// devfile.js — devfile configurator logic
// Loaded as type="module" from index.html after js-yaml is available on window.
// Imports Devfile from devfile.js (the schema class), which must also be present.

import { Devfile } from './devfile.js';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  repos: [], starters: [],
  resources: {
    image: 'quay.io/devfile/universal-developer-image:latest',
    name: 'dev', sourceMapping: '/projects',
    mountSources: true, dedicatedPod: false,
    cpuRequest: '500m', cpuLimit: '2', memRequest: '512Mi', memLimit: '4Gi',
  },
  endpoints: [], customEnv: [], volumes: [],
  activeComponents: new Set(), componentConfigs: {},
};

const cpuSteps = ['','100m','200m','300m','500m','750m','1','1500m','2','3','4','5','6','7','8','10','12','16','20','24','32'];
const memSteps = ['','128Mi','256Mi','384Mi','512Mi','768Mi','1Gi','1536Mi','2Gi','3Gi','4Gi','6Gi','8Gi','10Gi','12Gi','16Gi','20Gi','24Gi','32Gi','48Gi','64Gi'];

const CATALOG = [
  { id:'git-config',       name:'Git Configuration',  icon:'🌿', desc:'Inject git user name and email as environment variables',         fields:[{key:'GIT_USER_NAME',label:'Git User Name',placeholder:'Jane Dev',type:'text'},{key:'GIT_USER_EMAIL',label:'Git Email',placeholder:'jane@example.com',type:'text'}] },
  { id:'docker-in-docker', name:'Docker-in-Docker',   icon:'🐳', desc:'Add a DinD sidecar volume for container builds inside the workspace', fields:[{key:'dind-vol-size',label:'DinD Volume Size',placeholder:'10Gi',type:'text'}] },
  { id:'node-version',     name:'Node.js Runtime',    icon:'🟩', desc:'Set the Node.js version and npm cache environment',               fields:[{key:'NODE_VERSION',label:'Node Version',placeholder:'20',type:'text'},{key:'npm-cache-vol',label:'npm Cache Volume Name',placeholder:'npm-cache',type:'text'}] },
  { id:'java-config',      name:'Java / Maven',       icon:'☕', desc:'Configure JAVA_HOME and Maven settings',                          fields:[{key:'JAVA_VERSION',label:'Java Version',placeholder:'17',type:'text'},{key:'MAVEN_OPTS',label:'MAVEN_OPTS',placeholder:'-Xmx1024m',type:'text'}] },
  { id:'python-config',    name:'Python Runtime',     icon:'🐍', desc:'Set Python version and virtualenv path environment variables',    fields:[{key:'PYTHON_VERSION',label:'Python Version',placeholder:'3.11',type:'text'},{key:'VIRTUAL_ENV',label:'Virtual Env Path',placeholder:'/projects/.venv',type:'text'}] },
  { id:'shared-volume',    name:'Shared Volume',      icon:'💾', desc:'Add a named persistent volume shared across components',          fields:[{key:'shared-vol-name',label:'Volume Name',placeholder:'shared-data',type:'text'},{key:'shared-vol-size',label:'Size',placeholder:'5Gi',type:'text'},{key:'shared-vol-path',label:'Mount Path',placeholder:'/shared',type:'text'}] },
  { id:'proxy-config',     name:'HTTP Proxy',         icon:'🔀', desc:'Set HTTP/HTTPS proxy environment variables for the workspace',    fields:[{key:'HTTP_PROXY',label:'HTTP_PROXY',placeholder:'http://proxy:3128',type:'text'},{key:'HTTPS_PROXY',label:'HTTPS_PROXY',placeholder:'http://proxy:3128',type:'text'},{key:'NO_PROXY',label:'NO_PROXY',placeholder:'localhost,127.0.0.1',type:'text'}] },
  { id:'debug-port',       name:'Debug Port',         icon:'🐞', desc:'Expose a debug endpoint and set related env vars',                fields:[{key:'debug-port',label:'Debug Port',placeholder:'5005',type:'number'},{key:'DEBUG_SUSPEND',label:'DEBUG_SUSPEND (y/n)',placeholder:'n',type:'text'}] },
];

function el(id) { return document.getElementById(id); }
function renderBadge(id, count) {
  const b = document.querySelector(`[data-section="${id}"] .nav-badge`);
  if (b) b.textContent = count;
}

