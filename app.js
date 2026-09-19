import { Site, decodeZip, pickEntry } from "./metamorph.js";
import { buildDemoZip } from "./demo-site.js";

const $ = (id) => document.getElementById(id);

const els = {
  app: $("appEl"),
  stage: $("stageEl"),
  view: $("viewEl"),
  site: $("siteEl"),
  hot: $("hotEl"),
  start: $("startEl"),
  busy: $("busyEl"),
  busyText: $("busyTextEl"),
  err: $("errEl"),
  errMsg: $("errMsgEl"),
  errRetry: $("errRetryBtn"),
  panel: $("panelEl"),
  panelBody: $("panelBodyEl"),
  pill: $("pillEl"),
  pillSrc: $("pillSrcEl"),
  pillMeta: $("pillMetaEl"),
  dot: $("dotEl"),
  fileInput: $("fileInput"),
  urlInput: $("urlInput"),
  loadUrlBtn: $("loadUrlBtn"),
  demoBtn: $("demoBtn"),
  browseBtn: $("browseBtn"),
  drop: $("dropEl"),
  reloadBtn: $("reloadBtn"),
  backBtn: $("backBtn"),
  zoomOutBtn: $("zoomOutBtn"),
  zoomInBtn: $("zoomInBtn"),
  zoomLabel: $("zoomLabelEl"),
  panelBtn: $("panelBtn"),
  panelCloseBtn: $("panelCloseBtn"),
  toast: $("toastEl"),
};

// Metamorph keeps everything of its own inside one widget option (`metamorph`), so an uploaded
// Grist-aware site can use grist.setOption(...) for its own keys without stepping on our config.
const OPTS_KEY = "metamorph";
const LEGACY_KEYS = ["zipUrl", "entry", "size", "zoom", "priority"];
const EMBED_WARN = 1.5 * 1024 * 1024;
const EMBED_MAX = 6 * 1024 * 1024;

const state = {
  files: null,
  bytes: null,
  site: null,
  entry: null,
  previewPath: null,
  sourceKey: null,
  sourceLabel: "nothing loaded",
  sourceSize: 0,
  connected: false,
  standalone: false,
  access: null,
  config: {},
  embedded: null,
  rowFallback: null,
  record: null,
  mappings: null,
  entryHint: "",
  zoom: 1,
  size: "auto",
  cache: new Map(),
  lastError: null,
  chrome: true,
  chromeTimer: null,
  bundleKey: null,
  bundleBytes: null,
};

const SIZE_PRESETS = { auto: null, "1280x800": [1280, 800], "1024x768": [1024, 768], "768x1024": [768, 1024], "390x844": [390, 844] };

const LS_URL_KEY = "metamorph.zipUrl";

function rememberUrl(url) {
  try { localStorage.setItem(LS_URL_KEY, url); } catch (e) {}
}

function forgetUrl() {
  try { localStorage.removeItem(LS_URL_KEY); } catch (e) {}
}

function rememberedUrl() {
  try { return localStorage.getItem(LS_URL_KEY) || ""; } catch (e) { return ""; }
}

function labelOf(url) {
  return url.split("/").pop().split("?")[0] || url;
}

function formatBytes(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function toast(msg, ms) {
  els.toast.textContent = msg;
  els.toast.classList.add("is-on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("is-on"), ms || 2600);
}

/* ---------------------------------------------------------------- chrome */

function setChrome(shown) {
  const want = !!shown || !state.site;
  state.chrome = want;
  els.app.classList.toggle("is-sited", !!state.site);
  els.app.classList.toggle("is-chrome", want);
  els.hot.hidden = !state.site || want;
}

function flashChrome(ms) {
  setChrome(true);
  clearTimeout(state.chromeTimer);
  state.chromeTimer = setTimeout(() => {
    if (!els.panel.hidden) return;
    setChrome(false);
  }, ms || 2200);
}

/* ----------------------------------------------------------------- modes */

function setMode(mode) {
  els.start.hidden = mode !== "start";
  els.busy.hidden = mode !== "busy";
  els.err.hidden = mode !== "error";
  els.view.hidden = mode === "start" || mode === "busy" || mode === "error";
  els.reloadBtn.disabled = !state.site;
  if (mode !== "site") setChrome(true);
  updatePill();
}

function setBusy(text) {
  els.busyText.textContent = text || "unpacking…";
  setMode("busy");
}

function showError(err, label) {
  state.lastError = { message: err && err.message ? err.message : String(err), label: label || state.sourceLabel };
  els.errMsg.textContent = state.lastError.message;
  setMode("error");
  updatePill();
}

function updatePill() {
  els.backBtn.hidden = !state.previewPath;
  if (state.previewPath) {
    els.pillSrc.textContent = state.previewPath;
    els.pillMeta.textContent = "preview";
    return;
  }
  els.pillSrc.textContent = state.sourceLabel;
  const bits = [];
  if (state.files) bits.push(state.files.size + " files · " + formatBytes(state.sourceSize));
  if (state.embedded && state.sourceKey === state.embedded.key) bits.push("in document");
  if (!state.files && state.standalone) bits.push("standalone");
  els.pillMeta.textContent = bits.join(" · ");
  els.dot.className = "mm-dot" + (!state.files ? " is-off" : state.connected ? "" : " is-off");
}

/* ------------------------------------------------------------ persistence */

function idb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open("metamorph-widget", 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("kv")) req.result.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const req = tx.objectStore("kv").get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return null;
  }
}

