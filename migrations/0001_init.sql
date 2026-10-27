-- ChemBrain initial schema. Every row that holds user data carries owner_id so
-- authorization can be enforced in SQL on every query.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  brief_json TEXT,
  search_plan_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX projects_owner ON projects(owner_id);

-- Publisher credentials. secret_* holds AES-GCM ciphertext; settings_json holds
-- non-secret options (institutional network, AI-processing attestation).
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  secret_ciphertext TEXT,
  secret_iv TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  last_test_at TEXT,
  last_test_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, provider)
);

CREATE TABLE papers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doi TEXT,
  title TEXT NOT NULL,
  authors TEXT,
  year INTEGER,
  venue TEXT,
  publisher TEXT,
  abstract TEXT,
  landing_url TEXT,
  license TEXT,
  discovered_via TEXT NOT NULL,
  relevance REAL,
  relevance_reason TEXT,
  relevance_method TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  -- 1) can the user read it: unknown | open_access | entitled | user_confirmed | not_entitled
  user_access TEXT NOT NULL DEFAULT 'unknown',
  -- 2) did the integration retrieve it: discovered | abstract_only | full_text_retrieved |
  --    institutional_connection_required | permission_required | retrieval_failed | not_attempted
  retrieval_status TEXT NOT NULL DEFAULT 'discovered',
  retrieval_reason TEXT,
  retrieval_log_json TEXT,
  -- parse: not_parsed | parsed | parsing_incomplete | unreadable
  parse_status TEXT NOT NULL DEFAULT 'not_parsed',
  -- 3) is the intended AI processing permitted: open_license | user_attested | not_confirmed
  ai_permission TEXT NOT NULL DEFAULT 'not_confirmed',
  -- analysis: not_started | partial | analysis_complete | failed
  analysis_status TEXT NOT NULL DEFAULT 'not_started',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX papers_project ON papers(project_id, owner_id);
CREATE UNIQUE INDEX papers_project_doi ON papers(project_id, doi) WHERE doi IS NOT NULL;

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector TEXT NOT NULL,
  format TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  version_label TEXT,
  license TEXT,
  completeness TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  page_count INTEGER,
  char_count INTEGER NOT NULL,
  section_count INTEGER NOT NULL,
  has_methods INTEGER NOT NULL DEFAULT 0,
  supplementary_json TEXT,
  parse_notes TEXT,
  storage_key TEXT,
  retrieved_at TEXT NOT NULL
);
CREATE INDEX documents_paper ON documents(paper_id, owner_id);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  section TEXT,
  kind TEXT NOT NULL,
  label TEXT,
  page_start INTEGER,
  page_end INTEGER,
  text TEXT NOT NULL
);
CREATE INDEX chunks_document ON chunks(document_id, seq);
CREATE INDEX chunks_project ON chunks(project_id, owner_id);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  role TEXT,
  value_text TEXT,
  value_num REAL,
  unit TEXT,
  normalized_value REAL,
  normalized_unit TEXT,
  conversion_note TEXT,
  conditions TEXT,
  quote TEXT NOT NULL,
  quote_match TEXT NOT NULL,
  check_status TEXT NOT NULL DEFAULT 'unchecked',
  check_note TEXT,
  uncertainty TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX evidence_project ON evidence(project_id, owner_id);
CREATE INDEX evidence_paper ON evidence(paper_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  error TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  token_budget INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX jobs_project ON jobs(project_id, owner_id);

CREATE TABLE job_tasks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  paper_id TEXT,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX job_tasks_job ON job_tasks(job_id, seq);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT,
  model TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX reports_project ON reports(project_id, owner_id);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE model_usage (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT,
  job_id TEXT,
  stage TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX model_usage_owner ON model_usage(owner_id, created_at);
