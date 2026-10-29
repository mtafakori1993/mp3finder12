"""Shared async HTTP client and page-fetching helper.

A single httpx.AsyncClient is reused across the app to benefit from
connection pooling. Every fetch is guarded by SSRF-safety checks on both
the requested URL and the final URL after redirects.
"""

from __future__ import annotations

import logging
import os

import httpx

from app.config import settings
from app.models.schemas import PageContent
from app.utils.url_utils import is_url_safe_async

logger = logging.getLogger(__name__)

_client: httpx.AsyncClient | None = None

_PROXY_ENV_VARS = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")


def _resolve_proxy_url() -> str | None:
    """Read a proxy URL from the environment, tolerating the common bare "socks://" form.

    httpx only recognizes "http", "https", "socks5", and "socks5h" proxy
    schemes, but many shells/tools export SOCKS proxies as "socks://" (e.g.
    ALL_PROXY=socks://127.0.0.1:1080). We normalize that here instead of
    letting httpx raise on client construction.
    """
    for var in _PROXY_ENV_VARS:
        value = os.environ.get(var)
        if not value:
            continue
        if value.startswith("socks://"):
            value = "socks5://" + value[len("socks://") :]
        return value
    return None


def get_http_client() -> httpx.AsyncClient:
    """Return the shared AsyncClient, creating it on first use."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.http_timeout),
            follow_redirects=True,
            headers={"User-Agent": settings.user_agent},
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            proxy=_resolve_proxy_url(),
            trust_env=False,
        )
    return _client


async def close_http_client() -> None:
    """Close the shared AsyncClient. Call on application shutdown."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def fetch_page(url: str) -> PageContent | None:
    """Fetch a URL and return its HTML content, or None if it can't be used.

    Returns None (rather than raising) for unsafe URLs, network errors, or
    non-HTML responses, so that a single bad page never fails the whole
    discovery pipeline.
    """
    if not await is_url_safe_async(url):
        logger.info("Skipping unsafe or disallowed URL")
        return None

    client = get_http_client()

    try:
        response = await client.get(url)
    except (httpx.TimeoutException, httpx.HTTPError) as exc:
        logger.info("Failed to fetch page (%s)", type(exc).__name__)
        return None
    except Exception as exc:  # defensive: never let one bad page crash discovery
        logger.info("Unexpected error fetching page (%s)", type(exc).__name__)
        return None

    content_type = response.headers.get("content-type", "")
    if "html" not in content_type.lower():
        return None

    final_url = str(response.url)
    if final_url != url and not await is_url_safe_async(final_url):
        logger.info("Redirect target failed SSRF safety check")
        return None

    try:
        html = response.text
    except Exception:
        return None

    return PageContent(
        url=url,
        html=html,
        status_code=response.status_code,
        content_type=content_type,
        final_url=final_url,
    )
