# ChemBrain

ChemBrain turns a desired chemical product or material into a research-backed development proposal. A researcher types a sentence or two describing their compound or material ("a biodegradable, water-resistant packaging film made from starch, cast from water") and clicks **Find papers**. There are no forms of parameters to fill in. ChemBrain then:

1. plans literature searches with Meta's model, inferring target properties and constraints from the description (keywords from the description are used when Meta is not configured),
2. discovers papers (Crossref and Europe PMC),
3. retrieves complete papers through the researcher's **own** publisher access,
4. parses them into sections and chunks that keep their section, page, and table references,
5. extracts ingredients, methods, conditions, and results with Meta's model,
6. checks every extracted value against the exact passage it came from,
7. compares approaches across papers, and
8. writes a cited research proposal.

**Evidence traceability is the core feature.** Every experimental value links to the paper, section, page or table, and the verbatim passage that supports it. Quotes that cannot be found in the retrieved document are rejected. A numeric value is rejected if it does not appear in its own quote. Proposal citations that refer to unknown evidence are removed and counted.

Live site: https://chembrain.pages.dev/ · Build info: https://chembrain.pages.dev/build-info.json · Health: https://chembrain.pages.dev/api/health

> ChemBrain produces research plans for researcher review. Its proposals are not experimentally validated formulations.

## Contents

- [Architecture](docs/ARCHITECTURE.md): modules, data model, job orchestration, security model
- [Deployment](docs/DEPLOYMENT.md): Cloudflare resources, secrets, migrations, release checks, rollback
- [Publisher connections](docs/PUBLISHERS.md): Elsevier, Wiley, Springer Nature, and what each one can and cannot retrieve
- [Meta configuration](docs/META.md): model, budgets, prompts, failure handling
- [Demonstration walkthrough](#hackathon-demonstration-walkthrough)
- [Known limitations](#known-limitations)

## Quick start (local development)

Requirements: Node 22+ and npm.

```bash
npm install
```

Create `.dev.vars` (git-ignored) with a local encryption key, and add `MODEL_API_KEY=` if you have a Meta key:

```bash
printf 'CREDENTIALS_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars
```

Create the local database:

```bash
npm run db:migrate:local
```

Build and run the full stack (static site, Pages Functions, and local D1) at http://127.0.0.1:8788:

```bash
npm run build && npx wrangler pages dev dist --port 8788
```

For frontend-only hot reload, run `npm run dev` in a second terminal. Vite proxies `/api` to port 8788.

### Checks

```bash
npm run check
```

That runs the typecheck, the test suite, the production build, and the secret scan. The tests run against a real local D1 (workerd/SQLite) and cover:

- document parsing and identity checks on four real CC BY papers
- evidence-to-citation validation, fabricated-quote rejection, and value-in-quote checks
- unit normalisation (ambiguous `%` is never converted)
- authentication, CSRF protection, and cross-user isolation (16 guessed-ID, search, export, and evidence probes)
- credential encryption, revocation, and redaction
- retry, timeout, rate-limit, and redirect policies for each connector
- background-job crash recovery (expired leases), the Meta-not-configured pause, and budget enforcement

Upstream services are simulated with **labelled fixtures** (`tests/fixtures.ts`, `tests/connectors.test.ts`). Passing them does not verify live subscription access.

Bounded live checks against the real services, using credentials you put in `.dev.vars.live-test` (git-ignored):

```bash
npm run test:live
```

## Access, privacy, and credentials (summary)

- **No sign-in page (for now).** Each browser gets a private workspace: a real server-side account bound to an HttpOnly, Secure session cookie. Every query is scoped to the owner. Other users' objects return 404, never 403. Username/password accounts exist in the API and can be re-enabled in the UI later.
- **Each researcher uses their own publisher access.** Credentials are AES-256-GCM encrypted with a per-user key derived (HKDF) from the `CREDENTIALS_KEY` secret, bound to user and provider. They are never returned to the browser, logged, sent to the model, or exported, and can be revoked at any time.
- **Three separate questions are tracked for every paper:** can the user read it, could the integration retrieve it, and is AI processing permitted. Subscription access does not imply permission to send text to Meta. That needs an open licence or the researcher's explicit confirmation for that publisher or upload.
- No university passwords and no MFA automation. Retrieved content is never cached across users, never published, and never used for training. The Meta API's standard mode does not train on inputs.

## Hackathon demonstration walkthrough

1. Open https://chembrain.pages.dev/. Your private workspace is created automatically.
2. Click **Open a demonstration project**. It contains four real CC BY 4.0 papers on water-resistant biodegradable films, bundled from Europe PMC and clearly labelled as a demonstration (not live publisher calls). The description is pre-filled.
3. **Workspace → Analyse selected papers.** Watch the stages: retrieve and parse, then extract, check, and compare (each Meta stage is a live call). The coverage bar shows discovered, readable, retrieved, parsed, and analysed counts.
4. In **Extracted evidence**, click any source link. The drawer shows the paper, section, page or table, and the passage with the quote highlighted. Tick **Show rejected items** to see what verification threw out.
5. **Results** shows the assessment, ranked approaches, ingredient, method, and performance comparisons (with comparability warnings), conflicts, missing evidence, ChemBrain's own adaptations (labelled as not published), next experiments, and what the sources do not establish. Every green number opens its passage. Use **Export Markdown** or **Export JSON**.
6. Ask a question in **Ask the sources**, e.g. "Which plasticiser concentration gave the lowest water vapour permeability?"
7. To show live discovery, type a description of a compound on the start page and click **Find papers**. ChemBrain plans the queries, searches, ranks the results, and opens the paper list, all in one step. The queries it used are shown under **Searched for**. Connect a publisher under **Publisher connections**; each card has a live **Test connection**.

## Known limitations

- **Campus-IP entitlement does not reach the cloud.** Elsevier uses the browser mode below. Wiley subscription content is served only to the institution's network, so those papers show *Institutional connection required*. The researcher can upload a PDF they can open, and it gets the same identity and completeness checks.
- **Elsevier browser mode:** the hosted website can retrieve articles directly through your browser's network. Enter a tab-only key under **Elsevier from this browser**, then use **Retrieve Elsevier using this browser** in Papers before analysis. Add the website's exact origin to your key's CORS Domains. The key is never included in the document import or model requests. See [Publisher connections](docs/PUBLISHERS.md).
- **Springer Nature** uses only the Open Access API. Add its OA key under Publisher connections. Metadata discovery comes from Crossref and Europe PMC; subscription full-text API access is not offered on the website.
- **ACS and RSC** offer no text-mining API for this use, so their papers need an upload.
- **Supporting information** is listed when the XML references it, but is not retrieved automatically. The Wiley TDM API does not deliver it.
- **PDF parsing** extracts text, not layout: tables and equations become plain text. Scanned PDFs without a text layer are reported as *Unreadable*. OCR is not performed.
- **Long-running work is driven by the open browser tab.** Jobs are resumable server-side tasks, but one runs only while the Workspace tab is open. Closing the tab pauses it, and reopening resumes it.
- **Cloudflare Free plan CPU limit (10 ms per request).** Large PDFs and XML documents may exceed it on the Free plan. Those steps are retried, then reported as failed with an explicit reason. The Workers Paid plan removes this limit. It is not enabled automatically.
- Guest workspaces are tied to the browser's cookie. Clearing cookies starts a new, empty workspace.
