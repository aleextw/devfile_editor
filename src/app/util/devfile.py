from typing import Any
import json
import zlib
import base64


def _encode_blob(state: dict[str, Any]) -> str:
    """
    Encode a frontend state dict to the same base64url + deflate-raw format
    produced by the browser's encodeStateToHash() function.

    The state dict must be JSON-serialisable (no sets, no non-JSON types).
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


def _devfile_to_state(devfile: dict[str, Any]) -> dict[str, Any]:
    """
    Convert a parsed devfile YAML dict into a frontend state object compatible
    with the Alpine store shape defined in store.js / hydrateFromHash().

    The store shape is:
      {
        schemaVersion:    str,
        metadata:         { name, displayName, description, version, language,
                            projectType, provider, supportUrl, website, icon,
                            tags, architectures, attributes },
        variables:        { key: value, … },
        attributes:       { key: value, … },
        components:       [ { name, container: { image, mountSources, sourceMapping,
                              dedicatedPod, cpuRequest, cpuLimit, memoryRequest,
                              memoryLimit, args, command, annotation,
                              env, endpoints, volumeMounts } } ],
        projects:         [ { name, git: { remotes: { origin }, checkoutFrom: { revision } },
                              clonePath, attributes } ],
        starterProjects:  [ { name, git: { remotes: { origin }, checkoutFrom: { revision } } } ],
        commands:         [ { id, type, attributes, exec? | composite? | apply? } ],
        events:           { preStart, postStart, preStop, postStop },

        # Flat UI helpers (assembled into the devfile on export by buildDevfileData)
        customEnv:        [ { name, value } ],
        endpoints:        [ { name, targetPort, protocol, exposure,
                              secure, path, annotation } ],
        volumes:          [ { name, size, mountPath, ephemeral } ],

        # Fragment list — always empty for predefined config blobs
        fragments: [],
      }

    Only the fields that the frontend store understands are mapped; anything
    outside that shape is silently ignored.
    """

    # ── Metadata ──────────────────────────────────────────────────────────────
    raw_meta = devfile.get("metadata") or {}
    metadata: dict[str, Any] = {
        "name": raw_meta.get("name", ""),
        "displayName": raw_meta.get("displayName", ""),
        "description": raw_meta.get("description", ""),
        "version": raw_meta.get("version", ""),
        "language": raw_meta.get("language", ""),
        "projectType": raw_meta.get("projectType", ""),
        "provider": raw_meta.get("provider", ""),
        "supportUrl": raw_meta.get("supportUrl", ""),
        "website": raw_meta.get("website", ""),
        "icon": raw_meta.get("icon", ""),
        "tags": list(raw_meta.get("tags") or []),
        "architectures": list(raw_meta.get("architectures") or []),
        "attributes": dict(raw_meta.get("attributes") or {}),
    }

    # ── Top-level variables and attributes ────────────────────────────────────
    variables: dict[str, str] = dict(devfile.get("variables") or {})
    attributes: dict[str, Any] = dict(devfile.get("attributes") or {})

    # ── Container component (first container component wins) ──────────────────
    default_container_image = "quay.io/devfile/universal-developer-image:latest"
    container_name = "dev"
    container: dict[str, Any] = {
        "image": default_container_image,
        "mountSources": True,
        "sourceMapping": "/projects",
        "dedicatedPod": False,
        "cpuRequest": "",
        "cpuLimit": "",
        "memoryRequest": "",
        "memoryLimit": "",
        "args": [],
        "command": [],
        "annotation": {},
        "env": [],
        "endpoints": [],
        "volumeMounts": [],
    }

    # Flat UI lists assembled from the container component
    endpoints: list[dict] = []
    custom_env: list[dict] = []

    for comp in devfile.get("components") or []:
        ct = comp.get("container")
        if not ct:
            continue
        container_name = comp.get("name", "dev")
        container.update(
            {
                "image": ct.get("image", default_container_image),
                "mountSources": ct.get("mountSources", True),
                "sourceMapping": ct.get("sourceMapping", "/projects"),
                "dedicatedPod": ct.get("dedicatedPod", False),
                "cpuRequest": ct.get("cpuRequest", ""),
                "cpuLimit": ct.get("cpuLimit", ""),
                "memoryRequest": ct.get("memoryRequest", ""),
                "memoryLimit": ct.get("memoryLimit", ""),
                "args": list(ct.get("args") or []),
                "command": list(ct.get("command") or []),
                "annotation": dict(ct.get("annotation") or {}),
                "env": [],
                "endpoints": [],
                "volumeMounts": [],
            }
        )
        for ep in ct.get("endpoints") or []:
            endpoints.append(
                {
                    "name": ep.get("name", ""),
                    "targetPort": ep.get("targetPort", 0),
                    "protocol": ep.get("protocol", "http"),
                    "exposure": ep.get("exposure", "public"),
                    "secure": ep.get("secure", False),
                    "path": ep.get("path", ""),
                    "annotation": dict(ep.get("annotation") or {}),
                }
            )
        for env in ct.get("env") or []:
            custom_env.append(
                {"name": env.get("name", ""), "value": env.get("value", "")}
            )
        break  # only read the first container component

    # ── Volumes (flat UI shape) ────────────────────────────────────────────────
    volumes: list[dict] = []
    for comp in devfile.get("components") or []:
        if "volume" not in comp:
            continue
        vol = comp["volume"]
        # Find the corresponding volumeMount path from the first container
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
                "ephemeral": vol.get("ephemeral", False),
            }
        )

    # ── Projects ──────────────────────────────────────────────────────────────
    projects: list[dict] = []
    for p in devfile.get("projects") or []:
        git = p.get("git") or {}
        origin = next(iter((git.get("remotes") or {}).values()), "")
        revision = (git.get("checkoutFrom") or {}).get("revision", "main")
        name = p.get("name", "")
        projects.append(
            {
                "name": name,
                "git": {
                    "remotes": {"origin": origin},
                    "checkoutFrom": {"revision": revision},
                },
                "clonePath": p.get("clonePath", name),
                "attributes": dict(p.get("attributes") or {}),
            }
        )

    # ── Starter projects ───────────────────────────────────────────────────────
    starter_projects: list[dict] = []
    for s in devfile.get("starterProjects") or []:
        git = s.get("git") or {}
        origin = next(iter((git.get("remotes") or {}).values()), "")
        revision = (git.get("checkoutFrom") or {}).get("revision", "main")
        starter_projects.append(
            {
                "name": s.get("name", ""),
                "git": {
                    "remotes": {"origin": origin},
                    "checkoutFrom": {"revision": revision},
                },
            }
        )

    # ── Commands ───────────────────────────────────────────────────────────────
    commands: list[dict] = []
    for c in devfile.get("commands") or []:
        if not c.get("id"):
            continue

        cmd: dict[str, Any] = {
            "id": c["id"],
            "attributes": dict(c.get("attributes") or {}),
        }

        if "exec" in c:
            cmd["type"] = "exec"
            ex = c["exec"]
            cmd["exec"] = {
                "commandLine": ex.get("commandLine", ""),
                "component": ex.get("component", ""),
                "workingDir": ex.get("workingDir", ""),
                "label": ex.get("label", ""),
                "hotReloadCapable": ex.get("hotReloadCapable", False),
                "env": list(ex.get("env") or []),
                "group": ex.get("group") or {"kind": "run", "isDefault": False},
            }
        elif "composite" in c:
            cmd["type"] = "composite"
            cp = c["composite"]
            cmd["composite"] = {
                "commands": list(cp.get("commands") or []),
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
    events: dict[str, list] = {
        "preStart": list(raw_events.get("preStart") or []),
        "postStart": list(raw_events.get("postStart") or []),
        "preStop": list(raw_events.get("preStop") or []),
        "postStop": list(raw_events.get("postStop") or []),
    }

    return {
        # Top-level Devfile fields
        "schemaVersion": devfile.get("schemaVersion", "2.3.0"),
        "metadata": metadata,
        "variables": variables,
        "attributes": attributes,
        # Structural Devfile fields
        "components": [{"name": container_name, "container": container}],
        "projects": projects,
        "starterProjects": starter_projects,
        "commands": commands,
        "events": events,
        # Flat UI helpers
        "customEnv": custom_env,
        "endpoints": endpoints,
        "volumes": volumes,
        # Fragments — always empty for predefined config blobs
        "fragments": [],
    }


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
