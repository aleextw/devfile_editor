// script.js — entry point for the devfile configurator
// Registers all Alpine stores and starts Alpine.

import {
  registerStores,
  CATALOG,
  PREDEFINED_COMMANDS,
  PREDEFINED_REPOS,
  PREDEFINED_CONFIGS,
} from "./store.js";
import { Devfile } from "./devfile.js";

// Expose catalog data to Jinja-rendered Alpine x-data blocks (no ES module access there).
// _generateAndExport is wired up at the bottom of this file, after the function is defined.
window._devfileStore = {
  CATALOG,
  PREDEFINED_COMMANDS,
  PREDEFINED_REPOS,
  PREDEFINED_CONFIGS,
};
window._Devfile = Devfile;

document.addEventListener("alpine:init", () => {
  registerStores();

  // ── Import section component ───────────────────────────────────────────────
  // Registered here so the _hydrateStore logic lives in JS, not in an HTML attribute.
  Alpine.data("devfileImport", () => ({
    doImport() {
      const raw = Alpine.store("ui").importYaml.trim();
      const ui = Alpine.store("ui");
      if (!raw) {
        ui.importStatus = {
          type: "err",
          message: "Please paste a devfile YAML first.",
        };
        ui.importResultVisible = false;
        return;
      }
      try {
        const data = jsyaml.load(raw);
        const result = Devfile.validate(data);
        if (!result.valid) {
          ui.importStatus = {
            type: "err",
            message: "✖ " + result.errors.join("<br>✖ "),
          };
          ui.importResultVisible = false;
          return;
        }
        ui.importStatus = {
          type: "ok",
          message: `✔ Valid devfile. Schema version: ${data.schemaVersion}`,
        };
        ui.importJsonOutput = JSON.stringify(data, null, 2);
        ui.importResultVisible = true;
        this._hydrateStore(data);
      } catch (e) {
        ui.importStatus = { type: "err", message: "✖ " + e.message };
        ui.importResultVisible = false;
      }
    },

    _hydrateStore(data) {
      const store = Alpine.store("devfile");

      // Top-level fields
      store.schemaVersion = data.schemaVersion ?? "2.3.0";
      store.metadata = {
        name: data.metadata?.name ?? "",
        displayName: data.metadata?.displayName ?? "",
        description: data.metadata?.description ?? "",
        version: data.metadata?.version ?? "",
        language: data.metadata?.language ?? "",
        projectType: data.metadata?.projectType ?? "",
        provider: data.metadata?.provider ?? "",
        supportUrl: data.metadata?.supportUrl ?? "",
        website: data.metadata?.website ?? "",
        icon: data.metadata?.icon ?? "",
        tags: data.metadata?.tags ?? [],
        architectures: data.metadata?.architectures ?? [],
        attributes: data.metadata?.attributes ?? {},
      };
      store.variables = data.variables ?? {};
      store.attributes = data.attributes ?? {};

      // Container component (first container component wins)
      const mainComp = (data.components || []).find((c) => c.container);
      if (mainComp) {
        const ct = mainComp.container;
        store.components = [
          {
            name: mainComp.name,
            container: {
              image: ct.image || "",
              mountSources: ct.mountSources !== false,
              sourceMapping: ct.sourceMapping || "/projects",
              dedicatedPod: ct.dedicatedPod || false,
              cpuRequest: ct.cpuRequest || "",
              cpuLimit: ct.cpuLimit || "",
              memoryRequest: ct.memoryRequest || "",
              memoryLimit: ct.memoryLimit || "",
              env: [],
              endpoints: [],
              volumeMounts: [],
            },
          },
        ];
        store.customEnv = (ct.env || []).map((e) => ({
          name: e.name,
          value: e.value || "",
        }));
        store.endpoints = (ct.endpoints || []).map((e) => ({
          name: e.name,
          targetPort: e.targetPort,
          protocol: e.protocol || "http",
          exposure: e.exposure || "public",
        }));
      }

      // Volumes: volume components → flat [{name, size, mountPath}]
      const containerCt = (data.components || []).find(
        (x) => x.container,
      )?.container;
      store.volumes = (data.components || [])
        .filter((c) => c.volume)
        .map((c) => {
          const vm = (containerCt?.volumeMounts || []).find(
            (v) => v.name === c.name,
          );
          return {
            name: c.name,
            size: c.volume?.size || "",
            mountPath: vm?.path || "",
          };
        });

      // Projects
      store.projects = (data.projects || []).map((p) => ({
        name: p.name,
        git: {
          remotes: { origin: Object.values(p.git?.remotes ?? {})[0] || "" },
          checkoutFrom: p.git?.checkoutFrom ?? { revision: "main" },
        },
        clonePath: p.clonePath || p.name,
      }));

      // Starter projects
      store.starterProjects = (data.starterProjects || []).map((s) => ({
        name: s.name,
        git: {
          remotes: { origin: Object.values(s.git?.remotes ?? {})[0] || "" },
          checkoutFrom: s.git?.checkoutFrom ?? { revision: "main" },
        },
      }));

      // Commands
      store.commands = (data.commands || []).map((c) => {
        const type = c.exec ? "exec" : c.composite ? "composite" : "apply";
        const cmd = { id: c.id, type };
        if (c.exec) {
          cmd.exec = {
            commandLine: c.exec.commandLine || "",
            component: c.exec.component || "",
            workingDir: c.exec.workingDir || "",
            hotReloadCapable: c.exec.hotReloadCapable || false,
            label: c.exec.label || "",
            group: c.exec.group ?? { kind: "run", isDefault: false },
            env: c.exec.env || [],
          };
        }
        if (c.composite) {
          cmd.composite = {
            commands: c.composite.commands || [],
            parallel: c.composite.parallel || false,
            label: c.composite.label || "",
            group: c.composite.group ?? { kind: "run", isDefault: false },
          };
        }
        if (c.apply) {
          cmd.apply = {
            component: c.apply.component || "",
            label: c.apply.label || "",
            group: c.apply.group ?? { kind: "run", isDefault: false },
          };
        }
        return cmd;
      });

      // Events
      store.events = {
        preStart: data.events?.preStart || [],
        postStart: data.events?.postStart || [],
        preStop: data.events?.preStop || [],
        postStop: data.events?.postStop || [],
      };

      // Fragments — always empty when importing a plain devfile YAML
      store.fragments = [];
    },

    clearImport() {
      const ui = Alpine.store("ui");
      ui.importYaml = "";
      ui.importStatus = null;
      ui.importResultVisible = false;
    },
  }));
});

