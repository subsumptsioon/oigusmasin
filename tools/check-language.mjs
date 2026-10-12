#!/usr/bin/env node
/**
 * check-language.mjs — enforce "English code, Estonian content" (requirement 12).
 *
 * No npm deps, same as the other tools here.
 *
 * The rule has two halves, and a comment states which is which:
 *
 *   class, id, data-*, variable, function, module and file names   → English
 *   text a visitor reads, and text a screen reader speaks           → Estonian
 *
 * That split exists because the alternative — Estonian names for Estonian
 * labels — puts a translatable string where a routing key belongs. `group`
 * decides which tab a node lands in; name that group "infodiktsioon" and
 * translating the interface silently unbuilds the navigation. So identifiers are
 * English and the Estonian travels beside them in a `labelEt`.
 *
 * SCOPE — deliberately not the whole repository. `tools/` and the older pages
 * predate this rule, and two of their comments contain "Õigusmasin" and the page
 * name "ennetähtaegne-vabastamine". Both are legitimate English sentences about
 * Estonian things: a product name and a filename. A regex cannot tell those from
 * a comment that is simply written in Estonian, and an allowlist that grows a
 * line per proper noun stops being a rule. So the check covers the code this
 * project is building, where every name was chosen under the rule. Widening it
 * is one line, once those two comments are reworded.
 *
 * `lib/` is excluded outright: vendored pdf.js and exifr are not our code and
 * carry their own licences and conventions.
 *
 * Usage:  node tools/check-language.mjs
 * Exit:   0 clean, 1 violations found, 2 harness error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/* Estonian letters, including š and ž, which a naive [äöüõÄÖÜÕ] misses and
   which turn up in surnames and imported proper names.
 *
 * WHAT THIS DOES NOT CATCH, because it is the honest limit of the method and a
 * reader will otherwise assume otherwise:
 *
 *   An Estonian word written in ASCII passes. `kaust`, `tulemus`, `seade` and
 *   `fail` contain no diacritic, and they are as Estonian as `märgistus`. The
 *   plan's own phase 11 verification uses `kaust` as its example of a class name
 *   that should fail the build — and it does not, because there is nothing in
 *   the string to distinguish it from English.
 *
 * So this check is a **high-confidence filter, not a language detector.** It
 * catches the mistakes that actually happen: a translated string leaking into an
 * identifier, a whole comment written in Estonian, a label pasted into a
 * selector. It cannot catch a single borrowed common noun, and nothing in the
 * file should pretend otherwise. `formats/node.js` states the rule in English and
 * keeps the Estonian in `labelEt` precisely because a human, not a regex, is the
 * thing that notices the rest. */
const ESTONIAN = /[äöüõšžÄÖÜÕŠŽ]/;

/* Rule 1 applies to code files. Rule 2 to markup. */
const CODE_EXT = new Set([".js", ".mjs", ".css"]);

/* HTML attributes that name things. `aria-label` and `alt` are deliberately
   absent: they are announced by a screen reader, so they are content. */
const NAME_ATTRS = ["class", "id", "name"];

const violations = [];
const report = (file, line, rule, msg) => violations.push({ file, line, rule, msg });

/* ── Targets ─────────────────────────────────────────────────────────────── */

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function targets() {
  const files = [
    path.join(ROOT, "metaandmed.html"),
    path.join(ROOT, "noir.css"),
    ...walk(path.join(ROOT, "formats")),
  ];
  return files
    .filter((f) => fs.existsSync(f))
    .filter((f) => CODE_EXT.has(path.extname(f)) || f.endsWith(".html"))
    .sort();
}

/* ── Stripping ────────────────────────────────────────────────────────────
   Only strings are stripped, and the match is blanked rather than deleted so
   line numbers in the report still match the file on disk. A checker that
   renumbers is a checker whose error messages cannot be acted on.

   Strings are the one place Estonian is allowed in a code file, so they are the
   one thing that has to go before looking. Everything else — identifiers,
   keywords, comments, selectors — stays, because requirement 12 puts comments
   on the English side of the line. An earlier draft stripped comments too, on
   the reasoning that a comment cannot execute; that made the check pass a file
   containing `// märkus: …` and is exactly the failure this tool exists to
   prevent. Do not add comment stripping back.

   Over-stripping is still the safe direction where it has to happen: a string
   that fails to strip costs one missed violation, a false positive costs the
   whole check being ignored, and an ignored check is worse than no check. */

function blank(match) {
  return match.replace(/[^\n]/g, " ");
}

const STRINGS = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

function stripStrings(src) {
  return src.replace(STRINGS, blank);
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/* ── Rules ──────────────────────────────────────────────────────────────── */

function checkCode(file, src) {
  const stripped = stripStrings(src);
  for (const m of stripped.matchAll(new RegExp(ESTONIAN, "g"))) {
    report(
      path.relative(ROOT, file),
      lineOf(src, m.index),
      "estonian-in-code",
      `${m[0]} in code — identifiers, comments and selectors are English; Estonian belongs in a string`,
    );
  }
}

function checkAttributes(file, src) {
  const rel = path.relative(ROOT, file);
  for (const m of src.matchAll(/\s([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) {
    const [, attr, value] = m;
    const isName =
      NAME_ATTRS.includes(attr.toLowerCase()) || attr.toLowerCase().startsWith("data-");
    if (!isName) continue;
    const bad = value.match(new RegExp(ESTONIAN, "g"));
    if (!bad) continue;
    report(
      rel,
      lineOf(src, m.index),
      "estonian-in-attribute",
      `${attr}="${value}" — attribute names name code; Estonian belongs in the text`,
    );
  }
}

/* ── Main ───────────────────────────────────────────────────────────────── */

function main() {
  const files = targets();
  console.log(`Language check — ${files.length} file(s) (English code, Estonian content)`);
  console.log("─".repeat(72));

  try {
    if (files.length < 4) {
      console.error("harness error: expected the analyser sources to be present");
      process.exit(2);
    }
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      if (file.endsWith(".html")) checkAttributes(file, src);
      else checkCode(file, src);
    }
  } catch (err) {
    console.error("harness error:", err?.message || err);
    process.exit(2);
  }

  if (!violations.length) {
    console.log("\x1b[32mOK\x1b[0m  no Estonian in code positions.");
    process.exit(0);
  }

  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }
  for (const [rule, items] of [...byRule].sort()) {
    console.log(`\n\x1b[31m${rule}\x1b[0m (${items.length})`);
    for (const v of items) console.log(`  ${v.file}:${v.line}  ${v.msg}`);
  }
  console.log(`\n\x1b[31mFAIL\x1b[0m  ${violations.length} violation(s) in ${byRule.size} rule(s).`);
  process.exit(1);
}

main();