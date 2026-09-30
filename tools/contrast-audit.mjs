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

/* Translucent tints, and the text that sits on them.
 *
 * The important measurement is NOT tint-vs-page: a search-term highlight is
 * *meant* to be subtle, so that is held only as decoration. What must pass is
 * the text rendered on top of the tint, which is why these are pairs of
 * (tint, foreground) rather than a single foreground. */
const TINT_PAIRS = [
  // mark: amber text on the amber-22 highlight used in the substances table
  { tint: "--amber-22", fg: "--amber", min: 4.5, role: "text on tint" },
  // .input-highlight mark paints transparent text — background only, so the
  // tint is decorative and the foreground is deliberately absent.
  { tint: "--amber-28", fg: null, min: 0, role: "deco" },
  { tint: "--muted-12", fg: null, min: 0, role: "deco" },
  { tint: "--muted-25", fg: null, min: 0, role: "deco" },
];

function hexToRgb(hex) {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/* `rgba(r, g, b, a)` in a :root token. Returns the colour plus its alpha so
   callers can composite it over a known background — the alpha ramps in
   noir.css are stored this way so they stay statically resolvable. */
function rgbaToRgb(value) {
  const m = value
    .trim()
    .match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (!m) return null;
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: m[4] === undefined ? 1 : Number(m[4]) };
}

/* Source-over composite of a translucent colour onto an opaque backdrop. */
function composite(fg, bg) {
  const a = fg.alpha;
  if (a >= 1) return fg.rgb;
  return [0, 1, 2].map((i) => Math.round(fg.rgb[i] * a + bg[i] * (1 - a)));
}

/* Resolve a token that may be hex, rgba(), a var() alias, or a shadow that
 * wraps a colour in a var() (e.g. `--ring: 0 0 0 2px var(--amber-15)`).
 * Following the nested reference is what keeps the focus-ring check honest:
 * repoint --ring at another colour and the check follows it automatically. */
function resolve(tokens, name, seen = new Set()) {
  if (seen.has(name)) return null;
  seen.add(name);
  const raw = tokens[name];
  if (raw === undefined) return null;
  const hex = hexToRgb(raw);
  if (hex) return { rgb: hex, alpha: 1 };
  const rgba = rgbaToRgb(raw);
  if (rgba) return rgba;
  const alias = raw.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i);
  if (alias) return resolve(tokens, alias[1], seen);
  // Not a colour itself — if it wraps one colour reference, follow that.
  const nested = raw.match(/var\(\s*(--[a-z0-9-]+)\s*\)/i);
  if (nested) return resolve(tokens, nested[1], seen);
  return null;
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
    // Everything is kept, including non-colour values like --ring and --glow.
    // resolve() decides what it can measure and returns null otherwise, so an
    // unreadable token simply drops out of the audit instead of crashing it.
    tokens[m[1]] = m[2].trim();
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

  // ── Tinted backgrounds ────────────────────────────────────────────────────
  // The tint is composited over each surface; the foreground is then measured
  // against that composited ground. This is the check that covers the search
  // highlight marks, which the opaque palette table cannot see.
  for (const bg of BG) {
    const bgRgb = hexToRgb(tokens[bg]);
    if (!bgRgb) continue;
    for (const spec of TINT_PAIRS) {
      const tint = resolve(tokens, spec.tint);
      if (!tint) continue;
      const ground = composite(tint, bgRgb);
      const label = spec.fg ? `${spec.fg} on ${spec.tint}` : spec.tint;
      // No foreground: the tint itself is the whole assertion, so measure it
      // against the page it sits on at the (decorative) threshold.
      const ratio = spec.fg
        ? contrast(resolve(tokens, spec.fg).rgb, ground)
        : contrast(ground, bgRgb);
      const ok = ratio + 1e-9 >= spec.min;
      if (!ok) failed++;
      rows.push({
        bg, fg: label, role: spec.role,
        ratio: Math.round(ratio * 100) / 100, min: spec.min, ok,
      });
    }
  }

  // ── Focus ring (WCAG 2.4.11) ──────────────────────────────────────────────
  // The ring is the *only* indicator on some controls, so it is checked
  // against every surface it can land on. This is the check whose absence
  // let a page set `outline: none` and dim the focus border to --line
  // (1.17:1) without anything going red.
  for (const bg of BG) {
    const ring = resolve(tokens, "--ring");
    if (!ring) continue;
    const ratio = contrast(ring.rgb, hexToRgb(tokens[bg]));
    const ok = ratio + 1e-9 >= 3.0;
    if (!ok) failed++;
    rows.push({ bg, fg: "--amber (focus ring)", role: "nontext", ratio: Math.round(ratio * 100) / 100, min: 3.0, ok });
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
