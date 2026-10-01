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
- `rehkendaja-test.html` — browser test page for Rehkendaja (24 suites / 115 tests).
- `rehkendaja-core.js` — **pure** detection+formatting logic shared by Rehkendaja and its tests. No DOM, no side effects. This is what the tests exercise.
- `nav.js` — single source of truth for the sidebar (`NAV_ITEMS`). Auto-detects active page.
- `noir.css` — the whole design system: tokens, layout, and shared components
  (`.field`, `.panel`, `.result-*`, `.list-*`, the label base). Pages keep only
  genuinely page-specific rules in their own `<style>`, and `npm run css` fails
  the build if a page re-declares something that belongs to a component.
- `fonts/` — self-hosted JetBrainsMono Nerd Font (subset WOFF2, OFL 1.1). See
  `fonts/README.md` for provenance and how to regenerate.
- `scrape.py` — fetches narcotics data → `data.json` (run by `update-data.yml` cron).
- `data.json` — scraped narcotics data (committed; updated daily by CI).

## Requirements
Node **>= 23** to run the tests (the core regexes use duplicate named capture
groups in one pattern — V8 feature from Node 23; CI pins Node 24). Browsers: any
modern Chrome/Edge/Firefox/Safari that shipped the same feature, plus
`@container` and `color-scheme` (Chrome 111+/Safari 16.2+/Firefox 113+).

**Font:** the site asks only for **JetBrainsMono Nerd Font** and serves it
itself — see `fonts/`. There is no webfont CDN and no dependency on the visitor
having the font installed: the two weights the design uses are self-hosted as
subset WOFF2 (~81 KB each) and declared in `@font-face` at the top of
`noir.css`, with `local()` listed first so anyone who *does* have the Nerd Font
installed skips the download. The family name in `@font-face` matches the first
entry of `--mono`, so the stack resolves either way. The Nerd Font ships
Regular/Bold only, so `font-weight` 500 and 800 were snapped to 400 and 700
rather than left to be synthesised. Italic is not shipped — nothing uses it.
`fonts/README.md` documents provenance (OFL 1.1), the subset ranges, and how to
regenerate.

## Verify before you ship
```bash
npm test        # headless Rehkendaja suites (exit 1 on failure)
npm run check   # local asset/nav integrity
npm run contrast # WCAG token audit (opaque pairs + tinted grounds + focus ring)
npm run css     # CSS convention lint (tokens, scales, breakpoints, focus)
npm run verify  # all four of the above

npm run dom     # DOM regression tests for the tool pages (needs `chromium`)
npm run smoke   # load every page in Chromium, report JS/console errors (needs `chromium`)
npm run snapshot            # dump computed style + geometry for every component
npm run snapshot -- --save f.json   # keep as a baseline
npm run snapshot -- --diff f.json   # see what a refactor actually moved
```
`dom`/`smoke` are local-only (not in CI) because they need a Chromium binary.
`.baseline/css-current.txt` holds a current snapshot baseline (1606 values,
verified clean). Diff against it before and after any type, spacing or layout
change — `node tools/css-snapshot.mjs --diff .baseline/css-current.txt` — then
refresh it with `--save` once the change is accepted. It is scratch, not a
source of truth; delete and re-create freely. Prefer it to eyeballing: the
figures are measured, not judged.
CI: `.github/workflows/test.yml` runs the four `verify` steps on push/PR to `main`.
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
  `#sidebar`, every non-test page is listed in `nav.js`, and every `url()` in a
  stylesheet resolves (so a renamed font file fails CI instead of silently
  falling back to `ui-monospace`).
- `css_audit.py` — compares inline CSS across pages to spot duplicates that
  should be hoisted into `noir.css` (run: `python3 tools/css_audit.py --all`).
- `contrast-audit.mjs` — WCAG 2.1 checker for the `noir.css` design tokens.
  Covers three families: opaque fg/bg pairs, **text on translucent tints**
  (composited over each surface first), and the **focus ring** against every
  surface. The last one exists because a focus ring that resolves to a
  near-invisible colour used to pass CI silently — see `--json` for the rows.
  Run `npm run contrast`; wired into `verify`/CI.
- `check-css.mjs` — convention lint for the stylesheets, no npm deps. Enforces
  that every `var(--x)` is a real token, that no raw colour appears outside a
  `:root` palette block, and that type/spacing/z-index/breakpoints come from
  the documented scales. The `outline: none` and `100vh` rules each exist
  because they caught a real regression. Run `npm run css`; wired into
  `verify`/CI.
- `css-snapshot.mjs` — measures computed style + geometry (incl. a canvas
  text-width probe, which is what catches a real font-fallback change) for
  every shared component on all 5 pages, and diffs two runs. Use it before and
  after any change to type, spacing or layout.
- `dom-tests.mjs` — regression checks for the *inline* logic of the tool pages
  (isikukood, narkonimekirjad, index, karistuste-liitmine, ennetähtaegne) that
  the pure-core runner can't reach. Loads each page in headless Chromium over the
  DevTools Protocol (no npm deps; Node built-in `WebSocket`) and asserts page
  globals. Add a check to `CHECKS`. Run `npm run dom`.
