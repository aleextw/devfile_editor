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
    ComponentCatalogItem,
    JsonStrList,
)
from src.app.util.devfile import _encode_blob, _devfile_to_state

logger = logging.getLogger(__name__)


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

    Devfile Configurator
    --------------------
    devfile_predefined_repos_file:
        Path to a JSON file containing the predefined repository catalog shown
        in the devfile configurator picker. See predefined_repos.example.json
        for the expected structure. If unset or the file doesn't exist, no
        predefined repos are shown and only manual URL entry is available.

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

    # ── Devfile Configurator ──────────────────────────────────────────────────

    devfile_predefined_repos_file: Path | None = Field(
        default=None,
        description=(
            "Path to a JSON file containing the predefined repositories shown "
            "in the devfile configurator picker. The file must be a JSON array "
            "of objects — see predefined_repos.example.json for the schema. "
            "Relative paths are resolved from the working directory. "
            "If unset or the file is absent, no predefined repos are shown."
        ),
    )

    devfile_predefined_configs_dir: Path | None = Field(
        default=None,
        description=(
            "Path to a directory containing predefined devfile YAML configurations. "
            "Each .yaml / .yml file in the directory is parsed at startup, converted "
            "to a frontend state blob, and shown as a selectable template in the "
            "configurator sidebar. Relative paths are resolved from the working directory."
        ),
    )

    devfile_predefined_commands_file: Path | None = Field(
        default=None,
        description=(
            "Path to a JSON file containing the predefined commands shown in the "
            "devfile configurator Commands section picker. The file must be a JSON "
            "array of command objects — see predefined_commands.example.json for the "
            "schema. Relative paths are resolved from the working directory."
        ),
    )

    devfile_component_catalog_file: Path | None = Field(
        default=None,
        description=(
            "Path to a JSON file defining the component catalog shown in the "
            "devfile configurator Components section. Each entry describes a bundle "
            "that can be selected to inject env vars, volumes, and endpoints into "
            "the devfile. See component_catalog.example.json for the schema. "
            "If unset, no component catalog is shown."
        ),
    )

    # ── Paths ─────────────────────────────────────────────────────────────────

    base_dir: Path = Field(
        default=Path.cwd(),
        description=(
            "Root directory containing templates and the static/ subdirectory. "
            "Defaults to the directory containing config.py."
        ),
    )

    # ── Derived properties ────────────────────────────────────────────────────

    @property
    def static_dir(self) -> Path:
        """Absolute path to the static assets directory."""
        return self.base_dir / "src" / "site" / "static"

    @property
    def template_dir(self) -> Path:
        """Absolute path to the Jinja2 templates directory (same as base_dir)."""
        return self.base_dir / "src" / "site"

    @property
    def devfile_predefined_repos(self) -> list[PredefinedRepo]:
        """
        Load and return the predefined repositories from the JSON file
        referenced by ``devfile_predefined_repos_file``.

        Returns an empty list if the field is unset, the file does not exist,
        or the file cannot be parsed — errors are logged as warnings rather
        than crashing the application at startup.
        """
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
        """
        Load and return the predefined commands from the JSON file referenced
        by ``devfile_predefined_commands_file``.

        Returns an empty list if the field is unset, the file does not exist,
        or the file cannot be parsed.
        """
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
    def devfile_component_catalog(self) -> list[ComponentCatalogItem]:
        """
        Load and return the component catalog from the JSON file referenced
        by ``devfile_component_catalog_file``.

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
                "DEVFILE_COMPONENT_CATALOG_FILE points to a non-existent file: %s", path
            )
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return [ComponentCatalogItem.model_validate(item) for item in raw]
        except Exception as exc:
            logger.warning("Failed to load component catalog from %s: %s", path, exc)
            return []

    @property
    def devfile_predefined_configs(self) -> list[PredefinedConfig]:
        """
        Scan ``devfile_predefined_configs_dir`` for .yaml / .yml files, parse
        each as a devfile, convert to frontend state, and return a list of
        ``PredefinedConfig`` objects sorted alphabetically by name.

        Files that cannot be parsed are skipped with a warning. Returns an
        empty list if the directory is unset or does not exist.
        """
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
                "PyYAML is not installed — cannot parse predefined devfile configs. "
                "Install it with: pip install pyyaml"
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
