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

// ===== Niveau 2 — Web Push (notifications appli fermée) =====
// Envoi « sans charge utile » : le téléphone reçoit un signal signé VAPID, le service worker
// affiche une notification générique. Le détail s'affiche en ouvrant l'appli.
const VAPID_PUB = "BPgtjrioK0ucyYk1XxWToj1OlSOiNWBNUQJX4KFXxczKb2NqGTbCSkoXee59LBFsd7GwoPtgz5I1XWX8VSnzdZY";
const b64uToBytes = (s) => { const pad = "=".repeat((4 - (s.length % 4)) % 4); const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/")); const a = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i); return a; };
const bytesToB64u = (buf) => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
async function vapidAuthHeader(env, endpoint) {
  const pub = b64uToBytes(VAPID_PUB); // 65 octets : 0x04 | x(32) | y(32)
  const jwk = { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE, x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)) };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = new TextEncoder();
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:hacamara2@gmail.com" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(header + "." + payload));
  return `vapid t=${header}.${payload}.${bytesToB64u(sig)}, k=${VAPID_PUB}`;
}
function u8concat() { let len = 0; for (let i = 0; i < arguments.length; i++) len += arguments[i].length; const out = new Uint8Array(len); let o = 0; for (let i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; } return out; }
// Chiffre la charge utile pour un abonné (RFC 8291 / aes128gcm) — le téléphone peut ainsi
// afficher le vrai contenu de la demande, même appli fermée.
async function encryptPayload(p256dhB64, authB64, plaintext) {
  const uaPublic = b64uToBytes(p256dhB64);   // 65 octets
  const authSecret = b64uToBytes(authB64);   // 16 octets
  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey)); // 65 octets
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const enc = new TextEncoder();
  const keyInfo = u8concat(enc.encode("WebPush: info"), new Uint8Array([0]), uaPublic, asPublicRaw);
  const ecdhKey = await crypto.subtle.importKey("raw", ecdh, "HKDF", false, ["deriveBits"]);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: authSecret, info: keyInfo }, ecdhKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cekBits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt, info: enc.encode("Content-Encoding: aes128gcm\0") }, ikmKey, 128);
  const nonceBits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt, info: enc.encode("Content-Encoding: nonce\0") }, ikmKey, 96);
  const cek = await crypto.subtle.importKey("raw", cekBits, { name: "AES-GCM" }, false, ["encrypt"]);
  const record = u8concat(plaintext, new Uint8Array([2])); // délimiteur dernier enregistrement
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(nonceBits), tagLength: 128 }, cek, record));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return u8concat(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw, ct);
}
async function pushOne(env, row, plaintext) {
  try {
    const sub = JSON.parse(row.sub); const endpoint = sub.endpoint || row.endpoint;
    const headers = { Authorization: await vapidAuthHeader(env, endpoint), TTL: "86400", Urgency: "high" };
    let body = null;
    if (plaintext && sub.keys && sub.keys.p256dh && sub.keys.auth) {
      body = await encryptPayload(sub.keys.p256dh, sub.keys.auth, plaintext);
      headers["Content-Encoding"] = "aes128gcm";
      headers["Content-Type"] = "application/octet-stream";
    }
    const r = await fetch(endpoint, { method: "POST", headers: headers, body: body });
    if (r.status === 404 || r.status === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(row.endpoint).run();
    return r.status;
  } catch (e) { return 0; }
}
// Notifie tous les appareils. payloadObj = { title, body, url, tag } (facultatif).
async function pushAll(env, payloadObj) {
  if (!env.VAPID_PRIVATE) return 0;
  const rs = await env.DB.prepare("SELECT endpoint, sub FROM push_subs").all();
  const rows = rs.results || [];
  const plaintext = payloadObj ? new TextEncoder().encode(JSON.stringify(payloadObj)) : null;
  await Promise.allSettled(rows.map((row) => pushOne(env, row, plaintext)));
  return rows.length;
}
// Construit le contenu de la notification à partir d'une demande de gardiennage.
function demandeNotif(m) {
  const head = m.client || m.ville || m.titre || "Demande";
  let body = "";
  if (m.texte) {
    body = String(m.texte);
  } else {
    const L = [];
    if (m.client) L.push("🏢 Client : " + m.client);
    const vc = [m.ville, m.cp ? "(" + m.cp + ")" : ""].filter(Boolean).join(" ");
    if (vc) L.push("📍 " + vc);
    if (m.mheure) L.push("🕐 " + m.mheure + (m.mfin ? " → " + m.mfin : ""));
    body = L.join("\n");
  }
  if (m.urgent && body.indexOf("URGENT") < 0) body = "🔴 URGENT\n" + body;
  return { title: "🆕 Nouvelle demande — " + String(head).slice(0, 40), body: (body || "Une demande vient de passer en recherche.").slice(0, 1600), url: "/fkh-securite-apps/gestion/", tag: "fkh-" + (m.id || Date.now()) };
}
// Quelles demandes viennent de passer « en recherche » entre l'ancienne et la nouvelle valeur ?
function newRechercheItems(oldV, newV) {
  let o = [], n = [];
  try { o = JSON.parse(oldV || "[]") || []; } catch (_) {}
  try { n = JSON.parse(newV || "[]") || []; } catch (_) {}
  if (!Array.isArray(o)) o = []; if (!Array.isArray(n)) n = [];
  const was = {}; o.forEach((m) => { if (m && m.id) was[m.id] = m.statut; });
  return n.filter((m) => m && m.statut === "recherche" && was[m.id] !== "recherche");
}

// ===== IA : détecter les demandes de gardiennage dans les appels entrants =====
function safeParse(s) { try { return JSON.parse(s) || {}; } catch (e) { return {}; } }
async function aiTranscribe(env, audioUrl) {
  let a = await fetch(audioUrl, { headers: { Authorization: env.RINGOVER_API_KEY } });
  if (!a.ok) a = await fetch(audioUrl);
  if (!a.ok) throw new Error("audio " + a.status);
  const blob = await a.blob();
  const form = new FormData();
  form.append("file", blob, "call.mp3");
  form.append("model", "whisper-1");
  form.append("language", "fr");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY }, body: form });
  if (!r.ok) throw new Error("whisper " + r.status + " " + (await r.text()).slice(0, 120));
  const j = await r.json();
  return j.text || "";
}
async function aiAnalyze(env, transcript) {
  const prompt = "Tu analyses la transcription d'un appel telephonique d'une societe de securite privee (gardiennage). Determine s'il s'agit d'une (ou plusieurs) demande(s) de GARDIENNAGE (surveillance, agent de securite, ADS, ronde...). Reponds UNIQUEMENT en JSON strict, sans aucun texte autour :\n{\"is_demande\": true|false, \"resume\": \"\", \"demandes\": [{\"client\":\"\",\"ville\":\"\",\"cp\":\"\",\"site\":\"\",\"type_site\":\"\",\"nb_agents\":\"\",\"urgent\":true,\"vacations\":[{\"date\":\"\",\"horaires\":\"\"}]}]}\nREGLES ABSOLUES :\n- UNE demande = UN SEUL SITE. Si l'appel concerne PLUSIEURS SITES differents (villes ou lieux differents), cree PLUSIEURS entrees distinctes dans 'demandes', une par site. NE JAMAIS regrouper plusieurs sites dans une seule demande.\n- Pour un MEME site demande sur PLUSIEURS DATES : c'est UNE SEULE demande, mais mets UNE entree PAR DATE dans 'vacations', chaque entree = {date, horaires (creneau de cette date)}. NE PAS regrouper toutes les dates ensemble.\n- is_demande=false et demandes=[] si ce n'est pas une demande de gardiennage (facture, RH, autre).\n- Laisse \"\" si une info est absente. resume = 1 phrase courte resumant l'appel.\n\nTranscription :\n\"\"\"" + transcript + "\"\"\"";
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [{ role: "user", content: prompt }] }) });
  if (!r.ok) throw new Error("claude " + r.status + " " + (await r.text()).slice(0, 120));
  const j = await r.json();
  const txt = (j.content && j.content[0] && j.content[0].text) || "{}";
  const m = txt.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : txt); } catch (e) { return { is_demande: false, resume: "analyse illisible" }; }
}
async function aiScan(env, maxCalls) {
  if (!env.RINGOVER_API_KEY || !env.OPENAI_API_KEY || !env.ANTHROPIC_API_KEY) return { error: "keys_missing" };
  // Liste blanche stricte : on n'analyse QUE les numéros suivis (avec leur règle entrant/sortant)
  const numKey = (n) => { let d = String(n || "").replace(/\D/g, ""); if (d.length > 9) d = d.slice(-9); return d; };
  let watchMap = {};
  try { const wr = await env.DB.prepare("SELECT v FROM store WHERE k = 'fkh_ai_numbers'").first(); const list = wr && wr.v ? JSON.parse(wr.v) : []; (Array.isArray(list) ? list : []).forEach((w) => { const k = numKey(w.n || w.number); if (k) watchMap[k] = w.dir || "both"; }); } catch (e) {}
  if (!Object.keys(watchMap).length) return { ok: true, processed: 0, detected: 0, note: "aucun numéro suivi" };
  const now = new Date(), from = new Date(now.getTime() - 2 * 3600 * 1000);
  const p = new URLSearchParams({ limit_count: "50", start_date: from.toISOString(), end_date: now.toISOString() });
  const r = await fetch("https://public-api.ringover.com/v2/calls?" + p.toString(), { headers: { Authorization: env.RINGOVER_API_KEY } });
  if (!r.ok) return { error: "ringover", status: r.status };
  const j = await r.json();
  const calls = (j.call_list || []).filter((c) => {
    if (!c.is_answered || !c.record || typeof c.record !== "string" || c.record.indexOf("http") !== 0) return false;
    const rule = watchMap[numKey(c.contact_number)];
    if (!rule) return false;
    return rule === "both" || rule === c.direction;
  });
  let processed = 0, detected = 0;
  for (const c of calls.slice(0, maxCalls || 8)) {
    const id = String(c.cdr_id);
    const exist = await env.DB.prepare("SELECT cdr_id FROM ai_calls WHERE cdr_id = ?").bind(id).first();
    if (exist) continue;
    let data = {}, isDem = 0;
    try {
      const transcript = await aiTranscribe(env, c.record);
      if (transcript) { const an = await aiAnalyze(env, transcript); data = { resume: an.resume || "", demandes: Array.isArray(an.demandes) ? an.demandes : [], transcript: transcript.slice(0, 2000), number: c.contact_number, direction: c.direction, start: c.start_time }; isDem = (data.demandes.length) ? 1 : 0; }
      else data = { skip: "no_transcript" };
    } catch (e) { data = { error: String((e && e.message) || e) }; }
    await env.DB.prepare("INSERT OR REPLACE INTO ai_calls (cdr_id, at, is_demande, dismissed, created, data) VALUES (?, ?, ?, 0, 0, ?)").bind(id, Date.now(), isDem, JSON.stringify(data)).run();
    processed++; if (isDem) detected++;
  }
  return { ok: true, processed, detected, total_in: calls.length };
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(aiScan(env, 8)); },
  async fetch(request, env, ctx) {
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

    // Sections autorisées pour les 2 accès restreints (memes 3 sections).
    const RESTRICTED_SECTIONS = ["demandes", "noterapide", "suiviappels", "interv"];
    // Renvoie le rôle correspondant au mot de passe, ou null si invalide.
    const roleFor = (pw) => {
      if (!pw) return null;
      if (typeof env.APP_PASSWORD === "string" && env.APP_PASSWORD.length > 0 && pw === env.APP_PASSWORD)
        return { role: "full", sections: null };
      for (const v of ["APP_PASSWORD_R1", "APP_PASSWORD_R2"]) {
        if (typeof env[v] === "string" && env[v].length > 0 && pw === env[v])
          return { role: v, sections: RESTRICTED_SECTIONS };
      }
      return null;
    };

    // --- Connexion : valide le mot de passe (complet ou restreint) et renvoie les sections autorisées ---
    if (path === "/login" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const r = roleFor(body.password || "");
      if (!r) return json({ ok: false });
      return json({ ok: true, role: r.role, sections: r.sections });
    }

    // --- Toutes les autres routes exigent un mot de passe valide (complet OU restreint) ---
    const pass = request.headers.get("X-App-Password") || "";
    if (!roleFor(pass)) {
      return json({ error: "unauthorized" }, 401);
    }

    // --- Ringover : journal d'appels pour vérifier ce qui a été réellement appelé ---
    if (path === "/ringover/calls" && request.method === "GET") {
      if (!env.RINGOVER_API_KEY) return json({ error: "no_key" }, 500);
      const from = url.searchParams.get("from") || ""; // YYYY-MM-DD
      const to = url.searchParams.get("to") || from;
      const p = new URLSearchParams({ limit_count: "1000" });
      if (from) p.set("start_date", from + "T00:00:00.000Z");
      if (to) p.set("end_date", to + "T23:59:59.999Z");
      try {
        const r = await fetch("https://public-api.ringover.com/v2/calls?" + p.toString(), { headers: { Authorization: env.RINGOVER_API_KEY } });
        if (!r.ok) return json({ error: "ringover", status: r.status }, 502);
        const j = await r.json();
        const calls = (j.call_list || []).map((c) => ({
          number: String(c.contact_number || ""),
          start: c.start_time || "",
          answered: !!c.is_answered,
          direction: c.direction || "",
          duration: c.total_duration || 0,
        }));
        return json({ ok: true, total: j.total_call_count || calls.length, calls });
      } catch (e) { return json({ error: "ringover_fetch" }, 502); }
    }

    // --- Ringover : diagnostic — quels champs renvoie l'API (enregistrement ? transcription ?) ---
    if (path === "/ringover/probe" && request.method === "GET") {
      if (!env.RINGOVER_API_KEY) return json({ error: "no_key" }, 500);
      try {
        const r = await fetch("https://public-api.ringover.com/v2/calls?limit_count=5", { headers: { Authorization: env.RINGOVER_API_KEY } });
        if (!r.ok) return json({ error: "ringover", status: r.status }, 502);
        const j = await r.json();
        const list = j.call_list || [];
        const sample = list[0] || null;
        // Cherche un appel qui a un enregistrement pour repérer les champs
        const withRec = list.find((c) => c.record || c.record_url || c.recording || c.transcription || c.transcript) || null;
        return json({
          ok: true,
          fields: sample ? Object.keys(sample) : [],
          hasRecordField: sample ? ("record" in sample || "record_url" in sample || "recording" in sample) : false,
          hasTranscriptField: sample ? ("transcription" in sample || "transcript" in sample) : false,
          sampleWithRecord: withRec,
          sample,
        });
      } catch (e) { return json({ error: "fetch" }, 502); }
    }

    // --- IA : scanner les appels entrants et récupérer les demandes détectées ---
    if (path === "/ai/scan" && request.method === "POST") {
      const res = await aiScan(env, 8);
      return json(res, res && res.error ? 502 : 200);
    }
    if (path === "/ai/demandes" && request.method === "GET") {
      const rs = await env.DB.prepare("SELECT cdr_id, at, data FROM ai_calls WHERE is_demande = 1 AND dismissed = 0 AND created = 0 ORDER BY at DESC LIMIT 50").all();
      const items = (rs.results || []).map((row) => Object.assign({ cdr_id: row.cdr_id, at: row.at }, safeParse(row.data)));
      return json({ ok: true, items });
    }
    if ((path === "/ai/dismiss" || path === "/ai/created") && request.method === "POST") {
      let b = {}; try { b = await request.json(); } catch (_) {}
      if (b.cdr_id) {
        const col = path === "/ai/dismiss" ? "dismissed" : "created";
        await env.DB.prepare("UPDATE ai_calls SET " + col + " = 1 WHERE cdr_id = ?").bind(String(b.cdr_id)).run();
      }
      return json({ ok: true });
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
      // Niveau 2 : compare avec l'ancienne valeur AVANT écriture — nouvelle demande « en recherche » => push
      const PUSH_KEYS = ["fkh_suivi", "fkh_interv"];
      let fresh = [];
      for (const it of items) {
        if (!PUSH_KEYS.includes(String(it.k))) continue;
        try {
          const old = await env.DB.prepare("SELECT v FROM store WHERE k = ?").bind(String(it.k)).first();
          const nv = typeof it.v === "string" ? it.v : JSON.stringify(it.v);
          fresh = fresh.concat(newRechercheItems(old ? old.v : "[]", nv));
        } catch (_) {}
      }
      await env.DB.batch(batch);
      if (fresh.length && ctx && ctx.waitUntil) {
        ctx.waitUntil((async () => {
          for (const m of fresh.slice(0, 5)) await pushAll(env, demandeNotif(m));
        })());
      }
      return json({ ok: true, now });
    }

    // --- Niveau 2 : abonnements Web Push (notifications appli fermée) ---
    if (path === "/push/subscribe" && request.method === "POST") {
      let body = {}; try { body = await request.json(); } catch (_) {}
      const sub = body.sub || body.subscription;
      if (!sub || !sub.endpoint) return json({ error: "subscription manquante" }, 400);
      await env.DB.prepare("INSERT INTO push_subs (endpoint, sub, at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub, at = excluded.at")
        .bind(String(sub.endpoint), JSON.stringify(sub), Date.now()).run();
      return json({ ok: true });
    }
    if (path === "/push/unsubscribe" && request.method === "POST") {
      let body = {}; try { body = await request.json(); } catch (_) {}
      if (!body.endpoint) return json({ error: "endpoint manquant" }, 400);
      await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(String(body.endpoint)).run();
      return json({ ok: true });
    }
    // Envoi de test : notifie tous les appareils abonnés (pour vérifier le circuit)
    if (path === "/push/test" && request.method === "POST") {
      const sent = await pushAll(env, { title: "🧪 Test — GESTION", body: "Test de notification appli fermée.\n🏢 Client : DÉMO\n📍 Ville : Dijon (21000)\n🏬 Type de site : Magasin\n🕐 Vacation : 20:00 → 06:00\n🔴 Ceci est un exemple.", url: "/fkh-securite-apps/gestion/", tag: "fkh-test-" + Date.now() });
      return json({ ok: true, sent });
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
