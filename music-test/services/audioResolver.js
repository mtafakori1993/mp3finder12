import fetchPage from "./pageFetcher.js";
import extractAudioCandidates from "./audioExtractor.js";
import validateAudio from "./audioValidator.js";
import rankCandidates from "./rankingService.js";
import { resolveUrl, normalizeUrlForDedup, extensionMimeType } from "../utils/urlUtils.js";
import logger from "../utils/logger.js";

const MAX_AUDIO_CANDIDATES = Number(process.env.MAX_AUDIO_CANDIDATES || 20);
const MAX_CONCURRENT_VALIDATIONS = Number(process.env.MAX_CONCURRENT_VALIDATIONS || 5);
const MAX_CANDIDATES_IN_RESPONSE = 5;

function emptyResolverResult() {
  return {
    audio_url: null,
    mime_type: null,
    playable: false,
    confidence: 0,
    candidates: []
  };
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function resolveAndDedupeCandidates(rawCandidates, baseUrl, sourcePageUrl) {
  const byUrl = new Map();

  for (const raw of rawCandidates) {
    const resolved = resolveUrl(raw.url, baseUrl);
    if (!resolved) continue;

    const key = normalizeUrlForDedup(resolved);
    const existing = byUrl.get(key);

    const candidate = {
      url: resolved,
      sourcePage: sourcePageUrl,
      sourceType: raw.sourceType,
      declaredMimeType: raw.declaredMimeType || extensionMimeType(resolved),
      extractionConfidence: raw.extractionConfidence,
      validation: null,
      score: 0
    };

    if (!existing || raw.extractionConfidence > existing.extractionConfidence) {
      byUrl.set(key, candidate);
    }
  }

  return Array.from(byUrl.values());
}

function toResponseCandidate(candidate) {
  return {
    url: candidate.url,
    sourceType: candidate.sourceType,
    declaredMimeType: candidate.declaredMimeType,
    score: candidate.score,
    confidence: candidate.confidence,
    playable: candidate.validation ? candidate.validation.playable : null
  };
}

/**
 * Full pipeline: fetch a source page, extract candidate audio URLs, resolve
 * and dedupe them, validate a bounded set concurrently, rank deterministically,
 * and return the best playable result. Never throws.
 */
export async function resolveAudioFromPage(sourcePageUrl) {
  try {
    logger.resolver("Fetching:", sourcePageUrl);

    const page = await fetchPage(sourcePageUrl);

    if (!page.success) {
      logger.resolver("Fetch failed:", page.error);
      return emptyResolverResult();
    }

    const rawCandidates = extractAudioCandidates(page.html);

    if (rawCandidates.length === 0) {
      logger.resolver("No candidates extracted from", sourcePageUrl);
      return emptyResolverResult();
    }

    const deduped = resolveAndDedupeCandidates(rawCandidates, page.finalUrl, sourcePageUrl);

    logger.extractor(
      `Resolved ${deduped.length} unique candidates from ${rawCandidates.length} raw matches`
    );

    if (deduped.length === 0) {
      return emptyResolverResult();
    }

    // Prioritize higher-confidence extractions before truncating, so the
    // candidate limit doesn't discard the most promising URLs.
    const limited = deduped
      .sort((a, b) => b.extractionConfidence - a.extractionConfidence)
      .slice(0, MAX_AUDIO_CANDIDATES);

    const validated = await mapWithConcurrency(limited, MAX_CONCURRENT_VALIDATIONS, async (candidate) => {
      const validation = await validateAudio(candidate.url);
      return { ...candidate, validation };
    });

    const ranked = rankCandidates(validated);

    const best = ranked.find((c) => c.validation && c.validation.playable);

    const responseCandidates = ranked.slice(0, MAX_CANDIDATES_IN_RESPONSE).map(toResponseCandidate);

    if (!best) {
      logger.resolver("No playable candidate found for", sourcePageUrl);
      return { ...emptyResolverResult(), candidates: responseCandidates };
    }

    logger.resolver("Final playable URL found:", best.url);

    return {
      audio_url: best.url,
      mime_type: best.validation.contentType || best.declaredMimeType || null,
      playable: true,
      confidence: best.confidence,
      candidates: responseCandidates
    };
  } catch (error) {
    logger.error("RESOLVER", sourcePageUrl, error.message);
    return emptyResolverResult();
  }
}

export default resolveAudioFromPage;
