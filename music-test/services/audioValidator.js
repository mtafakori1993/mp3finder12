import { isAllowedUrl, looksLikeAudioUrl } from "../utils/urlUtils.js";
import logger from "../utils/logger.js";

const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 10000);
const USER_AGENT =
  process.env.USER_AGENT || "Mozilla/5.0 MusicDiscoveryBot/1.0";
const RANGE_BYTES = 4096;

const VALID_AUDIO_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/webm",
  "audio/x-m4a"
]);

const SIGNATURES = [
  { name: "mp3-id3", test: (b) => b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 },
  {
    name: "mp3-frame-sync",
    test: (b) => b[0] === 0xff && (b[1] & 0xe0) === 0xe0
  },
  {
    name: "wav-riff",
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45
  },
  { name: "ogg", test: (b) => b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53 },
  {
    name: "flac",
    test: (b) => b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43
  },
  {
    name: "mp4-ftyp",
    test: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
  }
];

function detectSignature(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const match = SIGNATURES.find((sig) => sig.test(bytes));
  return match ? match.name : null;
}

function emptyResult(url, overrides = {}) {
  return {
    playable: false,
    url,
    statusCode: null,
    contentType: null,
    contentLength: null,
    rangeSupported: false,
    signature: null,
    error: null,
    ...overrides
  };
}

function isAcceptableMime(contentType) {
  if (!contentType) return { acceptable: false, confident: false };
  const base = contentType.split(";")[0].trim().toLowerCase();
  if (VALID_AUDIO_MIME_TYPES.has(base)) return { acceptable: true, confident: true };
  if (base === "application/octet-stream") return { acceptable: true, confident: false };
  return { acceptable: false, confident: false };
}

async function withTimeout(fn) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function tryHead(url) {
  return withTimeout(async (signal) => {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal,
      headers: { "User-Agent": USER_AGENT }
    });
    return response;
  });
}

async function tryRangeGet(url) {
  return withTimeout(async (signal) => {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal,
      headers: {
        "User-Agent": USER_AGENT,
        Range: `bytes=0-${RANGE_BYTES - 1}`
      }
    });

    let bytes = new Uint8Array(0);

    if (response.body) {
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;

      while (received < RANGE_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
      }
      await reader.cancel().catch(() => {});

      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    }

    return { response, bytes };
  });
}

/**
 * Validates a candidate audio URL without downloading the whole file.
 * Tries HEAD first, falls back to a small ranged GET. Never throws.
 */
export async function validateAudio(url) {
  if (!isAllowedUrl(url)) {
    return emptyResult(url, { error: "URL is not allowed (blocked host or protocol)" });
  }

  logger.validator("Testing:", url);

  try {
    const headResponse = await tryHead(url);

    if (headResponse.ok || headResponse.status === 206) {
      const contentType = headResponse.headers.get("content-type");
      const contentLengthRaw = headResponse.headers.get("content-length");
      const acceptRanges = headResponse.headers.get("accept-ranges");
      const { acceptable, confident } = isAcceptableMime(contentType);

      if (acceptable) {
        const result = emptyResult(url, {
          playable: true,
          statusCode: headResponse.status,
          contentType,
          contentLength: contentLengthRaw ? Number(contentLengthRaw) : null,
          rangeSupported: acceptRanges === "bytes",
          error: confident ? null : "Ambiguous MIME type (octet-stream)"
        });
        logger.validator(
          `Result (HEAD): ${result.statusCode} ${result.contentType} playable=${result.playable}`
        );
        return result;
      }

      if (contentType && contentType.includes("html")) {
        return emptyResult(url, {
          statusCode: headResponse.status,
          contentType,
          error: "HTML returned instead of audio"
        });
      }
    }
  } catch (error) {
    logger.validator("HEAD failed, falling back to range GET:", error.message);
  }

  try {
    const { response, bytes } = await tryRangeGet(url);

    if (!response.ok && response.status !== 206) {
      return emptyResult(url, {
        statusCode: response.status,
        error: `Unexpected status ${response.status}`
      });
    }

    const contentType = response.headers.get("content-type");
    const contentRange = response.headers.get("content-range");
    const contentLengthRaw = response.headers.get("content-length");
    const { acceptable, confident } = isAcceptableMime(contentType);

    if (contentType && contentType.includes("html")) {
      return emptyResult(url, {
        statusCode: response.status,
        contentType,
        error: "HTML returned instead of audio"
      });
    }

    if (bytes.length < 64) {
      return emptyResult(url, {
        statusCode: response.status,
        contentType,
        error: "Suspicious tiny response"
      });
    }

    const signature = detectSignature(bytes);
    const urlLooksLikeAudio = looksLikeAudioUrl(url);

    const playable = acceptable || (urlLooksLikeAudio && response.status < 400);

    let totalLength = null;
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)$/);
      if (match) totalLength = Number(match[1]);
    } else if (contentLengthRaw) {
      totalLength = Number(contentLengthRaw);
    }

    const result = emptyResult(url, {
      playable,
      statusCode: response.status,
      contentType,
      contentLength: totalLength,
      rangeSupported: response.status === 206,
      signature,
      error: playable ? (confident ? null : "Ambiguous MIME type (octet-stream)") : "Unrecognized content"
    });

    logger.validator(
      `Result (RANGE): ${result.statusCode} ${result.contentType} playable=${result.playable} signature=${signature}`
    );

    return result;
  } catch (error) {
    const message = error.name === "AbortError" ? "Request timed out" : error.message;
    logger.error("VALIDATOR", url, message);
    return emptyResult(url, { error: message });
  }
}

export default validateAudio;
