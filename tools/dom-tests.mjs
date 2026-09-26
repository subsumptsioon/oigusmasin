#!/usr/bin/env node
/**
 * dom-tests.mjs — regression tests for the DOM tool pages (headless Chromium).
 *
 * The Rehkendaja core is covered by tools/run-rehkendaja-tests.mjs (pure, Node
 * VM). The other pages' inline logic is only reachable in a browser, so this
 * runner loads each affected page once and evaluates assertions in its global
 * scope. No npm deps: drives Chromium over CDP via Node's built-in WebSocket.
 *
 * Requires `chromium` on PATH (not wired into `npm run verify`/CI, which run
 * dependency-free Node checks only).
 *
 * Usage:  node tools/dom-tests.mjs [--verbose]
 * Exit:   0 all pass, 1 any fail, 2 harness error.
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
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// ── Checks: {page, label, expr, expect} — expect compared by JSON equality ──
const J = JSON.stringify;
const CHECKS = [
  // isikukood — ID parsing / checksum
  { page: "isikukood.html", label: "parseIdCode: valid checksum", expr: "parseIdCode('49001012115')", expect: { valid: true, checksumOk: true, born: { y: 1990, m: 1, d: 1 } } },
  { page: "isikukood.html", label: "parseIdCode: wrong checksum", expr: "parseIdCode('37605030000').checksumOk", expect: false },
  { page: "isikukood.html", label: "parseIdCode: first digit out of range", expr: "parseIdCode('07605030000').valid", expect: false },
  { page: "isikukood.html", label: "parseIdCode: length", expr: "parseIdCode('123').valid", expect: false },
  { page: "isikukood.html", label: "parseIdCode: century map 1->1800", expr: "parseIdCode('10001010000').born ? parseIdCode('10001010000').born.y : parseIdCode('10001010000').error", expect: 1800 },

  // isikukood — age (regression: negative-days bug)
  { page: "isikukood.html", label: "calcAge: 31.01 -> 01.03 = 0y 1m 1d", expr: "calcAge({y:2020,m:1,d:31},{y:2020,m:3,d:1})", expect: { years: 0, months: 1, days: 1 } },
  { page: "isikukood.html", label: "calcAge: leap-day -> non-leap", expr: "calcAge({y:2020,m:2,d:29},{y:2021,m:2,d:28})", expect: { years: 1, months: 0, days: 0 } },
  { page: "isikukood.html", label: "calcAge: normal case unchanged", expr: "calcAge({y:2000,m:5,d:10},{y:2026,m:9,d:26})", expect: { years: 26, months: 4, days: 16 } },
  { page: "isikukood.html", label: "calcAge: never negative", expr: "(()=>{for(let y=1990;y<=2001;y++)for(let m=1;m<=12;m++)for(let d=1;d<=31;d++){const bd=new Date(y,m-1,d);if(bd.getMonth()!==m-1||bd.getDate()!==d)continue;for(let rm=1;rm<=12;rm++)for(let rd=1;rd<=31;rd++){const r=new Date(y+30,rm-1,rd);if(r.getMonth()!==rm-1||r.getDate()!==rd)continue;const a=calcAge({y,m,d},{y:y+30,m:rm,d:rd});if(a.years<0||a.months<0||a.days<0)return false;}}return true;})()", expect: true },
  { page: "isikukood.html", label: "parseDMY: rejects impossible dates", expr: "[parseDMY('31.02.2020'), parseDMY('01.13.2020'), parseDMY('29.02.2020')]", expect: [null, null, { y: 2020, m: 2, d: 29 }] },

  // narkonimekirjad — highlight must not corrupt escaped entities
  { page: "narkonimekirjad.html", label: "highlight: query 'amp' keeps entity intact", expr: "highlight('Amphetamine & co', 'amp')", expect: "<mark>Amp</mark>hetamine &amp; co" },
  { page: "narkonimekirjad.html", label: "highlight: query '&' escapes the mark", expr: "highlight('a & b', '&')", expect: "a <mark>&amp;</mark> b" },
  { page: "narkonimekirjad.html", label: "highlight: query '<' escapes the mark", expr: "highlight('a < b', '<')", expect: "a <mark>&lt;</mark> b" },
  { page: "narkonimekirjad.html", label: "highlight: no entity match when absent", expr: "highlight('hello', 'zzz')", expect: "hello" },
  { page: "narkonimekirjad.html", label: "esc: escapes &<>", expr: "esc('a & b < c > d')", expect: "a &amp; b &lt; c &gt; d" },

  // index — detection, sum, exclusion round-trip
  { page: "index.html", label: "eur sum", expr: "(()=>{mode='eur';inputEl.value='1 234,56 € ning 89.50 €';update();return valSum.textContent;})()", expect: "1324,06\u00a0€" },
  { page: "index.html", label: "gram sum", expr: "(()=>{mode='g';inputEl.value='0,5g heroiini ja 1.2g';update();return valSum.textContent;})()", expect: "1,7\u00a0g" },
  { page: "index.html", label: "exclude one of two", expr: "(()=>{mode='eur';inputEl.value='10 € ja 20 €';update();toggleExclude(0);return [valSum.textContent, valCount.textContent];})()", expect: ["20,00\u00a0€", "1 / 2"] },

  // karistuste-liitmine — duration carry
  { page: "karistuste-liitmine.html", label: "carry: 11m + 11m = 1y 10m", expr: "(()=>{const set=(id,v)=>document.getElementById(id).value=v;set('a-years',1);set('a-months',11);set('a-days',0);set('b-years',0);set('b-months',11);set('b-days',20);const r=compute();return {y:r.rYears,m:r.rMonths,d:r.rDays};})()", expect: { y: 2, m: 10, d: 20 } },
  { page: "karistuste-liitmine.html", label: "carry: 25 days -> 0m 25d", expr: "(()=>{const set=(id,v)=>document.getElementById(id).value=v;set('a-years',0);set('a-months',0);set('a-days',25);set('b-years',0);set('b-months',0);set('b-days',0);const r=compute();return {y:r.rYears,m:r.rMonths,d:r.rDays};})()", expect: { y: 0, m: 0, d: 25 } },

  // ennetähtaegne-vabastamine — calendar arithmetic + entity fix
  { page: "ennetahtaegne-vabastamine.html", label: "addCalendarDuration clamps to month end", expr: "(()=>{const f=d=>formatDate(d);return [f(addCalendarDuration(new Date(2021,0,31),0,1,0)), f(addCalendarDuration(new Date(2020,0,31),0,1,0)), f(addCalendarDuration(new Date(2020,1,29),1,0,0))];})()", expect: ["28.02.2021", "29.02.2020", "28.02.2021"] },
  { page: "ennetahtaegne-vabastamine.html", label: "compute applies 4-month minimum", expr: "(()=>{const r=compute(new Date(2021,0,1),0,3,0,1,2);return {date:formatDate(r.resultDate), min:r.minApplied};})()", expect: { date: "01.05.2021", min: true } },
  { page: "ennetahtaegne-vabastamine.html", label: "legal label has no literal &nbsp", expr: "document.querySelector('.result-legal-label').textContent.includes('&nbsp')", expect: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => J(a) === J(b);

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    const file = path.join(ROOT, rel || "index.html");
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("nf"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const port = await new Promise((r) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "domtests-"));
  const chrome = spawn("chromium", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });

  let cdp;
  let exit = 0;
  try {
    let wsUrl;
    for (let i = 0; i < 100 && !wsUrl; i++) {
      try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; }
      catch { await sleep(150); }
    }
    if (!wsUrl) throw new Error("DevTools endpoint did not come up");

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

    const pages = [...new Set(CHECKS.map((c) => c.page))];
    let pass = 0, fail = 0;
    const failures = [];

    for (const page of pages) {
      const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
      const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
      await send("Page.enable", {}, sessionId);
      await send("Runtime.enable", {}, sessionId);
      await send("Page.navigate", { url: `${base}/${page}` }, sessionId);
      await sleep(1200);

      for (const c of CHECKS.filter((c) => c.page === page)) {
        const out = await send("Runtime.evaluate", { expression: c.expr, returnByValue: true, awaitPromise: true }, sessionId);
        const r = out.result;
        if (r?.exceptionDetails) {
          fail++; failures.push({ ...c, threw: r.exceptionDetails.exception?.description || r.exceptionDetails.text });
          continue;
        }
        const got = r.result.value;
        if (eq(got, c.expect)) { pass++; if (VERBOSE) console.log(`  \x1b[32m✓\x1b[0m ${page} :: ${c.label}`); }
        else { fail++; failures.push({ ...c, got }); }
      }
      await send("Target.closeTarget", { targetId });
    }

    console.log(`DOM regression tests  (${pass + fail} checks across ${pages.length} pages)`);
    console.log("─".repeat(64));
    for (const f of failures) {
      console.error(`\x1b[31m✗\x1b[0m ${f.page} :: ${f.label}`);
      if (f.threw) console.error(`    threw: ${f.threw}`);
      else { console.error(`    got      ${J(f.got)}`); console.error(`    expected ${J(f.expect)}`); }
    }
    console.log("─".repeat(64));
    if (fail) { console.log(`\x1b[31mFAIL\x1b[0m  ${pass} passed, ${fail} failed`); exit = 1; }
    else console.log(`\x1b[32mPASS\x1b[0m  ${pass} passed, 0 failed`);

    cdp = ws;
  } catch (err) {
    console.error("harness error:", err?.message || err);
    exit = 2;
  } finally {
    try { cdp?.close(); } catch {}
    chrome.kill("SIGKILL");
    server.close();
    fs.rmSync(udd, { recursive: true, force: true });
  }
  process.exit(exit);
}

main();
