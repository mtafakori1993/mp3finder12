"""Extracts candidate audio URLs and basic metadata from a fetched page.

Implements several independent extractors (HTML5 audio/source tags, direct
anchor links, embedded JSON, JSON-LD, and a conservative regex fallback) and
combines their results. No JavaScript is executed; everything is static
markup and text inspection.
"""

from __future__ import annotations

import json
import logging
import re

from bs4 import BeautifulSoup, Tag

from app.models.schemas import AudioCandidate, PageContent
from app.utils.url_utils import guess_mime_type, has_audio_extension, resolve_url

logger = logging.getLogger(__name__)

# Absolute URLs ending in a known audio extension, optionally with a query string.
_AUDIO_URL_PATTERN = re.compile(
    r"https?://[^\s\"'<>]+?\.(?:mp3|m4a|aac|ogg|wav)(?:\?[^\s\"'<>]*)?",
    re.IGNORECASE,
)

# Keys commonly used to hold an audio/stream URL in embedded JSON blobs.
_AUDIO_JSON_KEYS = {
    "audio",
    "audiourl",
    "audio_url",
    "stream",
    "streamurl",
    "stream_url",
    "file",
    "fileurl",
    "file_url",
    "mp3",
    "src",
    "contenturl",
    "content_url",
}

_MAX_SCRIPT_LENGTH = 500_000


def _extract_html5_audio(soup: BeautifulSoup, base_url: str) -> list[AudioCandidate]:
    """Extractor A: <audio src="..."> and <audio><source src="..."></audio>."""
    candidates: list[AudioCandidate] = []

    for audio_tag in soup.find_all("audio"):
        src = audio_tag.get("src")
        resolved = resolve_url(base_url, src)
        if resolved:
            candidates.append(
                AudioCandidate(
                    url=resolved,
                    source_type="html_audio",
                    source_page=base_url,
                    declared_mime_type=audio_tag.get("type") or guess_mime_type(resolved),
                )
            )

        for source_tag in audio_tag.find_all("source"):
            s_src = source_tag.get("src")
            resolved = resolve_url(base_url, s_src)
            if resolved:
                candidates.append(
                    AudioCandidate(
                        url=resolved,
                        source_type="html_audio",
                        source_page=base_url,
                        declared_mime_type=source_tag.get("type") or guess_mime_type(resolved),
                    )
                )

    return candidates


def _extract_source_tags(soup: BeautifulSoup, base_url: str) -> list[AudioCandidate]:
    """Extractor B: standalone <source> tags with an audio MIME type, prioritized by type."""
    candidates: list[AudioCandidate] = []

    for source_tag in soup.find_all("source"):
        parent = source_tag.parent
        if isinstance(parent, Tag) and parent.name == "audio":
            continue  # already handled by the html5 audio extractor

        mime = source_tag.get("type", "") or ""
        src = source_tag.get("src")
        if not src:
            continue

        if mime.lower().startswith("audio/") or has_audio_extension(src):
            resolved = resolve_url(base_url, src)
            if resolved:
                candidates.append(
                    AudioCandidate(
                        url=resolved,
                        source_type="source_tag",
                        source_page=base_url,
                        declared_mime_type=mime or guess_mime_type(resolved),
                    )
                )

    return candidates


def _extract_direct_links(soup: BeautifulSoup, base_url: str) -> list[AudioCandidate]:
    """Extractor C: anchor tags pointing directly at an audio file."""
    candidates: list[AudioCandidate] = []

    for a_tag in soup.find_all("a", href=True):
        href = a_tag["href"]
        if has_audio_extension(href):
            resolved = resolve_url(base_url, href)
            if resolved:
                candidates.append(
                    AudioCandidate(
                        url=resolved,
                        source_type="direct_link",
                        source_page=base_url,
                        declared_mime_type=guess_mime_type(resolved),
                    )
                )

    return candidates


