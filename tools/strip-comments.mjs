/* Build the comment-free tree that the `release` branch serves, and check that
 * a tree already is comment-free.
 *
 *   node tools/strip-comments.mjs --check --root <dir>
 *   node tools/strip-comments.mjs --write <out> --root <dir>
 *
 * The manifest is the contract: `release` carries exactly these files. Anything
 * else in the repo — tools, workflows, journals, the scraper — stays on `dev`,
 * where it is also no longer publicly reachable from GitHub Pages.
 *
 * `data/stats.json` is deliberately absent: nothing references it and it holds
 * absolute paths from the machine that generated it.
 */
import fs from "node:fs";
import path from "node:path";
import { stripJs } from "./js-strip.mjs";
import { resolveRoot } from "./root.mjs";

/* The five pages a visitor can reach. */
export const PAGES = [
  "index.html",
  "isikukood.html",
  "karistuste-liitmine.html",
  "narkonimekirjad.html",
  "ennetahtaegne-vabastamine.html",
];

const STYLES_AND_SCRIPTS = ["noir.css", "nav.js", "rehkendaja-core.js"];
const DATA = ["data.json"];
const ASSET_DIRS = ["fonts"];

/* Stripped and verified, but not shipped: the test page exists so the unit
 * suite has a DOM harness to load, not so a visitor can open it. */
export const VERIFY_ONLY = ["rehkendaja-test.html"];

export function shippedFiles(root) {
  const files = [...PAGES, ...STYLES_AND_SCRIPTS, ...DATA];
  for (const dir of ASSET_DIRS) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full).sort()) {
      files.push(path.join(dir, entry));
    }
  }
  return files;
}

export function verifyFiles(root) {
  return [...shippedFiles(root), ...VERIFY_ONLY];
}

/** Remove the comment at `start..end` from what has been emitted so far.
 *
 *  A comment alone on its line takes the line with it, plus any run of blank
 *  lines behind it. Anything else becomes a single space, so that
 *  `a/*x*` mid-expression cannot collapse two tokens into one.
 *
 *  Returns the new output and the index to resume from. Resuming matters: an
 *  earlier version kept the right text but stopped scanning, which let every
 *  comment after the first one survive into the release build.
 */
function dropComment(out, src, start, end) {
  const lineStart = out.lastIndexOf("\n") + 1;
  const beforeBlank = out.slice(lineStart).trim() === "";
  const nl = src.indexOf("\n", end);
  const afterBlank = src.slice(end, nl === -1 ? src.length : nl).trim() === "";

  if (!beforeBlank || !afterBlank) {
    return { out: out + " ", next: end };
  }

  let next = nl === -1 ? src.length : nl + 1;
  for (;;) {
    const rest = src.indexOf("\n", next);
    const line = src.slice(next, rest === -1 ? src.length : rest);
    if (line.trim() !== "") break;
    if (rest === -1) {
      next = src.length;
      break;
    }
    next = rest + 1;
  }

  return { out: out.slice(0, lineStart), next };
}

