// devfile.js — Devfile schema classes with validation helpers
// Each class validates on construction and exposes static helper methods
// used by Alpine components and the store.

function validatePattern(value, pattern, field) {
  if (!new RegExp(pattern).test(value)) {
    throw new Error(
      `Invalid value for "${field}": "${value}" does not match pattern ${pattern}`,
    );
  }
}
function validateEnum(value, enumArr, field) {
  if (!enumArr.includes(value)) {
    throw new Error(
      `Invalid value for "${field}": "${value}". Allowed: ${enumArr.join(", ")}`,
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return true if s is a valid devfile identifier (^[a-z0-9]([-a-z0-9]*[a-z0-9])?$, ≤63). */
function isValidId(s) {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= 63 &&
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(s)
  );
}

/** Blank default container component. */
function defaultContainer() {
  return {
    name: "dev",
    container: {
      image: "quay.io/devfile/universal-developer-image:latest",
      mountSources: true,
      sourceMapping: "/projects",
      dedicatedPod: false,
      cpuRequest: "",
      cpuLimit: "",
      memoryRequest: "",
      memoryLimit: "",
      // Container override fields (rarely needed, but part of schema)
      args: [], // override CMD args
      command: [], // override ENTRYPOINT command
      annotation: {}, // Kubernetes annotation key/value pairs
      // Managed by the store as flat UI helpers, assembled on export:
      env: [],
      endpoints: [],
      volumeMounts: [],
    },
  };
}

/** Blank exec command. */
function defaultExecCommand() {
  return {
    id: "",
    type: "exec",
    attributes: {},
    exec: {
      commandLine: "",
      component: "dev",
      workingDir: "$PROJECT_SOURCE",
      label: "",
      hotReloadCapable: false,
      env: [],
      group: { kind: "run", isDefault: false },
    },
  };
}

/** Blank composite command. */
function defaultCompositeCommand() {
  return {
    id: "",
    type: "composite",
    attributes: {},
    composite: {
      commands: [],
      parallel: false,
      label: "",
      group: { kind: "run", isDefault: false },
    },
  };
}

/** Blank apply command. */
function defaultApplyCommand() {
  return {
    id: "",
    type: "apply",
    attributes: {},
    apply: {
      component: "dev",
      label: "",
      group: { kind: "run", isDefault: false },
    },
  };
}

/** Blank project (repository). */
function defaultProject() {
  return {
    name: "",
    git: { remotes: { origin: "" } },
    clonePath: "",
    attributes: {},
  };
}

/** Blank starter project. */
function defaultStarterProject() {
  return {
    name: "",
    git: { remotes: { origin: "" } },
  };
}

/** Blank endpoint. */
function defaultEndpoint() {
  return {
    name: "",
    targetPort: 3000,
    protocol: "http",
    exposure: "public",
    secure: false,
    path: "",
    annotation: {},
  };
}

/** Blank volume (UI flat shape — assembled into Devfile shape on export). */
function defaultVolume() {
  return { name: "", size: "", mountPath: "", ephemeral: false };
}

/** Blank env var. */
function defaultEnvVar() {
  return { name: "", value: "" };
}

/** Blank metadata object. */
function defaultMetadata() {
  return {
    name: "",
    displayName: "",
    description: "",
    version: "",
    language: "",
    projectType: "",
    provider: "",
    supportUrl: "",
    website: "",
    icon: "",
    tags: [],
    architectures: [],
    attributes: {},
  };
}

// ── Schema classes ────────────────────────────────────────────────────────────

class CommandGroup {
  constructor(data) {
    if (!("kind" in data))
      throw new Error("Missing required 'kind' in command group");
    this.kind = data.kind;
    validateEnum(
      this.kind,
      ["build", "run", "test", "debug", "deploy"],
      "group.kind",
    );
    this.isDefault = data.isDefault || false;
  }

  static validate(data) {
    return new CommandGroup(data);
  }
}

class ExecCommand {
  constructor(data) {
    ["commandLine", "component"].forEach((k) => {
      if (!(k in data))
        throw new Error(`Missing required "${k}" in exec command`);
    });
    this.commandLine = data.commandLine;
    this.component = data.component;
    this.env = data.env || [];
    this.group = data.group ? new CommandGroup(data.group) : undefined;
    this.hotReloadCapable = data.hotReloadCapable || false;
    this.label = data.label;
    this.workingDir = data.workingDir;
  }

  /** Return a plain object suitable for YAML export (omits empty/undefined fields). */
  toExport() {
    const out = {
      commandLine: this.commandLine,
      component: this.component,
    };
    if (this.workingDir) out.workingDir = this.workingDir;
    if (this.label) out.label = this.label;
    if (this.hotReloadCapable) out.hotReloadCapable = true;
    if (this.env && this.env.length) out.env = this.env;
    if (this.group && this.group.kind) {
      out.group = { kind: this.group.kind, isDefault: !!this.group.isDefault };
    }
    return out;
  }
}

class ApplyCommand {
  constructor(data) {
    if (!("component" in data))
      throw new Error("Missing required 'component' in apply command");
    this.component = data.component;
    this.group = data.group ? new CommandGroup(data.group) : undefined;
    this.label = data.label;
  }

  toExport() {
    const out = { component: this.component };
    if (this.label) out.label = this.label;
    if (this.group && this.group.kind) {
      out.group = { kind: this.group.kind, isDefault: !!this.group.isDefault };
    }
    return out;
  }
}

class CompositeCommand {
  constructor(data) {
    if ("commands" in data) this.commands = data.commands;
    this.group = data.group ? new CommandGroup(data.group) : undefined;
    this.label = data.label;
    this.parallel = data.parallel || false;
  }

  toExport() {
    const out = {};
    if (this.commands && this.commands.length) out.commands = this.commands;
    if (this.parallel) out.parallel = true;
    if (this.label) out.label = this.label;
    if (this.group && this.group.kind) {
      out.group = { kind: this.group.kind, isDefault: !!this.group.isDefault };
    }
    return out;
  }
}

class Command {
  constructor(data) {
    if (!("id" in data))
      throw new Error("Missing required property: id in command");
    this.id = data.id;
    validatePattern(this.id, "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", "command.id");
    if (!("exec" in data || "apply" in data || "composite" in data)) {
      throw new Error("Command must have one of exec/apply/composite");
    }
    if ("exec" in data) this.exec = new ExecCommand(data.exec);
    if ("apply" in data) this.apply = new ApplyCommand(data.apply);
    if ("composite" in data)
      this.composite = new CompositeCommand(data.composite);
    this.attributes = data.attributes || {};
  }

  /** Validate without throwing; returns array of error strings. */
  static errors(data) {
    const errs = [];
    if (!data.id) {
      errs.push("Command ID is required");
      return errs;
    }
    if (!isValidId(data.id))
      errs.push(`Command ID "${data.id}" is not a valid identifier`);
    if (data.type === "exec") {
      if (!data.exec?.commandLine)
        errs.push(`Command "${data.id}": commandLine is required`);
      if (!data.exec?.component)
        errs.push(`Command "${data.id}": component is required`);
    }
    if (data.type === "apply") {
      if (!data.apply?.component)
        errs.push(`Command "${data.id}": component is required`);
    }
    return errs;
  }

  toExport() {
    const out = { id: this.id };
    if (this.exec) out.exec = this.exec.toExport();
    if (this.apply) out.apply = this.apply.toExport();
    if (this.composite) out.composite = this.composite.toExport();
    return out;
  }
}

class Endpoint {
  constructor(data) {
    ["name", "targetPort"].forEach((k) => {
      if (!(k in data)) throw new Error(`Missing required "${k}" in endpoint`);
    });
    this.name = data.name;
    validatePattern(
      this.name,
      "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$",
      "endpoint.name",
    );
    this.targetPort = data.targetPort;
    this.protocol = data.protocol || "http";
    validateEnum(
      this.protocol,
      ["http", "https", "ws", "wss", "tcp", "udp"],
      "endpoint.protocol",
    );
    this.exposure = data.exposure || "public";
    validateEnum(
      this.exposure,
      ["public", "internal", "none"],
      "endpoint.exposure",
    );
    this.secure = data.secure || false;
    this.path = data.path;
    this.annotation = data.annotation || {};
    this.attributes = data.attributes || {};
  }

  static errors(data) {
    const errs = [];
    if (!data.name) errs.push("Endpoint name is required");
    else if (!isValidId(data.name))
      errs.push(`Endpoint name "${data.name}" is not a valid identifier`);
    if (!data.targetPort)
      errs.push(
        `Endpoint "${data.name || "(unnamed)"}": targetPort is required`,
      );
    return errs;
  }
}

class VolumeMount {
  constructor(data) {
    if (!("name" in data)) throw new Error("Missing 'name' in volume mount");
    this.name = data.name;
    validatePattern(
      this.name,
      "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$",
      "volumeMount.name",
    );
    this.path = data.path || `/${data.name}`;
  }
}

class VolumeComponent {
  constructor(data) {
    this.ephemeral = data.ephemeral || false;
    this.size = data.size;
  }
}

class ContainerComponent {
  constructor(data) {
    if (!("image" in data))
      throw new Error("Missing required 'image' in container");
    this.image = data.image;
    this.annotation = data.annotation || {};
    this.args = data.args || [];
    this.command = data.command || [];
    this.cpuLimit = data.cpuLimit;
    this.cpuRequest = data.cpuRequest;
    this.dedicatedPod = data.dedicatedPod || false;
    this.endpoints = data.endpoints
      ? data.endpoints.map((e) => new Endpoint(e))
      : [];
    this.env = data.env || [];
    this.memoryLimit = data.memoryLimit;
    this.memoryRequest = data.memoryRequest;
    this.mountSources =
      data.mountSources !== undefined ? data.mountSources : true;
    this.sourceMapping = data.sourceMapping || "/projects";
    this.volumeMounts = data.volumeMounts
      ? data.volumeMounts.map((vm) => new VolumeMount(vm))
      : [];
  }

  static errors(data) {
    const errs = [];
    if (!data.image) errs.push("Container image is required");
    (data.endpoints || []).forEach((ep) => errs.push(...Endpoint.errors(ep)));
    return errs;
  }
}

class ImageComponent {
  constructor(data) {
    if (!("imageName" in data))
      throw new Error("Missing 'imageName' in image component");
    this.imageName = data.imageName;
    this.autoBuild = data.autoBuild || false;
  }
}

class K8sComponent {
  constructor(data) {
    if (!("uri" in data || "inlined" in data)) {
      throw new Error("Kubernetes component requires 'uri' or 'inlined'");
    }
    this.uri = data.uri;
    this.inlined = data.inlined;
    this.deployByDefault = data.deployByDefault || false;
    this.endpoints = data.endpoints
      ? data.endpoints.map((e) => new Endpoint(e))
      : [];
  }
}

class OpenshiftComponent {
  constructor(data) {
    if (!("uri" in data || "inlined" in data)) {
      throw new Error("Openshift component requires 'uri' or 'inlined'");
    }
    this.uri = data.uri;
    this.inlined = data.inlined;
    this.deployByDefault = data.deployByDefault || false;
    this.endpoints = data.endpoints
      ? data.endpoints.map((e) => new Endpoint(e))
      : [];
  }
}

class Component {
  constructor(data) {
    if (!("name" in data)) throw new Error("Missing 'name' in component");
    this.name = data.name;
    validatePattern(
      this.name,
      "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$",
      "component.name",
    );
    this.attributes = data.attributes || {};
    if ("container" in data)
      this.container = new ContainerComponent(data.container);
    else if ("kubernetes" in data)
      this.kubernetes = new K8sComponent(data.kubernetes);
    else if ("openshift" in data)
      this.openshift = new OpenshiftComponent(data.openshift);
    else if ("volume" in data) this.volume = new VolumeComponent(data.volume);
    else if ("image" in data) this.image = new ImageComponent(data.image);
    else
      throw new Error(
        "Component must have one of container/kubernetes/openshift/volume/image",
      );
  }

  static errors(data) {
    const errs = [];
    if (!data.name) errs.push("Component name is required");
    else if (!isValidId(data.name))
      errs.push(`Component name "${data.name}" is not a valid identifier`);
    if (data.container) errs.push(...ContainerComponent.errors(data.container));
    return errs;
  }
}

class GitSource {
  constructor(data) {
    if (!("remotes" in data))
      throw new Error("Missing 'remotes' in git source");
    this.remotes = data.remotes;
    this.checkoutFrom = data.checkoutFrom;
  }
}

class ZipSource {
  constructor(data) {
    if (!("location" in data))
      throw new Error("Missing 'location' in zip source");
    this.location = data.location;
  }
}

class Project {
  constructor(data) {
    if (!("name" in data)) throw new Error("Missing 'name' in project");
    this.name = data.name;
    validatePattern(
      this.name,
      "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$",
      "project.name",
    );
    if (!("git" in data || "zip" in data)) {
      throw new Error("Project must have either 'git' or 'zip' source");
    }
    if ("git" in data) this.git = new GitSource(data.git);
    if ("zip" in data) this.zip = new ZipSource(data.zip);
    this.clonePath = data.clonePath || this.name;
    this.attributes = data.attributes || {};
  }

  static errors(data) {
    const errs = [];
    if (!data.name) errs.push("Project name is required");
    else if (!isValidId(data.name))
      errs.push(`Project name "${data.name}" is not a valid identifier`);
    const origin = data.git?.remotes?.origin;
    if (!origin)
      errs.push(
        `Project "${data.name || "(unnamed)"}": git remote origin is required`,
      );
    return errs;
  }
}

class Events {
  constructor(data) {
    this.preStart = data.preStart || [];
    this.postStart = data.postStart || [];
    this.preStop = data.preStop || [];
    this.postStop = data.postStop || [];
  }
}

class Metadata {
  constructor(data) {
    this.architectures = data.architectures || [];
    if (this.architectures.length) {
      this.architectures.forEach((a) =>
        validateEnum(
          a,
          ["amd64", "arm64", "ppc64le", "s390x"],
          "metadata.architectures",
        ),
      );
    }
    this.attributes = data.attributes || {};
    this.description = data.description;
    this.displayName = data.displayName;
    this.globalMemoryLimit = data.globalMemoryLimit;
    this.icon = data.icon;
    this.language = data.language;
    this.name = data.name;
    this.projectType = data.projectType;
    this.provider = data.provider;
    this.supportUrl = data.supportUrl;
    this.tags = data.tags || [];
    this.version = data.version;
    if (this.version) {
      validatePattern(
        this.version,
        "^([0-9]+)\\.([0-9]+)\\.([0-9]+)(\\-[0-9a-z-]+(\\.[0-9a-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$",
        "metadata.version",
      );
    }
    this.website = data.website;
  }
}

class Devfile {
  constructor(data) {
    if (!("schemaVersion" in data))
      throw new Error("Missing required property: schemaVersion");
    this.schemaVersion = data.schemaVersion;
    validatePattern(
      this.schemaVersion,
      "^([2-9])\\.([0-9]+)\\.([0-9]+)(\\-[0-9a-z-]+(\\.[0-9a-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$",
      "schemaVersion",
    );
    this.attributes = data.attributes || {};
    this.commands = data.commands
      ? data.commands.map((c) => new Command(c))
      : [];
    this.components = data.components
      ? data.components.map((c) => new Component(c))
      : [];
    this.events = data.events ? new Events(data.events) : undefined;
    this.metadata = data.metadata ? new Metadata(data.metadata) : undefined;
    this.projects = data.projects
      ? data.projects.map((p) => new Project(p))
      : [];
    this.starterProjects = data.starterProjects
      ? data.starterProjects.map((p) => new Project(p))
      : [];
    this.variables = data.variables || {};
  }

  /**
   * Validate a plain devfile data object without throwing.
   * Returns { valid: bool, errors: string[] }.
   */
  static validate(data) {
    const errors = [];
    try {
      new Devfile(data);
    } catch (e) {
      errors.push(e.message);
    }
    // Additional cross-cutting checks
    (data.components || []).forEach((c) => errors.push(...Component.errors(c)));
    (data.projects || []).forEach((p) => errors.push(...Project.errors(p)));
    (data.commands || []).forEach((c) => errors.push(...Command.errors(c)));
    return { valid: errors.length === 0, errors };
  }
}

/** Blank devfile fragment (partial devfile a catalog entry or user fragment can contribute). */
function defaultFragment() {
  return {
    // UI metadata — not written to the devfile output
    id: `fragment-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: "",
    description: "",
    icon: "🧩",
    // Partial devfile fields this fragment contributes.
    // Only non-empty entries are merged into the base on export.
    devfile: {
      variables: {},
      attributes: {},
      components: [], // additional container/volume components
      projects: [],
      starterProjects: [],
      commands: [],
      events: { preStart: [], postStart: [], preStop: [], postStop: [] },
    },
  };
}

/**
 * Deep-merge a list of partial devfile fragments into a base devfile object.
 * Returns { merged, errors } where errors is an array of conflict messages.
 *
 * Merge rules:
 *   schemaVersion, metadata  — base wins (fragments cannot override)
 *   variables, attributes    — shallow merge; base wins on key conflicts
 *   components               — array concat; duplicate names are errors
 *   projects, starterProjects — array concat; duplicate names are errors
 *   commands                 — array concat; duplicate IDs are errors
 *   events.*                 — array union (deduplicated)
 */
function mergeDevfileFragments(base, fragments) {
  const errors = [];

  // Work on a deep clone of the base so we never mutate it
  const merged = JSON.parse(JSON.stringify(base));

  // Seed uniqueness trackers from the base
  const componentNames = new Set((merged.components || []).map((c) => c.name));
  const projectNames = new Set((merged.projects || []).map((p) => p.name));
  const starterNames = new Set(
    (merged.starterProjects || []).map((s) => s.name),
  );
  const commandIds = new Set((merged.commands || []).map((c) => c.id));

  for (const frag of fragments) {
    const d = frag.devfile || {};

    // variables — base wins
    for (const [k, v] of Object.entries(d.variables || {})) {
      if (!(k in (merged.variables || {}))) {
        merged.variables = merged.variables || {};
        merged.variables[k] = v;
      }
    }

    // attributes — base wins
    for (const [k, v] of Object.entries(d.attributes || {})) {
      if (!(k in (merged.attributes || {}))) {
        merged.attributes = merged.attributes || {};
        merged.attributes[k] = v;
      }
    }

    // components — concat, error on duplicate name
    for (const comp of d.components || []) {
      if (componentNames.has(comp.name)) {
        errors.push(
          `Fragment "${frag.name || frag.id}": component name "${comp.name}" already exists.`,
        );
      } else {
        merged.components = merged.components || [];
        merged.components.push(comp);
        componentNames.add(comp.name);
      }
    }

    // projects — concat, error on duplicate name
    for (const proj of d.projects || []) {
      if (projectNames.has(proj.name)) {
        errors.push(
          `Fragment "${frag.name || frag.id}": project name "${proj.name}" already exists.`,
        );
      } else {
        merged.projects = merged.projects || [];
        merged.projects.push(proj);
        projectNames.add(proj.name);
      }
    }

    // starterProjects — concat, error on duplicate name
    for (const sp of d.starterProjects || []) {
      if (starterNames.has(sp.name)) {
        errors.push(
          `Fragment "${frag.name || frag.id}": starterProject name "${sp.name}" already exists.`,
        );
      } else {
        merged.starterProjects = merged.starterProjects || [];
        merged.starterProjects.push(sp);
        starterNames.add(sp.name);
      }
    }

    // commands — concat, error on duplicate ID
    for (const cmd of d.commands || []) {
      if (commandIds.has(cmd.id)) {
        errors.push(
          `Fragment "${frag.name || frag.id}": command ID "${cmd.id}" already exists.`,
        );
      } else {
        merged.commands = merged.commands || [];
        merged.commands.push(cmd);
        commandIds.add(cmd.id);
      }
    }

    // events — union per lifecycle key
    const fragEvents = d.events || {};
    for (const key of ["preStart", "postStart", "preStop", "postStop"]) {
      for (const cmdId of fragEvents[key] || []) {
        merged.events = merged.events || {};
        merged.events[key] = merged.events[key] || [];
        if (!merged.events[key].includes(cmdId)) {
          merged.events[key].push(cmdId);
        }
      }
    }
  }

  return { merged, errors };
}

export {
  Devfile,
  Command,
  ExecCommand,
  ApplyCommand,
  CompositeCommand,
  CommandGroup,
  Component,
  ContainerComponent,
  Endpoint,
  VolumeMount,
  VolumeComponent,
  Project,
  GitSource,
  Events,
  Metadata,
  isValidId,
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
};
