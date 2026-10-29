import { isIP } from "net";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal"
]);

// Known cloud metadata endpoints (AWS/GCP/Azure/DO all use 169.254.169.254).
const BLOCKED_EXACT_IPS = new Set(["169.254.169.254"]);

function ipv4ToLong(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return null;
  }
  return (
    (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  ) >>> 0;
}

function inRange(long, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (long & mask) === (base & mask);
}

const PRIVATE_V4_RANGES = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
  ["127.0.0.0", 8],
  ["0.0.0.0", 8],
  ["100.64.0.0", 10] // carrier-grade NAT, also used by some metadata proxies
];

function isPrivateIPv4(ip) {
  const long = ipv4ToLong(ip);
  if (long === null) return false;
  if (BLOCKED_EXACT_IPS.has(ip)) return true;
  return PRIVATE_V4_RANGES.some(([base, bits]) => inRange(long, ipv4ToLong(base), bits));
}

function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  // Unique local addresses fc00::/7, link-local fe80::/10
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe80")) return true;
  // IPv4-mapped IPv6 addresses
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/**
 * Blocks obvious SSRF targets by hostname/IP shape. This is a best-effort
 * static check (no DNS resolution) meant to stop the common cases: literal
 * loopback/private/link-local addresses and cloud metadata hosts.
 */
export function isBlockedHost(hostname) {
  if (!hostname) return true;

  const bare = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();

  if (BLOCKED_HOSTNAMES.has(bare)) return true;

  const ipVersion = isIP(bare);
  if (ipVersion === 4) return isPrivateIPv4(bare);
  if (ipVersion === 6) return isPrivateIPv6(bare);

  // Not a literal IP - allow (DNS resolution happens at fetch time; we can't
  // do a safe pre-check without extra deps, so we rely on protocol/hostname
  // checks plus fetch timeouts/size limits as defense in depth).
  return false;
}

export function isAllowedUrl(url) {
  try {
    const parsed = url instanceof URL ? url : new URL(url);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return false;
    if (isBlockedHost(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Converts backslash-escaped URLs (as found inside JS string literals / JSON) to normal form. */
export function unescapeUrl(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\\\//g, "/").replace(/\\u0026/gi, "&").trim();
}

/**
 * Resolves a candidate URL (possibly relative or escaped) against a base URL.
 * Returns null if the result is not an allowed http(s) URL.
 */
export function resolveUrl(candidateUrl, baseUrl) {
  if (!candidateUrl || typeof candidateUrl !== "string") return null;

  const cleaned = unescapeUrl(candidateUrl.trim());
  if (!cleaned) return null;

  const lowered = cleaned.toLowerCase();
  if (
    lowered.startsWith("javascript:") ||
    lowered.startsWith("data:") ||
    lowered.startsWith("file:") ||
    lowered.startsWith("blob:") ||
    lowered.startsWith("mailto:") ||
    lowered.startsWith("#")
  ) {
    return null;
  }

  try {
    const resolved = new URL(cleaned, baseUrl);
    if (!isAllowedUrl(resolved)) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Normalizes a URL for deduplication purposes: lowercases host, strips
 * default ports, removes trailing slash on bare paths, sorts nothing (query
 * strings are preserved as-is since audio URLs often need exact tokens).
 */
export function normalizeUrlForDedup(url) {
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }
    // Strip common tracking-only fragments (never query params - those can
    // carry auth tokens required to stream the file).
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

const AUDIO_EXTENSIONS = ["mp3", "m4a", "aac", "ogg", "wav", "flac"];
const AUDIO_EXTENSION_PATTERN = new RegExp(
  `\\.(${AUDIO_EXTENSIONS.join("|")})(\\?[^\\s"'<>]*)?$`,
  "i"
);

export function looksLikeAudioUrl(url) {
  if (!url || typeof url !== "string") return false;
  const withoutQuery = url.split(/[?#]/)[0];
  return AUDIO_EXTENSIONS.some((ext) =>
    withoutQuery.toLowerCase().endsWith("." + ext)
  ) || AUDIO_EXTENSION_PATTERN.test(url);
}

export function extensionMimeType(url) {
  const match = url.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
  if (!match) return null;
  const ext = match[1].toLowerCase();
  const map = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    wav: "audio/wav",
    flac: "audio/flac"
  };
  return map[ext] || null;
}
