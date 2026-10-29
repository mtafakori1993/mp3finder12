"""Pydantic models shared across the discovery pipeline and the public API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class SearchResult(BaseModel):
    """A single result returned by a SearchProvider."""

    title: str
    url: str
    snippet: str | None = None


class PageContent(BaseModel):
    """The fetched contents of a candidate web page."""

    url: str
    html: str
    status_code: int
    content_type: str | None = None
    final_url: str


class AudioCandidate(BaseModel):
    """A candidate audio URL discovered on a source page, prior to validation."""

    url: str
    source_type: str
    source_page: str
    declared_mime_type: str | None = None
    page_title: str | None = None
    artist_guess: str | None = None
    cover_image: str | None = None


class AudioValidation(BaseModel):
    """The result of probing a candidate audio URL without downloading it fully."""

    playable: bool
    status_code: int | None = None
    content_type: str | None = None
    content_length: int | None = None
    range_supported: bool = False
    error: str | None = None


class DiscoveredTrack(BaseModel):
    """A ranked, validated track ready to be returned to the frontend."""

    title: str
    artist: str | None = None
    source_page: str
    audio_url: str
    mime_type: str | None = None
    duration: float | None = None
    confidence: float
    validation: AudioValidation


class SearchRequest(BaseModel):
    """The request body for POST /api/search."""

    query: str = Field(..., min_length=1, max_length=300)


class SearchResponse(BaseModel):
    """The response body for POST /api/search."""

    query: str
    results: list[DiscoveredTrack]
