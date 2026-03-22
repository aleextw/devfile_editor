from __future__ import annotations

from typing import Any

from app.core.config import settings
from app.util.yaml import _resolve_field, _slugify
from app.model.devfile import ComponentCatalogItem, CatalogVolumeContribution


def _apply_catalog_contributions(
    active: set[str],
    configs: dict[str, Any],
    catalog: list,  # list[ComponentCatalogItem]
    env_vars: list[dict],
    vol_components: list[dict],
    vol_mounts: list[dict],
    endpoints: list[dict],
    commands: list[dict],
    events: dict[str, list[str]],
) -> list[str]:
    """
    Evaluate each active catalog item's contributions and append/merge the
    results into the provided lists/dicts. Operates in-place.

    Returns a list of error strings for any command ID conflicts found.
    Command contributions whose ID already exists in ``commands`` are
    skipped and recorded as errors rather than silently dropped.
    Event contributions append command IDs to the appropriate event lists,
    deduplicating within each list.
    """
    errors: list[str] = []
    for item in catalog:
        if item.id not in active:
            continue

        cfg = configs.get(item.id) or {}

        apply_env_vars(item, env_vars)
        apply_volumes(item, vol_components, vol_mounts, cfg)
        apply_endpoints(item, endpoints, cfg)
        apply_commands(item, commands, errors, cfg)
        apply_events(item, events)

    return errors


def apply_env_vars(item: ComponentCatalogItem, env_vars: list[dict]):
    for env in item.contributions.env:
        value = _resolve_field(env.value, env.value_from, {})

        if value:
            env_vars.append({"name": env.name, "value": value})


def apply_volumes(
    item: ComponentCatalogItem,
    vol_components: list[dict],
    vol_mounts: list[dict],
    cfg: dict[str, Any],
):
    for vol in item.contributions.volumes:
        vname = resolve_volume_name(vol, cfg)

        if not vname:
            continue

        size = _resolve_field(vol.size, vol.size_from, {})
        vol_def: dict[str, Any] = {"size": size} if size else {}
        vol_components.append({"name": vname, "volume": vol_def})
        mount = _resolve_field(vol.mount_path, vol.path_from, {}) or f"/{vname}"
        vol_mounts.append({"name": vname, "path": mount})


def resolve_volume_name(vol: CatalogVolumeContribution, cfg: dict[str, Any]) -> str:
    if vol.name:
        return vol.name
    elif vol.name_from:
        raw = cfg.get(vol.name_from, "") or vol.name_default
        return _slugify(raw) if vol.slugify else raw
    else:
        return ""


def apply_endpoints(
    item: ComponentCatalogItem,
    endpoints: list[dict],
    cfg: dict[str, Any],
):
    for ep in item.contributions.endpoints:
        name = _resolve_field(ep.name, ep.name_from, cfg)

        if not name:
            continue

        target_port = int(_resolve_field(str(ep.target_port), ep.port_from, cfg) or 0)

        if not target_port:
            continue

        endpoint = {
            "name": name,
            "targetPort": target_port,
            "protocol": ep.protocol,
            "exposure": ep.exposure,
        }

        endpoints.append(endpoint)


def apply_commands(
    item: ComponentCatalogItem,
    commands: list[dict],
    errors: list[str],
    cfg: dict[str, Any],
):
    existing_ids = {c.get("id") for c in commands}
    for cmd_contrib in item.contributions.commands:
        cmd_id = cmd_contrib.get("id", "")

        if not cmd_id:
            continue

        if cmd_id in existing_ids:
            errors.append(
                f'Command ID "{cmd_id}" contributed by catalog item '
                f'"{item.name}" conflicts with an existing command. '
                f"Rename the command or remove it before exporting."
            )
            continue

        cmd_type = cmd_contrib.get("type", "")
        entry: dict[str, Any] = {"id": cmd_id}

        if cmd_type == "exec":
            apply_exec_command(cmd_contrib, entry, cfg)
        elif cmd_type == "composite":
            apply_composite_command(cmd_contrib, entry, cfg)
        elif cmd_type == "apply":
            apply_apply_command(cmd_contrib, entry, cfg)
        else:
            continue

        commands.append(entry)
        existing_ids.add(cmd_id)


def apply_exec_command(
    cmd_contrib: dict[str, Any], entry: dict[str, Any], cfg: dict[str, Any]
):
    raw_exec = cmd_contrib.get("exec") or {}

    exec_obj: dict[str, Any] = {
        "commandLine": _resolve_field(
            raw_exec.get("commandLine", ""),
            raw_exec.get("commandLine_from", ""),
            cfg,
        ),
        "component": _resolve_field(
            raw_exec.get("component", ""),
            raw_exec.get("component_from", ""),
            cfg,
        ),
    }

    wd = _resolve_field(
        raw_exec.get("workingDir", ""),
        raw_exec.get("workingDir_from", ""),
        cfg,
    )

    if wd:
        exec_obj["workingDir"] = wd

    if raw_exec.get("label"):
        exec_obj["label"] = raw_exec["label"]

    if raw_exec.get("hotReloadCapable"):
        exec_obj["hotReloadCapable"] = True

    if raw_exec.get("group", {}).get("kind"):
        exec_obj["group"] = {
            "kind": raw_exec["group"]["kind"],
            "isDefault": bool(raw_exec["group"].get("isDefault")),
        }

    entry["exec"] = exec_obj


