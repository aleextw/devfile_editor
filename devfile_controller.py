"""
Devfile Configurator Controller
================================
Serves a Jinja2-rendered chat assistant at / and the devfile configurator at
/devfile, plus a /raw endpoint that decodes a compressed state blob and returns
the corresponding devfile as text/yaml.

Routes
------
GET  /               → renders chat.html (Jinja2 template)
GET  /devfile        → renders index.html (Jinja2 template)
GET  /raw            → decodes ?c=<blob> and returns text/yaml
GET  /static/<file>  → served via Litestar StaticFilesConfig (see Usage below)

The blob format (produced by the frontend) is:
    base64url( deflate-raw( JSON.stringify(state) ) )

where `state` is the full configurator state object. This module mirrors the
generateDevfileData() logic from static/devfile.js so both produce identical
output.

Configuration
-------------
All user-facing text and path settings live in config.py, loaded from
environment variables or a .env file via pydantic-settings. See config.py
and .env.example for the full list of available options.

Usage
-----
Register the controller, template engine, and static file serving with your
Litestar app:

    from litestar import Litestar
    from litestar.contrib.jinja import JinjaTemplateEngine
    from litestar.template.config import TemplateConfig
    from litestar.static_files import StaticFilesConfig
    from .config import settings
    from .devfile_controller import DevfileController

    app = Litestar(
        route_handlers=[DevfileController],
        template_config=TemplateConfig(
            directory=settings.template_dir,
            engine=JinjaTemplateEngine,
        ),
        static_files_config=[
            StaticFilesConfig(
                directories=[settings.static_dir],
                path="/static",
            ),
        ],
    )

Directory layout expected
-------------------------
<BASE_DIR>/
  chat.html          ← Jinja2 template
  index.html         ← Jinja2 template
  _navbar.html       ← Jinja2 partial
  static/
    base.css
    navbar.css
    chat.css
    chat.js
    devfile.css
    devfile.js
"""

from __future__ import annotations

import base64
import zlib
from pathlib import Path
from typing import Any

from litestar import Controller, get
from litestar.exceptions import HTTPException
from litestar.response import Redirect, Response, Template

from .config import settings

# ── Base directory ────────────────────────────────────────────────────────────
# Resolved from settings so the controller never reads env vars directly.
# Templates (chat.html, index.html, _navbar.html) live here.
# Static assets (CSS/JS) live under BASE_DIR / "static".

BASE_DIR: Path = settings.base_dir

# ── Blob decode ────────────────────────────────────────────────────────────────

def _decode_blob(blob: str) -> dict[str, Any]:
    """
    Decode a base64url + deflate-raw compressed state blob produced by the
    frontend's encodeStateToHash() function.

    Raises ValueError with a human-readable message on any failure so callers
    can surface it as a 400 without leaking internal tracebacks.
    """
    # base64url → standard base64
    padded = blob.replace("-", "+").replace("_", "/")
    padding = (4 - len(padded) % 4) % 4
    padded += "=" * padding

    try:
        compressed = base64.b64decode(padded)
    except Exception as exc:
        raise ValueError(f"Invalid base64 encoding: {exc}") from exc

    try:
        # wbits=-15 = raw deflate (no zlib/gzip header), matching
        # the browser's DecompressionStream('deflate-raw')
        raw_json = zlib.decompress(compressed, wbits=-15)
    except zlib.error as exc:
        raise ValueError(f"Decompression failed: {exc}") from exc

    try:
        return json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in decoded blob: {exc}") from exc


# ── YAML generation ────────────────────────────────────────────────────────────
# Mirrors generateDevfileData() in index.html. Keep in sync when the frontend
# logic changes.

#: Env var keys injected by the component catalog bundles
_CATALOG_ENV_KEYS: frozenset[str] = frozenset({
    "GIT_USER_NAME", "GIT_USER_EMAIL",
    "NODE_VERSION",
    "JAVA_VERSION", "MAVEN_OPTS",
    "PYTHON_VERSION", "VIRTUAL_ENV",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
})


