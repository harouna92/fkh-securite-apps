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
// Notification pour une (ou plusieurs) demande(s) détectée(s) automatiquement par l'IA dans un appel.
function aiDemandeNotif(call, demandes) {
  const dir = call && call.direction === "out" ? "sortant" : "entrant";
  let head, L = [];
  if (demandes.length === 1) {
    const d = demandes[0];
    head = d.client || d.site || d.ville || "Demande";
    if (d.client) L.push("🏢 " + d.client);
    if (d.site) L.push("🏬 " + d.site);
    const vc = [d.ville, d.cp ? "(" + d.cp + ")" : ""].filter(Boolean).join(" ");
    if (vc) L.push("📍 " + vc);
    const v0 = (Array.isArray(d.vacations) && d.vacations[0]) || null;
    if (v0) L.push("🕐 " + [v0.date, v0.horaires].filter(Boolean).join(" · "));
    if (Array.isArray(d.vacations) && d.vacations.length > 1) L.push("＋ " + (d.vacations.length - 1) + " autre(s) date(s)");
    if (d.urgent) L.unshift("🔴 URGENT");
  } else {
    head = demandes.length + " sites";
    demandes.slice(0, 4).forEach((d) => L.push("• " + [d.site || d.client || "Site", d.ville].filter(Boolean).join(" — ")));
    if (demandes.length > 4) L.push("…");
  }
  L.push("");
  L.push("👉 Déjà dans Suivi demandes (en recherche). À vérifier avant de lancer la recherche.");
  return {
    title: "🤖 Demande détectée par l'IA — " + String(head).slice(0, 34),
    body: ("📞 Appel " + dir + "\n" + L.join("\n")).slice(0, 1600),
    url: "/fkh-securite-apps/gestion/",
    tag: "fkh-ai-" + (call && call.cdr_id ? call.cdr_id : Date.now()),
  };
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
const AI_PROMPT_BASE = "Tu analyses un message (appel transcrit, mail, SMS ou capture d'ecran) d'une societe de securite privee. Determine s'il contient une (ou plusieurs) demande(s) operationnelle(s), de trois NATURES possibles :\n- GARDIENNAGE : un agent est POSTE pour SURVEILLER un site sur une vacation / une duree (nuit, week-end, chantier, magasin...). Surveillance statique, l'agent reste sur place.\n- INTERVENTION : un DEPLACEMENT PONCTUEL declenche par une ALARME / une levee de doute / une alerte (l'agent se rend sur place, verifie, repart). Ponctuel, dure typiquement 1 h.\n- RONDE : un ou plusieurs PASSAGES de verification / pointage / tournee sur un ou plusieurs sites.\nEn cas de DOUTE entre gardiennage et intervention/ronde, choisis GARDIENNAGE.\nReponds UNIQUEMENT en JSON strict, sans aucun texte autour :\n{\"is_demande\": true|false, \"resume\": \"\", \"demandes\": [{\"nature\":\"gardiennage|intervention|ronde\",\"client\":\"\",\"ville\":\"\",\"cp\":\"\",\"site\":\"\",\"type_site\":\"\",\"nb_agents\":\"\",\"urgent\":true,\"vacations\":[{\"date\":\"\",\"horaires\":\"\"}]}],\"arrets\":[{\"client\":\"\",\"site\":\"\",\"ville\":\"\",\"motif\":\"\"}]}\nREGLES ABSOLUES :\n- FKH (FKH SECURITE) n'est JAMAIS le champ 'client' : FKH c'est NOUS, le destinataire des demandes. Le client est l'AUTRE societe (donneur d'ordre). Si le seul nom present est FKH, laisse 'client' vide.\n- 'nature' est OBLIGATOIRE pour CHAQUE demande : exactement 'gardiennage', 'intervention' ou 'ronde'.\n- Le champ 'client' est PRIORITAIRE : cherche ACTIVEMENT le donneur d'ordre et reprends-le exactement comme il est dit (Securitas, Sotel, etc.). Regarde partout : societe qui appelle/mande, nom cite, en-tete ou signature du mail, expediteur, en-tete de SMS. C'est souvent une societe de securite qui nous sous-traite. Ne laisse 'client' vide QUE si vraiment AUCUN nom de donneur d'ordre n'apparait nulle part.\n- UNE demande = UN SEUL SITE. Si le message concerne PLUSIEURS SITES differents (villes ou lieux differents), cree PLUSIEURS entrees distinctes dans 'demandes', une par site. NE JAMAIS regrouper plusieurs sites dans une seule demande.\n- Pour un MEME site (gardiennage) demande sur PLUSIEURS DATES : c'est UNE SEULE demande, mais mets UNE entree PAR DATE dans 'vacations', chaque entree = {date, horaires (creneau de cette date)}. NE PAS regrouper toutes les dates ensemble. Pour une intervention ou une ronde ponctuelle, 'vacations' peut rester vide (ou contenir la date/heure prevue si elle est precisee).\n- ARRET / ANNULATION a l'initiative du CLIENT : si le message est un client qui ARRETE, ANNULE ou met FIN a une prestation de gardiennage EN COURS (ex. « on arrete la surveillance du site X », « plus besoin d'agent a partir de demain », « on suspend la mission »), NE le mets PAS dans 'demandes' → mets une entree dans 'arrets' {client, site, ville, motif}. C'est le client qui prend l'initiative de l'arret.\n- is_demande=false, demandes=[] et arrets=[] si ce n'est NI du gardiennage, NI une intervention, NI une ronde, NI un arret (facture, RH, commercial, conversation, autre).\n- Laisse \"\" si une info est absente. resume = 1 phrase courte resumant le message.";
function aiParseJson(j) { const txt = (j.content && j.content[0] && j.content[0].text) || "{}"; const m = txt.match(/\{[\s\S]*\}/); try { return JSON.parse(m ? m[0] : txt); } catch (e) { return { is_demande: false, resume: "analyse illisible" }; } }
async function aiAnalyze(env, transcript, direction) {
  const dirLine = direction === "in" ? "\n\nContexte : appel ENTRANT (le correspondant nous appelle)."
    : direction === "out" ? "\n\nContexte : appel SORTANT (c'est NOUS qui appelons le correspondant)."
    : "";
  const prompt = AI_PROMPT_BASE + dirLine + "\n\nTexte a analyser :\n\"\"\"" + transcript + "\"\"\"";
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [{ role: "user", content: prompt }] }) });
  if (!r.ok) throw new Error("claude " + r.status + " " + (await r.text()).slice(0, 120));
  return aiParseJson(await r.json());
}
// b203 : lecture des PIECES JOINTES PDF (bons de commande) par l'IA -> adresse exacte du site, refs, horaires
async function aiReadPdf(env, pdfs) {
  const docs = (pdfs || []).slice(0, 2).map((p) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.b64 } }));
  if (!docs.length) return null;
  const q = { type: "text", text: "Ce sont des bons de commande / demandes de prestation de gardiennage adresses a FKH SECURITE (sous-traitant). Extrais UNIQUEMENT ce qui est ecrit, en JSON strict, sans commentaire : {\"site\":\"nom du site a garder\",\"adresse\":\"numero et rue\",\"cp\":\"code postal\",\"ville\":\"ville\",\"client\":\"donneur d'ordre\",\"ref\":\"reference de la commande\",\"date\":\"AAAA-MM-JJ\",\"debut\":\"HH:MM\",\"fin\":\"HH:MM\",\"consignes\":\"consignes en une phrase\"}. Mets une chaine vide pour tout champ absent. FKH SECURITE n'est JAMAIS le client." };
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 700, messages: [{ role: "user", content: docs.concat([q]) }] }) });
  if (!r.ok) return null;
  const j = await r.json();
  const txt = (j && j.content && j.content[0] && j.content[0].text) || "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

