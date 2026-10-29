import { isAllowedUrl } from "../utils/urlUtils.js";
import logger from "../utils/logger.js";

const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 10000);
const MAX_PAGE_SIZE_BYTES = Number(process.env.MAX_PAGE_SIZE_BYTES || 5_000_000);
const USER_AGENT =
  process.env.USER_AGENT || "Mozilla/5.0 MusicDiscoveryBot/1.0";

/**
 * Fetches a page's HTML with a timeout, redirect following, and a hard cap
 * on response size. Never throws - all failures resolve to {success:false}.
 */
export async function fetchPage(url) {
  if (!isAllowedUrl(url)) {
    return { success: false, error: "URL is not allowed (blocked host or protocol)" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    const finalUrl = response.url || url;

    // The final destination after redirects must also pass SSRF checks.
    if (!isAllowedUrl(finalUrl)) {
      return { success: false, error: "Redirected to a disallowed URL" };
    }

    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}`,
        status: response.status,
        finalUrl
      };
    }

    if (contentType && !contentType.includes("html") && !contentType.includes("text")) {
      return {
        success: false,
        error: `Unsupported content-type: ${contentType}`,
        status: response.status,
        finalUrl,
        contentType
      };
    }

    const html = await readBodyWithLimit(response, MAX_PAGE_SIZE_BYTES);

    return {
      success: true,
      url,
      finalUrl,
      status: response.status,
      contentType,
      html
    };
  } catch (error) {
    const message =
      error.name === "AbortError" ? "Request timed out" : error.message || "Fetch failed";
    logger.error("PAGE_FETCHER", url, message);
    return { success: false, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readBodyWithLimit(response, limitBytes) {
  if (!response.body) {
    const text = await response.text();
    return text.slice(0, limitBytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let output = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    received += value.length;
    output += decoder.decode(value, { stream: true });

    if (received >= limitBytes) {
      await reader.cancel();
      break;
    }
  }

  output += decoder.decode();
  return output;
}

export default fetchPage;
