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

from litestar import Controller, Request, get
from litestar.response import Redirect, Response, Template
import json
import yaml

from app.config import settings, PREDEFINED_CONFIGS

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


def _slugify(value: str) -> str:
    """Replace non-alphanumeric characters with hyphens."""
    return "".join(c if c.isalnum() or c == "-" else "-" for c in value.lower())


def _apply_catalog_contributions(
    active: set[str],
    configs: dict[str, Any],
    catalog: list,  # list[ComponentCatalogItem]
    env_vars: list[dict],
    vol_components: list[dict],
    vol_mounts: list[dict],
    endpoints: list[dict],
) -> None:
    """
    Evaluate each active catalog item's contributions and append the results
    to the provided lists. Operates in-place.
    """
    for item in catalog:
        if item.id not in active:
            continue
        cfg = configs.get(item.id) or {}

        for env in item.contributions.env:
            value = env.value or (cfg.get(env.value_from, "") if env.value_from else "")
            if value:
                env_vars.append({"name": env.name, "value": value})

        for vol in item.contributions.volumes:
            if vol.name:
                vname = vol.name
            elif vol.name_from:
                raw = cfg.get(vol.name_from, "") or vol.name_default
                vname = _slugify(raw) if vol.slugify else raw
            else:
                vname = ""
            if not vname:
                continue

            size = vol.size or (cfg.get(vol.size_from, "") if vol.size_from else "")
            vol_def: dict[str, Any] = {}
            if size:
                vol_def["size"] = size
            vol_components.append({"name": vname, "volume": vol_def})
            mount = (
                (cfg.get(vol.path_from, "") if vol.path_from else "")
                or vol.mount_path
                or f"/{vname}"
            )
            vol_mounts.append({"name": vname, "path": mount})

        for ep in item.contributions.endpoints:
            if ep.port_from:
                try:
                    port = int(cfg.get(ep.port_from) or ep.target_port or 0)
                except (TypeError, ValueError):
                    port = ep.target_port
            else:
                port = ep.target_port
            if port:
                endpoints.append(
                    {
                        "name": ep.name,
                        "targetPort": port,
                        "protocol": ep.protocol,
                        "exposure": ep.exposure,
                    }
                )


