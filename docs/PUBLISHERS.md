# Publisher connections

Each researcher adds their own credentials under **Publisher connections**. ChemBrain never substitutes a shared key for a user's entitlement. Each card has a live **Test connection** that makes a handful of real requests and reports pass, warn, fail, or skipped with a plain-language reason.
At least one check must pass for the overall connection to be verified; an upstream outage with only warnings is not a successful verification.

**Test connection saves your edits first.** Blank credential fields keep their saved values, so replacing an institutional token or one Springer API key does not erase the other keys. Use **Remove** to delete the entire connection. Saving credentials or settings clears the previous test result.

The AI-processing checkbox on each card is separate from access. Tick it only if your institution's licence permits sending that publisher's subscription text to an external AI service (Meta). Open-licence (Creative Commons) papers are analysed regardless.

## Elsevier / ScienceDirect

- **Docs:** https://dev.elsevier.com/sd_apis.html · https://dev.elsevier.com/tecdoc_api_authentication.html
- **Credentials:** an API key from dev.elsevier.com, plus an optional **institutional token** from your library.
- **Endpoints used:**
  - `GET https://api.elsevier.com/content/article/entitlement/?doi={url-encoded DOI}` (XML `entitled`, including `open_access`)
  - then `GET https://api.elsevier.com/content/article/doi/{doi}?view=FULL` (`Accept: text/xml`)
  - Headers: `X-ELS-APIKey`, optionally `X-ELS-Insttoken`.
