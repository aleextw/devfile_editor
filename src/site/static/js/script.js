// devfile.js — devfile configurator logic
// Loaded as type="module" from index.html after js-yaml is available on window.
// Imports Devfile from devfile.js (the schema class), which must also be present.
//
// Depends on window.DEVFILE_CONFIG being set by an inline <script> in index.html:
//   window.DEVFILE_CONFIG = { predefinedRepos: [...] };

import { Devfile } from "./devfile.js";

// ─── Config from template ─────────────────────────────────────────────────────
// predefinedRepos: array of {name, remotes, revision, remote, clone_path,
// description} injected server-side via Jinja2. Empty array = picker not shown.
const PREDEFINED_REPOS = window.DEVFILE_CONFIG?.predefinedRepos ?? [];
// predefinedConfigs: array of {name, description, blob} injected server-side.
// The blob is a ready-to-use base64url state hash — Load links use #c=<blob>.
const PREDEFINED_CONFIGS = window.DEVFILE_CONFIG?.predefinedConfigs ?? [];

// ─── State ────────────────────────────────────────────────────────────────────
// Repo shape mirrors the devfile Project schema:
//   name       — project.name
//   remotes    — project.git.remotes  (object, e.g. {origin: "https://..."})
//   revision   — project.git.checkoutFrom.revision  (branch / tag / commit)
//   remote     — project.git.checkoutFrom.remote    (only needed with multiple remotes)
//   clonePath  — project.clonePath
const state = {
  repos: [],
  starters: [],
  resources: {
    image: "quay.io/devfile/universal-developer-image:latest",
    name: "dev",
    sourceMapping: "/projects",
    mountSources: true,
    dedicatedPod: false,
    cpuRequest: "500m",
    cpuLimit: "2",
    memRequest: "512Mi",
    memLimit: "4Gi",
  },
  endpoints: [],
  customEnv: [],
  volumes: [],
  activeComponents: new Set(),
  componentConfigs: {},
  commands: [], // [{id, type, exec?, composite?, apply?}]
  events: { preStart: [], postStart: [], preStop: [], postStop: [] },
};

const cpuSteps = [
  "",
  "100m",
  "200m",
  "300m",
  "500m",
  "750m",
  "1",
  "1500m",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "10",
  "12",
  "16",
  "20",
  "24",
  "32",
];
const memSteps = [
  "",
  "128Mi",
  "256Mi",
  "384Mi",
  "512Mi",
  "768Mi",
  "1Gi",
  "1536Mi",
  "2Gi",
  "3Gi",
  "4Gi",
  "6Gi",
  "8Gi",
  "10Gi",
  "12Gi",
  "16Gi",
  "20Gi",
  "24Gi",
  "32Gi",
  "48Gi",
  "64Gi",
];

// ─── Predefined commands (from server config) ─────────────────────────────────
// Array of command objects injected from DEVFILE_PREDEFINED_COMMANDS_FILE.
// Each entry is a full devfile Command object (id + exec/composite/apply)
// plus optional UI-only fields: display_name, description.
const PREDEFINED_COMMANDS = window.DEVFILE_CONFIG?.predefinedCommands ?? [];

// ─── Component catalog (from server config) ───────────────────────────────────
// Each item: { id, name, icon, description, fields, contributions }
// contributions: { env: [{name, value, value_from}],
//                  volumes: [{name, name_from, name_default, size, size_from,
//                             mount_path, slugify}],
//                  endpoints: [{name, target_port, port_from, protocol, exposure}] }
const CATALOG = window.DEVFILE_CONFIG?.componentCatalog ?? [];

function el(id) {
  return document.getElementById(id);
}
function renderBadge(id, count) {
  const b = document.querySelector(
    `.sidebar-nav [data-section="${id}"] .nav-badge`,
  );
  if (b) b.textContent = count;
}

// ─── Nav ──────────────────────────────────────────────────────────────────────
document.querySelectorAll(".sidebar-nav .nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    document
      .querySelectorAll(".sidebar-nav .nav-item")
      .forEach((i) => i.classList.remove("active"));
    document
      .querySelectorAll(".section")
      .forEach((s) => s.classList.remove("active"));
    item.classList.add("active");
    el("section-" + item.dataset.section).classList.add("active");
  });
});

// ─── Toggles ──────────────────────────────────────────────────────────────────
document.querySelectorAll(".toggle").forEach((t) => {
  t.addEventListener("click", () => {
    const on = t.dataset.state === "true";
    t.dataset.state = !on;
    t.classList.toggle("on", !on);
    if (t.id === "mount-sources-toggle") state.resources.mountSources = !on;
    if (t.id === "dedicated-pod-toggle") state.resources.dedicatedPod = !on;
  });
});

// ─── Resource sliders ─────────────────────────────────────────────────────────
function syncSliderToText(sliderId, textId, valId, steps) {
  const slider = el(sliderId),
    text = el(textId),
    val = el(valId);
  slider.addEventListener("input", () => {
    const v = steps[+slider.value] || "";
    text.value = v;
    val.textContent = v || "—";
    syncResourceState();
  });
  text.addEventListener("input", () => {
    val.textContent = text.value || "—";
    syncResourceState();
  });
}
syncSliderToText(
  "cpu-request-slider",
  "cpu-request-text",
  "cpu-request-val",
  cpuSteps,
);
syncSliderToText(
  "cpu-limit-slider",
  "cpu-limit-text",
  "cpu-limit-val",
  cpuSteps,
);
syncSliderToText(
  "mem-request-slider",
  "mem-request-text",
  "mem-request-val",
  memSteps,
);
syncSliderToText(
  "mem-limit-slider",
  "mem-limit-text",
  "mem-limit-val",
  memSteps,
);

function syncResourceState() {
  state.resources.cpuRequest = el("cpu-request-text").value;
  state.resources.cpuLimit = el("cpu-limit-text").value;
  state.resources.memRequest = el("mem-request-text").value;
  state.resources.memLimit = el("mem-limit-text").value;
  state.resources.image = el("container-image").value;
  state.resources.name = el("container-name").value;
  state.resources.sourceMapping = el("source-mapping").value;
}
["container-image", "container-name", "source-mapping"].forEach((id) =>
  el(id).addEventListener("input", syncResourceState),
);

