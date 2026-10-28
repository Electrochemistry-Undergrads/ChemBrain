"""HTTP client: honest User-Agent, per-host rate limits, retries on 429/5xx.

The client always identifies itself as paperfetch. It never pretends to be a
browser: a publisher page that blocks scripts is treated as "not available
automatically" and the paper goes to the assisted-download list instead.
"""
from __future__ import annotations

import threading
import time
from urllib.parse import urlparse

import httpx

from .config import Config

# Minimum seconds between requests to one host (published limits, with margin).
_HOST_INTERVAL = {
    "api.semanticscholar.org": 1.1,
    "eutils.ncbi.nlm.nih.gov": 0.4,
    "pmc.ncbi.nlm.nih.gov": 0.4,
    "www.ncbi.nlm.nih.gov": 0.4,
    "export.arxiv.org": 3.0,
    "arxiv.org": 1.0,
    "api.core.ac.uk": 1.0,
    "api.crossref.org": 0.1,
    "api.openalex.org": 0.1,
    "api.elsevier.com": 0.2,
    "api.wiley.com": 0.5,
}
_DEFAULT_INTERVAL = 0.25
MAX_BYTES = 80 * 1024 * 1024


class Http:
    def __init__(self, cfg: Config):
        contact = f"; mailto:{cfg.email}" if cfg.email else ""
        self.client = httpx.Client(
            follow_redirects=True,
            timeout=httpx.Timeout(45.0, connect=15.0),
            headers={"User-Agent": f"paperfetch/0.1 (literature full-text retrieval{contact})"},
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
        self._locks: dict[str, threading.Lock] = {}
        self._last: dict[str, float] = {}
        self._guard = threading.Lock()

    def _wait_turn(self, host: str) -> None:
        with self._guard:
            lock = self._locks.setdefault(host, threading.Lock())
        with lock:
            gap = _HOST_INTERVAL.get(host, _DEFAULT_INTERVAL)
            wait = self._last.get(host, 0.0) + gap - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last[host] = time.monotonic()

    def get(self, url: str, *, params=None, headers=None, retries: int = 3) -> httpx.Response | None:
        """GET with rate limiting and retry. Returns None on network failure."""
        host = urlparse(url).hostname or ""
        for attempt in range(retries + 1):
            self._wait_turn(host)
            try:
                with self.client.stream("GET", url, params=params, headers=headers) as resp:
                    body = bytearray()
                    for chunk in resp.iter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_BYTES:
                            break
                    resp._content = bytes(body)
            except (httpx.HTTPError, OSError):
                if attempt == retries:
                    return None
                time.sleep(1.5 * (attempt + 1))
                continue
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < retries:
                retry_after = resp.headers.get("Retry-After", "")
                delay = float(retry_after) if retry_after.isdigit() else 2.0 * (attempt + 1)
                time.sleep(min(delay, 30.0))
                continue
            return resp
        return None

    def json(self, url: str, **kw):
        resp = self.get(url, **kw)
        if resp is None or resp.status_code != 200:
            return None
        try:
            return resp.json()
        except ValueError:
            return None
