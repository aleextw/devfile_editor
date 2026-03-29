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
import logging
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.model.devfile import (
    PredefinedCommand,
    PredefinedRepo,
    PredefinedConfig,
    CatalogFragment,
    JsonStrList,
)
from app.util.devfile import _encode_blob, _devfile_to_state

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    """
    All application configuration, loaded from environment variables or a
    .env file in the working directory.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
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
            "Set as a JSON array string in the environment."
        ),
    )

    # ── Devfile Configurator ──────────────────────────────────────────────────

    devfile_predefined_repos_file: Path | None = Field(
        default=None,
        description=(
            "Path to a JSON file containing the predefined repositories shown "
            "in the devfile configurator picker."
        ),
    )

    devfile_predefined_configs_dir: Path | None = Field(
        default=None,
        description=(
            "Path to a directory containing predefined devfile YAML configurations."
        ),
    )

    devfile_predefined_commands_file: Path | None = Field(
        default=None,
        description=(
            "Path to a JSON file containing the predefined commands shown in the "
            "devfile configurator Commands section picker."
        ),
    )

    devfile_component_catalog_file: Path | None = Field(
        default=None,
        description=(
            "Path to a JSON file defining the fragment catalog shown in the "
            "devfile configurator Components section. Each entry is a partial "
            "devfile fragment preset: { id, name, icon, description, devfile: {...} }. "
            "See component_catalog.example.json for the schema."
        ),
    )

    # ── Paths ─────────────────────────────────────────────────────────────────

    base_dir: Path = Field(
        default=Path.cwd(),
        description=(
            "Root directory containing templates and the static/ subdirectory."
        ),
    )

    # ── Derived properties ────────────────────────────────────────────────────

    @property
    def static_dir(self) -> Path:
        return self.base_dir / "src" / "site" / "static"

    @property
    def template_dir(self) -> Path:
        return self.base_dir / "src" / "site"

    @property
    def devfile_predefined_repos(self) -> list[PredefinedRepo]:
        if self.devfile_predefined_repos_file is None:
            return []
        path = self.devfile_predefined_repos_file
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.exists():
            logger.warning(
                "DEVFILE_PREDEFINED_REPOS_FILE points to a non-existent file: %s", path
            )
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return [PredefinedRepo.model_validate(item) for item in raw]
        except Exception as exc:
            logger.warning("Failed to load predefined repos from %s: %s", path, exc)
            return []

    @property
    def devfile_predefined_commands(self) -> list[PredefinedCommand]:
        if self.devfile_predefined_commands_file is None:
            return []
        path = self.devfile_predefined_commands_file
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.exists():
            logger.warning(
                "DEVFILE_PREDEFINED_COMMANDS_FILE points to a non-existent file: %s",
                path,
            )
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return [PredefinedCommand.model_validate(item) for item in raw]
        except Exception as exc:
            logger.warning("Failed to load predefined commands from %s: %s", path, exc)
            return []

    @property
    def devfile_component_catalog(self) -> list[CatalogFragment]:
        """
        Load the fragment catalog from the JSON file at
        ``devfile_component_catalog_file``.

        Each entry must be a CatalogFragment:
          { id, name, icon?, description?, devfile: { ... } }

        The ``devfile`` field is a partial devfile fragment that is merged into
        the base devfile on export.  It may contain any combination of
        ``components``, ``commands``, ``events``, ``variables``, ``attributes``,
        ``projects``, and ``starterProjects``.

        Returns an empty list if the field is unset, the file does not exist,
        or the file cannot be parsed.
        """
        if self.devfile_component_catalog_file is None:
            return []
        path = self.devfile_component_catalog_file
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.exists():
            logger.warning(
                "DEVFILE_COMPONENT_CATALOG_FILE points to a non-existent file: %s",
                path,
            )
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return [CatalogFragment.model_validate(item) for item in raw]
        except Exception as exc:
            logger.warning("Failed to load component catalog from %s: %s", path, exc)
            return []

    @property
    def devfile_predefined_configs(self) -> list[PredefinedConfig]:
        if self.devfile_predefined_configs_dir is None:
            return []

        configs_dir = self.devfile_predefined_configs_dir
        if not configs_dir.is_absolute():
            configs_dir = Path.cwd() / configs_dir

        if not configs_dir.is_dir():
            logger.warning(
                "DEVFILE_PREDEFINED_CONFIGS_DIR points to a non-existent directory: %s",
                configs_dir,
            )
            return []

        try:
            import yaml  # type: ignore[import]
        except ImportError:
            logger.warning(
                "PyYAML is not installed — cannot parse predefined devfile configs."
            )
            return []

        results: list[PredefinedConfig] = []
        for path in sorted(configs_dir.glob("*.y*ml")):
            if path.suffix not in {".yaml", ".yml"}:
                continue
            try:
                raw_text = path.read_text(encoding="utf-8")
                devfile = yaml.safe_load(raw_text)
                if not isinstance(devfile, dict):
                    raise ValueError("Top-level value is not a mapping")

                metadata = devfile.get("metadata") or {}
                raw_name = (
                    metadata.get("name")
                    or path.stem.replace("-", " ").replace("_", " ").title()
                )
                description = metadata.get("description", "")

                state = _devfile_to_state(devfile)
                blob = _encode_blob(state)

                results.append(
                    PredefinedConfig(
                        name=raw_name,
                        description=description,
                        blob=blob,
                        yaml_preview=raw_text.strip(),
                    )
                )
                logger.info(
                    "Loaded predefined devfile config: %s (%s)", raw_name, path.name
                )
            except Exception as exc:
                logger.warning(
                    "Skipping %s — could not parse as devfile: %s", path.name, exc
                )

        return results


settings = Settings()