// ─── Repositories ─────────────────────────────────────────────────────────────
function renderRepos() {
  const list = el("repo-list"),
    empty = el("repo-empty");
  list.innerHTML = "";
  empty.style.display = state.repos.length ? "none" : "block";
  state.repos.forEach((r, i) => {
    // Primary remote is the first entry in the remotes object (usually "origin")
    const remoteEntries = Object.entries(r.remotes || {});
    const primaryName = remoteEntries[0]?.[0] ?? "origin";
    const primaryUrl = remoteEntries[0]?.[1] ?? "";
    // Extra remotes beyond the first
    const extraEntries = remoteEntries.slice(1);

    const entry = document.createElement("div");
    entry.className = "repo-entry";
    entry.style.gridTemplateColumns = "1fr 1fr auto";
    entry.innerHTML = `
      <div class="field-group">
        <label class="field-label">Project Name</label>
        <input type="text" value="${r.name}" placeholder="my-project"
               data-field="name" data-idx="${i}">
        <p class="field-hint">^[a-z0-9]([-a-z0-9]*[a-z0-9])?$, max 63 chars</p>
      </div>
      <div class="field-group">
        <label class="field-label">Remote URL
          <span class="tag" style="margin-left:6px;font-size:9px">${primaryName}</span>
        </label>
        <input type="text" value="${primaryUrl}" placeholder="https://github.com/org/repo"
               data-field="remotes.${primaryName}" data-idx="${i}">
        ${extraEntries
          .map(
            ([rname, rurl]) => `
          <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
            <span class="tag" style="flex-shrink:0;font-size:9px">${rname}</span>
            <input type="text" value="${rurl}" placeholder="https://..."
                   data-field="remotes.${rname}" data-idx="${i}" style="flex:1">
          </div>`,
          )
          .join("")}
      </div>
      <div class="field-group">
        <label class="field-label">Branch / Revision</label>
        <input type="text" value="${r.revision ?? "main"}" placeholder="main"
               data-field="revision" data-idx="${i}">
        ${
          remoteEntries.length > 1
            ? `
          <label class="field-label" style="margin-top:8px">Checkout Remote</label>
          <input type="text" value="${r.remote ?? ""}" placeholder="${primaryName}"
                 data-field="remote" data-idx="${i}">
          <p class="field-hint">Required when multiple remotes are configured.</p>`
            : ""
        }
      </div>
      <div class="remove-btn">
        <button class="btn btn-danger btn-sm" data-remove="${i}">✕</button>
      </div>`;
    list.appendChild(entry);
  });

  // Wire up field changes — handle both simple fields and nested remotes.X
  list.querySelectorAll("input[data-field]").forEach((inp) =>
    inp.addEventListener("input", (e) => {
      const idx = +e.target.dataset.idx;
      const field = e.target.dataset.field;
      if (field.startsWith("remotes.")) {
        const remoteName = field.slice("remotes.".length);
        state.repos[idx].remotes = {
          ...state.repos[idx].remotes,
          [remoteName]: e.target.value,
        };
      } else {
        state.repos[idx][field] = e.target.value;
      }
      renderBadge("repositories", state.repos.length);
    }),
  );
  list.querySelectorAll("[data-remove]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      state.repos.splice(+e.currentTarget.dataset.remove, 1);
      renderRepos();
    }),
  );
  renderBadge("repositories", state.repos.length);
}

el("add-repo-btn").addEventListener("click", () => {
  state.repos.push({
    name: "",
    remotes: { origin: "" },
    revision: "main",
    remote: "",
    clonePath: "",
  });
  renderRepos();
});

// ─── Predefined repo picker ───────────────────────────────────────────────────
// Only wired up if the picker was rendered (PREDEFINED_REPOS is non-empty).
if (PREDEFINED_REPOS.length) {
  const selectAllBtn = el("select-all-repos-btn");
  const addSelectedBtn = el("add-selected-repos-btn");

  // Select All / Deselect All toggle
  selectAllBtn.addEventListener("click", () => {
    const checks = document.querySelectorAll(".predefined-repo-check");
    const allChecked = [...checks].every((c) => c.checked);
    checks.forEach((c) => {
      c.checked = !allChecked;
    });
    selectAllBtn.textContent = allChecked ? "Select All" : "Deselect All";
  });

  // Sync label when individual checkboxes change
  document
    .getElementById("predefined-repo-list")
    ?.addEventListener("change", () => {
      const checks = document.querySelectorAll(".predefined-repo-check");
      selectAllBtn.textContent = [...checks].every((c) => c.checked)
        ? "Deselect All"
        : "Select All";
    });

  // Add Selected — looks up each checked row in PREDEFINED_REPOS by name
  // to get the full remotes object, avoiding any attribute encoding issues.
  addSelectedBtn.addEventListener("click", () => {
    const rows = document.querySelectorAll(".predefined-repo-row");
    let added = 0;
    rows.forEach((row) => {
      const check = row.querySelector(".predefined-repo-check");
      if (!check?.checked) return;

      const name = row.dataset.name;

      // Skip duplicates (by name)
      if (state.repos.some((r) => r.name === name)) return;

      // Look up the full repo definition from the in-memory catalog
      // rather than decoding it from a data attribute.
      const predefined = PREDEFINED_REPOS.find((r) => r.name === name);
      if (!predefined) return;

      state.repos.push({
        name,
        remotes: predefined.remotes,
        revision: predefined.revision || "main",
        remote: predefined.remote || "",
        clonePath: predefined.clone_path || name,
      });
      check.checked = false;
      added++;
    });

    if (added > 0) {
      renderRepos();
      selectAllBtn.textContent = "Select All";
    }
  });
}

function renderStarters() {
  const list = el("starter-list"),
    empty = el("starter-empty");
  list.innerHTML = "";
  empty.style.display = state.starters.length ? "none" : "block";
  state.starters.forEach((r, i) => {
    const primaryUrl = Object.values(r.remotes || {})[0] ?? "";
    const entry = document.createElement("div");
    entry.className = "repo-entry";
    entry.innerHTML = `
      <div class="field-group">
        <label class="field-label">Starter Name</label>
        <input type="text" value="${r.name}" placeholder="my-starter" data-field="name" data-idx="${i}">
      </div>
      <div class="field-group">
        <label class="field-label">Remote URL</label>
        <input type="text" value="${primaryUrl}" placeholder="https://github.com/org/starter"
               data-field="remotes.origin" data-idx="${i}">
      </div>
      <div class="field-group">
        <label class="field-label">Branch / Revision</label>
        <input type="text" value="${r.revision ?? "main"}" placeholder="main"
               data-field="revision" data-idx="${i}">
      </div>
      <div class="remove-btn">
        <button class="btn btn-danger btn-sm" data-remove="${i}">✕</button>
      </div>`;
    list.appendChild(entry);
  });
  list.querySelectorAll("input[data-field]").forEach((inp) =>
    inp.addEventListener("input", (e) => {
      const idx = +e.target.dataset.idx;
      const field = e.target.dataset.field;
      if (field.startsWith("remotes.")) {
        const remoteName = field.slice("remotes.".length);
        state.starters[idx].remotes = {
          ...state.starters[idx].remotes,
          [remoteName]: e.target.value,
        };
      } else {
        state.starters[idx][field] = e.target.value;
      }
    }),
  );
  list.querySelectorAll("[data-remove]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      state.starters.splice(+e.currentTarget.dataset.remove, 1);
      renderStarters();
    }),
  );
}
el("add-starter-btn").addEventListener("click", () => {
  state.starters.push({
    name: "",
    remotes: { origin: "" },
    revision: "main",
    remote: "",
  });
  renderStarters();
});

