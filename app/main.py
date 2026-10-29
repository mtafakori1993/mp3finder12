"""FastAPI application entrypoint."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.models.schemas import SearchRequest, SearchResponse
from app.services.discovery_service import MusicDiscoveryService
from app.services.page_fetcher import close_http_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

discovery_service = MusicDiscoveryService()


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await close_http_client()


app = FastAPI(
    title="Music Discovery",
    description="Discover and preview publicly accessible music streams from the web.",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def read_index() -> FileResponse:
    return FileResponse("static/index.html")


@app.post("/api/search", response_model=SearchResponse)
async def search(request: SearchRequest) -> SearchResponse:
    try:
        tracks = await discovery_service.discover(request.query)
    except Exception:
        logger.exception("Search pipeline failed unexpectedly")
        raise HTTPException(status_code=500, detail="Search failed")

    return SearchResponse(query=request.query, results=tracks)