def _generate_devfile_data(state: dict[str, Any]) -> dict[str, Any]:
    resources: dict[str, Any] = state.get("resources") or {}
    active: set[str] = set(state.get("activeComponents") or [])
    configs: dict[str, Any] = state.get("componentConfigs") or {}

    # ── Environment variables ──────────────────────────────────────────────────
    env_vars: list[dict] = []
    for e in state.get("customEnv") or []:
        if e.get("name"):
            env_vars.append({"name": e["name"], "value": e.get("value", "")})
    for comp_id in active:
        cfg = configs.get(comp_id) or {}
        for key, val in cfg.items():
            if key in _CATALOG_ENV_KEYS and val:
                env_vars.append({"name": key, "value": val})

    # ── Volume components + mounts ─────────────────────────────────────────────
    vol_components: list[dict] = []
    vol_mounts: list[dict] = []

    for v in state.get("volumes") or []:
        name = v.get("name", "").strip()
        if not name:
            continue
        vol_def: dict = {}
        if v.get("size"):
            vol_def["size"] = v["size"]
        vol_components.append({"name": name, "volume": vol_def})
        vol_mounts.append({"name": name, "path": v.get("mountPath") or f"/{name}"})

    if "docker-in-docker" in active:
        cfg = configs.get("docker-in-docker") or {}
        vol_components.append({
            "name": "dind-storage",
            "volume": {"size": cfg.get("dind-vol-size") or "10Gi"},
        })
        vol_mounts.append({"name": "dind-storage", "path": "/var/lib/docker"})

    if "node-version" in active:
        cfg = configs.get("node-version") or {}
        vname = (cfg.get("npm-cache-vol") or "npm-cache").lower()
        vname = "".join(c if c.isalnum() or c == "-" else "-" for c in vname)
        if vname:
            vol_components.append({"name": vname, "volume": {}})
            vol_mounts.append({"name": vname, "path": "/root/.npm"})

    if "shared-volume" in active:
        cfg = configs.get("shared-volume") or {}
        vname = (cfg.get("shared-vol-name") or "shared-data").lower()
        vname = "".join(c if c.isalnum() or c == "-" else "-" for c in vname)
        if vname:
            vol_def = {}
            if cfg.get("shared-vol-size"):
                vol_def["size"] = cfg["shared-vol-size"]
            vol_components.append({"name": vname, "volume": vol_def})
            vol_mounts.append({
                "name": vname,
                "path": cfg.get("shared-vol-path") or "/shared",
            })

    # ── Endpoints ──────────────────────────────────────────────────────────────
    endpoints: list[dict] = [
        ep for ep in (state.get("endpoints") or [])
        if ep.get("name") and ep.get("targetPort")
    ]
    if "debug-port" in active:
        cfg = configs.get("debug-port") or {}
        try:
            port = int(cfg.get("debug-port") or 5005)
        except (TypeError, ValueError):
            port = 5005
        endpoints.append({
            "name": "debug",
            "targetPort": port,
            "protocol": "tcp",
            "exposure": "internal",
        })

    # ── Main container component ───────────────────────────────────────────────
    container: dict[str, Any] = {
        "image": resources.get("image") or "quay.io/devfile/universal-developer-image:latest",
        "mountSources": resources.get("mountSources", True) is not False,
    }
    if resources.get("cpuRequest"):
        container["cpuRequest"] = resources["cpuRequest"]
    if resources.get("cpuLimit"):
        container["cpuLimit"] = resources["cpuLimit"]
    if resources.get("memRequest"):
        container["memoryRequest"] = resources["memRequest"]
    if resources.get("memLimit"):
        container["memoryLimit"] = resources["memLimit"]
    if resources.get("sourceMapping"):
        container["sourceMapping"] = resources["sourceMapping"]
    if resources.get("dedicatedPod"):
        container["dedicatedPod"] = True
    if env_vars:
        container["env"] = env_vars
    if endpoints:
        container["endpoints"] = endpoints
    if vol_mounts:
        container["volumeMounts"] = vol_mounts

    container_component: dict[str, Any] = {
        "name": resources.get("name") or "dev",
        "container": container,
    }
    components = [container_component, *vol_components]

    # ── Projects ───────────────────────────────────────────────────────────────
    projects = []
    for r in state.get("repos") or []:
        if not (r.get("name") and r.get("remote")):
            continue
        git: dict[str, Any] = {"remotes": {"origin": r["remote"]}}
        if r.get("branch") and r["branch"] != "main":
            git["checkoutFrom"] = {"revision": r["branch"]}
        proj: dict[str, Any] = {"name": r["name"], "git": git}
        if r.get("clonePath") and r["clonePath"] != r["name"]:
            proj["clonePath"] = r["clonePath"]
        projects.append(proj)

    starter_projects = []
    for s in state.get("starters") or []:
        if not (s.get("name") and s.get("remote")):
            continue
        git = {"remotes": {"origin": s["remote"]}}
        if s.get("branch") and s["branch"] != "main":
            git["checkoutFrom"] = {"revision": s["branch"]}
        starter_projects.append({"name": s["name"], "git": git})

    # ── Assemble ───────────────────────────────────────────────────────────────
    devfile: dict[str, Any] = {
        "schemaVersion": "2.3.0",
        "components": components,
    }
    if projects:
        devfile["projects"] = projects
    if starter_projects:
        devfile["starterProjects"] = starter_projects

    return devfile


