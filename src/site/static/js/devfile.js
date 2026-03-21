// Utility function for regex and enum validation
function validatePattern(value, pattern, field) {
  if (!new RegExp(pattern).test(value)) {
    throw new Error(`Invalid value for "${field}": "${value}" does not match pattern ${pattern}`);
  }
}
function validateEnum(value, enumArr, field) {
  if (!enumArr.includes(value)) {
    throw new Error(`Invalid value for "${field}": "${value}". Allowed: ${enumArr.join(", ")}`);
  }
}

class Devfile {
  constructor(data) {
    // Required
    if (!("schemaVersion" in data)) throw new Error("Missing required property: schemaVersion");
    this.schemaVersion = data.schemaVersion;
    validatePattern(this.schemaVersion, "^([2-9])\\.([0-9]+)\\.([0-9]+)(\\-[0-9a-z-]+(\\.[0-9a-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$", "schemaVersion");

    // Optional
    this.attributes = data.attributes || {};
    this.commands = data.commands ? data.commands.map(c => new Command(c)) : [];
    this.components = data.components ? data.components.map(c => new Component(c)) : [];
    this.dependentProjects = data.dependentProjects ? data.dependentProjects.map(p => new Project(p)) : [];
    this.events = data.events ? new Events(data.events) : undefined;
    this.metadata = data.metadata ? new Metadata(data.metadata) : undefined;
    this.parent = data.parent ? new Parent(data.parent) : undefined;
    this.projects = data.projects ? data.projects.map(p => new Project(p)) : [];
    this.starterProjects = data.starterProjects ? data.starterProjects.map(p => new Project(p)) : [];
    this.variables = data.variables || {};
  }
}

class Command {
  constructor(data) {
    if (!("id" in data)) throw new Error("Missing required property: id in command");
    this.id = data.id;
    validatePattern(this.id, "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", "command.id");
    if (!("exec" in data || "apply" in data || "composite" in data))
      throw new Error("Command must have one of exec/apply/composite");
    if ("exec" in data) this.exec = new ExecCommand(data.exec);
    if ("apply" in data) this.apply = new ApplyCommand(data.apply);
    if ("composite" in data) this.composite = new CompositeCommand(data.composite);
    this.attributes = data.attributes || {};
  }
}
class ExecCommand {
  constructor(data) {
    ["commandLine", "component"].forEach(k => {
      if (!(k in data)) throw new Error(`Missing required "${k}" in exec command`);
    });
    this.commandLine = data.commandLine;
    this.component = data.component;
    this.env = data.env || [];
    this.group = data.group ? new CommandGroup(data.group) : undefined;
    this.hotReloadCapable = data.hotReloadCapable || false;
    this.label = data.label;
    this.workingDir = data.workingDir;
  }
}
class ApplyCommand {
  constructor(data) {
    if (!("component" in data)) throw new Error("Missing required 'component' in apply command");
    this.component = data.component;
    this.group = data.group ? new CommandGroup(data.group) : undefined;
    this.label = data.label;
  }
}
class CompositeCommand {
  constructor(data) {
    if ("commands" in data) this.commands = data.commands;
    this.group = data.group ? new CommandGroup(data.group) : undefined;
    this.label = data.label;
    this.parallel = data.parallel || false;
  }
}
class CommandGroup {
  constructor(data) {
    if (!("kind" in data)) throw new Error("Missing required 'kind' in command group");
    this.kind = data.kind;
    validateEnum(this.kind, ["build", "run", "test", "debug", "deploy"], "group.kind");
    this.isDefault = data.isDefault || false;
  }
}