// ─── Nav ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    item.classList.add('active');
    el('section-' + item.dataset.section).classList.add('active');
  });
});

// ─── Toggles ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.toggle').forEach(t => {
  t.addEventListener('click', () => {
    const on = t.dataset.state === 'true';
    t.dataset.state = !on;
    t.classList.toggle('on', !on);
    if (t.id === 'mount-sources-toggle') state.resources.mountSources = !on;
    if (t.id === 'dedicated-pod-toggle') state.resources.dedicatedPod = !on;
  });
});

// ─── Resource sliders ─────────────────────────────────────────────────────────
function syncSliderToText(sliderId, textId, valId, steps) {
  const slider = el(sliderId), text = el(textId), val = el(valId);
  slider.addEventListener('input', () => {
    const v = steps[+slider.value] || '';
    text.value = v; val.textContent = v || '—';
    syncResourceState();
  });
  text.addEventListener('input', () => { val.textContent = text.value || '—'; syncResourceState(); });
}
syncSliderToText('cpu-request-slider', 'cpu-request-text', 'cpu-request-val', cpuSteps);
syncSliderToText('cpu-limit-slider',   'cpu-limit-text',   'cpu-limit-val',   cpuSteps);
syncSliderToText('mem-request-slider', 'mem-request-text', 'mem-request-val', memSteps);
syncSliderToText('mem-limit-slider',   'mem-limit-text',   'mem-limit-val',   memSteps);

function syncResourceState() {
  state.resources.cpuRequest    = el('cpu-request-text').value;
  state.resources.cpuLimit      = el('cpu-limit-text').value;
  state.resources.memRequest    = el('mem-request-text').value;
  state.resources.memLimit      = el('mem-limit-text').value;
  state.resources.image         = el('container-image').value;
  state.resources.name          = el('container-name').value;
  state.resources.sourceMapping = el('source-mapping').value;
}
['container-image', 'container-name', 'source-mapping'].forEach(id =>
  el(id).addEventListener('input', syncResourceState)
);

// ─── Repositories ─────────────────────────────────────────────────────────────
function renderRepos() {
  const list = el('repo-list'), empty = el('repo-empty');
  list.innerHTML = '';
  empty.style.display = state.repos.length ? 'none' : 'block';
  state.repos.forEach((r, i) => {
    const entry = document.createElement('div');
    entry.className = 'repo-entry';
    entry.innerHTML = `
      <div class="field-group">
        <label class="field-label">Project Name</label>
        <input type="text" value="${r.name}" placeholder="my-project" data-field="name" data-idx="${i}">
        <p class="field-hint">^[a-z0-9]([-a-z0-9]*[a-z0-9])?$</p>
      </div>
      <div class="field-group">
        <label class="field-label">Remote URL</label>
        <input type="text" value="${r.remote}" placeholder="https://github.com/org/repo" data-field="remote" data-idx="${i}">
      </div>
      <div class="field-group">
        <label class="field-label">Branch / Revision</label>
        <input type="text" value="${r.branch}" placeholder="main" data-field="branch" data-idx="${i}">
      </div>
      <div class="remove-btn">
        <button class="btn btn-danger btn-sm" data-remove="${i}">✕</button>
      </div>`;
    list.appendChild(entry);
  });
  list.querySelectorAll('input[data-field]').forEach(inp =>
    inp.addEventListener('input', e => {
      state.repos[+e.target.dataset.idx][e.target.dataset.field] = e.target.value;
      renderBadge('repositories', state.repos.length);
    })
  );
  list.querySelectorAll('[data-remove]').forEach(btn =>
    btn.addEventListener('click', e => { state.repos.splice(+e.currentTarget.dataset.remove, 1); renderRepos(); })
  );
  renderBadge('repositories', state.repos.length);
}
el('add-repo-btn').addEventListener('click', () => {
  state.repos.push({ name: '', remote: '', branch: 'main', clonePath: '' });
  renderRepos();
});

