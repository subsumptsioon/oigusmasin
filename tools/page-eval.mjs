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
import { launch } from "./cdp.mjs";

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

async function main() {
  const env = await launch();
  let exitCode = 0;
  try {
    const { targetId, sessionId } = await env.open(page, { settle: 1500 });
    /* Set after load so the emulation applies to the query being asked about. */
    if (media) await env.cdp.send("Emulation.setEmulatedMedia", { media }, sessionId);

    /* A debug probe wants the exception text, not a harness stack trace. */
    const out = await env.evalRaw(expr, sessionId);
    if (out.exceptionDetails) {
      console.error("expression threw:", out.exceptionDetails.text, out.exceptionDetails.exception?.description || "");
      exitCode = 1;
    } else {
      const v = out.result.value;
      console.log(asJson ? JSON.stringify(v, null, 2) : (typeof v === "string" ? v : JSON.stringify(v)));
    }
    await env.close_(targetId);
  } catch (err) {
    console.error("harness error:", err?.message || err);
    exitCode = 2;
  } finally {
    await env.close();
  }
  process.exit(exitCode);
}

main();
