"""Offline tests. Run: .venv/bin/python -m unittest discover tests"""
import unittest

from paperfetch import extract, ids
from paperfetch.models import classify
from paperfetch.resolve import title_match


class TestIds(unittest.TestCase):
    def test_parse(self):
        cases = {
            "https://doi.org/10.1021/jacs.1c06913": ("doi", "10.1021/jacs.1c06913"),
            "https://pubs.acs.org/doi/10.1021/jacs.1C06913": ("doi", "10.1021/jacs.1c06913"),
            "https://onlinelibrary.wiley.com/doi/full/10.1002/anie.202016072": ("doi", "10.1002/anie.202016072"),
            "doi:10.1016/j.tet.2020.131000.": ("doi", "10.1016/j.tet.2020.131000"),
            "arXiv:2006.10256v2": ("arxiv", "2006.10256"),
            "https://arxiv.org/abs/2006.10256": ("arxiv", "2006.10256"),
            "10.48550/arXiv.2006.10256": ("arxiv", "2006.10256"),
            "PMC8405276": ("pmcid", "PMC8405276"),
            "34324817": ("pmid", "34324817"),
            "Total Synthesis of (-)-Strempeliopine": ("title", "Total Synthesis of (-)-Strempeliopine"),
        }
        for raw, want in cases.items():
            got = ids.parse(raw)
            self.assertEqual((got.kind, got.value), want, raw)

    def test_publisher(self):
        self.assertEqual(ids.publisher_of("10.1039/d0sc06223e"), "RSC")
        self.assertEqual(ids.publisher_of("10.1016/j.tet.2020.131000"), "Elsevier")
        self.assertEqual(ids.publisher_of(None), "Other")


