/**
 * GESTION FKH — API backend (Cloudflare Worker + D1)
 * ---------------------------------------------------
 * Rôle : « gardien » de la base partagée.
 *  - Vérifie un MOT DE PASSE COMMUN (secret `APP_PASSWORD`, jamais exposé au navigateur).
 *  - Stocke chaque « tiroir » de l'appli (clé localStorage) comme une ligne dans la table `store`.
 *  - Endpoints :
 *      POST /login            { password }            -> { ok:true|false }
 *      GET  /state?since=<ts> (X-App-Password)        -> { now, changed:{ k:{v,u} } }
 *      PUT  /state            { k, v } ou { items:[…] }-> { ok:true, now }
 *
 * ÉVOLUTION PRÉVUE (accès par utilisateur / par section, plus tard) :
 *  - ajouter une table `users` (voir schema.sql) : login · hash mot de passe · sections autorisées ;
 *  - /login renverra un jeton + la liste des sections ; /state filtrera les clés selon les droits.
 *  Le MVP mot de passe commun ci-dessous est le socle de cette évolution (pas de reconstruction).
 */

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Password",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin);
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const path = url.pathname.replace(/\/+$/, "") || "/";

    // --- Connexion : valide le mot de passe commun ---
    if (path === "/login" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const ok = typeof env.APP_PASSWORD === "string" &&
                 env.APP_PASSWORD.length > 0 &&
                 (body.password || "") === env.APP_PASSWORD;
      return json({ ok });
    }

    // --- Toutes les autres routes exigent le mot de passe ---
    const pass = request.headers.get("X-App-Password") || "";
    if (!env.APP_PASSWORD || pass !== env.APP_PASSWORD) {
      return json({ error: "unauthorized" }, 401);
    }

    // --- Lecture des changements depuis un horodatage ---
    if (path === "/state" && request.method === "GET") {
      const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
      const rs = await env.DB
        .prepare("SELECT k, v, updated_at FROM store WHERE updated_at > ?")
        .bind(since)
        .all();
      const changed = {};
      for (const r of (rs.results || [])) changed[r.k] = { v: r.v, u: r.updated_at };
      return json({ now: Date.now(), changed });
    }

    // --- Écriture (une clé ou un lot) ---
    if (path === "/state" && request.method === "PUT") {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const items = Array.isArray(body.items)
        ? body.items
        : (body.k != null ? [{ k: body.k, v: body.v }] : []);
      if (!items.length) return json({ error: "empty" }, 400);
      const now = Date.now();
      const stmt = env.DB.prepare(
        "INSERT INTO store (k, v, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at"
      );
      const batch = items.map((it) =>
        stmt.bind(String(it.k), typeof it.v === "string" ? it.v : JSON.stringify(it.v), now)
      );
      await env.DB.batch(batch);
      return json({ ok: true, now });
    }

    // --- Upload d'une photo vers R2 (corps = octets de l'image, ?key=chemin/dans/le/bucket) ---
    if (path === "/photo" && request.method === "POST") {
      if (!env.PHOTOS) return json({ error: "no bucket" }, 500);
      const key = url.searchParams.get("key");
      if (!key) return json({ error: "key manquante" }, 400);
      const ct = request.headers.get("Content-Type") || "application/octet-stream";
      await env.PHOTOS.put(key, request.body, { httpMetadata: { contentType: ct } });
      return json({ ok: true, key, now: Date.now() });
    }

    // --- Liste des photos (repertoire), ?prefix=tenue/ ---
    if (path === "/photos" && request.method === "GET") {
      if (!env.PHOTOS) return json({ error: "no bucket" }, 500);
      const prefix = url.searchParams.get("prefix") || "";
      const listed = await env.PHOTOS.list({ prefix, limit: 500 });
      const keys = (listed.objects || []).map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded }));
      return json({ keys });
    }

    // --- Affichage d'une photo depuis R2 (l'appli fetch avec le mot de passe -> blob) ---
    if (path.startsWith("/photo/") && request.method === "GET") {
      if (!env.PHOTOS) return json({ error: "no bucket" }, 500);
      const key = decodeURIComponent(path.slice("/photo/".length));
      const obj = await env.PHOTOS.get(key);
      if (!obj) return json({ error: "not found" }, 404);
      const h = new Headers(cors);
      h.set("Content-Type", (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream");
      h.set("Cache-Control", "private, max-age=3600");
      return new Response(obj.body, { headers: h });
    }

    // --- Suppression d'une photo (?key=...) ---
    if (path === "/photo" && request.method === "DELETE") {
      if (!env.PHOTOS) return json({ error: "no bucket" }, 500);
      const key = url.searchParams.get("key");
      if (!key) return json({ error: "key manquante" }, 400);
      await env.PHOTOS.delete(key);
      return json({ ok: true });
    }

    // --- Porte Claude : depot d'une demande/observation par un collaborateur ---
    if (path === "/msg" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const canal = (body.canal === "retour") ? "retour" : "analyse";
      const texte = typeof body.texte === "string" ? body.texte.trim() : "";
      const auteur = typeof body.auteur === "string" ? body.auteur.slice(0, 120) : "";
      const fichier = typeof body.fichier === "string" ? body.fichier.slice(0, 2000) : null;
      if (!texte) return json({ error: "texte vide" }, 400);
      const now = Date.now();
      const rs = await env.DB
        .prepare("INSERT INTO messages (canal, auteur, texte, fichier, statut, created_at) VALUES (?, ?, ?, ?, 'nouveau', ?)")
        .bind(canal, auteur, texte, fichier, now)
        .run();
      const id = rs.meta && rs.meta.last_row_id;
      return json({ ok: true, id, now });
    }

    // --- Porte Claude : le site recupere les messages (et les reponses) depuis un horodatage ---
    if (path === "/msg" && request.method === "GET") {
      const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
      const rs = await env.DB
        .prepare(
          "SELECT id, canal, auteur, texte, fichier, statut, reponse, created_at, replied_at " +
          "FROM messages WHERE created_at > ? OR (replied_at IS NOT NULL AND replied_at > ?) " +
          "ORDER BY id ASC LIMIT 200"
        )
        .bind(since, since)
        .all();
      return json({ now: Date.now(), messages: rs.results || [] });
    }

    return json({ error: "not found" }, 404);
  },
};
