-- Link codes let paperfetch, running on a researcher's own (campus) computer, send papers into one
-- project. A code is upload-only and project-scoped; only its SHA-256 is stored.

CREATE TABLE link_codes (
  code_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The researcher's statement, made when creating the code, that publisher terms allow sending
  -- the papers to the model for analysis.
  ai_permitted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX link_codes_project ON link_codes(project_id, owner_id);
