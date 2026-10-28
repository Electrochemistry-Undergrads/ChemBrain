"""Send papers into a ChemBrain project.

ChemBrain runs in the cloud, off any campus network, so it can't open subscription papers. This
runs on your computer instead: it asks the project which papers still lack full text, fetches them
through the usual routes (your network, keys, inbox and Zotero), and uploads each one as JATS XML,
with its Supporting Information as a final section.

The link code comes from the project's Papers tab. It only allows uploads into that project.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlparse
from xml.sax.saxutils import escape

import httpx

from .fetcher import Context, fetch_many
from .models import Paper

MAX_PUSH = 50
_BAD_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")


class PushError(Exception):
    """The site or link code can't be used; nothing more will be sent."""


@dataclass
class PushReport:
    project: str
    sent: list[Paper] = field(default_factory=list)
    rejected: list[tuple[Paper, str]] = field(default_factory=list)
    missing: list[Paper] = field(default_factory=list)   # no full text here either: needs a PDF in inbox/
    remaining: int = 0                                   # left for the next run because of the limit

    def text(self, inbox: str) -> str:
        lines = [f"ChemBrain project “{self.project}”: sent {len(self.sent)}, "
                 f"rejected {len(self.rejected)}, still missing {len(self.missing)}"]
        lines += [f"  sent      {p.doi}  {(p.title or '')[:70]}" for p in self.sent]
        lines += [f"  rejected  {p.doi}  {reason}" for p, reason in self.rejected]
        if self.missing:
            lines.append(f"Save these PDFs into {inbox} (any filename), then run the same command again:")
            for p in self.missing:
                link = next((u for u in p.manual_links if "ezproxy" in u), p.manual_links[0] if p.manual_links else "")
                lines.append(f"  {p.doi}  {link}")
        if self.remaining:
            lines.append(f"{self.remaining} more papers wait for the next run (limit per run).")
        return "\n".join(lines)


def _x(text: str | None) -> str:
    return escape(_BAD_XML.sub("", text or ""))


def _paras(text: str) -> str:
    return "".join(f"<p>{_x(p.strip())}</p>" for p in re.split(r"\n\s*\n", text) if p.strip())


def to_jats(paper: Paper) -> bytes:
    """The paper as minimal JATS: DOI and title for ChemBrain's identity check, methods tagged, SI last."""
    abstract = paper.abstract or next((s.text for s in paper.sections if s.kind == "abstract"), "")
    secs = []
    for s in paper.sections:
        if s.kind == "abstract" or not s.text.strip():
            continue
        kind = ' sec-type="methods"' if s.kind == "methods" else ""
        secs.append(f"<sec{kind}><title>{_x(s.title or 'Main text')}</title>{_paras(s.text)}</sec>")
    if paper.si_text:
        parts = re.split(r"^### (.+)$", paper.si_text, flags=re.M)
        inner = _paras(parts[0])
        for name, body in zip(parts[1::2], parts[2::2]):
            inner += f"<sec><title>{_x(name)}</title>{_paras(body)}</sec>"
        secs.append(f"<sec><title>Supporting Information</title>{inner}</sec>")
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<article><front><article-meta>'
           f'<article-id pub-id-type="doi">{_x(paper.doi)}</article-id>'
           f"<title-group><article-title>{_x(paper.title)}</article-title></title-group>"
           + (f"<abstract>{_paras(abstract)}</abstract>" if abstract else "")
           + f"</article-meta></front><body>{''.join(secs)}</body></article>\n")
    return xml.encode("utf-8")


def _site(url: str) -> str:
    u = urlparse(url.strip())
    local = u.hostname in ("localhost", "127.0.0.1")
    if u.scheme not in ("https", "http") or not u.hostname or (u.scheme == "http" and not local):
        raise PushError(f"Use the site's https:// address (got {url!r}).")
    return f"{u.scheme}://{u.netloc}"


def _error(resp: httpx.Response) -> str:
    try:
        return resp.json()["error"]["message"]
    except (ValueError, KeyError, TypeError):
        return f"HTTP {resp.status_code}"


def push(site: str, code: str, ctx: Context | None = None, *, limit: int = 20,
         client: httpx.Client | None = None, fetch=fetch_many) -> PushReport:
    if not 1 <= limit <= MAX_PUSH:
        raise PushError(f"limit must be 1-{MAX_PUSH}")
    if not re.fullmatch(r"cbl_[A-Za-z0-9_-]{20,100}", code.strip()):
        raise PushError("That doesn't look like a ChemBrain link code (it starts with cbl_).")
    base = _site(site)
    ctx = ctx or Context()
    http = client or httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0))
    http.headers.update({"Authorization": f"Bearer {code.strip()}", "User-Agent": "paperfetch/0.1 (ChemBrain link)"})

    resp = http.get(f"{base}/api/link/papers")
    if resp.status_code != 200:
        raise PushError(f"ChemBrain refused the link code: {_error(resp)}")
    data = resp.json()
    todo = [p for p in data.get("papers", []) if p.get("doi")]
    report = PushReport(project=data.get("project", {}).get("name", "?"), remaining=max(0, len(todo) - limit))
    todo = todo[:limit]
    if not todo:
        return report

    ctx.local_index.refresh()  # pick up PDFs saved into inbox/ or Zotero since the last run
    papers = fetch([t["doi"] for t in todo], ctx)
    for target, paper in zip(todo, papers):
        paper.doi = paper.doi or target["doi"]
        if paper.coverage != "full":
            report.missing.append(paper)
            continue
        r = http.post(f"{base}/api/link/papers/{target['id']}/upload",
                      files={"file": (f"{target['doi'].replace('/', '_')}.xml", to_jats(paper), "application/xml")},
                      data={"source": f"{paper.fulltext_source}, {paper.version or 'unknown'} version"})
        if r.status_code == 200:
            report.sent.append(paper)
        elif r.status_code == 401:
            raise PushError(f"ChemBrain stopped accepting the link code: {_error(r)}")
        else:
            report.rejected.append((paper, _error(r)))
    return report
