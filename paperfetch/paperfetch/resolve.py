"""Metadata resolution: find the DOI, PMCID, arXiv id, OA locations and abstract for a query."""
from __future__ import annotations

import re
from urllib.parse import quote

from . import ids
from .models import Paper

OPENALEX = "https://api.openalex.org"


def _oa_params(ctx) -> dict:
    p = {}
    if ctx.cfg.email:
        p["mailto"] = ctx.cfg.email
    if ctx.cfg.openalex_key:
        p["api_key"] = ctx.cfg.openalex_key
    return p


def _abstract_from_inverted(inv: dict | None) -> str | None:
    if not inv:
        return None
    words = sorted((pos, w) for w, positions in inv.items() for pos in positions)
    return " ".join(w for _, w in words)


def title_tokens(title: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]{4,}", title.lower())}


def title_match(title: str | None, text: str, threshold: float = 0.6) -> bool:
    if not title:
        return True
    want = title_tokens(title)
    if len(want) < 2:
        return True
    have = set(re.findall(r"[a-z0-9]{4,}", text.lower()))
    return len(want & have) / len(want) >= threshold


def _apply_openalex(paper: Paper, w: dict) -> None:
    paper.openalex_id = (w.get("id") or "").rsplit("/", 1)[-1] or None
    if w.get("doi"):
        paper.doi = ids.clean_doi(w["doi"])
    paper.title = paper.title or w.get("title") or w.get("display_name")
    paper.year = paper.year or w.get("publication_year")
    src = ((w.get("primary_location") or {}).get("source") or {})
    paper.journal = paper.journal or src.get("display_name")
    wid = w.get("ids") or {}
    if wid.get("pmcid") and not paper.pmcid:
        paper.pmcid = "PMC" + re.sub(r"\D", "", wid["pmcid"].rstrip("/").rsplit("/", 1)[-1])
    if wid.get("pmid") and not paper.pmid:
        paper.pmid = wid["pmid"].rstrip("/").rsplit("/", 1)[-1]
    paper.abstract = paper.abstract or _abstract_from_inverted(w.get("abstract_inverted_index"))
    paper.oa_status = (w.get("open_access") or {}).get("oa_status")
    paper._meta["openalex_locations"] = w.get("locations") or []
    paper._meta["openalex_has_content"] = w.get("has_content") or {}
    paper._meta["host_org"] = src.get("host_organization_name")
    for loc in w.get("locations") or []:
        m = re.search(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})", loc.get("landing_page_url") or "")
        if m and not paper.arxiv:
            paper.arxiv = m.group(1)


def resolve(paper: Paper, ctx) -> None:
    pid = ids.parse(paper.query)
    http = ctx.http
    work = None
    if pid.kind == "doi":
        paper.doi = pid.value
        work = http.json(f"{OPENALEX}/works/doi:{quote(pid.value, safe='/')}", params=_oa_params(ctx))
    elif pid.kind == "arxiv":
        paper.arxiv = pid.value
        work = http.json(f"{OPENALEX}/works/doi:10.48550/arxiv.{pid.value}", params=_oa_params(ctx))
    elif pid.kind == "pmcid":
        paper.pmcid = pid.value
        work = http.json(f"{OPENALEX}/works/pmcid:{pid.value}", params=_oa_params(ctx))
    elif pid.kind == "pmid":
        paper.pmid = pid.value
        work = http.json(f"{OPENALEX}/works/pmid:{pid.value}", params=_oa_params(ctx))
    else:
        params = {**_oa_params(ctx), "filter": f"title.search:{pid.value}", "per_page": 5}
        data = http.json(f"{OPENALEX}/works", params=params) or {}
        for cand in data.get("results", []):
            if title_match(cand.get("title") or "", pid.value, 0.85) and title_match(pid.value, cand.get("title") or "", 0.85):
                work = cand
                break
    if work:
        _apply_openalex(paper, work)
        paper.log("openalex", "ok", "metadata")
    else:
        paper.log("openalex", "miss", f"no OpenAlex record for {pid.kind}")

    if paper.doi:
        _crossref(paper, ctx)
        if not paper.pmcid:
            _ncbi_idconv(paper, ctx)
    if paper.doi and not paper.arxiv:
        _semantic_scholar(paper, ctx)
    paper.publisher = ids.publisher_of(paper.doi)
    if paper.publisher == "Other" and paper._meta.get("host_org"):
        paper.publisher = paper._meta["host_org"]


def _crossref(paper: Paper, ctx) -> None:
    params = {"mailto": ctx.cfg.email} if ctx.cfg.email else None
    data = ctx.http.json(f"https://api.crossref.org/works/{quote(paper.doi, safe='/')}", params=params)
    msg = (data or {}).get("message")
    if not msg:
        return
    paper.title = paper.title or (msg.get("title") or [None])[0]
    paper.journal = paper.journal or (msg.get("container-title") or [None])[0]
    if not paper.year:
        parts = (msg.get("issued") or {}).get("date-parts") or [[None]]
        paper.year = parts[0][0]
    if not paper.abstract and msg.get("abstract"):
        paper.abstract = re.sub(r"<[^>]+>", " ", msg["abstract"]).strip()
    paper._meta["crossref_links"] = msg.get("link") or []
    rel = msg.get("relation") or {}
    paper._meta["preprint_dois"] = [r.get("id", "").lower() for r in rel.get("has-preprint", []) if r.get("id-type") == "doi"]


def _ncbi_idconv(paper: Paper, ctx) -> None:
    params = {"ids": paper.doi, "format": "json", "tool": "paperfetch"}
    if ctx.cfg.email:
        params["email"] = ctx.cfg.email
    data = ctx.http.json("https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/", params=params)
    for rec in (data or {}).get("records", []):
        if rec.get("pmcid"):
            paper.pmcid = rec["pmcid"]
        if rec.get("pmid") and not paper.pmid:
            paper.pmid = str(rec["pmid"])


def _semantic_scholar(paper: Paper, ctx) -> None:
    headers = {"x-api-key": ctx.cfg.s2_key} if ctx.cfg.s2_key else None
    data = ctx.http.json(
        f"https://api.semanticscholar.org/graph/v1/paper/DOI:{quote(paper.doi, safe='/')}",
        params={"fields": "openAccessPdf,externalIds"}, headers=headers, retries=1,
    )
    if not data:
        return
    ext = data.get("externalIds") or {}
    if ext.get("ArXiv"):
        paper.arxiv = ext["ArXiv"]
    if ext.get("PubMedCentral") and not paper.pmcid:
        paper.pmcid = "PMC" + str(ext["PubMedCentral"])
    url = (data.get("openAccessPdf") or {}).get("url")
    if url:
        paper._meta["s2_pdf"] = url