async function idbDel(key) {
  try {
    const db = await idb();
    await new Promise((resolve) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").delete(key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch (e) {}
}

function cachePut(key, value) {
  if (!key) return;
  state.cache.set(key, value);
  while (state.cache.size > 3) {
    const oldest = state.cache.keys().next().value;
    if (oldest === key) break;
    state.cache.delete(oldest);
  }
}

/* --------------------------------------------------------- widget options */

function readConfig(raw) {
  const cfg = {};
  if (raw && typeof raw === "object") {
    const nested = raw[OPTS_KEY];
    if (nested && typeof nested === "object") Object.assign(cfg, nested);
    for (const key of LEGACY_KEYS) {
      if (cfg[key] === undefined && raw[key] !== undefined) cfg[key] = raw[key];
    }
  }
  return cfg;
}

function saveConfig(patch) {
  Object.assign(state.config, patch);
  renderPanel();
  if (!window.grist || !state.connected) return Promise.resolve(false);
  const payload = Object.assign({}, state.config);
  return Promise.resolve()
    .then(() => window.grist.setOption(OPTS_KEY, payload))
    .then(() => true)
    .catch((e) => {
      toast("Could not save widget options: " + (e && e.message ? e.message : e));
      return false;
    });
}

const SAVE_HINT = "Widget options changed — press Save in Grist (the button that appears next to the sort/filter icon) to write them into the document.";

function bytesToBase64(bytes) {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// A .zip is already deflated, so re-deflating usually only adds bytes — but a bare .html sheds a lot.
function packBundle(bytes) {
  let data = bytes;
  let z = 0;
  try {
    const deflated = globalThis.fflate.deflateSync(bytes);
    if (deflated.length < bytes.length * 0.98) {
      data = deflated;
      z = 1;
    }
  } catch (e) {}
  return { d: bytesToBase64(data), z };
}

async function embedSite() {
  if (!state.connected) {
    toast("Storing a site in the document only works inside Grist — right now Metamorph is standalone.");
    return;
  }
  if (!state.bytes) {
    toast("Load a site first, then you can store it in the document.");
    return;
  }
  const raw = state.bytes.length;
  if (raw > EMBED_MAX) {
    showError(
      new Error(
        "This archive is " + formatBytes(raw) + ", which is too big to live inside a Grist document (limit " +
        formatBytes(EMBED_MAX) + "). Map an Attachment column or use the ZIP URL option instead — " +
        "both keep the widget tiny."
      ),
      state.sourceLabel
    );
    return;
  }
  if (raw > EMBED_WARN && !window.confirm(
    "This archive is " + formatBytes(raw) + ". It will be stored in the document itself, so every copy of " +
    "the document carries it and it syncs to every collaborator. Continue?"
  )) return;

  setBusy("storing the site in this document…");
  await new Promise((r) => setTimeout(r, 30));
  const packed = packBundle(state.bytes);
  const bundle = {
    v: 1,
    name: state.sourceLabel,
    entry: state.entry,
    savedAt: Date.now(),
    z: packed.z,
    d: packed.d,
  };
  // Adopt the new bundle before writing it, so the onOptions echo of our own write doesn't remount.
  const key = "embed:" + bundle.savedAt;
  state.embedded = { name: bundle.name, entry: bundle.entry, key, bytes: state.bytes, savedAt: bundle.savedAt };
  state.sourceKey = key;
  cachePut(key, { files: state.files, bytes: state.bytes, label: bundle.name });
  const ok = await saveConfig({ site: bundle, entry: state.entry });
  setMode("site");
  if (!ok) {
    updatePill();
    return;
  }
  toast("Stored in the document options. " + SAVE_HINT, 11000);
  updatePill();
  renderPanel();
}

async function clearEmbed() {
  if (!state.embedded) return;
  if (!window.confirm("Remove the site that is stored inside this document? The widget goes back to its normal row/URL sources.")) return;
  const previous = state.embedded.key;
  state.embedded = null;
  if (state.sourceKey === previous) state.sourceKey = null;
  await saveConfig({ site: null });
  toast("Removed from the widget options. " + SAVE_HINT, 11000);
  updatePill();
  renderPanel();
}

/* ----------------------------------------------------------- source intent */

function pickAttachment(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    const id = Number(value);
    return { id, name: "attachment-" + id + ".zip" };
  }
  if (typeof value === "string") return null;
  if (Array.isArray(value)) {
    if (value[0] === "L" && value.length >= 3) {
      return { id: value[1], name: String(value[2] || "attachment-" + value[1] + ".zip") };
    }
    if (value.length === 2 && typeof value[0] === "number" && typeof value[1] === "string") {
      return { id: value[0], name: value[1] };
    }
    for (const item of value) {
      const found = pickAttachment(item);
      if (found) return found;
    }
  }
  return null;
}

// For the "no column mapping configured" case: scan every column value. Bare numbers are ignored
// (they're far more likely to be ordinary data than attachment ids).
function pickEncodedAttachment(value) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "string") return null;
  if (!Array.isArray(value)) return null;
  if (value[0] === "L" && value.length >= 3 && typeof value[1] === "number") {
    const name = String(value[2] || "attachment-" + value[1] + ".zip");
    return { id: value[1], name };
  }
  if (value.length === 2 && typeof value[0] === "number" && typeof value[1] === "string") {
    return { id: value[0], name: value[1] };
  }
  for (const item of value) {
    const found = pickEncodedAttachment(item);
    if (found) return found;
  }
  return null;
}

