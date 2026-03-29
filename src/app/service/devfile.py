from __future__ import annotations

import copy
from typing import Any


# ── Fragment merge ────────────────────────────────────────────────────────────


def _merge_fragments(
    base: dict[str, Any],
    fragments: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[str]]:
    """
    Deep-merge a list of partial devfile fragment dicts into ``base``.

    Each fragment dict has the shape:
      { id, name, description, icon, devfile: { components, commands, events,
        variables, attributes, projects, starterProjects } }

    Merge rules (mirrors mergeDevfileFragments in devfile.js):
      schemaVersion, metadata  — base wins; fragments cannot override
      variables, attributes    — shallow merge; base wins on key conflicts
      components               — array concat; duplicate names → error
      projects, starterProjects — array concat; duplicate names → error
      commands                 — array concat; duplicate IDs → error
      events.*                 — array union (deduplicated)

    Returns (merged_devfile, error_list).
    """
    merged = copy.deepcopy(base)
    errors: list[str] = []

    # Seed uniqueness sets from the base
    component_names: set[str] = {
        c.get("name", "") for c in merged.get("components") or []
    }
    project_names: set[str] = {p.get("name", "") for p in merged.get("projects") or []}
    starter_names: set[str] = {
        s.get("name", "") for s in merged.get("starterProjects") or []
    }
    command_ids: set[str] = {c.get("id", "") for c in merged.get("commands") or []}

    for frag in fragments:
        label = frag.get("name") or frag.get("id") or "(unnamed)"
        d: dict[str, Any] = frag.get("devfile") or {}

        # variables — base wins on conflict
        for k, v in (d.get("variables") or {}).items():
            if k not in (merged.get("variables") or {}):
                merged.setdefault("variables", {})[k] = v

        # attributes — base wins on conflict
        for k, v in (d.get("attributes") or {}).items():
            if k not in (merged.get("attributes") or {}):
                merged.setdefault("attributes", {})[k] = v

        # components — concat, error on duplicate name
        for comp in d.get("components") or []:
            name = comp.get("name", "")
            if name in component_names:
                errors.append(
                    f'Fragment "{label}": component name "{name}" already exists.'
                )
            else:
                merged.setdefault("components", []).append(comp)
                component_names.add(name)

        # projects — concat, error on duplicate name
        for proj in d.get("projects") or []:
            name = proj.get("name", "")
            if name in project_names:
                errors.append(
                    f'Fragment "{label}": project name "{name}" already exists.'
                )
            else:
                merged.setdefault("projects", []).append(proj)
                project_names.add(name)

        # starterProjects — concat, error on duplicate name
        for sp in d.get("starterProjects") or []:
            name = sp.get("name", "")
            if name in starter_names:
                errors.append(
                    f'Fragment "{label}": starterProject name "{name}" already exists.'
                )
            else:
                merged.setdefault("starterProjects", []).append(sp)
                starter_names.add(name)

        # commands — concat, error on duplicate ID
        for cmd in d.get("commands") or []:
            cmd_id = cmd.get("id", "")
            if cmd_id in command_ids:
                errors.append(
                    f'Fragment "{label}": command ID "{cmd_id}" already exists.'
                )
            else:
                merged.setdefault("commands", []).append(cmd)
                command_ids.add(cmd_id)

        # events — union per lifecycle key
        frag_events = d.get("events") or {}
        for key in ("preStart", "postStart", "preStop", "postStop"):
            for cmd_id in frag_events.get(key) or []:
                merged.setdefault("events", {}).setdefault(key, [])
                if cmd_id not in merged["events"][key]:
                    merged["events"][key].append(cmd_id)

    return merged, errors


