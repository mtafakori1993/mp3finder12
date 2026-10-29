import "./utils/loadEnv.js";

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import searchTracks from "./services/openrouterService.js";
import resolveAudioFromPage from "./services/audioResolver.js";
import extractMetadata from "./services/metadataService.js";
import validateAudio from "./services/audioValidator.js";
import logger from "./utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.error("ERROR: OPENROUTER_API_KEY is missing in .env");
  process.exit(1);
}

const MAX_CONCURRENT_TRACK_RESOLUTION = Number(
  process.env.MAX_CONCURRENT_TRACK_RESOLUTION || 3
);

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

async function attachAudioToTrack(track) {
  if (!track || !track.source_page) {
    return {
      ...track,
      audio_url: track?.audio_url ?? null,
      mime_type: null,
      playable: false,
      audio_confidence: 0
    };
  }

  try {
    const audioResult = await resolveAudioFromPage(track.source_page);

    return {
      ...track,
      audio_url: audioResult.audio_url,
      mime_type: audioResult.mime_type,
      playable: audioResult.playable,
      audio_confidence: audioResult.confidence
    };
  } catch (error) {
    // A single failed source page must never take down the whole search.
    logger.error("SEARCH", "Track audio resolution failed:", error.message);
    return {
      ...track,
      audio_url: null,
      mime_type: null,
      playable: false,
      audio_confidence: 0
    };
  }
}

app.post("/api/search", async (req, res) => {
  try {
    const query = req.body?.query?.trim();

    if (!query) {
      return res.status(400).json({
        error: "Song query is required"
      });
    }

    logger.search("Searching for:", query);

    let result;

    try {
      result = await searchTracks(query);
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({
          error: "OpenRouter request failed",
          details: error.details
        });
      }
      throw error;
    }

    if (Array.isArray(result?.tracks) && result.tracks.length > 0) {
      logger.resolver(`Resolving audio for ${result.tracks.length} track(s)`);

      result.tracks = await mapWithConcurrency(
        result.tracks,
        MAX_CONCURRENT_TRACK_RESOLUTION,
        attachAudioToTrack
      );
    }

    return res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error("Search error:");
    console.error(error);

    return res.status(500).json({
      error: error.message || "Internal server error"
    });
  }
});

/**
 * Never trusts an LLM-provided audio_url at face value: re-validates it with
 * a real HEAD/Range request, and if it's missing but a source page was
 * found, tries to discover a real playable URL from that page instead.
 */
async function resolveMetadataAudio(metadata) {
  if (metadata.audio_url) {
    try {
      const validation = await validateAudio(metadata.audio_url);
      if (!validation.playable) {
        logger.error("METADATA", "Discarding unverified audio_url:", metadata.audio_url);
        metadata.audio_url = "";
      }
    } catch (error) {
      logger.error("METADATA", "Validation failed:", error.message);
      metadata.audio_url = "";
    }
  }

  if (!metadata.audio_url && metadata.audio_source_page) {
    try {
      const resolved = await resolveAudioFromPage(metadata.audio_source_page);
      if (resolved.playable && resolved.audio_url) {
        metadata.audio_url = resolved.audio_url;
      }
    } catch (error) {
      logger.error("METADATA", "Audio resolution failed:", error.message);
    }
  }

  return metadata;
}

app.post("/api/metadata", async (req, res) => {
  try {
    const query = req.body?.query?.trim();

    if (!query) {
      return res.status(400).json({
        error: "Song query is required"
      });
    }

    logger.search("Extracting metadata for:", query);

    let metadata;

    try {
      metadata = await extractMetadata(query);
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({
          error: "OpenRouter request failed",
          details: error.details
        });
      }
      throw error;
    }

    metadata = await resolveMetadataAudio(metadata);

    return res.json({
      success: true,
      result: metadata
    });
  } catch (error) {
    console.error("Metadata error:");
    console.error(error);

    return res.status(500).json({
      error: error.message || "Internal server error"
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = Number(process.env.PORT || 3020);

app.listen(PORT, () => {
  console.log("");
  console.log("=================================");
  console.log("Music Discovery Test");
  console.log("Server running at:");
  console.log("http://localhost:" + PORT);
  console.log("=================================");
  console.log("");
});