function scanRowForSource(row) {
  let best = null;
  for (const [key, value] of Object.entries(row || {})) {
    if (key === "id") continue;
    const att = pickEncodedAttachment(value);
    if (att) {
      const zipish = /\.zip$/i.test(att.name);
      if (zipish) return { kind: "attachment", att, key: "att:" + att.id, label: att.name, scanned: true };
      if (!best) best = { kind: "attachment", att, key: "att:" + att.id, label: att.name, scanned: true };
      continue;
    }
    if (typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim()) && /\.zip(\?|#|$)/i.test(value.trim())) {
      const url = value.trim();
      if (!best) best = { kind: "url", url, key: "url:" + url, label: labelOf(url), scanned: true };
    }
  }
  return best;
}

function mappedRecord() {
  const raw = state.record;
  if (!raw) return null;
  if (window.grist && typeof window.grist.mapColumnNames === "function") {
    try {
      const mapped = window.grist.mapColumnNames(raw);
      if (mapped) return Object.assign({}, raw, mapped);
    } catch (e) {}
  }
  return raw;
}

function rowIntent() {
  const mapped = mappedRecord() || {};
  const att = pickAttachment(mapped.zip) || pickAttachment(mapped.url);
  if (att) return { kind: "attachment", att, key: "att:" + att.id, label: att.name };
  const rawUrl = typeof mapped.url === "string" ? mapped.url.trim() : "";
  if (/^https?:\/\//i.test(rawUrl)) return { kind: "url", url: rawUrl, key: "url:" + rawUrl, label: labelOf(rawUrl) };
  return state.rowFallback;
}

function currentIntent() {
  const embedded = state.embedded
    ? { kind: "embedded", key: state.embedded.key, label: state.embedded.name, entry: state.embedded.entry, bytes: state.embedded.bytes }
    : null;
  const row = rowIntent();
  const cfgUrl = typeof state.config.zipUrl === "string" && /^https?:\/\//i.test(state.config.zipUrl)
    ? { kind: "url", url: state.config.zipUrl, key: "url:" + state.config.zipUrl, label: labelOf(state.config.zipUrl) }
    : null;
  const embeddedFirst = embedded && state.config.priority !== "row";
  const order = embeddedFirst ? [embedded, row, cfgUrl] : [row, cfgUrl, embedded];
  for (const candidate of order) if (candidate) return candidate;

  // Standalone (GitHub Pages / a plain .html file): fall back to whatever this browser remembers.
  if (state.standalone || !state.connected) {
    const saved = rememberedUrl();
    if (saved) return { kind: "url", url: saved, key: "url:" + saved, label: labelOf(saved), saved: true };
  }
  return { kind: "none" };
}

/* ------------------------------------------------------------------- view */

function applyOptions(raw, settings) {
  state.config = readConfig(raw);
  if (settings) state.access = settings.accessLevel || settings.access_level || state.access;
  const stored = state.config.site && typeof state.config.site.d === "string" ? state.config.site : null;
  if (stored) {
    // Options echo back on every write (zoom, size…), so decode a given bundle only once.
    const key = "embed:" + (stored.savedAt || stored.d.length);
    let bytes = null;
    if (state.bundleKey === key && state.bundleBytes) {
      bytes = state.bundleBytes;
    } else {
      try {
        const packed = base64ToBytes(stored.d);
        bytes = stored.z ? globalThis.fflate.inflateSync(packed) : packed;
        state.bundleKey = key;
        state.bundleBytes = bytes;
      } catch (e) {
        console.warn("[metamorph] embedded bundle could not be read", e);
      }
    }
    if (bytes && bytes.length) {
      state.embedded = {
        name: stored.name || "site stored in document",
        entry: stored.entry || "",
        key,
        bytes,
        savedAt: stored.savedAt || 0,
      };
    } else {
      state.embedded = null;
      toast("The site stored in this document's widget options could not be read.");
    }
  } else {
    state.embedded = null;
  }
  if (typeof state.config.zoom === "number" && state.config.zoom >= 0.25 && state.config.zoom <= 2) state.zoom = state.config.zoom;
  if (state.config.size && SIZE_PRESETS[state.config.size]) state.size = state.config.size;
  state.entryHint = typeof state.config.entry === "string" ? state.config.entry : "";
  layout();
  renderPanel();
}

function layout() {
  const container = els.view;
  const cw = Math.max(120, container.clientWidth);
  const ch = Math.max(80, container.clientHeight);
  const preset = SIZE_PRESETS[state.size];
  if (preset) {
    const scale = Math.min(1, cw / preset[0], ch / preset[1]) * state.zoom;
    els.site.style.width = preset[0] + "px";
    els.site.style.height = preset[1] + "px";
    els.site.style.transform = "scale(" + scale + ")";
  } else {
    els.site.style.width = Math.round(cw / state.zoom) + "px";
    els.site.style.height = Math.round(ch / state.zoom) + "px";
    els.site.style.transform = "scale(" + state.zoom + ")";
  }
  els.zoomLabel.textContent = Math.round(state.zoom * 100) + "%";
  els.site.hidden = !state.site;
}

function setZoom(z) {
  state.zoom = Math.min(2, Math.max(0.25, Math.round(z * 20) / 20));
  layout();
  saveConfig({ zoom: state.zoom });
}

function setSize(name) {
  if (!SIZE_PRESETS[name]) return;
  state.size = name;
  layout();
  saveConfig({ size: name });
}

function mountSite(files, meta) {
  const wanted = (meta && meta.entry) || state.entryHint || state.config.entry || "";
  const entry = pickEntry(files, wanted);
  if (!entry) throw new Error("No HTML page was found inside the archive.");
  const site = new Site(files);
  const url = site.pageUrl(entry);
  if (!url) throw new Error("Could not prepare the start page (" + entry + ").");
  site.entry = entry;
  site.onChrome = () => setChrome(!state.chrome);
  site.install();
  const previous = state.site;
  state.site = site;
  state.files = files;
  state.entry = entry;
  state.previewPath = null;
  els.site.src = url;
  els.site.hidden = false;
  setMode("site");
  if (previous) previous.dispose();
  layout();
  flashChrome(2400);
  setTimeout(afterMount, 60);
}

function afterMount() {
  updatePill();
  renderPanel();
  setTimeout(() => {
    const doc = els.site.contentDocument;
    if (doc && doc.title) els.pillSrc.textContent = doc.title;
  }, 300);
  setTimeout(renderPanel, 1600);
}

async function useBytes(bytes, meta) {
  setBusy((meta && meta.busyText) || "unpacking " + formatBytes(bytes.length) + "…");
  await new Promise((r) => setTimeout(r, 30));
  const files = decodeZip(bytes);
  state.sourceSize = bytes.length;
  state.sourceLabel = (meta && meta.label) || "website.zip";
  state.sourceKey = (meta && meta.key) || null;
  state.bytes = bytes;
  mountSite(files, meta || {});
  if (meta && meta.remember) {
    idbSet("localZip", { bytes, label: state.sourceLabel, key: state.sourceKey, savedAt: Date.now() });
  }
}

async function useFile(file) {
  if (!file) return;
  if (!/\.(zip|html?|xhtml)$/i.test(file.name) && !/^application\/(zip|x-zip)/.test(file.type)) {
    toast("That doesn't look like a .zip or .html file");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await useBytes(bytes, { label: file.name, key: "file:" + file.name + ":" + file.size, entry: state.entryHint, remember: true });
}

async function useUrl(url, opts) {
  const label = labelOf(url);
  const key = "url:" + url;
  if (state.cache.has(key)) {
    const hit = state.cache.get(key);
    state.sourceLabel = hit.label;
    state.sourceSize = hit.bytes.length;
    state.sourceKey = key;
    state.bytes = hit.bytes;
    mountSite(hit.files, { entry: state.entryHint });
    return;
  }
  setBusy("fetching " + label + "…");
  let response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (e) {
    throw new Error("Could not fetch that URL (" + e.message + "). The host must allow cross-origin requests — or just drop the .zip into the widget.");
  }
  if (!response.ok) throw new Error("The server answered " + response.status + " for that URL.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  const looksHtml = /\.(html?|xhtml)$/i.test(url.split("?")[0].split("#")[0]);
  if (!isZip && !looksHtml) {
    throw new Error("That URL didn't return a .zip or .html file (it may be an error page or a GitHub 'blob' page — use the raw/download link).");
  }
  await useBytes(bytes, { label, key, entry: state.entryHint });
  cachePut(key, { files: state.files, bytes, label: state.sourceLabel });
  if (opts && opts.save) {
    rememberUrl(url);
    saveConfig({ zipUrl: url });
  }
}

async function useEmbedded(intent) {
  if (state.cache.has(intent.key)) {
    const hit = state.cache.get(intent.key);
    state.sourceLabel = hit.label;
    state.sourceSize = hit.bytes.length;
    state.sourceKey = intent.key;
    state.bytes = hit.bytes;
    mountSite(hit.files, { entry: intent.entry });
    return;
  }
  await useBytes(intent.bytes, {
    label: intent.name || intent.label,
    key: intent.key,
    entry: intent.entry,
    busyText: "unpacking the site stored in this document…",
  });
  cachePut(intent.key, { files: state.files, bytes: state.bytes, label: state.sourceLabel });
}

async function useAttachment(att) {
  const key = "att:" + att.id;
  if (state.cache.has(key)) {
    const hit = state.cache.get(key);
    state.sourceLabel = hit.label;
    state.sourceSize = hit.bytes.length;
    state.sourceKey = key;
    state.bytes = hit.bytes;
    mountSite(hit.files, { entry: state.entryHint });
    return;
  }
  if (!window.grist || !window.grist.docApi || !window.grist.docApi.getAccessToken) {
    throw new Error("Grist access tokens are unavailable — grant the widget full document access, or use a URL / local file.");
  }
  setBusy("downloading " + att.name + " from Grist…");
  const info = await window.grist.docApi.getAccessToken({ readOnly: true });
  const url = info.baseUrl + "/attachments/" + att.id + "/download?auth=" + encodeURIComponent(info.token);
  let response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw new Error("Could not download the attachment (" + e.message + "). Some Grist deployments don't allow cross-origin reads — host the .zip somewhere with CORS, or drop the file in directly.");
  }
  if (!response.ok) throw new Error("Grist answered " + response.status + " for that attachment.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  await useBytes(bytes, { label: att.name, key, entry: state.entryHint });
  cachePut(key, { files: state.files, bytes, label: att.name });
}

async function refreshSource(force) {
  const intent = currentIntent();
  if (intent.kind === "none") {
    if (state.files) return;
    if (force) showError("No .zip source is configured. Load a file or URL, or map an attachment column.");
    return;
  }
  if (!force && intent.key === state.sourceKey) return;
  try {
    if (intent.kind === "embedded") await useEmbedded(intent);
    else if (intent.kind === "attachment") await useAttachment(intent.att);
    else await useUrl(intent.url);
  } catch (e) {
    showError(e, intent.label);
  }
}

// Only runs when no column mapping produced a source: asks Grist for every column of the row.
let rowScanToken = 0;
async function deepScanRow(record) {
  if (!window.grist || !state.connected || !record || record.id === null || record.id === undefined) return;
  if (typeof window.grist.fetchSelectedRecord !== "function") return;
  const token = ++rowScanToken;
  let all = null;
  try {
    all = await window.grist.fetchSelectedRecord(record.id, { keepEncoded: false, includeColumns: "all" });
  } catch (e) {
    return;
  }
  if (token !== rowScanToken || !all) return;
  const found = scanRowForSource(all);
  if (!found) return;
  state.rowFallback = found;
  console.info("[metamorph] found a .zip in a column that isn't mapped:", found.label);
  refreshSource(false);
  updatePill();
}

function previewFile(path) {
  if (!state.site) return;
  const url = state.site.assetUrl(path);
  if (!url) {
    toast("Can't preview that one");
    return;
  }
  state.previewPath = path;
  els.site.src = url;
  updatePill();
  renderPanel();
}

function goHome() {
  if (!state.site || !state.entry) return;
  state.previewPath = null;
  els.site.src = state.site.pageUrl(state.entry);
  updatePill();
  renderPanel();
}

function reloadSite() {
  if (!state.site) return;
  state.previewPath = null;
  els.site.src = state.site.pageUrl(state.entry);
  updatePill();
  toast("Reloaded");
}

/* ------------------------------------------------------------------ panel */

function panelSection(title) {
  const section = document.createElement("div");
  section.className = "mm-section";
  const h = document.createElement("h3");
  h.textContent = title;
  section.append(h);
  els.panelBody.append(section);
  return section;
}

function panelRow(section) {
  const row = document.createElement("div");
  row.className = "mm-field";
  section.append(row);
  return row;
}

function panelHint(section, text) {
  const hint = document.createElement("div");
  hint.className = "mm-hint";
  hint.textContent = text;
  section.append(hint);
  return hint;
}

function panelButton(section, label, onClick, primary) {
  const btn = document.createElement("button");
  btn.className = "mm-btn" + (primary ? " is-primary" : "");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  section.append(btn);
  return btn;
}

function panelSelect(section, labelText, options, value, onChange) {
  const row = panelRow(section);
  const label = document.createElement("label");
  label.textContent = labelText;
  const select = document.createElement("select");
  select.className = "mm-input";
  select.style.minWidth = "170px";
  select.style.flex = "0 1 auto";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    select.append(o);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  row.append(label, select);
  return select;
}

function renderPanel() {
  if (els.panel.hidden) return;
  els.panelBody.textContent = "";

  const site = panelSection("Site");
  panelHint(site, state.files
    ? "Showing “" + state.sourceLabel + "” · " + state.files.size + " files · " + formatBytes(state.sourceSize)
    : "Nothing loaded yet.");
  const sourceRow = panelRow(site);
  panelButton(sourceRow, "Choose a file…", () => els.fileInput.click());
  panelButton(sourceRow, "Try the demo site", () => loadDemo());
  const urlRow = panelRow(site);
  const urlInput = document.createElement("input");
  urlInput.className = "mm-input";
  urlInput.placeholder = "https://…/site.zip";
  urlInput.value = state.config.zipUrl || "";
  urlInput.style.minWidth = "200px";
  const loadBtn = document.createElement("button");
  loadBtn.className = "mm-btn";
  loadBtn.textContent = "Load URL";
  const doLoad = () => {
    const url = urlInput.value.trim();
    if (!url) return;
    useUrl(url, { save: true }).then(() => toast("Loaded — this link is remembered for this widget")).catch((e) => showError(e, url));
  };
  loadBtn.addEventListener("click", doLoad);
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLoad();
  });
  urlRow.append(urlInput, loadBtn);
  if (rememberedUrl()) {
    panelButton(site, "Forget the remembered link", () => {
      forgetUrl();
      toast("Forgotten");
      renderPanel();
    });
  }
  if (state.sourceKey && state.sourceKey.startsWith("file:")) {
    panelButton(site, "Forget the locally remembered .zip", async () => {
      await idbDel("localZip");
      toast("Forgotten");
    });
  }

  const doc = panelSection("This document");
  if (state.connected) {
    panelHint(doc, state.embedded
      ? "Stored in the widget options: “" + state.embedded.name + "” · " + formatBytes(state.embedded.bytes.length) + ". It travels with the document, so anyone opening it sees this site."
      : "No site stored in this document's widget options yet.");
  } else {
    panelHint(doc, "Metamorph is standalone here — there is no Grist document to store anything in. Loaded files and URLs are remembered locally instead.");
  }
  const embedRow = panelRow(doc);
  const embedBtn = panelButton(
    embedRow,
    state.embedded ? "Replace with the site you're viewing" : "Store this site in the document",
    embedSite,
    !state.embedded
  );
  embedBtn.disabled = !state.connected || !state.bytes;
  if (state.embedded) panelButton(embedRow, "Remove from the document", clearEmbed);
  if (state.connected) {
    panelSelect(doc, "Source order", [
      { value: "embedded", label: "Document site first" },
      { value: "row", label: "Mapped column first" },
    ], state.config.priority === "row" ? "row" : "embedded", (value) => {
      saveConfig({ priority: value }).then(() => refreshSource(true));
    });
    panelHint(doc, "“Document site first” means the widget always shows the stored site — even for a collaborator who never had the .zip. Press Save in Grist's sort/filter menu to persist any of this in the document itself.");
  }

  const view = panelSection("View");
  const htmlFiles = state.files ? [...state.files.keys()].filter((p) => /\.(html?|xhtml)$/i.test(p)) : [];
  if (htmlFiles.length) {
    panelSelect(view, "Start page", htmlFiles.map((p) => ({ value: p, label: p })), state.entry, (value) => {
      saveConfig({ entry: value });
      if (state.site) {
        const url = state.site.pageUrl(value);
        if (url) {
          state.entry = value;
          state.previewPath = null;
          els.site.src = url;
          updatePill();
        }
      }
    });
  }
  panelSelect(view, "Window size", [
    { value: "auto", label: "Fit widget" },
    { value: "1280x800", label: "Desktop 1280×800" },
    { value: "1024x768", label: "Tablet 1024×768" },
    { value: "768x1024", label: "Portrait 768×1024" },
    { value: "390x844", label: "Phone 390×844" },
  ], state.size, setSize);

  const zoomRow = panelRow(view);
  const zoomLabel = document.createElement("label");
  zoomLabel.textContent = "Zoom";
  const zoomRange = document.createElement("input");
  zoomRange.type = "range";
  zoomRange.min = "0.25";
  zoomRange.max = "2";
  zoomRange.step = "0.05";
  zoomRange.value = String(state.zoom);
  zoomRange.style.flex = "1 1 auto";
  const zoomVal = document.createElement("span");
  zoomVal.className = "mm-hint";
  zoomVal.textContent = Math.round(state.zoom * 100) + "%";
  zoomRange.addEventListener("input", () => {
    zoomVal.textContent = Math.round(Number(zoomRange.value) * 100) + "%";
  });
  zoomRange.addEventListener("change", () => setZoom(Number(zoomRange.value)));
  zoomRow.append(zoomLabel, zoomRange, zoomVal);

  const bar = panelSection("Metamorph bar");
  panelHint(bar, state.site
    ? "While a site is loaded the bar stays out of the way. Bring it back with Ctrl/Cmd+Shift+M, the little dot in the top-right corner, or Grist's “Open configuration” entry."
    : "The bar shows whenever no site is loaded.");
  panelButton(bar, state.chrome ? "Hide the bar" : "Show the bar", () => setChrome(!state.chrome));

  if (state.files) {
    const files = panelSection("Files (“" + state.files.size + "”)");
    const filterRow = panelRow(files);
    const filter = document.createElement("input");
    filter.className = "mm-input";
    filter.placeholder = "filter…";
    filter.style.minWidth = "180px";
    filterRow.append(filter);
    const list = document.createElement("div");
    list.className = "mm-files";
    files.append(list);
    const paths = state.site ? state.site.pathList() : [...state.files.keys()];
    const paint = () => {
      const q = filter.value.trim().toLowerCase();
      list.textContent = "";
      for (const path of paths) {
        if (q && !path.toLowerCase().includes(q)) continue;
        const row = document.createElement("div");
        row.className = "mm-file";
        const name = document.createElement("span");
        name.textContent = path;
        const size = document.createElement("span");
        size.className = "mm-size";
        size.textContent = formatBytes(state.files.get(path).length);
        row.append(name, size);
        row.addEventListener("click", () => {
          previewFile(path);
          els.panel.hidden = true;
        });
        list.append(row);
        if (list.childElementCount > 400) break;
      }
    };
    filter.addEventListener("input", paint);
    paint();
  }

  const diag = panelSection("Diagnostics");
  const missing = state.site ? [...state.site.misses.entries()].slice(0, 8) : [];
  const flags = state.site ? state.site.flags.slice(-6) : [];
  const bits = [];
  bits.push("Grist: " + (state.connected ? "connected" + (state.access ? " (" + state.access + ")" : "") : window.grist ? "not connected" : "standalone"));
  if (state.site) bits.push("missing refs: " + state.site.misses.size);
  if (state.rowFallback) bits.push("auto-found: " + state.rowFallback.label);
  panelHint(diag, bits.join(" · "));
  if (window.grist && window.grist.__metamorphStub) panelHint(diag, "window.grist is Metamorph's offline stub, so a Grist-aware uploaded site still renders here.");
  if (missing.length) {
    const ul = document.createElement("div");
    ul.className = "mm-files";
    for (const [path, info] of missing) {
      const row = document.createElement("div");
      row.className = "mm-file";
      const name = document.createElement("span");
      name.className = "mm-warn";
      name.textContent = path;
      const count = document.createElement("span");
      count.className = "mm-size";
      count.textContent = "×" + info.count;
      row.append(name, count);
      ul.append(row);
    }
    diag.append(ul);
  }
  if (flags.length) {
    const pre = document.createElement("div");
    pre.className = "mm-hint";
    pre.style.whiteSpace = "pre-wrap";
    pre.textContent = flags.join("\n");
    diag.append(pre);
  }
  if (state.lastError) {
    panelHint(diag, "last error: " + state.lastError.message);
  }
}

function openPanel() {
  els.panel.hidden = false;
  setChrome(true);
  renderPanel();
}

function closePanel() {
  els.panel.hidden = true;
  if (state.site) setChrome(false);
}

function loadDemo() {
  try {
    const bytes = buildDemoZip();
    useBytes(bytes, { label: "metamorph-demo.zip", key: "demo", entry: "index.html" })
      .then(() => toast("Demo site unpacked — click around"))
      .catch((e) => showError(e, "demo"));
  } catch (e) {
    showError(e, "demo");
  }
}

/* ------------------------------------------------------------------ Grist */

function initGrist() {
  if (!window.grist || typeof window.grist.ready !== "function") return false;
  const g = window.grist;
  try {
    g.ready({
      requiredAccess: "full",
      columns: [
        { name: "zip", title: "Website ZIP", type: "Attachments", optional: true, description: "The .zip containing the site" },
        { name: "url", title: "ZIP URL", type: "Text", optional: true, description: "A link to a .zip file" },
        { name: "entry", title: "Start page", type: "Text", optional: true, description: "e.g. index.html" },
      ],
      onEditOptions: () => openPanel(),
    });
    g.onOptions((options, settings) => {
      const first = !state.connected;
      state.connected = true;
      if (first) window.__metamorphGristReady = true;
      applyOptions(options, settings);
      refreshSource(false);
      updatePill();
    });
    g.onRecord((record, mappings) => {
      state.connected = true;
      window.__metamorphGristReady = true;
      state.record = record || null;
      state.mappings = mappings || null;
      state.rowFallback = null;
      const mapped = mappedRecord() || {};
      const entry = typeof mapped.entry === "string" ? mapped.entry.trim() : "";
      if (entry && entry !== state.entryHint) {
        state.entryHint = entry;
        if (state.files) refreshSource(true);
      } else {
        refreshSource(false);
      }
      updatePill();
      renderPanel();
      if (!rowIntent() && !(state.embedded && state.config.priority !== "row")) deepScanRow(record);
    });
    return true;
  } catch (e) {
    console.warn("[metamorph] grist init failed", e);
    return false;
  }
}

// A same-origin bridge for uploaded pages: forward the Grist plugin API's messages between the
// unpacked site and Grist. (Pages that load the plugin API from its usual URL don't need this —
// they get the widget's own live API instance — but an inline/bundled copy does.)
function wireGristRelay() {
  window.addEventListener("message", (event) => {
    const frame = els.site.contentWindow;
    const fromSite = frame && event.source === frame;
    const fromGrist = window.parent !== window && event.source === window.parent;
    if (!fromSite && !fromGrist) return;
    const data = event.data;
    if (!data || typeof data !== "object" || typeof data.mtype !== "string") return;
    const target = fromSite ? window.parent : frame;
    if (!target || target === window) return;
    try {
      target.postMessage(data, "*");
    } catch (e) {}
  });
}

// Outside Grist there is no plugin API to answer an uploaded Grist-aware site, so give it a quiet
// one that resolves to empty data instead of hanging on a connection that will never come.
function installGristStub() {
  if (state.connected) return;
  const empty = (value) => () => Promise.resolve(value);
  const noop = () => Promise.resolve(null);
  const stub = {
    __metamorphStub: true,
    ready: () => {},
    on: () => {},
    onRecord: () => {},
    onRecords: () => {},
    onNewRecord: () => {},
    onOptions: () => {},
    enableKeyboardShortcuts: () => {},
    setOption: noop,
    getOption: empty(undefined),
    setOptions: noop,
    getOptions: empty(null),
    clearOptions: noop,
    fetchSelectedRecord: empty({}),
    fetchSelectedTable: empty([]),
    getTable: empty({ id: null, tableId: null, columns: [] }),
    listTables: empty([]),
    getSelectedTableId: empty(null),
    getDocName: empty(""),
    mapColumnNames: (data) => data,
    mapColumnNamesBack: (data) => data,
    getAccessToken: empty({ baseUrl: "", token: "", ttlMsecs: 0 }),
    docApi: {
      applyUserActions: empty([]),
      fetchSelectedRecord: empty({}),
      fetchSelectedTable: empty([]),
      fetchTable: empty({ id: null, columns: [] }),
      listTables: empty([]),
      getDocName: empty(""),
      setCursorPos: noop,
      getAccessToken: empty({ baseUrl: "", token: "", ttlMsecs: 0 }),
    },
    sectionApi: {},
    customSectionAPI: {},
  };
  try {
    window.grist = stub;
  } catch (e) {
    try { Object.defineProperty(window, "grist", { value: stub, configurable: true }); } catch (e2) {}
  }
  window.__metamorphGristReady = true;
  console.info("[metamorph] not running inside Grist — uploaded pages get an empty Grist API stub.");
}

/* ------------------------------------------------------------------ wiring */

function wireEvents() {
  els.browseBtn.addEventListener("click", () => els.fileInput.click());
  els.demoBtn.addEventListener("click", () => loadDemo());
  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    els.fileInput.value = "";
    useFile(file).catch((e) => showError(e, file ? file.name : ""));
  });
  els.loadUrlBtn.addEventListener("click", () => {
    const url = els.urlInput.value.trim();
    if (url) useUrl(url, { save: true }).catch((e) => showError(e, url));
  });
  els.urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.loadUrlBtn.click();
  });
  els.reloadBtn.addEventListener("click", reloadSite);
  els.backBtn.addEventListener("click", goHome);
  els.zoomOutBtn.addEventListener("click", () => setZoom(state.zoom - 0.1));
  els.zoomInBtn.addEventListener("click", () => setZoom(state.zoom + 0.1));
  els.zoomLabel.addEventListener("click", () => setZoom(1));
  els.panelBtn.addEventListener("click", () => (els.panel.hidden ? openPanel() : closePanel()));
  els.panelCloseBtn.addEventListener("click", closePanel);
  els.errRetry.addEventListener("click", () => refreshSource(true));
  els.pill.addEventListener("click", openPanel);
  els.hot.addEventListener("click", () => setChrome(true));

  window.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || !event.shiftKey || event.key.toLowerCase() !== "m") return;
    event.preventDefault();
    if (!state.site) return;
    setChrome(!state.chrome);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!els.panel.hidden) closePanel();
    else if (state.site && state.chrome) setChrome(false);
  });

  for (const evt of ["dragenter", "dragover"]) {
    window.addEventListener(evt, (e) => {
      e.preventDefault();
      els.drop.classList.add("is-over");
    });
  }
  for (const evt of ["dragleave", "drop"]) {
    window.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === "dragleave" && e.relatedTarget) return;
      els.drop.classList.remove("is-over");
    });
  }
  window.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) useFile(file).catch((err) => showError(err, file.name));
  });
  window.addEventListener("resize", layout);
}

