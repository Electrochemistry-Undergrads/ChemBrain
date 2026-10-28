from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

METHODS_KINDS = ("methods", "si")


@dataclass
class Section:
    title: str
    text: str
    kind: str = "other"   # abstract | intro | methods | results | discussion | conclusion | si | other


@dataclass
class Attempt:
    source: str
    outcome: str          # ok | miss | blocked | error | skipped | rejected
    detail: str = ""
    url: str | None = None


@dataclass
class Paper:
    query: str
    doi: str | None = None
    title: str | None = None
    year: int | None = None
    publisher: str = "Other"
    journal: str | None = None
    openalex_id: str | None = None
    pmcid: str | None = None
    pmid: str | None = None
    arxiv: str | None = None
    abstract: str | None = None
    oa_status: str | None = None

    coverage: str = "none"            # full | abstract | none
    fulltext_source: str | None = None
    fulltext_format: str | None = None  # jats | tei | elsevier-xml | bioc | pdf
    version: str | None = None        # published | accepted | preprint
    sections: list[Section] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    si_status: str = "none"           # fetched | linked | none
    si_text: str = ""
    si_files: list[str] = field(default_factory=list)
    si_links: list[str] = field(default_factory=list)   # SI to open in your browser when not fetched
    attempts: list[Attempt] = field(default_factory=list)
    manual_links: list[str] = field(default_factory=list)
    candidate_pdf_urls: list[str] = field(default_factory=list)
    # Filled during resolution; not part of the saved record.
    _meta: dict = field(default_factory=dict, repr=False)

    def log(self, source: str, outcome: str, detail: str = "", url: str | None = None) -> None:
        self.attempts.append(Attempt(source, outcome, detail[:300], url))

    @property
    def full_text(self) -> str:
        return "\n\n".join(f"## {s.title}\n{s.text}" if s.title else s.text for s in self.sections)

    def methods_text(self) -> str:
        """Experimental/methods sections plus SI text: what a synthesis plan needs."""
        parts = [f"## {s.title}\n{s.text}" for s in self.sections if s.kind in METHODS_KINDS]
        if self.si_text:
            parts.append(f"## Supporting Information\n{self.si_text}")
        return "\n\n".join(parts)

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("_meta", None)
        d["full_text_chars"] = len(self.full_text)
        d["methods_chars"] = len(self.methods_text())
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Paper":
        d = {k: v for k, v in d.items() if k in cls.__dataclass_fields__ and k != "_meta"}
        d["sections"] = [Section(**s) for s in d.get("sections", [])]
        d["attempts"] = [Attempt(**a) for a in d.get("attempts", [])]
        return cls(**d)


# Spaces are optional (\s*) because some PDF fonts drop them from headings.
_KIND_PATTERNS = [
    ("si", r"supporting\s*information|supplementary\s*(?:information|material|data)|electronic\s*supplementary"),
    ("abstract", r"^abstract$|^summary$"),
    ("results", r"results|discussion"),
    ("methods", r"method|experimental|materials|procedure|preparation|general\s*information|"
                r"instrumentation|synthetic\s*details|characteri[sz]ation|reagents|^synthesis$|^online\s*methods"),
    ("intro", r"introduction|background"),
    ("conclusion", r"conclusion|outlook|summary\s*and"),
]


def classify(title: str, sec_type: str | None = None) -> str:
    st = (sec_type or "").lower()
    if st:
        if "method" in st or "materials" in st:
            return "methods"
        if "supplementary" in st:
            return "si"
    t = re.sub(r"^[\dIVX]+\.?\s*", "", (title or "").strip().lower())
    for kind, pat in _KIND_PATTERNS:
        if re.search(pat, t):
            return kind
    return "other"
