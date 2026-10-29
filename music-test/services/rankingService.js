import logger from "../utils/logger.js";

const SOURCE_TYPE_BASE_SCORE = {
  html_audio: 30,
  source_tag: 30,
  wordpress_player: 25,
  embedded_json: 20,
  data_attribute: 15,
  direct_link: 15,
  inline_script: 10,
  regex_fallback: 5
};

const KNOWN_AUDIO_MIME_PATTERN = /^audio\//i;

// Deliberately generous upper bound so normalized confidence rarely hits 1.0
// unless a candidate scores well across every signal.
const MAX_EXPECTED_SCORE = 140;

function extractionScore(candidate) {
  let score = SOURCE_TYPE_BASE_SCORE[candidate.sourceType] ?? 5;

  if (candidate.sourceType === "source_tag") {
    const mime = (candidate.declaredMimeType || "").toLowerCase();
    if (!KNOWN_AUDIO_MIME_PATTERN.test(mime)) {
      score -= 10; // source tag present but MIME wasn't a recognized audio type
    }
  }

  return score;
}

function validationScore(candidate) {
  const validation = candidate.validation;
  if (!validation) return 0;

  let score = 0;

  if (validation.error === "HTML returned instead of audio") {
    return -100;
  }

  if (!validation.playable) {
    return -100;
  }

  score += 40; // successful validation

  const contentType = (validation.contentType || "").split(";")[0].trim().toLowerCase();
  const isConfidentMime = KNOWN_AUDIO_MIME_PATTERN.test(contentType) && contentType !== "audio/octet-stream";

  if (isConfidentMime) {
    score += 30;
  }

  if (validation.rangeSupported) {
    score += 10;
  }

  if (validation.signature) {
    score += 25;
  }

  if (validation.error === "Suspicious tiny response") {
    score -= 30;
  }

  return score;
}

function httpsBonus(url) {
  try {
    return new URL(url).protocol === "https:" ? 5 : 0;
  } catch {
    return 0;
  }
}

/**
 * Deterministically scores a single candidate. Mutates nothing - returns a
 * new object with score/confidence attached.
 */
export function scoreCandidate(candidate) {
  const score = extractionScore(candidate) + validationScore(candidate) + httpsBonus(candidate.url);
  const confidence = Math.max(0, Math.min(1, score / MAX_EXPECTED_SCORE));

  return {
    ...candidate,
    score,
    confidence: Number(confidence.toFixed(3))
  };
}

/**
 * Scores and sorts candidates best-first. Deterministic, no LLM involved.
 */
export function rankCandidates(candidates) {
  const scored = candidates.map(scoreCandidate);
  scored.sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    logger.ranking(`Best candidate score=${scored[0].score} url=${scored[0].url}`);
  }

  return scored;
}

export default rankCandidates;
