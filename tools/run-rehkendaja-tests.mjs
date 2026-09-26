#!/usr/bin/env node
/**
 * run-rehkendaja-tests.mjs — headless runner for the Rehkendaja test suites.
 *
 * The suites live in `rehkendaja-test.html` (a browser page). This runner
 * reuses them verbatim so there is exactly ONE source of truth for the tests:
 * it slices the suite block out of the HTML and evaluates it together with
 * `rehkendaja-core.js` in a Node VM (no DOM needed — the core is pure).
 *
 * Usage:  node tools/run-rehkendaja-tests.mjs [--verbose]
 * Exit:   0 all green, 1 any failure, 2 harness/extraction error.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const HTML = path.join(ROOT, "rehkendaja-test.html");
const CORE = path.join(ROOT, "rehkendaja-core.js");

const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

// Markers delimiting the reusable block: the harness + all suite(...) calls.
// Everything before START is DOM bootstrap; everything at/after END is DOM render.
const START = "const suites = [];";
const END = 'const output = document.getElementById("output");';

function fail(msg) {
  console.error(`\x1b[31mharness error:\x1b[0m ${msg}`);
  process.exit(2);
}

function extractSuiteBlock(html) {
  const s = html.indexOf(START);
  if (s === -1) fail(`could not find start marker ${JSON.stringify(START)} in ${path.basename(HTML)}`);
  const e = html.indexOf(END, s);
  if (e === -1) fail(`could not find end marker ${JSON.stringify(END)} in ${path.basename(HTML)}`);
  return html.slice(s, e);
}

function main() {
  const core = fs.readFileSync(CORE, "utf8");
  const html = fs.readFileSync(HTML, "utf8");
  const suitesSrc = extractSuiteBlock(html);

  // Single script => core's top-level `let mode` and the harness share one
  // lexical scope. The epilogue exposes the collected results to us.
  const program = [
    "'use strict';",
    core,
    "\n/* ---- harness + suites (from rehkendaja-test.html) ---- */\n",
    suitesSrc,
    "\nglobalThis.__SUITES__ = suites;",
    "\nglobalThis.__MODE__ = typeof mode !== 'undefined' ? mode : undefined;",
  ].join("\n");

  // Shared context object: the epilogue writes __SUITES__ onto `globalThis`,
  // which we alias to the context itself.
  const context = { Intl, Math, JSON, console };
  context.globalThis = context;
  vm.createContext(context);

  let suites;
  try {
    vm.runInContext(program, context, {
      filename: "rehkendaja-tests.bundle.js",
    });
    suites = context.__SUITES__;
  } catch (err) {
    fail(`exception while evaluating suites: ${err && err.stack ? err.stack : err}`);
  }

  if (!Array.isArray(suites)) fail("no suites were collected (marker slice empty?)");

  let totalPass = 0;
  let totalFail = 0;
  const failures = [];

  const line = "─".repeat(64);
  console.log(`Rehkendaja headless tests  (${suites.length} suites)`);
  console.log(line);

  for (const s of suites) {
    const pass = s.tests.filter((t) => t.pass).length;
    const failN = s.tests.length - pass;
    totalPass += pass;
    totalFail += failN;
    const badge = failN ? `\x1b[31m${pass}/${s.tests.length}\x1b[0m` : `\x1b[33m${pass}/${s.tests.length}\x1b[0m`;
    console.log(`${failN ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m"} ${s.name}  [${badge}]`);
    for (const t of s.tests) {
      if (t.pass) {
        if (VERBOSE) console.log(`    ✓ ${t.label}`);
        continue;
      }
      console.log(`    \x1b[31m✗ ${t.label || "(no label)"}\x1b[0m`);
      console.log(`        got      ${t.got}`);
      console.log(`        expected ${t.expected}`);
      failures.push(`${s.name} :: ${t.label}`);
    }
  }

  console.log(line);
  const total = totalPass + totalFail;
  console.log(
    `${totalFail ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32mPASS\x1b[0m"}  ` +
      `${totalPass} passed, ${totalFail} failed, ${total} total`,
  );

  if (totalFail) {
    console.log(`\n${failures.length} failing test(s).`);
    process.exit(1);
  }
  process.exit(0);
}

main();
