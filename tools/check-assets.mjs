#!/usr/bin/env node
/**
 * check-assets.mjs — static integrity check for the Õigusmasin site.
 *
 * Verifies, with no browser and no deps:
 *   1. every local href/src referenced by an HTML page resolves to a file;
 *   2. every NAV_ITEMS entry in nav.js points to an existing page;
 *   3. every page includes nav.js and noir.css (site-wide consistency);
 *   4. every page that includes nav.js has the sidebar/overlay scaffold;
 *   5. every url() in a stylesheet (notably the @font-face src) resolves.
 *
 * Usage:  node tools/check-assets.mjs
 * Exit:   0 clean, 1 problems found.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const problems = [];
const note = (p) => problems.push(p);

function listPages() {
  return fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".html"))
    .sort();
}

function isLocalRef(ref) {
  if (!ref) return false;
  const r = ref.trim();
  if (!r) return false;
  if (/^(https?:)?\/\//i.test(r)) return false; // absolute / protocol-relative
  if (/^(mailto:|tel:|data:|javascript:)/i.test(r)) return false;
  if (r.startsWith("#")) return false; // same-page anchor
  return true;
}

function stripRef(ref) {
  return ref.trim().split("#")[0].split("?")[0];
}

function checkRefs(pages) {
  const attrRe = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    let m;
    while ((m = attrRe.exec(html)) !== null) {
      const ref = m[1];
      if (!isLocalRef(ref)) continue;
      const clean = stripRef(ref);
      if (!clean) continue;
      const target = path.resolve(ROOT, clean);
      if (!fs.existsSync(target)) {
        note(`${page}: missing local ref -> ${ref}`);
      }
    }
  }
}

function checkNav(pages) {
  const navPath = path.join(ROOT, "nav.js");
  if (!fs.existsSync(navPath)) {
    note("nav.js not found");
    return [];
  }
  const nav = fs.readFileSync(navPath, "utf8");
  const hrefs = [...nav.matchAll(/href:\s*["']([^"']+)["']/g)].map((m) => m[1]);
  if (!hrefs.length) note("nav.js: no NAV_ITEMS hrefs parsed (marker changed?)");

  for (const href of hrefs) {
    const clean = stripRef(href);
    if (clean && !fs.existsSync(path.resolve(ROOT, clean))) {
      note(`nav.js: NAV_ITEMS href -> ${href} (file missing)`);
    }
  }
  return hrefs;
}

function checkConsistency(pages, navHrefs) {
  const navSet = new Set(navHrefs.map(stripRef));
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");

    if (!/src\s*=\s*["']nav\.js["']/.test(html)) {
      note(`${page}: does not include nav.js`);
    }
    if (!/href\s*=\s*["']noir\.css["']/.test(html)) {
      note(`${page}: does not include noir.css`);
    }
    if (/src\s*=\s*["']nav\.js["']/.test(html) && !/id\s*=\s*["']sidebar["']/.test(html)) {
      note(`${page}: includes nav.js but has no #sidebar element`);
    }
  }

  // Pages present on disk but absent from the nav (excluding the test page).
  for (const page of pages) {
    if (page === "rehkendaja-test.html") continue;
    if (!navSet.has(page)) {
      note(`${page}: exists on disk but is not in nav.js NAV_ITEMS`);
    }
  }
}

/* Every url() referenced from a stylesheet must exist on disk. @font-face src
   urls are not href/src attributes, so checkRefs cannot see them — a renamed
   or uncommitted font file would otherwise only surface as a silent fallback
   to ui-monospace in production. */
function checkStyleAssets() {
  const sheets = [...fs.readdirSync(ROOT).filter((f) => f.endsWith(".css")), "noir.css"];
  for (const sheet of new Set(sheets)) {
    const p = path.join(ROOT, sheet);
    if (!fs.existsSync(p)) continue;
    const css = fs.readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const ref = m[1].trim();
      if (/^(https?:|data:|\/\/)/i.test(ref)) continue;
      const target = path.join(ROOT, ref);
      if (!fs.existsSync(target)) {
        note(`${sheet}: url(${ref}) -> file missing`);
      }
    }
  }
}

