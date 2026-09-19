# Metamorph

A tiny, dependency-free **Grist custom widget** that *becomes* any website you give it.

Drop a `.zip` containing a complete website (a Perchance export, a static site, a hand-rolled
`index.html` + assets — anything) onto the widget and it unpacks that archive **in the browser**
and serves it. Nothing is uploaded anywhere. The widget is a static site, so it hosts happily on
**GitHub Pages**.

Then, if it's inside a Grist document, it can take the next step and hide itself: **store the site
in the document** and the archive becomes part of the `.grist` file — the widget opens straight into
your site, for you and for anyone you share the document with. See *Storing the site inside the
document* below.

> This folder (`src/`) is the whole widget. Its contents are what gets deployed.

---

## Using it in Grist

1. Add a widget → **Custom** → *Custom widget URL* → paste your GitHub Pages URL.
2. In the widget's column mapping, map **Website ZIP** to a column of type `Attachment`.
   Optionally map **ZIP URL** (Text) to a column holding a link to a `.zip`, and
   **Start page** (Text) to override the page that opens first.
3. Drop a `.zip` into a cell. The widget follows the selected row.

A `.zip`, a bare `.html` file, and a link to either all work — the same code path handles all three.

The widget asks for **full document access** (`requiredAccess: "full"`), which is what Grist needs
in order to hand out a *read-only access token* for attachment downloads. If you'd rather not grant
that, use the **ZIP URL** column or drop the file in by hand — both work without any access token.

### Storing the site inside the document

A widget can carry its own configuration data, and Metamorph uses that: the ☰ panel →
*This document* → **Store this site in the document** writes the whole archive into the widget's
options (`grist.setOption("metamorph", …)`), so the site is hosted *by the document itself* — the
same trick Grist's own custom-widget builder uses for its code.

The consequences are exactly what you'd want:

- The widget then shows **that** site every time the document is opened, with no attachment, no
  URL, and no local file — a collaborator who has never seen your `.zip` sees your site.
- Refreshing, closing, or sharing the document changes nothing: the site is part of it.
- Metamorph's own bar gets out of the way (see below), so what you see is just the site.

Two things to know:

- Grist keeps widget-option changes as a *pending* modification. After storing a site, press
  **Save** in Grist — the button that appears next to the section's sort/filter icon — to write it
  into the document. `(modified)` / `(customized)` appears under **Custom options** in that menu.
  Reverting there removes the stored site again.
- The archive is stored as base64 inside the document, so keep it small: Metamorph warns above
  **1.5 MB** and refuses above **6 MB**. For big sites, use an Attachment column or a URL instead —
  the widget stays a few kilobytes and the payload stays out of the document.

