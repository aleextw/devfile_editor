"""
config.py — Application configuration
======================================
Uses pydantic-settings to load configuration from environment variables and
an optional .env file. Import the singleton ``settings`` in other modules:

    from .config import settings

    print(settings.chat_team_name)
    print(settings.base_dir)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any

from pydantic import BeforeValidator, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_json_list(value: Any) -> list[str]:
    """
    Coerce a value to a list of strings.

    Accepts:
    - An already-parsed list (passed through as-is).
    - A JSON string (e.g. from an env var): '["a", "b"]'
    - An empty string or missing value → returns [].
    """
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        return json.loads(stripped)
    return []


JsonStrList = Annotated[list[str], BeforeValidator(_parse_json_list)]


# ── Settings ──────────────────────────────────────────────────────────────────

class Settings(BaseSettings):
    """
    All application configuration, loaded from environment variables or a
    .env file in the working directory.

    Every field maps to a correspondingly named environment variable
    (case-insensitive). Pydantic-settings reads them in this priority order:
        1. Real environment variables
        2. .env file (path set by ``model_config``)
        3. Field default

    Chat UI
    -------
    chat_team_name:
        Displayed as "<team_name> Assistant" in the header and empty state.
        Also used as the HTML page <title>.
    chat_logo_text:
        Short string (2–4 chars) shown in the logo mark and message avatars.
    chat_tagline:
        Subtitle shown under the title in the header and on the empty state.
    chat_welcome_message:
        Body copy shown before the user sends their first message.
    chat_input_placeholder:
        Placeholder text inside the chat textarea.
    chat_suggestions:
        JSON array of suggestion chips shown on the empty state.
        Example env value: '["Tell me about X", "How do I Y"]'

    Paths
    -----
    base_dir:
        Root directory containing the Jinja2 templates (chat.html, index.html,
        _navbar.html) and the static/ subdirectory.
        Defaults to the directory containing this config.py file.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        # Allow extra env vars to be present without raising an error
        extra="ignore",
    )

    # ── Chat UI ───────────────────────────────────────────────────────────────

    chat_team_name: str = Field(
        default="Team",
        description="Team name shown in the assistant header and page title.",
    )

    chat_logo_text: str = Field(
        default="ai",
        description="Short logo mark text (2–4 chars) used in avatars.",
    )

    chat_tagline: str = Field(
        default="ask me anything",
        description="Subtitle shown beneath the team name.",
    )

    chat_welcome_message: str = Field(
        default=(
            "Ask me anything — I'm here to help with questions, tasks, "
            "and anything your team needs."
        ),
        description="Welcome copy shown on the empty chat state.",
    )

    chat_input_placeholder: str = Field(
        default="Ask anything…",
        description="Placeholder text inside the chat input.",
    )

    chat_suggestions: JsonStrList = Field(
        default=[
            "Summarise our last sprint",
            "Help me write a runbook",
            "What's the on-call rotation?",
            "Draft a post-mortem template",
        ],
        description=(
            "Suggestion chips shown on the empty state. "
            "Set as a JSON array string in the environment: "
            'CHAT_SUGGESTIONS=\'["Option A","Option B"]\''
        ),
    )

    # ── Paths ─────────────────────────────────────────────────────────────────

    base_dir: Path = Field(
        default=Path(__file__).parent,
        description=(
            "Root directory containing templates and the static/ subdirectory. "
            "Defaults to the directory containing config.py."
        ),
    )

    # ── Derived properties ────────────────────────────────────────────────────

    @property
    def static_dir(self) -> Path:
        """Absolute path to the static assets directory."""
        return self.base_dir / "static"

    @property
    def template_dir(self) -> Path:
        """Absolute path to the Jinja2 templates directory (same as base_dir)."""
        return self.base_dir


# ── Singleton ─────────────────────────────────────────────────────────────────
# Import this instance throughout the application:
#
#   from .config import settings
#
# To override in tests, construct a fresh Settings() with the desired values:
#
#   from .config import Settings
#   test_settings = Settings(chat_team_name="Test Team", ...)

settings = Settings()