# Music Discovery

A local prototype that searches the public web for a song, artist, or lyric
fragment, inspects candidate pages for publicly accessible audio, validates
the streams, ranks them, and plays back the best matches in the browser.

This is a **discovery and playback prototype**. It only processes publicly
accessible URLs returned by normal web search and publicly exposed page
content. It does not implement, and must not be extended to implement, DRM
circumvention, authentication bypass, paywall bypass, signature forgery,
cookie theft, or access-control bypass.

## How it works

```text
User Query
    -> Query Normalization
    -> Search Query Generation
    -> Web Search
    -> Candidate Pages
    -> Concurrent Page Inspection
    -> Audio URL Extraction
    -> Audio Validation
    -> Deduplication
    -> Ranking
    -> Top 5 Results
```

1. **Normalization** (`app/utils/url_utils.py`) unifies Persian/Arabic letter
   variants, strips diacritics and stray punctuation, and collapses
   whitespace, while the original query is preserved for display.
2. **Query generation** builds a handful of exact-phrase and genre/format
   variants (`"query" آهنگ`, `"query" mp3`, ...), which also covers lyric
   fragments via exact-phrase search.
3. **Search** (`app/services/search_service.py`) is behind a `SearchProvider`
   interface. The default implementation, `BingSearchProvider`, scrapes
   Bing's public HTML search results (no API key required); a
   `DuckDuckGoSearchProvider` is also included as an alternative. Additional
   providers (e.g. a paid search API) can be added without touching the rest
   of the pipeline.
4. **Page fetching** (`app/services/page_fetcher.py`) uses a single shared
   `httpx.AsyncClient`, bounded by a semaphore, with SSRF checks on both the
   requested and the final (post-redirect) URL.
5. **Audio extraction** (`app/services/audio_extractor.py`) runs six
   independent extractors: HTML5 `<audio>`/`<source>` tags, standalone
   `<source>` tags, direct anchor links to audio files, embedded JSON in
   `<script>` tags, JSON-LD structured data, and a conservative regex
   fallback (used only if nothing else matched). No JavaScript is executed.
6. **Validation** (`app/services/audio_validator.py`) issues a `HEAD`
   request first, falling back to a ranged `GET` (`Range: bytes=0-2048`) when
   `HEAD` is unsupported. The full media file is never downloaded.
7. **Ranking** (`app/services/ranking_service.py`) scores each candidate on
   title/URL relevance, extractor confidence, MIME type validity, range
   support, and HTTPS, then normalizes the score into a 0-1 confidence.
8. **Discovery orchestration** (`app/services/discovery_service.py`) ties all
   of the above together, deduplicating pages and candidates and returning at
   most 5 ranked, playable tracks.

## Project structure

```text
music-discovery/
├── app/
│   ├── main.py                  FastAPI app, routes
│   ├── config.py                Settings (env-driven)
│   ├── models/schemas.py        Pydantic models
│   ├── services/
│   │   ├── search_service.py    SearchProvider abstraction + DuckDuckGo impl
│   │   ├── discovery_service.py Main orchestrator
│   │   ├── page_fetcher.py      Shared HTTP client, SSRF-guarded fetch
│   │   ├── audio_extractor.py   Audio URL + metadata extractors
│   │   ├── audio_validator.py   HEAD/ranged-GET stream validation
│   │   └── ranking_service.py   Scoring and confidence normalization
│   └── utils/url_utils.py       Normalization, URL resolution, SSRF guard
├── static/index.html            Frontend (vanilla JS, no build step)
├── requirements.txt
├── .env.example
└── README.md
```

## Installation

```bash
python -m venv .venv
```

Activate the virtual environment.

Linux/macOS:

```bash
source .venv/bin/activate
```

Windows:

