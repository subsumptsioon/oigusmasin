#!/usr/bin/env node
/**
 * smoke-test.mjs — load every page in headless Chromium and report JS errors.
 *
 * No npm deps: drives Chromium over the DevTools Protocol using Node's built-in
 * global WebSocket (Node >= 22). Starts a local static server so pages can
 * `fetch("data.json")` over http (file:// would be blocked by CORS).
 *
 * Usage:  node tools/smoke-test.mjs [--keep] [--page index.html]
 * Exit:   0 no page threw / logged an error, 1 otherwise, 2 harness error.
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

const only = (() => {
  const i = process.argv.indexOf("--page");
  return i !== -1 ? process.argv[i + 1] : null;
})();

const PAGES = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith(".html"))
  .filter((f) => (only ? f === only : true))
  .sort();

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

function launchChromium(port, userDataDir) {
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];
  const proc = spawn("chromium", args, { stdio: ["ignore", "ignore", "pipe"] });
  return proc;
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

// Minimal CDP client over the browser-level WebSocket.
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

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const port = await findFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-chrome-"));
  const chromium = launchChromium(port, userDataDir);

  let exitCode = 0;
  let cdp;
  try {
    const wsUrl = await waitForDevTools(port);
    cdp = await CDP.connect(wsUrl);

    const problems = [];

    for (const page of PAGES) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Log.enable", {}, sessionId);

      const unsub = cdp.on((msg) => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === "Runtime.exceptionThrown") {
          const d = msg.params.exceptionDetails;
          problems.push(`${page}: uncaught ${d.text} ${d.exception?.description || ""}`.trim());
        } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
          problems.push(`${page}: console.error ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
        } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
          const e = msg.params.entry;
          const where = e.url ? ` [${e.url}]` : "";
          // Ignore favicon 404s which Chromium logs for file pages.
          if (!/favicon\.ico/.test((e.text || "") + (e.url || ""))) problems.push(`${page}: ${e.source} ${e.text}${where}`);
        }
      });

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
      await new Promise((r) => setTimeout(r, 1200)); // let deferred work (fetch/render) run

      unsub();
      await cdp.send("Target.closeTarget", { targetId });
    }

    if (problems.length) {
      exitCode = 1;
      console.error(`\x1b[31m${problems.length} runtime problem(s):\x1b[0m`);
      for (const p of problems) console.error("  - " + p);
    } else {
      console.log(`\x1b[32mOK\x1b[0m  ${PAGES.length} page(s) loaded with no runtime errors.`);
    }
  } catch (err) {
    exitCode = 2;
    console.error("harness error:", err?.message || err);
  } finally {
    try { cdp?.ws.close(); } catch {}
    chromium.kill("SIGKILL");
    server.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
  process.exit(exitCode);
}

main();
