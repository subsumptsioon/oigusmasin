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
import { launch, pages } from "./cdp.mjs";

const only = (() => {
  const i = process.argv.indexOf("--page");
  return i !== -1 ? process.argv[i + 1] : null;
})();

const PAGES = pages(only);

async function main() {
  const env = await launch();
  let exitCode = 0;
  try {
    const { cdp } = env;
    const problems = [];

    for (const page of PAGES) {
      const { targetId, sessionId } = await env.attach();
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

      await env.goto(page, sessionId, { settle: 1200 });

      unsub();
      await env.close_(targetId);
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
    await env.close();
  }
  process.exit(exitCode);
}

main();