class Component {
  constructor(data) {
    if (!("name" in data)) throw new Error("Missing 'name' in component");
    this.name = data.name;
    validatePattern(this.name, "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", "component.name");

    this.attributes = data.attributes || {};
    if ("container" in data) {
      this.container = new ContainerComponent(data.container);
    } else if ("kubernetes" in data) {
      this.kubernetes = new K8sComponent(data.kubernetes);
    } else if ("openshift" in data) {
      this.openshift = new OpenshiftComponent(data.openshift);
    } else if ("volume" in data) {
      this.volume = new VolumeComponent(data.volume);
    } else if ("image" in data) {
      this.image = new ImageComponent(data.image);
    } else {
      throw new Error("Component must have one of container/kubernetes/openshift/volume/image");
    }
  }
}
class ContainerComponent {
  constructor(data) {
    if (!("image" in data)) throw new Error("Missing required 'image' in container");
    this.image = data.image;
    this.annotation = data.annotation || {};
    this.args = data.args || [];
    this.command = data.command || [];
    this.cpuLimit = data.cpuLimit;
    this.cpuRequest = data.cpuRequest;
    this.dedicatedPod = data.dedicatedPod || false;
    this.endpoints = data.endpoints ? data.endpoints.map(e => new Endpoint(e)) : [];
    this.env = data.env || [];
    this.memoryLimit = data.memoryLimit;
    this.memoryRequest = data.memoryRequest;
    this.mountSources = data.mountSources !== undefined ? data.mountSources : true;
    this.sourceMapping = data.sourceMapping || "/projects";
    this.volumeMounts = data.volumeMounts ? data.volumeMounts.map(vm => new VolumeMount(vm)) : [];
  }
}
class Endpoint {
  constructor(data) {
    ["name", "targetPort"].forEach(k => { if (!(k in data)) throw new Error(`Missing required "${k}" in endpoint`); });
    this.name = data.name;
    validatePattern(this.name, "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", "endpoint.name");
    this.targetPort = data.targetPort;
    this.protocol = data.protocol || "http";
    validateEnum(this.protocol, ["http", "https", "ws", "wss", "tcp", "udp"], "endpoint.protocol");
    this.exposure = data.exposure || "public";
    validateEnum(this.exposure, ["public", "internal", "none"], "endpoint.exposure");
    this.secure = data.secure || false;
    this.path = data.path;
    this.annotation = data.annotation || {};
    this.attributes = data.attributes || {};
  }
}
class VolumeMount {
  constructor(data) {
    if (!("name" in data)) throw new Error("Missing 'name' in volume mount");
    this.name = data.name;
    validatePattern(this.name, "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", "volumeMount.name");
    this.path = data.path || `/${data.name}`;
  }
}
class K8sComponent {
  constructor(data) {
    if (!("uri" in data || "inlined" in data)) throw new Error("Kubernetes component requires 'uri' or 'inlined'");
    this.uri = data.uri;
    this.inlined = data.inlined;
    this.deployByDefault = data.deployByDefault || false;
    this.endpoints = data.endpoints ? data.endpoints.map(e => new Endpoint(e)) : [];
  }
}
class OpenshiftComponent {
  constructor(data) {
    if (!("uri" in data || "inlined" in data)) throw new Error("Openshift component requires 'uri' or 'inlined'");
    this.uri = data.uri;
    this.inlined = data.inlined;
    this.deployByDefault = data.deployByDefault || false;
    this.endpoints = data.endpoints ? data.endpoints.map(e => new Endpoint(e)) : [];
  }
}
class VolumeComponent {
  constructor(data) {
    this.ephemeral = data.ephemeral || false;
    this.size = data.size;
  }
}
class ImageComponent {
  constructor(data) {
    if (!("imageName" in data)) throw new Error("Missing 'imageName' in image component");
    this.imageName = data.imageName;
    if ("dockerfile" in data) this.dockerfile = new Dockerfile(data.dockerfile);
    this.autoBuild = data.autoBuild || false;
  }
}
class Dockerfile {
  constructor(data) {
    if (!("uri" in data || "devfileRegistry" in data || "git" in data)) {
      throw new Error("Dockerfile requires uri, devfileRegistry or git");
    }
    this.args = data.args || [];
    this.buildContext = data.buildContext;
    this.rootRequired = data.rootRequired || false;
    this.uri = data.uri;
    this.devfileRegistry = data.devfileRegistry;
    this.git = data.git;
  }
}

// Project and StarterProject are similar
class Project {
  constructor(data) {
    if (!("name" in data)) throw new Error("Missing 'name' in project");
    this.name = data.name;
    validatePattern(this.name, "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", "project.name");
    if (!("git" in data || "zip" in data))
      throw new Error("Project must have either 'git' or 'zip' source");
    if ("git" in data) this.git = new GitSource(data.git);
    if ("zip" in data) this.zip = new ZipSource(data.zip);
    this.clonePath = data.clonePath || this.name;
    this.attributes = data.attributes || {};
  }
}
class GitSource {
  constructor(data) {
    if (!("remotes" in data)) throw new Error("Missing 'remotes' in git source");
    this.remotes = data.remotes;
    this.checkoutFrom = data.checkoutFrom;
  }
}
class ZipSource {
  constructor(data) {
    if (!("location" in data)) throw new Error("Missing 'location' in zip source");
    this.location = data.location;
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
      this.architectures.forEach(a =>
        validateEnum(a, ["amd64", "arm64", "ppc64le", "s390x"], "metadata.architectures"));
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
    if (this.version)
      validatePattern(this.version, "^([0-9]+)\\.([0-9]+)\\.([0-9]+)(\\-[0-9a-z-]+(\\.[0-9a-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$", "metadata.version");
    this.website = data.website;
  }
}

class Parent {
  constructor(data) {
    if (!("uri" in data || "id" in data || "kubernetes" in data))
      throw new Error("Parent must have 'uri', 'id' or 'kubernetes'");
    this.uri = data.uri;
    this.id = data.id;
    this.registryUrl = data.registryUrl;
    this.version = data.version;
    this.attributes = data.attributes || {};
    this.commands = data.commands ? data.commands.map(c => new Command(c)) : [];
    this.components = data.components ? data.components.map(c => new Component(c)) : [];
    this.dependentProjects = data.dependentProjects ? data.dependentProjects.map(p => new Project(p)) : [];
    this.projects = data.projects ? data.projects.map(p => new Project(p)) : [];
    this.starterProjects = data.starterProjects ? data.starterProjects.map(p => new Project(p)) : [];
    this.variables = data.variables || {};
    this.kubernetes = data.kubernetes;
  }
}

// Usage Example:
// const devfile = new Devfile(devfileJson);
// devfile will be fully validated and structured

export {
  Devfile, Command, Component, Project, Events, Metadata, Parent,
};