-- Porte "messages" entre l'appli GESTION et Claude.
-- 1 ligne = 1 demande d'un collaborateur + (plus tard) la reponse de Claude.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  canal       TEXT NOT NULL,              -- 'analyse' (question/fichier) | 'retour' (besoin/observation)
  auteur      TEXT,                        -- qui a ecrit (nom saisi cote appli)
  texte       TEXT NOT NULL,               -- la demande / l'observation
  fichier     TEXT,                        -- reference/URL d'un fichier (R2) en v2, sinon NULL
  statut      TEXT NOT NULL DEFAULT 'nouveau', -- nouveau | en_cours | repondu
  reponse     TEXT,                        -- la reponse de Claude
  created_at  INTEGER NOT NULL,            -- horodatage ms de depot
  replied_at  INTEGER                      -- horodatage ms de reponse
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_replied ON messages(replied_at);
CREATE INDEX IF NOT EXISTS idx_messages_statut  ON messages(statut);