async function aiAnalyzeImage(env, b64, media) {
  const content = [ { type: "text", text: AI_PROMPT_BASE + "\n\nAnalyse cette capture d'ecran (demande recue) :" }, { type: "image", source: { type: "base64", media_type: media || "image/png", data: b64 } } ];
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, messages: [{ role: "user", content: content }] }) });
  if (!r.ok) throw new Error("claude " + r.status + " " + (await r.text()).slice(0, 120));
  return aiParseJson(await r.json());
}
// #3 Vision : une photo censee montrer un agent en tenue montre-t-elle plutot un batiment ?
function b64FromBuf(buf) { let bin = ""; const bytes = new Uint8Array(buf), chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)); return btoa(bin); }
async function aiCheckPhoto(env, b64, media) {
  const content = [
    { type: "text", text: "Tu verifies une photo censee montrer un AGENT DE SECURITE EN TENUE (uniforme). Dis si elle montre bien une PERSONNE en tenue, ou plutot un BATIMENT / lieu / objet sans personne (erreur probable de l'agent). Reponds UNIQUEMENT en JSON strict : {\"contenu\":\"personne|batiment|autre\",\"tenue_visible\":true|false,\"resume\":\"\"}." },
    { type: "image", source: { type: "base64", media_type: media || "image/jpeg", data: b64 } },
  ];
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 200, messages: [{ role: "user", content: content }] }) });
  if (!r.ok) throw new Error("claude " + r.status + " " + (await r.text()).slice(0, 120));
  return aiParseJson(await r.json());
}
async function aiScan(env, maxCalls, force) {
  if (!env.RINGOVER_API_KEY || !env.OPENAI_API_KEY || !env.ANTHROPIC_API_KEY) return { error: "keys_missing" };
  // Liste blanche stricte : on n'analyse QUE les numéros suivis (avec leur règle entrant/sortant)
  const numKey = (n) => { let d = String(n || "").replace(/\D/g, ""); if (d.length > 9) d = d.slice(-9); return d; };
  let watchMap = {};
  try { const wr = await env.DB.prepare("SELECT v FROM store WHERE k = 'fkh_ai_numbers'").first(); const list = wr && wr.v ? JSON.parse(wr.v) : []; (Array.isArray(list) ? list : []).forEach((w) => { const k = numKey(w.n || w.number); if (k) watchMap[k] = w.dir || "both"; }); } catch (e) {}
  if (!Object.keys(watchMap).length) return { ok: true, processed: 0, detected: 0, note: "aucun numéro suivi" };
  // Le cron regarde les 2 dernières heures (temps réel) ; une re-analyse manuelle (force) remonte à 24 h pour rattraper un appel plus ancien de la journée.
  const now = new Date(), lookbackH = force ? 24 : 2, from = new Date(now.getTime() - lookbackH * 3600 * 1000);
  const p = new URLSearchParams({ limit_count: force ? "100" : "50", start_date: from.toISOString(), end_date: now.toISOString() });
  const r = await fetch("https://public-api.ringover.com/v2/calls?" + p.toString(), { headers: { Authorization: env.RINGOVER_API_KEY } });
  if (!r.ok) return { error: "ringover", status: r.status };
  const j = await r.json();
  const all = j.call_list || [];
  const diag = { fetched: all.length, answered: 0, withRecord: 0, whitelisted: 0 };
  const calls = all.filter((c) => {
    if (c.is_answered) diag.answered++;
    const hasRec = c.record && typeof c.record === "string" && c.record.indexOf("http") === 0;
    if (hasRec) diag.withRecord++;
    const rule = watchMap[numKey(c.contact_number)];
    if (rule && (rule === "both" || rule === c.direction)) diag.whitelisted++;
    if (!c.is_answered || !hasRec) return false;
    if (!rule) return false;
    return rule === "both" || rule === c.direction;
  });
  let processed = 0, detected = 0;
  for (const c of calls.slice(0, maxCalls || 8)) {
    const id = String(c.cdr_id);
    if (!force) {
      const exist = await env.DB.prepare("SELECT cdr_id FROM ai_calls WHERE cdr_id = ?").bind(id).first();
      if (exist) continue;
    }
    let data = {}, isDem = 0;
    try {
      const transcript = await aiTranscribe(env, c.record);
      if (transcript) { const an = await aiAnalyze(env, transcript, c.direction); data = { resume: an.resume || "", demandes: Array.isArray(an.demandes) ? an.demandes : [], arrets: Array.isArray(an.arrets) ? an.arrets : [], transcript: transcript.slice(0, 2000), number: c.contact_number, direction: c.direction, start: c.start_time }; isDem = (data.demandes.length || data.arrets.length) ? 1 : 0; }
      else data = { skip: "no_transcript" };
    } catch (e) { data = { error: String((e && e.message) || e) }; }
    await env.DB.prepare("INSERT OR REPLACE INTO ai_calls (cdr_id, at, is_demande, dismissed, created, data) VALUES (?, ?, ?, 0, 0, ?)").bind(id, Date.now(), isDem, JSON.stringify(data)).run();
    processed++;
    if (isDem) { detected++; try { await pushAll(env, aiDemandeNotif({ cdr_id: id, direction: c.direction }, data.demandes)); } catch (e) {} }
  }
  return { ok: true, processed, detected, total_in: calls.length, window_h: lookbackH, diag };
}

