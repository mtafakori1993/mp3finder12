import logger from "../utils/logger.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const SYSTEM_PROMPT = `
You are an intelligent Music Discovery Agent.

Your job is to find the music track requested by the user using web search.

The user may provide:

* Exact song title
* Artist name
* Partial title
* Fragment of lyrics
* Approximate spelling
* Persian, English, Kurdish, Arabic, or mixed language text

Your workflow:

1. Understand the user's request.
2. Determine whether the query is:

   * exact song title
   * artist and song
   * lyrics fragment
   * approximate description
3. Use web search when necessary.
4. Identify the most likely song.
5. Search for publicly accessible pages related to that song.
6. Prefer pages that may contain playable audio.
7. Return discovered information.

IMPORTANT RULES:

* Never invent URLs.
* Only return URLs actually discovered through search.
* Do not claim an audio URL is playable without evidence.
* If a direct audio URL is found, include it.
* If only a source page is found, include source_page.
* Prefer exact matches.
* Return multiple candidates when uncertain.
* Maximum 5 tracks.

Return ONLY valid JSON.

Use exactly this structure:

{
"found": true,
"query_interpretation": "description of what the user requested",
"tracks": [
{
"title": "song title",
"artist": "artist name or null",
"confidence": 0.0,
"source_page": "https://example.com/page or null",
"audio_url": null,
"reason": "short explanation"
}
]
}

Rules:

* confidence must be a number between 0 and 1
* use null for unknown values
* never include markdown
* never wrap JSON inside code fences
* return JSON only
  `;

export function extractJson(text) {
  if (!text) {
    throw new Error("Empty response from model");
  }

  if (typeof text !== "string") {
    throw new Error("Model response content is not a string");
  }

  // Try direct JSON parsing first
  try {
    return JSON.parse(text);
  } catch (error) {
    // Continue with cleanup
  }

  const cleaned = text
    .replace(/`json/gi, "")
    .replace(/`/g, "")
    .trim();

  // Try parsing after markdown cleanup
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // Continue searching for JSON object
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start !== -1 && end !== -1 && end > start) {
    const jsonString = cleaned.substring(start, end + 1);
    try {
      return JSON.parse(jsonString);
    } catch (error) {
      throw new Error(
        "Could not parse JSON object from model response: " +
        error.message
      );
    }
  }

  throw new Error("Could not find JSON in model response");
}

/**
 * Runs the existing OpenRouter web-search track identification flow.
 * Unchanged from the working prototype - only relocated into its own module.
 */
export async function searchTracks(query) {
  logger.openrouter("Sending request for:", query);

  const requestBody = {
    model: "google/gemini-2.5-flash",
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      {
        role: "user",
        content: "Find this music request: " + query
      }
    ],
    tools: [
      {
        type: "openrouter:web_search"
      }
    ],
    temperature: 0.2,
    max_tokens: 2000
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

  logger.openrouter("Status:", response.status);

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

  const content = message.content;

  const result = extractJson(content);

  logger.openrouter(`Found ${result?.tracks?.length ?? 0} candidate tracks`);

  return result;
}

export default searchTracks;
