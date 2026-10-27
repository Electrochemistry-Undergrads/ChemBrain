# Publisher connections

Each researcher adds their own credentials under **Publisher connections**. ChemBrain never substitutes a shared key for a user's entitlement. Each card has a live **Test connection** that makes a handful of real requests and reports pass, warn, fail, or skipped with a plain-language reason.

The AI-processing checkbox on each card is separate from access. Tick it only if your institution's licence permits sending that publisher's subscription text to an external AI service (Meta). Open-licence (Creative Commons) papers are analysed regardless.

## Elsevier / ScienceDirect

- **Docs:** https://dev.elsevier.com/sd_apis.html · https://dev.elsevier.com/tecdoc_api_authentication.html
- **Credentials:** an API key from dev.elsevier.com, plus an optional **institutional token** from your library.
- **Endpoints used:**
  - `GET https://api.elsevier.com/content/article/entitlement/doi/{doi}` (JSON `entitled`)
  - then `GET https://api.elsevier.com/content/article/doi/{doi}?view=FULL` (`Accept: text/xml`)
  - Headers: `X-ELS-APIKey`, optionally `X-ELS-Insttoken`.
- **Entitlement:** the API key only identifies the application. Subscription entitlement comes from campus IP or the institutional token. ChemBrain runs in the cloud, so **without a token only open-access articles are retrievable**. Subscription papers then show *Institutional connection required*.
- **Abstract-only detection:** a response without `originalText` / `ce:sections` is recorded as *Abstract only*.
- **Limits:** Article Retrieval 10 req/s, 50,000/week. Entitlement 6 req/s. ChemBrain paces at about 6 req/s, and `QUOTA_EXCEEDED` (429) is reported explicitly.
- **Connection test:** entitlement for an open-access Heliyon article (validates the key), then a subscription Electrochimica Acta article (reports whether subscription access works from ChemBrain's servers).

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
- **Connection test:** probes an open-access article (validates the token) and a subscription Angewandte article (reports network entitlement) without downloading files.

## Springer Nature

- **Docs:** https://dev.springernature.com/docs/api-endpoints/open-access/ · https://dev.springernature.com/docs/api-endpoints/fulltext-api/
- **Credentials:** an API key from dev.springernature.com.
- **Discovery:** `GET https://api.springernature.com/meta/v2/json?q=…&p=…&api_key=…`
- **Full text:**
  - Open access: `GET /openaccess/jats?q=doi:{doi}&api_key=…`
  - Subscription articles use the **Full Text API** (`/xmldata/jats`). It requires an approved TDM agreement, and ChemBrain only calls it when you tick *I hold an approved full-text agreement*. **A free or open-access key never appears to unlock subscription Nature articles.** Without the agreement, the attempt is recorded as *Permission required (agreement required)*.
- **Limits (Basic):** 100 requests/min and 500/day per API. ChemBrain paces at about 1 request per 650 ms.

## Crossref and Europe PMC (no credentials)

- **Crossref** (`api.crossref.org/works`) is used for discovery and DOI metadata only, in the polite pool when `CONTACT_EMAIL` is configured. A DOI, abstract, or `link` URL is never counted as a retrieved paper.
- **Europe PMC** search, and `…/rest/{PMCID}/fullTextXML` for open-access JATS. The version is labelled because it may be an accepted manuscript.

## Live verification status

The fixture tests in `tests/connectors.test.ts` exercise documented behaviours only. Live access is verified per user with **Test connection** in the deployed app, or locally with `npm run test:live`.
