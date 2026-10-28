# paperfetch

Gets the **full text, methods and Supporting Information** of research papers so the
synthesis-plan generator works from real procedures instead of abstracts.

## Why full text was failing

Two separate problems, both measured on this machine:

1. **Metadata APIs only return abstracts.** OpenAlex, Crossref and Semantic Scholar tell you a
   paper exists and sometimes where a PDF is. They don't give you the paper.
2. **Publisher sites block scripts, even for open-access papers.** ChemRxiv, Wiley, RSC,
   ACS and many university repositories return `403` to any non-browser client. That
   includes the "free PDF" links the metadata APIs hand you. arXiv and PubMed Central are
   the exceptions.

paperfetch avoids both problems by only using routes that are *built* for machine access, in
this order (structured XML first, because it keeps section boundaries so the methods come
out clean):

| # | Route | What it covers | Needs |
|---|-------|----------------|-------|
| 1 | Your inbox folder + Zotero library | anything you've downloaded yourself | nothing |
| 2 | PubMed Central open-data bucket (AWS), Europe PMC, NCBI BioC | OA papers **and NIH author manuscripts** (lots of JACS / JOC / Org Lett), with SI for OA papers | nothing |
| 3 | Elsevier Article API | ScienceDirect full-text XML + SI | free key, UT network/VPN |
| 4 | Springer Nature OA API | Springer/Nature OA as JATS | free key |
| 5 | Wiley TDM API | Wiley full-text PDF | free token, UT network/VPN |
| 6 | OpenAlex content | OpenAlex's cached PDFs / GROBID XML | free key |
| 7 | bioRxiv/medRxiv JATS | preprints | nothing |
| 8 | OA links: OpenAlex, Unpaywall, Semantic Scholar, **Crossref text-mining links** | repository copies; Springer/Nature subscribed PDFs when on UT network | `CONTACT_EMAIL` for Unpaywall |
| 9 | Publisher landing page `citation_pdf_url` | the few publishers that allow it | nothing |
| 10 | CORE | repository manuscripts | free key |
| 11 | arXiv | preprints | nothing |

Every downloaded file is checked: it must be a real PDF/XML with at least 4,000 characters of
body text, and the title has to match the paper you asked for. Anything that fails goes to
the next route.

What it does **not** do: pretend to be a browser, solve bot challenges, or use shadow
libraries. If a publisher only serves humans, the paper goes to `download_queue.html` and you
download it (see "Getting to 90%").

## Setup

Run everything from this folder (`ChemBrain/paperfetch`). It's a local Python tool, separate from the
web app, and it isn't part of the Cloudflare build.

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r requirements.txt
```

```bash
cp .env.example .env
```

Then fill in `.env`. Every key is optional, and `python -m paperfetch status` shows which routes are on.

## Usage

```bash
.venv/bin/python -m paperfetch fetch 10.1021/jacs.1c06913 10.1039/d0sc06223e "arXiv:2006.10256"
```

```bash
.venv/bin/python -m paperfetch fetch --file my_dois.txt
```

The input can be a DOI, a DOI URL or publisher URL, an arXiv id, a PMCID, a PMID, or an exact title.

Output:
- `cache/papers/<doi>/fulltext.md`: the whole paper, by section
- `cache/papers/<doi>/methods.md`: experimental/methods sections plus SI text
- `cache/papers/<doi>/paper.json`: the full record, including every route tried and why it failed
- `output/download_queue.html` + `output/zotero_dois.txt`: what's left for you to download

### In the synthesis pipeline

```python
from paperfetch import fetch_many
from paperfetch.context import build_context

