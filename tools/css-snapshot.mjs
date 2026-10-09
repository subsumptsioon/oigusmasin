#!/usr/bin/env node
/**
 * css-snapshot.mjs — capture computed style + geometry for the site's shared
 * components, so a CSS refactor can be diffed instead of eyeballed.
 *
 * No npm deps: drives Chromium over the DevTools Protocol using Node's built-in
 * global WebSocket (Node >= 22), same harness shape as smoke-test.mjs.
 *
 * Usage:
 *   node tools/css-snapshot.mjs                  # print flat map
 *   node tools/css-snapshot.mjs --save f.json    # write baseline
 *   node tools/css-snapshot.mjs --diff f.json    # diff against baseline
 *   node tools/css-snapshot.mjs --page index.html
 *
 * Every entry is `page|selector|prop` -> value so the output diffs cleanly with
 * plain `diff`. `textWidth` is a canvas measurement of a fixed probe string in
 * the element's own computed font, which is what catches a real font-fallback
 * change (the computed `font-family` stack is just the declaration echoed back).
 *
 * Pseudo-elements that carry chrome are captured via the PSEUDOS list: without
 * it a rule that exists only on ::before/::after is invisible to the diff. They
 * record style only — a pseudo has no box, so w/h/textWidth would be noise.
 *
 * A selector that matches nothing is skipped rather than reported, so a rule can
 * rot unnoticed. When adding one, confirm it resolves (`rg 'sel' baseline`).
 *
 * Exit: 0 clean (or diff with no differences), 1 diff found changes, 2 harness error.
 */
import fs from "node:fs";
import path from "node:path";
import { launch, pages as allPages } from "./cdp.mjs";

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  return i === -1 ? null : argv[i + 1];
};
const saveTo = flag("--save");
const diffFrom = flag("--diff");
const only = flag("--page");

const PAGES = allPages(only);

/* Components whose type/spacing/colour we care about. Kept flat and selector-
 * only so a missing component shows up as a MISSING line rather than silently
 * vanishing. */
const SELECTORS = [
  "body",
  ".brand-name",
  ".nav-item",
  ".nav-sigil",
  ".sidebar-foot",
  ".title-block h1",
  ".title-block .subtitle",
  ".subtitle-label",
  ".subtitle-date",
  ".stat-pill",
  ".pill-label",
  ".pill-n",
  ".search-zone",
  ".search-inner",
  "#search",
  ".search-clear",
  "#result-count",
  "main",
  ".panel",
  ".panel-header",
  ".header-row",
  ".panel-body",
  ".result-block",
  ".result-header",
  ".result-label",
  ".result-body",
  ".result-body--inline",
  ".result-body--stack",
  ".result-figure",
  ".result-figure--md",
  ".result-unit",
  ".copy-btn",
  ".field-label",
  ".duration-row",
  ".duration-sublabel",
  ".list-section",
  ".list-header",
  ".list-sigil",
  ".list-info .n",
  ".list-info .d",
  ".count-badge",
  ".chevron",
  ".substances-table",
  ".substances-table thead th",
  ".substances-table td",
  ".row-num",
  ".et-name",
  ".en-name",
  "mark",
  ".no-results",
  "footer",
  "#loading",
  // page-specific
  ".input-wrap",
  ".input-highlight",
  "#input-text",
  ".reset-btn",
  ".elements-list",
  ".elements-list li",
  ".el-num",
  ".sum-value",
  ".count-value",
  ".unit-switcher",
  ".unit-btn",
  ".operator",
  ".panel-note",
  ".field-group",
  ".result-fraction",
  ".result-legal-label",
  ".result-min-note",
  ".input-section",
  ".code-suffix",
  "#code-input",
  ".input-clear",
  ".input-hint",
  ".or-separator",
  ".dob-section",
  "#dob-input",
  ".ref-section",
  ".control-row",
  "#ref-input",
  ".ref-today-btn",
  "#ref-calendar",
  ".age-main",
  ".age-detail",
  ".idle-state",
  ".field",
  ".field--code",
  ".field--cal",
  ".pill-bar[data-list=\"3\"]",
  ".list-sigil[data-list=\"3\"]",
  // Utilities and page state classes
  ".list-section--last",
  ".source-link",
  // Rehkendaja test page
  ".tool-wrap",
  ".result-block.animate",
  ".code-input-wrap",
  // Modifiers — these replaced page-level overrides that used to be scoped by
  // stylesheet order. Track them, or a leak back to every page goes unseen.
  ".field-label--spaced",
  ".panel-body--stack",
  ".result-header--stack",
  ".result-block--full",
  ".suite",
  ".suite-title",
  ".test",
  ".test-icon",
  ".test-name",
  ".test-detail",
  ".test-extra",
  ".summary",
  ".summary-pass",
  ".summary-fail",
  ".summary-total",
];

