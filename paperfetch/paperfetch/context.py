"""Build the text handed to the synthesis-planning LLM.

Methods and SI go first because they hold the procedures, reagents and
conditions. Every paper is labelled with how much of it we actually have, so
the model is told not to invent procedures for papers it only saw the abstract of.
"""
from __future__ import annotations

from .models import Paper

GUARDRAIL = (
    "Each source below is marked FULL TEXT or ABSTRACT ONLY. Take reagents, amounts, "
    "conditions and yields only from FULL TEXT sources and cite them as [S#]. For ABSTRACT ONLY "
    "sources, use them for the route idea only and say that the procedure must be checked."
)


def paper_block(paper: Paper, n: int, max_chars: int) -> str:
    status = "FULL TEXT" if paper.coverage == "full" else "ABSTRACT ONLY"
    head = [f"[S{n}] {paper.title or paper.query}",
            f"DOI: {paper.doi or '-'} | {paper.journal or paper.publisher} {paper.year or ''} | {status}"
            + (f" ({paper.version} version via {paper.fulltext_source})" if paper.coverage == "full" else "")]
    if paper.coverage == "full" and paper.si_status != "fetched":
        head.append("Note: Supporting Information not retrieved; detailed procedures may be missing.")
    body = []
    if paper.abstract:
        body.append(f"Abstract: {paper.abstract}")
    methods = paper.methods_text()
    if methods:
        body.append(f"Experimental / methods:\n{methods}")
    if paper.coverage == "full":
        rest = "\n\n".join(f"## {s.title}\n{s.text}" for s in paper.sections if s.kind in ("results", "discussion", "other", "conclusion"))
        if rest:
            body.append(f"Results and discussion:\n{rest}")
    text = "\n".join(head) + "\n\n" + "\n\n".join(body)
    return text if len(text) <= max_chars else text[: max_chars - 40] + "\n[... truncated for length ...]"


def build_context(papers: list[Paper], max_chars_per_paper: int = 60000) -> str:
    blocks = [paper_block(p, i + 1, max_chars_per_paper) for i, p in enumerate(papers)]
    return GUARDRAIL + "\n\n" + "\n\n---\n\n".join(blocks)
