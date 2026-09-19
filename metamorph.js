const MIMES = {
  html: "text/html", htm: "text/html", xhtml: "application/xhtml+xml",
  css: "text/css", js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
  json: "application/json", map: "application/json", webmanifest: "application/manifest+json",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime",
  txt: "text/plain;charset=utf-8", md: "text/markdown;charset=utf-8", xml: "application/xml",
  csv: "text/csv;charset=utf-8", tsv: "text/tab-separated-values;charset=utf-8",
  wasm: "application/wasm", glb: "model/gltf-binary", gltf: "model/gltf+json",
  pdf: "application/pdf", zip: "application/zip", bin: "application/octet-stream",
};

const HTML_EXTS = new Set(["html", "htm", "xhtml"]);
const JS_EXTS = new Set(["js", "mjs", "cjs"]);
const CSS_EXTS = new Set(["css"]);
const ASSET_RELS = new Set([
  "stylesheet", "icon", "shortcut", "apple-touch-icon", "mask-icon", "manifest",
  "preload", "prefetch", "modulepreload", "prerender",
]);
const INLINE_SCRIPT_TYPES = new Set([
  "", "module", "text/javascript", "application/javascript", "application/ecmascript", "text/ecmascript",
]);

const GRIST_API_RE = /grist-plugin-api(\.min)?\.js/i;

export function extOf(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ""));
  return m ? m[1].toLowerCase() : "";
}

export function mimeOf(path) {
  return MIMES[extOf(path)] || "application/octet-stream";
}

