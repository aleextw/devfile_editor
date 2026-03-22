from typing import Any
import json
import zlib
import base64


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
        remote = next(iter((git.get("remotes") or {}).values()), "")
        repos.append(
            {
                "name": p.get("name", ""),
                "remote": remote,
                "revision": (git.get("checkoutFrom") or {}).get("revision", "main"),
                "clonePath": p.get("clonePath", p.get("name", "")),
            }
        )

    starters: list[dict] = []
    for s in devfile.get("starterProjects") or []:
        git = s.get("git") or {}
        remote = next(iter((git.get("remotes") or {}).values()), "")
        starters.append(
            {
                "name": s.get("name", ""),
                "remote": remote,
                "revision": (git.get("checkoutFrom") or {}).get("revision", "main"),
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
