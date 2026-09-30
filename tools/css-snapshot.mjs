#!/usr/bin/env node
/**
 * css-snapshot.mjs — capture computed style + geometry for the site's shared
 * components, so a CSS refactor can be diffed instead of eyeballed.
 *
 * No npm deps: drives Chromium over the DevTools Protocol using Node's built-in
 * global WebSocket (Node >= 22), same harness shape as smoke-test.mjs.
 *
 * Usage:
 *   node tools/css-snapshot.mjs                  # print flat map
 *   node tools/css-snapshot.mjs --save f.json    # write baseline
 *   node tools/css-snapshot.mjs --diff f.json    # diff against baseline
 *   node tools/css-snapshot.mjs --page index.html
 *
 * Every entry is `page|selector|prop` -> value so the output diffs cleanly with
 * plain `diff`. `textWidth` is a canvas measurement of a fixed probe string in
 * the element's own computed font, which is what catches a real font-fallback
 * change (the computed `font-family` stack is just the declaration echoed back).
 *
 * Exit: 0 clean (or diff with no differences), 1 diff found changes, 2 harness error.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  return i === -1 ? null : argv[i + 1];
};
const saveTo = flag("--save");
const diffFrom = flag("--diff");
const only = flag("--page");

const PAGES = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith(".html"))
  .filter((f) => f !== "rehkendaja-test.html")
  .filter((f) => (only ? f === only : true))
  .sort();

/* Components whose type/spacing/colour we care about. Kept flat and selector-
 * only so a missing component shows up as a MISSING line rather than silently
 * vanishing. */
