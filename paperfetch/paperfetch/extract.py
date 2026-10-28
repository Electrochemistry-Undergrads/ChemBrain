"""Convert every full-text format into a list of titled, classified sections."""
from __future__ import annotations

import io
import re
import zipfile

from lxml import etree

from .models import Section, classify

_PARSER = etree.XMLParser(recover=True, huge_tree=True, resolve_entities=False, no_network=True)
_WS = re.compile(r"[ \t\r\f\v]+")


def _norm(text: str) -> str:
    text = _WS.sub(" ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()


def _local(el) -> str:
    tag = el.tag
    return tag.split("}", 1)[1] if isinstance(tag, str) and "}" in tag else str(tag)


def _text(el) -> str:
    return _norm("".join(el.itertext()))


def _xml(data: bytes):
    try:
        return etree.fromstring(data, _PARSER)
    except etree.XMLSyntaxError:
        return None


# --------------------------------------------------------------------- JATS
def _jats_block_text(sec, depth=0) -> str:
    """Paragraphs, lists, captions and nested subsections of one <sec>, in order."""
    out = []
    for child in sec:
        name = _local(child)
        if name == "title":
            continue
        if name == "sec":
            sub_title = child.find("title")
            heading = _text(sub_title) if sub_title is not None else ""
            body = _jats_block_text(child, depth + 1)
            out.append((f"### {heading}\n" if heading else "") + body)
        elif name in ("p", "list", "disp-formula", "statement", "boxed-text", "def-list", "disp-quote"):
            out.append(_text(child))
        elif name in ("fig", "table-wrap", "scheme", "chem-struct-wrap"):
            cap = child.find(".//caption")
            label = child.find("label")
            if cap is not None:
                out.append(f"[{_text(label) if label is not None else name}] {_text(cap)}")
            table = child.find(".//table")
            if table is not None:
                out.append(_table_text(table))
    return "\n\n".join(t for t in out if t)


def _table_text(table) -> str:
    rows = []
    for tr in table.iter():
        if _local(tr) == "tr":
            cells = [_text(td) for td in tr if _local(td) in ("td", "th")]
            rows.append(" | ".join(cells))
    return "\n".join(rows)


def parse_jats(data: bytes) -> dict:
    root = _xml(data)
    if root is None:
        return {}
    for el in root.iter():  # Drop namespaces so plain paths work for every JATS flavour.
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    title_el = root.find(".//article-meta/title-group/article-title")
    abstract_el = root.find(".//article-meta/abstract")
    sections: list[Section] = []
    body = root.find(".//body")
    if body is not None:
        loose = []
        for child in body:
            if child.tag == "sec":
                t = child.find("title")
                title = _text(t) if t is not None else ""
                text = _jats_block_text(child)
                if text:
                    sections.append(Section(title, text, classify(title, child.get("sec-type"))))
            elif child.tag == "p":
                loose.append(_text(child))
        if loose:
            sections.insert(0, Section("", "\n\n".join(loose), "other"))
    back = root.find(".//back")
    if back is not None:  # Methods sometimes live in <back> (e.g. Nature "Methods" in app-group).
        for sec in back.iter("sec"):
            t = sec.find("title")
            title = _text(t) if t is not None else ""
            kind = classify(title, sec.get("sec-type"))
            if kind == "methods":
                sections.append(Section(title, _jats_block_text(sec), kind))
    si_links = []
    for sm in root.iter("supplementary-material"):
        href = sm.get("{http://www.w3.org/1999/xlink}href") or sm.get("href")
        media = sm.find(".//media")
        if not href and media is not None:
            href = media.get("{http://www.w3.org/1999/xlink}href") or media.get("href")
        if href:
            si_links.append(href)
    return {
        "title": _text(title_el) if title_el is not None else None,
        "abstract": _text(abstract_el) if abstract_el is not None else None,
        "sections": sections,
        "si_links": si_links,
    }


# --------------------------------------------------------------------- GROBID TEI
def parse_tei(data: bytes) -> dict:
    root = _xml(data)
    if root is None:
        return {}
    ns = {"t": "http://www.tei-c.org/ns/1.0"}
    title = root.find(".//t:titleStmt/t:title", ns)
    abstract = root.find(".//t:profileDesc/t:abstract", ns)
    sections = []
    for div in root.findall(".//t:text/t:body/t:div", ns) + root.findall(".//t:text/t:back/t:div[@type='annex']/t:div", ns):
        head = div.find("t:head", ns)
        heading = _text(head) if head is not None else ""
        paras = [_text(p) for p in div if _local(p) in ("p", "formula", "list")]
        text = "\n\n".join(p for p in paras if p)
        if not text:
            continue
        # GROBID flattens subsections into sibling divs; merge untitled ones into the previous one.
        if sections and (not heading or (head is not None and head.get("n", "").count(".") > 0)):
            prev = sections[-1]
            prev.text += f"\n\n### {heading}\n{text}" if heading else f"\n\n{text}"
            continue
        sections.append(Section(heading, text, classify(heading)))
    return {
        "title": _text(title) if title is not None else None,
        "abstract": _text(abstract) if abstract is not None else None,
        "sections": sections,
        "si_links": [],
    }


# --------------------------------------------------------------------- Elsevier full-text XML
def parse_elsevier(data: bytes) -> dict:
    root = _xml(data)
    if root is None:
        return {}
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    title = root.find(".//coredata/title")
    abstract = root.find(".//coredata/description")
    sections = []

    def walk(sec, depth=0):
        st = sec.find("section-title")
        heading = _text(st) if st is not None else ""
        chunks = []
        for child in sec:
            if child.tag == "para" or child.tag == "simple-para":
                chunks.append(_text(child))
            elif child.tag == "section":
                sub_heading, sub_text = walk(child, depth + 1)
                chunks.append((f"### {sub_heading}\n" if sub_heading else "") + sub_text)
        return heading, "\n\n".join(c for c in chunks if c)

    container = root.find(".//sections")
    if container is not None:
        for sec in container.findall("section"):
            heading, text = walk(sec)
            if text:
                sections.append(Section(heading, text, classify(heading)))
    return {
        "title": _text(title) if title is not None else None,
        "abstract": _text(abstract) if abstract is not None else None,
        "sections": sections,
        "si_links": [],
    }


# --------------------------------------------------------------------- NCBI BioC JSON
_BIOC_KIND = {"METHODS": "methods", "RESULTS": "results", "DISCUSS": "discussion", "INTRO": "intro",
              "CONCL": "conclusion", "ABSTRACT": "abstract", "SUPPL": "si"}


def parse_bioc(doc: dict) -> dict:
    sections: list[Section] = []
    title = abstract = None
    for p in doc.get("passages", []):
        inf = p.get("infons", {})
        st = inf.get("section_type", "")
        typ = inf.get("type", "")
        text = (p.get("text") or "").strip()
        if not text or st in ("REF", "FIG", "TABLE", "COMP_INT", "AUTH_CONT", "ACK_FUND", "REVIEW_INFO"):
            if st in ("FIG", "TABLE") and text and "caption" in typ:
                if sections:
                    sections[-1].text += f"\n\n[{st.lower()}] {text}"
            continue
        if st == "TITLE" and typ == "front":
            title = text
            continue
        if st == "ABSTRACT":
            abstract = f"{abstract}\n\n{text}" if abstract else text
            continue
        if typ.startswith("title"):
            sections.append(Section(text, "", _BIOC_KIND.get(st, classify(text))))
            continue
        if not sections or sections[-1].kind != _BIOC_KIND.get(st, sections[-1].kind):
            sections.append(Section(st.title(), "", _BIOC_KIND.get(st, "other")))
        sections[-1].text = f"{sections[-1].text}\n\n{text}".strip()
    return {"title": title, "abstract": abstract, "sections": [s for s in sections if s.text], "si_links": []}


# --------------------------------------------------------------------- PDF
# Compared with spaces removed: some publisher fonts (RSC) drop them, ACS prefixes "■ ".
_HEADINGS = {
    "abstract", "introduction", "background", "results", "resultsanddiscussion", "discussion",
    "conclusion", "conclusions", "conclusionsandoutlook", "summaryandoutlook", "outlook",
    "methods", "method", "materialsandmethods", "experimental", "experimentalsection",
    "experimentalprocedure", "experimentalprocedures", "experimentaldetails", "experimentalmethods",
    "onlinemethods", "generalprocedure", "generalprocedures", "generalinformation", "generalmethods",
    "syntheticprocedures", "syntheticprocedure", "synthesis", "characterization", "characterisation",
    "materials", "supportinginformation", "supplementaryinformation", "supplementarymaterial",
    "electronicsupplementaryinformation", "associatedcontent", "acknowledgements", "acknowledgments",
    "acknowledgement", "acknowledgment", "references", "referencesandnotes", "notesandreferences", "notes",
    "authorinformation", "authorcontributions", "conflictsofinterest", "conflictofinterest",
    "competinginterests", "dataavailability", "dataavailabilitystatement", "funding", "keywords",
}
# Back matter: noise for synthesis planning.
_STOP = ("acknowledg", "reference", "notes", "author", "conflict", "competing", "funding", "keywords",
         "associatedcontent", "dataavailability")
_LEAD = re.compile(r"^[\W_]*(?:(?:\d{1,2}(?:\.\d{1,2})*|[IVX]{1,4})\.?\s+)?")


def _heading_key(line: str) -> str | None:
    if not 3 <= len(line) <= 60:
        return None
    key = re.sub(r"[\s:.]+", "", _LEAD.sub("", line)).lower().replace("ﬂ", "fl").replace("ﬁ", "fi")
    return key if key in _HEADINGS else None


def pdf_text(data: bytes) -> tuple[str, int]:
    import pymupdf

    with pymupdf.open(stream=data, filetype="pdf") as doc:
        # Content-stream order keeps two-column layouts column by column; sort=True would interleave them.
        pages = [page.get_text("text") for page in doc]
        return "\n".join(pages), len(pages)


def parse_pdf_text(text: str) -> list[Section]:
    sections: list[Section] = [Section("", "", "other")]
    for line in text.splitlines():
        stripped = line.strip()
        key = _heading_key(stripped)
        if key:
            title = _LEAD.sub("", stripped).strip(" :.")
            sections.append(Section(title, "", classify(title) if " " in title else classify(key)))
            sections[-1].key = key
            continue
        sections[-1].text += line + "\n"
    out = []
    for s in sections:
        s.text = _dehyphenate(s.text)
        if not s.text or getattr(s, "key", "").startswith(_STOP):
            continue
        out.append(s)
    return out


def _dehyphenate(text: str) -> str:
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = re.sub(r"(?<![.\n:])\n(?!\n)", " ", text)
    return _norm(text)


def clean_si(text: str) -> str:
    """Tidy SI text: drop table-of-contents dot leaders, page furniture and runs of blank lines."""
    text = re.sub(r"[.…·]{4,}\s*S?I?-?\d*", " ", text)
    text = re.sub(r"(?im)^\s*(?:S|SI-)?\d{1,3}\s*$", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return _norm(text)


def docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml = z.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError):
        return ""
    root = _xml(xml)
    if root is None:
        return ""
    w = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    paras = ["".join(t.text or "" for t in p.iter(f"{w}t")) for p in root.iter(f"{w}p")]
    return _norm("\n".join(paras))
