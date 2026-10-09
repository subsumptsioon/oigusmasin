/**
 * cdp.mjs — shared headless-browser harness for the tools in this directory.
 *
 * Four tools (smoke-test, css-snapshot, dom-tests, page-eval) need the same
 * thing: serve the repo over http, launch Chromium, talk DevTools Protocol, tear
 * it all down. Each carried its own copy, and the copies had drifted — two had
 * a CDP class, two had a sloppier inline client that ignored protocol errors, so
 * a failed CDP call resolved as `undefined` instead of throwing.
 *
 * No npm deps: uses Node's built-in global WebSocket (Node >= 22) and child_process.
 *
 * Typical use:
 *   const env = await launch();
 *   try {
 *     const page = await env.open("index.html");
 *     await page.send("Runtime.evaluate", { expression: "1+1" }, page.sessionId);
 *   } finally {
 *     await env.close();
 *   }
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every HTML page in the repo root, sorted, optionally narrowed by name. */
export function pages(only) {
  return fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".html"))
    .filter((f) => (only ? f === only : true))
    .sort();
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/* file:// would be blocked by CORS, so pages that `fetch("data.json")` need a
 * real origin. Bound to an ephemeral port on loopback; nothing leaves the box. */
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
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      });
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

async function waitForDevTools(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error("DevTools endpoint did not come up");
}

/** Minimal CDP client over the browser-level WebSocket. */
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

/**
 * Start the server + browser. Always pair with `close()` — the Chromium process
 * and its temp profile otherwise outlive the process.
 *
 * `extraArgs` is for per-tool flags (css-snapshot hides scrollbars and pins the
 * device scale factor so geometry is comparable run to run).
 */
export async function launch({ extraArgs = [] } = {}) {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const port = await findFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oigusmasin-chrome-"));

  const proc = spawn(
    "chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      ...extraArgs,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"], detached: true },
  );

  /* Chromium forks zygote/renderer/gpu children into the same process group.
   * Killing only the parent leaves that tree running: every tool here leaked a
   * headless Chromium per run, and the zygotes outlived the node process. The
   * negative pid signals the whole group. */
  const killTree = () => {
    try { process.kill(-proc.pid, "SIGKILL"); } catch {}
    try { proc.kill("SIGKILL"); } catch {}
  };

  let cdp;
  try {
    cdp = await CDP.connect(await waitForDevTools(port));
  } catch (err) {
    killTree();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw err;
  }

  const env = {
    base,
    cdp,
    proc,

    /** Attach to a fresh tab with the domains a page runner needs. No navigation
     *  yet, so a caller can subscribe to Runtime/Log events before any script
     *  on the page has had a chance to throw. */
    async attach() {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);
      return { targetId, sessionId };
    },

    /** Navigate an attached tab and wait for load. */
    async goto(page, sessionId, { settle = 0 } = {}) {
      const loaded = new Promise((resolve) => {
        const off = cdp.on((msg) => {
          if (msg.sessionId === sessionId && msg.method === "Page.loadEventFired") {
            off();
            resolve();
          }
        });
      });
      await cdp.send("Page.navigate", { url: `${base}/${page}` }, sessionId);
      await Promise.race([loaded, sleep(8000)]);
      /* Deferred work (fetch + render) settles after loadEventFired. */
      if (settle) await sleep(settle);
    },

    /** attach() + goto(): the common case when no events need pre-navigation. */
    async open(page, { settle = 0 } = {}) {
      const tab = await env.attach();
      await env.goto(page, tab.sessionId, { settle });
      return tab;
    },

    async close_(targetId) {
      await cdp.send("Target.closeTarget", { targetId });
    },

    /** Evaluate in a page and throw if the expression itself threw. */
    async eval(expression, sessionId) {
      const res = await this.evalRaw(expression, sessionId);
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error(d.exception?.description || d.text);
      }
      return res.result.value;
    },

    /**
     * Evaluate and hand back the raw CDP payload — `{result, exceptionDetails}`.
     * For callers that need to report the exception rather than throw on it
     * (page-eval prints it).
     */
    async evalRaw(expression, sessionId) {
      const res = await cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      return res;
    },

    async close() {
      try { cdp.ws.close(); } catch {}
      killTree();
      /* Chromium unlinks its profile on a clean exit; give the group a moment
       * to die before removing the directory, or the rm races the zygote. */
      await new Promise((r) => setTimeout(r, 150));
      server.close();
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    },
  };

  return env;
}
