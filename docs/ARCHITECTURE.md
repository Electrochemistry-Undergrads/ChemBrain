# Architecture

ChemBrain runs entirely on the existing Cloudflare Pages project `chembrain`:

```
Browser (React + TypeScript + Vite, served from dist/)
   │  same-origin fetch /api/*  (HttpOnly session cookie + x-chembrain header)
   ▼
Cloudflare Pages Function  functions/api/[[path]].ts  →  server/api/router.ts
   ├── D1 (binding DB): users, sessions, projects, papers, documents, chunks, evidence, jobs, reports
   ├── optional private R2 (binding DOCS): original files, only if bound and RETAIN_ORIGINALS=true
   ├── Publisher APIs (per-user credentials): Elsevier, Wiley, Springer Nature; Crossref; Europe PMC
   └── Meta Model API (server secret MODEL_API_KEY): https://api.meta.ai/v1/chat/completions
```

`npm run build` bundles the Functions itself with the pinned Wrangler version (`wrangler pages functions build --outdir dist/_worker.js`). Pages then serves that bundle as-is ("advanced mode") instead of re-bundling `functions/` in its build image. This matters because the build image's bundler mis-compiles pdf.js class static blocks: PDF parsing failed in production until this step was added. `public/_routes.json` limits the Worker to `/api/*`, so static assets never invoke it.

There is no separate backend or background Worker. Long work is split into small resumable tasks (see *Job orchestration*), so every request stays within the Pages Functions limits, and the only thing deployed is the Pages project. The retired standalone Worker named `chembrain` is unrelated and stays disabled.

## Modules

| Concern | Location | Notes |
|---|---|---|
| Publisher connectors | `server/connectors/` | `elsevier.ts`, `wiley.ts`, `springer.ts`, `crossref.ts`, `europepmc.ts`; routing in `index.ts`; DOI-prefix publisher mapping in `publishers.ts` |
| HTTP policy | `server/http/fetcher.ts` | timeouts, bounded retries with jitter and Retry-After, per-service pacing, manual redirects limited to known hosts, credentials stripped on cross-host redirects, capped body reads |
| Document parsing | `server/parsing/` | own XML parser (no DTD/entity resolution) → `jats.ts` (Springer Nature, Europe PMC) and `elsevier.ts` (full-text-retrieval-response); `pdf.ts` (unpdf / pdf.js serverless build) with heading detection, page tracking, running-header removal; `quality.ts` (identity, completeness, login-page sniffing); `chunk.ts` |
| Meta inference | `server/meta/` | `client.ts` (streamed chat completions, `response_format: json_schema`, retries, usage + budgets), `schemas.ts` (zod → JSON Schema), `prompts.ts` |
| Evidence extraction and validation | `server/evidence/`, `server/jobs/analysis.ts` | deterministic quote matching and value-in-quote checks; unit normalisation; cross-paper proposal with citation validation |
| Authentication and authorization | `server/auth/`, `server/api/access.ts` | PBKDF2 passwords (named accounts), guest workspaces, hashed session tokens, CSRF check, D1 rate limits; owner-scoped lookups |
| Credential encryption | `server/crypto/secrets.ts` | AES-256-GCM, HKDF per user, AAD = user:provider; redaction helper |
| Job orchestration | `server/jobs/runner.ts`, `server/jobs/documents.ts` | leased D1 tasks |
| Search planning without Meta | `server/search/keywords.ts` | keyword queries from the free-text description |
| User interface | `src/` | one-box search (dashboard and Describe tab, `src/lib/search.ts`), papers, workspace, results, connections, your data |

## Data model (D1)

`migrations/0001_init.sql`. Every user-data row carries `owner_id`, and every query filters on it. Deleting a project or account cascades through foreign keys (D1 enforces them) to papers, documents, chunks, evidence, jobs, reports, and questions.

Per paper, these are tracked **separately**:

| Column | Values |
|---|---|
| `user_access` (can the user read it?) | unknown, open_access, entitled, user_confirmed, not_entitled |
| `retrieval_status` (did an integration retrieve it?) | discovered, abstract_only, full_text_retrieved, institutional_connection_required, permission_required, retrieval_failed |
| `parse_status` | not_parsed, parsed, parsing_incomplete, unreadable |
| `ai_permission` (may it be sent to Meta?) | open_license, user_attested, not_confirmed |
| `analysis_status` | not_started, in_progress, partial, analysis_complete |