export function typeForText(path) {
  const m = mimeOf(path);
  return /charset=/.test(m) || /^text\//.test(m) || /(json|javascript|xml|svg)/.test(m)
    ? m + (/charset=/.test(m) ? "" : ";charset=utf-8")
    : m;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

function stripDotSegments(path) {
  const out = [];
  for (const part of String(path).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}

function resolveRelative(base, rel) {
  if (rel.startsWith("/")) return stripDotSegments(rel);
  const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
  return stripDotSegments(dir + "/" + rel);
}

function commonRoot(files) {
  let prefix = null;
  for (const key of files.keys()) {
    const i = key.indexOf("/");
    if (i < 0) return "";
    const seg = key.slice(0, i);
    if (prefix === null) prefix = seg;
    else if (prefix !== seg) return "";
  }
  return prefix || "";
}

function looksLikeHtml(bytes) {
  if (!bytes || bytes.length < 16) return false;
  let head = "";
  for (let i = 0; i < Math.min(bytes.length, 512); i++) head += String.fromCharCode(bytes[i]);
  return /^\s*(<!doctype\s+html|<!--|<html|<head|<body|<svg|<meta|<script|<style|<div|<h1|<p[\s>])/i.test(head);
}

export function decodeZip(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let raw = null;
  let error = null;
  try {
    raw = globalThis.fflate.unzipSync(bytes);
  } catch (e) {
    error = e;
  }
  const files = new Map();
  if (!raw) {
    if (looksLikeHtml(bytes)) {
      files.set("index.html", bytes);
      return files;
    }
    throw new Error("This file isn't a readable .zip archive" + (error ? " (" + error.message + ")" : ""));
  }
  for (const name of Object.keys(raw)) {
    let n = name.replace(/\\/g, "/");
    if (n.endsWith("/")) continue;
    if (n.startsWith("__MACOSX/") || n.endsWith(".DS_Store") || n === "Thumbs.db") continue;
    n = stripDotSegments(n);
    if (!n) continue;
    files.set(n, raw[name]);
  }
  if (!files.size) throw new Error("The .zip archive is empty");
  const root = commonRoot(files);
  if (root) {
    const stripped = new Map();
    for (const [k, v] of files) stripped.set(k.slice(root.length + 1), v);
    return stripped;
  }
  return files;
}

export function pickEntry(files, preferred) {
  const htmls = [...files.keys()]
    .filter(p => HTML_EXTS.has(extOf(p)))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  if (preferred) {
    const want = stripDotSegments(String(preferred).replace(/^\/+/, ""));
    if (files.has(want)) return want;
    const tail = htmls.find(h => h === want || h.endsWith("/" + want));
    if (tail) return tail;
  }
  return htmls.find(h => h.toLowerCase() === "index.html")
    || htmls.find(h => h.toLowerCase().endsWith("/index.html"))
    || htmls.find(h => h.toLowerCase().startsWith("index."))
    || htmls[0]
    || null;
}

function installShim(cfg) {
  if (window.__metamorphShimInstalled) return;
  window.__metamorphShimInstalled = true;

  var api = null;
  try {
    if (window.parent && window.parent !== window) api = window.parent.__metamorph__ || null;
  } catch (e) { api = null; }

  var entryBase = (cfg && cfg.base) || "index.html";
  var warned = false;

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function report(msg) {
    if (!api) return;
    safe(function () { api.flag(msg); });
  }

  function currentBase() {
    if (!api) return entryBase;
    var p = safe(function () { return api.selfPath(location.href); }, null);
    return p || entryBase;
  }

  function isSpecial(spec) {
    return /^\s*(data:|blob:|mailto:|tel:|about:|javascript:|#)/i.test(spec);
  }

  function mapUrl(spec) {
    if (typeof spec !== "string" || !spec || !api || isSpecial(spec)) return null;
    var out = safe(function () { return api.url(spec, currentBase()); }, null);
    if (!out || out === spec) return null;
    return out;
  }

  function mapPath(spec) {
    if (typeof spec !== "string" || !spec || !api || isSpecial(spec)) return null;
    return safe(function () { return api.path(spec, currentBase()); }, null);
  }

  function patchSetter(proto, prop) {
    if (!proto) return;
    var desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || typeof desc.set !== "function" || desc.set.__mmPatched) return;
    var origSet = desc.set;
    var setter = function (value) {
      var mapped = mapUrl(value);
      return origSet.call(this, mapped === null ? value : mapped);
    };
    setter.__mmPatched = true;
    var replacement = { configurable: true, enumerable: desc.enumerable, set: setter };
    if (typeof desc.get === "function") replacement.get = desc.get;
    Object.defineProperty(proto, prop, replacement);
  }

  if (window.HTMLImageElement) patchSetter(window.HTMLImageElement.prototype, "src");
  if (window.HTMLScriptElement) patchSetter(window.HTMLScriptElement.prototype, "src");
  if (window.HTMLLinkElement) patchSetter(window.HTMLLinkElement.prototype, "href");
  if (window.HTMLAnchorElement) patchSetter(window.HTMLAnchorElement.prototype, "href");
  if (window.HTMLSourceElement) patchSetter(window.HTMLSourceElement.prototype, "src");
  if (window.HTMLTrackElement) patchSetter(window.HTMLTrackElement.prototype, "src");
  if (window.HTMLMediaElement) {
    patchSetter(window.HTMLMediaElement.prototype, "src");
    patchSetter(window.HTMLMediaElement.prototype, "poster");
  }
  if (window.HTMLEmbedElement) patchSetter(window.HTMLEmbedElement.prototype, "src");
  if (window.HTMLObjectElement) patchSetter(window.HTMLObjectElement.prototype, "data");
  if (window.HTMLIFrameElement) patchSetter(window.HTMLIFrameElement.prototype, "src");

  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var spec = null;
      if (typeof input === "string") spec = input;
      else if (input instanceof URL) spec = input.href;
      else if (input && typeof input.url === "string") spec = input.url;
      if (spec) {
        var path = mapPath(spec);
        if (path && api) {
          var bytes = safe(function () { return api.bytes(path); }, null);
          if (bytes) {
            var body = new Uint8Array(bytes);
            var headers = { "Content-Type": api.mime(path) };
            return Promise.resolve(new Response(body, { status: 200, statusText: "OK", headers: headers }));
          }
        }
      }
      return origFetch.apply(this, arguments);
    };
  }

  var XHR = window.XMLHttpRequest;
  if (XHR) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__mmPath = null;
      var path = mapPath(typeof url === "string" ? url : url && url.href);
      if (path) {
        this.__mmPath = path;
        this.__mmUrl = String(url);
        return;
      }
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var xhr = this;
      if (!xhr.__mmPath || !api) return origSend.apply(this, arguments);
      var path = xhr.__mmPath;
      var bytes = safe(function () { return api.bytes(path); }, null);
      var mime = api.mime(path);
      setTimeout(function () {
        var text = bytes ? safe(function () { return new TextDecoder().decode(bytes); }, "") : "";
        var type = safe(function () { return xhr.responseType; }, "");
        var payload = "";
        if (type === "" || type === "text") payload = text;
        else if (type === "json") payload = safe(function () { return JSON.parse(text); }, null);
        else if (type === "blob") payload = bytes ? new Blob([new Uint8Array(bytes)], { type: mime }) : null;
        else if (type === "arraybuffer") payload = bytes ? new Uint8Array(bytes).buffer : null;
        safe(function () {
          Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
          Object.defineProperty(xhr, "status", { value: bytes ? 200 : 404, configurable: true });
          Object.defineProperty(xhr, "statusText", { value: bytes ? "OK" : "Not Found", configurable: true });
          Object.defineProperty(xhr, "responseURL", { value: xhr.__mmUrl, configurable: true });
          Object.defineProperty(xhr, "response", { value: payload, configurable: true });
          Object.defineProperty(xhr, "responseText", {
            value: type === "" || type === "text" ? payload : "", configurable: true,
          });
          Object.defineProperty(xhr, "responseXML", { value: null, configurable: true });
          xhr.getResponseHeader = function (name) {
            return /content-type/i.test(name) ? mime : null;
          };
          xhr.getAllResponseHeaders = function () {
            return "content-type: " + mime + "\r\ncontent-length: " + (bytes ? bytes.length : 0) + "\r\n";
          };
        });
        xhr.dispatchEvent(new Event("readystatechange"));
        xhr.dispatchEvent(new ProgressEvent("load"));
        xhr.dispatchEvent(new ProgressEvent("loadend"));
      }, 0);
    };
  }

  function wrapWorker(Orig) {
    if (typeof Orig !== "function") return Orig;
    return new Proxy(Orig, {
      construct: function (Target, args) {
        var list = Array.prototype.slice.call(args);
        var mapped = mapUrl(list[0]);
        if (mapped !== null) list[0] = mapped;
        return new (Function.prototype.bind.apply(Target, [null].concat(list)))();
      },
    });
  }
  if (window.Worker) {
    try { window.Worker = wrapWorker(window.Worker); } catch (e) {}
  }
  if (window.SharedWorker) {
    try { window.SharedWorker = wrapWorker(window.SharedWorker); } catch (e) {}
  }

  function guardStorage(name) {
    var ok = true;
    try { void window[name].length; } catch (e) { ok = false; }
    if (ok) return;
    var mem = new Map();
    var fake = {
      getItem: function (k) { k = String(k); return mem.has(k) ? mem.get(k) : null; },
      setItem: function (k, v) { mem.set(String(k), String(v)); },
      removeItem: function (k) { mem.delete(String(k)); },
      clear: function () { mem.clear(); },
      key: function (i) { var keys = Array.from(mem.keys()); return i < keys.length ? keys[i] : null; },
    };
    Object.defineProperty(fake, "length", { get: function () { return mem.size; } });
    safe(function () { Object.defineProperty(window, name, { value: fake, configurable: true }); });
    report("storage was blocked here; " + name + " is being emulated in memory");
  }
  guardStorage("localStorage");
  guardStorage("sessionStorage");

  document.addEventListener("keydown", function (ev) {
    if (!(ev.ctrlKey || ev.metaKey) || !ev.shiftKey) return;
    if (ev.key !== "M" && ev.key !== "m") return;
    ev.preventDefault();
    if (api && typeof api.chrome === "function") safe(function () { api.chrome(); });
  }, true);

  document.addEventListener("click", function (ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var node = ev.target;
    var link = node && node.closest ? node.closest("a[href]") : null;
    if (!link) return;
    if (link.target && link.target !== "_self") return;
    var mapped = mapUrl(link.getAttribute("href"));
    if (mapped === null) return;
    ev.preventDefault();
    location.href = mapped;
  }, true);

  window.addEventListener("error", function (ev) {
    report("page error: " + (ev && ev.message ? ev.message : "unknown"));
  });
  window.addEventListener("unhandledrejection", function (ev) {
    var reason = ev && ev.reason;
    report("unhandled rejection: " + ((reason && reason.message) || reason || "unknown"));
  });

  if (!warned && !api) warned = true;
}

