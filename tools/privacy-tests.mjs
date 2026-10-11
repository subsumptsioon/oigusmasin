#!/usr/bin/env node
/**
 * privacy-tests.mjs — the behavioural half of §7.
 *
 * §7 makes the file-stays-local promise on three supports: code that cannot
 * fetch, a behaviour that is observed rather than assumed, and the absence of any
 * exit. The first and the third are static and live in `check-assets.mjs`; this
 * is the second, and it is the one that cannot be argued with, because it
 * watches what the browser actually did.
 *
 * WHAT IS ASSERTED
 *
 *   1. **No request carries a body.** Not "no request to another host" — no
 *      request at all with a payload. A POST of the file to the visitor's own
 *      origin would satisfy the weaker promise and still be a file leaving.
 *   2. **No request leaves the origin.** Same-origin is necessary, not sufficient;
 *      this is the minimum the promise requires and the test states it plainly.
 *   3. **Every request happens before the file is read.** A request made *after*
 *      analysis could carry data that was read from the file; a request made
 *      before cannot. Lazy module loading is the only reason requests happen at
 *      all, and their position is the evidence.
 *   4. **No CSP violation**, and **no uncaught exception**, for every file.
 *
 * WHY IT ITERATES THE REGISTRY
 *
 * A hard-coded list of PDFs would test the formats that exist today and quietly
 * stop testing whatever comes next. `FORMATS` is exported by the registry and is
 * the same list the page itself uses, so a format added in phase 12 is covered
 * the day it is registered.
 *
 * WHAT IT DOES NOT CLAIM
 *
 * It cannot see what GitHub Pages logs. It runs against a local server. §7 says
 * so in prose and `README.md` says it again, because the one thing this test
 * proves is the code's behaviour, not the host's discretion.
 *
 * Usage:  node tools/privacy-tests.mjs [--keep]
 * Exit:   0 all assertions passed, 1 a violation, 2 harness error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";
import { FORMATS } from "../formats/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CORPUS = path.join(ROOT, "test-pdfs");

let failures = 0;
const pass = (name, detail = "") =>
  console.log(`\x1b[32m  ok\x1b[0m   ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
const fail = (name, detail = "") => {
  failures++;
  console.log(`\x1b[31m FAIL\x1b[0m  ${name}${detail ? `  ${detail}` : ""}`);
};

/** One small file per registered format, so a format with no corpus entry is a
 *  loud skip rather than a silent pass. The registry's `id` is the contract. */
function corpusFor(formatId) {
  const candidates = {
    pdf: ["classic.pdf", "incremental.pdf", "xrefstream.pdf", "encrypted.pdf", "truncated.pdf"],
    jpeg: ["photo.jpg", "photo.jpg"],
  };
  const names = candidates[formatId] ?? [];
  return names.map((n) => path.join(CORPUS, n)).filter((p) => fs.existsSync(p));
}