function renderStarters() {
  const list = el('starter-list'), empty = el('starter-empty');
  list.innerHTML = '';
  empty.style.display = state.starters.length ? 'none' : 'block';
  state.starters.forEach((r, i) => {
    const entry = document.createElement('div');
    entry.className = 'repo-entry';
    entry.innerHTML = `
      <div class="field-group">
        <label class="field-label">Starter Name</label>
        <input type="text" value="${r.name}" placeholder="my-starter" data-field="name" data-idx="${i}">
      </div>
      <div class="field-group">
        <label class="field-label">Remote URL</label>
        <input type="text" value="${r.remote}" placeholder="https://github.com/org/starter" data-field="remote" data-idx="${i}">
      </div>
      <div class="field-group">
        <label class="field-label">Branch</label>
        <input type="text" value="${r.branch}" placeholder="main" data-field="branch" data-idx="${i}">
      </div>
      <div class="remove-btn">
        <button class="btn btn-danger btn-sm" data-remove="${i}">✕</button>
      </div>`;
    list.appendChild(entry);
  });
  list.querySelectorAll('input[data-field]').forEach(inp =>
    inp.addEventListener('input', e => { state.starters[+e.target.dataset.idx][e.target.dataset.field] = e.target.value; })
  );
  list.querySelectorAll('[data-remove]').forEach(btn =>
    btn.addEventListener('click', e => { state.starters.splice(+e.currentTarget.dataset.remove, 1); renderStarters(); })
  );
}
el('add-starter-btn').addEventListener('click', () => {
  state.starters.push({ name: '', remote: '', branch: 'main' });
  renderStarters();
});