export function stripCss(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? src.length : close + 2;
      const result = dropComment(out, src, i, end);
      out = result.out;
      i = result.next;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

/* HTML comments, with <script> and <style> bodies handed to the right stripper.
 * A `<!--` inside a script is a legacy comment, so the boundaries have to be
 * found before the comment scan starts. */
export function stripHtml(src) {
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  const styleRe = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
  const blocks = [];

  for (const m of src.matchAll(scriptRe)) {
    const external = /\bsrc\s*=/i.test(m[1]);
    blocks.push({
      start: m.index,
      end: m.index + m[0].length,
      tag: "script",
      attrs: m[1],
      body: external ? "" : m[2],
    });
  }
  for (const m of src.matchAll(styleRe)) {
    blocks.push({ start: m.index, end: m.index + m[0].length, tag: "style", attrs: m[1], body: m[2] });
  }
  blocks.sort((a, b) => a.start - b.start);

  let out = "";
  let cursor = 0;
  for (const block of blocks) {
    out += stripHtmlRegion(src.slice(cursor, block.start));
    const body = block.tag === "script" ? stripJs(block.body) : stripCss(block.body);
    out += `<${block.tag}${block.attrs}>${body}</${block.tag}>`;
    cursor = block.end;
  }
  out += stripHtmlRegion(src.slice(cursor));
  return out;
}

/** Comment-only removal for a stretch of HTML with no script or style in it. */
function stripHtmlRegion(region) {
  let out = "";
  let i = 0;
  while (i < region.length) {
    if (region[i] === "<" && region.startsWith("<!--", i)) {
      const close = region.indexOf("-->", i + 4);
      const end = close === -1 ? region.length : close + 3;
      const result = dropComment(out, region, i, end);
      out = result.out;
      i = result.next;
      continue;
    }
    out += region[i];
    i++;
  }
  return out;
}

/** Which stripper a file gets. Anything unlisted is copied byte for byte. */
export function stripFile(rel, content) {
  if (rel.endsWith(".js")) return stripJs(content);
  if (rel.endsWith(".css")) return stripCss(content);
  if (rel.endsWith(".html")) return stripHtml(content);
  return content;
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

/** Only these get read as text and rewritten. Everything else — fonts, JSON,
 *  licence files — is copied as bytes, because decoding a .woff2 through UTF-8
 *  replaces every invalid sequence and silently destroys it. */
export function isStrippable(rel) {
  return /\.(js|css|html)$/i.test(rel);
}

export function check(root) {
  const violations = [];
  for (const rel of verifyFiles(root)) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) {
      violations.push({ rel, reason: "missing from the release tree" });
      continue;
    }
    if (!isStrippable(rel)) continue;

    const content = fs.readFileSync(full, "utf8");
    const stripped = stripFile(rel, content);
    if (stripped !== content) {
      const removed = content.split("\n").length - stripped.split("\n").length;
      violations.push({
        rel,
        reason: `${removed > 0 ? `${removed} comment line(s)` : "an inline comment"} still present`,
      });
    }
  }
  return violations;
}

export function write(outDir, root, { includeVerifyOnly = true } = {}) {
  const files = includeVerifyOnly ? verifyFiles(root) : shippedFiles(root);
  let bytesIn = 0;
  let bytesOut = 0;

  for (const rel of files) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const raw = fs.readFileSync(src);
    bytesIn += raw.length;
    let buf;
    if (isStrippable(rel)) {
      buf = Buffer.from(stripFile(rel, raw.toString("utf8")), "utf8");
    } else {
      buf = raw;
    }
    bytesOut += buf.length;
    fs.writeFileSync(dest, buf);
  }

  return { files: files.length, bytesIn, bytesOut };
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolveRoot(argv);

  if (argv.includes("--check")) {
    const violations = check(root);
    console.log("─".repeat(72));
    console.log(`Comment-free check — ${root}`);
    console.log("─".repeat(72));
    if (!violations.length) {
      console.log("OK  every shipped file is comment-free.");
      process.exit(0);
    }
    for (const v of violations) console.log(`  ${v.rel}: ${v.reason}`);
    console.log(`\nFAIL  ${violations.length} file(s) carry comments.`);
    process.exit(1);
  }

  if (argv.includes("--write")) {
    const out = flag("--write");
    if (!out) {
      console.error("--write needs an output directory");
      process.exit(2);
    }
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const stats = write(out, root);
    const pct = stats.bytesIn ? Math.round((1 - stats.bytesOut / stats.bytesIn) * 100) : 0;
    console.log(`Stripped ${stats.files} files -> ${out}`);
    console.log(`  ${(stats.bytesIn / 1024).toFixed(1)} kB -> ${(stats.bytesOut / 1024).toFixed(1)} kB (${pct}% smaller)`);
    process.exit(0);
  }

  console.log("usage: node tools/strip-comments.mjs (--check | --write <dir>) [--root <dir>]");
  process.exit(2);
}
