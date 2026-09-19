export const demoFiles = {
  "index.html": `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Metamorph demo site</title>
<link rel="stylesheet" href="styles.css">
<link rel="icon" href="logo.svg">
</head>
<body>
<div class="wrap">
  <img class="logo" src="logo.svg" alt="logo" width="88" height="88">
  <h1>I am a website that came out of a zip file</h1>
  <p class="lead">This whole page — its stylesheet, its module graph, its JSON data, and the page you get
  by clicking <a href="about.html">about</a> — was unpacked from a single <code>.zip</code> in your browser.
  Nothing was uploaded anywhere.</p>
  <div class="card">
    <h2>Live data from <code>data/items.json</code></h2>
    <ul id="list"></ul>
  </div>
  <div class="card">
    <h2>Things this page is quietly proving</h2>
    <ul class="plain">
      <li><code>&lt;link rel=stylesheet&gt;</code> resolved through the archive</li>
      <li><code>&lt;img&gt;</code> and favicon loaded from archive bytes</li>
      <li>an ES module graph (<code>app.js</code> &rarr; <code>lib/util.js</code>)</li>
      <li>a dynamic <code>import()</code> that only happens when you click</li>
      <li><code>fetch()</code> of a relative path, served from memory</li>
      <li>client-side navigation to a second page</li>
    </ul>
    <button id="shuffle">Load the bonus module</button>
    <p id="clock" class="clock"></p>
  </div>
</div>
<script type="module" src="app.js"></script>
</body>
</html>
`,
  "about.html": `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>About this demo</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<div class="wrap">
  <img class="logo" src="logo.svg" alt="logo" width="64" height="64">
  <h1>Page two</h1>
  <p class="lead">Navigate freely — every page in the archive is turned into a blob URL as you reach it,
  so relative links keep working without a server.</p>
  <p><a href="index.html">&larr; back to the first page</a></p>
</div>
</body>
</html>
`,
  "styles.css": `@import url("theme.css");
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
  background: radial-gradient(120% 120% at 10% 0%, #2b1b52, #150d2b 55%, #0c0818);
  color: #f3eeff;
  min-height: 100vh;
}
.wrap { max-width: 720px; margin: 0 auto; padding: 40px 22px 64px; }
.logo { filter: drop-shadow(0 8px 24px rgba(160, 110, 255, 0.55)); }
h1 { font-size: 30px; line-height: 1.2; margin: 14px 0 8px; }
h2 { font-size: 16px; letter-spacing: 0.02em; text-transform: uppercase; color: #c9b6ff; margin: 0 0 10px; }
.lead { color: #cfc4ee; line-height: 1.6; }
.card {
  background: rgba(255, 255, 255, 0.055);
  border: 1px solid rgba(190, 160, 255, 0.22);
  border-radius: 14px;
  padding: 18px 20px;
  margin: 18px 0;
}
ul { margin: 0; padding-left: 20px; line-height: 1.8; }
ul.plain { list-style: none; padding-left: 0; }
ul.plain li::before { content: "✓ "; color: #8ef0c0; }
code { font-family: "SFMono-Regular", Consolas, monospace; background: rgba(255,255,255,0.09); padding: 1px 5px; border-radius: 5px; font-size: 0.92em; }
a { color: #b7a1ff; }
button {
  margin-top: 14px; padding: 10px 16px; border-radius: 10px; border: 0; cursor: pointer;
  background: linear-gradient(135deg, #8b5cf6, #ec4899); color: white; font-size: 14px; font-weight: 600;
}
button:hover { filter: brightness(1.1); }
.clock { color: #9c8fc4; font-size: 13px; margin: 14px 0 0; }
`,
  "theme.css": `:root { --accent: #a78bfa; }
h1 { text-shadow: 0 0 30px rgba(167, 139, 250, 0.35); }
`,
  "app.js": `import { titleize, pick } from "./lib/util.js";

const list = document.getElementById("list");
const clock = document.getElementById("clock");

const response = await fetch("data/items.json");
const items = await response.json();

function paint() {
  list.innerHTML = items.map(item => "<li>" + titleize(item) + "</li>").join("");
}
paint();

document.getElementById("shuffle").addEventListener("click", async () => {
  const bonus = await import("./lib/bonus.js");
  bonus.celebrate(items);
  paint();
});

setInterval(() => {
  clock.textContent = "page clock: " + pick(["tick", "tock"]) + " — " + new Date().toLocaleTimeString();
}, 1000);
`,
  "lib/util.js": `export function titleize(text) {
  return String(text).replace(/\\b\\w/g, c => c.toUpperCase());
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}
`,
  "lib/bonus.js": `export function celebrate(items) {
  const hue = Math.floor(Math.random() * 360);
  document.body.style.transition = "background 700ms ease";
  document.body.style.background =
    "radial-gradient(120% 120% at 10% 0%, hsl(" + hue + " 60% 22%), #12102a 60%, #09070f)";
  console.log("bonus module loaded, " + items.length + " items");
}
`,
  "data/items.json": JSON.stringify([
    "written as plain files",
    "zipped up",
    "dropped onto the widget",
    "unpacked in your browser",
    "resolved to blob urls",
  ], null, 2) + "\n",
  "logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#ec4899"/>
    </linearGradient>
  </defs>
  <path fill="url(#g)" d="M50 6c14 0 20 10 30 16s14 18 8 32-20 20-38 22-32-8-36-22 4-26 12-34S36 6 50 6z"/>
  <circle cx="40" cy="46" r="7" fill="#160f2c"/>
  <circle cx="64" cy="46" r="7" fill="#160f2c"/>
  <circle cx="42" cy="44" r="2.4" fill="#fff"/>
  <circle cx="66" cy="44" r="2.4" fill="#fff"/>
</svg>
`,
};

export function buildDemoZip() {
  const fflate = globalThis.fflate;
  const entries = {};
  for (const [path, text] of Object.entries(demoFiles)) entries[path] = fflate.strToU8(text);
  return fflate.zipSync(entries, { level: 6 });
}