// ─── Endpoints ────────────────────────────────────────────────────────────────
function renderEndpoints() {
  const list = el('endpoint-list'), empty = el('endpoint-empty');
  list.innerHTML = '';
  empty.style.display = state.endpoints.length ? 'none' : 'block';
  state.endpoints.forEach((ep, i) => {
    const row = document.createElement('div');
    row.className = 'repo-entry';
    row.style.gridTemplateColumns = '1fr 90px 110px 110px auto';
    row.innerHTML = `
      <div class="field-group"><label class="field-label">Name</label><input type="text" value="${ep.name}" placeholder="http-dev" data-field="name" data-idx="${i}"></div>
      <div class="field-group"><label class="field-label">Port</label><input type="number" value="${ep.targetPort}" placeholder="3000" data-field="targetPort" data-idx="${i}"></div>
      <div class="field-group"><label class="field-label">Protocol</label><select data-field="protocol" data-idx="${i}">${['http','https','ws','wss','tcp','udp'].map(p=>`<option ${p===ep.protocol?'selected':''}>${p}</option>`).join('')}</select></div>
      <div class="field-group"><label class="field-label">Exposure</label><select data-field="exposure" data-idx="${i}">${['public','internal','none'].map(p=>`<option ${p===ep.exposure?'selected':''}>${p}</option>`).join('')}</select></div>
      <div class="remove-btn"><button class="btn btn-danger btn-sm" data-remove="${i}">✕</button></div>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-field]').forEach(el => {
    ['change', 'input'].forEach(ev =>
      el.addEventListener(ev, e => { state.endpoints[+e.target.dataset.idx][e.target.dataset.field] = e.target.value; })
    );
  });
  list.querySelectorAll('[data-remove]').forEach(btn =>
    btn.addEventListener('click', e => { state.endpoints.splice(+e.currentTarget.dataset.remove, 1); renderEndpoints(); })
  );
}
el('add-endpoint-btn').addEventListener('click', () => {
  state.endpoints.push({ name: '', targetPort: 3000, protocol: 'http', exposure: 'public' });
  renderEndpoints();
});

// ─── Custom Env ───────────────────────────────────────────────────────────────
function renderCustomEnv() {
  const list = el('custom-env-list'), empty = el('custom-env-empty');
  list.innerHTML = '';
  empty.style.display = state.customEnv.length ? 'none' : 'block';
  state.customEnv.forEach((kv, i) => {
    const row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML = `
      <input type="text" value="${kv.name}" placeholder="ENV_VAR_NAME" data-field="name" data-idx="${i}">
      <input type="text" value="${kv.value}" placeholder="value" data-field="value" data-idx="${i}">
      <button class="btn btn-danger btn-sm" data-remove="${i}">✕</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('input[data-field]').forEach(inp =>
    inp.addEventListener('input', e => { state.customEnv[+e.target.dataset.idx][e.target.dataset.field] = e.target.value; })
  );
  list.querySelectorAll('[data-remove]').forEach(btn =>
    btn.addEventListener('click', e => { state.customEnv.splice(+e.currentTarget.dataset.remove, 1); renderCustomEnv(); })
  );
}
el('add-env-btn').addEventListener('click', () => { state.customEnv.push({ name: '', value: '' }); renderCustomEnv(); });

// ─── Volumes ──────────────────────────────────────────────────────────────────
function renderVolumes() {
  const list = el('volume-list'), empty = el('volume-empty');
  list.innerHTML = '';
  empty.style.display = state.volumes.length ? 'none' : 'block';
  state.volumes.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'repo-entry';
    row.style.gridTemplateColumns = '1fr 120px 1fr auto';
    row.innerHTML = `
      <div class="field-group"><label class="field-label">Volume Name</label><input type="text" value="${v.name}" placeholder="my-volume" data-field="name" data-idx="${i}"></div>
      <div class="field-group"><label class="field-label">Size</label><input type="text" value="${v.size}" placeholder="1Gi" data-field="size" data-idx="${i}"></div>
      <div class="field-group"><label class="field-label">Mount Path</label><input type="text" value="${v.mountPath}" placeholder="/data" data-field="mountPath" data-idx="${i}"></div>
      <div class="remove-btn"><button class="btn btn-danger btn-sm" data-remove="${i}">✕</button></div>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-field]').forEach(inp =>
    inp.addEventListener('input', e => { state.volumes[+e.target.dataset.idx][e.target.dataset.field] = e.target.value; })
  );
  list.querySelectorAll('[data-remove]').forEach(btn =>
    btn.addEventListener('click', e => { state.volumes.splice(+e.currentTarget.dataset.remove, 1); renderVolumes(); })
  );
}
el('add-vol-btn').addEventListener('click', () => { state.volumes.push({ name: '', size: '1Gi', mountPath: '' }); renderVolumes(); });

// ─── Component Catalog ────────────────────────────────────────────────────────
function renderCatalog() {
  const cat = el('component-catalog');
  cat.innerHTML = '';
  CATALOG.forEach(comp => {
    const item = document.createElement('div');
    item.className = 'catalog-item' + (state.activeComponents.has(comp.id) ? ' selected' : '');
    item.innerHTML = `<div class="catalog-icon">${comp.icon}</div><div class="catalog-name">${comp.name}</div><div class="catalog-desc">${comp.desc}</div>`;
    item.addEventListener('click', () => {
      if (state.activeComponents.has(comp.id)) {
        state.activeComponents.delete(comp.id);
      } else {
        state.activeComponents.add(comp.id);
        if (!state.componentConfigs[comp.id]) {
          state.componentConfigs[comp.id] = {};
          comp.fields.forEach(f => { state.componentConfigs[comp.id][f.key] = ''; });
        }
      }
      renderCatalog();
      renderActiveComponents();
    });
    cat.appendChild(item);
  });
}

function renderActiveComponents() {
  const container = el('active-components'), empty = el('active-components-empty');
  container.innerHTML = '';
  const active = CATALOG.filter(c => state.activeComponents.has(c.id));
  empty.style.display = active.length ? 'none' : 'block';
  renderBadge('components', active.length);
  active.forEach(comp => {
    const block = document.createElement('div');
    block.className = 'component-block';
    const cfg = state.componentConfigs[comp.id] || {};
    block.innerHTML = `
      <div class="component-block-header">
        <span>${comp.icon}</span>
        <span style="font-size:13px;font-weight:600">${comp.name}</span>
        <span class="collapse-icon" style="margin-left:auto">▾</span>
      </div>
      <div class="component-block-body">
        ${comp.fields.map(f => `
          <div class="field-group mb-8">
            <label class="field-label">${f.label}</label>
            <input type="${f.type || 'text'}" value="${cfg[f.key] || ''}" placeholder="${f.placeholder}" data-comp="${comp.id}" data-key="${f.key}">
          </div>`).join('')}
      </div>`;
    block.querySelector('.component-block-header').addEventListener('click', () => block.classList.toggle('collapsed'));
    block.querySelectorAll('input[data-comp]').forEach(inp =>
      inp.addEventListener('input', e => { state.componentConfigs[e.target.dataset.comp][e.target.dataset.key] = e.target.value; })
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
  state.customEnv.filter(e => e.name).forEach(e => envVars.push({ name: e.name, value: e.value }));
  CATALOG.filter(c => state.activeComponents.has(c.id)).forEach(comp => {
    const cfg = state.componentConfigs[comp.id] || {};
    comp.fields.forEach(f => { if (f.key.toUpperCase() === f.key && cfg[f.key]) envVars.push({ name: f.key, value: cfg[f.key] }); });
  });
  const volComponents = [], volMounts = [];
  state.volumes.filter(v => v.name).forEach(v => {
    volComponents.push({ name: v.name, volume: v.size ? { size: v.size } : {} });
    volMounts.push({ name: v.name, path: v.mountPath || `/${v.name}` });
  });
  if (state.activeComponents.has('docker-in-docker')) {
    const cfg = state.componentConfigs['docker-in-docker'] || {};
    volComponents.push({ name: 'dind-storage', volume: { size: cfg['dind-vol-size'] || '10Gi' } });
    volMounts.push({ name: 'dind-storage', path: '/var/lib/docker' });
  }
  if (state.activeComponents.has('node-version')) {
    const cfg = state.componentConfigs['node-version'] || {};
    const vname = (cfg['npm-cache-vol'] || 'npm-cache').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (vname) { volComponents.push({ name: vname, volume: {} }); volMounts.push({ name: vname, path: '/root/.npm' }); }
  }
  if (state.activeComponents.has('shared-volume')) {
    const cfg = state.componentConfigs['shared-volume'] || {};
    const vname = (cfg['shared-vol-name'] || 'shared-data').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (vname) {
      volComponents.push({ name: vname, volume: { size: cfg['shared-vol-size'] || '5Gi' } });
      volMounts.push({ name: vname, path: cfg['shared-vol-path'] || '/shared' });
    }
  }
  const allEndpoints = [...state.endpoints.filter(e => e.name && e.targetPort)];
  if (state.activeComponents.has('debug-port')) {
    const cfg = state.componentConfigs['debug-port'] || {};
    allEndpoints.push({ name: 'debug', targetPort: parseInt(cfg['debug-port']) || 5005, protocol: 'tcp', exposure: 'internal' });
  }
  const containerComp = {
    name: r.name || 'dev',
    container: {
      image: r.image || 'quay.io/devfile/universal-developer-image:latest',
      ...(r.cpuRequest ? { cpuRequest: r.cpuRequest } : {}),
      ...(r.cpuLimit   ? { cpuLimit:   r.cpuLimit   } : {}),
      ...(r.memRequest ? { memoryRequest: r.memRequest } : {}),
      ...(r.memLimit   ? { memoryLimit:   r.memLimit   } : {}),
      mountSources: r.mountSources,
      ...(r.sourceMapping ? { sourceMapping: r.sourceMapping } : {}),
      ...(r.dedicatedPod  ? { dedicatedPod: true } : {}),
      ...(envVars.length      ? { env:          envVars      } : {}),
      ...(allEndpoints.length ? { endpoints:    allEndpoints } : {}),
      ...(volMounts.length    ? { volumeMounts: volMounts    } : {}),
    },
  };
  const components = [containerComp, ...volComponents];
  const projects = state.repos
    .filter(r => r.name && r.remote)
    .map(r => ({ name: r.name, git: { remotes: { origin: r.remote }, ...(r.branch && r.branch !== 'main' ? { checkoutFrom: { revision: r.branch } } : {}) } }));
  const starterProjects = state.starters
    .filter(s => s.name && s.remote)
    .map(s => ({ name: s.name, git: { remotes: { origin: s.remote }, ...(s.branch && s.branch !== 'main' ? { checkoutFrom: { revision: s.branch } } : {}) } }));
  return { schemaVersion: '2.3.0', components, ...(projects.length ? { projects } : {}), ...(starterProjects.length ? { starterProjects } : {}) };
}

function generate() {
  const data = generateDevfileData();
  const statusEl = el('output-status');
  try {
    new Devfile(data);
    statusEl.className = 'status-bar ok';
    statusEl.innerHTML = '✔ Devfile is valid and conforms to schema v2.3.0.';
  } catch (e) {
    statusEl.className = 'status-bar err';
    statusEl.innerHTML = '✖ Validation error: ' + e.message;
  }
  const plain = JSON.parse(JSON.stringify(data));
  el('yaml-output').textContent = jsyaml.dump(plain, { sortKeys: false, lineWidth: 120 });
  el('json-output').textContent = JSON.stringify(plain, null, 2);
  pushStateToURL().then(shareURL => {
    const encodedBlob = location.hash.slice(3);
    el('share-url').value = shareURL;
    el('raw-url').value = `${location.origin}/raw?c=${encodedBlob}`;
    el('share-size-tag').textContent = `~${(encodedBlob.length / 1024).toFixed(1)} KB`;
    el('share-panel').style.display = 'block';
  });
}

// ─── URL Serialization ────────────────────────────────────────────────────────
async function encodeStateToHash(stateSnapshot) {
  const serializable = { ...stateSnapshot, activeComponents: [...stateSnapshot.activeComponents] };
  const bytes = new TextEncoder().encode(JSON.stringify(serializable));
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(compressed)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function decodeHashToState(hash) {
  const b64 = hash.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const parsed = JSON.parse(new TextDecoder().decode(await new Response(ds.readable).arrayBuffer()));
  parsed.activeComponents = new Set(parsed.activeComponents || []);
  return parsed;
}

function serializableState() {
  syncResourceState();
  return {
    repos: state.repos, starters: state.starters,
    resources: { ...state.resources },
    endpoints: state.endpoints, customEnv: state.customEnv, volumes: state.volumes,
    activeComponents: state.activeComponents, componentConfigs: state.componentConfigs,
  };
}

async function pushStateToURL() {
  const hash = await encodeStateToHash(serializableState());
  history.replaceState(null, '', `#c=${hash}`);
  return `${location.origin}${location.pathname}#c=${hash}`;
}

function hydrateStateFromParsed(parsed) {
  state.repos    = parsed.repos    || [];
  state.starters = parsed.starters || [];
  state.resources = { ...state.resources, ...parsed.resources };
  state.endpoints = parsed.endpoints || [];
  state.customEnv = parsed.customEnv || [];
  state.volumes   = parsed.volumes   || [];
  state.activeComponents  = parsed.activeComponents instanceof Set ? parsed.activeComponents : new Set(parsed.activeComponents || []);
  state.componentConfigs  = parsed.componentConfigs || {};
  const r = state.resources;
  el('container-image').value  = r.image         || '';
  el('container-name').value   = r.name          || 'dev';
  el('source-mapping').value   = r.sourceMapping || '/projects';
  el('cpu-request-text').value = r.cpuRequest    || '';
  el('cpu-limit-text').value   = r.cpuLimit      || '';
  el('mem-request-text').value = r.memRequest    || '';
  el('mem-limit-text').value   = r.memLimit      || '';
  el('cpu-request-val').textContent = r.cpuRequest || '—';
  el('cpu-limit-val').textContent   = r.cpuLimit   || '—';
  el('mem-request-val').textContent = r.memRequest || '—';
  el('mem-limit-val').textContent   = r.memLimit   || '—';
  const mt = el('mount-sources-toggle');
  mt.dataset.state = r.mountSources;
  mt.classList.toggle('on', r.mountSources !== false);
  const dp = el('dedicated-pod-toggle');
  dp.dataset.state = r.dedicatedPod;
  dp.classList.toggle('on', !!r.dedicatedPod);
  renderRepos(); renderStarters(); renderEndpoints();
  renderCustomEnv(); renderVolumes(); renderCatalog(); renderActiveComponents();
}

async function tryLoadFromHash() {
  if (!location.hash.startsWith('#c=')) return false;
  try {
    hydrateStateFromParsed(await decodeHashToState(location.hash.slice(3)));
    return true;
  } catch (e) {
    console.warn('Failed to decode state from URL hash:', e);
    return false;
  }
}

// ─── Output tabs ──────────────────────────────────────────────────────────────
document.querySelectorAll('.output-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.output-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.output-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    el('pane-' + tab.dataset.tab).classList.add('active');
  });
});

