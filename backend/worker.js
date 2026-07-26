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
    "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
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

    return json({ error: "not found" }, 404);
  },
};
