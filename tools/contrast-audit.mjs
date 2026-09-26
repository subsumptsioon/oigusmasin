#!/usr/bin/env node
/**
 * contrast-audit.mjs — WCAG contrast checker for the noir.css design tokens.
 *
 * Reads the `:root { ... }` custom properties from a CSS file, then checks a
 * defined set of foreground/background token pairs against WCAG 2.1 thresholds
 * (1.4.3 text 4.5:1, 1.4.11 non-text / large text 3:1).
 *
 * Usage:
 *   node tools/contrast-audit.mjs [cssFile] [--all] [--json]
 *     cssFile   default: noir.css
 *     --all     also print pairs that pass (default only prints failures + a summary)
 *     --json    machine-readable output
 *
 * Exit: 0 all required pairs pass, 1 any required pair fails, 2 parse error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// token roles -> required minimum contrast against each background
//   text   : normal-size body text            -> 4.5
//   large  : large/bold text only (accents)   -> 3.0
//   nontext: borders, focus rings, icons      -> 3.0
//   deco   : hairlines / purely decorative    -> 0 (informational)
const FG = {
  "--text": { role: "text", min: 4.5 },
  "--muted": { role: "text", min: 4.5 },
  "--dim": { role: "text", min: 4.5 },
  "--amber": { role: "large", min: 3.0 },
  "--red": { role: "large", min: 3.0 },
  "--border": { role: "nontext", min: 3.0 },
  "--line": { role: "deco", min: 0 },
};
const BG = ["--void", "--deep", "--surface", "--lift"];

function hexToRgb(hex) {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function relLum([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(rgb1, rgb2) {
  const l1 = relLum(rgb1);
  const l2 = relLum(rgb2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function parseTokens(css) {
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
  if (!rootMatch) return {};
  const tokens = {};
  for (const m of rootMatch[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const val = m[2].trim();
    if (/^#[0-9a-f]{3,6}$/i.test(val)) tokens[m[1]] = val;
  }
  return tokens;
}

function main() {
  const args = process.argv.slice(2);
  const cssArg = args.find((a) => !a.startsWith("--")) || path.join(ROOT, "noir.css");
  const showAll = args.includes("--all");
  const asJson = args.includes("--json");
  const css = fs.readFileSync(cssArg, "utf8");
  const tokens = parseTokens(css);

  const missing = [...Object.keys(FG), ...BG].filter((t) => !tokens[t]);
  if (missing.length) {
    console.error(`parse error: missing tokens in ${path.basename(cssArg)}: ${missing.join(", ")}`);
    process.exit(2);
  }

  const rows = [];
  let failed = 0;
  for (const bg of BG) {
    for (const [fg, spec] of Object.entries(FG)) {
      const ratio = contrast(hexToRgb(tokens[fg]), hexToRgb(tokens[bg]));
      const ok = ratio + 1e-9 >= spec.min;
      if (!ok) failed++;
      rows.push({ bg, fg, role: spec.role, ratio: Math.round(ratio * 100) / 100, min: spec.min, ok });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ file: path.basename(cssArg), tokens, rows, failed }, null, 2));
    process.exit(failed ? 1 : 0);
  }

  console.log(`WCAG contrast audit — ${path.basename(cssArg)}`);
  console.log("─".repeat(72));
  const show = showAll ? rows : rows.filter((r) => !r.ok);
  for (const r of show) {
    const mark = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(
      `${mark} ${r.fg.padEnd(9)} on ${r.bg.padEnd(9)} ${String(r.ratio).padStart(6)}:1  ` +
        `(min ${r.min}, ${r.role})`,
    );
  }
  if (!showAll && !show.length) console.log("(all required pairs pass)");
  console.log("─".repeat(72));
  console.log(
    failed
      ? `\x1b[31mFAIL\x1b[0m  ${failed} of ${rows.length} pairs below threshold`
      : `\x1b[32mPASS\x1b[0m  all ${rows.length} pairs meet their WCAG threshold`,
  );
  process.exit(failed ? 1 : 0);
}

main();
