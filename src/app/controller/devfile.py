from __future__ import annotations

import yaml

from litestar import Controller, Request, get
from litestar.response import Redirect, Response, Template

from app.core.config import settings
from app.util.devfile import _decode_blob
from app.service.devfile import _generate_devfile_data


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
                "predefined_configs": [
                    cfg.model_dump() for cfg in settings.devfile_predefined_configs
                ],
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

        try:
            devfile_data = _generate_devfile_data(state)
        except ValueError as exc:
            # Catalog contribution errors (e.g. command ID conflicts) — return
            # a plain-text 409 so operators can diagnose the problem clearly.
            return Response(
                content=f"Error generating devfile:\n\n{exc}\n",
                media_type="text/plain",
                status_code=409,
                headers={"Cache-Control": "no-store"},
            )

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
