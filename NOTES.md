# Õigusmasin — workspace notes (for future agents/sessions)

Static, dependency-free site (plain HTML/CSS/JS, no build step, no bundler).
Hosted from the repo root; `main` is the deploy branch. Estonian-language legal
calculators.

## Layout
- `index.html` — **Rehkendaja**: finds & sums amounts in pasted text (modes: € / g / all numbers).
- `karistuste-liitmine.html` — combining sentences (karistuste liitmine).
- `narkonimekirjad.html` — narcotics lists I–VI (data from `data.json`).
- `ennetahtaegne-vabastamine.html` — early release.
- `isikukood.html` — Estonian personal ID / age.
- `rehkendaja-test.html` — browser test page for Rehkendaja (18 suites / 80 tests).
- `rehkendaja-core.js` — **pure** detection+formatting logic shared by Rehkendaja and its tests. No DOM, no side effects. This is what the tests exercise.
- `nav.js` — single source of truth for the sidebar (`NAV_ITEMS`). Auto-detects active page.
- `noir.css` — shared stylesheet. Pages keep only page-specific `<style>`.
- `scrape.py` — fetches narcotics data → `data.json` (run by `update-data.yml` cron).
- `data.json` — scraped narcotics data (committed; updated daily by CI).

## Requirements
Node **>= 23** to run the tests (the core regexes use duplicate named capture
groups in one pattern — V8 feature from Node 23; CI pins Node 24). Browsers: any
modern Chrome/Edge/Firefox/Safari that shipped the same feature.

## Verify before you ship (run both)
```bash
npm test        # headless Rehkendaja suites (exit 1 on failure)
npm run check   # local asset/nav integrity
npm run verify  # both
```
CI: `.github/workflows/test.yml` runs both on push/PR to `main`.
`.github/workflows/update-data.yml` refreshes `data.json` daily at 04:00 UTC.

## Tools in `tools/`
- `run-rehkendaja-tests.mjs` — headless test runner. It **slices the harness +
  `suite(...)` block straight out of `rehkendaja-test.html`** and runs it in a
  Node VM together with `rehkendaja-core.js`, so the browser page stays the single
  source of truth for tests (no duplicated specs). Extraction is marker-based:
  start `const suites = [];`, end `const output = document.getElementById("output");`.
  If you edit those markers in the HTML, update the runner.
- `check-assets.mjs` — verifies every local `href`/`src` resolves, every
  `NAV_ITEMS` href exists, every page includes `nav.js`+`noir.css` and a
  `#sidebar`, and every non-test page is listed in `nav.js`.
- `css_audit.py` — compares inline CSS across pages to spot duplicates that
  should be hoisted into `noir.css` (run: `python3 tools/css_audit.py --all`).
- `contrast-audit.mjs` — WCAG 2.1 checker for the `noir.css` design tokens
  (4.5:1 text, 3:1 non-text). Run `npm run contrast`; wired into `verify`/CI.

## Design / theming
- All page colour lives in `noir.css` `:root` tokens (zero hardcoded hex in the
  HTML pages). Retheming = editing tokens.
- Palette = **Omarchy Retro 82** (deep navy / amber / teal, cream text) —
  applied in `noir.css`. Mono font = **JetBrainsMono Nerd Font** (with web
  `JetBrains Mono` fallback). Style: sharp corners, amber glow on focus/hero,
  accent-chip active nav. (CRT scanline was trialled and **removed** — too
  noisy.)
- `docs/retro82-theme-plan.md` — the retrofit plan + rationale (phases marked).

## Conventions
- Adding a page: create `<name>.html`, incl. `noir.css` + `nav.js` + `#sidebar`,
  then add a `NAV_ITEMS` entry in `nav.js` (`npm run check` enforces this).
- Adding a Rehkendaja test: add a `suite(...)` block in `rehkendaja-test.html`;
  the headless runner picks it up automatically.
- Rehkendaja copy-to-clipboard glues amount to unit with a **non-breaking space**
  (`\u00A0`) so Word never line-breaks between the number and € / g.
- `lausepank` work lives on the `lausepank` branch and uses encrypted data
  (plaintext `lausepank-andmed.json` is gitignored; see `.vscode/tasks.json`).

## Local artifacts (gitignored)
`sessions/`, `data/stats.json` — agent runtime state, never commit.
