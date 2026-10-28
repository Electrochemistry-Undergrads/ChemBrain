"""MCP server: lets Claude (or any MCP client) search, fetch and read papers through paperfetch.

Run: .venv/bin/python -m paperfetch.mcp_server   (stdio; register it with `claude mcp add`)

It adds no new download routes. Papers come through the same machine-access routes
as the CLI, so subscribed full text needs the campus network or VPN, and ACS/RSC still
need the PDF saved into inbox/ or Zotero. Calls are capped so nobody bulk-crawls a
publisher: ACS suspends a whole university's access when it sees that.

stdout is the MCP channel, so nothing in here may print.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from mcp.server.mcpserver import MCPServer

from . import ids
from .cli import write_queue
from .config import PROJECT_ROOT
from .context import build_context, paper_block
from .fetcher import Context, fetch_many
from .models import Paper

MAX_SEARCH = 25
MAX_FETCH = 20
SNIPPET = 300

server = MCPServer(
    "paperfetch",
    instructions=(
        "Research-paper full text for synthesis planning. Typical flow: search_papers -> fetch_papers -> "
        "read_paper(part='methods'). search_library searches papers already fetched. Papers that come back "
        "without full text (mostly ACS/RSC) need the user to save the PDF into the inbox folder; never try "
        "to download them another way."
    ),
)

_ctx: Context | None = None


def ctx() -> Context:
    global _ctx
    if _ctx is None:
        _ctx = Context()
    return _ctx


def set_context(new: Context | None) -> None:
    """Swap the context (tests point it at a temporary cache)."""
    global _ctx
    _ctx = new


def _papers_dir() -> Path:
    return ctx().cfg.cache_dir / "papers"


def _load(query: str) -> Paper | None:
    pid = ids.parse(query)
    path = _papers_dir() / ids.slug(pid.value) / "paper.json"
    if not path.is_file():
        return None
    return Paper.from_dict(json.loads(path.read_text()))


def _summary(p: Paper) -> str:
    head = f"{p.doi or p.query} | {p.publisher} {p.year or ''} | {p.title or '(no title)'}"
    if p.coverage == "full":
        return (f"{head}\n  FULL TEXT via {p.fulltext_source} ({p.version}); methods {len(p.methods_text())} chars; "
                f"SI {p.si_status}")
    links = "\n".join(f"    {u}" for u in p.manual_links[:3])
    return (f"{head}\n  {p.coverage.upper()} only. Save the PDF into {ctx().cfg.inbox_dir} "
            f"(any filename) and fetch again. Open it here:\n{links}")


@server.tool()
def search_papers(topic: str, publishers: list[str] | None = None, years: str = "2015-2026", limit: int = 10) -> str:
    """Find papers on a topic via OpenAlex. Returns metadata only and downloads nothing.

    publishers: any of ACS, Elsevier, Nature, Springer, Wiley, RSC (default ACS, Elsevier, Nature).
    years: a year or range like "2018-2026". limit: at most 25.
    """
    publishers = publishers or ["ACS", "Elsevier", "Nature"]
    if limit < 1 or limit > MAX_SEARCH:
        raise ValueError(f"limit must be 1-{MAX_SEARCH}")
    unknown = [p for p in publishers if p not in ids.OPENALEX_PUBLISHERS]
    if unknown:
        raise ValueError(f"unknown publishers {unknown}; choose from {list(ids.OPENALEX_PUBLISHERS)}")
    lineage = "|".join(ids.OPENALEX_PUBLISHERS[p] for p in publishers)
    params = {
        "search": topic,
        "filter": f"primary_location.source.publisher_lineage:{lineage},type:article,publication_year:{years},has_doi:true",
        "per_page": limit,
        "select": "doi,title,publication_year,primary_location,open_access,cited_by_count",
    }
    cfg = ctx().cfg
    if cfg.email:
        params["mailto"] = cfg.email
    if cfg.openalex_key:
        params["api_key"] = cfg.openalex_key
    data = ctx().http.json("https://api.openalex.org/works", params=params)
    if data is None:
        return "OpenAlex search failed (network or rate limit). Try again shortly."
    lines = []
    for w in data.get("results", []):
        doi = (w.get("doi") or "").removeprefix("https://doi.org/")
        source = ((w.get("primary_location") or {}).get("source") or {}).get("display_name") or ""
        oa = (w.get("open_access") or {}).get("oa_status") or "closed"
        lines.append(f"{doi} | {ids.publisher_of(doi)} | {source} {w.get('publication_year') or ''} | "
                     f"{oa} | cited {w.get('cited_by_count', 0)} | {w.get('title')}")
    return "\n".join(lines) or "No matches."


@server.tool()
def fetch_papers(queries: list[str], refresh: bool = False) -> str:
    """Get full text, methods and Supporting Information for up to 20 papers.

    queries: DOIs, DOI/publisher URLs, arXiv ids, PMCIDs, PMIDs or exact titles.
    Finished papers come from the cache; refresh=True re-downloads them.
    """
    if not queries or len(queries) > MAX_FETCH:
        raise ValueError(f"give 1-{MAX_FETCH} papers per call")
    c = ctx()
    c.local_index.refresh()  # pick up PDFs saved into inbox/ or Zotero since the last call
    papers = fetch_many(queries, c, workers=4, use_cache=not refresh)
    full = sum(p.coverage == "full" for p in papers)
    return f"{full}/{len(papers)} full text\n\n" + "\n\n".join(_summary(p) for p in papers)


@server.tool()
def read_paper(paper: str, part: str = "methods", max_chars: int = 40000) -> str:
    """Read a fetched paper. paper: its DOI (or the query it was fetched with).

    part: "methods" (experimental sections + SI, best for procedures), "full" (whole paper by section),
    "si" (Supporting Information only) or "all" (labelled block with abstract, methods and results).
    """
    p = _load(paper)
    if p is None:
        return f"{paper} is not in the cache yet. Call fetch_papers first."
    if part == "methods":
        text = p.methods_text()
    elif part == "full":
        text = p.full_text
    elif part == "si":
        text = p.si_text
    elif part == "all":
        text = paper_block(p, 1, max_chars)
    else:
        raise ValueError('part must be "methods", "full", "si" or "all"')
    if not text:
        return f"No {part} text for {paper} (coverage: {p.coverage}, SI: {p.si_status})."
    status = "FULL TEXT" if p.coverage == "full" else "ABSTRACT ONLY"
    header = f"# {p.title or p.query}\nDOI: {p.doi or '-'} | {status} | SI {p.si_status}\n\n"
    if len(text) > max_chars:
        text = text[:max_chars] + f"\n[... truncated at {max_chars} of {len(text)} chars ...]"
    return header + text


@server.tool()
def search_library(text: str, limit: int = 20) -> str:
    """Search the text of every paper already fetched (full text, methods and SI). Case-insensitive.

    Returns one snippet per matching paper. Only covers the local cache; use search_papers to find new ones.
    """
    words = [re.escape(w) for w in re.split(r"[\s\-]+", text.strip()) if w]
    needle = re.compile(r"[\s\-]+".join(words), re.I)  # "hot injection" also matches "hot-injection"
    hits = []
    for d in sorted(_papers_dir().glob("*/")):
        for name in ("methods.md", "fulltext.md"):
            f = d / name
            if not f.is_file():
                continue
            body = f.read_text(errors="replace")
            m = needle.search(body)
            if not m:
                continue
            title = body.split("\n", 1)[0].lstrip("# ").removeprefix("Methods: ")
            doi = d.name
            meta = d / "paper.json"
            if meta.is_file():
                doi = json.loads(meta.read_text()).get("doi") or doi
            start = max(0, m.start() - SNIPPET // 2)
            snippet = " ".join(body[start:m.end() + SNIPPET // 2].split())
            hits.append(f"{doi} | {title}\n  ({name}, {len(needle.findall(body))} matches) ...{snippet}...")
            break
        if len(hits) >= limit:
            break
    return "\n\n".join(hits) or f"No fetched paper mentions {text!r}."


@server.tool()
def synthesis_context(papers: list[str], max_chars_per_paper: int = 20000) -> str:
    """Methods-first context block for planning a synthesis from fetched papers.

    Each source is labelled FULL TEXT or ABSTRACT ONLY; take reagents, amounts and conditions only
    from FULL TEXT sources.
    """
    loaded = [p for p in (_load(q) for q in papers) if p is not None]
    missing = len(papers) - len(loaded)
    text = build_context(loaded, max_chars_per_paper)
    return text + (f"\n\n({missing} of the requested papers are not fetched yet.)" if missing else "")


@server.tool()
def access_status() -> str:
    """Which full-text routes are on, and which fetched papers still need a PDF saved by hand."""
    c = ctx()
    c.local_index.refresh()
    routes = "\n".join(f"  [{'x' if on else ' '}] {name}" for name, on in c.cfg.enabled_routes().items())
    papers = [Paper.from_dict(json.loads(f.read_text())) for f in _papers_dir().glob("*/paper.json")]
    todo = [p for p in papers if p.coverage != "full"]
    queue = write_queue(papers, c, PROJECT_ROOT / "output")
    by_pub: dict[str, int] = {}
    for p in todo:
        by_pub[p.publisher] = by_pub.get(p.publisher, 0) + 1
    return (f"full-text routes:\n{routes}\n  [x] PubMed Central, Europe PMC, arXiv, bioRxiv, OA and text-mining links\n"
            f"inbox: {c.cfg.inbox_dir} ({len(c.local_index.by_doi)} PDFs with a DOI, incl. Zotero)\n"
            f"cache: {len(papers)} papers, {len(papers) - len(todo)} full text\n"
            f"need a PDF saved by hand: {len(todo)} "
            + (f"({', '.join(f'{k} {v}' for k, v in sorted(by_pub.items()))})" if todo else "")
            + f"\ndownload list: {queue}\n"
            "Run on the campus network or VPN; subscribed papers only come through there.")


def main() -> None:
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one INFO line per request otherwise
    server.run()


if __name__ == "__main__":
    main()
