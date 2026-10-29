"""URL, query normalization, and SSRF-safety helpers used across the discovery pipeline."""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import unicodedata
from urllib.parse import urljoin, urlparse

# --------------------------------------------------------------------------
# Query normalization
# --------------------------------------------------------------------------

# Arabic-script variants that are commonly typed instead of their Persian
# equivalents (e.g. keyboards defaulting to Arabic presentation forms).
_ARABIC_TO_PERSIAN = {
    "ي": "ی",  # ي -> ی
    "ك": "ک",  # ك -> ک
    "ة": "ه",  # ة -> ه
    "ۀ": "ه",  # ۀ -> ه
    "أ": "ا",  # أ -> ا
    "إ": "ا",  # إ -> ا
    "ؤ": "و",  # ؤ -> و
    "ئ": "ی",  # ئ -> ی
}

# Arabic/Persian diacritics (tashkeel) that add no search value.
_DIACRITICS_PATTERN = re.compile(r"[ً-ٰٟۖ-ۭ]")

# Quote-like punctuation that should be stripped rather than searched literally.
_PUNCTUATION_PATTERN = re.compile(r"[\"'`«»“”‘’]+")

_WHITESPACE_PATTERN = re.compile(r"\s+")

# Persian/Arabic Unicode block, used to decide which search templates to use.
_PERSIAN_RANGE_PATTERN = re.compile(r"[؀-ۿ]")


def normalize_query(query: str) -> str:
    """Normalize a user query for search and matching purposes.

    Handles Unicode normalization, Arabic->Persian letter variants, diacritics,
    stray punctuation, and collapses whitespace. The original query as typed
    by the user should be kept separately for display purposes.
    """
    if not query:
        return ""

    text = unicodedata.normalize("NFKC", query)

    for arabic_char, persian_char in _ARABIC_TO_PERSIAN.items():
        text = text.replace(arabic_char, persian_char)

    text = _DIACRITICS_PATTERN.sub("", text)
    text = _PUNCTUATION_PATTERN.sub("", text)
    text = _WHITESPACE_PATTERN.sub(" ", text)
    text = text.strip()
    text = text.lower()

    return text


def generate_search_queries(query: str, max_queries: int = 4) -> list[str]:
    """Generate a small set of diversified search-engine queries for a track query.

    Wraps the normalized query in quotes for an exact-phrase search (this also
    covers lyric fragments) and adds a few genre/format hints so both Persian
    and non-Persian queries surface music-oriented pages.
    """
    normalized = normalize_query(query)
    if not normalized:
        return []

    is_persian = bool(_PERSIAN_RANGE_PATTERN.search(normalized))

    if is_persian:
        templates = [
            f'"{normalized}" آهنگ',
            f'"{normalized}" موسیقی mp3',
            f'"{normalized}" دانلود آهنگ',
            f'"{normalized}"',
        ]
    else:
        templates = [
            f'"{normalized}" audio',
            f'"{normalized}" mp3',
            f'"{normalized}" song',
            f'"{normalized}"',
        ]

    queries: list[str] = []
    for template in templates:
        if template not in queries:
            queries.append(template)
        if len(queries) >= max_queries:
            break

    return queries


# --------------------------------------------------------------------------
# URL resolution & audio extension helpers
# --------------------------------------------------------------------------

AUDIO_EXTENSIONS: tuple[str, ...] = (".mp3", ".m4a", ".aac", ".ogg", ".wav")

_EXTENSION_TO_MIME = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
}


def has_audio_extension(url: str) -> bool:
    """Return True if the URL path ends with a recognized audio file extension."""
    try:
        path = urlparse(url).path.lower()
    except ValueError:
        return False
    return path.endswith(AUDIO_EXTENSIONS)


def guess_mime_type(url: str) -> str | None:
    """Guess a MIME type from a URL's file extension, if recognizable."""
    try:
        path = urlparse(url).path.lower()
    except ValueError:
        return None
    for ext, mime in _EXTENSION_TO_MIME.items():
        if path.endswith(ext):
            return mime
    return None


def resolve_url(base_url: str, maybe_relative: str | None) -> str | None:
    """Resolve a possibly-relative URL against a base page URL.

    Returns None if the value is empty, unparsable, or resolves to a
    non-http(s) scheme (e.g. javascript:, data:, mailto:).
    """
    if not maybe_relative:
        return None

    candidate = maybe_relative.strip()
    if not candidate or candidate.startswith(("javascript:", "data:", "mailto:", "#")):
        return None

    try:
        resolved = urljoin(base_url, candidate)
    except ValueError:
        return None

    try:
        parsed = urlparse(resolved)
    except ValueError:
        return None

    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None

    return resolved


def normalize_url_for_dedup(url: str) -> str:
    """Produce a canonical key for deduplicating URLs pointing at the same resource."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return url

    scheme = "https" if parsed.scheme in ("http", "https") else parsed.scheme
    netloc = parsed.netloc.lower()
    if netloc.startswith("www."):
        netloc = netloc[4:]
    path = parsed.path.rstrip("/") or "/"
    return f"{scheme}://{netloc}{path}"


def get_domain(url: str) -> str:
    """Return the network location (host[:port]) of a URL."""
    try:
        return urlparse(url).netloc
    except ValueError:
        return ""


# --------------------------------------------------------------------------
# SSRF protection
# --------------------------------------------------------------------------

_BLOCKED_HOSTNAMES = {"localhost", "localhost.localdomain"}

# Cloud metadata endpoints that must never be reachable from this service.
_BLOCKED_LITERAL_HOSTS = {
    "169.254.169.254",
    "metadata.google.internal",
    "metadata",
}

_PRIVATE_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),  # carrier-grade NAT
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),  # link-local, includes cloud metadata
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("::ffff:0:0/96"),
    ipaddress.ip_network("fc00::/7"),  # unique local
    ipaddress.ip_network("fe80::/10"),  # link-local
]


def _is_ip_blocked(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True

    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return True

    return any(ip in network for network in _PRIVATE_NETWORKS)


def is_safe_url(url: str) -> bool:
    """Synchronously check whether a URL is safe to fetch (basic SSRF protection).

    Rejects non-http(s) schemes, localhost/loopback, private/link-local/
    reserved IP ranges, and known cloud metadata hosts. Resolves hostnames to
    IP addresses and validates every resolved address.
    """
    try:
        parsed = urlparse(url)
    except ValueError:
        return False

    if parsed.scheme not in ("http", "https"):
        return False

    hostname = parsed.hostname
    if not hostname:
        return False

    hostname_lower = hostname.lower()
    if hostname_lower in _BLOCKED_HOSTNAMES or hostname_lower in _BLOCKED_LITERAL_HOSTS:
        return False

    # Literal IP address in the URL itself.
    try:
        ip = ipaddress.ip_address(hostname)
        return not _is_ip_blocked(str(ip))
    except ValueError:
        pass

    # Resolve the hostname and validate every returned address, to guard
    # against DNS names that point at internal infrastructure.
    try:
        addrinfo = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return False

    if not addrinfo:
        return False

    for info in addrinfo:
        sockaddr = info[4]
        if not sockaddr:
            return False
        ip_str = sockaddr[0]
        if _is_ip_blocked(ip_str):
            return False

    return True


async def is_url_safe_async(url: str) -> bool:
    """Async wrapper around is_safe_url that avoids blocking the event loop on DNS lookups."""
    return await asyncio.to_thread(is_safe_url, url)
