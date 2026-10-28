"""Command line: python -m paperfetch {fetch,queue,bench,context,status} ..."""
from __future__ import annotations

import argparse
import html
import json
import sys
import threading
from collections import Counter, defaultdict
from pathlib import Path

from .config import PROJECT_ROOT
from .context import build_context
from .fetcher import Context, fetch_many
from .ids import OPENALEX_PUBLISHERS
from .models import Paper


def _read_queries(args) -> list[str]:
    queries = list(args.ids or [])
    if args.file:
        queries += [l.strip() for l in Path(args.file).read_text().splitlines() if l.strip() and not l.startswith("#")]
    if not queries:
        sys.exit("give DOIs/arXiv ids/PMCIDs/titles as arguments or with --file")
    return queries


def _progress(total: int):
    done = [0]
    lock = threading.Lock()

    def report(p: Paper):
        with lock:
            done[0] += 1
            mark = {"full": "FULL ", "abstract": "abstr", "none": "none "}[p.coverage]
            src = p.fulltext_source or "-"
            print(f"[{done[0]:>3}/{total}] {mark} {p.publisher:9.9} {src:22.22} {(p.doi or p.query)[:45]}", flush=True)
    return report


def summarize(papers: list[Paper]) -> str:
    lines = []
    by_pub: dict[str, list[Paper]] = defaultdict(list)
    for p in papers:
        by_pub[p.publisher].append(p)
    lines.append(f"{'publisher':10} {'n':>4} {'full':>6} {'%full':>6} {'methods':>8} {'SI':>4}")
    for pub, ps in sorted(by_pub.items(), key=lambda kv: -len(kv[1])):
        full = sum(p.coverage == "full" for p in ps)
        meth = sum(bool(p.methods_text()) for p in ps)
        si = sum(p.si_status == "fetched" for p in ps)
        lines.append(f"{pub[:10]:10} {len(ps):>4} {full:>6} {100 * full / len(ps):>5.0f}% {meth:>8} {si:>4}")
    full = sum(p.coverage == "full" for p in papers)
    lines.append(f"{'TOTAL':10} {len(papers):>4} {full:>6} {100 * full / max(1, len(papers)):>5.0f}%")
    lines.append("")
    lines.append("full text by source: " + ", ".join(f"{k}={v}" for k, v in Counter(p.fulltext_source for p in papers if p.coverage == "full").most_common()))
    blocked = Counter(a.source for p in papers if p.coverage != "full" for a in p.attempts if a.outcome == "blocked")
    if blocked:
        lines.append("blocked for scripts (open these in your browser): " + ", ".join(f"{k}={v}" for k, v in blocked.most_common()))
    skipped = Counter(a.source for p in papers if p.coverage != "full" for a in p.attempts if a.outcome == "skipped")
    if skipped:
        lines.append("would have tried with a key: " + ", ".join(f"{k}={v}" for k, v in skipped.most_common()))
    return "\n".join(lines)


def write_queue(papers: list[Paper], ctx: Context, out: Path) -> Path | None:
    """HTML page listing papers that still need a PDF, plus a DOI list for Zotero."""
    todo = [p for p in papers if p.coverage != "full"]
    si_todo = [p for p in papers if p.coverage == "full" and p.si_status != "fetched" and p.si_links]
    out.mkdir(parents=True, exist_ok=True)
    (out / "zotero_dois.txt").write_text("\n".join(p.doi for p in todo if p.doi) + "\n")
    rows = []
    for p in todo:
        links = " · ".join(f'<a href="{html.escape(u)}" target="_blank">{"UT library" if "ezproxy" in u else ("doi.org" if "doi.org" in u else "PDF link")}</a>'
                           for u in p.manual_links)
        rows.append(f"<tr><td>{html.escape(p.publisher)}</td><td>{html.escape(p.title or p.query)}</td>"
                    f"<td><code>{html.escape(p.doi or '')}</code></td><td>{links}</td></tr>")
    si_rows = [f"<tr><td>{html.escape(p.publisher)}</td><td>{html.escape(p.title or p.query)}</td><td>"
               + " · ".join(f'<a href="{html.escape(u)}" target="_blank">SI</a>' for u in p.si_links) + "</td></tr>"
               for p in si_todo]
    page = f"""<!doctype html><meta charset="utf-8"><title>Papers to download</title>
<style>body{{font:14px system-ui;margin:24px;max-width:1100px}}td,th{{padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top}}
table{{border-collapse:collapse;width:100%}}code{{font-size:12px}}</style>
<h1>{len(todo)} papers need a PDF</h1>
<p>Save each PDF into <code>{html.escape(str(ctx.cfg.inbox_dir))}</code> (any filename), or paste
<code>zotero_dois.txt</code> into Zotero's "Add Item by Identifier" box, then run
<code>python -m paperfetch fetch --file &lt;same list&gt;</code> again. Go at a normal reading pace:
publishers (ACS in particular) suspend institutional access when they see bulk downloading.</p>
<table><tr><th>Publisher</th><th>Title</th><th>DOI</th><th>Get it</th></tr>{''.join(rows)}</table>
<h2>{len(si_todo)} papers have full text but no Supporting Information</h2>
<p>For synthesis work the experimental procedures are often only in the SI. Save SI PDFs into the inbox as
<code>&lt;anything&gt;_SI.pdf</code>.</p>
<table><tr><th>Publisher</th><th>Title</th><th>Get it</th></tr>{''.join(si_rows)}</table>"""
    path = out / "download_queue.html"
    path.write_text(page)
    return path