The full attempt log (connector, status, plain-language reason) is stored in `retrieval_log_json`. Coverage (`server/api/access.ts`) keeps confirmed-readable papers that failed to retrieve in the denominator.

## Retrieval pipeline

For each selected paper, `retrievePaper` tries:

1. the publisher's own connector, chosen by DOI prefix: Elsevier (entitlement check, then XML `view=FULL`) or Springer Nature (Open Access JATS; the Full Text API only with a declared agreement)
2. Europe PMC open-access JATS
3. Wiley TDM (PDF, paced to one request every 10 s per user)

The first success is validated in `ingestDocument`:

- **Content sniffing:** HTML login pages and JSON errors are rejected.
- **Identity:** the DOI must match, or the title must be clearly present. A mismatch is rejected.
- **Completeness:** abstract-only and unreadable documents are never counted as full text.

The validated document is then chunked into pieces of at most 3,500 characters. Each chunk keeps its section path, table or figure label, and page range. References are excluded from analysis, and supplementary files are listed separately.

## Meta stages

1. **Search planning:** the researcher's free-text description → interpretation (with stated assumptions), inferred target properties, 4–8 queries. A Meta relevance screen of the top 40 candidates (title and abstract) follows. Both run automatically from one **Find papers** click (`src/lib/search.ts`). Without Meta, queries are the description's keywords and ranking is keyword overlap; both are labelled as such in the UI.
2. **Extraction:** every chunk of each permitted document is processed, in windows of about 14,000 characters. Each item carries `chunk_ref`, a verbatim quote, the value as written, and the unit as written.
3. **Checking:** deterministic first: the quote must occur in the cited chunk (whitespace, hyphenation, and ligature tolerant), and the value must occur in the quote. Then Meta judges each remaining item: supported, partially supported, or unsupported.
4. **Comparison and proposal:** only checked evidence (supported or partially supported) is sent. All `E#` and `P#` references in the output are validated, unknown ones are removed and counted, and uncited performance claims are dropped.

Paper text is wrapped in `<document>` and `<chunk>` blocks. Delimiter tags inside the text are neutralised, and the system prompt declares that content untrusted. The model has no tools, and its output is used only after schema validation.

## Job orchestration

`POST /api/projects/:id/jobs` creates one `retrieve` task per selected paper plus a final `compare` task. Each `retrieve` task enqueues `extract` windows and a `check` task for its paper. The Workspace tab calls `POST …/jobs/:jid/step` in a loop. Each step:

1. selects the next runnable task (a `check` waits for its paper's extracts; `compare` waits for everything),
2. claims it with an atomic `UPDATE … RETURNING` under a 4-minute lease,
3. runs it within one request's limits (at most a few subrequests and well under 50 D1 queries),
4. records the outcome.

How outcomes are handled:

- **Worker crash or closed tab:** the lease expires and the task is reclaimed.
- **Retryable failures** (Meta 429/5xx, publisher rate limits): the task goes back to pending with a not-before time. Rate-limited tasks get up to 8 attempts; others get 3.
- **Configuration problems** (Meta key missing or rejected, billing) and **budget exhaustion:** the job is paused, not failed. Resume adds one more budget increment.

## Security model

- **Sessions:** 256-bit random tokens, stored as SHA-256 hashes, in `__Host-` cookies (HttpOnly, Secure, SameSite=Lax).
- **CSRF:** state-changing requests must match the origin and carry the `x-chembrain` header.
- **Authorization:** every lookup is owner-scoped. Foreign IDs return 404, never 403.
- **Credentials:** encrypted at rest, never returned or logged, never put in prompts or exports. Upstream messages are passed through `redact()`.
- **Headers** (`public/_headers`): CSP with `default-src 'self'`, `frame-ancestors 'none'`, HSTS, no referrer, `noindex`.
- **Tenant isolation:** there is no cross-user cache of subscription content. Each user's retrieval is their own.
