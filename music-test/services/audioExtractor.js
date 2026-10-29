import * as cheerio from "cheerio";
import { looksLikeAudioUrl, unescapeUrl } from "../utils/urlUtils.js";
import logger from "../utils/logger.js";

const AUDIO_MIME_PRIORITY = [
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac"
];

const DATA_ATTR_KEYS = [
  "data-src",
  "data-url",
  "data-audio",
  "data-file",
  "data-mp3",
  "data-stream",
  "data-audio-url",
  "data-music"
];

const JS_KEY_PATTERN =
  /(?:audio_url|audioUrl|stream_url|streamUrl|file_url|fileUrl|audio|stream|file|mp3|song|src)\s*[:=]\s*["'`]([^"'`]{4,500})["'`]/gi;

const JSON_KEY_HINTS = [
  "audio",
  "audio_url",
  "audioUrl",
  "stream",
  "stream_url",
  "streamUrl",
  "file",
  "file_url",
  "fileUrl",
  "mp3",
  "contentUrl",
  "encoding",
  "url"
];

const PLAYER_CLASS_HINTS = [
  "wp-playlist",
  "mejs",
  "mediaelement",
  "jplayer",
  "howler",
  "wavesurfer",
  "audioplayer"
];

function looksLikeAudioValue(value) {
  if (typeof value !== "string") return false;
  const trimmed = unescapeUrl(value.trim());
  if (!trimmed) return false;
  if (looksLikeAudioUrl(trimmed)) return true;
  // Allow relative paths / protocol-relative URLs that carry an audio extension
  // already covered by looksLikeAudioUrl. Otherwise reject generic strings.
  return false;
}

function pushCandidate(list, url, sourceType, declaredMimeType, extractionConfidence) {
  const cleaned = unescapeUrl(url);
  if (!cleaned) return;
  list.push({
    url: cleaned,
    sourceType,
    declaredMimeType: declaredMimeType || null,
    extractionConfidence
  });
}

function extractHtmlAudioTags($, candidates) {
  $("audio").each((_, el) => {
    const $el = $(el);
    const directSrc = $el.attr("src");
    if (directSrc) {
      pushCandidate(candidates, directSrc, "html_audio", $el.attr("type") || null, 0.9);
    }
  });
}

function extractSourceTags($, candidates) {
  $("audio source, source").each((_, el) => {
    const $el = $(el);
    const src = $el.attr("src");
    if (!src) return;
    const type = ($el.attr("type") || "").toLowerCase();
    const isKnownAudioMime = AUDIO_MIME_PRIORITY.some((mime) => type.includes(mime));
    const isAudioType = type.startsWith("audio/") || isKnownAudioMime || looksLikeAudioUrl(src);
    if (isAudioType) {
      pushCandidate(candidates, src, "source_tag", type || null, isKnownAudioMime ? 0.95 : 0.8);
    }
  });
}

function extractDirectLinks($, candidates) {
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && looksLikeAudioUrl(href)) {
      pushCandidate(candidates, href, "direct_link", null, 0.6);
    }
  });
}

function extractDataAttributes($, candidates) {
  $("*").each((_, el) => {
    const attribs = el.attribs || {};
    for (const key of Object.keys(attribs)) {
      if (!DATA_ATTR_KEYS.includes(key.toLowerCase())) continue;
      const value = attribs[key];
      if (looksLikeAudioValue(value) || /^https?:\/\//i.test(value || "")) {
        pushCandidate(candidates, value, "data_attribute", null, 0.55);
      }
    }
  });
}

function extractInlineScriptUrls($, candidates) {
  $("script:not([src])").each((_, el) => {
    const code = $(el).contents().text();
    if (!code || code.length > 400_000) return;

    let match;
    JS_KEY_PATTERN.lastIndex = 0;
    while ((match = JS_KEY_PATTERN.exec(code)) !== null) {
      const value = match[1];
      if (looksLikeAudioValue(value) || /^https?:\/\//i.test(value)) {
        if (looksLikeAudioUrl(value)) {
          pushCandidate(candidates, value, "inline_script", null, 0.5);
        }
      }
    }
  });
}

function walkJsonForAudioUrls(node, candidates, depth = 0) {
  if (!node || depth > 6) return;

  if (Array.isArray(node)) {
    for (const item of node) walkJsonForAudioUrls(item, candidates, depth + 1);
    return;
  }

  if (typeof node !== "object") return;

  for (const [key, value] of Object.entries(node)) {
    const keyLower = key.toLowerCase();
    const matchesHint = JSON_KEY_HINTS.some((hint) => keyLower === hint.toLowerCase());

    if (typeof value === "string" && matchesHint) {
      const isGenericUrlKey = keyLower === "url" || keyLower === "contenturl" || keyLower === "encoding";
      if (!isGenericUrlKey && /^https?:\/\//i.test(value)) {
        pushCandidate(candidates, value, "embedded_json", null, 0.65);
      } else if (looksLikeAudioUrl(value)) {
        // Generic "url"/"contentUrl"/"encoding" fields only count when they
        // clearly point at an audio file, to avoid false positives.
        pushCandidate(candidates, value, "embedded_json", null, 0.65);
      }
    } else if (typeof value === "object") {
      walkJsonForAudioUrls(value, candidates, depth + 1);
    }
  }
}

function extractEmbeddedJson($, candidates) {
  $('script[type="application/json"], script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw || raw.length > 400_000) return;
    try {
      const parsed = JSON.parse(raw);
      walkJsonForAudioUrls(parsed, candidates);
    } catch {
      // Malformed JSON is common (trailing commas, HTML entities) - skip safely.
    }
  });
}

function extractWordpressAndPlayers($, candidates) {
  // WordPress core playlist shortcode stores its track list as JSON inside a
  // script tag with class "wp-playlist-script" that immediately follows the
  // playlist container.
  $(".wp-playlist-script").each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      walkJsonForAudioUrls(parsed, candidates);
    } catch {
      // ignore malformed playlist JSON
    }
  });

  const classSelector = PLAYER_CLASS_HINTS.map((c) => `[class*="${c}"]`).join(", ");
  $(classSelector).each((_, el) => {
    const attribs = el.attribs || {};
    for (const [key, value] of Object.entries(attribs)) {
      if (!value) continue;
      if (key.toLowerCase().startsWith("data-") && (looksLikeAudioValue(value) || /^https?:\/\//i.test(value))) {
        if (looksLikeAudioUrl(value)) {
          pushCandidate(candidates, value, "wordpress_player", null, 0.7);
        }
      }
    }
  });
}

const RAW_URL_PATTERN =
  /https?:(?:\\?\/){2}[^\s"'<>\\]+?\.(?:mp3|m4a|aac|ogg|wav|flac)(?:\?[^\s"'<>\\]*)?/gi;

function extractRegexFallback(html, candidates) {
  if (!html) return;
  let match;
  RAW_URL_PATTERN.lastIndex = 0;
  let count = 0;
  while ((match = RAW_URL_PATTERN.exec(html)) !== null && count < 50) {
    pushCandidate(candidates, match[0], "regex_fallback", null, 0.3);
    count += 1;
  }
}

/**
 * Runs all extraction strategies (A-H) against page HTML.
 * Returns raw candidates with possibly-relative/escaped URLs - resolution
 * and deduplication happen in audioResolver.js.
 */
export function extractAudioCandidates(html) {
  const candidates = [];

  if (!html || typeof html !== "string") {
    return candidates;
  }

  let $;
  try {
    $ = cheerio.load(html);
  } catch (error) {
    logger.error("EXTRACTOR", "Failed to parse HTML:", error.message);
    extractRegexFallback(html, candidates);
    return candidates;
  }

  try {
    extractHtmlAudioTags($, candidates);
    extractSourceTags($, candidates);
    extractDirectLinks($, candidates);
    extractDataAttributes($, candidates);
    extractInlineScriptUrls($, candidates);
    extractEmbeddedJson($, candidates);
    extractWordpressAndPlayers($, candidates);
  } catch (error) {
    logger.error("EXTRACTOR", "Strategy failed:", error.message);
  }

  // Regex fallback always runs last, purely additive.
  extractRegexFallback(html, candidates);

  logger.extractor(`Found ${candidates.length} raw candidates`);

  return candidates;
}

export default extractAudioCandidates;