def cmd_fetch(args) -> None:
    queries = _read_queries(args)
    ctx = Context()
    papers = fetch_many(queries, ctx, workers=args.workers, use_cache=not args.refresh, progress=_progress(len(queries)))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "papers.jsonl").write_text("\n".join(json.dumps(p.to_dict()) for p in papers) + "\n")
    print()
    print(summarize(papers))
    queue = write_queue(papers, ctx, out)
    print(f"\nrecords: {out / 'papers.jsonl'}\nper-paper text: {ctx.cfg.cache_dir / 'papers'}\ndownload queue: {queue}")


def cmd_bench(args) -> None:
    ctx = Context()
    queries = []
    for name in args.publishers.split(","):
        pid = OPENALEX_PUBLISHERS[name]
        params = {
            "filter": f"primary_location.source.publisher_lineage:{pid},type:article,"
                      f"publication_year:{args.years},title_and_abstract.search:{args.topic},has_doi:true"
                      + (f",primary_topic.field.id:{args.fields}" if args.fields else ""),
            "sample": args.per_publisher, "seed": args.seed, "per_page": args.per_publisher, "select": "doi",
        }
        if ctx.cfg.email:
            params["mailto"] = ctx.cfg.email
        data = ctx.http.json("https://api.openalex.org/works", params=params) or {}
        dois = [w["doi"].removeprefix("https://doi.org/") for w in data.get("results", []) if w.get("doi")]
        print(f"sampled {len(dois)} {name} papers")
        queries += dois
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "bench_dois.txt").write_text("\n".join(queries) + "\n")
    papers = fetch_many(queries, ctx, workers=args.workers, use_cache=not args.refresh, progress=_progress(len(queries)))
    (out / "bench_results.jsonl").write_text("\n".join(json.dumps(p.to_dict()) for p in papers) + "\n")
    report = summarize(papers)
    (out / "bench_report.txt").write_text(report + "\n\nkeys in use: " + json.dumps(ctx.cfg.enabled_routes()) + "\n")
    print()
    print(report)
    write_queue(papers, ctx, out)


def cmd_context(args) -> None:
    queries = _read_queries(args)
    papers = fetch_many(queries, Context(), workers=args.workers)
    text = build_context(papers, args.max_chars)
    if args.out:
        Path(args.out).write_text(text)
        print(f"wrote {len(text)} chars to {args.out}")
    else:
        print(text)


def cmd_status(args) -> None:
    ctx = Context()
    print("full-text routes:")
    for name, on in ctx.cfg.enabled_routes().items():
        print(f"  [{'x' if on else ' '}] {name}")
    print("  [x] PubMed Central open-data bucket, Europe PMC, NCBI BioC, arXiv, bioRxiv, OA links")
    print(f"inbox: {ctx.cfg.inbox_dir} ({len(ctx.local_index.by_doi)} PDFs with a DOI, incl. Zotero)")
    print(f"contact email set: {bool(ctx.cfg.email)} (needed for Unpaywall)")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="paperfetch", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="fetch full text for DOIs/arXiv ids/PMCIDs/titles")
    f.add_argument("ids", nargs="*")
    f.add_argument("--file", help="text file with one id per line")
    f.add_argument("--out", default=str(PROJECT_ROOT / "output"))
    f.add_argument("--workers", type=int, default=4)
    f.add_argument("--refresh", action="store_true", help="ignore the cache")
    f.set_defaults(func=cmd_fetch)

    b = sub.add_parser("bench", help="measure coverage on a random sample of papers")
    b.add_argument("--publishers", default=",".join(OPENALEX_PUBLISHERS))
    b.add_argument("--per-publisher", type=int, default=20)
    b.add_argument("--topic", default="synthesis")
    b.add_argument("--years", default="2012-2025")
    b.add_argument("--fields", default="16|25|15", help="OpenAlex field ids (16 Chemistry, 25 Materials, 15 Chem Eng)")
    b.add_argument("--seed", type=int, default=7)
    b.add_argument("--out", default=str(PROJECT_ROOT / "bench"))
    b.add_argument("--workers", type=int, default=6)
    b.add_argument("--refresh", action="store_true")
    b.set_defaults(func=cmd_bench)

    c = sub.add_parser("context", help="print the methods-first LLM context for some papers")
    c.add_argument("ids", nargs="*")
    c.add_argument("--file")
    c.add_argument("--out")
    c.add_argument("--max-chars", type=int, default=60000)
    c.add_argument("--workers", type=int, default=4)
    c.set_defaults(func=cmd_context)

    s = sub.add_parser("status", help="show which routes are enabled")
    s.set_defaults(func=cmd_status)

    args = ap.parse_args(argv)
    args.func(args)
