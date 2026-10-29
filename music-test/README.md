# Music Discovery Test

A two-phase music discovery prototype:

1. **Track identification** - the user's query (title, artist, or lyrics fragment)
   is sent to an LLM via OpenRouter, which uses its built-in web search tool to
   identify the song and return candidate source pages.
2. **Audio resolution** - for every candidate source page, the backend fetches
   the page, parses its HTML/JS/JSON for playable audio URLs, validates the
   best candidates with lightweight HEAD/Range requests, ranks them
   deterministically, and returns the best playable stream URL so the
   frontend can play it in an HTML5 `<audio>` element.

## Project structure

```text
music-test/
├── server.js                    Express app, wires phase 1 + phase 2 together
├── package.json
├── .env / .env.example
│
├── services/
│   ├── openrouterService.js     Phase 1: OpenRouter web-search track identification
│   ├── audioResolver.js         Phase 2 orchestrator (fetch → extract → validate → rank)
│   ├── pageFetcher.js           SSRF-safe HTML fetch with timeout + size cap
│   ├── audioExtractor.js        Cheerio-based multi-strategy audio URL extraction
│   ├── audioValidator.js        HEAD/Range validation + audio signature sniffing
│   └── rankingService.js        Deterministic candidate scoring
│
├── utils/
│   ├── urlUtils.js               URL resolution, SSRF host blocking, dedup, extension checks
│   └── logger.js                 Tagged, secret-redacting console logger
│
└── public/
    └── index.html                 Frontend (search UI + audio player)
```

## Running

```bash
npm install
cp .env.example .env   # then fill in OPENROUTER_API_KEY
npm start
```

Visit `http://localhost:3000` (or whatever `PORT` is set to).

## API

`POST /api/search` — unchanged request shape from phase 1:

```json
{ "query": "نازارگم عادل حسینی" }
```

Response now includes resolved audio info per track:

```json
{
  "success": true,
  "result": {
    "found": true,
    "query_interpretation": "...",
    "tracks": [
      {
        "title": "نازارگم",
        "artist": "عادل حسینی",
        "confidence": 1,
        "source_page": "https://www.limusic.org/adel-hosseini-nazaragam/",
        "audio_url": "https://cdn.example.com/song.mp3",
        "mime_type": "audio/mpeg",
        "playable": true,
        "audio_confidence": 0.83,
        "reason": "Found a direct match for the song title and artist."
      }
    ]
  }
}
```

If a source page yields no playable audio, the track is still returned with
`audio_url: null`, `playable: false`, `audio_confidence: 0` - a failed
resolution never discards the track or the search result.

## Audio resolution pipeline

```text
Source Page
    ↓
Fetch HTML (timeout, size cap, SSRF-blocked hosts rejected)
    ↓
Extract candidates (8 strategies: <audio>, <source>, direct links,
                     data-* attributes, inline <script>, embedded JSON,
                     known player configs, regex fallback)
    ↓
Resolve relative/escaped URLs against the final page URL
    ↓
Deduplicate by normalized URL
    ↓
Limit to MAX_AUDIO_CANDIDATES, prioritizing higher-confidence extractions
    ↓
Validate candidates concurrently (HEAD, falling back to a 4KB Range GET;
                                   sniffs MP3/WAV/OGG/FLAC/MP4 signatures)
    ↓
Rank deterministically (extraction strategy + validation result + HTTPS)
    ↓
Best playable candidate returned
```

Tracks are resolved concurrently (`MAX_CONCURRENT_TRACK_RESOLUTION`), and
within each page, candidate validation is concurrency-limited
(`MAX_CONCURRENT_VALIDATIONS`). A failure on any single page or candidate
never aborts the rest of the search.

## SSRF protection

Before fetching or validating any URL, `utils/urlUtils.js` rejects:

- Non-`http(s)` protocols (`javascript:`, `data:`, `file:`, `blob:`, etc.)
- Literal loopback/private/link-local IPs (`127.0.0.1`, `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, IPv6 equivalents)
- Known cloud metadata addresses (`169.254.169.254`)
- `localhost` and other blocked hostnames

Redirects are re-checked against the same rules once the final URL is known.

## Environment variables

See `.env.example`:

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | required, used for phase 1 |
| `PORT` | HTTP port |
| `HTTP_TIMEOUT_MS` | timeout for page fetch / audio validation requests |
| `MAX_PAGE_SIZE_BYTES` | hard cap on HTML bytes read per source page |
| `MAX_AUDIO_CANDIDATES` | max candidates validated per source page |
| `MAX_CONCURRENT_VALIDATIONS` | concurrency limit for candidate validation |
| `MAX_CONCURRENT_TRACK_RESOLUTION` | concurrency limit across tracks |
| `USER_AGENT` | User-Agent sent on outbound requests |