el('output-generate-btn').addEventListener('click', generate);
el('generate-btn').addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelector('[data-section="output"]').classList.add('active');
  el('section-output').classList.add('active');
  generate();
});

function copyToClipboard(btn, text, label) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✔ Copied!';
    setTimeout(() => { btn.textContent = label; }, 1800);
  });
}
el('copy-btn').addEventListener('click', () => {
  const p = document.querySelector('.output-pane.active .code-block');
  navigator.clipboard.writeText(p.textContent).then(() => {
    el('copy-btn').textContent = '✔ Copied!';
    setTimeout(() => { el('copy-btn').textContent = '⎘ Copy'; }, 1800);
  });
});
el('copy-share-btn').addEventListener('click', () => copyToClipboard(el('copy-share-btn'), el('share-url').value, '⎘ Copy'));
el('copy-raw-btn').addEventListener('click',   () => copyToClipboard(el('copy-raw-btn'),   el('raw-url').value,   '⎘ Copy Raw'));
el('download-btn').addEventListener('click', () => {
  const isYaml = document.querySelector('.output-tab.active').dataset.tab === 'yaml';
  const content = el(isYaml ? 'yaml-output' : 'json-output').textContent;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  a.download = `devfile.${isYaml ? 'yaml' : 'json'}`;
  a.click();
});

