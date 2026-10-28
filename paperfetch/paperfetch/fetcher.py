"""Orchestrates resolution, the source cascade, validation, SI download and caching."""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin

from . import extract, ids, resolve, sources
from .config import Config
from .http import Http
from .localfiles import LocalIndex
from .models import Paper, Section

MIN_FULLTEXT_CHARS = 4000   # below this it is an abstract/landing page, not a paper
MAX_SI_FILES = 4


class Context:
    def __init__(self, cfg: Config | None = None):
        self.cfg = cfg or Config.from_env()
        self.http = Http(self.cfg)
        self.local_index = LocalIndex(self.cfg)


def _paper_dir(cfg: Config, paper: Paper) -> Path:
    return cfg.cache_dir / "papers" / ids.slug(paper.doi or paper.query)


def _parse_hit(hit: sources.Hit, paper: Paper) -> tuple[list[Section], str | None, str]:
    """Returns (sections, title_found, reject_reason)."""
    if hit.fmt == "pdf":
        try:
            text, pages = extract.pdf_text(hit.data)
        except Exception as e:
            return [], None, f"unreadable PDF: {e}"
        if len(text.strip()) < MIN_FULLTEXT_CHARS:
            return [], None, f"PDF has little text ({pages} pages; scanned or cover page)"
        if not resolve.title_match(paper.title, text[:12000]):
            return [], None, "PDF title does not match this paper"
        return extract.parse_pdf_text(text), None, ""
    if hit.fmt == "text":
        if not resolve.title_match(paper.title, hit.data[:12000]):
            return [], None, "text title does not match this paper"
        return extract.parse_pdf_text(hit.data), None, ""
    parser = {"jats": extract.parse_jats, "tei": extract.parse_tei,
              "elsevier-xml": extract.parse_elsevier, "bioc": extract.parse_bioc}[hit.fmt]
    parsed = parser(hit.data) or {}
    sections = parsed.get("sections") or []
    body_chars = sum(len(s.text) for s in sections)
    if body_chars < MIN_FULLTEXT_CHARS:
        why = "abstract only (not entitled: needs UT network/VPN or insttoken)" if hit.fmt == "elsevier-xml" \
            else f"only {body_chars} chars of body text"
        return [], None, why
    if paper.abstract is None and parsed.get("abstract"):
        paper.abstract = parsed["abstract"]
    known = {u for u, _ in hit.si}
    if hit.source.startswith("pmc"):
        paper._meta["pmc_si_files"] = [l.rsplit("/", 1)[-1] for l in parsed.get("si_links") or []]
    for link in parsed.get("si_links") or []:
        # PMC manuscripts reference SI by bare filename, stored next to the XML.
        url = link if link.startswith("http") else (urljoin(hit.url, link) if hit.url else None)
        if url and url not in known and url.lower().split("?")[0].endswith((".pdf", ".docx", ".doc")):
            hit.si.append((url, None))
            known.add(url)
    return sections, parsed.get("title"), ""


def _fetch_si(paper: Paper, hit: sources.Hit, ctx: Context, out_dir: Path) -> None:
    texts = []
    for url, headers in hit.si[:MAX_SI_FILES]:
        resp = ctx.http.get(url, headers=headers, retries=1)
        if resp is None or resp.status_code != 200:
            continue
        name = ids.slug(url.rsplit("/", 1)[-1])
        if resp.content[:5] == b"%PDF-":
            try:
                text, _ = extract.pdf_text(resp.content)
            except Exception:
                continue
        elif resp.content[:2] == b"PK":
            text = extract.docx_text(resp.content)
        else:
            continue
        (out_dir / f"si_{name}").write_bytes(resp.content)
        paper.si_files.append(str(out_dir / f"si_{name}"))
        if text.strip():
            texts.append(f"### {name}\n{extract.clean_si(text)}")
    if texts:
        paper.si_text = "\n\n".join(texts)
        paper.si_status = "fetched"


def _local_si(paper: Paper, ctx: Context) -> None:
    texts = []
    for path in ctx.local_index.lookup_si(paper.doi, paper.title):
        try:
            text, _ = extract.pdf_text(Path(path).read_bytes())
        except Exception:
            continue
        paper.si_files.append(path)
        texts.append(f"### {Path(path).name}\n{extract.clean_si(text)}")
    if texts:
        paper.si_text = "\n\n".join(texts)
        paper.si_status = "fetched"