// ─── Endpoints ────────────────────────────────────────────────────────────────
function renderEndpoints() {
  const list = el("endpoint-list"),
    empty = el("endpoint-empty");
  list.innerHTML = "";
  empty.style.display = state.endpoints.length ? "none" : "block";
  state.endpoints.forEach((ep, i) => {
    const row = document.createElement("div");
    row.className = "repo-entry";
    row.style.gridTemplateColumns = "1fr 90px 110px 110px auto";
    row.innerHTML = `
      <div class="field-group"><label class="field-label">Name</label><input type="text" value="${ep.name}" placeholder="http-dev" data-field="name" data-idx="${i}"></div>
      <div class="field-group"><label class="field-label">Port</label><input type="number" value="${ep.targetPort}" placeholder="3000" data-field="targetPort" data-idx="${i}"></div>
      <div class="field-group"><label class="field-label">Protocol</label><select data-field="protocol" data-idx="${i}">${["http", "https", "ws", "wss", "tcp", "udp"].map((p) => `<option ${p === ep.protocol ? "selected" : ""}>${p}</option>`).join("")}</select></div>
      <div class="field-group"><label class="field-label">Exposure</label><select data-field="exposure" data-idx="${i}">${["public", "internal", "none"].map((p) => `<option ${p === ep.exposure ? "selected" : ""}>${p}</option>`).join("")}</select></div>
      <div class="remove-btn"><button class="btn btn-danger btn-sm" data-remove="${i}">✕</button></div>`;
    list.appendChild(row);
  });
  list.querySelectorAll("[data-field]").forEach((el) => {
    ["change", "input"].forEach((ev) =>
      el.addEventListener(ev, (e) => {
        state.endpoints[+e.target.dataset.idx][e.target.dataset.field] =
          e.target.value;
      }),
    );
  });
  list.querySelectorAll("[data-remove]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      state.endpoints.splice(+e.currentTarget.dataset.remove, 1);
      renderEndpoints();
    }),
  );
}
el("add-endpoint-btn").addEventListener("click", () => {
  state.endpoints.push({
    name: "",
    targetPort: 3000,
    protocol: "http",
    exposure: "public",
  });
  renderEndpoints();
});