def apply_composite_command(
    cmd_contrib: dict[str, Any], entry: dict[str, Any], cfg: dict[str, Any]
):
    raw_comp = cmd_contrib.get("composite") or {}

    raw_cmds = raw_comp.get("commands") or []

    # Each sub-command can be a literal string or {"id_from": "field-key"}
    sub_cmds = []

    for sub in raw_cmds:
        if isinstance(sub, str):
            sub_cmds.append(sub)
        elif isinstance(sub, dict) and sub.get("id_from"):
            resolved = cfg.get(sub["id_from"], "")
            if resolved:
                sub_cmds.append(resolved)

    comp_obj: dict[str, Any] = {}

    if sub_cmds:
        comp_obj["commands"] = sub_cmds

    if raw_comp.get("parallel"):
        comp_obj["parallel"] = True

    if raw_comp.get("label"):
        comp_obj["label"] = raw_comp["label"]

    if raw_comp.get("group", {}).get("kind"):
        comp_obj["group"] = {
            "kind": raw_comp["group"]["kind"],
            "isDefault": bool(raw_comp["group"].get("isDefault")),
        }

    entry["composite"] = comp_obj


def apply_apply_command(
    cmd_contrib: dict[str, Any], entry: dict[str, Any], cfg: dict[str, Any]
):
    raw_apply = cmd_contrib.get("apply") or {}

    apply_obj: dict[str, Any] = {
        "component": _resolve_field(
            raw_apply.get("component", ""),
            raw_apply.get("component_from", ""),
            cfg,
        ),
    }

    if raw_apply.get("label"):
        apply_obj["label"] = raw_apply["label"]

    if raw_apply.get("group", {}).get("kind"):
        apply_obj["group"] = {
            "kind": raw_apply["group"]["kind"],
            "isDefault": bool(raw_apply["group"].get("isDefault")),
        }

    entry["apply"] = apply_obj


def apply_events(
    item: ComponentCatalogItem,
    events: dict[str, list[str]],
):
    for evt in item.contributions.events:
        evt_type = evt.get("type", "")
        cmd_id = evt.get("command_id", "")

        if not evt_type or not cmd_id:
            continue

        if evt_type not in events:
            events[evt_type] = []

        if cmd_id not in events[evt_type]:
            events[evt_type].append(cmd_id)


def _generate_devfile_data(state: dict[str, Any]) -> dict[str, Any]:
    resources: dict[str, Any] = state.get("resources") or {}
    active: set[str] = set(state.get("activeComponents") or [])
    configs: dict[str, Any] = state.get("componentConfigs") or {}

    env_vars = generate_env_vars(state)
    vol_components, vol_mounts = generate_volume_components_and_mounts(state)
    endpoints = generate_endpoints(state)
    container_component = generate_container_component(
        resources, env_vars, endpoints, vol_mounts
    )

    components = [container_component, *vol_components]

    projects = generate_projects(state)
    starter_projects = generate_starter_projects(state)
    commands = generate_commands(state)
    events = generate_events(state)

    # ── Catalog contributions (generic, data-driven) ───────────────────────────
    # Called after state commands/events are built so catalog contributions
    # can be appended to the same lists (skipping duplicate command IDs and
    # deduplicating event bindings).
    catalog_errors = _apply_catalog_contributions(
        active,
        configs,
        settings.devfile_component_catalog,
        env_vars,
        vol_components,
        vol_mounts,
        endpoints,
        commands,
        events,
    )
    if catalog_errors:
        raise ValueError("\n".join(catalog_errors))

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
    if events:
        devfile["events"] = events

    return devfile


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
        vol_components.append({"name": name, "volume": vol_def})
        vol_mounts.append({"name": name, "path": v.get("mountPath") or f"/{name}"})
    return vol_components, vol_mounts


def generate_endpoints(state: dict[str, Any]) -> list[dict]:
    return [
        ep
        for ep in (state.get("endpoints") or [])
        if ep.get("name") and ep.get("targetPort")
    ]


def generate_container_component(
    resources: dict[str, Any],
    env_vars: list[dict],
    endpoints: list[dict],
    vol_mounts: list[dict],
) -> dict[str, Any]:
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

    return {
        "name": resources.get("name") or "dev",
        "container": container,
    }


def generate_projects(state: dict[str, Any]) -> list[dict]:
    projects = []
    for r in state.get("repos") or []:
        remote = r.get("remote") or ""
        # Accept both the new flat shape and old remotes-object shape from
        # any existing serialized blobs
        if not remote:
            remote = next(iter((r.get("remotes") or {}).values()), "")
        if not r.get("name") or not remote:
            continue
        checkout_from: dict[str, str] = {}
        if r.get("revision") and r["revision"] != "main":
            checkout_from["revision"] = r["revision"]
        git: dict[str, Any] = {"remotes": {"origin": remote}}
        if checkout_from:
            git["checkoutFrom"] = checkout_from
        proj: dict[str, Any] = {"name": r["name"], "git": git}
        if r.get("clonePath") and r["clonePath"] != r["name"]:
            proj["clonePath"] = r["clonePath"]
        projects.append(proj)

    return projects


def generate_starter_projects(state: dict[str, Any]) -> list[dict]:
    starter_projects = []
    for s in state.get("starters") or []:
        remote = s.get("remote") or next(iter((s.get("remotes") or {}).values()), "")
        if not s.get("name") or not remote:
            continue
        checkout_from = {}
        if s.get("revision") and s["revision"] != "main":
            checkout_from["revision"] = s["revision"]
        git = {"remotes": {"origin": remote}}
        if checkout_from:
            git["checkoutFrom"] = checkout_from
        starter_projects.append({"name": s["name"], "git": git})
    return starter_projects


def generate_commands(state: dict[str, Any]) -> list[dict]:
    commands = []
    for c in state.get("commands") or []:
        if not c.get("id"):
            continue
        entry: dict[str, Any] = {"id": c["id"]}
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


def generate_exec_command(c: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
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


def generate_composite_command(
    c: dict[str, Any], entry: dict[str, Any]
) -> dict[str, Any]:
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


def generate_apply_command(c: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
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