def _find_audio_in_json(obj: object, found: list[str], depth: int = 0) -> None:
    """Recursively walk a parsed JSON structure collecting likely audio URLs."""
    if depth > 8:
        return

    if isinstance(obj, dict):
        for key, value in obj.items():
            key_lower = str(key).lower()
            if isinstance(value, str):
                if key_lower in _AUDIO_JSON_KEYS or has_audio_extension(value):
                    found.append(value)
            else:
                _find_audio_in_json(value, found, depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            _find_audio_in_json(item, found, depth + 1)


_JSON_KEY_VALUE_PATTERN = re.compile(
    r"[\"'](?:" + "|".join(re.escape(k) for k in _AUDIO_JSON_KEYS) + r")[\"']\s*:\s*[\"']([^\"']+)[\"']",
    re.IGNORECASE,
)


def _extract_embedded_json(soup: BeautifulSoup, base_url: str) -> list[AudioCandidate]:
    """Extractor D: inspects <script> tags for JSON objects carrying audio URLs.

    Tries a strict json.loads first; falls back to a targeted key/value regex
    for the common case of embedded (not strictly valid JSON) JS objects.
    Never executes script content.
    """
    candidates: list[AudioCandidate] = []

    for script_tag in soup.find_all("script"):
        script_type = (script_tag.get("type") or "").lower()
        if script_type == "application/ld+json":
            continue  # handled separately by the JSON-LD extractor

        text = script_tag.string or script_tag.get_text() or ""
        if not text or len(text) > _MAX_SCRIPT_LENGTH:
            continue

        found_urls: list[str] = []
        try:
            data = json.loads(text)
            _find_audio_in_json(data, found_urls)
        except (json.JSONDecodeError, ValueError):
            found_urls.extend(_JSON_KEY_VALUE_PATTERN.findall(text))

        for raw_url in found_urls:
            resolved = resolve_url(base_url, raw_url)
            if not resolved:
                continue
            if has_audio_extension(resolved) or "audio" in resolved.lower() or "stream" in resolved.lower():
                candidates.append(
                    AudioCandidate(
                        url=resolved,
                        source_type="embedded_json",
                        source_page=base_url,
                        declared_mime_type=guess_mime_type(resolved),
                    )
                )

    return candidates


def _extract_json_ld(soup: BeautifulSoup, base_url: str) -> list[AudioCandidate]:
    """Extractor E: <script type="application/ld+json"> structured data."""
    candidates: list[AudioCandidate] = []

    for script_tag in soup.find_all("script", type="application/ld+json"):
        text = script_tag.string or script_tag.get_text() or ""
        if not text:
            continue

        try:
            data = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            continue

        found_urls: list[str] = []
        _find_audio_in_json(data, found_urls)

        for raw_url in found_urls:
            resolved = resolve_url(base_url, raw_url)
            if resolved:
                candidates.append(
                    AudioCandidate(
                        url=resolved,
                        source_type="json_ld",
                        source_page=base_url,
                        declared_mime_type=guess_mime_type(resolved),
                    )
                )

    return candidates


def _extract_regex_fallback(html: str, base_url: str) -> list[AudioCandidate]:
    """Extractor F: last-resort scan for absolute audio URLs anywhere in the HTML."""
    candidates: list[AudioCandidate] = []

    for match in _AUDIO_URL_PATTERN.finditer(html):
        url = match.group(0)
        candidates.append(
            AudioCandidate(
                url=url,
                source_type="regex_fallback",
                source_page=base_url,
                declared_mime_type=guess_mime_type(url),
            )
        )

    return candidates


def extract_audio_candidates(page: PageContent) -> list[AudioCandidate]:
    """Run all extractors against a page and return the combined candidates.

    The regex fallback only runs if no structured extractor found anything,
    to avoid overly aggressive matching on pages with many unrelated links.
    """
    try:
        soup = BeautifulSoup(page.html, "lxml")
    except Exception:
        logger.info("Failed to parse HTML for a page")
        return []

    candidates: list[AudioCandidate] = []
    candidates.extend(_extract_html5_audio(soup, page.final_url))
    candidates.extend(_extract_source_tags(soup, page.final_url))
    candidates.extend(_extract_direct_links(soup, page.final_url))
    candidates.extend(_extract_embedded_json(soup, page.final_url))
    candidates.extend(_extract_json_ld(soup, page.final_url))

    if not candidates:
        candidates.extend(_extract_regex_fallback(page.html, page.final_url))

    return candidates


def extract_metadata(page: PageContent) -> tuple[str | None, str | None, str | None]:
    """Best-effort extraction of (title, artist, cover_image) from a page.

    Artist detection is heuristic: if the title looks like "Artist - Title"
    (a very common pattern on music sites), it is split accordingly.
    """
    try:
        soup = BeautifulSoup(page.html, "lxml")
    except Exception:
        return None, None, None

    title: str | None = None
    og_title = soup.find("meta", attrs={"property": "og:title"})
    if isinstance(og_title, Tag) and og_title.get("content"):
        title = str(og_title["content"]).strip()
    elif soup.title and soup.title.string:
        title = soup.title.string.strip()

    artist: str | None = None
    if title:
        for separator in (" - ", " – ", " | "):
            if separator in title:
                parts = title.split(separator, 1)
                if len(parts) == 2 and parts[0].strip() and parts[1].strip():
                    artist = parts[0].strip()
                    title = parts[1].strip()
                break

    cover_image: str | None = None
    og_image = soup.find("meta", attrs={"property": "og:image"})
    if isinstance(og_image, Tag) and og_image.get("content"):
        cover_image = resolve_url(page.final_url, str(og_image["content"]))

    return title, artist, cover_image