// ─── Custom Env ───────────────────────────────────────────────────────────────
function renderCustomEnv() {
  const list = el("custom-env-list"),
    empty = el("custom-env-empty");
  list.innerHTML = "";
  empty.style.display = state.customEnv.length ? "none" : "block";
  state.customEnv.forEach((kv, i) => {
    const row = document.createElement("div");
    row.className = "kv-row";
    row.innerHTML = `
      <input type="text" value="${kv.name}" placeholder="ENV_VAR_NAME" data-field="name" data-idx="${i}">
      <input type="text" value="${kv.value}" placeholder="value" data-field="value" data-idx="${i}">
      <button class="btn btn-danger btn-sm" data-remove="${i}">✕</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll("input[data-field]").forEach((inp) =>
    inp.addEventListener("input", (e) => {
      state.customEnv[+e.target.dataset.idx][e.target.dataset.field] =
        e.target.value;
    }),
  );
  list.querySelectorAll("[data-remove]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      state.customEnv.splice(+e.currentTarget.dataset.remove, 1);
      renderCustomEnv();
    }),
  );
}
el("add-env-btn").addEventListener("click", () => {
  state.customEnv.push({ name: "", value: "" });
  renderCustomEnv();
});

// ─── Volumes ──────────────────────────────────────────────────────────────────
function renderVolumes() {
  const list = el("volume-list"),
    empty = el("volume-empty");
  list.innerHTML = "";
  empty.style.display = state.volumes.length ? "none" : "block";
  state.volumes.forEach((v, i) => {
    const row = document.createElement("div");
    row.className = "repo-entry";
    row.style.gridTemplateColumns = "1fr 120px 1fr auto";
    row.innerHTML = `
      <div class="field-group"><label class="field-label">Volume Name</label><input type="text" value="${v.name}" placeholder="my-volume" data-field="name" data-idx="${i}"></div>
      <div class="field-group"><label class="field-label">Size</label><input type="text" value="${v.size}" placeholder="1Gi" data-field="size" data-idx="${i}"></div>
      <div class="field-group"><label class="field-label">Mount Path</label><input type="text" value="${v.mountPath}" placeholder="/data" data-field="mountPath" data-idx="${i}"></div>
      <div class="remove-btn"><button class="btn btn-danger btn-sm" data-remove="${i}">✕</button></div>`;
    list.appendChild(row);
  });
  list.querySelectorAll("[data-field]").forEach((inp) =>
    inp.addEventListener("input", (e) => {
      state.volumes[+e.target.dataset.idx][e.target.dataset.field] =
        e.target.value;
    }),
  );
  list.querySelectorAll("[data-remove]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      state.volumes.splice(+e.currentTarget.dataset.remove, 1);
      renderVolumes();
    }),
  );
}
el("add-vol-btn").addEventListener("click", () => {
  state.volumes.push({ name: "", size: "1Gi", mountPath: "" });
  renderVolumes();
});

el("add-vol-btn").addEventListener("click", () => {
  state.volumes.push({ name: "", size: "1Gi", mountPath: "" });
  renderVolumes();
});

// ─── Commands ─────────────────────────────────────────────────────────────────
// Helper: collect the names of currently configured container components
// so exec/apply commands can offer a populated dropdown.
function containerComponentNames() {
  const name = state.resources.name || "dev";
  return name ? [name] : ["dev"];
}

function componentDropdown(fieldName, idx, selected) {
  const names = containerComponentNames();
  // If the current value isn't in the list (typed manually), include it too
  const all =
    selected && !names.includes(selected) ? [selected, ...names] : names;
  return `<select data-cmd-field="${fieldName}" data-idx="${idx}" class="cmd-component-select">
    ${all.map((n) => `<option value="${n}" ${n === selected ? "selected" : ""}>${n}</option>`).join("")}
    <option value="__custom__">Custom…</option>
  </select>`;
}

function renderCommands() {
  // ── Predefined picker ──────────────────────────────────────────────────────
  const pickerCard = el("predefined-commands-card");
  if (pickerCard) {
    pickerCard.style.display = PREDEFINED_COMMANDS.length ? "" : "none";
  }

  // ── Custom command list ────────────────────────────────────────────────────
  const list = el("command-list");
  const empty = el("command-empty");
  if (!list) return;
  list.innerHTML = "";
  empty.style.display = state.commands.length ? "none" : "block";
  renderBadge("commands", state.commands.length);

  state.commands.forEach((cmd, i) => {
    const block = document.createElement("div");
    block.className = "component-block";

    const typeLabel =
      cmd.type === "exec"
        ? "exec"
        : cmd.type === "composite"
          ? "composite"
          : "apply";
    const badgeClass = `cmd-type-badge ${cmd.type}`;

    // ── Type-specific fields ──────────────────────────────────────────────────
    let fieldsHtml = "";
    if (cmd.type === "exec") {
      const exec = cmd.exec || {};
      fieldsHtml = `
        <div class="field-row cols-2">
          <div class="field-group">
            <label class="field-label">Command Line <span style="color:var(--warn)">*</span></label>
            <textarea placeholder="npm run build" rows="3"
                      data-cmd-field="exec.commandLine" data-idx="${i}"
                      style="resize:vertical">${exec.commandLine || ""}</textarea>
          </div>
          <div class="field-group">
            <label class="field-label">Working Dir</label>
            <input type="text" value="${exec.workingDir || ""}" placeholder="$PROJECT_SOURCE"
                   data-cmd-field="exec.workingDir" data-idx="${i}">
          </div>
        </div>
        <div class="field-row cols-2 mt-8">
          <div class="field-group">
            <label class="field-label">Component <span style="color:var(--warn)">*</span></label>
            ${componentDropdown("exec.component", i, exec.component || "")}
            <input type="text" value="${exec.component || ""}" placeholder="dev"
                   data-cmd-field="exec.component" data-idx="${i}"
                   class="cmd-component-custom mt-8"
                   style="${containerComponentNames().includes(exec.component || "") ? "display:none" : ""}">
            <p class="field-hint">Container component to run this command in.</p>
          </div>
          <div class="field-group">
            <label class="field-label">Group</label>
            <select data-cmd-field="exec.group.kind" data-idx="${i}">
              ${["build", "run", "test", "debug", "deploy"]
                .map(
                  (k) =>
                    `<option value="${k}" ${exec.group?.kind === k ? "selected" : ""}>${k}</option>`,
                )
                .join("")}
            </select>
          </div>
        </div>
        <div class="field-row cols-2 mt-8">
          <div class="field-group">
            <label class="field-label">Label</label>
            <input type="text" value="${exec.label || ""}" placeholder="optional display label"
                   data-cmd-field="exec.label" data-idx="${i}">
          </div>
          <div class="field-group" style="justify-content:flex-end;padding-top:20px">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
              <input type="checkbox" ${exec.group?.isDefault ? "checked" : ""}
                     data-cmd-field="exec.group.isDefault" data-idx="${i}">
              Default for group
            </label>
          </div>
        </div>`;
    } else if (cmd.type === "composite") {
      const comp = cmd.composite || {};
      fieldsHtml = `
        <div class="field-row cols-2">
          <div class="field-group">
            <label class="field-label">Sub-commands (comma-separated)</label>
            <input type="text" value="${(comp.commands || []).join(", ")}" placeholder="build, run"
                   data-cmd-field="composite.commands" data-idx="${i}">
            <p class="field-hint">IDs of other commands to run in sequence.</p>
          </div>
          <div class="field-group">
            <label class="field-label">Group</label>
            <select data-cmd-field="composite.group.kind" data-idx="${i}">
              ${["build", "run", "test", "debug", "deploy"]
                .map(
                  (k) =>
                    `<option value="${k}" ${comp.group?.kind === k ? "selected" : ""}>${k}</option>`,
                )
                .join("")}
            </select>
          </div>
        </div>
        <div class="field-row cols-2 mt-8">
          <div class="field-group">
            <label class="field-label">Label</label>
            <input type="text" value="${comp.label || ""}" placeholder="optional display label"
                   data-cmd-field="composite.label" data-idx="${i}">
          </div>
          <div class="field-group" style="justify-content:flex-end;padding-top:20px">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
              <input type="checkbox" ${comp.parallel ? "checked" : ""}
                     data-cmd-field="composite.parallel" data-idx="${i}">
              Run in parallel
            </label>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-top:8px">
              <input type="checkbox" ${comp.group?.isDefault ? "checked" : ""}
                     data-cmd-field="composite.group.isDefault" data-idx="${i}">
              Default for group
            </label>
          </div>
        </div>`;
    } else if (cmd.type === "apply") {
      const apply = cmd.apply || {};
      fieldsHtml = `
        <div class="field-row cols-2">
          <div class="field-group">
            <label class="field-label">Component <span style="color:var(--warn)">*</span></label>
            ${componentDropdown("apply.component", i, apply.component || "")}
            <input type="text" value="${apply.component || ""}" placeholder="dev"
                   data-cmd-field="apply.component" data-idx="${i}"
                   class="cmd-component-custom mt-8"
                   style="${containerComponentNames().includes(apply.component || "") ? "display:none" : ""}">
          </div>
          <div class="field-group">
            <label class="field-label">Group</label>
            <select data-cmd-field="apply.group.kind" data-idx="${i}">
              ${["build", "run", "test", "debug", "deploy"]
                .map(
                  (k) =>
                    `<option value="${k}" ${apply.group?.kind === k ? "selected" : ""}>${k}</option>`,
                )
                .join("")}
            </select>
          </div>
        </div>
        <div class="field-row cols-2 mt-8">
          <div class="field-group">
            <label class="field-label">Label</label>
            <input type="text" value="${apply.label || ""}" placeholder="optional display label"
                   data-cmd-field="apply.label" data-idx="${i}">
          </div>
          <div class="field-group" style="justify-content:flex-end;padding-top:20px">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
              <input type="checkbox" ${apply.group?.isDefault ? "checked" : ""}
                     data-cmd-field="apply.group.isDefault" data-idx="${i}">
              Default for group
            </label>
          </div>
        </div>`;
    }

    block.innerHTML = `
      <div class="component-block-header">
        <span class="${badgeClass}">${typeLabel}</span>
        <span style="font-size:13px;font-weight:600;margin-left:4px">${cmd.id || "(unnamed)"}</span>
        <span class="collapse-icon" style="margin-left:auto">▾</span>
      </div>
      <div class="component-block-body">
        <div class="field-row cols-2">
          <div class="field-group">
            <label class="field-label">ID <span style="color:var(--warn)">*</span></label>
            <input type="text" value="${cmd.id}" placeholder="my-command"
                   data-cmd-field="id" data-idx="${i}">
            <p class="field-hint">^[a-z0-9]([-a-z0-9]*[a-z0-9])?$, max 63 chars</p>
          </div>
          <div class="field-group">
            <label class="field-label">Type</label>
            <select data-cmd-field="type" data-idx="${i}">
              ${["exec", "composite", "apply"]
                .map(
                  (t) =>
                    `<option value="${t}" ${cmd.type === t ? "selected" : ""}>${t}</option>`,
                )
                .join("")}
            </select>
          </div>
        </div>
        ${fieldsHtml}
        <div style="margin-top:12px;text-align:right">
          <button class="btn btn-danger btn-sm" data-cmd-remove="${i}">✕ Remove</button>
        </div>
      </div>`;

    block
      .querySelector(".component-block-header")
      .addEventListener("click", () => block.classList.toggle("collapsed"));

    // ── Field change handlers ──────────────────────────────────────────────────
    block.querySelectorAll("[data-cmd-field]").forEach((input) => {
      const ev = input.type === "checkbox" ? "change" : "input";
      input.addEventListener(ev, (e) => {
        const idx = +e.target.dataset.idx;
        const field = e.target.dataset.field || e.target.dataset.cmdField;
        const value =
          e.target.type === "checkbox" ? e.target.checked : e.target.value;
        _setCmdField(state.commands[idx], field, value);
        // Update the block header label when id changes
        if (field === "id") {
          block.querySelector(
            ".component-block-header span:nth-child(2)",
          ).textContent = value || "(unnamed)";
        }
        // When type changes, re-render the whole list
        if (field === "type") {
          state.commands[idx] = { id: state.commands[idx].id, type: value };
          if (value === "exec")
            state.commands[idx].exec = {
              commandLine: "",
              component: "",
              workingDir: "$PROJECT_SOURCE",
              group: { kind: "run", isDefault: false },
            };
          if (value === "composite")
            state.commands[idx].composite = {
              commands: [],
              parallel: false,
              group: { kind: "run", isDefault: false },
            };
          if (value === "apply")
            state.commands[idx].apply = {
              component: "",
              group: { kind: "run", isDefault: false },
            };
          renderCommands();
        }
      });
    });

    // Component dropdown → show/hide custom input
    block.querySelectorAll(".cmd-component-select").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const customInput = e.target.parentElement.querySelector(
          ".cmd-component-custom",
        );
        if (!customInput) return;
        const isCustom = e.target.value === "__custom__";
        customInput.style.display = isCustom ? "" : "none";
        if (!isCustom) {
          // Update state immediately from dropdown selection
          const idx = +e.target.dataset.idx;
          const field = e.target.dataset.cmdField;
          _setCmdField(state.commands[idx], field, e.target.value);
        }
      });
    });

    // Composite commands field — parse comma-separated list to array
    block
      .querySelectorAll('[data-cmd-field="composite.commands"]')
      .forEach((inp) => {
        inp.addEventListener("input", (e) => {
          const idx = +e.target.dataset.idx;
          if (!state.commands[idx].composite) return;
          state.commands[idx].composite.commands = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        });
      });

    block.querySelectorAll("[data-cmd-remove]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        state.commands.splice(+e.currentTarget.dataset.cmdRemove, 1);
        renderCommands();
      }),
    );

    list.appendChild(block);
  });

  // Keep event bindings in sync with the current command list
  renderEvents();
}

// Deep-set a dotted path on a command object (e.g. "exec.group.kind")
function _setCmdField(cmd, path, value) {
  const parts = path.split(".");
  let obj = cmd;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!obj[parts[i]]) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;
}

// ── Add custom command button ──────────────────────────────────────────────────
el("add-command-btn")?.addEventListener("click", () => {
  state.commands.push({
    id: "",
    type: "exec",
    exec: {
      commandLine: "",
      component: state.resources.name || "dev",
      workingDir: "$PROJECT_SOURCE",
      group: { kind: "run", isDefault: false },
    },
  });
  renderCommands();
});

// ── Predefined command picker ──────────────────────────────────────────────────
if (PREDEFINED_COMMANDS.length) {
  const selectAllBtn = el("select-all-commands-btn");
  const addSelectedBtn = el("add-selected-commands-btn");

  selectAllBtn?.addEventListener("click", () => {
    const checks = document.querySelectorAll(".predefined-command-check");
    const allChecked = [...checks].every((c) => c.checked);
    checks.forEach((c) => {
      c.checked = !allChecked;
    });
    selectAllBtn.textContent = allChecked ? "Select All" : "Deselect All";
  });

  document
    .getElementById("predefined-command-list")
    ?.addEventListener("change", () => {
      const checks = document.querySelectorAll(".predefined-command-check");
      if (selectAllBtn)
        selectAllBtn.textContent = [...checks].every((c) => c.checked)
          ? "Deselect All"
          : "Select All";
    });

  addSelectedBtn?.addEventListener("click", () => {
    const rows = document.querySelectorAll(".predefined-command-row");
    let added = 0;
    rows.forEach((row) => {
      const check = row.querySelector(".predefined-command-check");
      if (!check?.checked) return;
      const predefined = PREDEFINED_COMMANDS.find(
        (c) => c.id === row.dataset.commandId,
      );
      if (!predefined) return;
      // Skip if already present by id
      if (state.commands.some((c) => c.id === predefined.id)) return;
      // Deep-clone and strip UI-only fields
      const { display_name, description, ...cmd } = JSON.parse(
        JSON.stringify(predefined),
      );
      // Default the component to the currently configured container name
      if (cmd.exec && !cmd.exec.component)
        cmd.exec.component = state.resources.name || "dev";
      if (cmd.apply && !cmd.apply.component)
        cmd.apply.component = state.resources.name || "dev";
      state.commands.push(cmd);
      check.checked = false;
      added++;
    });
    if (added > 0) {
      renderCommands();
      if (selectAllBtn) selectAllBtn.textContent = "Select All";
    }
  });
}

// ─── Events ───────────────────────────────────────────────────────────────────
const EVENT_TYPES = [
  {
    key: "preStart",
    label: "preStart",
    desc: "Run before the workspace starts. Executed as init containers in the devworkspace pod.",
  },
  {
    key: "postStart",
    label: "postStart",
    desc: "Run after the workspace and all plugins have fully started.",
  },
  { key: "preStop", label: "preStop", desc: "Run before the workspace stops." },
  {
    key: "postStop",
    label: "postStop",
    desc: "Run after the workspace has stopped.",
  },
];

function renderEvents() {
  EVENT_TYPES.forEach(({ key }) => {
    const container = el(`event-${key}-commands`);
    if (!container) return;

    const commandIds = state.commands.map((c) => c.id).filter(Boolean);
    const selected = new Set(state.events[key] || []);

    if (!commandIds.length) {
      container.innerHTML = `<p style="font-size:12px;color:var(--text-faint);padding:8px 0;">
        No commands defined yet — add commands in the <strong style="color:var(--text-dim)">Commands</strong> section first.
      </p>`;
      return;
    }

    container.innerHTML = commandIds
      .map((id) => {
        const cmd = state.commands.find((c) => c.id === id);
        const typeTag = cmd
          ? `<span class="cmd-type-badge ${cmd.type}" style="margin-left:6px">${cmd.type}</span>`
          : "";
        return `
        <label class="event-command-row">
          <input type="checkbox" class="event-cmd-check"
                 data-event-key="${key}" data-cmd-id="${id}"
                 ${selected.has(id) ? "checked" : ""}>
          <span class="event-cmd-id">${id}</span>
          ${typeTag}
        </label>`;
      })
      .join("");

    container.querySelectorAll(".event-cmd-check").forEach((chk) => {
      chk.addEventListener("change", (e) => {
        const evKey = e.target.dataset.eventKey;
        const cmdId = e.target.dataset.cmdId;
        const arr = state.events[evKey] || [];
        if (e.target.checked) {
          if (!arr.includes(cmdId)) arr.push(cmdId);
        } else {
          const idx = arr.indexOf(cmdId);
          if (idx !== -1) arr.splice(idx, 1);
        }
        state.events[evKey] = arr;
      });
    });
  });
}

// ─── Component Catalog ────────────────────────────────────────────────────────
function renderCatalog() {
  const cat = el("component-catalog");
  const emptyMsg = el("catalog-empty");
  cat.innerHTML = "";
  if (!CATALOG.length) {
    if (emptyMsg) emptyMsg.style.display = "";
    return;
  }
  if (emptyMsg) emptyMsg.style.display = "none";
  CATALOG.forEach((comp) => {
    const item = document.createElement("div");
    item.className =
      "catalog-item" + (state.activeComponents.has(comp.id) ? " selected" : "");
    item.innerHTML = `<div class="catalog-icon">${comp.icon || "🧩"}</div><div class="catalog-name">${comp.name}</div><div class="catalog-desc">${comp.description || comp.desc || ""}</div>`;
    item.addEventListener("click", () => {
      if (state.activeComponents.has(comp.id)) {
        state.activeComponents.delete(comp.id);
      } else {
        state.activeComponents.add(comp.id);
        if (!state.componentConfigs[comp.id]) {
          state.componentConfigs[comp.id] = {};
          comp.fields.forEach((f) => {
            state.componentConfigs[comp.id][f.key] = "";
          });
        }
      }
      renderCatalog();
      renderActiveComponents();
    });
    cat.appendChild(item);
  });
}

function renderActiveComponents() {
  const container = el("active-components"),
    empty = el("active-components-empty");
  container.innerHTML = "";
  const active = CATALOG.filter((c) => state.activeComponents.has(c.id));
  empty.style.display = active.length ? "none" : "block";
  renderBadge("components", active.length);
  active.forEach((comp) => {
    const block = document.createElement("div");
    block.className = "component-block";
    const cfg = state.componentConfigs[comp.id] || {};
    block.innerHTML = `
      <div class="component-block-header">
        <span>${comp.icon || "🧩"}</span>
        <span style="font-size:13px;font-weight:600">${comp.name}</span>
        <span class="collapse-icon" style="margin-left:auto">▾</span>
      </div>
      <div class="component-block-body">
        ${comp.fields
          .map(
            (f) => `
          <div class="field-group mb-8">
            <label class="field-label">${f.label}</label>
            <input type="${f.type || "text"}" value="${cfg[f.key] || ""}" placeholder="${f.placeholder}" data-comp="${comp.id}" data-key="${f.key}">
          </div>`,
          )
          .join("")}
      </div>`;
    block
      .querySelector(".component-block-header")
      .addEventListener("click", () => block.classList.toggle("collapsed"));
    block.querySelectorAll("input[data-comp]").forEach((inp) =>
      inp.addEventListener("input", (e) => {
        state.componentConfigs[e.target.dataset.comp][e.target.dataset.key] =
          e.target.value;
      }),
    );
    container.appendChild(block);
  });
}

renderCatalog();
renderActiveComponents();

// ─── Generate ─────────────────────────────────────────────────────────────────
function generateDevfileData() {
  syncResourceState();
  const r = state.resources;
  const envVars = [];
  state.customEnv
    .filter((e) => e.name)
    .forEach((e) => envVars.push({ name: e.name, value: e.value }));

  const volComponents = [];
  const volMounts = [];
  state.volumes
    .filter((v) => v.name)
    .forEach((v) => {
      volComponents.push({
        name: v.name,
        volume: v.size ? { size: v.size } : {},
      });
      volMounts.push({ name: v.name, path: v.mountPath || `/${v.name}` });
    });

  const allEndpoints = [
    ...state.endpoints.filter((e) => e.name && e.targetPort),
  ];

  // ── Catalog contributions (generic, data-driven) ────────────────────────────
  function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  }

  CATALOG.filter((c) => state.activeComponents.has(c.id)).forEach((item) => {
    const cfg = state.componentConfigs[item.id] || {};
    const contrib = item.contributions || {};

    // Env vars
    (contrib.env || []).forEach((e) => {
      const val = e.value || (e.value_from ? cfg[e.value_from] || "" : "");
      if (val) envVars.push({ name: e.name, value: val });
    });

    // Volumes
    (contrib.volumes || []).forEach((v) => {
      let vname = v.name || "";
      if (!vname && v.name_from) {
        const raw = cfg[v.name_from] || v.name_default || "";
        vname = v.slugify !== false ? slugify(raw) : raw;
      }
      if (!vname) return;
      const size = v.size || (v.size_from ? cfg[v.size_from] || "" : "");
      const volDef = size ? { size } : {};
      volComponents.push({ name: vname, volume: volDef });
      const mountPath =
        (v.path_from ? cfg[v.path_from] || "" : "") ||
        v.mount_path ||
        `/${vname}`;
      volMounts.push({ name: vname, path: mountPath });
    });

    // Endpoints
    (contrib.endpoints || []).forEach((ep) => {
      const port = ep.port_from
        ? parseInt(cfg[ep.port_from]) || ep.target_port || 0
        : ep.target_port || 0;
      if (port)
        allEndpoints.push({
          name: ep.name,
          targetPort: port,
          protocol: ep.protocol || "tcp",
          exposure: ep.exposure || "internal",
        });
    });
  });
  const containerComp = {
    name: r.name || "dev",
    container: {
      image: r.image || "quay.io/devfile/universal-developer-image:latest",
      ...(r.cpuRequest ? { cpuRequest: r.cpuRequest } : {}),
      ...(r.cpuLimit ? { cpuLimit: r.cpuLimit } : {}),
      ...(r.memRequest ? { memoryRequest: r.memRequest } : {}),
      ...(r.memLimit ? { memoryLimit: r.memLimit } : {}),
      mountSources: r.mountSources,
      ...(r.sourceMapping ? { sourceMapping: r.sourceMapping } : {}),
      ...(r.dedicatedPod ? { dedicatedPod: true } : {}),
      ...(envVars.length ? { env: envVars } : {}),
      ...(allEndpoints.length ? { endpoints: allEndpoints } : {}),
      ...(volMounts.length ? { volumeMounts: volMounts } : {}),
    },
  };
  const components = [containerComp, ...volComponents];
  const projects = state.repos.map((r) => {
    const checkoutFrom = {};
    if (r.revision && r.revision !== "main") checkoutFrom.revision = r.revision;
    if (r.remote) checkoutFrom.remote = r.remote;
    return {
      name: r.name,
      git: {
        remotes: r.remotes,
        ...(Object.keys(checkoutFrom).length ? { checkoutFrom } : {}),
      },
      ...(r.clonePath && r.clonePath !== r.name
        ? { clonePath: r.clonePath }
        : {}),
    };
  });
  const starterProjects = state.starters
    .filter(
      (s) =>
        s.name && s.remotes && Object.keys(s.remotes).some((k) => s.remotes[k]),
    )
    .map((s) => {
      const checkoutFrom = {};
      if (s.revision && s.revision !== "main")
        checkoutFrom.revision = s.revision;
      if (s.remote) checkoutFrom.remote = s.remote;
      return {
        name: s.name,
        git: {
          remotes: s.remotes,
          ...(Object.keys(checkoutFrom).length ? { checkoutFrom } : {}),
        },
      };
    });
  const commands = state.commands
    .filter((c) => c.id)
    .map((c) => {
      const entry = { id: c.id };
      if (c.type === "exec" && c.exec) {
        const exec = {
          commandLine: c.exec.commandLine || "",
          component: c.exec.component || "",
        };
        if (c.exec.workingDir) exec.workingDir = c.exec.workingDir;
        if (c.exec.hotReloadCapable) exec.hotReloadCapable = true;
        if (c.exec.label) exec.label = c.exec.label;
        if (c.exec.group?.kind)
          exec.group = {
            kind: c.exec.group.kind,
            isDefault: !!c.exec.group.isDefault,
          };
        if (c.exec.env?.length) exec.env = c.exec.env;
        entry.exec = exec;
      } else if (c.type === "composite" && c.composite) {
        const comp = {};
        if (c.composite.commands?.length) comp.commands = c.composite.commands;
        if (c.composite.parallel) comp.parallel = true;
        if (c.composite.label) comp.label = c.composite.label;
        if (c.composite.group?.kind)
          comp.group = {
            kind: c.composite.group.kind,
            isDefault: !!c.composite.group.isDefault,
          };
        entry.composite = comp;
      } else if (c.type === "apply" && c.apply) {
        const apply = { component: c.apply.component || "" };
        if (c.apply.label) apply.label = c.apply.label;
        if (c.apply.group?.kind)
          apply.group = {
            kind: c.apply.group.kind,
            isDefault: !!c.apply.group.isDefault,
          };
        entry.apply = apply;
      }
      return entry;
    });
  const evts = state.events || {};
  const eventsObj = {};
  if (evts.preStart?.length) eventsObj.preStart = evts.preStart;
  if (evts.postStart?.length) eventsObj.postStart = evts.postStart;
  if (evts.preStop?.length) eventsObj.preStop = evts.preStop;
  if (evts.postStop?.length) eventsObj.postStop = evts.postStop;

  return {
    schemaVersion: "2.3.0",
    components,
    ...(projects.length ? { projects } : {}),
    ...(starterProjects.length ? { starterProjects } : {}),
    ...(commands.length ? { commands } : {}),
    ...(Object.keys(eventsObj).length ? { events: eventsObj } : {}),
  };
}

function generate() {
  const data = generateDevfileData();
  const statusEl = el("output-status");
  try {
    new Devfile(data);
    statusEl.className = "status-bar ok";
    statusEl.innerHTML = "✔ Devfile is valid and conforms to schema v2.3.0.";
  } catch (e) {
    statusEl.className = "status-bar err";
    statusEl.innerHTML = "✖ Validation error: " + e.message;
  }
  const plain = JSON.parse(JSON.stringify(data));
  el("yaml-output").textContent = jsyaml.dump(plain, {
    sortKeys: false,
    lineWidth: 120,
  });
  el("json-output").textContent = JSON.stringify(plain, null, 2);
  pushStateToURL().then((shareURL) => {
    const encodedBlob = location.hash.slice(3);
    el("share-url").value = shareURL;
    el("raw-url").value = `${location.origin}/raw?c=${encodedBlob}`;
    el("share-size-tag").textContent =
      `~${(encodedBlob.length / 1024).toFixed(1)} KB`;
    el("share-panel").style.display = "block";
  });
}

// ─── URL Serialization ────────────────────────────────────────────────────────
async function encodeStateToHash(stateSnapshot) {
  const serializable = {
    ...stateSnapshot,
    activeComponents: [...stateSnapshot.activeComponents],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(serializable));
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

async function decodeHashToState(hash) {
  const b64 = hash.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const parsed = JSON.parse(
    new TextDecoder().decode(await new Response(ds.readable).arrayBuffer()),
  );
  parsed.activeComponents = new Set(parsed.activeComponents || []);
  return parsed;
}

function serializableState() {
  syncResourceState();
  return {
    repos: state.repos,
    starters: state.starters,
    resources: { ...state.resources },
    endpoints: state.endpoints,
    customEnv: state.customEnv,
    volumes: state.volumes,
    activeComponents: state.activeComponents,
    componentConfigs: state.componentConfigs,
    commands: state.commands,
    events: state.events,
  };
}

async function pushStateToURL() {
  const hash = await encodeStateToHash(serializableState());
  history.replaceState(null, "", `#c=${hash}`);
  return `${location.origin}${location.pathname}#c=${hash}`;
}

function hydrateStateFromParsed(parsed) {
  state.repos = parsed.repos || [];
  state.starters = parsed.starters || [];
  state.resources = { ...state.resources, ...parsed.resources };
  state.endpoints = parsed.endpoints || [];
  state.customEnv = parsed.customEnv || [];
  state.volumes = parsed.volumes || [];
  state.activeComponents =
    parsed.activeComponents instanceof Set
      ? parsed.activeComponents
      : new Set(parsed.activeComponents || []);
  state.componentConfigs = parsed.componentConfigs || {};
  state.commands = parsed.commands || [];
  state.events = {
    preStart: parsed.events?.preStart || [],
    postStart: parsed.events?.postStart || [],
    preStop: parsed.events?.preStop || [],
    postStop: parsed.events?.postStop || [],
  };
  const r = state.resources;
  el("container-image").value = r.image || "";
  el("container-name").value = r.name || "dev";
  el("source-mapping").value = r.sourceMapping || "/projects";
  el("cpu-request-text").value = r.cpuRequest || "";
  el("cpu-limit-text").value = r.cpuLimit || "";
  el("mem-request-text").value = r.memRequest || "";
  el("mem-limit-text").value = r.memLimit || "";
  el("cpu-request-val").textContent = r.cpuRequest || "—";
  el("cpu-limit-val").textContent = r.cpuLimit || "—";
  el("mem-request-val").textContent = r.memRequest || "—";
  el("mem-limit-val").textContent = r.memLimit || "—";
  const mt = el("mount-sources-toggle");
  mt.dataset.state = r.mountSources;
  mt.classList.toggle("on", r.mountSources !== false);
  const dp = el("dedicated-pod-toggle");
  dp.dataset.state = r.dedicatedPod;
  dp.classList.toggle("on", !!r.dedicatedPod);
  renderRepos();
  renderStarters();
  renderEndpoints();
  renderCustomEnv();
  renderVolumes();
  renderCatalog();
  renderActiveComponents();
  renderCommands();
  renderEvents();
}

async function tryLoadFromHash() {
  if (!location.hash.startsWith("#c=")) return false;
  try {
    hydrateStateFromParsed(await decodeHashToState(location.hash.slice(3)));
    return true;
  } catch (e) {
    console.warn("Failed to decode state from URL hash:", e);
    return false;
  }
}

// ─── Output tabs ──────────────────────────────────────────────────────────────
document.querySelectorAll(".output-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".output-tab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".output-pane")
      .forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    el("pane-" + tab.dataset.tab).classList.add("active");
  });
});