def _generate_devfile_data(state: dict[str, Any]) -> dict[str, Any]:
    """
    Build a final devfile dict from the Alpine store state shape.

    Builds a base devfile from the store's structural fields, then
    deep-merges each fragment in ``state["fragments"]`` in order.
    """
    components_raw: list[dict] = state.get("components") or []
    first_comp = components_raw[0] if components_raw else {}
    container_name: str = first_comp.get("name") or "dev"
    ct: dict[str, Any] = first_comp.get("container") or {}

    env_vars = generate_env_vars(state)
    vol_components, vol_mounts = generate_volume_components_and_mounts(state)
    endpoints = generate_endpoints(state)
    container_component = generate_container_component(
        container_name, ct, env_vars, endpoints, vol_mounts
    )

    components = [container_component, *vol_components]
    projects = generate_projects(state)
    starter_projects = generate_starter_projects(state)
    commands = generate_commands(state)
    events = generate_events(state)

    # ── Top-level optional fields ──────────────────────────────────────────────
    meta_raw: dict = state.get("metadata") or {}
    meta_out: dict[str, Any] = {}
    for field in (
        "name",
        "displayName",
        "description",
        "version",
        "language",
        "projectType",
        "provider",
        "supportUrl",
        "website",
        "icon",
    ):
        if meta_raw.get(field):
            meta_out[field] = meta_raw[field]
    if meta_raw.get("tags"):
        meta_out["tags"] = meta_raw["tags"]
    if meta_raw.get("architectures"):
        meta_out["architectures"] = meta_raw["architectures"]
    if meta_raw.get("attributes"):
        meta_out["attributes"] = meta_raw["attributes"]

    variables: dict = state.get("variables") or {}
    top_attributes: dict = state.get("attributes") or {}

    # ── Assemble base devfile ──────────────────────────────────────────────────
    base: dict[str, Any] = {"schemaVersion": "2.3.0"}
    if meta_out:
        base["metadata"] = meta_out
    if variables:
        base["variables"] = variables
    if top_attributes:
        base["attributes"] = top_attributes
    base["components"] = components
    if projects:
        base["projects"] = projects
    if starter_projects:
        base["starterProjects"] = starter_projects
    if commands:
        base["commands"] = commands
    if events:
        base["events"] = events

    # ── Merge fragments ────────────────────────────────────────────────────────
    fragments: list[dict] = state.get("fragments") or []
    merged, errors = _merge_fragments(base, fragments)
    if errors:
        raise ValueError("\n".join(errors))

    return merged


def generate_env_vars(state: dict[str, Any]) -> list[dict]:
    env_vars: list[dict] = []
    for e in state.get("customEnv") or []:
        if e.get("name"):
            env_vars.append({"name": e["name"], "value": e.get("value", "")})
    return env_vars


def generate_volume_components_and_mounts(
    state: dict[str, Any],
) -> tuple[list[dict], list[dict]]:
    vol_components: list[dict] = []
    vol_mounts: list[dict] = []
    for v in state.get("volumes") or []:
        name = v.get("name", "").strip()
        if not name:
            continue
        vol_def: dict = {}
        if v.get("size"):
            vol_def["size"] = v["size"]
        if v.get("ephemeral"):
            vol_def["ephemeral"] = True
        vol_components.append({"name": name, "volume": vol_def})
        vol_mounts.append({"name": name, "path": v.get("mountPath") or f"/{name}"})
    return vol_components, vol_mounts


def generate_endpoints(state: dict[str, Any]) -> list[dict]:
    out = []
    for ep in state.get("endpoints") or []:
        if not (ep.get("name") and ep.get("targetPort")):
            continue
        entry: dict[str, Any] = {
            "name": ep["name"],
            "targetPort": ep["targetPort"],
            "protocol": ep.get("protocol", "http"),
            "exposure": ep.get("exposure", "public"),
        }
        if ep.get("secure"):
            entry["secure"] = True
        if ep.get("path"):
            entry["path"] = ep["path"]
        if ep.get("annotation"):
            entry["annotation"] = ep["annotation"]
        out.append(entry)
    return out


