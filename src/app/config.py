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

import base64
import json
import logging
import zlib
from pathlib import Path
from typing import Annotated, Any

from pydantic import BaseModel, BeforeValidator, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _parse_json_list(value: Any) -> list:
    """
    Coerce a value to a list.

    Accepts:
    - An already-parsed list (passed through as-is).
    - A JSON string (e.g. from an env var): '["a", "b"]' or '[{...}, {...}]'
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


# ── Sub-models ────────────────────────────────────────────────────────────────


class PredefinedRepo(BaseModel):
    """
    A repository entry shown in the predefined picker in the devfile
    configurator. Fields mirror the devfile schema Project/GitSource structure.

    Schema mapping
    --------------
    name        → project.name           (required, ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$, max 63)
    remotes     → project.git.remotes    (required, at least one entry)
    revision    → project.git.checkoutFrom.revision  (branch, tag, or commit)
    remote      → project.git.checkoutFrom.remote    (only needed with multiple remotes)
    clone_path  → project.clonePath      (defaults to name if omitted)
    description → UI-only, not written to the devfile

    For the common single-remote case, only ``name``, ``remotes``, and
    optionally ``revision`` need to be specified. The picker UI surfaces
    ``origin`` from ``remotes`` as the display URL.

    Example (single remote)
    -----------------------
        {
            "name": "my-app",
            "remotes": {"origin": "https://github.com/org/my-app"},
            "revision": "main",
            "description": "Main application repository"
        }

    Example (multiple remotes)
    --------------------------
        {
            "name": "my-app",
            "remotes": {
                "origin": "https://github.com/org/my-app",
                "upstream": "https://github.com/upstream/my-app"
            },
            "revision": "main",
            "remote": "origin",
            "description": "Fork with upstream tracking"
        }
    """

    name: str = Field(
        description="Devfile project name. Must match ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ and be ≤63 chars.",
    )
    remotes: dict[str, str] = Field(
        description='Git remotes map, e.g. {"origin": "https://github.com/org/repo"}.',
    )
    revision: str = Field(
        default="main",
        description="Branch, tag, or commit to check out. Maps to git.checkoutFrom.revision.",
    )
    remote: str = Field(
        default="",
        description=(
            "Which remote to use as the checkout source. "
            "Only required when remotes contains more than one entry. "
            "Maps to git.checkoutFrom.remote."
        ),
    )
    clone_path: str = Field(
        default="",
        description="Clone path relative to /projects. Defaults to the project name if empty.",
    )
    description: str = Field(
        default="",
        description="UI-only helper text shown in the predefined repo picker. Not written to the devfile.",
    )


class PredefinedCommand(BaseModel):
    """
    A predefined command entry shown in the Commands section picker.
    All fields mirror the devfile Command schema directly, with two
    additional UI-only fields.

    Required: id, and exactly one of exec / composite / apply.
    UI-only:  display_name (falls back to id), description.
    """

    id: str
    display_name: str = ""
    description: str = ""
    # Exactly one of these must be present (mirrors devfile schema oneOf)
    exec: dict[str, Any] | None = None
    composite: dict[str, Any] | None = None
    apply: dict[str, Any] | None = None


class CatalogField(BaseModel):
    """A configurable field on a component catalog item."""

    key: str
    label: str
    placeholder: str = ""
    type: str = "text"  # "text" | "number"


class CatalogEnvContribution(BaseModel):
    """
    An environment variable contributed by a catalog item.
    ``value`` is a literal string; ``value_from`` is a field key whose
    current value is used. Exactly one should be set.
    """

    name: str
    value: str = ""
    value_from: str = ""  # references a CatalogField.key


class CatalogVolumeContribution(BaseModel):
    """
    A volume component + mount contributed by a catalog item.
    ``name`` is a literal volume name; ``name_from`` + ``name_default``
    derives the name from a field value (slugified when ``slugify=True``).
    """

    name: str = ""
    name_from: str = ""  # references a CatalogField.key
    name_default: str = ""  # fallback when name_from field is empty
    size: str = ""  # literal; empty means no size constraint
    size_from: str = ""  # references a CatalogField.key
    mount_path: str = ""  # literal mount path; defaults to "/<name>"
    path_from: str = ""  # references a CatalogField.key for mount path
    slugify: bool = True  # replace non-alnum chars with "-"


class CatalogEndpointContribution(BaseModel):
    """An endpoint contributed by a catalog item."""

    name: str
    target_port: int = 0
    port_from: str = ""  # references a CatalogField.key
    protocol: str = "tcp"
    exposure: str = "internal"


class CatalogContributions(BaseModel):
    """What a catalog item contributes to the devfile when active."""

    env: list[CatalogEnvContribution] = []
    volumes: list[CatalogVolumeContribution] = []
    endpoints: list[CatalogEndpointContribution] = []


class ComponentCatalogItem(BaseModel):
    """
    A component catalog bundle shown in the Components section.
    When selected, the item's ``contributions`` are merged into the
    generated devfile based on the user's field values.

    The ``contributions`` schema is evaluated generically by both the
    frontend (generateDevfileData) and the backend (_generate_devfile_data),
    replacing the previous hardcoded per-item logic.
    """

    id: str
    name: str
    icon: str = "🧩"
    description: str = ""
    fields: list[CatalogField] = []
    contributions: CatalogContributions = CatalogContributions()


class PredefinedConfig(BaseModel):
    """
    A parsed and encoded predefined devfile configuration, ready to be
    injected into the template. Generated at startup from files in the
    predefined configs directory.

    Attributes
    ----------
    name:
        Display name shown in the sidebar and card heading. Derived from the
        filename (stem, with hyphens/underscores replaced by spaces, title-cased)
        unless a ``metadata.name`` field is present in the devfile.
    description:
        Optional description shown in the expandable card. Derived from
        ``metadata.description`` if present in the devfile.
    blob:
        Base64url-encoded, deflate-raw-compressed frontend state JSON,
        ready to append as ``#c=<blob>`` to the configurator URL.
    """

    name: str
    description: str = ""
    blob: str
    yaml_preview: str = ""


# ── Helpers ───────────────────────────────────────────────────────────────────


def _encode_blob(state: dict[str, Any]) -> str:
    """
    Encode a frontend state dict to the same base64url + deflate-raw format
    produced by the browser's encodeStateToHash() function.

    ``activeComponents`` must be a list (not a set) since sets are not
    JSON-serialisable.
    """
    raw = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    compressed = zlib.compress(raw.encode(), level=9, wbits=-15)
    return (
        base64.b64encode(compressed)
        .decode()
        .replace("+", "-")
        .replace("/", "_")
        .rstrip("=")
    )


def _devfile_to_state(devfile: dict[str, Any]) -> dict[str, Any]:
    """
    Convert a parsed devfile YAML dict into a frontend state object compatible
    with hydrateStateFromParsed() in devfile.js.

    Only the fields that the frontend state shape understands are mapped —
    anything outside that shape is silently ignored.
    """
    # ── Resources from the first container component ───────────────────────────
    resources: dict[str, Any] = {
        "image": "quay.io/devfile/universal-developer-image:latest",
        "name": "dev",
        "sourceMapping": "/projects",
        "mountSources": True,
        "dedicatedPod": False,
        "cpuRequest": "",
        "cpuLimit": "",
        "memRequest": "",
        "memLimit": "",
    }
    endpoints: list[dict] = []
    custom_env: list[dict] = []
    volumes: list[dict] = []

    for comp in devfile.get("components") or []:
        ct = comp.get("container")
        if not ct:
            continue
        resources.update(
            {
                "name": comp.get("name", "dev"),
                "image": ct.get("image", resources["image"]),
                "sourceMapping": ct.get("sourceMapping", "/projects"),
                "mountSources": ct.get("mountSources", True),
                "dedicatedPod": ct.get("dedicatedPod", False),
                "cpuRequest": ct.get("cpuRequest", ""),
                "cpuLimit": ct.get("cpuLimit", ""),
                "memRequest": ct.get("memoryRequest", ""),
                "memLimit": ct.get("memoryLimit", ""),
            }
        )
        for ep in ct.get("endpoints") or []:
            endpoints.append(
                {
                    "name": ep.get("name", ""),
                    "targetPort": ep.get("targetPort", 0),
                    "protocol": ep.get("protocol", "http"),
                    "exposure": ep.get("exposure", "public"),
                }
            )
        for env in ct.get("env") or []:
            custom_env.append(
                {"name": env.get("name", ""), "value": env.get("value", "")}
            )
        break  # only read the first container component

    for comp in devfile.get("components") or []:
        if "volume" in comp:
            vol = comp["volume"]
            # Find corresponding volumeMount for the mountPath
            mount_path = ""
            for c2 in devfile.get("components") or []:
                ct2 = c2.get("container")
                if not ct2:
                    continue
                for vm in ct2.get("volumeMounts") or []:
                    if vm.get("name") == comp.get("name"):
                        mount_path = vm.get("path", "")
                        break
            volumes.append(
                {
                    "name": comp.get("name", ""),
                    "size": vol.get("size", ""),
                    "mountPath": mount_path,
                }
            )

    # ── Projects ───────────────────────────────────────────────────────────────
    repos: list[dict] = []
    for p in devfile.get("projects") or []:
        git = p.get("git") or {}
        repos.append(
            {
                "name": p.get("name", ""),
                "remotes": git.get("remotes") or {},
                "revision": (git.get("checkoutFrom") or {}).get("revision", "main"),
                "remote": (git.get("checkoutFrom") or {}).get("remote", ""),
                "clonePath": p.get("clonePath", p.get("name", "")),
            }
        )

    starters: list[dict] = []
    for s in devfile.get("starterProjects") or []:
        git = s.get("git") or {}
        starters.append(
            {
                "name": s.get("name", ""),
                "remotes": git.get("remotes") or {},
                "revision": (git.get("checkoutFrom") or {}).get("revision", "main"),
                "remote": (git.get("checkoutFrom") or {}).get("remote", ""),
            }
        )

    # ── Commands ───────────────────────────────────────────────────────────────
    commands: list[dict] = []
    for c in devfile.get("commands") or []:
        if not c.get("id"):
            continue
        cmd: dict = {"id": c["id"]}
        if "exec" in c:
            cmd["type"] = "exec"
            ex = c["exec"]
            cmd["exec"] = {
                "commandLine": ex.get("commandLine", ""),
                "component": ex.get("component", ""),
                "workingDir": ex.get("workingDir", ""),
                "label": ex.get("label", ""),
                "hotReloadCapable": ex.get("hotReloadCapable", False),
                "env": ex.get("env", []),
                "group": ex.get("group") or {"kind": "run", "isDefault": False},
            }
        elif "composite" in c:
            cmd["type"] = "composite"
            cp = c["composite"]
            cmd["composite"] = {
                "commands": cp.get("commands", []),
                "parallel": cp.get("parallel", False),
                "label": cp.get("label", ""),
                "group": cp.get("group") or {"kind": "run", "isDefault": False},
            }
        elif "apply" in c:
            cmd["type"] = "apply"
            ap = c["apply"]
            cmd["apply"] = {
                "component": ap.get("component", ""),
                "label": ap.get("label", ""),
                "group": ap.get("group") or {"kind": "run", "isDefault": False},
            }
        else:
            continue
        commands.append(cmd)

    # ── Events ─────────────────────────────────────────────────────────────────
    raw_events = devfile.get("events") or {}
    events: dict = {
        "preStart": raw_events.get("preStart", []),
        "postStart": raw_events.get("postStart", []),
        "preStop": raw_events.get("preStop", []),
        "postStop": raw_events.get("postStop", []),
    }

    return {
        "repos": repos,
        "starters": starters,
        "resources": resources,
        "endpoints": endpoints,
        "customEnv": custom_env,
        "volumes": volumes,
        "activeComponents": [],
        "componentConfigs": {},
        "commands": commands,
        "events": events,
    }


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
            log.warning(
                "DEVFILE_PREDEFINED_REPOS_FILE points to a non-existent file: %s", path
            )
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return [PredefinedRepo.model_validate(item) for item in raw]
        except Exception as exc:
            log.warning("Failed to load predefined repos from %s: %s", path, exc)
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
            log.warning(
                "DEVFILE_PREDEFINED_COMMANDS_FILE points to a non-existent file: %s",
                path,
            )
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return [PredefinedCommand.model_validate(item) for item in raw]
        except Exception as exc:
            log.warning("Failed to load predefined commands from %s: %s", path, exc)
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
            log.warning(
                "DEVFILE_COMPONENT_CATALOG_FILE points to a non-existent file: %s", path
            )
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return [ComponentCatalogItem.model_validate(item) for item in raw]
        except Exception as exc:
            log.warning("Failed to load component catalog from %s: %s", path, exc)
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
            log.warning(
                "DEVFILE_PREDEFINED_CONFIGS_DIR points to a non-existent directory: %s",
                configs_dir,
            )
            return []

        try:
            import yaml  # type: ignore[import]
        except ImportError:
            log.warning(
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
                log.info(
                    "Loaded predefined devfile config: %s (%s)", raw_name, path.name
                )
            except Exception as exc:
                log.warning(
                    "Skipping %s — could not parse as devfile: %s", path.name, exc
                )

        return results


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

# ── Eager startup loading ──────────────────────────────────────────────────────
# Parse predefined configs at import time so any errors appear in startup logs
# rather than on the first request. The results are cached on the module-level
# dict below and served directly from the controller.
PREDEFINED_CONFIGS: list[PredefinedConfig] = settings.devfile_predefined_configs
