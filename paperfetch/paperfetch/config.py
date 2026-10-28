"""Settings, read from environment variables or a .env file in the project root.

Every key is optional. Each one unlocks another full-text route; see README.md
for where to get them.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


@dataclass
class Config:
    email: str | None = None              # polite-pool contact for OpenAlex/Crossref/Unpaywall/NCBI
    openalex_key: str | None = None       # content.openalex.org cached PDFs + GROBID XML
    core_key: str | None = None           # CORE aggregator of repository full texts
    s2_key: str | None = None             # Semantic Scholar (higher rate limit)
    ncbi_key: str | None = None           # NCBI E-utilities (higher rate limit)
    elsevier_key: str | None = None       # ScienceDirect full text (entitled on UT network/VPN)
    elsevier_insttoken: str | None = None # lets Elsevier entitle you off-campus
    wiley_token: str | None = None        # Wiley TDM API (entitled on UT network/VPN)
    springer_key: str | None = None       # Springer Nature open-access JATS API
    proxy_prefix: str | None = None       # library proxy prefix, used only for links shown to you
    cache_dir: Path = PROJECT_ROOT / "cache"
    inbox_dir: Path = PROJECT_ROOT / "inbox"
    zotero_dir: Path | None = None
    fetch_si: bool = True

    @classmethod
    def from_env(cls) -> "Config":
        _load_dotenv(PROJECT_ROOT / ".env")
        zotero = _env("ZOTERO_DIR")
        if zotero is None and (Path.home() / "Zotero" / "storage").is_dir():
            zotero = str(Path.home() / "Zotero")
        return cls(
            email=_env("CONTACT_EMAIL"),
            openalex_key=_env("OPENALEX_API_KEY"),
            core_key=_env("CORE_API_KEY"),
            s2_key=_env("S2_API_KEY"),
            ncbi_key=_env("NCBI_API_KEY"),
            elsevier_key=_env("ELSEVIER_API_KEY"),
            elsevier_insttoken=_env("ELSEVIER_INSTTOKEN"),
            wiley_token=_env("WILEY_TDM_TOKEN"),
            springer_key=_env("SPRINGER_API_KEY"),
            proxy_prefix=_env("LIBRARY_PROXY_PREFIX") or "https://login.ezproxy.lib.utexas.edu/login?url=",
            cache_dir=Path(_env("PAPERFETCH_CACHE") or PROJECT_ROOT / "cache"),
            inbox_dir=Path(_env("PAPERFETCH_INBOX") or PROJECT_ROOT / "inbox"),
            zotero_dir=Path(zotero) if zotero else None,
            fetch_si=(_env("PAPERFETCH_FETCH_SI") or "1") != "0",
        )

    def enabled_routes(self) -> dict[str, bool]:
        return {
            "OpenAlex content (cached PDFs/XML)": bool(self.openalex_key),
            "Elsevier / ScienceDirect API": bool(self.elsevier_key),
            "Wiley TDM API": bool(self.wiley_token),
            "Springer Nature OA API": bool(self.springer_key),
            "CORE": bool(self.core_key),
            "Zotero library": bool(self.zotero_dir),
        }