def generate_container_component(
    name: str,
    ct: dict[str, Any],
    env_vars: list[dict],
    endpoints: list[dict],
    vol_mounts: list[dict],
) -> dict[str, Any]:
    container: dict[str, Any] = {
        "image": ct.get("image") or "quay.io/devfile/universal-developer-image:latest",
        "mountSources": ct.get("mountSources", True) is not False,
    }
    if ct.get("cpuRequest"):
        container["cpuRequest"] = ct["cpuRequest"]
    if ct.get("cpuLimit"):
        container["cpuLimit"] = ct["cpuLimit"]
    if ct.get("memoryRequest"):
        container["memoryRequest"] = ct["memoryRequest"]
    if ct.get("memoryLimit"):
        container["memoryLimit"] = ct["memoryLimit"]
    if ct.get("sourceMapping"):
        container["sourceMapping"] = ct["sourceMapping"]
    if ct.get("dedicatedPod"):
        container["dedicatedPod"] = True
    if ct.get("args"):
        container["args"] = ct["args"]
    if ct.get("command"):
        container["command"] = ct["command"]
    if ct.get("annotation"):
        container["annotation"] = ct["annotation"]
    if env_vars:
        container["env"] = env_vars
    if endpoints:
        container["endpoints"] = endpoints
    if vol_mounts:
        container["volumeMounts"] = vol_mounts

    return {"name": name or "dev", "container": container}


def generate_projects(state: dict[str, Any]) -> list[dict]:
    projects = []
    for p in state.get("projects") or []:
        name = p.get("name", "")
        git = p.get("git") or {}
        remotes = git.get("remotes") or {}
        origin = remotes.get("origin", "")
        if not origin:
            origin = p.get("remote", "") or next(iter(remotes.values()), "")
        if not name or not origin:
            continue
        revision = (git.get("checkoutFrom") or {}).get("revision", "main")
        checkout_from: dict[str, str] = {}
        if revision and revision != "main":
            checkout_from["revision"] = revision
        git_out: dict[str, Any] = {"remotes": {"origin": origin}}
        if checkout_from:
            git_out["checkoutFrom"] = checkout_from
        proj: dict[str, Any] = {"name": name, "git": git_out}
        clone_path = p.get("clonePath", "")
        if clone_path and clone_path != name:
            proj["clonePath"] = clone_path
        if p.get("attributes"):
            proj["attributes"] = p["attributes"]
        projects.append(proj)
    return projects


def generate_starter_projects(state: dict[str, Any]) -> list[dict]:
    """
    Build the starterProjects list from the new state shape:
      starterProjects: [ { name, git: { remotes: { origin }, checkoutFrom: { revision } } } ]
    """
    starter_projects = []
    for s in state.get("starterProjects") or []:
        name = s.get("name", "")
        git = s.get("git") or {}
        remotes = git.get("remotes") or {}
        origin = remotes.get("origin", "")

        if not origin:
            origin = s.get("remote", "") or next(iter(remotes.values()), "")

        if not name or not origin:
            continue

        revision = (git.get("checkoutFrom") or {}).get("revision", "main")
        checkout_from: dict[str, str] = {}
        if revision and revision != "main":
            checkout_from["revision"] = revision

        git_out: dict[str, Any] = {"remotes": {"origin": origin}}
        if checkout_from:
            git_out["checkoutFrom"] = checkout_from

        starter_projects.append({"name": name, "git": git_out})

    return starter_projects


def generate_commands(state: dict[str, Any]) -> list[dict]:
    commands = []
    for c in state.get("commands") or []:
        if not c.get("id"):
            continue
        entry: dict[str, Any] = {"id": c["id"]}
        if c.get("attributes"):
            entry["attributes"] = c["attributes"]
        cmd_type = c.get("type")
        if cmd_type == "exec" and c.get("exec"):
            generate_exec_command(c, entry)
        elif cmd_type == "composite" and c.get("composite"):
            generate_composite_command(c, entry)
        elif cmd_type == "apply" and c.get("apply"):
            generate_apply_command(c, entry)
        else:
            continue
        commands.append(entry)

    return commands


def generate_exec_command(c: dict[str, Any], entry: dict[str, Any]) -> None:
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


def generate_composite_command(c: dict[str, Any], entry: dict[str, Any]) -> None:
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


def generate_apply_command(c: dict[str, Any], entry: dict[str, Any]) -> None:
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


def generate_events(state: dict[str, Any]) -> dict[str, list[str]]:
    raw_events = state.get("events") or {}
    events: dict[str, list[str]] = {}
    for key in ("preStart", "postStart", "preStop", "postStop"):
        ids = [i for i in (raw_events.get(key) or []) if i]
        if ids:
            events[key] = ids
    return events
