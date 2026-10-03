#!/usr/bin/env node
/**
 * page-eval.mjs — load one page in headless Chromium and evaluate JS in it.
 *
 * Handy for poking at the inline-script functions of the DOM tools (they are
 * top-level classic-script declarations, so they live on the page's global).
 *
 * Usage:
 *   node tools/page-eval.mjs <page.html> "<expression>" [--json] [--media <m>]
 *     --json           pretty-print the result instead of a compact form
 *     --media <m>      emulate a media type, e.g. `print`. Needed to inspect
 *                       anything inside an @media block, which computed style
 *                       otherwise reports as if the query never matched.
 *
 * Example:
 *   node tools/page-eval.mjs isikukood.html "parseIdCode('37605030000')"
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

const page = process.argv[2];
const expr = process.argv[3];
if (!page || !expr) {
  console.error("usage: node tools/page-eval.mjs <page.html> \"<expression>\" [--json] [--media <m>]");
  process.exit(2);
}
const asJson = process.argv.includes("--json");
const mi = process.argv.indexOf("--media");
const media = mi === -1 ? null : process.argv[mi + 1];
if (mi !== -1 && !media) {
  console.error("--media needs a value, e.g. --media print");
  process.exit(2);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    const file = path.join(ROOT, rel || "index.html");
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("nf"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const port = await new Promise((r) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "peval-"));
  const chrome = spawn("chromium", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });

  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(150); }
  }
  if (!wsUrl) { console.error("no devtools"); process.exit(2); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

  const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Page.navigate", { url: `${base}/${page}` }, sessionId);
  await sleep(1500);
  /* Set after load so the emulation applies to the query being asked about. */
  if (media) await send("Emulation.setEmulatedMedia", { media }, sessionId);

  const out = await send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true,
  }, sessionId);

  const r = out.result;
  if (r?.exceptionDetails) {
    console.error("expression threw:", r.exceptionDetails.text, r.exceptionDetails.exception?.description || "");
    process.exitCode = 1;
  } else {
    const v = r.result.value;
    console.log(asJson ? JSON.stringify(v, null, 2) : (typeof v === "string" ? v : JSON.stringify(v)));
  }

  ws.close();
  chrome.kill("SIGKILL");
  server.close();
  fs.rmSync(udd, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
main();