Metamorph keeps all of its own settings under a single `metamorph` key, so a Grist-aware site you
upload can use `grist.setOption("something", …)` for itself without stepping on our config. (It
also gets the widget's live Grist API — see *A Grist-aware site* below.)

### Widget options

Open the ☰ panel → *Open Widget configuration* (`onEditOptions`). Options are stored per widget:

| Option | Meaning |
| --- | --- |
| `zipUrl` | A link to a `.zip` to load when nothing else supplies one |
| `entry` | Which HTML file inside the archive to open first |
| `size` | Virtual window size: `auto`, `1280x800`, `1024x768`, `768x1024`, `390x844` |
| `zoom` | Scale factor between `0.25` and `2` |
| `priority` | `embedded` (default) = the site stored in the document wins, `row` = a mapped column wins |
| `site` | The archive stored in the document: `{name, entry, savedAt, z, d}` (`d` = base64, `z` = deflated?) |

Sources are tried in this order (first match wins): the stored site *or* the mapped column (by
`priority`), then the `zipUrl` option, then the stored site. Outside Grist the last URL you loaded is
remembered in `localStorage` (clear it with *Forget the remembered link*), and the last **file** you
dropped is kept in IndexedDB. That makes the standalone (GitHub Pages) case behave like a real
browser that remembers your site.

### The bar gets out of the way

Once a site is loaded, Metamorph's toolbar hides itself after a couple of seconds — the widget *is*
the site, so there is nothing to frame. Bring it back with:

- **Ctrl/Cmd + Shift + M** (works even while the site has focus),
- the small faint dot in the **top-right corner**,
- Grist's own **Open configuration** entry in the section menu,
- or `Esc` to hide it again.

### A Grist-aware site

If the site you upload talks to Grist, it gets the real thing: Metamorph rewrites the site's
`<script src="…/grist-plugin-api.js">` into a tiny bridge that hands the page the widget's own live
API instance (`window.__metamorphGrist === "shared"`), so `grist.onRecord`, `grist.docApi`, …, — and
the widget's own `requiredAccess: "full"` grant — all work unchanged. Pages that ship a *bundled*
copy of the plugin API instead are relayed message-by-message between the page and Grist
(`wireGristRelay`). Outside Grist, an uploaded page gets a quiet stub API that resolves to empty
data (`window.grist.__metamorphStub === true`) instead of hanging on a connection that can't happen.


## How it works

```
     .zip bytes (a Grist attachment, a URL, a dropped file, or the site stored in the document)
                                        │
                        fflate.unzipSync │  decodeZip()
                                        ▼
                            Map<path, Uint8Array>          ← the virtual filesystem
                                        │
              Site.rewriteHtml / rewriteCss / rewriteJs  ← every local reference is
                                        │                   replaced with a blob: URL
                                        ▼
   page.html  → blob:…/…  ──▶  <iframe src="blob:…">   (same-origin, no sandbox)
                                        │
                    same-origin, so the page also reads window.parent.grist
```

`src/metamorph.js` is the whole engine; it only knows about Grist through one small bridge:

- **`decodeZip`** — unzips, normalises path separators, drops `__MACOSX/`, `.DS_Store`, and
  transparently unwraps a single top-level folder (`site/index.html` → `index.html`).
- **`Site`** — a memoising, cycle-tolerant *transformer*. For each file it produces a `blob:` URL
  and caches it, so a page's stylesheet, module graph, images and favicons are all rewritten to
  point at their own blob URLs. Handled:
  - HTML: `src`/`href` on every relevant element, `srcset` (including `w`/`x` descriptors),
    `poster`, `<use href>` / `xlink:href` in inline SVG, inline `<style>` blocks and `style=""`
    attributes, `<base>` (removed — the widget is the base), CSP `<meta>` (removed — blob URLs
    would be blocked by a strict policy), `<meta charset>` (ensured), and **`<script type="importmap">`**
    which is rewritten so bare specifiers resolve inside the archive too.
  - CSS: `@import` and `url(…)`, recursively.
  - JS: `import … from "…"`, `export … from "…"`, bare `import "…"`, dynamic `import("…")`,
    `new Worker("…")` / `new SharedWorker("…")`, `importScripts("…")`, and
    `new URL("…", import.meta.url)`.
- **The shim** — `installShim()` is stringified and injected as the *first* script of every
  unpacked page. It re-implements the server that isn't there:
  - `fetch` and `XMLHttpRequest` are answered from the in-memory files,
  - element `src`/`href`/`poster`/`data` setters are patched so *runtime*-created elements resolve
    inside the archive too,
  - `Worker`/`SharedWorker` constructors are wrapped,
  - anchor clicks are intercepted, so client-side navigation between pages works even when the
    link could not be pre-rewritten (cycles are left as raw hrefs and resolved on click),
  - `localStorage`/`sessionStorage` are emulated in memory when the browser blocks them,
  - **Ctrl/Cmd+Shift+M** asks the widget to show its bar,
  - uncaught errors and missing-file references are reported back to the widget's diagnostics panel.
- **The Grist bridge** — `rewriteHtml` spots `<script src="…/grist-plugin-api.js">` and swaps it
  for an inline bootstrap (`gristBridge`) that, when the widget is attached to a document, points
  the page at the widget's own `grist` object instead of loading a second, disconnected copy.

### What this costs

Blob URLs inherit the widget's origin, so the unpacked site runs **same-origin with the widget**.
That is what makes the shim possible (no server, no service worker, works on GitHub Pages), and it
means an uploaded site is trusted code: it can read the widget's own storage. Treat a `.zip` you
load the same way you'd treat a program you install.

Two things genuinely cannot work: real service workers, and features that need a live server
(server-side rendering, WebSocket backends, cookies for a "same" domain). Everything static —
including a Perchance export — works.

## Files

| File | Role |
| --- | --- |
| `index.html` | The widget document: bar, stage, reveal hotspot, start screen, busy/error states, panel. |
| `app.js` | UI + state machine + Grist glue (`ready`/`onOptions`/`onRecord`, attachments, widget-option storage, the message relay, the offline stub, IDB/localStorage fallbacks). |
| `metamorph.js` | The engine described above. Grist-agnostic; usable on its own. |
| `metamorph.css` | Styling, themed through Grist's CSS variables with a dark-mode fallback. |
| `demo-site.js` | The built-in demo site (a real site, built in memory and zipped on the fly) used by *Try the demo*. |
| `vendor/fflate.min.js` | [fflate](https://github.com/101arrowz/fflate) 0.8.2 UMD, vendored so unzipping needs no network. |

## Testing

Open the widget without Grist and press **Try the demo**. The demo site deliberately exercises the
hard parts: a stylesheet with `@import`, an SVG logo, a module graph (`app.js` → `lib/util.js`),
a dynamic `import()` behind a button, a `fetch()` of `data/items.json`, and a second page you
navigate to and back from.

To exercise the Grist paths without a real document, load the page with a fake parent API installed
before the widget's scripts (`page_refresh`'s `preambleJs` in the editor, or a `<script>` above
`app.js`): give it `ready`/`onOptions`/`onRecord`/`setOption`/`mapColumnNames`/`docApi.getAccessToken`,
define it non-writable (`Object.defineProperty(window, "grist", {value: api, writable: false})`) so
the CDN build can't replace it, then drive it from the console:

```js
const A = window.__metamorphApp;                        // debug hook, no behaviour depends on it
A.loadDemo();                                           // a real archive to store
await A.embedSite();                                    // → window.grist.setOption("metamorph", …)
__fake.onOptionsCb({metamorph: {site: {v: 1, z: 0, d: "…", name: "site.zip"}}}, {accessLevel: "full"});
A.embedSite(); A.clearEmbed(); A.currentIntent();       // round-trip, priority and source ordering
```

`__metamorphApp` exposes `state`, `els`, `embedSite`, `clearEmbed`, `applyOptions`, `refreshSource`,
`currentIntent`, `openPanel`/`closePanel`/`setChrome`, `loadDemo`, `useBytes`/`useFile`/`useUrl` and
`packBundle` — enough to drive any of the above from a console.
