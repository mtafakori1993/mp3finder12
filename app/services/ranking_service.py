"""Scores and ranks validated audio candidates into a final confidence value."""

from __future__ import annotations

from app.models.schemas import AudioCandidate, AudioValidation
from app.utils.url_utils import normalize_query

_MIN_SCORE = -100.0
_MAX_SCORE = 100.0

_SOURCE_TYPE_SCORES = {
    "html_audio": 20.0,
    "source_tag": 15.0,
    "json_ld": 12.0,
    "embedded_json": 10.0,
    "direct_link": 8.0,
    "regex_fallback": 2.0,
}


def score_candidate(
    *,
    query: str,
    page_title: str | None,
    candidate: AudioCandidate,
    validation: AudioValidation,
) -> float:
    """Compute a raw score for a candidate, combining relevance and validation signals."""
    score = 0.0

    normalized_query = normalize_query(query)
    query_tokens = [tok for tok in normalized_query.split(" ") if tok]

    title_text = (page_title or "").lower()
    url_text = candidate.url.lower()

    if normalized_query and normalized_query in title_text:
        score += 30.0
    elif query_tokens and any(tok in title_text for tok in query_tokens):
        score += 15.0

    if query_tokens and any(tok in url_text for tok in query_tokens):
        score += 10.0

    score += _SOURCE_TYPE_SCORES.get(candidate.source_type, 0.0)

    if validation.playable:
        score += 25.0
        if validation.range_supported:
            score += 10.0
    else:
        score -= 100.0

    if validation.content_type and "html" in validation.content_type.lower():
        score -= 80.0

    if candidate.url.lower().startswith("https://"):
        score += 5.0

    if validation.content_length is not None and validation.content_length < 2048:
        score -= 30.0

    return score


def normalize_confidence(score: float) -> float:
    """Map a raw score onto a 0-1 confidence value."""
    clamped = max(_MIN_SCORE, min(_MAX_SCORE, score))
    normalized = (clamped - _MIN_SCORE) / (_MAX_SCORE - _MIN_SCORE)
    return round(normalized, 4)