// ─── Import ───────────────────────────────────────────────────────────────────
el('do-import-btn').addEventListener('click', () => {
  const raw = el('import-yaml-input').value.trim();
  const statusEl = el('import-status'), resultCard = el('import-result-card');
  statusEl.style.display = '';
  if (!raw) {
    statusEl.className = 'status-bar err';
    statusEl.textContent = 'Please paste a devfile YAML first.';
    resultCard.style.display = 'none';
    return;
  }
  try {
    const data = jsyaml.load(raw);
    const devfile = new Devfile(data);
    statusEl.className = 'status-bar ok';
    statusEl.textContent = '✔ Valid devfile. Schema version: ' + devfile.schemaVersion;
    el('import-json-output').textContent = JSON.stringify(JSON.parse(JSON.stringify(devfile)), null, 2);
    resultCard.style.display = 'block';
    if (devfile.components) {
      const main = devfile.components.find(c => c.container);
      if (main && main.container) {
        const ct = main.container;
        state.resources.image        = ct.image         || '';
        state.resources.name         = main.name;
        state.resources.cpuRequest   = ct.cpuRequest    || '';
        state.resources.cpuLimit     = ct.cpuLimit      || '';
        state.resources.memRequest   = ct.memoryRequest || '';
        state.resources.memLimit     = ct.memoryLimit   || '';
        state.resources.mountSources = ct.mountSources !== false;
        state.resources.dedicatedPod = ct.dedicatedPod  || false;
        el('container-image').value  = state.resources.image;
        el('container-name').value   = state.resources.name;
        el('cpu-request-text').value = state.resources.cpuRequest;
        el('cpu-limit-text').value   = state.resources.cpuLimit;
        el('mem-request-text').value = state.resources.memRequest;
        el('mem-limit-text').value   = state.resources.memLimit;
        el('cpu-request-val').textContent = state.resources.cpuRequest || '—';
        el('cpu-limit-val').textContent   = state.resources.cpuLimit   || '—';
        el('mem-request-val').textContent = state.resources.memRequest || '—';
        el('mem-limit-val').textContent   = state.resources.memLimit   || '—';
        const mt = el('mount-sources-toggle');
        mt.dataset.state = state.resources.mountSources;
        mt.classList.toggle('on', state.resources.mountSources);
        if (ct.env) { state.customEnv = ct.env.map(e => ({ name: e.name, value: e.value || '' })); renderCustomEnv(); }
        if (ct.endpoints) { state.endpoints = ct.endpoints.map(e => ({ name: e.name, targetPort: e.targetPort, protocol: e.protocol || 'http', exposure: e.exposure || 'public' })); renderEndpoints(); }
      }
    }
    if (devfile.projects) {
      state.repos = devfile.projects.map(p => ({
        name: p.name,
        remote: p.git ? Object.values(p.git.remotes || {})[0] || '' : '',
        branch: p.git?.checkoutFrom?.revision || 'main',
        clonePath: p.clonePath || p.name,
      }));
      renderRepos();
    }
    if (devfile.starterProjects) {
      state.starters = devfile.starterProjects.map(p => ({
        name: p.name,
        remote: p.git ? Object.values(p.git.remotes || {})[0] || '' : '',
        branch: p.git?.checkoutFrom?.revision || 'main',
      }));
      renderStarters();
    }
  } catch (e) {
    statusEl.className = 'status-bar err';
    statusEl.textContent = '✖ ' + e.message;
    resultCard.style.display = 'none';
  }
});

el('clear-import-btn').addEventListener('click', () => {
  el('import-yaml-input').value = '';
  el('import-status').style.display = 'none';
  el('import-result-card').style.display = 'none';
});

el('import-btn').addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelector('[data-section="import"]').classList.add('active');
  el('section-import').classList.add('active');
});

// ─── Init ─────────────────────────────────────────────────────────────────────
tryLoadFromHash().then(loaded => {
  if (!loaded) {
    renderRepos(); renderStarters(); renderEndpoints(); renderCustomEnv(); renderVolumes();
  }
});