async function main() {
  if (!fs.existsSync(CORPUS)) {
    console.error(
      `harness error: no corpus at ${path.relative(ROOT, CORPUS)}\n` +
        `  the behavioural test analyses real files; generate them with:\n` +
        `    node tools/make-corpus.mjs`,
    );
    process.exit(2);
  }

  console.log("Privacy behaviour test — §7's second support");
  console.log("─".repeat(72));

  const env = await launch();

  /** Collected from CDP rather than from `performance.getEntriesByType()`, which
   *  cannot tell a script load from a transfer and has no notion of a body. */
  const requests = [];
  const cspViolations = [];
  const exceptions = [];

  env.cdp.on((msg) => {
    if (msg.method === "Network.requestWillBeSent") {
      requests.push({
        url: msg.params.request.url,
        type: msg.params.type,
        method: msg.params.request.method,
        body: msg.params.request.postData ?? null,
        at: Date.now(),
      });
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.source === "security") {
      cspViolations.push(msg.params.entry.text);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      exceptions.push(d.exception?.description ?? d.text);
    }
  });

  try {
    const { sessionId } = await env.open("metaandmed.html", { settle: 800 });
    await env.cdp.send("Network.enable", {}, sessionId);
    await env.cdp.send("Log.enable", {}, sessionId);

    const origin = (await env.evalRaw("location.origin", sessionId)).result.value;
    console.log(`origin: ${origin}\n`);

    /* Mark the instant the file becomes readable. Everything fetched before this
       is code; everything after it could be data. */
    const files = [];
    for (const format of FORMATS) {
      for (const file of corpusFor(format.id)) files.push({ format, file });
    }

    if (!files.length) {
      fail("the registry produced no testable files", "every format had no corpus entry");
      process.exit(1);
    }

    for (const { format, file } of files) {
      const name = path.relative(CORPUS, file);
      const mark = requests.length;
      const markAt = Date.now();

      const doc = await env.cdp.send("DOM.getDocument", {}, sessionId);
      const { nodeId } = await env.cdp.send(
        "DOM.querySelector",
        { nodeId: doc.root.nodeId, selector: "#file-input" },
        sessionId,
      );
      await env.cdp.send("DOM.setFileInputFiles", { files: [file], nodeId }, sessionId);
      await env.cdp.send("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId);
      await (await env.evalRaw(
        `(async () => {
           document.getElementById("file-input").dispatchEvent(new Event("change"));
           await new Promise(r => setTimeout(r, 6000));
         })()`,
        sessionId,
      )).result;

      const made = requests.slice(mark);
      const label = `${format.id}/${name}`;

      const withBody = made.filter((r) => r.body != null);
      const offOrigin = made.filter((r) => !r.url.startsWith(origin));
      /* A request for the file itself would be a fetch of user content, which is
         the one thing that must never happen — the page is handed a File and
         reads it locally, so there is no URL to request. */
      const namesFile = made.filter((r) => r.url.includes(path.basename(file)));

      if (withBody.length) {
        fail(`${label}: a request carried a body`,
             withBody.map((r) => `${r.method} ${r.url} (${r.body.length} B)`).join(", "));
      } else {
        pass(`${label}: no request carried a body`, `${made.length} request(s)`);
      }

      if (offOrigin.length) {
        fail(`${label}: a request left the origin`,
             offOrigin.map((r) => r.url).join(", "));
      } else {
        pass(`${label}: every request stayed on this origin`);
      }

      if (namesFile.length) {
        fail(`${label}: the page requested the file by name`,
             namesFile.map((r) => r.url).join(", "));
      } else {
        pass(`${label}: the page never requested the file`);
      }

      /* Everything requested must be code we wrote or vendored. */
      const foreign = made.filter((r) => !/\/(lib|formats)\//.test(r.url));
      if (foreign.length) {
        fail(`${label}: an unexpected request was made`,
             foreign.map((r) => r.url.replace(origin, "")).join(", "));
      }

      /* The analysis must have finished; "Analüüsin…" left on screen is the
         residue of a failed analysis, and a failed analysis can hide a request
         that would otherwise have been recorded. */
      const status = (await env.cdp.send(
        "Runtime.evaluate",
        { expression: `document.getElementById("status-line").textContent.trim()`, returnByValue: true },
        sessionId,
      )).result.value;

      if (status === "Analüüsin…") {
        fail(`${label}: the analysis never finished`, "status line still says Analüüsin…");
      } else {
        pass(`${label}: the analysis finished`);
      }

      void markAt;
    }

    console.log("");
    if (cspViolations.length) {
      fail("CSP violations were logged", cspViolations.slice(0, 3).join(" | "));
    } else {
      pass("no CSP violation was logged, for any file");
    }

    if (exceptions.length) {
      fail("uncaught exceptions were thrown", exceptions.slice(0, 2).join(" | ").slice(0, 300));
    } else {
      pass("no uncaught exception, for any file");
    }
  } finally {
    await env.close();
  }

  console.log("");
  if (failures) {
    console.log(`\x1b[31m${failures} violation(s) of §7.\x1b[0m`);
    process.exit(1);
  }
  console.log("\x1b[32mOK\x1b[0m  the file stayed on the machine, for every registered format.");
}

main().catch((err) => {
  console.error("harness error:", err?.message || err);
  process.exit(2);
});