function gristBridge(origSrc) {
  var shared = false;
  try {
    var p = window.parent;
    if (p && p !== window && p.grist && p.__metamorphGristReady) {
      window.grist = p.grist;
      window.__metamorphGrist = "shared";
      shared = true;
    }
  } catch (e) {}
  if (shared) return;
  var s = document.createElement("script");
  s.src = origSrc;
  (document.head || document.documentElement).appendChild(s);
  window.__metamorphGrist = "own";
}

function rewriteSrcset(value, resolve) {
  return String(value).split(",").map(chunk => {
    const parts = chunk.trim().split(/\s+/);
    if (!parts.length || !parts[0]) return chunk;
    if (/^(data:|blob:|https?:)/i.test(parts[0])) return chunk;
    const url = resolve(parts[0]);
    if (!url) return chunk;
    parts[0] = url;
    return parts.join(" ");
  }).join(", ");
}

export class Site {
  constructor(files) {
    this.files = files;
    this.origin = location.origin && location.origin !== "null"
      ? location.origin
      : new URL(document.baseURI).origin;
    this.entry = null;
    this.created = new Set();
    this.blobToPath = new Map();
    this.urlOfPath = new Map();
    this.memoPage = new Map();
    this.memoCss = new Map();
    this.memoJs = new Map();
    this.memoSvg = new Map();
    this.stack = new Set();
    this.misses = new Map();
    this.flags = [];
    this.onChrome = null;
    this.api = {
      url: (spec, base) => this.url(spec, base),
      path: (spec, base) => {
        const r = this.resolvePath(spec, base);
        return r ? r.path : null;
      },
      bytes: (path) => this.files.get(path) || null,
      mime: (path) => mimeOf(path),
      selfPath: (href) => this.blobToPath.get(href) || null,
      miss: (path, ref) => this.noteMiss(path, ref),
      flag: (msg) => this.noteFlag(msg),
      chrome: () => {
        if (typeof this.onChrome === "function") this.onChrome();
      },
    };
  }

