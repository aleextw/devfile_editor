from pydantic import BaseModel, Field, BeforeValidator
from typing import Annotated, Any

from app.utils.helpers import _parse_json_list


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

    Example
    -------
        {
            "name": "my-app",
            "remote": "https://github.com/org/my-app",
            "revision": "main",
            "description": "Main application repository"
        }
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
    commands: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []


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


JsonStrList = Annotated[list[str], BeforeValidator(_parse_json_list)]