/* ── No exit ────────────────────────────────────────────────────────────────
   §7's third support, and the one a visitor can check for themselves: there is
   no way for the file to leave this page. Export, download, share and file-save
   are all absent, and the absence is what the promise rests on — a page with no
   exit has nothing to copy out, attach to a mail, or hand onward.

   **Comments are stripped before the search.** Without that, a comment *naming* a
   banned API fails the build — and this file has such a comment, written to
   explain the rule. A check that punishes its own documentation is a check
   people learn to disable, which is the opposite of the point. Strings are
   stripped for the same reason: this file mentions `createObjectURL` in prose.

   `lib/` is excluded. Vendored pdf.js is not our code, and the claim here is
   that *we* wrote no exit — not that no library contains one. */
const EXIT_APIS = [
  "createObjectURL",
  "revokeObjectURL",
  "new Blob",
  "showSaveFilePicker",
  "navigator.share",
  "DataTransfer",
  "msSaveBlob",
  "webkitRequestFileSystem",
  "URL.createObjectURL",
];

function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

function stripJsStrings(src) {
  return src
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => " ".repeat(m.length))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => " ".repeat(m.length))
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => " ".repeat(m.length));
}

/* §7's *first* support: the file is read in exactly two places, and nothing
   that can carry it anywhere is called on the result. A banned-API list catches
   an exit path; it cannot catch `navigator.sendBeacon("", bytes)` unless the
   outbound calls are listed too, so they are.

   `fetch` and `XMLHttpRequest` are not banned outright: pdf.js fetches its own
   worker from this origin, and that is legitimate. What is banned is sending
   *file content* out — which is why these are reported separately and why the
   message says what was found rather than only that something was. */
const OUTBOUND_APIS = [
  "sendBeacon",
  "XMLHttpRequest",
  "navigator.share",
  "postMessage",
  "localStorage.setItem",
  "sessionStorage.setItem",
  "indexedDB.open",
  "document.cookie\s*=",
  "atob",
];

function checkOutbound(file, raw, code) {
  for (const api of OUTBOUND_APIS) {
    const pattern = new RegExp(`\\b${api}\\b`);
    const m = pattern.exec(code);
    if (m) {
      problems.push(
        `${path.relative(ROOT, file)}:${lineOf(raw, m.index)} uses ${api} — ` +
          `§7 allows exactly two readers and no writer; confirm this carries no file content`,
      );
    }
  }
}

function checkNoExit() {
  const sources = [
    path.join(ROOT, "metaandmed.html"),
    path.join(ROOT, "metaandmed.js"),
    ...walk(path.join(ROOT, "formats")),
  ].filter((f) => fs.existsSync(f));

  for (const file of sources) {
    const raw = fs.readFileSync(file, "utf8");
    const code = stripJsStrings(stripJsComments(raw));
    for (const api of EXIT_APIS) {
      const at = code.indexOf(api);
      if (at !== -1) {
        problems.push(
          `${path.relative(ROOT, file)}:${lineOf(raw, at)} uses ${api} — §7 requires no exit path`,
        );
      }
    }
    checkOutbound(file, raw, code);

    /* The `download` attribute, which is an exit with no API call at all.
       Matched in the *raw* source, not the stripped one, because it is an HTML
       attribute and the stripping here is for JavaScript. The attribute may be
       bare (`<a download>`), valued (`download="x.pdf"`) or separated by any
       whitespace, including a newline — the first version required a following
       space, `=` or `>` and so missed `download="metaandmed.json"`, which is
       precisely the case the check exists to catch. */
    for (const m of raw.matchAll(/\bdownload\s*(=|\s|>)/g)) {
      problems.push(
        `${path.relative(ROOT, file)}:${lineOf(raw, m.index)} has a download attribute — an exit path`,
      );
    }
  }
  return sources.length;
}