document.addEventListener("alpine:initialized", async () => {
  // Hydrate from URL hash if present
  if (location.hash.startsWith("#c=")) {
    await Alpine.store("devfile").hydrateFromHash(location.hash.slice(3));
  }

  // Re-hydrate when the hash changes (template Load links, etc.)
  window.addEventListener("hashchange", async () => {
    if (location.hash.startsWith("#c=")) {
      await Alpine.store("devfile").hydrateFromHash(location.hash.slice(3));
      Alpine.store("ui").setSection("metadata");
    }
  });

  // Header buttons
  document
    .getElementById("generate-btn")
    ?.addEventListener("click", async () => {
      Alpine.store("ui").setSection("output");
      await generateAndExport();
    });

  document.getElementById("import-btn")?.addEventListener("click", () => {
    Alpine.store("ui").setSection("import");
  });
});

// ── Generate & Export ─────────────────────────────────────────────────────────
// Called from the output section's Regenerate button and the header button.
export async function generateAndExport() {
  const store = Alpine.store("devfile");
  const ui = Alpine.store("ui");

  const { data, errors: catalogErrors } = store.buildExport();

  if (catalogErrors.length) {
    ui.outputStatus = {
      type: "err",
      message: catalogErrors.map((e) => `✖ ${e}`).join("<br>"),
    };
    return;
  }

  const { valid, errors } = Devfile.validate(data);
  if (!valid) {
    ui.outputStatus = { type: "err", message: "✖ " + errors.join("<br>✖ ") };
  } else {
    ui.outputStatus = {
      type: "ok",
      message: "✔ Devfile is valid (schema v2.3.0).",
    };
  }

  const plain = JSON.parse(JSON.stringify(data));
  ui.yamlOutput = jsyaml.dump(plain, { sortKeys: false, lineWidth: 120 });
  ui.jsonOutput = JSON.stringify(plain, null, 2);

  // Push to URL and build share links
  const blob = await store.pushToURL();
  ui.shareUrl = `${location.origin}${location.pathname}#c=${blob}`;
  ui.rawUrl = `${location.origin}/raw?c=${blob}`;
  ui.shareSizeTag = `~${(blob.length / 1024).toFixed(1)} KB`;
  ui.sharePanelVisible = true;
}

// Wire up after function definition so the reference is valid.
window._generateAndExport = generateAndExport;