papers = fetch_many(["10.1021/jacs.1c06913", "10.1039/d0sc06223e"])
llm_context = build_context(papers)   # methods + SI first; each source marked FULL TEXT / ABSTRACT ONLY
```

`build_context` starts with an instruction telling the model to take reagents, amounts and
conditions only from FULL TEXT sources. That stops it from making up a procedure for a paper
it only saw the abstract of.

`paper.coverage` is `full`, `abstract` or `none`; `paper.methods_text()` is the procedures
text; `paper.si_status` says whether the SI was retrieved.

### From Claude (MCP server)

`paperfetch/mcp_server.py` exposes paperfetch to Claude Code (or any MCP client) as tools:

| Tool | What it does |
|------|--------------|
| `search_papers` | finds papers on a topic via OpenAlex, filtered to ACS / Elsevier / Nature / Springer / Wiley / RSC (metadata only, max 25) |
| `fetch_papers` | gets full text, methods and SI for up to 20 papers, using the same routes as `fetch` |
| `read_paper` | returns a fetched paper's methods + SI, full text, SI only, or a labelled summary block |
| `search_library` | searches the text of every paper already fetched, one snippet per paper |
| `synthesis_context` | the `build_context` block for planning a synthesis |
| `access_status` | which routes are on, how many papers still need a PDF saved by hand, and the download list |
| `send_to_chembrain` | sends a ChemBrain project's missing papers into it (see below) |

Register it once from this folder (see the command below); Claude Code asks you to approve it the first
time you start a session here. The server adds no new download routes, so the rules above still
apply: run it on the campus network or VPN, and ACS/RSC papers come in through `inbox/` or Zotero.
Calls are capped so Claude can't bulk-crawl a publisher.

**On someone else's laptop:** it works with whatever access that laptop has. Clone ChemBrain,
`cd paperfetch`, follow Setup, put their own keys in `.env` (keys are per person, don't share yours), set
`LIBRARY_PROXY_PREFIX` if they aren't at UT, and register it from the project folder:

```bash
claude mcp add paperfetch --scope project -e PYTHONPATH="$PWD" -- "$PWD/.venv/bin/python" -m paperfetch.mcp_server
```

It doesn't give a hosted website institutional access: a server in the cloud isn't on anyone's
campus network, so publishers see it as unentitled. To get papers into ChemBrain, use `push`.

### Sending papers to ChemBrain

ChemBrain's servers can't open subscription papers, but your computer on the campus network or VPN
can. In a ChemBrain project, open **Papers → Send papers from your campus computer**, confirm you're
entitled to read the papers, and create a link code. Then, from this folder:

```bash
.venv/bin/python -m paperfetch push https://chembrain.pages.dev cbl_your_code
```

It asks the project which papers still lack full text, fetches up to 20 per run (`--limit`, max 50)
and uploads them, each with its Supporting Information. ChemBrain runs its usual identity and
completeness checks, so a wrong or partial paper is rejected rather than counted as full text.
Papers it can't get, mostly ACS and RSC, are printed with UT library links and written to
`output/download_queue.html`. Save those PDFs into `inbox/` and run the same command again.

The code only uploads into that one project, expires after 7 days, and can be revoked in the panel.
From Claude, the `send_to_chembrain` tool does the same thing.

## Getting to 90%

Measured on 2026-10-26: 120 random chemistry/materials "synthesis" papers, 20 per publisher, run from the UT network
with **no keys configured**:

| Publisher | Full text now | Methods found | What closes the gap |
|-----------|--------------:|--------------:|---------------------|
| Nature    | 20/20 (100%) | 16 | done (PMC + Nature TDM links) |
| Springer  | 19/19 (100%) | 11 | done (Springer TDM links, UT-entitled) |
| ACS       |  9/20 (45%)  |  8 | assisted download (11 left) |
| Elsevier  |  3/20 (15%)  |  3 | `ELSEVIER_API_KEY` on UT network (17 left) |
| RSC       |  3/21 (14%)  |  3 | assisted download (18 left) |
| Wiley     |  1/20 (5%)   |  0 | `WILEY_TDM_TOKEN` on UT network (19 left) |
| **Total** | **55/120 (46%)** | 41 | |

Projected (not yet measured, because it needs your keys): Elsevier and Wiley keys could add up to 36
papers, which would make about 76% fully automatic. ACS and RSC (29 papers here) have no automated
route, so 90% needs the assisted step for at least 17 of them, and 100% is reachable with it.

Steps, in order of payoff:

1. **Run on the UT network or VPN.** Springer and Nature subscribed PDFs already come through
   their official text-mining links because UT's IP range is entitled. Elsevier and Wiley work
   the same way once you have a key.
2. **`ELSEVIER_API_KEY`**: register at https://dev.elsevier.com (UT email). On campus or VPN the
   Article API returns full-text XML for everything UT subscribes to. For off-campus runs, ask
   UT Libraries for an institutional token (`ELSEVIER_INSTTOKEN`).
3. **`WILEY_TDM_TOKEN`**: sign in at onlinelibrary.wiley.com, open the Text and Data Mining page,
   accept the terms and copy the token. It's entitled from the UT network.
4. **`CONTACT_EMAIL`, `SPRINGER_API_KEY`, `OPENALEX_API_KEY`, `CORE_API_KEY`**: free. Each one
   adds a few percent.
5. **ACS and RSC**: neither publisher offers a text-mining API, and both block scripts even from
   entitled networks. Open `download_queue.html`: each paper has a UT-library link. Either
   save the PDFs into `inbox/` (any filename works, since papers are matched by the DOI or title
   inside the PDF), or paste `zotero_dois.txt` into Zotero's *Add Item by Identifier* and let
   Zotero fetch them. paperfetch reads your Zotero library directly. Then run the same `fetch`
   command again. Papers already finished come from the cache, and the new PDFs get picked up.
   **Download at a normal reading pace.** ACS in particular suspends a whole university's
   access when it sees bulk downloading.
6. **Supporting Information**: for synthesis work the procedures are often only in the SI.
   PMC and Elsevier SI is fetched automatically. For the rest, the queue page lists SI links;
   save SI PDFs into `inbox/` and they attach to their paper, matched by the title on the SI's
   first page.

To re-measure after adding keys:

```bash
.venv/bin/python -m paperfetch bench --per-publisher 20 --refresh
```

It draws a random sample of chemistry/materials "synthesis" papers from ACS, Elsevier, Wiley,
Nature, Springer and RSC (OpenAlex, fixed seed) and prints coverage by publisher and route
(`bench/bench_report.txt`).

## Tests

```bash
.venv/bin/python -m unittest discover tests
```
