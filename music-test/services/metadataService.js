import { extractJson } from "./openrouterService.js";
import { isAllowedUrl } from "../utils/urlUtils.js";
import logger from "../utils/logger.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const ALLOWED_LANGUAGES = [
  "نامشخص",
  "English",
  "فارسی",
  "Հայերեն",
  "Türkçe",
  "العربية",
  "کوردی"
];

const ALLOWED_GENRES = [
  "نامشخص",
  "پاپ",
  "راک",
  "هیپ‌هاپ",
  "سنتی",
  "محلی",
  "کلاسیک",
  "جاز",
  "الکترونیک",
  "دنس",
  "میهنی",
  "بی‌کلام"
];

const ALLOWED_MOODS = [
  "نامشخص",
  "شاد",
  "انرژی‌بخش",
  "انگیزشی",
  "عاشقانه",
  "غمگین",
  "آرام",
  "جشن",
  "حماسی"
];

const SYSTEM_PROMPT = `
You are a professional music metadata extraction agent.

Your task is to identify a music track from the user's input and web search
results, research the track when necessary, and return structured metadata
that can be used directly to populate a music-library creation form.

The user may provide: song title, artist name, lyrics fragment, full lyrics,
a URL, a music page, a combination of title and artist, an approximate or
misspelled title, or an approximate or misspelled artist name.

Use web search when necessary to verify the information.

Your output MUST be valid JSON. Do not return Markdown. Do not return
explanations outside the JSON object. No code fences. No comments. No
trailing commas. Exactly these properties, no additional properties:

{
"title": "",
"artist": "",
"title_aliases": [],
"artist_aliases": [],
"description": "",
"lyrics": "",
"language": "",
"genre": "",
"mood": "",
"audio_url": "",
"audio_source_page": "",
"confidence": 0.0
}

FIELD RULES

1. title - the canonical, most commonly recognized official title. Do not
   include noise such as "MP3", "دانلود", "Official Audio", "lyrics",
   "کیفیت 320", or the artist name.

2. artist - the canonical performer/singer name.

3. title_aliases - array of alternative spellings/pronunciations of the
   title that improve search: Latin transliteration, Persian/Arabic spelling
   variants, common misspellings, spacing variants, phonetic spellings. Only
   include variants reasonably supported by search results or common
   transliteration. Never guess randomly. [] if none.

4. artist_aliases - same idea for the artist name (Latin transliteration,
   common English spelling, common misspellings, phonetic spelling,
   alternate spacing). Only plausible variants. [] if none.

5. description - a short, factual description (musical style, theme,
   release context, notable characteristics). No lyrics here. Do not copy
   long text from websites. "" if reliable information is unavailable.

6. lyrics - SEPARATE from description. Only include lyrics that are publicly
   available and can be legally returned. If only a fragment is available,
   do not invent the rest. Never fabricate lyrics or reconstruct them from
   memory. If search results only confirm the song but don't provide
   lyrics, leave "". This field must support later search by lyric fragment
   (e.g. a user searching "the song that goes 'my heart is heavy...'").

7. language - EXACTLY one of: ${ALLOWED_LANGUAGES.map((v) => `"${v}"`).join(", ")}.
   Use "کوردی" for Kurdish songs. Never invent another value. "نامشخص" if
   not confidently determined.

8. genre - EXACTLY one of: ${ALLOWED_GENRES.map((v) => `"${v}"`).join(", ")}.
   Never invent another value. "نامشخص" if uncertain. Choose the single
   most appropriate primary genre.

9. mood - EXACTLY one of: ${ALLOWED_MOODS.map((v) => `"${v}"`).join(", ")}.
   Choose only the single dominant emotional character. "نامشخص" if
   uncertain.

10. audio_url - only a publicly accessible DIRECT audio stream/file URL that
    was actually discovered through search (e.g. ends in an audio file or is
    clearly identified as an audio stream). Never invent a URL. Never derive
    it by guessing from the page URL (e.g. never assume
    "https://example.com/music/song" implies
    "https://example.com/music/song.mp3" - only report a URL that was
    actually found). "" if not confidently identified. Do NOT put the source
    page URL in this field.

11. audio_source_page - the webpage where the song/audio was found. "" if
    none.

12. confidence - a number between 0.0 and 1.0 (never a string like "high").
    1.0 = exact title, artist and metadata verified from reliable sources.
    0.9 = highly confident. 0.7 = probable match with some uncertainty.
    0.5 = weak match. 0.2 = highly uncertain.

WEB RESEARCH STRATEGY

Search progressively: try the raw query first, then split title/artist,
then alternative transliterations. If the input looks like a lyrics
fragment rather than a title, search the exact phrase as lyrics, then use
the identified title/artist for further verification.

SOURCE PRIORITY

Prefer, in order: official artist pages; official music releases;
established music databases; established music websites; search result
snippets; other public pages. Cross-check important metadata. Do not assume
the first search result is correct.

DISAMBIGUATION

If multiple songs share a similar name, compare artist, lyrics, search
result title, album, release information, source page, and language. Choose
the candidate with the strongest evidence. Never merge information from
different songs.

NORMALIZATION

Normalize obvious Persian/Arabic spelling variants when determining aliases
(e.g. ي to ی, ك to ک). Remove unnecessary duplicated spaces. Preserve the
canonical title and artist exactly as commonly written.

EMPTY VALUES

Use "" for unavailable string fields and [] for unavailable alias arrays.
Never use null.

Return JSON only.
`;

function toCleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(cleaned));
}

function toEnum(value, allowed) {
  return allowed.includes(value) ? value : allowed[0];
}

function toConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function toAudioFieldUrl(value) {
  const cleaned = toCleanString(value);
  return cleaned && isAllowedUrl(cleaned) ? cleaned : "";
}

/**
 * Coerces a raw LLM response into the exact schema, dropping anything
 * malformed rather than trusting the model's output at face value.
 */
export function sanitizeMetadata(raw) {
  const title = toCleanString(raw?.title);
  const artist = toCleanString(raw?.artist);

  return {
    title,
    artist,
    title_aliases: toStringArray(raw?.title_aliases).filter((alias) => alias !== title),
    artist_aliases: toStringArray(raw?.artist_aliases).filter((alias) => alias !== artist),
    description: toCleanString(raw?.description),
    lyrics: toCleanString(raw?.lyrics),
    language: toEnum(toCleanString(raw?.language), ALLOWED_LANGUAGES),
    genre: toEnum(toCleanString(raw?.genre), ALLOWED_GENRES),
    mood: toEnum(toCleanString(raw?.mood), ALLOWED_MOODS),
    audio_url: toAudioFieldUrl(raw?.audio_url),
    audio_source_page: toAudioFieldUrl(raw?.audio_source_page),
    confidence: toConfidence(raw?.confidence)
  };
}

/**
 * Runs the metadata-extraction agent against OpenRouter web search and
 * returns a schema-validated metadata object for a single track.
 */
export async function extractMetadata(query) {
  logger.openrouter("Sending metadata request for:", query);

  const requestBody = {
    model: "google/gemini-2.5-flash",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "Extract metadata for this music request: " + query }
    ],
    tools: [
      {
        type: "openrouter:web_search"
      }
    ],
    temperature: 0.2,
    max_tokens: 3000
  };

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + OPENROUTER_API_KEY,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Music Discovery Test"
      },
      body: JSON.stringify(requestBody)
    }
  );

  const responseText = await response.text();

  logger.openrouter("Metadata status:", response.status);

  if (!response.ok) {
    logger.error("OPENROUTER", responseText);

    const error = new Error("OpenRouter request failed");
    error.status = response.status;
    error.details = responseText;
    throw error;
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch (error) {
    logger.error("OPENROUTER", "Invalid JSON:", responseText);
    throw new Error("OpenRouter returned invalid JSON");
  }

  const message = data?.choices?.[0]?.message;

  if (!message) {
    logger.error("OPENROUTER", "Unexpected response:", JSON.stringify(data));
    throw new Error("No message found in OpenRouter response");
  }

  const parsed = extractJson(message.content);
  const sanitized = sanitizeMetadata(parsed);

  logger.openrouter(`Metadata extracted: "${sanitized.title}" by "${sanitized.artist}"`);

  return sanitized;
}

export default extractMetadata;