// ===== Assistant (porte Claude) : réponse automatique aux messages des collaborateurs =====
async function aiAssistantReply(env, canal, auteur, texte) {
  const ctxLine = canal === "retour"
    ? "Le collaborateur SIGNALE UN BESOIN ou une OBSERVATION sur l'application. Accuse reception avec bienveillance, reformule le besoin en 1 phrase, et indique qu'il est transmis a l'equipe pour etude. Ne promets aucun delai."
    : "Le collaborateur POSE UNE QUESTION ou demande une ANALYSE. Reponds de facon concrete et utile.";
  const sys = "Tu es l'assistant interne de l'application GESTION de FKH SECURITE (societe de securite privee francaise). L'appli gere : demandes de gardiennage, interventions/rondes sur alarme, prise et fin de service, suivi des appels de controle, fiches agents (repertoire geolocalise), tenues, supervision et anomalies, photos terrain horodatees. " + ctxLine + " Reponds en FRANCAIS, de facon breve et claire (8 lignes maximum), sans formules inutiles.";
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, system: sys, messages: [{ role: "user", content: (auteur ? ("De " + auteur + " : ") : "") + texte }] }) });
  if (!r.ok) throw new Error("claude " + r.status + " " + (await r.text()).slice(0, 120));
  const j = await r.json();
  return (j.content && j.content[0] && j.content[0].text) || "";
}
async function replyToMsg(env, id, canal, auteur, texte) {
  if (!env.ANTHROPIC_API_KEY) return;
  try {
    const rep = await aiAssistantReply(env, canal, auteur, texte);
    if (rep) await env.DB.prepare("UPDATE messages SET reponse = ?, replied_at = ?, statut = 'repondu' WHERE id = ?").bind(rep, Date.now(), id).run();
  } catch (e) { /* on laisse statut='nouveau' → le cron réessaiera */ }
}
async function aiReplyPending(env) {
  if (!env.ANTHROPIC_API_KEY) return;
  const rs = await env.DB.prepare("SELECT id, canal, auteur, texte FROM messages WHERE statut = 'nouveau' ORDER BY id ASC LIMIT 5").all();
  for (const m of (rs.results || [])) await replyToMsg(env, m.id, m.canal, m.auteur, m.texte);
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(aiScan(env, 8)); ctx.waitUntil(aiReplyPending(env)); },
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
      // Rôles métier, PLUSIEURS comptes par rôle via pattern : APP_PASSWORD_OPERATEUR, _OPERATEUR2, _OPERATEUR3… (idem SUPERVISEUR/ADMIN/SUPERADMIN).
      // Accès complet (sections:null) pour l'instant ; `user` = identité pour l'attribution des anomalies. Ajouter une personne = créer un nouveau secret, SANS redéploiement.
      const ROLE_MAP = { OPERATEUR: "operateur", SUPERVISEUR: "superviseur", ADMIN: "admin", SUPERADMIN: "superadmin" };
      // Vues autorisées par rôle. null = accès complet. Opérateur = restreint (défini avec Zeus, à affiner ensuite).
      const SECTIONS_BY_ROLE = { operateur: ["suiviappels", "interv", "suivi", "demandes", "noterapide"] };
      for (const k of Object.keys(env)) {
        const mm = /^APP_PASSWORD_(SUPERADMIN|SUPERVISEUR|OPERATEUR|ADMIN)(\d*)$/.exec(k);
        if (mm && typeof env[k] === "string" && env[k].length > 0 && pw === env[k]) {
          const role = ROLE_MAP[mm[1]];
          return { role: role, user: mm[1].toLowerCase() + "-" + (mm[2] || "1"), sections: SECTIONS_BY_ROLE[role] || null };
        }
      }
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
      return json({ ok: true, role: r.role, user: r.user || null, sections: r.sections });
    }

    // --- PUBLIC (à token) : dépôt d'une photo par un agent via un lien (pas de mot de passe appli) ---
    if (path === "/agent-photo" && request.method === "POST") {
      if (!env.PHOTOS) return json({ error: "no_bucket" }, 500);
      const tok = url.searchParams.get("k") || "";
      const expected = env.AGENT_PHOTO_TOKEN || "fkh-photo-link-2026";
      if (tok !== expected) return json({ error: "bad_token" }, 403);
      const key = url.searchParams.get("key") || "";
      if (!key || !/^(agent|tenue|appel|u)\//.test(key) || key.indexOf("..") >= 0) return json({ error: "bad_key" }, 400); // u/ = lien photo UNIQUE (sans identité agent)
      const ct = request.headers.get("Content-Type") || "image/jpeg";
      await env.PHOTOS.put(key, request.body, { httpMetadata: { contentType: ct } });
      return json({ ok: true, key: key });
    }

    // --- PUBLIC (à token) : ingestion d'un mail (BDC) transféré par le Gmail Apps Script → pipeline IA existant ---
    if (path === "/mail/ingest" && request.method === "POST") {
      const tok = url.searchParams.get("k") || "";
      const expected = env.MAIL_INGEST_TOKEN || "fkh-mail-ingest-2026";
      if (tok !== expected) return json({ error: "bad_token" }, 403);
      if (!env.ANTHROPIC_API_KEY) return json({ error: "keys_missing" }, 502);
      let b = {}; try { b = await request.json(); } catch (_) {}
      const msgId = String(b.msgId || "").replace(/[^\w-]/g, "") || ("m" + Date.now());
      const cdr = "mail_" + msgId;
      const text = (String(b.subject || "") + "\n" + String(b.body || "")).slice(0, 8000);
      if (!text.trim()) return json({ error: "empty" }, 400);
      const exist = await env.DB.prepare("SELECT cdr_id FROM ai_calls WHERE cdr_id = ?").bind(cdr).first();
      if (exist) return json({ ok: true, skipped: "already" });
      let data = {}, isDem = 0;
      let pdfInfo = null;
      try { if (Array.isArray(b.pdfs) && b.pdfs.length && env.ANTHROPIC_API_KEY) pdfInfo = await aiReadPdf(env, b.pdfs); } catch (e) {}
      try { const an = await aiAnalyze(env, text); data = { resume: an.resume || "", demandes: Array.isArray(an.demandes) ? an.demandes : [], arrets: Array.isArray(an.arrets) ? an.arrets : [], transcript: text.slice(0, 2000), number: String(b.from || "mail"), direction: "in", source: "mail", start: new Date().toISOString() }; isDem = (data.demandes.length || data.arrets.length) ? 1 : 0; }
      catch (e) { data = { error: String((e && e.message) || e) }; }
      if (pdfInfo) { data.pdf = pdfInfo; if (pdfInfo.adresse || pdfInfo.cp) isDem = isDem || 1; } // b203 : adresse exacte issue du bon de commande
      // b155 : le script envoie TOUS les mails reçus — on ne GARDE que ce qui concerne les missions
      // (demande détectée par l'IA, OU donneur d'ordre connu, OU vocabulaire mission). Le reste = marqueur `skip`
      // (dédoublonnage : le mail ne sera pas ré-analysé) ; ses infos restent en base pour d'autres sections plus tard.
      const fromStr = String(b.from || "");
      const knownSender = /(securitas|reseau-aquila|ranc-developpement|banzai-communication)/i.test(fromStr);
      const missionWords = /(gardien|prestation|surveillance|annulation|bon de commande|vacation|agent de s[eé]curit|rondier|intervention|ronde)/i.test(text);
      if (!isDem && !knownSender && !missionWords) {
        await env.DB.prepare("INSERT OR REPLACE INTO ai_calls (cdr_id, at, is_demande, dismissed, created, data) VALUES (?, ?, 0, 1, 0, ?)").bind(cdr, Date.now(), JSON.stringify({ skip: 1, transcript: text.slice(0, 300), number: fromStr, source: "mail" })).run();
        return json({ ok: true, skipped: "hors-mission" });
      }
      await env.DB.prepare("INSERT OR REPLACE INTO ai_calls (cdr_id, at, is_demande, dismissed, created, data) VALUES (?, ?, ?, 0, 0, ?)").bind(cdr, Date.now(), isDem, JSON.stringify(data)).run();
      if (isDem) { try { await pushAll(env, aiDemandeNotif({ cdr_id: cdr, direction: "in" }, data.demandes)); } catch (e) {} }
      return json({ ok: true, detected: isDem ? data.demandes.length : 0 });
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
      const force = url.searchParams.get("force") === "1";
      const res = await aiScan(env, force ? 20 : 8, force);
      return json(res, res && res.error ? 502 : 200);
    }
    // --- IA : analyser un texte COLLÉ (mail/SMS) et en extraire les demandes de gardiennage ---
    if (path === "/ai/parse-text" && request.method === "POST") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "keys_missing" }, 502);
      let b = {}; try { b = await request.json(); } catch (_) {}
      const text = String(b.text || "").slice(0, 8000);
      if (!text.trim()) return json({ error: "empty" }, 400);
      try { const an = await aiAnalyze(env, text); return json({ ok: true, resume: an.resume || "", demandes: Array.isArray(an.demandes) ? an.demandes : [], arrets: Array.isArray(an.arrets) ? an.arrets : [] }); }
      catch (e) { return json({ error: String((e && e.message) || e) }, 502); }
    }
    // --- IA : analyser une CAPTURE D'ÉCRAN (image) et en extraire les demandes de gardiennage ---
    if (path === "/ai/parse-image" && request.method === "POST") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "keys_missing" }, 502);
      let b = {}; try { b = await request.json(); } catch (_) {}
      const data = String(b.image || "").replace(/^data:[^,]*,/, "");
      const media = String(b.media_type || "image/png");
      if (!data) return json({ error: "empty" }, 400);
      try { const an = await aiAnalyzeImage(env, data, media); return json({ ok: true, resume: an.resume || "", demandes: Array.isArray(an.demandes) ? an.demandes : [], arrets: Array.isArray(an.arrets) ? an.arrets : [] }); }
      catch (e) { return json({ error: String((e && e.message) || e) }, 502); }
    }
    // --- IA vision : vérifier qu'une photo « tenue » montre bien une personne en tenue (pas un bâtiment) ---
    if (path === "/ai/check-photo" && request.method === "POST") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "keys_missing" }, 502);
      if (!env.PHOTOS) return json({ error: "no_bucket" }, 500);
      let b = {}; try { b = await request.json(); } catch (_) {}
      const key = String(b.key || "");
      if (!key) return json({ error: "empty" }, 400);
      const obj = await env.PHOTOS.get(key);
      if (!obj) return json({ error: "not_found" }, 404);
      try {
        const b64 = b64FromBuf(await obj.arrayBuffer());
        const media = (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg";
        const an = await aiCheckPhoto(env, b64, media);
        return json({ ok: true, contenu: an.contenu || "autre", tenue_visible: !!an.tenue_visible, resume: an.resume || "" });
      } catch (e) { return json({ error: String((e && e.message) || e) }, 502); }
    }
    if (path === "/ai/demandes" && request.method === "GET") {
      const rs = await env.DB.prepare("SELECT cdr_id, at, data FROM ai_calls WHERE is_demande = 1 AND dismissed = 0 AND created = 0 ORDER BY at DESC LIMIT 50").all();
      const items = (rs.results || []).map((row) => Object.assign({ cdr_id: row.cdr_id, at: row.at }, safeParse(row.data)));
      return json({ ok: true, items });
    }
    // --- b151 : liste des mails ingérés (section 📧 Mails missions — super-admin uniquement) ---
    if (path === "/mails/list" && request.method === "GET") {
      const rr = roleFor(pass);
      if (!rr || (rr.role !== "superadmin" && rr.role !== "full")) return json({ error: "forbidden" }, 403);
      const rs = await env.DB.prepare("SELECT cdr_id, at, is_demande, dismissed, created, data FROM ai_calls WHERE cdr_id LIKE 'mail_%' ORDER BY at DESC LIMIT 200").all();
      const items = (rs.results || []).map((row) => Object.assign({ cdr_id: row.cdr_id, at: row.at, is_demande: row.is_demande, dismissed: row.dismissed, created: row.created }, safeParse(row.data)));
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
      // Réponse IA automatique (les 2 canaux) — en arrière-plan pour répondre vite au POST.
      if (id) ctx.waitUntil(replyToMsg(env, id, canal, auteur, texte));
      // (A, 2026-07-31) Notification « Question Assistant » DÉSACTIVÉE à la demande de Zeus : plus AUCUN push à chaque écriture dans l'Assistant. Le message est enregistré et le super-admin le voit dans le cockpit Remontées.
      // if (id && canal === "analyse") ctx.waitUntil((async () => { try { await pushAll(env, { title: "💬 Question Assistant" + (auteur ? " — " + auteur : ""), body: texte.slice(0, 140), url: "/fkh-securite-apps/gestion/", tag: "fkh-asg-" + id }); } catch (e) {} })());
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
