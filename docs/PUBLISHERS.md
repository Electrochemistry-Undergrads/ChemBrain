# Publisher connections

Each researcher adds their own credentials under **Publisher connections**. ChemBrain never substitutes a shared key for a user's entitlement. Each card has a live **Test connection** that makes a handful of real requests and reports pass, warn, fail, or skipped with a plain-language reason.
At least one check must pass for the overall connection to be verified; an upstream outage with only warnings is not a successful verification.

**Test connection saves your edits first.** Blank credential fields keep their saved values. Use **Remove** to delete a saved server connection. Saving credentials or settings clears the previous test result.

The AI-processing checkboxes for Wiley and Elsevier browser mode are separate from access. Tick one only if your institution's licence permits sending that publisher's subscription text to Meta. Springer Nature uses its Open Access API only; open-licence papers keep their existing handling.

## Elsevier / ScienceDirect

### Use your browser's network on the hosted website

When a key works from your computer but fails from Cloudflare, use **Elsevier from this browser**, available under Publisher connections and on a project's Papers tab:

1. In Elsevier's key settings, set CORS Domains to `https://chembrain.pages.dev` (no trailing slash). For a preview deployment, add that preview's exact origin too.
2. Enter your API key in **Elsevier API key for this browser**, then choose **Use this browser** or **Test browser connection**. Never enter an institutional token into browser mode.
3. On the project's **Papers** tab, select Elsevier papers and click **Retrieve Elsevier using this browser**. The browser calls `api.elsevier.com` directly using your current network, then imports each XML file through ChemBrain's existing owner-scoped identity, completeness, and parsing checks.
4. Click **Analyse selected** after retrieval. Subscription text needs the browser mode's explicit AI-processing confirmation; open licences retain their existing handling.

The key is held only in tab memory and sent to Elsevier in a header, never in a URL, browser storage, the import request, or model inputs. Refreshing, closing the tab, changing accounts, or choosing **Forget browser key** clears it. Saved server keys are never returned to the browser. CORS, ScienceDirect API permissions, and your network's applicable access rights still apply. The browser stays on the hosted ChemBrain website; no local server is required.

The Elsevier/ScienceDirect server connection card has been removed. Automatic server retrieval does not call Elsevier, even if older server credentials are stored. Use browser mode above, or upload a PDF/XML file you can read.

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

- **Credential:** the **Open Access API key** from dev.springernature.com → API Management. This is the only Springer field on the website.
- **Docs:** https://dev.springernature.com/docs/api-endpoints/open-access/
- **Full text:** `GET /openaccess/jats?q=doi:{doi}&api_key=…` retrieves open-access JATS XML. Connection tests check only this endpoint.
- **Discovery:** Crossref and Europe PMC find papers, including Springer Nature papers. The website does not call the Meta or subscription Full Text APIs.
- **Existing keys:** an older shared key remains usable as an OA fallback. Removed metadata/full-text credentials and agreement settings are not activated. Saving a replacement OA key keeps only that active credential.
- **Limits (Basic):** 100 requests/min and 500/day. ChemBrain paces requests at about one per 650 ms.
- **401/403:** check that the key is active for the Open Access API in API Management.

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

Run `npm run test:live`. These local diagnostic tools retain legacy connector checks; the website uses Elsevier browser mode and Springer OA only. Leave unused values empty. `SPRINGER_API_KEY` is the shared-key fallback; the API-specific values override it. Set `SPRINGER_FULLTEXT_AGREEMENT=true` only for an approved agreement. Output contains statuses and redacted diagnostics, never credentials. Local network entitlement may differ from the deployed Cloudflare server.

## Crossref and Europe PMC (no credentials)

- **Crossref** (`api.crossref.org/works`) is used for discovery and DOI metadata only, in the polite pool when `CONTACT_EMAIL` is configured. A DOI, abstract, or `link` URL is never counted as a retrieved paper.
- **Europe PMC** search, and `…/rest/{PMCID}/fullTextXML` for open-access JATS. The version is labelled because it may be an accepted manuscript.

## Live verification status

The fixture tests in `tests/connectors.test.ts` exercise documented behaviours only. Live access is verified per user with **Test connection** in the deployed app, or locally with `npm run test:live`.
