from typing import Any


def _slugify(value: str) -> str:
    """Replace non-alphanumeric characters with hyphens."""
    return "".join(c if c.isalnum() or c == "-" else "-" for c in value.lower())


def _resolve_field(value: str, value_from: str, cfg: dict[str, Any]) -> str:
    """Return cfg[value_from] if set, otherwise the literal value."""
    return (cfg.get(value_from, "") if value_from else "") or value
