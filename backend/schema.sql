-- GESTION FKH — schéma de la base D1 (Cloudflare)
-- Chaque « tiroir » de l'appli (clé localStorage) = une ligne.
CREATE TABLE IF NOT EXISTS store (
  k          TEXT PRIMARY KEY,   -- ex. 'fkh_suivi', 'fkh_fa', 'fkh_thiam'…
  v          TEXT NOT NULL,      -- la valeur JSON (chaîne), telle que stockée côté appli
  updated_at INTEGER NOT NULL    -- horodatage ms de la dernière écriture (pour la synchro)
);
CREATE INDEX IF NOT EXISTS idx_store_updated ON store(updated_at);

-- ─────────────────────────────────────────────────────────────────────────
-- ÉVOLUTION FUTURE (accès par utilisateur / par section) — NON activé au MVP.
-- Quand on passera du « mot de passe commun » aux comptes individuels :
--   décommenter, remplir, et brancher la vérification dans worker.js.
-- ─────────────────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS users (
--   login      TEXT PRIMARY KEY,   -- identifiant de connexion
--   pass_hash  TEXT NOT NULL,      -- empreinte du mot de passe (jamais en clair)
--   sections   TEXT NOT NULL,      -- JSON : ['demandes','thiam','suiviappels'] = sections autorisées
--   role       TEXT DEFAULT 'agent',
--   created_at INTEGER NOT NULL
-- );