el("output-generate-btn").addEventListener("click", generate);
el("generate-btn").addEventListener("click", () => {
  document
    .querySelectorAll(".sidebar-nav .nav-item")
    .forEach((i) => i.classList.remove("active"));
  document
    .querySelectorAll(".section")
    .forEach((s) => s.classList.remove("active"));
  document.querySelector('[data-section="output"]').classList.add("active");
  el("section-output").classList.add("active");
  generate();
});

function copyToClipboard(btn, text, label) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = "✔ Copied!";
    setTimeout(() => {
      btn.textContent = label;
    }, 1800);
  });
}
el("copy-btn").addEventListener("click", () => {
  const p = document.querySelector(".output-pane.active .code-block");
  navigator.clipboard.writeText(p.textContent).then(() => {
    el("copy-btn").textContent = "✔ Copied!";
    setTimeout(() => {
      el("copy-btn").textContent = "⎘ Copy";
    }, 1800);
  });
});
el("copy-share-btn").addEventListener("click", () =>
  copyToClipboard(el("copy-share-btn"), el("share-url").value, "⎘ Copy"),
);
el("copy-raw-btn").addEventListener("click", () =>
  copyToClipboard(el("copy-raw-btn"), el("raw-url").value, "⎘ Copy Raw"),
);
el("download-btn").addEventListener("click", () => {
  const isYaml =
    document.querySelector(".output-tab.active").dataset.tab === "yaml";
  const content = el(isYaml ? "yaml-output" : "json-output").textContent;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  a.download = `devfile.${isYaml ? "yaml" : "json"}`;
  a.click();
});