def _generate_devfile_data(state: dict[str, Any]) -> dict[str, Any]:
    resources: dict[str, Any] = state.get("resources") or {}
    active: set[str] = set(state.get("activeComponents") or [])
    configs: dict[str, Any] = state.get("componentConfigs") or {}

    # ── Environment variables ──────────────────────────────────────────────────
    env_vars: list[dict] = []
    for e in state.get("customEnv") or []:
        if e.get("name"):
            env_vars.append({"name": e["name"], "value": e.get("value", "")})

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

    # ── Endpoints ──────────────────────────────────────────────────────────────
    endpoints: list[dict] = [
        ep
        for ep in (state.get("endpoints") or [])
        if ep.get("name") and ep.get("targetPort")
    ]

    # ── Catalog contributions (generic, data-driven) ───────────────────────────
    _apply_catalog_contributions(
        active,
        configs,
        settings.devfile_component_catalog,
        env_vars,
        vol_components,
        vol_mounts,
        endpoints,
    )

    # ── Main container component ───────────────────────────────────────────────
    container: dict[str, Any] = {
        "image": resources.get("image")
        or "quay.io/devfile/universal-developer-image:latest",
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
        remotes: dict = r.get("remotes") or {}
        # Must have a name and at least one non-empty remote URL
        if not r.get("name") or not any(remotes.values()):
            continue
        checkout_from: dict[str, str] = {}
        if r.get("revision") and r["revision"] != "main":
            checkout_from["revision"] = r["revision"]
        if r.get("remote"):
            checkout_from["remote"] = r["remote"]
        git: dict[str, Any] = {"remotes": remotes}
        if checkout_from:
            git["checkoutFrom"] = checkout_from
        proj: dict[str, Any] = {"name": r["name"], "git": git}
        if r.get("clonePath") and r["clonePath"] != r["name"]:
            proj["clonePath"] = r["clonePath"]
        projects.append(proj)

    starter_projects = []
    for s in state.get("starters") or []:
        remotes = s.get("remotes") or {}
        if not s.get("name") or not any(remotes.values()):
            continue
        checkout_from = {}
        if s.get("revision") and s["revision"] != "main":
            checkout_from["revision"] = s["revision"]
        if s.get("remote"):
            checkout_from["remote"] = s["remote"]
        git = {"remotes": remotes}
        if checkout_from:
            git["checkoutFrom"] = checkout_from
        starter_projects.append({"name": s["name"], "git": git})

    # ── Commands ───────────────────────────────────────────────────────────────
    commands = []
    for c in state.get("commands") or []:
        if not c.get("id"):
            continue
        entry: dict[str, Any] = {"id": c["id"]}
        cmd_type = c.get("type")
        if cmd_type == "exec" and c.get("exec"):
            ex = c["exec"]
            exec_obj: dict[str, Any] = {
                "commandLine": ex.get("commandLine", ""),
                "component": ex.get("component", ""),
            }
            if ex.get("workingDir"):
                exec_obj["workingDir"] = ex["workingDir"]
            if ex.get("label"):
                exec_obj["label"] = ex["label"]
            if ex.get("hotReloadCapable"):
                exec_obj["hotReloadCapable"] = True
            if ex.get("env"):
                exec_obj["env"] = ex["env"]
            if ex.get("group") and ex["group"].get("kind"):
                exec_obj["group"] = {
                    "kind": ex["group"]["kind"],
                    "isDefault": bool(ex["group"].get("isDefault")),
                }
            entry["exec"] = exec_obj
        elif cmd_type == "composite" and c.get("composite"):
            cp = c["composite"]
            comp_obj: dict[str, Any] = {}
            if cp.get("commands"):
                comp_obj["commands"] = cp["commands"]
            if cp.get("parallel"):
                comp_obj["parallel"] = True
            if cp.get("label"):
                comp_obj["label"] = cp["label"]
            if cp.get("group") and cp["group"].get("kind"):
                comp_obj["group"] = {
                    "kind": cp["group"]["kind"],
                    "isDefault": bool(cp["group"].get("isDefault")),
                }
            entry["composite"] = comp_obj
        elif cmd_type == "apply" and c.get("apply"):
            ap = c["apply"]
            apply_obj: dict[str, Any] = {"component": ap.get("component", "")}
            if ap.get("label"):
                apply_obj["label"] = ap["label"]
            if ap.get("group") and ap["group"].get("kind"):
                apply_obj["group"] = {
                    "kind": ap["group"]["kind"],
                    "isDefault": bool(ap["group"].get("isDefault")),
                }
            entry["apply"] = apply_obj
        else:
            continue
        commands.append(entry)

    # ── Events ─────────────────────────────────────────────────────────────────
    raw_events = state.get("events") or {}
    events_obj: dict[str, Any] = {}
    for key in ("preStart", "postStart", "preStop", "postStop"):
        ids = [i for i in (raw_events.get(key) or []) if i]
        if ids:
            events_obj[key] = ids

    # ── Assemble ───────────────────────────────────────────────────────────────
    devfile: dict[str, Any] = {
        "schemaVersion": "2.3.0",
        "components": components,
    }
    if projects:
        devfile["projects"] = projects
    if starter_projects:
        devfile["starterProjects"] = starter_projects
    if commands:
        devfile["commands"] = commands
    if events_obj:
        devfile["events"] = events_obj

    return devfile


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
    async def chat(self) -> Template:
        """Render the chat assistant page from chat.html via Jinja2."""
        return Template(
            template_name="chat.html",
            context={
                "team_name": settings.chat_team_name,
                "logo_text": settings.chat_logo_text,
                "tagline": settings.chat_tagline,
                "welcome_message": settings.chat_welcome_message,
                "input_placeholder": settings.chat_input_placeholder,
                "suggestions": settings.chat_suggestions,
                "active_page": "chat",
                "header_actions": "",
            },
        )

    # ── GET /devfile ───────────────────────────────────────────────────────────

    @get("/devfile")
    async def devfile(self, request: Request) -> Template:
        """Render the devfile configurator page from index.html via Jinja2."""
        devfile_actions = (
            '<button class="btn btn-ghost btn-sm" id="import-btn">⬆ Import YAML</button>'
            '<button class="btn btn-primary btn-sm" id="generate-btn">⬇ Generate &amp; Export</button>'
        )
        base_url = str(request.base_url).rstrip("/")
        return Template(
            template_name="index.html",
            context={
                "team_name": settings.chat_team_name,
                "logo_text": settings.chat_logo_text,
                "active_page": "devfile",
                "header_actions": devfile_actions,
                "base_url": base_url,
                "predefined_repos": [
                    repo.model_dump() for repo in settings.devfile_predefined_repos
                ],
                "predefined_configs": [cfg.model_dump() for cfg in PREDEFINED_CONFIGS],
                "predefined_commands": [
                    cmd.model_dump() for cmd in settings.devfile_predefined_commands
                ],
                "component_catalog": [
                    item.model_dump() for item in settings.devfile_component_catalog
                ],
            },
        )

    # ── GET /raw ───────────────────────────────────────────────────────────────

    @get("/raw")
    async def raw(self, c: str | None = None) -> Response[str] | Redirect:
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

        yaml_str = yaml.dump(
            devfile_data,
            default_flow_style=False,
            allow_unicode=True,
            sort_keys=False,
        )

        return Response(
            content=yaml_str,
            media_type="text/yaml",
            headers={
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            },
        )
