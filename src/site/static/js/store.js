// store.js — Alpine.store definitions and URL encode/decode
// Import this before starting Alpine.

import {
  Devfile,
  defaultContainer,
  defaultExecCommand,
  defaultCompositeCommand,
  defaultApplyCommand,
  defaultProject,
  defaultStarterProject,
  defaultEndpoint,
  defaultVolume,
  defaultEnvVar,
  defaultMetadata,
  defaultFragment,
  mergeDevfileFragments,
} from "./devfile.js";

// ── Constants from Jinja bridge ───────────────────────────────────────────────
const CFG = window.DEVFILE_CONFIG ?? {};
export const PREDEFINED_REPOS = CFG.predefinedRepos ?? [];
export const PREDEFINED_CONFIGS = CFG.predefinedConfigs ?? [];
export const PREDEFINED_COMMANDS = CFG.predefinedCommands ?? []; // kept for commands section
export const CATALOG = CFG.componentCatalog ?? []; // now: [{id,name,icon,description,devfile:{}}]

// ── URL encode / decode ───────────────────────────────────────────────────────

export async function encodeState(state) {
  // state is already JSON-serialisable (no Sets or Maps).
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(compressed)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export async function decodeState(hash) {
  const b64 = hash.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const parsed = JSON.parse(
    new TextDecoder().decode(await new Response(ds.readable).arrayBuffer()),
  );
  return parsed;
}

// ── Build full Devfile export object from store state ─────────────────────────

export function buildDevfileData(state) {
  const {
    components,
    volumes,
    customEnv,
    endpoints,
    commands,
    events,
    projects,
    starterProjects,
    fragments,
    metadata,
    variables,
    attributes,
  } = state;

  const containerComp = components[0] ?? defaultContainer();
  const ct = containerComp.container;

  // Build container object from base state
  const envVars = [...(customEnv ?? []).filter((e) => e.name)];
  const volMounts = [];
  const allEndpoints = [
    ...(endpoints ?? []).filter((e) => e.name && e.targetPort),
  ];

  // User-defined volumes
  const volComponents = [];
  (volumes ?? [])
    .filter((v) => v.name)
    .forEach((v) => {
      const volDef = v.size ? { size: v.size } : {};
      if (v.ephemeral) volDef.ephemeral = true;
      volComponents.push({ name: v.name, volume: volDef });
      volMounts.push({ name: v.name, path: v.mountPath || `/${v.name}` });
    });

  const endpointsOut = allEndpoints.map((ep) => ({
    name: ep.name,
    targetPort: ep.targetPort,
    protocol: ep.protocol || "http",
    exposure: ep.exposure || "public",
    ...(ep.secure ? { secure: true } : {}),
    ...(ep.path ? { path: ep.path } : {}),
    ...(Object.keys(ep.annotation ?? {}).length
      ? { annotation: ep.annotation }
      : {}),
  }));

  const containerOut = {
    image: ct.image || "quay.io/devfile/universal-developer-image:latest",
    mountSources: ct.mountSources !== false,
    ...(ct.sourceMapping ? { sourceMapping: ct.sourceMapping } : {}),
    ...(ct.dedicatedPod ? { dedicatedPod: true } : {}),
    ...(ct.cpuRequest ? { cpuRequest: ct.cpuRequest } : {}),
    ...(ct.cpuLimit ? { cpuLimit: ct.cpuLimit } : {}),
    ...(ct.memoryRequest ? { memoryRequest: ct.memoryRequest } : {}),
    ...(ct.memoryLimit ? { memoryLimit: ct.memoryLimit } : {}),
    ...(ct.args?.length ? { args: ct.args } : {}),
    ...(ct.command?.length ? { command: ct.command } : {}),
    ...(Object.keys(ct.annotation ?? {}).length
      ? { annotation: ct.annotation }
      : {}),
    ...(envVars.length ? { env: envVars } : {}),
    ...(endpointsOut.length ? { endpoints: endpointsOut } : {}),
    ...(volMounts.length ? { volumeMounts: volMounts } : {}),
  };

  // Build base devfile
  const meta = metadata ?? {};
  const metaOut = {};
  [
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
  ].forEach((f) => {
    if (meta[f]) metaOut[f] = meta[f];
  });
  if (meta.tags?.length) metaOut.tags = meta.tags;
  if (meta.architectures?.length) metaOut.architectures = meta.architectures;
  if (Object.keys(meta.attributes ?? {}).length)
    metaOut.attributes = meta.attributes;

  const projectsOut = (projects ?? [])
    .filter((p) => p.name && p.git?.remotes?.origin)
    .map((p) => {
      const cf = {};
      if (
        p.git.checkoutFrom?.revision &&
        p.git.checkoutFrom.revision !== "main"
      )
        cf.revision = p.git.checkoutFrom.revision;
      return {
        name: p.name,
        git: {
          remotes: { origin: p.git.remotes.origin },
          ...(Object.keys(cf).length ? { checkoutFrom: cf } : {}),
        },
        ...(p.clonePath && p.clonePath !== p.name
          ? { clonePath: p.clonePath }
          : {}),
        ...(Object.keys(p.attributes ?? {}).length
          ? { attributes: p.attributes }
          : {}),
      };
    });

  const starterProjectsOut = (starterProjects ?? [])
    .filter((s) => s.name && s.git?.remotes?.origin)
    .map((s) => {
      const cf = {};
      if (
        s.git.checkoutFrom?.revision &&
        s.git.checkoutFrom.revision !== "main"
      )
        cf.revision = s.git.checkoutFrom.revision;
      return {
        name: s.name,
        git: {
          remotes: { origin: s.git.remotes.origin },
          ...(Object.keys(cf).length ? { checkoutFrom: cf } : {}),
        },
      };
    });

  const commandsOut = (commands ?? [])
    .filter((c) => c.id)
    .map((c) => {
      const entry = {
        id: c.id,
        ...(Object.keys(c.attributes ?? {}).length
          ? { attributes: c.attributes }
          : {}),
      };
      if (c.type === "exec" && c.exec) {
        const ex = c.exec;
        const exec = {
          commandLine: ex.commandLine ?? "",
          component: ex.component ?? "",
        };
        if (ex.workingDir) exec.workingDir = ex.workingDir;
        if (ex.label) exec.label = ex.label;
        if (ex.hotReloadCapable) exec.hotReloadCapable = true;
        if (ex.env?.length) exec.env = ex.env;
        if (ex.group?.kind)
          exec.group = { kind: ex.group.kind, isDefault: !!ex.group.isDefault };
        entry.exec = exec;
      } else if (c.type === "composite" && c.composite) {
        const cp = c.composite;
        const comp = {};
        if (cp.commands?.length) comp.commands = cp.commands;
        if (cp.parallel) comp.parallel = true;
        if (cp.label) comp.label = cp.label;
        if (cp.group?.kind)
          comp.group = { kind: cp.group.kind, isDefault: !!cp.group.isDefault };
        entry.composite = comp;
      } else if (c.type === "apply" && c.apply) {
        const ap = c.apply;
        const apply = { component: ap.component ?? "" };
        if (ap.label) apply.label = ap.label;
        if (ap.group?.kind)
          apply.group = {
            kind: ap.group.kind,
            isDefault: !!ap.group.isDefault,
          };
        entry.apply = apply;
      }
      return entry;
    });

  const eventsRaw = events ?? {};
  const eventsOut = {};
  ["preStart", "postStart", "preStop", "postStop"].forEach((k) => {
    const ids = (eventsRaw[k] ?? []).filter(Boolean);
    if (ids.length) eventsOut[k] = ids;
  });

  const baseDevfile = {
    schemaVersion: "2.3.0",
    ...(Object.keys(metaOut).length ? { metadata: metaOut } : {}),
    ...(Object.keys(variables ?? {}).length ? { variables } : {}),
    ...(Object.keys(attributes ?? {}).length ? { attributes } : {}),
    components: [
      { name: containerComp.name || "dev", container: containerOut },
      ...volComponents,
    ],
    ...(projectsOut.length ? { projects: projectsOut } : {}),
    ...(starterProjectsOut.length
      ? { starterProjects: starterProjectsOut }
      : {}),
    ...(commandsOut.length ? { commands: commandsOut } : {}),
    ...(Object.keys(eventsOut).length ? { events: eventsOut } : {}),
  };

  // Merge all active fragments into the base
  const { merged, errors } = mergeDevfileFragments(
    baseDevfile,
    fragments ?? [],
  );
  return { data: merged, errors };
}

// ── Initial store state ───────────────────────────────────────────────────────

function initialDevfileState() {
  return {
    // ── Top-level Devfile fields ───────────────────────────────────────────
    schemaVersion: "2.3.0",
    metadata: defaultMetadata(),
    variables: {},
    attributes: {},

    // ── Structural Devfile fields ──────────────────────────────────────────
    components: [defaultContainer()],
    projects: [],
    starterProjects: [],
    commands: [],
    events: { preStart: [], postStart: [], preStop: [], postStop: [] },

    // ── Flat UI helpers for the container component ────────────────────────
    customEnv: [],
    endpoints: [],
    volumes: [],

    // ── Fragment list — replaces activeComponents + componentConfigs ───────
    // Each entry: { id, name, description, icon, devfile: { components,
    //   commands, events, variables, attributes, projects, starterProjects } }
    fragments: [],
  };
}

// ── Register Alpine stores ────────────────────────────────────────────────────

export function registerStores() {
  Alpine.store("devfile", {
    ...initialDevfileState(),

    // ── Container helpers ──────────────────────────────────────────────────

    get container() {
      return this.components[0]?.container ?? defaultContainer().container;
    },
    get containerName() {
      return this.components[0]?.name ?? "dev";
    },

    setContainerField(path, value) {
      const parts = path.split(".");
      let obj = this.components[0].container;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
    },

    setContainerName(name) {
      this.components[0].name = name;
    },

    // ── Project helpers ────────────────────────────────────────────────────

    addProject() {
      this.projects.push(defaultProject());
    },
    removeProject(i) {
      this.projects.splice(i, 1);
    },

    addStarterProject() {
      this.starterProjects.push(defaultStarterProject());
    },
    removeStarterProject(i) {
      this.starterProjects.splice(i, 1);
    },

    addProjectsFromPredefined(selectedNames) {
      selectedNames.forEach((name) => {
        if (this.projects.some((p) => p.name === name)) return;
        const pre = PREDEFINED_REPOS.find((r) => r.name === name);
        if (!pre) return;
        this.projects.push({
          name,
          git: {
            remotes: { origin: pre.remote ?? "" },
            checkoutFrom: { revision: pre.revision ?? "main" },
          },
          clonePath: pre.clone_path ?? name,
        });
      });
    },

    // ── Endpoint helpers ───────────────────────────────────────────────────

    addEndpoint() {
      this.endpoints.push(defaultEndpoint());
    },
    removeEndpoint(i) {
      this.endpoints.splice(i, 1);
    },

    // ── Env var helpers ────────────────────────────────────────────────────

    addEnvVar() {
      this.customEnv.push(defaultEnvVar());
    },
    removeEnvVar(i) {
      this.customEnv.splice(i, 1);
    },

    // ── Volume helpers ─────────────────────────────────────────────────────

    addVolume() {
      this.volumes.push(defaultVolume());
    },
    removeVolume(i) {
      this.volumes.splice(i, 1);
    },

    // ── Command helpers ────────────────────────────────────────────────────

    addCommand(type = "exec") {
      const cmd =
        type === "exec"
          ? defaultExecCommand()
          : type === "composite"
            ? defaultCompositeCommand()
            : defaultApplyCommand();
      this.commands.push(cmd);
    },

    removeCommand(i) {
      this.commands.splice(i, 1);
    },

    changeCommandType(i, newType) {
      const id = this.commands[i]?.id ?? "";
      const cmd =
        newType === "exec"
          ? defaultExecCommand()
          : newType === "composite"
            ? defaultCompositeCommand()
            : defaultApplyCommand();
      cmd.id = id;
      this.commands.splice(i, 1, cmd);
    },

    addCommandsFromPredefined(ids) {
      ids.forEach((id) => {
        if (this.commands.some((c) => c.id === id)) return;
        const pre = PREDEFINED_COMMANDS.find((c) => c.id === id);
        if (!pre) return;
        const { display_name, description, ...cmd } = JSON.parse(
          JSON.stringify(pre),
        );
        if (!cmd.type)
          cmd.type = cmd.exec ? "exec" : cmd.composite ? "composite" : "apply";
        if (cmd.exec && !cmd.exec.component)
          cmd.exec.component = this.containerName;
        if (cmd.apply && !cmd.apply.component)
          cmd.apply.component = this.containerName;
        this.commands.push(cmd);
      });
    },

    // ── Fragment helpers ───────────────────────────────────────────────────

    addFragment() {
      this.fragments.push(defaultFragment());
    },

    addFragmentFromCatalog(catalogId) {
      const entry = CATALOG.find((c) => c.id === catalogId);
      if (!entry) return;
      // Deep-clone the catalog fragment so edits don't mutate the catalog
      const frag = JSON.parse(
        JSON.stringify({
          id: `${catalogId}-${Date.now()}`,
          name: entry.name ?? catalogId,
          description: entry.description ?? "",
          icon: entry.icon ?? "🧩",
          devfile: entry.devfile ?? defaultFragment().devfile,
        }),
      );
      this.fragments.push(frag);
    },

    removeFragment(i) {
      this.fragments.splice(i, 1);
    },

    moveFragmentUp(i) {
      if (i === 0) return;
      const f = this.fragments.splice(i, 1)[0];
      this.fragments.splice(i - 1, 0, f);
    },

    moveFragmentDown(i) {
      if (i >= this.fragments.length - 1) return;
      const f = this.fragments.splice(i, 1)[0];
      this.fragments.splice(i + 1, 0, f);
    },

    // ── Event helpers ──────────────────────────────────────────────────────

    toggleEvent(key, cmdId) {
      const arr = this.events[key] ?? [];
      const idx = arr.indexOf(cmdId);
      if (idx === -1) arr.push(cmdId);
      else arr.splice(idx, 1);
      // Trigger Alpine reactivity by reassigning the array reference
      this.events = { ...this.events, [key]: [...arr] };
    },

    isEventActive(key, cmdId) {
      return (this.events[key] ?? []).includes(cmdId);
    },

    // ── Named command IDs (for event picker) ──────────────────────────────

    get commandIds() {
      return this.commands.map((c) => c.id).filter(Boolean);
    },

    // ── URL serialization ──────────────────────────────────────────────────

    async pushToURL() {
      const blob = await encodeState({
        schemaVersion: this.schemaVersion,
        metadata: this.metadata,
        variables: this.variables,
        attributes: this.attributes,
        components: this.components,
        customEnv: this.customEnv,
        endpoints: this.endpoints,
        volumes: this.volumes,
        projects: this.projects,
        starterProjects: this.starterProjects,
        commands: this.commands,
        events: this.events,
        fragments: this.fragments,
      });
      history.replaceState(null, "", `#c=${blob}`);
      return blob;
    },

    async hydrateFromHash(hash) {
      try {
        const parsed = await decodeState(hash);
        this.schemaVersion = parsed.schemaVersion ?? "2.3.0";
        this.metadata = parsed.metadata ?? defaultMetadata();
        this.variables = parsed.variables ?? {};
        this.attributes = parsed.attributes ?? {};
        this.components = parsed.components ?? [defaultContainer()];
        this.customEnv = parsed.customEnv ?? [];
        this.endpoints = parsed.endpoints ?? [];
        this.volumes = parsed.volumes ?? [];
        this.projects = parsed.projects ?? [];
        this.starterProjects = parsed.starterProjects ?? [];
        this.commands = parsed.commands ?? [];
        this.events = parsed.events ?? {
          preStart: [],
          postStart: [],
          preStop: [],
          postStop: [],
        };
        this.fragments = parsed.fragments ?? [];
        return true;
      } catch (e) {
        console.warn("Failed to decode state from URL hash:", e);
        return false;
      }
    },

    // ── Build export ───────────────────────────────────────────────────────

    buildExport() {
      return buildDevfileData(this);
    },
  });

  // ── UI store (ephemeral, not serialized) ───────────────────────────────────
  Alpine.store("ui", {
    activeSection: "metadata",
    yamlOutput: '# Click "Generate & Export" to build your devfile YAML',
    jsonOutput: "// JSON output will appear here",
    outputTab: "yaml",
    shareUrl: "",
    rawUrl: "",
    shareSizeTag: "",
    sharePanelVisible: false,
    outputStatus: {
      type: "info",
      message:
        "Click <strong>Generate &amp; Export</strong> to build your devfile.",
    },

    importYaml: "",
    importStatus: null, // { type: 'ok'|'err', message }
    importJsonOutput: "",
    importResultVisible: false,

    setSection(s) {
      this.activeSection = s;
    },
    setOutputTab(t) {
      this.outputTab = t;
    },
  });
}