- **Entitlement:** the API key only identifies the application. Subscription entitlement comes from campus IP or the institutional token. ChemBrain runs in the cloud, so campus access does not carry over. Even open-access articles require verified API entitlement and applicable access rights, as explained in [Elsevier's access documentation](https://dev.elsevier.com/tecdoc_article_access.html). An open-access licence alone does not guarantee API retrieval.
- **Abstract-only detection:** a response without `originalText` / `ce:sections` is recorded as *Abstract only*.
- **Limits:** Article Retrieval 10 req/s, 50,000/week. Entitlement 6 req/s. ChemBrain paces at about 6 req/s, and `QUOTA_EXCEEDED` (429) is reported explicitly.
- **Entitlement-service failures:** a temporary 5xx from the preflight does not establish that the key is invalid. ChemBrain still tries Article Retrieval, which enforces the publisher's access permissions itself. Negative entitlement responses remain respected.
- **Hosted-server failures:** if the publisher still returns 5xx after bounded retries, the result is an unverified service error rather than an invalid-key claim. If the key works locally but not from ChemBrain, ask your library or Elsevier to check institutional-token or hosted-server API access. The HTTP status alone cannot establish whether IP entitlement, an upstream outage, or another publisher-side condition caused it.
- **Connection test:** entitlement for an open-access Heliyon article, with a separate Article Retrieval metadata check if the entitlement check cannot confirm access, then a subscription Electrochimica Acta article. An entitlement outage is a warning. A successful metadata check validates that API connection, not full-text or subscription access. A key must have ScienceDirect/Article Retrieval permissions; a Scopus-only key may not have them.

## Wiley / Wiley-VCH

- **Docs:** https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining
- **Credentials:** a TDM client token. Sign in to Wiley Online Library, open Text and Data Mining, accept the licence, and copy the token.
- **Endpoint:** `GET https://api.wiley.com/onlinelibrary/tdm/v1/articles/{url-encoded DOI}` with header `Wiley-TDM-Client-Token`. The API redirects to a file server. ChemBrain follows HTTPS redirects but **removes the token header when leaving wiley.com**, and rejects anything that is not a PDF (for example a login page).
- **Status mapping:**

  | HTTP | Meaning in ChemBrain |
  |---|---|
  | 400 | no token |
  | 403 | invalid or unregistered token |
  | 404 | no access → *Institutional connection required* |
  | 429 | rate limited |

- **Entitlement:** subscription content is served only to requests from the subscribing institution's network. ChemBrain's servers are not on it, so only open-access Wiley articles retrieve automatically. For other papers, use **Upload the PDF or XML** on the paper. The upload passes the same identity and completeness checks.
- **Limits:** 3 articles/s and 60 requests per 10 minutes. ChemBrain enforces one request every 10 s per user, tracked in D1 across requests.
- **Supporting information:** not delivered by this API. It is reported separately.
- **Connection test:** probes an open-access article (validates the token) and a subscription Angewandte article (reports network entitlement) without following download redirects. Insecure/login redirects are not counted as success. If the OA test passes but subscription returns 403/404, the token remains accepted and subscription access is reported separately as a warning.

## Springer Nature

- **Docs:** https://dev.springernature.com/docs/api-endpoints/open-access/ · https://dev.springernature.com/docs/api-endpoints/fulltext-api/
- **Credentials:** activate the APIs you need at dev.springernature.com → API Management. Save a shared API key, or supply **Meta API key**, **Open Access API key**, and **Full Text API credential** separately. An API-specific value takes precedence over the shared key. Existing shared keys keep working without re-entry. A connection with only an OA key can retrieve OA articles; metadata discovery remains available through the other discovery sources.
- **Full Text credential format:** the [Full Text API documentation](https://dev.springernature.com/docs/api-endpoints/fulltext-api/) specifies `api_key=YOUR_API_KEY/YOUR-API-METRIC`. Copy the complete `key/metric` value from API Management after activation, and enable the agreement checkbox only if your agreement is approved.
- **Discovery:** `GET https://api.springernature.com/meta/v2/json?q=…&p=…&api_key=…`
- **Full text:**
  - Open access: `GET /openaccess/jats?q=doi:{doi}&api_key=…`
  - Subscription articles use the **Full Text API** (`/xmldata/jats`). It requires an approved TDM agreement, and ChemBrain only calls it when you tick *I hold an approved full-text agreement*. **A free or open-access key never appears to unlock subscription Nature articles.** Without the agreement, the attempt is recorded as *Permission required (agreement required)*.
- **Limits (Basic):** 100 requests/min and 500/day per API. ChemBrain paces at about 1 request per 650 ms.
- **401/403:** check the credential and activation for the specific API that failed. Success on one API does not establish access to another. A missing optional API key is skipped in the test. For an existing shared key accepted by one API, rejection by another is a warning, keeping the working connection usable. A key rejected by all APIs, or a rejected explicitly configured API-specific credential, still fails. Failure of the OA API does not prevent trying an independently configured, approved Full Text API connection.

## Local live tests

Put only the credentials you want to test in the git-ignored `.dev.vars.live-test` file:

```dotenv
ELSEVIER_API_KEY=
ELSEVIER_INSTTOKEN=
WILEY_TDM_TOKEN=
SPRINGER_API_KEY=
SPRINGER_META_API_KEY=
SPRINGER_OA_API_KEY=
SPRINGER_FULLTEXT_API_KEY=
SPRINGER_FULLTEXT_AGREEMENT=false
```

Run `npm run test:live`. Leave unused values empty. `SPRINGER_API_KEY` is the shared-key fallback; the API-specific values override it. Set `SPRINGER_FULLTEXT_AGREEMENT=true` only for an approved agreement. Output contains statuses and redacted diagnostics, never credentials. Local network entitlement may differ from the deployed Cloudflare server.

## Crossref and Europe PMC (no credentials)

- **Crossref** (`api.crossref.org/works`) is used for discovery and DOI metadata only, in the polite pool when `CONTACT_EMAIL` is configured. A DOI, abstract, or `link` URL is never counted as a retrieved paper.
- **Europe PMC** search, and `…/rest/{PMCID}/fullTextXML` for open-access JATS. The version is labelled because it may be an accepted manuscript.

## Live verification status

The fixture tests in `tests/connectors.test.ts` exercise documented behaviours only. Live access is verified per user with **Test connection** in the deployed app, or locally with `npm run test:live`.
