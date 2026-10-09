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
- `rehkendaja-test.html` — browser test page for Rehkendaja (40 suites / 552 tests).
- `rehkendaja-core.js` — **pure** detection+formatting logic shared by Rehkendaja and its tests. No DOM, no side effects. This is what the tests exercise.
- `nav.js` — single source of truth for the sidebar (`NAV_ITEMS`). Auto-detects active page.
- `noir.css` — **the only stylesheet.** Tokens, layout, shared components
  (`.field`, `.panel`, `.result-*`, `.list-*`, the label base), and a
  `PAGE COMPONENTS` section at the end holding the rules that belong to exactly
  one page, grouped by owning page. There are no page `<style>` blocks, no
  `style=""` attributes and no inline handlers that write styles; `npm run css`
  fails the build if any of the three reappears.
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
`.baseline/css-current.txt` holds a current snapshot baseline (2015 values,
verified clean). Diff against it before and after any type, spacing or layout
change — `node tools/css-snapshot.mjs --diff .baseline/css-current.txt` — then
refresh it with `--save` once the change is accepted. It is scratch, not a
source of truth; delete and re-create freely. Prefer it to eyeballing: the
figures are measured, not judged.
CI: `.github/workflows/test.yml` runs the four `verify` steps on push/PR to `main`.
`.github/workflows/update-data.yml` refreshes `data.json` daily at 04:00 UTC.

## Tools in `tools/`
- `cdp.mjs` — **shared headless-browser harness.** `smoke-test`, `css-snapshot`,
  `dom-tests` and `page-eval` all need the same three things — serve the repo
  over http (pages `fetch("data.json")`, which `file://` blocks), launch
  Chromium, speak CDP — and each used to carry its own copy. Four copies had
  drifted: two had a `CDP` class, two had a sloppier inline client that treated
  a protocol error as a resolved `undefined`. One module now owns it:
  `launch()` returns `{base, cdp, attach, goto, open, eval, evalRaw, close_}`,
  and `close()` is mandatory — it kills the browser's whole **process group**.
  That last part is a fix, not a refactor: `chromium` forks zygote/renderer
  children, and killing only the parent left one headless Chromium per tool run
  alive for the life of the machine. If you add a tool that opens a browser,
  `await env.close()` in a `finally` or it will leak.
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
- `contrast-audit.mjs` — WCAG 2.1 checker for the `noir.css` design tokens.
  Covers three families: opaque fg/bg pairs, **text on translucent tints**
  (composited over each surface first), and the **focus ring** against every
  surface. The last one exists because a focus ring that resolves to a
  near-invisible colour used to pass CI silently — see `--json` for the rows.
  Run `npm run contrast`; wired into `verify`/CI.
- `check-css.mjs` — convention lint for the stylesheet, no npm deps. Enforces
  that every `var(--x)` is a real token, that no raw colour appears outside a
  `:root` palette block, that type/spacing/z-index/breakpoints come from the
  documented scales, and — in each page — that there is no `<style>` block, no
  `style=""` attribute and no inline handler writing `.style`. The
  `outline: none` and `100vh` rules each exist because they caught a real
  regression. Run `npm run css`; wired into `verify`/CI.
  Deleted with `css_audit.py`: there is no second stylesheet left to compare.
  Two more rules, both added after the corresponding bug was found by hand:
  - **`dead-toggle`** — a bare-class `display: none` with no `.X.visible`
    counterpart. This is the `isikukood` clear button: JS toggled `visible` on
    it, nothing in CSS reacted, and it could never appear. Plant the defect and
    this rule fails, so it is not a check that only passes on clean input.
  - **`restated-media`** — a property inside `@media` set to the value the
    top-level rule already has. Equal specificity, equal value, so it cannot
    change anything; four had accumulated (`.sidebar{top,height}`,
    `.header-main{gap}`, `body{font-size}`). Only top-level rules are compared:
    two rules in *different* media queries are never both active.
- **Linters are validated by planting the defect, not by passing.** Every new
  rule here was checked by reintroducing the bug it is meant to catch and
  confirming a non-zero exit. A lint that has never failed may not work at all.
