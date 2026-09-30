#!/usr/bin/env node
/**
 * check-css.mjs — lint the stylesheets for the conventions noir.css documents.
 *
 * No npm deps on purpose: this project has none, and a small explicit rule set
 * is easier to reason about than a stylelint config.
 *
 * Each rule below exists because it caught a real regression during the design
 * token pass, not because it is stylistically nice.
 *
 * Usage:  node tools/check-css.mjs
 * Exit:   0 clean, 1 violations found, 2 harness error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CSS = "noir.css";
const HTML = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith(".html"))
  .sort();

/* Breakpoints are a documented convention rather than tokens: plain CSS cannot
 * read a custom property inside a media query without a build step. */
const ALLOWED_BREAKPOINTS = new Set(["800px", "900px"]);

/* Container-query thresholds are keyed to available content width instead of
 * the viewport, because the sidebar consumes 260px. */
const ALLOWED_CONTAINER_WIDTHS = new Set(["860px"]);

/* `outline: none` is only correct where a wrapper deliberately owns the ring
 * instead (the search box and the Rehkendaja textarea overlay). Anywhere else
 * it removes the only focus indicator. */
const OUTLINE_NONE_ALLOWLIST = ["#search", "#input-text"];

/* Deliberate one-off spacing nudges that do not belong on the scale. */
const SPACING_EXEMPT = new Set(["1px"]);

/* Tokens defined per-selector rather than in :root (component-scoped accents). */
const LOCAL_TOKENS = new Set(["--list-accent"]);

const violations = [];
const report = (file, line, rule, msg) => {
  violations.push({ file, line, rule, msg });
};

/* Strip comments so a token name mentioned in prose is not mistaken for code. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/* Tokens are global: page <style> blocks reference noir.css's :root, so the
 * defined set is collected once from the stylesheet and shared by every file. */
let TOKENS = new Set();

/* Remove every `:root { ... }` block, wherever it appears. The print palette
 * is a second `:root`, and a palette definition is exactly where raw colours
 * are legitimate. */
function stripRootBlocks(css) {
  return css.replace(/:root\s*\{[\s\S]*?\n\}/g, (m) => m.replace(/[^\n]/g, " "));
}

function checkCss(file, raw) {
  const css = stripComments(raw);

  // ── 1. Every var(--x) must be a known token ──────────────────────────────
  // A typo'd or deleted token fails silently at render time, which is how
  // `var(--display)` survived after --display was folded into --mono.
  for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/g)) {
    if (!TOKENS.has(m[1]) && !LOCAL_TOKENS.has(m[1])) {
      report(file, lineOf(css, m.index), "tokens", `var(${m[1]}) is not defined in :root`);
    }
  }

  // ── 2. No raw colours outside a :root palette block ──────────────────────
  const outsideRoot = stripRootBlocks(css);
  for (const m of outsideRoot.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) {
    report(file, lineOf(css, m.index), "raw-color", `hardcoded colour "${m[0]}" outside :root — use a token`);
  }

  // ── 3. No literal z-index ────────────────────────────────────────────────
  for (const m of css.matchAll(/z-index:\s*(\d+)/g)) {
    report(file, lineOf(css, m.index), "z-index", `literal z-index: ${m[1]} — use a --z-* token`);
  }

  // ── 4. No 100vh ──────────────────────────────────────────────────────────
  for (const m of css.matchAll(/\b100vh\b/g)) {
    report(file, lineOf(css, m.index), "viewport", "100vh — use 100dvh so mobile browser chrome does not clip it");
  }

  // ── 5. outline: none is allowlisted only ─────────────────────────────────
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*outline:\s*none[^{}]*)\}/g)) {
    const selector = m[1].trim().split("\n").pop().trim();
    if (!OUTLINE_NONE_ALLOWLIST.some((ok) => selector.includes(ok))) {
      report(
        file, lineOf(css, m.index), "focus",
        `outline: none on "${selector}" — the universal :focus-visible ring is the only focus indicator`
      );
    }
  }

  // ── 6. Type and spacing must come from the scale ─────────────────────────
  for (const m of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
    report(file, lineOf(css, m.index), "type-scale", `font-size: ${m[1]}px — use a --fs-* token`);
  }
  for (const m of css.matchAll(/letter-spacing:\s*(-?[\d.]+)em/g)) {
    report(file, lineOf(css, m.index), "type-scale", `letter-spacing: ${m[1]}em — use a --track-* token`);
  }
  const SPACING_PROPS = "padding|margin|gap|row-gap|column-gap";
  for (const m of css.matchAll(new RegExp(`(?:${SPACING_PROPS})[a-z-]*:\\s*([^;{}]+)`, "g"))) {
    for (const v of m[1].matchAll(/(\d+)px/g)) {
      if (!SPACING_EXEMPT.has(v[0])) {
        report(file, lineOf(css, m.index), "spacing", `${v[0]} in "${m[0].trim()}" — use a --sp-* token`);
      }
    }
  }

  // ── 7. Only documented breakpoints ───────────────────────────────────────
  for (const m of css.matchAll(/@media[^{]*?\(max-width:\s*(\d+)px\)/g)) {
    if (!ALLOWED_BREAKPOINTS.has(m[1] + "px")) {
      report(
        file, lineOf(css, m.index), "breakpoint",
        `viewport breakpoint ${m[1]}px is not one of ${[...ALLOWED_BREAKPOINTS].join(", ")}`
      );
    }
  }
  for (const m of css.matchAll(/@media[^{]*?\(min-width:\s*(\d+)px\)/g)) {
    report(file, lineOf(css, m.index), "breakpoint", `min-width media query ${m[1]}px — use a max-width query`);
  }
  for (const m of css.matchAll(/@container[^{]*?\(max-width:\s*(\d+)px\)/g)) {
    if (!ALLOWED_CONTAINER_WIDTHS.has(m[1] + "px")) {
      report(
        file, lineOf(css, m.index), "breakpoint",
        `container threshold ${m[1]}px is not one of ${[...ALLOWED_CONTAINER_WIDTHS].join(", ")}`
      );
    }
  }

  // ── 8. The mono stack belongs to body, not to 59 individual rules ────────
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*font-family:\s*var\(--mono\)[^{}]*)\}/g)) {
    const selector = m[1].trim().split("\n").pop().trim();
    if (selector !== "body") {
      report(file, lineOf(css, m.index), "font", `font-family: var(--mono) on "${selector}" — body already sets it`);
    }
  }
}

