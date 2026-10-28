"""Full-text sources, tried in order by fetcher.py.

Each source is a generator of Hit objects (raw bytes plus format). The fetcher
parses and validates each Hit and stops at the first one that is real full text
for the right paper. Sources are ordered structured-first (XML keeps section
boundaries, so the methods come out clean), then PDFs.

Only sanctioned machine-access routes are used: open repositories and the
publishers' own text-and-data-mining APIs. Anything that needs a browser
session goes to the assisted-download list.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from html import unescape
from urllib.parse import quote, urljoin

from .models import Paper


@dataclass
class Hit:
    source: str
    fmt: str               # jats | tei | elsevier-xml | bioc | pdf | text
    data: bytes | dict | str
    url: str | None = None
    version: str = "published"
    si: list = field(default_factory=list)   # (url, headers) tuples to fetch as SI


def _is_pdf(resp) -> bool:
    return resp is not None and resp.status_code == 200 and resp.content[:5] == b"%PDF-"


def _blocked(resp) -> str:
    if resp is None:
        return "network error"
    if resp.status_code in (401, 403):
        return f"HTTP {resp.status_code} (blocked or not entitled)"
    return f"HTTP {resp.status_code}"


# --------------------------------------------------------------------- local copies
def local_copy(paper: Paper, ctx):
    path = ctx.local_index.lookup(paper.doi, paper.title)
    if not path:
        paper.log("local", "miss", "not in inbox/Zotero")
        return
    try:
        data = open(path, "rb").read()
    except OSError as e:
        paper.log("local", "error", str(e))
        return
    yield Hit("local", "pdf", data, url=str(path), version="local copy")


# --------------------------------------------------------------------- PubMed Central
PMC_S3 = "https://pmc-oa-opendata.s3.amazonaws.com"
_SI_EXT = (".pdf", ".docx", ".doc")


def pmc(paper: Paper, ctx):
    if not paper.pmcid:
        return
    http = ctx.http
    listing = http.get(f"{PMC_S3}/", params={"list-type": "2", "prefix": f"{paper.pmcid}.", "delimiter": "/"})
    versions = re.findall(rf"<Prefix>({paper.pmcid}\.(\d+))/</Prefix>", listing.text if listing is not None else "")
    if versions:
        stem = max(versions, key=lambda v: int(v[1]))[0]
        meta = http.json(f"{PMC_S3}/{stem}/{stem}.json") or {}
        version = "accepted" if meta.get("is_manuscript") else "published"
        si = [(u.replace("s3://pmc-oa-opendata", PMC_S3).split("?")[0], None)
              for u in meta.get("media_urls", []) if u.split("?")[0].lower().endswith(_SI_EXT)]
        if meta.get("xml_url"):
            url = meta["xml_url"].replace("s3://pmc-oa-opendata", PMC_S3).split("?")[0]
            resp = http.get(url)
            if resp is not None and resp.status_code == 200:
                yield Hit("pmc-s3", "jats", resp.content, url, version, si)
        if meta.get("pdf_url"):
            url = meta["pdf_url"].replace("s3://pmc-oa-opendata", PMC_S3).split("?")[0]
            resp = http.get(url)
            if _is_pdf(resp):
                yield Hit("pmc-s3", "pdf", resp.content, url, version, si)
    else:
        paper.log("pmc-s3", "miss", "PMCID not in PMC open-data bucket")

    url = f"https://www.ebi.ac.uk/europepmc/webservices/rest/{paper.pmcid}/fullTextXML"
    resp = http.get(url, retries=1)
    if resp is not None and resp.status_code == 200 and b"<body" in resp.content:
        yield Hit("europepmc", "jats", resp.content, url, "published")
    else:
        paper.log("europepmc", "miss", _blocked(resp))

    url = f"https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/{paper.pmcid}/unicode"
    data = http.json(url, retries=1)
    if data:
        doc = data[0] if isinstance(data, list) else data
        docs = doc.get("documents") or []
        if docs:
            yield Hit("pmc-bioc", "bioc", docs[0], url, "accepted")


# --------------------------------------------------------------------- publisher TDM APIs
def elsevier(paper: Paper, ctx):
    if paper.publisher != "Elsevier" or not paper.doi:
        return
    if not ctx.cfg.elsevier_key:
        paper.log("elsevier-api", "skipped", "set ELSEVIER_API_KEY")
        return
    headers = {"X-ELS-APIKey": ctx.cfg.elsevier_key, "Accept": "text/xml"}
    if ctx.cfg.elsevier_insttoken:
        headers["X-ELS-Insttoken"] = ctx.cfg.elsevier_insttoken
    url = f"https://api.elsevier.com/content/article/doi/{paper.doi}"
    resp = ctx.http.get(url, params={"view": "FULL"}, headers=headers)
    if resp is None or resp.status_code != 200:
        paper.log("elsevier-api", "miss", _blocked(resp), url)
        return
    si = _elsevier_si(paper, ctx, headers) if ctx.cfg.fetch_si else []
    yield Hit("elsevier-api", "elsevier-xml", resp.content, url, "published", si)


def _elsevier_si(paper: Paper, ctx, headers) -> list:
    data = ctx.http.json(f"https://api.elsevier.com/content/object/doi/{paper.doi}",
                         params={"httpAccept": "application/json"}, headers={**headers, "Accept": "application/json"})
    out = []

    def walk(node):
        if isinstance(node, dict):
            url, name = node.get("prism:url"), str(node.get("filename") or node.get("ref") or "")
            mime = str(node.get("mimetype") or "")
            if url and "mmc" in name.lower() and ("pdf" in mime or "word" in mime):
                out.append((url, headers))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data or {})
    return out


def springer_oa(paper: Paper, ctx):
    if paper.publisher not in ("Springer", "Nature") or not paper.doi:
        return
    if not ctx.cfg.springer_key:
        paper.log("springer-oa-api", "skipped", "set SPRINGER_API_KEY")
        return
    url = "https://api.springernature.com/openaccess/jats"
    resp = ctx.http.get(url, params={"q": f"doi:{paper.doi}", "api_key": ctx.cfg.springer_key})
    if resp is not None and resp.status_code == 200 and b"<body" in resp.content:
        yield Hit("springer-oa-api", "jats", resp.content, url, "published")
    else:
        paper.log("springer-oa-api", "miss", "not open access" if resp is not None and resp.status_code == 200 else _blocked(resp))


def wiley_tdm(paper: Paper, ctx):
    if paper.publisher != "Wiley" or not paper.doi:
        return
    if not ctx.cfg.wiley_token:
        paper.log("wiley-tdm", "skipped", "set WILEY_TDM_TOKEN")
        return
    url = f"https://api.wiley.com/onlinelibrary/tdm/v1/articles/{quote(paper.doi, safe='')}"
    resp = ctx.http.get(url, headers={"Wiley-TDM-Client-Token": ctx.cfg.wiley_token})
    if _is_pdf(resp):
        yield Hit("wiley-tdm", "pdf", resp.content, url, "published")
    else:
        paper.log("wiley-tdm", "miss", _blocked(resp), url)


# --------------------------------------------------------------------- OpenAlex content cache
def openalex_content(paper: Paper, ctx):
    if not paper.openalex_id:
        return
    if not ctx.cfg.openalex_key:
        paper.log("openalex-content", "skipped", "set OPENALEX_API_KEY")
        return
    has = paper._meta.get("openalex_has_content") or {}
    params = {"api_key": ctx.cfg.openalex_key}
    base = f"https://content.openalex.org/works/{paper.openalex_id}"
    if has.get("grobid_xml", True):
        resp = ctx.http.get(f"{base}.grobid-xml", params=params, retries=1)
        if resp is not None and resp.status_code == 200 and b"<TEI" in resp.content[:2000]:
            yield Hit("openalex-content", "tei", resp.content, f"{base}.grobid-xml")
    if has.get("pdf", True):
        resp = ctx.http.get(f"{base}.pdf", params=params, retries=1)
        if _is_pdf(resp):
            yield Hit("openalex-content", "pdf", resp.content, f"{base}.pdf")
        else:
            paper.log("openalex-content", "miss", _blocked(resp))


# --------------------------------------------------------------------- preprint servers
def arxiv(paper: Paper, ctx):
    if not paper.arxiv:
        return
    url = f"https://arxiv.org/pdf/{paper.arxiv}"
    resp = ctx.http.get(url)
    if _is_pdf(resp):
        yield Hit("arxiv", "pdf", resp.content, url, "preprint")
    else:
        paper.log("arxiv", "miss", _blocked(resp), url)


def biorxiv(paper: Paper, ctx):
    if not paper.doi or not paper.doi.startswith("10.1101/"):
        return
    for server in ("biorxiv", "medrxiv"):
        data = ctx.http.json(f"https://api.biorxiv.org/details/{server}/{paper.doi}")
        coll = (data or {}).get("collection") or []
        if coll and coll[-1].get("jatsxml"):
            url = coll[-1]["jatsxml"]
            resp = ctx.http.get(url)
            if resp is not None and resp.status_code == 200 and b"<body" in resp.content:
                yield Hit(server, "jats", resp.content, url, "preprint")
            else:
                paper.log(server, "miss", _blocked(resp), url)
            return


# --------------------------------------------------------------------- open-access PDF links
_VERSION = {"publishedVersion": "published", "acceptedVersion": "accepted", "submittedVersion": "preprint"}


def _candidate_urls(paper: Paper) -> list[tuple[str, str, str]]:
    """(url, version, origin) for every PDF link the metadata services know about."""
    seen, out = set(), []

    def add(url, version, origin):
        if url and url not in seen:
            seen.add(url)
            out.append((url, version, origin))

    locs = paper._meta.get("openalex_locations") or []
    # Repositories first: they rarely block scripts, publisher sites often do.
    for loc in sorted(locs, key=lambda l: ((l.get("source") or {}).get("type") != "repository")):
        add(loc.get("pdf_url"), _VERSION.get(loc.get("version"), "published"), "openalex")
    for loc in paper._meta.get("unpaywall_locations") or []:
        add(loc.get("url_for_pdf"), _VERSION.get(loc.get("version"), "published"), "unpaywall")
    add(paper._meta.get("s2_pdf"), "published", "semantic-scholar")
    for link in paper._meta.get("crossref_links") or []:
        if link.get("intended-application") in ("text-mining", "similarity-checking", "unspecified") and \
                "pdf" in (link.get("content-type") or "") and "api.elsevier.com" not in link.get("URL", ""):
            add(link.get("URL"), "published", "crossref-tdm")
    return out


def oa_links(paper: Paper, ctx):
    if paper.doi and ctx.cfg.email:
        data = ctx.http.json(f"https://api.unpaywall.org/v2/{quote(paper.doi, safe='/')}", params={"email": ctx.cfg.email})
        paper._meta["unpaywall_locations"] = (data or {}).get("oa_locations") or []
    for url, version, origin in _candidate_urls(paper):
        resp = ctx.http.get(url, retries=1)
        if _is_pdf(resp):
            yield Hit(f"oa-link:{origin}", "pdf", resp.content, url, version)
        else:
            paper.log(f"oa-link:{origin}", "blocked" if resp is not None and resp.status_code in (401, 403) else "miss",
                      _blocked(resp) if resp is None or resp.status_code != 200 else "not a PDF", url)
            paper.candidate_pdf_urls.append(url)


def landing_page(paper: Paper, ctx):
    """Publisher landing page <meta name="citation_pdf_url">, fetched once with the honest UA."""
    if not paper.doi:
        return
    resp = ctx.http.get(f"https://doi.org/{paper.doi}", retries=0)
    if resp is None or resp.status_code != 200 or "html" not in resp.headers.get("content-type", ""):
        paper.log("landing-page", "blocked" if resp is not None and resp.status_code in (401, 403) else "miss", _blocked(resp))
        return
    m = re.search(r'<meta[^>]+name=["\']citation_pdf_url["\'][^>]+content=["\']([^"\']+)', resp.text, re.I) or \
        re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']citation_pdf_url', resp.text, re.I)
    if not m:
        paper.log("landing-page", "miss", "no citation_pdf_url")
        return
    url = urljoin(str(resp.url), unescape(m.group(1)))
    pdf = ctx.http.get(url, retries=0)
    if _is_pdf(pdf):
        yield Hit("landing-page", "pdf", pdf.content, url)
    else:
        paper.log("landing-page", "blocked", _blocked(pdf), url)
        paper.candidate_pdf_urls.append(url)


def core(paper: Paper, ctx):
    if not paper.doi:
        return
    if not ctx.cfg.core_key:
        paper.log("core", "skipped", "set CORE_API_KEY")
        return
    data = ctx.http.json("https://api.core.ac.uk/v3/search/works",
                         params={"q": f'doi:"{paper.doi}"', "limit": 3},
                         headers={"Authorization": f"Bearer {ctx.cfg.core_key}"}, retries=2)
    for res in (data or {}).get("results", []):
        url = res.get("downloadUrl")
        if url:
            resp = ctx.http.get(url, retries=1)
            if _is_pdf(resp):
                yield Hit("core", "pdf", resp.content, url, "accepted")
                continue
        if len(res.get("fullText") or "") > 5000:
            yield Hit("core", "text", res["fullText"], res.get("links", [{}])[0].get("url") if res.get("links") else None, "accepted")


ORDER = [local_copy, pmc, elsevier, springer_oa, wiley_tdm, openalex_content, biorxiv, oa_links, landing_page, core, arxiv]
