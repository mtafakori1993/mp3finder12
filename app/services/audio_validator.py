"""Validates that a candidate URL actually serves playable audio.

Uses a HEAD request first, falling back to a small ranged GET (0-2048 bytes)
when HEAD is unsupported or inconclusive. The full media file is never
downloaded.
"""

from __future__ import annotations

import logging

import httpx

from app.config import settings
from app.models.schemas import AudioValidation
from app.services.page_fetcher import get_http_client
from app.utils.url_utils import has_audio_extension, is_url_safe_async

logger = logging.getLogger(__name__)

_LIKELY_AUDIO_MIME_TYPES = {
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/webm",
    "audio/flac",
    "audio/x-m4a",
}


def _looks_like_audio(content_type: str | None, url: str) -> bool:
    if not content_type:
        return False
    mime = content_type.split(";", 1)[0].strip().lower()
    if mime in _LIKELY_AUDIO_MIME_TYPES:
        return True
    # Generic binary type is only accepted when the URL extension strongly
    # suggests audio -- final scoring still weighs this candidate lower.
    if mime == "application/octet-stream" and has_audio_extension(url):
        return True
    return False


def _parse_content_length(value: str | None) -> int | None:
    if value and value.isdigit():
        return int(value)
    return None


async def _try_head(client: httpx.AsyncClient, url: str) -> AudioValidation | None:
    """Attempt validation via HEAD. Returns None if inconclusive (caller should fall back to GET)."""
    try:
        response = await client.head(url, timeout=settings.http_timeout)
    except (httpx.TimeoutException, httpx.HTTPError):
        return None
    except Exception as exc:
        logger.info("HEAD request error (%s)", type(exc).__name__)
        return None

    if response.status_code not in (200, 206):
        return None

    content_type = response.headers.get("content-type")
    if not _looks_like_audio(content_type, url):
        return None

    accept_ranges = (response.headers.get("accept-ranges") or "").lower()
    return AudioValidation(
        playable=True,
        status_code=response.status_code,
        content_type=content_type,
        content_length=_parse_content_length(response.headers.get("content-length")),
        range_supported=accept_ranges == "bytes",
        error=None,
    )


async def _try_range_get(client: httpx.AsyncClient, url: str) -> AudioValidation:
    """Fallback validation: request only the first ~2KB via a Range header."""
    try:
        async with client.stream(
            "GET",
            url,
            headers={"Range": "bytes=0-2048"},
            timeout=settings.http_timeout,
        ) as response:
            content_type = response.headers.get("content-type")
            content_range = response.headers.get("content-range")
            accept_ranges = (response.headers.get("accept-ranges") or "").lower()
            status_code = response.status_code

            range_supported = status_code == 206 or bool(content_range) or accept_ranges == "bytes"

            content_length: int | None = None
            if content_range and "/" in content_range:
                total = content_range.rsplit("/", 1)[-1]
                if total.isdigit():
                    content_length = int(total)
            else:
                content_length = _parse_content_length(response.headers.get("content-length"))

            playable = status_code in (200, 206) and _looks_like_audio(content_type, url)

            return AudioValidation(
                playable=playable,
                status_code=status_code,
                content_type=content_type,
                content_length=content_length,
                range_supported=range_supported,
                error=None if playable else "Response did not look like playable audio",
            )
    except (httpx.TimeoutException, httpx.HTTPError) as exc:
        return AudioValidation(
            playable=False,
            status_code=None,
            content_type=None,
            content_length=None,
            range_supported=False,
            error=f"Request failed: {type(exc).__name__}",
        )
    except Exception as exc:
        logger.info("Range GET validation error (%s)", type(exc).__name__)
        return AudioValidation(
            playable=False,
            status_code=None,
            content_type=None,
            content_length=None,
            range_supported=False,
            error="Validation failed",
        )


async def validate_audio(url: str) -> AudioValidation:
    """Validate a candidate audio URL without downloading the full file."""
    if not await is_url_safe_async(url):
        return AudioValidation(
            playable=False,
            status_code=None,
            content_type=None,
            content_length=None,
            range_supported=False,
            error="URL not permitted",
        )

    client = get_http_client()

    head_result = await _try_head(client, url)
    if head_result is not None:
        return head_result

    return await _try_range_get(client, url)