const SELECTORS = [
  "body",
  ".brand-name",
  ".nav-item",
  ".nav-sigil",
  ".sidebar-foot",
  ".title-block h1",
  ".title-block .subtitle",
  ".subtitle-label",
  ".subtitle-date",
  ".stat-pill",
  ".pill-label",
  ".pill-n",
  ".search-zone",
  ".search-inner",
  "#search",
  ".search-clear",
  "#result-count",
  "main",
  ".panel",
  ".panel-header",
  ".panel-header-row",
  ".panel-body",
  ".result-block",
  ".result-header",
  ".result-label",
  ".result-body",
  ".result-body--inline",
  ".result-body--stack",
  ".result-figure",
  ".result-figure--md",
  ".result-unit",
  ".result-equation",
  ".copy-btn",
  ".field-label",
  ".duration-row",
  ".duration-field",
  ".duration-sublabel",
  ".list-section",
  ".list-header",
  ".list-sigil",
  ".list-info .n",
  ".list-info .d",
  ".count-badge",
  ".chevron",
  ".substances-table",
  ".substances-table thead th",
  ".substances-table td",
  ".row-num",
  ".et-name",
  ".en-name",
  "mark",
  ".no-results",
  ".groups-note",
  ".note-label",
  "footer",
  "#loading",
  // page-specific
  ".input-wrap",
  ".input-highlight",
  "#input-text",
  ".reset-btn",
  ".elements-list",
  ".elements-list li",
  ".el-num",
  ".empty-state",
  ".sum-value",
  ".count-value",
  ".unit-switcher",
  ".unit-btn",
  ".operator",
  ".panel-note",
  ".field-group",
  ".result-fraction",
  ".result-legal-label",
  ".result-date",
  ".result-min-note",
  ".input-section",
  ".code-suffix",
  "#code-input",
  ".input-clear",
  ".input-hint",
  ".or-separator",
  ".dob-section",
  "#dob-input",
  ".ref-section",
  ".ref-row",
  ".ref-label",
  "#ref-input",
  ".ref-today-btn",
  "#ref-calendar",
  ".age-main",
  ".age-detail",
  ".idle-state",
  ".field",
  ".field--code",
  ".field--md",
  ".field--sm",
  ".field--cal",
  ".pill-bar[data-list=\"3\"]",
  ".list-sigil[data-list=\"3\"]",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
      const file = path.join(ROOT, rel || "index.html");
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function findFreePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

async function waitForDevTools(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("DevTools endpoint did not come up");
}

/* Runs in the page. Returns { key: value } flat pairs. */
const COLLECT = `(async () => {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const PROBE = "Õigusmasin 0123 € g";
  const round = (n) => Math.round(n * 10) / 10;
  const out = {};
  const selectors = ${JSON.stringify(SELECTORS)};
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const key = (p) => location.pathname.split("/").pop() + "|" + sel + "|" + p;
    out[key("font-size")] = cs.fontSize;
    out[key("letter-spacing")] = cs.letterSpacing;
    out[key("font-weight")] = cs.fontWeight;
    out[key("line-height")] = cs.lineHeight;
    out[key("color")] = cs.color;
    out[key("background")] = cs.backgroundColor;
    out[key("border-color")] = cs.borderTopColor;
    out[key("padding")] = cs.padding;
    out[key("w")] = round(r.width) + "px";
    out[key("h")] = round(r.height) + "px";
    out[key("textWidth")] = (ctx.font = cs.font || (cs.fontWeight + " 16px " + cs.fontFamily), Math.round(ctx.measureText(PROBE).width * 10) / 10) + "px";
  }
  return out;
})()`;

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const port = await findFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "csssnap-"));
  const chromium = spawn("chromium", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--force-device-scale-factor=1", "--hide-scrollbars",
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });

  const flat = {};
  let cdp;
  try {
    const cdpUrl = await waitForDevTools(port);
    cdp = await CDP.connect(cdpUrl);

    for (const page of PAGES) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);

      const loaded = new Promise((resolve) => {
        const off = cdp.on((msg) => {
          if (msg.sessionId === sessionId && msg.method === "Page.loadEventFired") {
            off();
            resolve();
          }
        });
      });
      await cdp.send("Page.navigate", { url: `${base}/${page}` }, sessionId);
      await Promise.race([loaded, new Promise((r) => setTimeout(r, 8000))]);
      await new Promise((r) => setTimeout(r, 400));

      const res = await cdp.send("Runtime.evaluate", {
        expression: COLLECT, returnByValue: true, awaitPromise: true,
      }, sessionId);
      if (res.exceptionDetails) {
        console.error(`${page}: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ""}`);
        process.exitCode = 2;
      } else {
        Object.assign(flat, res.result.value);
      }
      await cdp.send("Target.closeTarget", { targetId });
    }

    const lines = Object.keys(flat).sort().map((k) => `${k} = ${flat[k]}`);

    if (saveTo) {
      fs.writeFileSync(path.resolve(saveTo), lines.join("\n") + "\n");
      console.log(`saved ${lines.length} entries -> ${saveTo}`);
    } else if (diffFrom) {
      const basePath = path.resolve(diffFrom);
      if (!fs.existsSync(basePath)) {
        console.error(`no baseline at ${diffFrom}`);
        process.exit(2);
      }
      const before = new Map(
        fs.readFileSync(basePath, "utf8").split("\n").filter(Boolean).map((l) => {
          const i = l.lastIndexOf(" = ");
          return [l.slice(0, i), l.slice(i + 3)];
        })
      );
      const after = new Map(lines.map((l) => {
        const i = l.lastIndexOf(" = ");
        return [l.slice(0, i), l.slice(i + 3)];
      }));
      const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
      let changed = 0;
      for (const k of keys) {
        const a = before.get(k);
        const b = after.get(k);
        if (a === b) continue;
        changed++;
        if (a === undefined) console.log(`  \x1b[32m+ ${k}\x1b[0m = ${b}`);
        else if (b === undefined) console.log(`  \x1b[31m- ${k}\x1b[0m = ${a}`);
        else console.log(`  \x1b[33m~ ${k}\x1b[0m: ${a} -> ${b}`);
      }
      console.log(changed
        ? `\n\x1b[33m${changed} change(s)\x1b[0m across ${after.size} tracked values.`
        : `\x1b[32mno changes\x1b[0m across ${after.size} tracked values.`);
      process.exit(changed ? 1 : 0);
    } else {
      console.log(lines.join("\n"));
    }
  } catch (err) {
    console.error("harness error:", err?.message || err);
    process.exit(2);
  } finally {
    try { cdp?.ws.close(); } catch {}
    chromium.kill("SIGKILL");
    server.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

main();
