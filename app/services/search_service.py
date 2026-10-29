"""Search provider abstraction and a default, dependency-free implementation.

The rest of the pipeline depends only on the SearchProvider interface, so
additional providers (a paid search API, a different engine, a cache layer)
can be plugged in later without touching the discovery orchestrator.
"""

from __future__ import annotations

import base64
import logging
from abc import ABC, abstractmethod
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from bs4 import BeautifulSoup

from app.config import settings
from app.models.schemas import SearchResult
from app.services.page_fetcher import get_http_client

logger = logging.getLogger(__name__)

_BROWSER_LIKE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


class SearchProvider(ABC):
    """Abstract interface for a web search backend."""

    @abstractmethod
    async def search(self, query: str, limit: int = 10) -> list[SearchResult]:
        """Return up to `limit` search results for `query`. Never raises on network errors."""
        raise NotImplementedError


class DuckDuckGoSearchProvider(SearchProvider):
    """Searches the web via DuckDuckGo's HTML endpoint (no API key required).

    This scrapes public, unauthenticated search result pages -- no login,
    paywall, or access-control bypass is involved.
    """

    SEARCH_URL = "https://html.duckduckgo.com/html/"

    async def search(self, query: str, limit: int = 10) -> list[SearchResult]:
        client = get_http_client()

        try:
            response = await client.post(
                self.SEARCH_URL,
                data={"q": query},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=settings.http_timeout,
            )
        except (httpx.TimeoutException, httpx.HTTPError) as exc:
            logger.info("Search request failed (%s)", type(exc).__name__)
            return []
        except Exception as exc:
            logger.info("Unexpected search error (%s)", type(exc).__name__)
            return []

        if response.status_code != 200:
            logger.info("Search provider returned status %s", response.status_code)
            return []

        try:
            soup = BeautifulSoup(response.text, "lxml")
        except Exception:
            return []

        results: list[SearchResult] = []
        for result_div in soup.select(".result"):
            link_tag = result_div.select_one("a.result__a")
            if not link_tag:
                continue

            resolved_url = self._unwrap_redirect(link_tag.get("href", ""))
            if not resolved_url:
                continue

            title = link_tag.get_text(strip=True)
            if not title:
                continue

            snippet_tag = result_div.select_one(".result__snippet")
            snippet = snippet_tag.get_text(strip=True) if snippet_tag else None

            results.append(SearchResult(title=title, url=resolved_url, snippet=snippet))
            if len(results) >= limit:
                break

        return results

    @staticmethod
    def _unwrap_redirect(href: str) -> str | None:
        """DuckDuckGo's HTML results link through /l/?uddg=<encoded target>."""
        if not href:
            return None

        if href.startswith("//"):
            href = "https:" + href

        try:
            parsed = urlparse(href)
        except ValueError:
            return None

        if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
            query_params = parse_qs(parsed.query)
            uddg = query_params.get("uddg")
            if uddg:
                return unquote(uddg[0])
            return None

        if parsed.scheme in ("http", "https"):
            return href

        return None


class BingSearchProvider(SearchProvider):
    """Searches the web via Bing's public HTML search results (no API key required)."""

    SEARCH_URL = "https://www.bing.com/search"

    async def search(self, query: str, limit: int = 10) -> list[SearchResult]:
        client = get_http_client()

        try:
            response = await client.get(
                self.SEARCH_URL,
                params={"q": query, "count": str(limit)},
                headers=_BROWSER_LIKE_HEADERS,
                timeout=settings.http_timeout,
            )
        except (httpx.TimeoutException, httpx.HTTPError) as exc:
            logger.info("Search request failed (%s)", type(exc).__name__)
            return []
        except Exception as exc:
            logger.info("Unexpected search error (%s)", type(exc).__name__)
            return []

        if response.status_code != 200:
            logger.info("Search provider returned status %s", response.status_code)
            return []

        try:
            soup = BeautifulSoup(response.text, "lxml")
        except Exception:
            return []

        results: list[SearchResult] = []
        for result_li in soup.select("li.b_algo"):
            heading = result_li.select_one("h2")
            link_tag = heading.select_one("a") if heading else None
            if not link_tag:
                continue

            resolved_url = self._unwrap_redirect(link_tag.get("href", ""))
            if not resolved_url:
                continue

            title = link_tag.get_text(strip=True)
            if not title:
                continue

            snippet_tag = result_li.select_one(".b_caption p") or result_li.select_one("p")
            snippet = snippet_tag.get_text(strip=True) if snippet_tag else None

            results.append(SearchResult(title=title, url=resolved_url, snippet=snippet))
            if len(results) >= limit:
                break

        return results

    @staticmethod
    def _unwrap_redirect(href: str) -> str | None:
        """Bing sometimes links through /ck/a?...&u=a1<base64url(target)> click tracking."""
        if not href:
            return None

        if href.startswith("//"):
            href = "https:" + href

        try:
            parsed = urlparse(href)
        except ValueError:
            return None

        if "bing.com" in parsed.netloc and parsed.path.startswith("/ck/a"):
            query_params = parse_qs(parsed.query)
            encoded = query_params.get("u")
            if not encoded:
                return None
            token = encoded[0]
            if token.startswith("a1"):
                token = token[2:]
            padded = token + "=" * (-len(token) % 4)
            try:
                decoded = base64.urlsafe_b64decode(padded).decode("utf-8")
            except Exception:
                return None
            decoded_parsed = urlparse(decoded)
            if decoded_parsed.scheme in ("http", "https"):
                return decoded
            return None

        if parsed.scheme in ("http", "https"):
            return href

        return None
