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

  console.log(`Asset check: ${pages.length} pages scanned.`);
  if (!problems.length) {
    console.log("\x1b[32mOK\x1b[0m  all local refs resolve; nav + includes + style assets consistent.");
    process.exit(0);
  }
  console.log(`\x1b[31m${problems.length} problem(s):\x1b[0m`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

main();
