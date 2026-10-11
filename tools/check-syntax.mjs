#!/usr/bin/env node
/**
 * check-syntax.mjs — every analyser module must parse, before anything runs.
 *
 * Why this exists, because it is not a theoretical concern.
 *
 * During phase 8 a scripted edit replaced a template literal's closing backtick
 * with a double quote. The file still parsed under most tools — because the
 * error was a *string* that swallowed the following lines — and the language
 * check passed, because it found no Estonian in what it read. The failure
 * surfaced as `SyntaxError: missing ) after argument list` in the browser, where
 * it took a while to locate because four other checks had already said the file
 * was fine.
 *
 * The general lesson is not "be careful with quotes". It is that **a
 * syntactically broken module was invisible to every check in `verify`**, because
 * all of them read the file as text rather than as code. This check parses it as
 * code, which is the only thing that can catch that class at all.
 *
 * No dependencies, same as the other tools here. Node parses the module itself;
 * the import below is never executed, only resolved.
 *
 * Usage:  node tools/check-syntax.mjs
 * Exit:   0 clean, 1 syntax error, 2 harness error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/** Everything the browser will import as a module. `lib/` is excluded: it is
 *  vendored, pinned, and already parsed by whatever built it. */
const TARGETS = [
  "metaandmed.js",
  "nav.js",
  ...walk(path.join(ROOT, "formats")),
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Parse a module **without running it**.
 *
 * Two obvious approaches are wrong:
 *
 *   `new Function(src)` rejects `import`/`export`, so it cannot parse the files
 *   that most need checking.
 *   `await import(url)` parses *and executes* — which is how this check began,
 *   and it reported `document is not defined` for `metaandmed.js` and `nav.js`.
 *   Those two are correct in a browser and wrong in Node, and a check that
 *   demands browser behaviour of a parser has stopped being a parser.
 *
 * `vm.SourceTextModule` links a module graph without evaluating it, which is
 * exactly the job. It needs `--experimental-vm-modules`, so the flag goes on the
 * child process rather than onto whatever runs this file.
 */
function parseModule(file) {
  const script = `
    import fs from "node:fs";
    import vm from "node:vm";
    const src = fs.readFileSync(${JSON.stringify(file)}, "utf8");
    // Compilation, not evaluation: a top-level reference to \`document\` is fine.
    new vm.SourceTextModule(src, { identifier: ${JSON.stringify(file)} });
  `;
  return execFileSync(
    process.execPath,
    ["--experimental-vm-modules", "--input-type=module", "-e", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 },
  );
}

/**
 * Every relative dynamic `import()` in our sources must resolve to a real file.
 *
 * Only relative specifiers are checked, and only the ones that point into
 * `lib/` — the vendored copies. A bare package name would be a dependency, and
 * requirement 7 says there are none at runtime.
 */
function checkVendorPaths(files) {
  const problems = [];

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/import\(\s*"([^"]+)"\s*\)/g)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(target)) continue;

      const line = src.slice(0, m.index).split("\n").length;
      problems.push({
        rel: path.relative(ROOT, file),
        message:
          `vendored path does not resolve\n` +
          `  line ${line}: import("${spec}")\n` +
          `  resolves to ${path.relative(ROOT, target)}, which does not exist\n` +
          `  note: a browser clamps a path that climbs above the origin root, so this\n` +
          `        mistake passes every page test and fails only here.`,
      });
    }
  }

  return problems;
}

function main() {
  const files = TARGETS
    .map((t) => (path.isAbsolute(t) ? t : path.join(ROOT, t)))
    .filter((f) => fs.existsSync(f))
    .sort();

  if (files.length < 4) {
    console.error("harness error: expected the analyser sources to be present");
    process.exit(2);
  }

  console.log(`Syntax check — ${files.length} module(s)`);
  console.log("─".repeat(72));

  const failures = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    try {
      parseModule(file);
    } catch (err) {
      const message = String(err?.stderr || err?.message || err)
        .split("\n")
        .filter((line) => line.trim() && !line.includes("MODULE_TYPELESS") && !line.includes("Reparsing") && !line.includes("To eliminate") && !line.includes("trace-warnings"))
        .join("\n");
      failures.push({ rel, message });
    }
  }

  /* A relative `import()` of a vendored file is parsed happily whether or not it
     resolves, because the resolution happens at run time. Two separate bugs in
     this project wrote `../../../lib/` from a file two levels deep: the browser
     clamps such a path at the origin root and serves the right file anyway, so
     every page test passed, while Node's resolver — which refuses — reported
     nothing but a missing feature. So the paths are resolved here, on disk,
     where a wrong depth is a wrong depth.
  */
  const vendorProblems = checkVendorPaths(files);
  for (const problem of vendorProblems) failures.push(problem);

  if (!failures.length) {
    console.log("\x1b[32mOK\x1b[0m  every module parses and resolves.");
    process.exit(0);
  }

  for (const { rel, message } of failures) {
    console.log(`\n\x1b[31m${rel}\x1b[0m`);
    console.log(`  ${message}`);
  }
  console.log(`\n\x1b[31mFAIL\x1b[0m  ${failures.length} module(s) did not parse.`);
  process.exit(1);
}

main();