def _manual_links(paper: Paper, cfg: Config) -> list[str]:
    links = []
    if paper.doi:
        links.append(f"https://doi.org/{paper.doi}")
        if cfg.proxy_prefix:
            links.append(f"{cfg.proxy_prefix}https://doi.org/{paper.doi}")
    links.extend(dict.fromkeys(paper.candidate_pdf_urls))  # blocked for scripts, fine in your browser
    return links


_SI_PAGES = {
    "ACS": "https://pubs.acs.org/doi/suppl/{doi}",
    "Wiley": "https://onlinelibrary.wiley.com/doi/full/{doi}#support-information-section",
    "Elsevier": "https://doi.org/{doi}",
}


def _si_links(paper: Paper) -> list[str]:
    links = []
    if paper.pmcid and paper._meta.get("pmc_si_files"):
        num = paper.pmcid.removeprefix("PMC")
        links += [f"https://pmc.ncbi.nlm.nih.gov/articles/instance/{num}/bin/{f}" for f in paper._meta["pmc_si_files"]]
    links.append(_SI_PAGES.get(paper.publisher, "https://doi.org/{doi}").format(doi=paper.doi))
    return links


def fetch(query: str, ctx: Context, *, use_cache: bool = True) -> Paper:
    paper = Paper(query=query.strip())
    pid = ids.parse(query)
    if use_cache and pid.kind == "doi":
        cached = ctx.cfg.cache_dir / "papers" / ids.slug(pid.value) / "paper.json"
        if cached.is_file():
            prior = Paper.from_dict(json.loads(cached.read_text()))
            # Only finished papers come from cache; the rest are retried because you may have
            # added a key, joined the VPN, or dropped the PDF into inbox/Zotero since.
            if prior.coverage == "full":
                if prior.si_status != "fetched":
                    _local_si(prior, ctx)
                    if prior.si_status == "fetched":
                        _save(prior, cached.parent)
                return prior

    resolve.resolve(paper, ctx)
    out_dir = _paper_dir(ctx.cfg, paper)
    out_dir.mkdir(parents=True, exist_ok=True)

    for source in sources.ORDER:
        try:
            for hit in source(paper, ctx):
                sections, _, reason = _parse_hit(hit, paper)
                if reason:
                    paper.log(hit.source, "rejected", reason, hit.url)
                    continue
                ext = {"pdf": "pdf", "text": "txt", "bioc": "json"}.get(hit.fmt, "xml")
                raw = out_dir / f"fulltext.{ext}"
                if isinstance(hit.data, (dict, str)):
                    raw.write_text(json.dumps(hit.data) if isinstance(hit.data, dict) else hit.data)
                else:
                    raw.write_bytes(hit.data)
                paper.sections, paper.coverage = sections, "full"
                paper.fulltext_source, paper.fulltext_format, paper.version = hit.source, hit.fmt, hit.version
                paper.files = [str(raw)]
                paper.log(hit.source, "ok", f"{hit.fmt}, {len(paper.full_text)} chars", hit.url)
                if ctx.cfg.fetch_si and hit.si:
                    _fetch_si(paper, hit, ctx, out_dir)
                break
        except Exception as e:  # one broken source must not sink the paper
            paper.log(source.__name__, "error", repr(e))
        if paper.coverage == "full":
            break

    if paper.si_status != "fetched":
        _local_si(paper, ctx)
    if paper.coverage != "full":
        paper.coverage = "abstract" if paper.abstract else "none"
        paper.manual_links = _manual_links(paper, ctx.cfg)
    if paper.si_status != "fetched" and paper.doi:
        paper.si_status = "linked"
        paper.si_links = _si_links(paper)
    _save(paper, out_dir)
    return paper


def _save(paper: Paper, out_dir: Path) -> None:
    (out_dir / "paper.json").write_text(json.dumps(paper.to_dict(), indent=2))
    (out_dir / "fulltext.md").write_text(f"# {paper.title or paper.query}\n\n{paper.full_text}")
    if paper.methods_text():
        (out_dir / "methods.md").write_text(f"# Methods: {paper.title or paper.query}\n\n{paper.methods_text()}")


def fetch_many(queries: list[str], ctx: Context | None = None, workers: int = 4, use_cache: bool = True,
               progress=None) -> list[Paper]:
    ctx = ctx or Context()
    results: list[Paper | None] = [None] * len(queries)

    def run(i):
        results[i] = fetch(queries[i], ctx, use_cache=use_cache)
        if progress:
            progress(results[i])

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(run, range(len(queries))))
    return results