def _to_yaml(data: Any, indent: int = 0) -> str:
    """
    Minimal YAML emitter for the devfile data structure.
    Handles mappings, sequences, strings, ints, booleans, and None.
    Avoids a PyYAML dependency — if PyYAML is already in your stack,
    replace this with yaml.dump(data, default_flow_style=False, allow_unicode=True).
    """
    pad = "  " * indent

    if data is None:
        return "null"
    if isinstance(data, bool):
        return "true" if data else "false"
    if isinstance(data, int):
        return str(data)
    if isinstance(data, float):
        return str(data)

    if isinstance(data, str):
        # Determine whether quoting is needed
        _NEEDS_QUOTE_PREFIXES = tuple('-?:,[]{}#&*!|>\'"%@`')
        _BOOL_LIKE = {"true", "false", "null", "yes", "no", "on", "off"}
        needs_quote = (
            data == ""
            or "\n" in data or "\r" in data or "\t" in data
            or data.startswith(_NEEDS_QUOTE_PREFIXES)
            or data.lower() in _BOOL_LIKE
            or data[0].isdigit()
            or ": " in data
            or " #" in data
            or data != data.strip()
        )
        if needs_quote:
            escaped = data.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
            return f'"{escaped}"'
        return data

    if isinstance(data, list):
        if not data:
            return "[]"
        lines: list[str] = []
        for item in data:
            if isinstance(item, dict) and item:
                keys = list(item.keys())
                first_val = _to_yaml(item[keys[0]], indent + 1)
                line = f"{pad}- {keys[0]}: {first_val}"
                for k in keys[1:]:
                    v = item[k]
                    if isinstance(v, (dict, list)):
                        inner = _to_yaml(v, indent + 2)
                        line += f"\n{pad}  {k}:\n" + "\n".join(
                            "  " + l for l in inner.split("\n")
                        )
                    else:
                        line += f"\n{pad}  {k}: {_to_yaml(v, indent + 1)}"
                lines.append(line)
            else:
                lines.append(f"{pad}- {_to_yaml(item, indent + 1)}")
        return "\n".join(lines)

    if isinstance(data, dict):
        if not data:
            return "{}"
        lines = []
        for k, v in data.items():
            if isinstance(v, (dict, list)):
                inner = _to_yaml(v, indent + 1)
                if inner in ("{}", "[]"):
                    lines.append(f"{pad}{k}: {inner}")
                else:
                    lines.append(f"{pad}{k}:\n{inner}")
            else:
                lines.append(f"{pad}{k}: {_to_yaml(v, indent)}")
        return "\n".join(lines)

    return str(data)


# ── Controller ─────────────────────────────────────────────────────────────────

class DevfileController(Controller):
    """
    Serves the chat assistant, devfile configurator, and /raw YAML endpoint.

    Requires a Jinja2 TemplateConfig pointed at BASE_DIR and a StaticFilesConfig
    pointed at BASE_DIR / "static" — see module docstring for the full setup.
    """

    path = "/"

    # ── GET / ──────────────────────────────────────────────────────────────────

    @get("/")
    def chat(self) -> Template:
        """Render the chat assistant page from chat.html via Jinja2."""
        return Template(
            template_name="chat.html",
            context={
                "team_name":         settings.chat_team_name,
                "logo_text":         settings.chat_logo_text,
                "tagline":           settings.chat_tagline,
                "welcome_message":   settings.chat_welcome_message,
                "input_placeholder": settings.chat_input_placeholder,
                "suggestions":       settings.chat_suggestions,
                "active_page":       "chat",
                "header_actions":    "",
            },
        )

    # ── GET /devfile ───────────────────────────────────────────────────────────

    @get("/devfile")
    def devfile(self) -> Template:
        """Render the devfile configurator page from index.html via Jinja2."""
        devfile_actions = (
            '<button class="btn btn-ghost btn-sm" id="import-btn">⬆ Import YAML</button>'
            '<button class="btn btn-primary btn-sm" id="generate-btn">⬇ Generate &amp; Export</button>'
        )
        return Template(
            template_name="index.html",
            context={
                "team_name":      settings.chat_team_name,
                "logo_text":      settings.chat_logo_text,
                "active_page":    "devfile",
                "header_actions": devfile_actions,
            },
        )

    # ── GET /raw ───────────────────────────────────────────────────────────────

    @get("/raw", sync_to_thread=True)
    def raw(self, c: str | None = None) -> Response[str] | Redirect:
        """
        Decode a compressed state blob and return the devfile as text/yaml.

        Parameters
        ----------
        c:
            base64url-encoded, deflate-raw-compressed JSON state blob,
            as produced by the configurator frontend. If absent or malformed,
            redirects back to / (the chat page).

        Returns
        -------
        Response
            Content-Type: text/yaml with the generated devfile YAML.

        Redirect
            Back to / if `c` is missing or cannot be decoded.
        """
        if not c:
            return Redirect(path="/")

        try:
            state = _decode_blob(c)
        except ValueError:
            return Redirect(path="/")

        devfile_data = _generate_devfile_data(state)

        try:
            import yaml  # type: ignore[import]
            yaml_str = yaml.dump(
                devfile_data,
                default_flow_style=False,
                allow_unicode=True,
                sort_keys=False,
            )
        except ImportError:
            yaml_str = _to_yaml(devfile_data) + "\n"

        return Response(
            content=yaml_str,
            media_type="text/yaml",
            headers={
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            },
        )