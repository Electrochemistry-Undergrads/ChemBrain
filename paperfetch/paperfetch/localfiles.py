"""Index of PDFs you already have: the inbox/ folder and your Zotero library.

This is how papers that can't be fetched automatically (mostly ACS and RSC)
get in: download them in your browser through the UT library, or let Zotero
fetch them, and the next run picks them up by DOI.
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from pathlib import Path

from .config import Config
from .ids import DOI_RE, clean_doi
from .resolve import title_match

_SI_NAME = re.compile(r"(?i)(?:^|[_\-\s.(])(?:e?si|supp\w*|supporting\w*|supplementary\w*)(?:[_\-\s.)]|\d|$)")
_SI_HEAD = re.compile(r"(?i)supporting\s*information|supplementary\s*(?:information|material)|electronic\s*supplementary")


def _looks_like_si(path: Path, head: str) -> bool:
    return bool(_SI_NAME.search(path.stem)) or bool(_SI_HEAD.search(head[:400]))


def _pdf_doi_and_head(path: Path) -> tuple[str | None, str]:
    import pymupdf

    try:
        with pymupdf.open(path) as doc:
            meta = " ".join(str(v) for v in (doc.metadata or {}).values() if v)
            head = "".join(doc[i].get_text() for i in range(min(2, len(doc))))
    except Exception:
        return None, ""
    for text in (path.name.replace("_", "/"), meta, head):
        m = DOI_RE.search(text)
        if m:
            return clean_doi(m.group(0)), head[:3000]
    return None, head[:3000]


class LocalIndex:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.index_path = cfg.cache_dir / "local_index.json"
        self.by_doi: dict[str, str] = {}
        self.heads: dict[str, str] = {}
        self.si: list[dict] = []
        self._lock = threading.Lock()
        self.refresh()

    def refresh(self) -> None:
        self.cfg.inbox_dir.mkdir(parents=True, exist_ok=True)
        try:
            cache = json.loads(self.index_path.read_text())
        except (OSError, ValueError):
            cache = {}
        fresh = {}
        for pdf in self.cfg.inbox_dir.rglob("*.pdf"):
            key = f"{pdf}|{pdf.stat().st_mtime_ns}|{pdf.stat().st_size}"
            entry = cache.get(key)
            if entry is None:
                doi, head = _pdf_doi_and_head(pdf)
                entry = {"path": str(pdf), "doi": doi, "head": head, "si": _looks_like_si(pdf, head)}
            fresh[key] = entry
        papers = [e for e in fresh.values() if not e.get("si")]
        self.si = [e for e in fresh.values() if e.get("si")]
        self.by_doi = {e["doi"]: e["path"] for e in papers if e["doi"]}
        self.heads = {e["path"]: e["head"] for e in papers}
        self.by_doi.update(self._zotero())  # Zotero's own DOI field beats text sniffing
        self.cfg.cache_dir.mkdir(parents=True, exist_ok=True)
        self.index_path.write_text(json.dumps(fresh))

    def _zotero(self) -> dict[str, str]:
        if not self.cfg.zotero_dir:
            return {}
        db = self.cfg.zotero_dir / "zotero.sqlite"
        if not db.is_file():
            return {}
        query = """
            SELECT LOWER(v.value), ia.path, att.key
            FROM items i
            JOIN itemData d ON d.itemID = i.itemID
            JOIN fields f ON f.fieldID = d.fieldID AND f.fieldName = 'DOI'
            JOIN itemDataValues v ON v.valueID = d.valueID
            JOIN itemAttachments ia ON ia.parentItemID = i.itemID
            JOIN items att ON att.itemID = ia.itemID
            WHERE ia.contentType = 'application/pdf' AND ia.path LIKE 'storage:%'
        """
        out = {}
        try:
            # immutable=1 reads the DB without taking Zotero's lock (safe while Zotero is open).
            con = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True)
            for doi, path, key in con.execute(query):
                pdf = self.cfg.zotero_dir / "storage" / key / path.removeprefix("storage:")
                if pdf.is_file():
                    out[clean_doi(doi)] = str(pdf)
            con.close()
        except sqlite3.Error:
            return {}
        return out

    def lookup(self, doi: str | None, title: str | None) -> str | None:
        with self._lock:
            if doi and doi in self.by_doi:
                return self.by_doi[doi]
            if title and len(title) > 25:
                for path, head in self.heads.items():
                    if head and title_match(title, head, 0.9):
                        return path
        return None

    def lookup_si(self, doi: str | None, title: str | None) -> list[str]:
        """SI PDFs in the inbox for this paper: by DOI if printed, else by the title on page 1."""
        with self._lock:
            return [e["path"] for e in self.si
                    if (doi and e.get("doi") == doi) or (title and len(title) > 25 and title_match(title, e["head"], 0.85))]
