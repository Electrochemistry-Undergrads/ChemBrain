"""Turn whatever the user typed (DOI, URL, arXiv id, PMCID, PMID, title) into a typed id."""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import unquote

DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"<>]+", re.I)
ARXIV_RE = re.compile(r"(?:arxiv[:/ ]|arxiv\.org/(?:abs|pdf)/)(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?", re.I)
BARE_ARXIV_RE = re.compile(r"^(\d{4}\.\d{4,5})(v\d+)?$")
PMCID_RE = re.compile(r"\bPMC\d{4,9}\b", re.I)
PMID_RE = re.compile(r"^(?:pmid:?\s*)?(\d{5,9})$", re.I)

# DOI prefix -> publisher family used for routing and reporting.
PUBLISHER_PREFIXES = {
    "10.1021": "ACS",
    "10.1038": "Nature",
    "10.1002": "Wiley",
    "10.1111": "Wiley",
    "10.1007": "Springer",
    "10.1186": "Springer",
    "10.1140": "Springer",
    "10.1023": "Springer",
    "10.1039": "RSC",
    "10.1016": "Elsevier",
    "10.1126": "Science",
    "10.1101": "bioRxiv",
    "10.26434": "ChemRxiv",
    "10.48550": "arXiv",
}

# OpenAlex publisher ids for the priority publishers (search filters and the benchmark).
OPENALEX_PUBLISHERS = {
    "ACS": "P4310320006",
    "Elsevier": "P4310320990",
    "Wiley": "P4310320595",
    "Nature": "P4310319908",
    "Springer": "P4310319900",
    "RSC": "P4310320556",
}


@dataclass
class PaperId:
    kind: str   # doi | arxiv | pmcid | pmid | title
    value: str


def clean_doi(doi: str) -> str:
    doi = unquote(doi).strip()
    doi = re.sub(r"^(?:https?://)?(?:dx\.)?doi\.org/", "", doi, flags=re.I)
    doi = re.sub(r"^doi:\s*", "", doi, flags=re.I)
    # Trailing punctuation and URL fragments picked up from copied text or links.
    doi = re.sub(r"(?:/(?:full|abstract|pdf|epdf|suppl_file)|[?#].*)$", "", doi, flags=re.I)
    return doi.rstrip(".,;)]}").lower()


def parse(raw: str) -> PaperId:
    text = raw.strip()
    m = ARXIV_RE.search(text) or BARE_ARXIV_RE.match(text)
    if m:
        return PaperId("arxiv", m.group(1))
    m = re.search(r"10\.48550/arxiv\.(\d{4}\.\d{4,5})", text, re.I)
    if m:
        return PaperId("arxiv", m.group(1))
    m = DOI_RE.search(text)
    if m:
        return PaperId("doi", clean_doi(m.group(0)))
    m = PMCID_RE.search(text)
    if m:
        return PaperId("pmcid", m.group(0).upper())
    m = PMID_RE.match(text)
    if m:
        return PaperId("pmid", m.group(1))
    return PaperId("title", text)


def publisher_of(doi: str | None) -> str:
    if not doi:
        return "Other"
    return PUBLISHER_PREFIXES.get(doi.split("/", 1)[0], "Other")


def slug(doi_or_text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", doi_or_text)[:120]