// ─── Import ───────────────────────────────────────────────────────────────────
el("do-import-btn").addEventListener("click", () => {
  const raw = el("import-yaml-input").value.trim();
  const statusEl = el("import-status"),
    resultCard = el("import-result-card");
  statusEl.style.display = "";
  if (!raw) {
    statusEl.className = "status-bar err";
    statusEl.textContent = "Please paste a devfile YAML first.";
    resultCard.style.display = "none";
    return;
  }
  try {
    const data = jsyaml.load(raw);
    const devfile = new Devfile(data);
    statusEl.className = "status-bar ok";
    statusEl.textContent =
      "✔ Valid devfile. Schema version: " + devfile.schemaVersion;
    el("import-json-output").textContent = JSON.stringify(
      JSON.parse(JSON.stringify(devfile)),
      null,
      2,
    );
    resultCard.style.display = "block";
    if (devfile.components) {
      const main = devfile.components.find((c) => c.container);
      if (main && main.container) {
        const ct = main.container;
        state.resources.image = ct.image || "";
        state.resources.name = main.name;
        state.resources.sourceMapping = ct.sourceMapping || "/projects";
        state.resources.cpuRequest = ct.cpuRequest || "";
        state.resources.cpuLimit = ct.cpuLimit || "";
        state.resources.memRequest = ct.memoryRequest || "";
        state.resources.memLimit = ct.memoryLimit || "";
        state.resources.mountSources = ct.mountSources !== false;
        state.resources.dedicatedPod = ct.dedicatedPod || false;
        el("container-image").value = state.resources.image;
        el("container-name").value = state.resources.name;
        el("source-mapping").value = state.resources.sourceMapping;
        el("cpu-request-text").value = state.resources.cpuRequest;
        el("cpu-limit-text").value = state.resources.cpuLimit;
        el("mem-request-text").value = state.resources.memRequest;
        el("mem-limit-text").value = state.resources.memLimit;
        el("cpu-request-val").textContent = state.resources.cpuRequest || "—";
        el("cpu-limit-val").textContent = state.resources.cpuLimit || "—";
        el("mem-request-val").textContent = state.resources.memRequest || "—";
        el("mem-limit-val").textContent = state.resources.memLimit || "—";
        const mt = el("mount-sources-toggle");
        mt.dataset.state = state.resources.mountSources;
        mt.classList.toggle("on", state.resources.mountSources);
        const dp = el("dedicated-pod-toggle");
        dp.dataset.state = state.resources.dedicatedPod;
        dp.classList.toggle("on", state.resources.dedicatedPod);
        if (ct.env) {
          state.customEnv = ct.env.map((e) => ({
            name: e.name,
            value: e.value || "",
          }));
          renderCustomEnv();
        }
        if (ct.endpoints) {
          state.endpoints = ct.endpoints.map((e) => ({
            name: e.name,
            targetPort: e.targetPort,
            protocol: e.protocol || "http",
            exposure: e.exposure || "public",
          }));
          renderEndpoints();
        }
      }
    }
    if (devfile.projects) {
      state.repos = devfile.projects.map((p) => ({
        name: p.name,
        remotes: p.git?.remotes ?? {},
        revision: p.git?.checkoutFrom?.revision ?? "main",
        remote: p.git?.checkoutFrom?.remote ?? "",
        clonePath: p.clonePath || p.name,
      }));
      renderRepos();
    }
    if (devfile.starterProjects) {
      state.starters = devfile.starterProjects.map((p) => ({
        name: p.name,
        remotes: p.git?.remotes ?? {},
        revision: p.git?.checkoutFrom?.revision ?? "main",
        remote: p.git?.checkoutFrom?.remote ?? "",
      }));
      renderStarters();
    }
    if (devfile.commands) {
      state.commands = devfile.commands.map((c) => {
        const cmd = {
          id: c.id,
          type: c.exec ? "exec" : c.composite ? "composite" : "apply",
        };
        if (c.exec)
          cmd.exec = {
            commandLine: c.exec.commandLine || "",
            component: c.exec.component || "",
            workingDir: c.exec.workingDir || "",
            hotReloadCapable: c.exec.hotReloadCapable || false,
            label: c.exec.label || "",
            group: c.exec.group
              ? {
                  kind: c.exec.group.kind,
                  isDefault: c.exec.group.isDefault || false,
                }
              : { kind: "run", isDefault: false },
            env: c.exec.env || [],
          };
        if (c.composite)
          cmd.composite = {
            commands: c.composite.commands || [],
            parallel: c.composite.parallel || false,
            label: c.composite.label || "",
            group: c.composite.group
              ? {
                  kind: c.composite.group.kind,
                  isDefault: c.composite.group.isDefault || false,
                }
              : { kind: "run", isDefault: false },
          };
        if (c.apply)
          cmd.apply = {
            component: c.apply.component || "",
            label: c.apply.label || "",
            group: c.apply.group
              ? {
                  kind: c.apply.group.kind,
                  isDefault: c.apply.group.isDefault || false,
                }
              : { kind: "run", isDefault: false },
          };
        return cmd;
      });
      renderCommands();
    }
    if (devfile.events) {
      state.events = {
        preStart: devfile.events.preStart || [],
        postStart: devfile.events.postStart || [],
        preStop: devfile.events.preStop || [],
        postStop: devfile.events.postStop || [],
      };
      renderEvents();
    }
  } catch (e) {
    statusEl.className = "status-bar err";
    statusEl.textContent = "✖ " + e.message;
    resultCard.style.display = "none";
  }
});