/* Pseudo-elements that carry real chrome. querySelector cannot reach a pseudo,
 * so these are measured as (base selector, pseudo) pairs — without them a rule
 * that only exists on ::before/::after is invisible to the diff. */
const PSEUDOS = [
  [".or-separator", "::before"],
  [".or-separator", "::after"],
  [".header-chrome", "::after"],
];

/* Runs in the page. Returns { key: value } flat pairs. */
const COLLECT = `(async () => {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const PROBE = "Õigusmasin 0123 € g";
  const round = (n) => Math.round(n * 10) / 10;
  const out = {};
  const selectors = ${JSON.stringify(SELECTORS)};
  const pseudos = ${JSON.stringify(PSEUDOS)};
  const page = location.pathname.split("/").pop();
  const measure = (el, sel, pseudo) => {
    const cs = getComputedStyle(el, pseudo || null);
    const key = (p) => page + "|" + sel + "|" + p;
    out[key("font-size")] = cs.fontSize;
    out[key("letter-spacing")] = cs.letterSpacing;
    out[key("font-weight")] = cs.fontWeight;
    out[key("line-height")] = cs.lineHeight;
    out[key("color")] = cs.color;
    out[key("background")] = cs.backgroundColor;
    out[key("border-color")] = cs.borderTopColor;
    out[key("padding")] = cs.padding;
    out[key("gap")] = cs.gap;
    if (pseudo) return; // no box of its own: w/h/textWidth would be noise
    const r = el.getBoundingClientRect();
    out[key("w")] = round(r.width) + "px";
    out[key("h")] = round(r.height) + "px";
    out[key("textWidth")] = (ctx.font = cs.font || (cs.fontWeight + " 16px " + cs.fontFamily), Math.round(ctx.measureText(PROBE).width * 10) / 10) + "px";
  };
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    measure(el, sel, null);
  }
  for (const [sel, pseudo] of pseudos) {
    const el = document.querySelector(sel);
    if (!el) continue;
    measure(el, sel + pseudo, pseudo);
  }
  return out;
})()`;

async function main() {
  /* Pin the device scale factor and hide scrollbars so geometry is comparable
   * run to run — a scrollbar appearing changes every width on the page. */
  const env = await launch({
    extraArgs: ["--force-device-scale-factor=1", "--hide-scrollbars"],
  });

  const flat = {};
  let exitCode = 0;
  try {
    for (const page of PAGES) {
      const { targetId, sessionId } = await env.open(page, { settle: 400 });
      try {
        const res = await env.eval(COLLECT, sessionId);
        Object.assign(flat, res);
      } catch (err) {
        console.error(`${page}: ${err.message}`);
        exitCode = 2;
      }
      await env.close_(targetId);
    }

    const lines = Object.keys(flat).sort().map((k) => `${k} = ${flat[k]}`);

    if (saveTo) {
      fs.writeFileSync(path.resolve(saveTo), lines.join("\n") + "\n");
      console.log(`saved ${lines.length} entries -> ${saveTo}`);
    } else if (diffFrom) {
      const basePath = path.resolve(diffFrom);
      if (!fs.existsSync(basePath)) {
        console.error(`no baseline at ${diffFrom}`);
        exitCode = 2;
      } else {
        const parse = (ls) =>
          new Map(ls.map((l) => {
            const i = l.lastIndexOf(" = ");
            return [l.slice(0, i), l.slice(i + 3)];
          }));
        const before = parse(fs.readFileSync(basePath, "utf8").split("\n").filter(Boolean));
        const after = parse(lines);
        const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
        let changed = 0;
        for (const k of keys) {
          const a = before.get(k);
          const b = after.get(k);
          if (a === b) continue;
          changed++;
          if (a === undefined) console.log(`  \x1b[32m+ ${k}\x1b[0m = ${b}`);
          else if (b === undefined) console.log(`  \x1b[31m- ${k}\x1b[0m = ${a}`);
          else console.log(`  \x1b[33m~ ${k}\x1b[0m: ${a} -> ${b}`);
        }
        console.log(changed
          ? `\n\x1b[33m${changed} change(s)\x1b[0m across ${after.size} tracked values.`
          : `\x1b[32mno changes\x1b[0m across ${after.size} tracked values.`);
        if (changed) exitCode = 1;
      }
    } else {
      console.log(lines.join("\n"));
    }
  } catch (err) {
    console.error("harness error:", err?.message || err);
    exitCode = 2;
  } finally {
    await env.close();
  }
  /* Exiting inside the try would skip the finally, leaving Chromium and its
   * temp profile running. */
  process.exit(exitCode);
}

main();