```bash
.venv\Scripts\activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

(Optional) copy the environment template and adjust as needed:

```bash
cp .env.example .env
```

## Running

```bash
uvicorn app.main:app --reload
```

Open your browser at:

```text
http://localhost:8000
```

## API

### `GET /`

Serves the frontend (`static/index.html`).

### `POST /api/search`

Request:

```json
{ "query": "سلطان قلب ها" }
```

Response:

```json
{
  "query": "سلطان قلب ها",
  "results": [
    {
      "title": "Song title",
      "artist": "Artist name",
      "source_page": "https://example.com/song-page",
      "audio_url": "https://cdn.example.com/song.mp3",
      "mime_type": "audio/mpeg",
      "duration": null,
      "confidence": 0.92,
      "validation": {
        "playable": true,
        "status_code": 200,
        "content_type": "audio/mpeg",
        "content_length": 12345678,
        "range_supported": true
      }
    }
  ]
}
```

Errors are always returned as `{"detail": "..."}` with an appropriate HTTP
status code; internal exceptions, stack traces, and environment details are
never exposed to the client (they are logged server-side only).

## Try it

- `Imagine Dragons Believer`
- `Bohemian Rhapsody Queen`
- `سلطان قلب ها`
- `دلم گرفته ای رفیق` (treated as a lyric fragment -> exact-phrase search)

## Configuration

All settings in `.env.example` are read via `app/config.py`
(`pydantic-settings`) and can be overridden with environment variables or a
`.env` file:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8000` | Bind address (used if you run uvicorn with `--host`/`--port` from these values) |
| `HTTP_TIMEOUT` | `10` | Timeout (seconds) for outbound HTTP requests |
| `MAX_CONCURRENT_PAGE_FETCHES` | `5` | Concurrency limit for fetching candidate pages |
| `MAX_CONCURRENT_AUDIO_VALIDATIONS` | `10` | Concurrency limit for validating candidate audio URLs |
| `MAX_SEARCH_RESULTS_PER_QUERY` | `8` | Search results requested per query variant |
| `MAX_INSPECTED_PAGES` | `15` | Cap on candidate pages fetched per search |
| `MAX_AUDIO_CANDIDATES` | `30` | Cap on audio candidates validated per search |
| `USER_AGENT` | `MusicDiscoveryBot/1.0` | User-Agent sent on outbound requests |

## Security notes

- **SSRF protection** (`app/utils/url_utils.py::is_safe_url`): only `http`/
  `https` schemes are allowed; `localhost`, loopback, private, link-local,
  reserved, and cloud metadata addresses are rejected. Hostnames are resolved
  and every returned IP is checked, both for the initial request and after
  redirects.
- **No full downloads**: audio validation only reads response headers (via
  `HEAD`) or the first ~2KB (via a ranged `GET`); it never downloads a
  complete media file.
- **No JavaScript execution**: embedded JSON is inspected via `json.loads`
  or targeted regex, never `eval`'d or executed in a browser context.
- **Bounded concurrency and result counts**: page fetches and audio
  validations are limited by semaphores; searches, inspected pages, and
  candidates are all capped (see Configuration above) to avoid unbounded
  network usage.

## Known limitations

- The bundled search providers (`BingSearchProvider`, default; and
  `DuckDuckGoSearchProvider`, alternative) scrape public HTML search-result
  pages. They require no API key, but are best-effort: search engines may
  rate-limit, CAPTCHA-challenge, or serve unrelated filler content to
  requests they classify as automated or suspicious -- this is noticeably
  more likely when running behind an unstable or rotating proxy/VPN, and can
  vary by query language. If searches return empty or clearly irrelevant
  results, first try running the app directly from a normal, unproxied
  network connection. For production use, swap in a `SearchProvider`
  implementation backed by a real search API (e.g. Brave Search API,
  SerpApi, or the Azure Bing Web Search API) -- the interface in
  `app/services/search_service.py` makes this a drop-in change.
- Audio metadata (title/artist) is extracted heuristically from page titles
  and Open Graph tags; it will not always be perfectly accurate.
- Track `duration` is not currently populated (would require parsing audio
  file headers, which is out of scope for this prototype).