el("clear-import-btn").addEventListener("click", () => {
  el("import-yaml-input").value = "";
  el("import-status").style.display = "none";
  el("import-result-card").style.display = "none";
});

el("import-btn").addEventListener("click", () => {
  document
    .querySelectorAll(".sidebar-nav .nav-item")
    .forEach((i) => i.classList.remove("active"));
  document
    .querySelectorAll(".section")
    .forEach((s) => s.classList.remove("active"));
  document.querySelector('[data-section="import"]').classList.add("active");
  el("section-import").classList.add("active");
});

// ─── Template card interactions ───────────────────────────────────────────────
if (PREDEFINED_CONFIGS.length) {
  // Expand / collapse preview bodies
  document.querySelectorAll(".template-expand-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.target;
      const body = document.getElementById(targetId);
      if (!body) return;
      const expanded = btn.getAttribute("aria-expanded") === "true";
      body.hidden = expanded;
      btn.setAttribute("aria-expanded", String(!expanded));
      btn.textContent = expanded ? "▾ Preview" : "▴ Hide";
    });
  });

  // Copy raw URL to clipboard
  document.querySelectorAll(".template-copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const urlInput = btn.previousElementSibling;
      if (!urlInput) return;
      navigator.clipboard.writeText(urlInput.value).then(() => {
        btn.textContent = "✔ Copied!";
        setTimeout(() => {
          btn.textContent = "⎘ Copy";
        }, 1800);
      });
    });
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
tryLoadFromHash().then((loaded) => {
  if (!loaded) {
    renderRepos();
    renderStarters();
    renderEndpoints();
    renderCustomEnv();
    renderVolumes();
    renderCommands();
    renderEvents();
  }
});

// Re-run hydration whenever the hash changes (e.g. clicking a Load link
// from the Templates section while already on the /devfile page).
window.addEventListener("hashchange", () => tryLoadFromHash());
