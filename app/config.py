"""Application configuration, loaded from environment variables / .env file."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for the music discovery service.

    All values can be overridden via environment variables or a .env file
    (see .env.example). Names are case-insensitive.
    """

    host: str = "0.0.0.0"
    port: int = 8000

    http_timeout: float = 10.0

    max_concurrent_page_fetches: int = 5
    max_concurrent_audio_validations: int = 10

    max_search_queries: int = 4
    max_search_results_per_query: int = 8
    max_inspected_pages: int = 15
    max_audio_candidates: int = 30
    max_returned_results: int = 5

    user_agent: str = "MusicDiscoveryBot/1.0"

    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False, extra="ignore")


settings = Settings()