  install() {
    window.__metamorph__ = this.api;
    return this;
  }

  pathList() {
    return [...this.files.keys()].sort((a, b) => a.localeCompare(b));
  }

  bytesOf(path) {
    return this.files.get(path) || null;
  }

  textOf(path) {
    const bytes = this.files.get(path);
    if (!bytes) return null;
    try {
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) {
      return null;
    }
  }

  noteMiss(path, ref) {
    const key = path || "(unknown)";
    const entry = this.misses.get(key) || { count: 0, ref: ref || "" };
    entry.count++;
    this.misses.set(key, entry);
    if (this.misses.size <= 12) {
      console.warn("[metamorph] missing file:", path, ref ? "referenced by " + ref : "");
    }
  }

  noteFlag(msg) {
    if (!msg) return;
    this.flags.push(String(msg));
    if (this.flags.length > 40) this.flags.shift();
    console.warn("[metamorph]", msg);
  }

  blob(key, data, type) {
    if (this.urlOfPath.has(key)) return this.urlOfPath.get(key);
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
    this.created.add(url);
    this.urlOfPath.set(key, url);
    return url;
  }

  rawUrl(path) {
    const bytes = this.files.get(path);
    if (!bytes) return null;
    const url = this.blob("raw:" + path, bytes, mimeOf(path));
    this.blobToPath.set(url, path);
    return url;
  }

