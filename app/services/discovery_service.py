"""Main orchestrator: query -> search -> fetch -> extract -> validate -> rank."""

from __future__ import annotations

import asyncio
import logging

from app.config import settings
from app.models.schemas import AudioCandidate, AudioValidation, DiscoveredTrack, PageContent
from app.services.audio_extractor import extract_audio_candidates, extract_metadata
from app.services.audio_validator import validate_audio
from app.services.page_fetcher import fetch_page
from app.services.ranking_service import normalize_confidence, score_candidate
from app.services.search_service import BingSearchProvider, SearchProvider
from app.utils.url_utils import generate_search_queries, normalize_query, normalize_url_for_dedup

logger = logging.getLogger(__name__)


class MusicDiscoveryService:
    """Coordinates the full discovery pipeline for a single user query."""

    def __init__(self, search_provider: SearchProvider | None = None) -> None:
        self._search_provider = search_provider or BingSearchProvider()
        self._page_semaphore = asyncio.Semaphore(settings.max_concurrent_page_fetches)
        self._validation_semaphore = asyncio.Semaphore(settings.max_concurrent_audio_validations)

    async def discover(self, query: str) -> list[DiscoveredTrack]:
        normalized = normalize_query(query)
        if not normalized:
            return []

        search_queries = generate_search_queries(query, max_queries=settings.max_search_queries)
        if not search_queries:
            return []

        candidate_urls = await self._collect_candidate_pages(search_queries)
        if not candidate_urls:
            return []

        candidate_urls = candidate_urls[: settings.max_inspected_pages]

        pages = await self._fetch_pages_concurrently(candidate_urls)
        if not pages:
            return []

        audio_candidates = self._extract_all_candidates(pages)
        audio_candidates = self._deduplicate_candidates(audio_candidates)
        audio_candidates = audio_candidates[: settings.max_audio_candidates]

        if not audio_candidates:
            return []

        tracks = await self._validate_and_rank(query, audio_candidates)
        return tracks[: settings.max_returned_results]

    async def _collect_candidate_pages(self, search_queries: list[str]) -> list[str]:
        """Run all search query variants concurrently and deduplicate resulting URLs."""
        search_tasks = [
            self._search_provider.search(q, limit=settings.max_search_results_per_query) for q in search_queries
        ]
        results_per_query = await asyncio.gather(*search_tasks, return_exceptions=True)

        seen_urls: set[str] = set()
        ordered_urls: list[str] = []

        for results in results_per_query:
            if isinstance(results, BaseException):
                logger.info("Search query failed (%s)", type(results).__name__)
                continue
            for result in results:
                dedup_key = normalize_url_for_dedup(result.url)
                if dedup_key in seen_urls:
                    continue
                seen_urls.add(dedup_key)
                ordered_urls.append(result.url)

        return ordered_urls

    async def _fetch_one_page(self, url: str) -> PageContent | None:
        async with self._page_semaphore:
            return await fetch_page(url)

    async def _fetch_pages_concurrently(self, urls: list[str]) -> list[PageContent]:
        results = await asyncio.gather(
            *(self._fetch_one_page(url) for url in urls),
            return_exceptions=True,
        )

        pages: list[PageContent] = []
        for result in results:
            if isinstance(result, BaseException):
                logger.info("Page fetch failed (%s)", type(result).__name__)
                continue
            if result is not None:
                pages.append(result)
        return pages

    def _extract_all_candidates(self, pages: list[PageContent]) -> list[AudioCandidate]:
        all_candidates: list[AudioCandidate] = []

        for page in pages:
            try:
                title, artist, cover_image = extract_metadata(page)
                candidates = extract_audio_candidates(page)
            except Exception as exc:
                logger.info("Extraction failed for a page (%s)", type(exc).__name__)
                continue

            for candidate in candidates:
                candidate.page_title = title
                candidate.artist_guess = artist
                candidate.cover_image = cover_image

            all_candidates.extend(candidates)

        return all_candidates

    def _deduplicate_candidates(self, candidates: list[AudioCandidate]) -> list[AudioCandidate]:
        seen: set[str] = set()
        deduped: list[AudioCandidate] = []
        for candidate in candidates:
            key = normalize_url_for_dedup(candidate.url)
            if key in seen:
                continue
            seen.add(key)
            deduped.append(candidate)
        return deduped

    async def _validate_one(self, candidate: AudioCandidate) -> tuple[AudioCandidate, AudioValidation]:
        async with self._validation_semaphore:
            validation = await validate_audio(candidate.url)
            return candidate, validation

    async def _validate_and_rank(
        self,
        original_query: str,
        candidates: list[AudioCandidate],
    ) -> list[DiscoveredTrack]:
        results = await asyncio.gather(
            *(self._validate_one(candidate) for candidate in candidates),
            return_exceptions=True,
        )

        scored: list[tuple[float, DiscoveredTrack]] = []
        seen_final_keys: set[str] = set()

        for result in results:
            if isinstance(result, BaseException):
                logger.info("Validation failed (%s)", type(result).__name__)
                continue

            candidate, validation = result
            if not validation.playable:
                continue

            dedup_key = normalize_url_for_dedup(candidate.url)
            if dedup_key in seen_final_keys:
                continue
            seen_final_keys.add(dedup_key)

            raw_score = score_candidate(
                query=original_query,
                page_title=candidate.page_title,
                candidate=candidate,
                validation=validation,
            )
            confidence = normalize_confidence(raw_score)

            track = DiscoveredTrack(
                title=candidate.page_title or "Unknown title",
                artist=candidate.artist_guess,
                source_page=candidate.source_page,
                audio_url=candidate.url,
                mime_type=validation.content_type or candidate.declared_mime_type,
                duration=None,
                confidence=confidence,
                validation=validation,
            )
            scored.append((raw_score, track))

        scored.sort(key=lambda item: item[0], reverse=True)
        return [track for _, track in scored]