class TestClassify(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(classify("Experimental Section"), "methods")
        self.assertEqual(classify("2. Materials and Methods"), "methods")
        self.assertEqual(classify("Results and Discussion"), "results")
        self.assertEqual(classify("Supporting Information"), "si")
        self.assertEqual(classify("Whatever", "methods"), "methods")


JATS = b"""<article><front><article-meta><title-group><article-title>A Test Paper</article-title></title-group>
<abstract><p>Short abstract.</p></abstract></article-meta></front><body>
<sec><title>Introduction</title><p>Intro text.</p></sec>
<sec sec-type="methods"><title>Experimental</title><p>Compound 1 (1.0 g) was stirred in THF.</p>
<sec><title>Synthesis of 2</title><p>To a solution of 1 was added n-BuLi at -78 C.</p></sec></sec>
<sec><title>Results</title><p>Yield 85%.</p><table-wrap><label>Table 1</label><caption><p>Screening</p></caption>
<table><tr><th>entry</th><th>yield</th></tr><tr><td>1</td><td>85</td></tr></table></table-wrap></sec>
<supplementary-material xmlns:xlink="http://www.w3.org/1999/xlink"><media xlink:href="si.pdf"/></supplementary-material>
</body></article>"""


class TestExtract(unittest.TestCase):
    def test_jats(self):
        d = extract.parse_jats(JATS)
        self.assertEqual(d["title"], "A Test Paper")
        kinds = [s.kind for s in d["sections"]]
        self.assertEqual(kinds, ["intro", "methods", "results"])
        self.assertIn("### Synthesis of 2", d["sections"][1].text)
        self.assertIn("n-BuLi", d["sections"][1].text)
        self.assertIn("1 | 85", d["sections"][2].text)
        self.assertEqual(d["si_links"], ["si.pdf"])

    def test_pdf_headings(self):
        text = ("A Test Paper\nAbstract\nWe made things.\nIntroduction\nBackground here.\n"
                "Experimental Section\nGeneral proce-\ndure: mix A and B.\nReferences\n(1) Someone, J. Am. Chem. Soc.\n")
        secs = extract.parse_pdf_text(text)
        by_kind = {s.kind: s.text for s in secs}
        self.assertIn("General procedure: mix A and B.", by_kind["methods"])
        self.assertNotIn("Someone", " ".join(s.text for s in secs))  # references dropped

    def test_title_match(self):
        self.assertTrue(title_match("Total Synthesis of Darobactin A", "...the total synthesis of darobactin a is..."))
        self.assertFalse(title_match("Total Synthesis of Darobactin A", "Array programming with NumPy"))



class TestZotero(unittest.TestCase):
    def test_zotero_lookup(self):
        """Mini zotero.sqlite with the tables the query reads."""
        import sqlite3
        import tempfile
        from pathlib import Path

        from paperfetch.config import Config
        from paperfetch.localfiles import LocalIndex

        root = Path(tempfile.mkdtemp())
        (root / "storage" / "ABCD1234").mkdir(parents=True)
        pdf = root / "storage" / "ABCD1234" / "Smith - 2021 - Total synthesis.pdf"
        pdf.write_bytes(b"%PDF-1.4 stub")
        con = sqlite3.connect(root / "zotero.sqlite")
        con.executescript("""
            CREATE TABLE items(itemID INTEGER PRIMARY KEY, key TEXT);
            CREATE TABLE fields(fieldID INTEGER PRIMARY KEY, fieldName TEXT);
            CREATE TABLE itemDataValues(valueID INTEGER PRIMARY KEY, value TEXT);
            CREATE TABLE itemData(itemID INT, fieldID INT, valueID INT);
            CREATE TABLE itemAttachments(itemID INT, parentItemID INT, contentType TEXT, path TEXT);
            INSERT INTO items VALUES (1, 'PARENT01'), (2, 'ABCD1234');
            INSERT INTO fields VALUES (26, 'DOI');
            INSERT INTO itemDataValues VALUES (5, '10.1021/JACS.1C06913');
            INSERT INTO itemData VALUES (1, 26, 5);
            INSERT INTO itemAttachments VALUES (2, 1, 'application/pdf', 'storage:Smith - 2021 - Total synthesis.pdf');
        """)
        con.commit()
        con.close()
        cfg = Config(cache_dir=root / "cache", inbox_dir=root / "inbox", zotero_dir=root)
        idx = LocalIndex(cfg)
        self.assertEqual(idx.lookup("10.1021/jacs.1c06913", None), str(pdf))
        self.assertIsNone(idx.lookup("10.1021/other", None))

    def test_clean_si(self):
        self.assertEqual(extract.clean_si("General information……………………SI-2\n\nAll reactions"), "General information\n\nAll reactions")


class TestMcpServer(unittest.TestCase):
    """The MCP tools are plain functions; run them against a temporary cache."""

    def setUp(self):
        import json
        import tempfile
        from pathlib import Path

        from paperfetch import mcp_server
        from paperfetch.config import Config
        from paperfetch.fetcher import Context, _save
        from paperfetch.models import Paper, Section

        self.m = mcp_server
        root = Path(tempfile.mkdtemp())
        mcp_server.set_context(Context(Config(cache_dir=root / "cache", inbox_dir=root / "inbox")))
        paper = Paper(query="10.1021/jacs.1c06913", doi="10.1021/jacs.1c06913", title="Hot-Injection Synthesis of InP Dots",
                      publisher="ACS", coverage="full", fulltext_source="local", version="published",
                      sections=[Section("Introduction", "Quantum dots are useful.", "intro"),
                                Section("Experimental Section", "Oleylamine (5 mL) was degassed at 120 °C.", "methods")],
                      si_status="fetched", si_text="SI: InCl3 0.1 mmol in hot\nInjection flask.")
        out = root / "cache" / "papers" / ids.slug(paper.doi)
        out.mkdir(parents=True)
        _save(paper, out)
        self.assertTrue(json.loads((out / "paper.json").read_text())["doi"])

    def tearDown(self):
        self.m.set_context(None)

    def test_read_paper(self):
        methods = self.m.read_paper("https://doi.org/10.1021/jacs.1c06913")
        self.assertIn("Oleylamine (5 mL)", methods)
        self.assertIn("InCl3", methods)
        self.assertNotIn("Quantum dots are useful", methods)
        self.assertIn("Quantum dots are useful", self.m.read_paper("10.1021/jacs.1c06913", "full"))
        self.assertIn("truncated", self.m.read_paper("10.1021/jacs.1c06913", "full", max_chars=10))
        self.assertIn("not in the cache", self.m.read_paper("10.1021/missing"))
        with self.assertRaises(ValueError):
            self.m.read_paper("10.1021/jacs.1c06913", "figures")

    def test_search_library(self):
        hit = self.m.search_library("hot injection")  # hyphenated in the title, line break in the SI
        self.assertIn("10.1021/jacs.1c06913", hit)
        self.assertIn("Hot-Injection Synthesis of InP Dots", hit)
        self.assertIn("No fetched paper", self.m.search_library("palladium"))

    def test_caps(self):
        with self.assertRaises(ValueError):
            self.m.fetch_papers([f"10.1021/x{i}" for i in range(21)])
        with self.assertRaises(ValueError):
            self.m.fetch_papers([])
        with self.assertRaises(ValueError):
            self.m.search_papers("perovskite", limit=26)
        with self.assertRaises(ValueError):
            self.m.search_papers("perovskite", publishers=["Science"])


if __name__ == "__main__":
    unittest.main()
