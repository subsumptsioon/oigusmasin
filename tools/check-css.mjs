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

/* ── Rule walker ─────────────────────────────────────────────────────────────
   Checks 9 and 10 need to know where a rule starts and ends, which a regular
   expression cannot express: `{}` and `{ }` are the same string to a regex, so
   an empty rule and a rule with a body are indistinguishable without counting
   braces. This walks the sheet once and yields only *style* rules — @keyframes
   steps are declarations rather than selectors, and @font-face/@page bodies
   would otherwise be read as rules with their own properties as "selectors".

   At-rule context is tracked rather than discarded, because a rule nested in
   @media still has to be reported against its own line. Nested at-rules are
   stepped *into* rather than skipped whole; leaf at-rules are skipped whole.
   Mirrors the shape tools/css-snapshot.mjs already uses to walk the DOM. */
function* styleRules(css) {
  const NESTED_AT = /^@(media|container|supports|layer|scope|document)\b/;
  const lineOfIdx = (i) => css.slice(0, i).split("\n").length;
  const endOfBlock = (from) => {
    let depth = 1;
    let k = from + 1;
    while (k < css.length && depth > 0) {
      if (css[k] === "{") depth++;
      else if (css[k] === "}") depth--;
      k++;
    }
    return k;
  };

  let i = 0;
  let preludeStart = 0;
  const atStack = [];
  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      const selector = css.slice(preludeStart, i).trim().replace(/\s+/g, " ");
      if (selector.startsWith("@")) {
        if (NESTED_AT.test(selector)) {
          atStack.push(selector);
          i++;
          preludeStart = i;
          continue;
        }
        i = endOfBlock(i);
        preludeStart = i;
        continue;
      }
      const end = endOfBlock(i);
      yield {
        selector,
        body: css.slice(i + 1, end - 1),
        line: lineOfIdx(i),
        context: atStack.join(" > "),
      };
      i = end;
      preludeStart = i;
      continue;
    }
    if (ch === "}") {
      atStack.pop();
      i++;
      preludeStart = i;
      continue;
    }
    if (ch === ";") {
      i++;
      preludeStart = i;
      continue;
    }
    i++;
  }
}

/* `box-sizing: border-box` is only ever the universal reset restated. Unlike
   margin/padding it has no legitimate per-component use here, so it can be
   flagged without a false-positive allowance. */
const UNIVERSAL_RESET = "*, *::before, *::after";

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

  // ── 9. No empty rules ───────────────────────────────────────────────────
  // A selector with no block is the residue of a consolidation: when a group of
  // near-identical rules becomes one shared base, the per-component selectors
  // are left behind as empty pairs. Three had accumulated in noir.css
  // (.result-label, .field-label, .duration-sublabel) and were invisible to
  // every other rule here, because a regex cannot tell `{}` from `{ }`.
  for (const r of styleRules(css)) {
    if (r.body.trim() === "") {
      report(file, r.line, "empty-rule", `empty rule "${r.selector}" — no declarations; delete it or the selector it was consolidated into`);
    }
  }

  // ── 10. No unused tokens ────────────────────────────────────────────────
  // A token nothing reads is a promise the stylesheet does not keep, and it is
  // how a re-theme ends up recolouring a value that was hardcoded next to it.
  // Four had accumulated: --amber-08, --z-raised, and --measure / --glow-hero,
  // which were both bypassed at their own point of use until their consumers
  // were rewired to reference them.
  //
  // Declaration sites are matched only after `^`, `;` or `{` so that a
  // selector containing a custom-property-shaped fragment is not mistaken for
  // one: `.field--cal::` declares nothing, but matches /--cal\s*:/.
  //
  // Reported once per name, at the first declaration. The print :root
  // redeclares palette tokens, so a token nobody reads would otherwise be
  // reported once per palette — five findings for four tokens the first time
  // this ran, which is the kind of noise that gets a rule switched off.
  const unused = new Map();
  for (const m of css.matchAll(/(?:^|[;{])\s*(--[a-z0-9-]+)\s*:/gm)) {
    const name = m[1];
    if (unused.has(name) || LOCAL_TOKENS.has(name)) continue;
    if (new RegExp(`var\\(\\s*${name}\\s*[,)]`).test(css)) continue;
    unused.set(name, lineOf(css, m.index));
  }
  for (const [name, line] of unused) {
    report(file, line, "unused-token", `${name} is declared but never referenced with var()`);
  }

  // ── 11. No restatement of the universal reset ───────────────────────────
  // box-sizing is only ever the reset being repeated. margin/padding are
  // deliberately NOT checked: `mark { padding: 0 }` overrides an earlier
  // `mark { padding: 0 var(--sp-1) }` at equal specificity, and telling that
  // apart from a redundant `padding: 0` needs selector-overlap reasoning this
  // linter has no business doing. A rule that cries wolf gets deleted.
  for (const r of styleRules(css)) {
    if (r.selector === UNIVERSAL_RESET) continue;
    if (/box-sizing:\s*border-box/.test(r.body)) {
      report(file, r.line, "reset", `box-sizing: border-box in "${r.selector}" — the universal reset already sets it`);
    }
  }
}

/* ── 0. One stylesheet, and it is noir.css ─────────────────────────────────
   Every page links noir.css and nothing else. There are no page <style> blocks
   and no style="" attributes: page rules live in noir.css's PAGE COMPONENTS
   section, and inline styling drifts off the token scale without anything
   noticing — a raw `letter-spacing:0.1em` sat in a style.cssText for months
   because the token checks only ever read stylesheets.

   This is the check that keeps that from eroding back. Paired with
   check-assets.mjs, which enforces that the <link> is present, the two together
   mean a page can neither drop noir.css nor quietly grow a second stylesheet.

   JS writing `el.style.x` is still allowed: those three sites compute a value
   at runtime (scroll offset, stagger index, caret position) and cannot be a
   rule. Only the declarative forms are banned. */
function checkNoInlineCss(file, raw) {
  for (const m of raw.matchAll(/<style[\s>]/g)) {
    report(file, lineOf(raw, m.index), "inline-css",
      "<style> block — all CSS lives in noir.css; add a rule and use a class");
  }
  for (const m of raw.matchAll(/\sstyle\s*=\s*["']/g)) {
    report(file, lineOf(raw, m.index), "inline-css",
      "style attribute — add a rule to noir.css and use a class");
  }
  for (const m of raw.matchAll(
    /\son(?:mouseover|mouseout|mouseenter|mouseleave|click)\s*=\s*["'][^"']*\.style\./g
  )) {
    report(file, lineOf(raw, m.index), "inline-css",
      "inline handler writing .style — use a :hover/:active rule in noir.css");
  }
}

function main() {
  console.log(`CSS convention check — ${CSS} + ${HTML.length} page(s)`);
  console.log("─".repeat(72));

  try {
    // Collect the global token vocabulary from the stylesheet first: it is the
    // only stylesheet, so this set covers every rule on the site.
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
      checkNoInlineCss(page, fs.readFileSync(path.join(ROOT, page), "utf8"));
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