function checkHtml(file, raw) {
  // Only <style> blocks; inline style="" attributes are checked separately.
  for (const m of raw.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    checkCss(`${file} <style>`, m[1]);
  }
  // Inline style attributes must not smuggle in raw colours or spacing.
  for (const m of raw.matchAll(/style="([^"]*)"/g)) {
    const decls = m[1];
    if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(decls)) {
      report(file, lineOf(raw, m.index), "raw-color", `hardcoded colour in style="${decls}" — use a token`);
    }
    for (const v of decls.matchAll(/(?:padding|margin|gap|font-size|letter-spacing)[a-z-]*:\s*(-?[\d.]+(?:px|em))/g)) {
      report(file, lineOf(raw, m.index), "inline-style", `style="${decls}" uses a raw ${v[0]} value — use a token`);
    }
  }
}

function main() {
  console.log(`CSS convention check — ${CSS} + ${HTML.length} page(s)`);
  console.log("─".repeat(72));

  try {
    // Collect the global token vocabulary from the stylesheet first: page
    // <style> blocks are written against it, not against their own :root.
    const sheet = fs.readFileSync(path.join(ROOT, CSS), "utf8");
    for (const m of stripComments(sheet).matchAll(/(--[a-z0-9-]+)\s*:/g)) {
      TOKENS.add(m[1]);
    }
    if (!TOKENS.size) {
      console.error("harness error: no custom properties found in " + CSS);
      process.exit(2);
    }

    checkCss(CSS, sheet);
    for (const page of HTML) {
      checkHtml(page, fs.readFileSync(path.join(ROOT, page), "utf8"));
    }
  } catch (err) {
    console.error("harness error:", err?.message || err);
    process.exit(2);
  }

  if (!violations.length) {
    console.log("\x1b[32mOK\x1b[0m  no convention violations.");
    process.exit(0);
  }

  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }
  for (const [rule, items] of [...byRule].sort()) {
    console.log(`\n\x1b[31m${rule}\x1b[0m (${items.length})`);
    for (const v of items) {
      console.log(`  ${v.file}:${v.line}  ${v.msg}`);
    }
  }
  console.log(`\n\x1b[31mFAIL\x1b[0m  ${violations.length} violation(s) in ${byRule.size} rule(s).`);
  process.exit(1);
}

main();