  resolvePath(spec, base) {
    if (typeof spec !== "string") return null;
    let s = spec.trim();
    if (!s) return null;
    if (/^(data:|mailto:|tel:|about:|javascript:)/i.test(s)) return null;
    if (s.startsWith("blob:")) {
      const path = this.blobToPath.get(s);
      return path ? { path, hash: "" } : null;
    }
    if (s.startsWith("#")) return null;
    let hash = "";
    const hashAt = s.indexOf("#");
    if (hashAt >= 0) {
      hash = s.slice(hashAt);
      s = s.slice(0, hashAt);
    }
    const queryAt = s.indexOf("?");
    if (queryAt >= 0) s = s.slice(0, queryAt);
    if (!s) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) {
      let parsed;
      try {
        parsed = new URL(s, this.origin + "/");
      } catch (e) {
        return null;
      }
      if (parsed.origin !== this.origin) return null;
      s = parsed.pathname;
    }
    const decoded = safeDecode(s);
    const path = decoded.startsWith("/") ? stripDotSegments(decoded) : resolveRelative(base || this.entry || "index.html", decoded);
    if (!path) return null;
    if (this.files.has(path)) return { path, hash };
    if (this.files.has(path + "/index.html")) return { path: path + "/index.html", hash };
    return null;
  }

  assetUrl(path) {
    if (!path || !this.files.has(path)) return null;
    const ext = extOf(path);
    if (HTML_EXTS.has(ext)) return this.pageUrl(path);
    if (CSS_EXTS.has(ext)) return this.cssUrl(path);
    if (JS_EXTS.has(ext)) return this.jsUrl(path);
    if (ext === "svg") return this.svgUrl(path);
    return this.rawUrl(path);
  }

  url(spec, base) {
    const resolved = this.resolvePath(spec, base);
    if (!resolved) return null;
    const url = this.assetUrl(resolved.path);
    if (!url) return null;
    return resolved.hash ? url + resolved.hash : url;
  }

  pageUrl(path) {
    if (this.memoPage.has(path)) return this.memoPage.get(path);
    if (this.stack.has("p:" + path)) return null;
    const text = this.textOf(path);
    if (text === null) return null;
    this.stack.add("p:" + path);
    let html;
    try {
      html = this.rewriteHtml(text, path);
    } catch (e) {
      this.noteFlag("could not prepare page " + path + ": " + e.message);
      html = null;
    }
    this.stack.delete("p:" + path);
    const url = html === null ? null : this.blob("page:" + path, new Blob([html], { type: "text/html;charset=utf-8" }));
    if (url) this.blobToPath.set(url, path);
    this.memoPage.set(path, url);
    return url;
  }

  cssUrl(path) {
    if (this.memoCss.has(path)) return this.memoCss.get(path);
    if (this.stack.has("c:" + path)) return null;
    const text = this.textOf(path);
    if (text === null) return null;
    this.stack.add("c:" + path);
    const out = this.rewriteCss(text, path);
    this.stack.delete("c:" + path);
    const url = this.blob("css:" + path, out, typeForText(path));
    this.memoCss.set(path, url);
    this.blobToPath.set(url, path);
    return url;
  }

  svgUrl(path) {
    if (this.memoSvg.has(path)) return this.memoSvg.get(path);
    if (this.stack.has("s:" + path)) return null;
    const text = this.textOf(path);
    if (text === null) return null;
    this.stack.add("s:" + path);
    const out = text.replace(/(href|xlink:href)\s*=\s*(['"])([^'"]+)\2/gi, (m, attr, q, spec) => {
      const url = this.url(spec, path);
      return url ? attr + "=" + q + url + q : m;
    });
    this.stack.delete("s:" + path);
    const url = this.blob("svg:" + path, out, "image/svg+xml;charset=utf-8");
    this.memoSvg.set(path, url);
    this.blobToPath.set(url, path);
    return url;
  }

  jsUrl(path) {
    if (this.memoJs.has(path)) return this.memoJs.get(path);
    if (this.stack.has("j:" + path)) {
      this.noteFlag("module cycle through " + path + " (that import could not be rewritten)");
      return null;
    }
    const text = this.textOf(path);
    if (text === null) return null;
    this.stack.add("j:" + path);
    const out = this.rewriteJs(text, path);
    this.stack.delete("j:" + path);
    const url = this.blob("js:" + path, out, typeForText(path));
    this.memoJs.set(path, url);
    this.blobToPath.set(url, path);
    return url;
  }

  rewriteJs(text, path) {
    const spec = (raw) => this.url(raw, path);
    const swap = (m, lead, q, target, tail) => {
      const url = spec(target);
      return url ? lead + JSON.stringify(url) + (tail || "") : m;
    };
    let out = text;
    out = out.replace(/\b(import|export)\b([^;'"`]*?\bfrom\s*)(['"])([^'"\n]+)\3/g,
      (m, kw, mid, q, target) => swap(m, kw + mid, q, target));
    out = out.replace(/(^|[;{}\n)\s])(import\s*)(['"])([^'"\n]+)\3/g,
      (m, lead, kw, q, target) => swap(m, lead + kw, q, target));
    out = out.replace(/(\bimport\s*\(\s*)(['"])([^'"\n]+)\2(\s*\))/g,
      (m, lead, q, target, tail) => swap(m, lead, q, target, tail));
    out = out.replace(/((?:new\s+(?:Shared)?Worker|importScripts)\s*\(\s*)(['"])([^'"\n]+)\2/g,
      (m, lead, q, target) => swap(m, lead, q, target));
    out = out.replace(/new\s+URL\s*\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g,
      (m, q, target) => swap(m, "", q, target, ""));
    out = out.replace(/\/\/#\s*sourceMappingURL=\S*\s*$/gm, "");
    return out;
  }

  rewriteCss(text, path) {
    let out = text.replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")]+)\1\s*\)?/gi, (m, q, target) => {
      const url = this.url(target, path);
      return url ? '@import url("' + url + '")' : m;
    });
    out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, target) => {
      if (/^\s*(data:|blob:|#|about:)/i.test(target)) return m;
      const url = this.url(target, path);
      return url ? 'url("' + url + '")' : m;
    });
    return out;
  }

  rewriteHtml(text, path) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const refUrl = (raw) => this.url(raw, path);

    for (const meta of doc.querySelectorAll("meta[http-equiv]")) {
      if (/content-security-policy/i.test(meta.getAttribute("http-equiv") || "")) meta.remove();
    }
    for (const base of doc.querySelectorAll("base")) base.remove();

    const PAIRS = [
      ["script", "src"], ["link", "href"], ["img", "src"], ["source", "src"], ["source", "srcset"],
      ["img", "srcset"], ["video", "src"], ["video", "poster"], ["audio", "src"], ["track", "src"],
      ["embed", "src"], ["object", "data"], ["input", "src"], ["iframe", "src"], ["a", "href"],
      ["use", "href"], ["use", "xlink:href"], ["image", "href"], ["image", "xlink:href"],
      ["form", "action"], ["area", "href"],
    ];
    for (const [tag, attr] of PAIRS) {
      for (const el of doc.querySelectorAll(tag)) {
        if (!el.hasAttribute(attr)) continue;
        if (tag === "link" && attr === "href" && !this.linkIsAsset(el)) continue;
        const raw = el.getAttribute(attr);
        if (!raw) continue;
        if (/^\s*(data:|mailto:|tel:|about:|javascript:|#)/i.test(raw)) continue;
        if ((attr === "srcset") && !/^[a-z][a-z0-9+.-]*:/i.test(raw.trim())) {
          el.setAttribute(attr, rewriteSrcset(raw, refUrl));
          continue;
        }
        const url = refUrl(raw);
        if (url) el.setAttribute(attr, url);
      }
    }

    for (const el of doc.querySelectorAll("[style]")) {
      el.setAttribute("style", this.rewriteCss(el.getAttribute("style"), path));
    }
    for (const style of doc.querySelectorAll("style")) {
      style.textContent = this.rewriteCss(style.textContent, path);
    }

    for (const script of doc.querySelectorAll("script")) {
      if (script.hasAttribute("src")) {
        const src = script.getAttribute("src") || "";
        if (GRIST_API_RE.test(src)) {
          const inline = doc.createElement("script");
          inline.textContent = "(" + gristBridge.toString() + ")(" + JSON.stringify(src) + ");";
          script.replaceWith(inline);
        }
        continue;
      }
      const type = (script.getAttribute("type") || "").toLowerCase();
      if (type === "importmap") {
        try {
          const map = JSON.parse(script.textContent);
          for (const key of Object.keys(map.imports || {})) {
            const url = refUrl(map.imports[key]);
            if (url) map.imports[key] = url;
          }
          for (const key of Object.keys(map.scopes || {})) {
            const scope = map.scopes[key];
            for (const inner of Object.keys(scope)) {
              const url = refUrl(scope[inner]);
              if (url) scope[inner] = url;
            }
          }
          script.textContent = JSON.stringify(map);
        } catch (e) {}
        continue;
      }
      if (!INLINE_SCRIPT_TYPES.has(type)) continue;
      script.textContent = this.rewriteJs(script.textContent, path);
    }

    const target = doc.head || doc.documentElement;
    if (target) {
      const shim = doc.createElement("script");
      shim.textContent = "(" + installShim.toString() + ")(" + JSON.stringify({ base: path }) + ");";
      target.insertBefore(shim, target.firstChild);
    }
    const charset = doc.querySelector("meta[charset]");
    if (!charset && doc.head) {
      const meta = doc.createElement("meta");
      meta.setAttribute("charset", "utf-8");
      doc.head.insertBefore(meta, doc.head.firstChild);
    }

    const doctype = /^\s*<!doctype\s+html/i.test(text) ? "<!DOCTYPE html>\n" : "";
    return doctype + "<html>" + doc.documentElement.innerHTML + "</html>";
  }

  linkIsAsset(el) {
    const rel = (el.getAttribute("rel") || "").toLowerCase().trim();
    if (!rel) return true;
    return rel.split(/\s+/).some(token => ASSET_RELS.has(token));
  }

  dispose() {
    if (window.__metamorph__ === this.api) window.__metamorph__ = null;
    for (const url of this.created) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }
    this.created.clear();
  }
}