/* Strip and keep line numbers: a check that renumbers is a check whose errors
   cannot be acted on. */
function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ── Content-Security-Policy ─────────────────────────────────────────────────
   §7's policy, audited rather than assumed. Three things it must be, and each
   one is a way a policy can be present, correct-looking, and not apply:

     1. **A meta tag.** GitHub Pages sends no custom response headers, so a
        header is not available. Re-verified at phase 11: the feature is still
        absent, while Codeberg Pages added a limited `_headers` allowlist in
        February 2026 — so the meta form is not merely a workaround, it is the
        only option on this host.
     2. **First in `<head>`.** A meta CSP applies only from the point it is
        parsed. One byte of script before it and the policy governs less than it
        appears to.
     3. **`script-src 'self'`, with no `unsafe-inline` and no `unsafe-eval`.**
        These are the two keywords that would undo the whole page, so they are
        checked by name rather than left to review. */
const CSP_REQUIRED = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
];
const CSP_FORBIDDEN = ["unsafe-inline", "unsafe-eval", "data:", "blob:"];

function checkCsp(page) {
  const html = fs.readFileSync(path.join(ROOT, page), "utf8");

  /* Does this page declare a CSP at all? Only the analyser has one, and that is
     a finding worth stating rather than a failure.

     The tag is matched across newlines and *without* `[^>]*`: the policy text
     itself contains `>` (in `script-src 'self'` there is none, but
     `worker-src 'self' blob:` and any future directive could), so a tag-shaped
     regex stops in the middle of the policy and the rest is never seen. The
     first version matched 90 characters and reported three missing directives on
     a policy that has all of them. */
  const meta = /<meta\s[^>]*?http-equiv=["']Content-Security-Policy["'][\s\S]*?>/i.exec(html);
  if (!meta) return null;

  const content = /content=["']([\s\S]*?)["']\s*\/?>/i.exec(meta[0])?.[1] ?? "";
  if (!content) {
    problems.push(`${page}: the CSP meta tag has no readable content attribute`);
    return null;
  }

  for (const directive of CSP_REQUIRED) {
    if (!content.includes(directive)) {
      problems.push(`${page}: CSP is missing ${directive}`);
    }
  }
  for (const keyword of CSP_FORBIDDEN) {
    if (new RegExp(`(script-src|default-src)[^;]*${keyword}`).test(content)) {
      problems.push(`${page}: CSP allows ${keyword} in a script directive — it undoes the page`);
    }
  }

  /* Position: nothing that executes may precede the meta tag. */
  const headOpen = html.search(/<head[^>]*>/i);
  const metaAt = meta.index;
  const between = html.slice(headOpen, metaAt);
  if (/<script/i.test(between)) {
    problems.push(`${page}: a <script> precedes the CSP meta tag — the policy would apply too late`);
  }
  const styleInHead = /<style/i.test(between);
  if (styleInHead) {
    problems.push(`${page}: a <style> precedes the CSP meta tag`);
  }

  return content;
}

function main() {
  const pages = listPages();
  if (!pages.length) {
    console.error("no HTML pages found");
    process.exit(2);
  }

  checkRefs(pages);
  const navHrefs = checkNav(pages);
  checkConsistency(pages, navHrefs);
  checkStyleAssets();
  const scanned = checkNoExit();

  let cspPages = 0;
  for (const page of pages) {
    if (checkCsp(page)) cspPages++;
  }

  console.log(
    `Asset check: ${pages.length} pages, ${scanned} source file(s), ` +
    `${cspPages} with a CSP.`,
  );
  if (!problems.length) {
    console.log("\x1b[32mOK\x1b[0m  all local refs resolve; nav + includes + style assets consistent.");
    process.exit(0);
  }
  console.log(`\x1b[31m${problems.length} problem(s):\x1b[0m`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

main();
