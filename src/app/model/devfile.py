from pydantic import BaseModel, Field, BeforeValidator
from typing import Annotated, Any

from app.util.devfile import _parse_json_list


class PredefinedRepo(BaseModel):
    """
    A repository entry shown in the predefined picker in the devfile configurator.

    Schema mapping
    --------------
    name        → project.name           (required, ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$, max 63)
    remote      → project.git.remotes.origin  (the single origin URL)
    revision    → project.git.checkoutFrom.revision  (branch, tag, or commit)
    clone_path  → project.clonePath      (defaults to name if omitted)
    description → UI-only, not written to the devfile
    """

    name: str = Field(
        description="Devfile project name. Must match ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ and be ≤63 chars.",
    )
    remote: str = Field(
        description="Git remote URL (the origin). Maps to project.git.remotes.origin.",
    )
    revision: str = Field(
        default="main",
        description="Branch, tag, or commit to check out. Maps to git.checkoutFrom.revision.",
    )
    clone_path: str = Field(
        default="",
        description="Clone path relative to /projects. Defaults to the project name if empty.",
    )
    description: str = Field(
        default="",
        description="UI-only helper text shown in the predefined repo picker.",
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
    exec: dict[str, Any] | None = None
    composite: dict[str, Any] | None = None
    apply: dict[str, Any] | None = None


class CatalogFragment(BaseModel):
    """
    A catalog preset entry shown in the fragment catalog picker.

    Each entry is a named, reusable partial devfile that users can add as a
    fragment to their workspace configuration.  When the user clicks the preset,
    a deep copy of ``devfile`` is added to ``store.devfile.fragments`` and merged
    into the base devfile on export.

    The ``devfile`` dict may contain any subset of the top-level devfile fields:
    ``components``, ``commands``, ``events``, ``variables``, ``attributes``,
    ``projects``, ``starterProjects``.  It must NOT contain ``schemaVersion`` or
    ``metadata`` (those belong only to the base).

    Example catalog JSON entry
    --------------------------
    {
      "id": "docker-in-docker",
      "name": "Docker-in-Docker",
      "icon": "🐳",
      "description": "Add a DinD volume for container builds inside the workspace.",
      "devfile": {
        "components": [
          { "name": "dind-storage", "volume": { "size": "10Gi" } }
        ],
        "commands": [
          {
            "id": "start-dind",
            "exec": {
              "commandLine": "dockerd &",
              "component": "dev",
              "group": { "kind": "run", "isDefault": false }
            }
          }
        ]
      }
    }
    """

    id: str = Field(description="Unique identifier for this catalog entry.")
    name: str = Field(description="Human-readable display name.")
    icon: str = Field(
        default="🧩", description="Emoji or short string used as a visual icon."
    )
    description: str = Field(
        default="", description="Short description shown in the picker."
    )
    devfile: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Partial devfile fragment. May contain components, commands, events, "
            "variables, attributes, projects, and/or starterProjects. "
            "schemaVersion and metadata are ignored if present."
        ),
    )


class PredefinedConfig(BaseModel):
    """
    A parsed and encoded predefined devfile configuration, ready to be
    injected into the template. Generated at startup from files in the
    predefined configs directory.
    """

    name: str
    description: str = ""
    blob: str
    yaml_preview: str = ""


JsonStrList = Annotated[list[str], BeforeValidator(_parse_json_list)]