- `css-snapshot.mjs` — measures computed style + geometry (incl. a canvas
  text-width probe, which is what catches a real font-fallback change) for
  every shared component on all 6 pages, and diffs two runs. Use it before and
  after any change to type, spacing or layout. `PSEUDOS` additionally captures
  `::before`/`::after` chrome (e.g. `.or-separator`'s dividers), which the
  selector list cannot reach. A selector matching nothing is **skipped, not
  reported** — when adding one, confirm it resolves with
  `rg 'sel' .baseline/css-current.txt`.
- `dom-tests.mjs` — regression checks for the *inline* logic of the tool pages
  (isikukood, narkonimekirjad, index, karistuste-liitmine, ennetähtaegne) that
  the pure-core runner can't reach. Loads each page in headless Chromium over the
  DevTools Protocol (no npm deps; Node built-in `WebSocket`) and asserts page
  globals. Add a check to `CHECKS`. Run `npm run dom`. The checks share one live
  page, so each one that touches `excluded`/`inputEl` must reset the state it
  depends on (`excluded.clear()`) — otherwise it only passes in one order.
- `smoke-test.mjs` — loads every page in headless Chromium and fails on any
  uncaught exception / console error. `npm run smoke`.
- `page-eval.mjs` — one-off probe: `node tools/page-eval.mjs <page> "<expr>"`
  evaluates JS in a loaded page (handy while debugging). `--media print`
  emulates a media type, which is the only way to inspect anything inside an
  `@media` block — computed style otherwise reports as if the query never
  matched, so a print-only rule looks broken until you emulate it.

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
  `800px` (the only one). Container: `860px`, keyed to available content width
  (`.page-content` is the container) because the sidebar eats 260px. `900px`
  used to be listed here and allowlisted in `check-css.mjs` while no rule used
  it — the two-column flip has always been the container query.
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
- **All CSS goes in `noir.css`.** No page `<style>` block, no `style=""`
  attribute, no `onclick`-style handler that writes `.style` — `npm run css`
  fails on all three, and between it and `npm run check` (which requires the
  `noir.css` `<link>`) a page can neither drop the stylesheet nor grow a second
  one. Add the page's rules to the `PAGE COMPONENTS` section. The one
  sanctioned exception is JS assigning `el.style.<prop>` to a value computed at
  runtime — there are three, all arithmetic on a measured or indexed value
  (scroll offset, animation stagger, caret position). Those are behaviour, not
  styling.
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
- **Varying a shared component: add a `--modifier`, do not re-declare the
  selector.** A page `<style>` block is parsed *after* `noir.css`, so a page
  rule that named a shared class used to win on order alone — fine while it was
  the only mechanism, but invisible and easy to leak once the rules share a
  file. That is why `.panel-body--stack`, `.result-header--stack`,
  `.result-block--full` and `.field-label--spaced` exist instead of bare
  `.panel-body`/`.result-header`/… overrides. A modifier has to actually change
  something: `.tool-wrap--tight` set the same `--gap-wide` as its base, so it was
  a knob that did nothing and has been deleted. The one exception is `main`, the
  page shell, which has no component to modify and so is opted into with
  `<body class="test-harness">`.
- **Focus:** the ring is one universal
  `:where(a, button, input, …):focus-visible` rule in `noir.css`, so new
  controls get it for free. `outline: none` is allowlisted only for `#search`
  and `#input-text`, whose wrappers (`.search-inner`, `.input-wrap`) own the
  ring instead. The ring is drawn two ways and `npm run contrast` checks **both**:
  `--focus-outline` (the universal outline, full-strength `--amber`) and
  `--ring` (the translucent box-shadow on the search well). They are not the
  same colour and they are not interchangeable — the audit originally covered
  only the shadow form, so dimming the *outline* would have passed CI.
- The uppercase mono micro-label is one `:where(...)` base in `noir.css`
  (`.panel-header`, `.field-label`, `.result-label`, …). Add new labels to that
  list rather than re-declaring the four declarations. There is a **second**
  family for small tracked notes that are *not* uppercased — `--track-wide`
  rather than `--track-caps` — sharing its own `:where(...)` base
  (`.panel-note`, `.input-hint`, `footer`, `.result-unit`, …). Same move, same
  reason: name the family so a new note inherits it.
- Adding a Rehkendaja test: add a `suite(...)` block in `rehkendaja-test.html`;
  the headless runner picks it up automatically. Beyond `toEqual`/`toBeCloseTo`
  the harness also has `toBeTruthy`, `toBeFalse`, `toBeLessThan`, `toHaveLength`,
  `toContain` and `toMatchFields` (partial deep compare, key-order agnostic —
  use it for `extractAmounts` records rather than `toEqual`, which compares
  `JSON.stringify` and so is key-order sensitive). `CORPUS` at the top of the
  suite block holds realistic Estonian legal strings; the `Regexi — invariant:`
  suites iterate it in all three modes and assert the *shape* of every result
  (raw spans the text it claims, matches are ordered and disjoint, amounts are
  finite, eur/g matches carry their unit) rather than specific strings.
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
- **Copy buttons: use `copyButton(btn, text, confirmLabel?)` from `nav.js`.**
  Three pages each had their own inline version and they had drifted — two said
  `"✓"`, one said `"Kopeeritud ✓"`; one stored the text on a DOM expando
  (`btn._clipText`) instead of passing it in. All three pass `confirmLabel` now,
  so the wording differences are explicit. The helper also handles a *rejected*
  clipboard write: the old code only cleared the busy state in `.then()`, so a
  denied permission left the button stuck showing "✓" forever.
- **Do not rebuild a whole list to change one row.** Both hot lists are sized
  for documents far past what they are usually used with, and the naive version
  was quadratic in practice:
  - Rehkendaja: excluding one amount used to call `renderResults()`, rebuilding
    the whole highlight mirror and all N `<li>`. On a 2000-match document that
    measured **118ms per click** — and clicking a row is how you drop a term from
    a total, so it is a normal action, not a rare one. `toggleExclude()` now
    patches the one row, the one `<mark>`, the sum and the count
    (`patchExclusion`), falling back to the full render if the cached nodes are
    not there. Same click: **~1ms**.
  - Narkonimekirjad: `highlight()` compiled a fresh `RegExp` on every call, and
    the search loop calls it twice per matching row — **412 compiles per
    keystroke** over 456 rows. The query is now compiled once (`compileQuery`)
    and a row is only re-highlighted when its query actually changed, since
    identical input yields identical markup. **1 compile per query.** The input
    is debounced at 80ms like Rehkendaja's.
  - `highlight(t, q)` still works with two arguments (it compiles its own regex);
    the third parameter is only the optimisation.
- `lausepank` work lives on the `lausepank` branch and uses encrypted data
  (plaintext `lausepank-andmed.json` is gitignored; see `.vscode/tasks.json`).

## Local artifacts (gitignored)
`sessions/`, `data/stats.json`, `agent_journal/`, `.agent_todos.json*`,
`.baseline/` (css-snapshot diff baselines) — agent runtime state, never commit.