async function standaloneBoot() {
  const remembered = await idbGet("localZip");
  if (remembered && remembered.bytes) {
    try {
      state.sourceLabel = remembered.label || "remembered .zip";
      await useBytes(remembered.bytes, { label: remembered.label, key: remembered.key, remember: false });
      return;
    } catch (e) {}
  }
  const savedUrl = rememberedUrl();
  if (savedUrl) {
    try {
      await useUrl(savedUrl, {});
      return;
    } catch (e) {
      showError(e, savedUrl);
      return;
    }
  }
  setMode("start");
}

function boot() {
  wireEvents();
  wireGristRelay();
  layout();
  setMode("start");
  const api = initGrist();
  let settled = false;
  const goStandalone = () => {
    if (settled || state.connected) return;
    settled = true;
    state.standalone = true;
    installGristStub();
    updatePill();
    standaloneBoot();
  };
  if (!api) goStandalone();
  else setTimeout(goStandalone, 2500);
}

// Debug hook (the same idea as `window.__metamorph__` for uploaded pages): handy console/testing
// access to the app's internals. Nothing in the widget depends on it.
window.__metamorphApp = {
  state, els,
  embedSite, clearEmbed, applyOptions, refreshSource, currentIntent,
  openPanel, closePanel, setChrome, flashChrome, loadDemo, useBytes, useFile, useUrl, packBundle,
};

boot();