- `smoke-test.mjs` — loads every page in headless Chromium and fails on any
  uncaught exception / console error. `npm run smoke`.
- `page-eval.mjs` — one-off probe: `node tools/page-eval.mjs <page> "<expr>"`
  evaluates JS in a loaded page (handy while debugging).

## Design / theming
- All page colour lives in `noir.css` `:root` tokens, and `npm run css` now
  *enforces* that — a hardcoded hex/rgb outside a `:root` block fails CI.
  Retheming = editing tokens. The `@media print` block is a second `:root`
  (a paper palette), which is the one sanctioned place for raw hex.
- Token families: palette (`--void`…`--dim`, `--l2`…`--l6`), alpha ramps
  (`--amber-08`…`--amber-50`, `--muted-12/25`, `--scrim`), type scale
  (`--fs-xs`…`--fs-hero`), tracking (`--track-tight/wide/caps`), spacing
  (`--sp-1`…`--sp-9`), stacking (`--z-raised`…`--z-drawer`). Ad-hoc px/em
  values in those four categories are a lint error.
- Breakpoints are a **documented convention, not tokens** — plain CSS cannot
  read a custom property inside a media query without a build step. Viewport:
  `900px`, `800px`. Container: `860px`, keyed to available content width
  (`.page-content` is the container) because the sidebar eats 260px.
- Palette = **Omarchy Retro 82** (deep navy / amber / teal, cream text).
  Mono = **JetBrainsMono Nerd Font**, self-hosted from `fonts/`. Sharp corners
  (`--radius: 0`), amber glow on focus/hero, accent-chip active nav.
- The body sets the mono stack, so individual rules must **not** repeat
  `font-family: var(--mono)` — and no rule may opt out to a proportional
  face. There is no second stack in the design system.
- `@media print` re-points the palette at paper, drops the sidebar/topbar/
  search/footer, forces collapsed lists open, and repeats table headers.
  Printing is a first-class path — these tools exist to produce a number
  someone writes into a file.
- `docs/retro82-theme-plan.md` — the original retrofit plan + rationale.

## Conventions
- Adding a page: create `<name>.html`, incl. `noir.css` + `nav.js` + `#sidebar`,
  then add a `NAV_ITEMS` entry in `nav.js` (`npm run check` enforces this).
- **Form controls** (`button`, `input`, `select`, `textarea`) do not inherit
  `font-family` — the UA stylesheet hard-resets it, so they render in the
  platform UI font no matter what `body` says. One `:where(...)` base in
  `noir.css` restores it. Never set `font` shorthand on a control: it drags
  `font-size` back to body's and defeats the `--fs-*` scale.
- **Text inputs:** use the `.field` component and one of its size modifiers
  (`.field--code/--md/--sm/--cal`, plus `.field--raised` for the lighter
  surface). A page must **not** declare `border` or `outline` on an input —
  that is exactly what used to silently outrank the shared focus style and
  leave the whole site with no focus indicator. Keep the `id` for JS, style via
  the class.
- **Focus:** the ring is one universal
  `:where(a, button, input, …):focus-visible` rule in `noir.css`, so new
  controls get it for free. `outline: none` is allowlisted only for `#search`
  and `#input-text`, whose wrappers (`.search-inner`, `.input-wrap`) own the
  ring instead.
- The uppercase mono micro-label is one `:where(...)` base in `noir.css`
  (`.panel-header`, `.field-label`, `.result-label`, …). Add new labels to that
  list rather than re-declaring the four declarations.
- Adding a Rehkendaja test: add a `suite(...)` block in `rehkendaja-test.html`;
  the headless runner picks it up automatically.
- **Rehkendaja signs.** A leading `-` is part of the amount, so `-50 €` sums as
  −50 and a credit reduces the total. Both ASCII `-` and U+2212 MINUS SIGN are
  accepted — `et-EE` formatting emits U+2212, so the tool must be able to read
  back its own output; `parseAmount` normalises it because `parseFloat` only
  knows ASCII. U+2013 EN DASH is a range dash, not a minus, and stays positive.
  The three detection patterns are built with `new RegExp` from one shared
  `NUM_SRC` fragment so the sign cannot drift between alternatives, and every
  pattern is guarded by `(?<![\p{L}\p{N}])` so an amount can never start inside a
  word — without that, the `-` in `COVID-19` would open a match.
- **A dot is a decimal separator**, not a thousands separator: `1.234` is one-two-
  point-three-four and renders as `1,23 €`. `1 234,56` and `1.234,56` are the
  thousands forms. A number followed by `. ` and another digit (`100. 200 EUR`)
  is therefore one value, `100,20 €`, which is intended and tested.
- Rehkendaja copy-to-clipboard glues amount to unit with a **non-breaking space**
  (`\u00A0`) so Word never line-breaks between the number and € / g.
- `lausepank` work lives on the `lausepank` branch and uses encrypted data
  (plaintext `lausepank-andmed.json` is gitignored; see `.vscode/tasks.json`).

## Local artifacts (gitignored)
`sessions/`, `data/stats.json`, `agent_journal/`, `.agent_todos.json*`,
`.baseline/` (css-snapshot diff baselines) — agent runtime state, never commit.
