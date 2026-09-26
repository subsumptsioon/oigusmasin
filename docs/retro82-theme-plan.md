# Retro 82 theme retrofit — implementation plan

**Goal:** retarget the Õigusmasin design system (`noir.css`) onto the
[Omarchy Retro 82](https://github.com/OldJobobo/omarchy-retro-82-theme) palette
and style language, **without touching any page markup or JS**.

**Why it's cheap:** every page routes 100% of its colour through `noir.css`
custom properties (verified: `0` hardcoded hex values across all 6 HTML files).
So ~90% of this is a single `:root` token remap, plus a small "style language"
pass and 7 stray hardcoded colours.

**Evidence base:** all proposed colours were validated with a new
`tools/contrast-audit.mjs` (WCAG 2.1). Proposed palette: **28/28 pairs pass**
(see §3).

---

## 1. Source of truth — what "Retro 82" is

From `colors.toml` / `shell.toml` / `gtk.css` / `vencord.theme.css` in the theme
repo, and `preview.png`:

| Aspect | Retro 82 |
|---|---|
| Base surfaces | deep navy `#00172e`, `#001123`, `#000c17` |
| Foreground | warm cream `#f6dcac` |
| Primary accent | amber `#faa968` (used for focus, selection, active) |
| Support | teal `#57898a` (muted), `#8cbfb8` (cyan), `#65a5a1`, `#a3ccc6` |
| Semantic | red `#f85525`, orange `#e97b3c`, yellow-bright `#ed9563` |
| Corners | **sharp** — `* { border-radius: 0 }` (gtk.css, aether.override.css) |
| Borders | 1–2 px, muted teal, low-alpha cream for hairlines (`alpha(fg,0.10)`) |
| Effects | CRT scanline (`--rt82-scanline`), subtle grid (`--rt82-grid`), amber glow (`--rt82-glow`) |
| Type | monospace terminal (BitstromWeraNF / JetBrains Mono NF); `VT323`/`Chakra Petch` for display |
| Selection | amber bg + navy text |

The preview confirms: navy field, amber/orange focal accent, teal secondary,
cream type, hard edges, thin borders, terminal chrome.

---

## 2. Current architecture (`noir.css`, 945 lines)

A clean token system. Token usage counts:

```
--mono 28   --border 26   --muted 14   --dim 13   --text 11   --amber 11
--deep 9    --surface 8   --lift 3     --line/void/red/sans/l6 1 each
```

Consequences:
- Remapping `:root` propagates to **all** pages automatically.
- Only **one** stray hardcoded hex exists in `noir.css` (`color:#fff`, line 269).
- `rehkendaja`'s inline highlight CSS has 6 hardcoded `rgba()` values (amber + a
  slate) that must be updated by hand (§4).

---

## 3. Proposed token map

Edit `noir.css` `:root` (lines 8–32). Every value is from the Retro 82 palette
except two clearly-derived surfaces.

| token | current | → new | Retro 82 source |
|---|---|---|---|
| `--void` | `#08080c` | `#000c17` | `darker_bg` |
| `--deep` | `#0d0e13` | `#001123` | `dark_bg` |
| `--surface` | `#121520` | `#00172e` | `bg` |
| `--lift` | `#191d28` | `#021f37` | derived (bg + accent lift; hover surface) |
| `--border` | `#60678f` | `#57898a` | `muted` |
| `--line` | `#252a3c` | `#0e2c47` | derived hairline |
| `--amber` | `#f5b942` | `#faa968` | `accent` / `blue` |
| `--red` | `#f25443` | `#f85525` | `red` |
| `--text` | `#eef1ff` | `#f6dcac` | `fg` |
| `--muted` | `#9099b8` | `#8cbfb8` | `cyan` |
| `--dim` | `#838dad` | `#65a5a1` | `bright_magenta` |
| `--l2` | `#f0893d` | `#ed9563` | `bright_yellow` |
| `--l3` | `#f5c842` | `#faa968` | `amber` |
| `--l4` | `#f0ae3d` | `#e97b3c` | `yellow` |
| `--l5` | `#5aade8` | `#8cbfb8` | `cyan` |
| `--l6` | `#a87fd4` | `#a3ccc6` | `bright_cyan` |

Notes:
- `--lift` and `--line` have no direct palette token; they are derived so the
  raised surface stays 1 step lighter than `--surface` and the hairline stays
  visible. `--lift #021f37` is the **lightest** value that still keeps
  `--dim` ≥ 4.5:1 (tuned via the auditor — see below).
- `--amber` shifts from yellow-amber to the warmer coral-amber `#faa968`; the
  `rehkendaja` sum value and focus rings inherit this automatically.

**Contrast audit (proposed palette, via `tools/contrast-audit.mjs`):**

```
PASS  all 28 pairs meet their WCAG threshold
  worst margins:
    --dim   on --lift    4.5x  (min 4.5 text)
    --border on --lift    3.0x  (min 3.0 non-text)
    --red   on --lift     4.9x  (min 3.0 large)
```

Baseline (current palette) also passes 28/28, so this is a **no-regression**
swap.

---

## 4. Hardcoded-colour cleanup

These bypass the tokens and must change with the palette.

| file:line | current | → new |
|---|---|---|
| `noir.css:269` | `color: #fff` (h1) | `color: var(--text)` |
| `noir.css:364` | `rgba(245,185,66,0.12)` (focus ring) | `rgba(250,169,104,0.15)` |
| `noir.css:639` | `rgba(245,185,66,0.12)` (focus ring) | `rgba(250,169,104,0.15)` |
| `noir.css:796` | `rgba(245,185,66,0.22)` (mark bg) | `rgba(250,169,104,0.22)` |
| `index.html:44` | `rgba(245,185,66,0.28)` (highlight mark) | `rgba(250,169,104,0.28)` |
| `index.html:47` | `rgba(245,185,66,0.5)` (mark outline) | `rgba(250,169,104,0.5)` |
| `index.html:53` | `rgba(122,132,168,0.12)` (excluded mark) | `rgba(140,191,184,0.12)` |
| `index.html:54` | `rgba(122,132,168,0.25)` (excluded outline) | `rgba(140,191,184,0.25)` |

Optionally introduce `--amber-rgb: 250 169 104;` and use
`rgb(var(--amber-rgb) / 0.28)` to end hardcoded rgba for the accent — cleaner
but adds one token. Recommended (small win, removes the last magic numbers).

---

## 5. Style-language pass (the part that makes it *feel* Retro 82)

Palette alone looks like a re-skin; these 6 touches carry the identity.

1. **Sharp corners.** `noir.css` already has almost none — set the two
   remaining `border-radius: 2px` (sidebar scrollbar thumb ~L107, ~L326) to `0`.
   Do **not** add a global `* { border-radius: 0 }`; the existing rule list is
   fine and keeps overrides local.

2. **Scanline retune.** Replace the current overlay (L56–70, black @ 0.008) with
   the Retro 82 recipe: cream @ ~4% + navy @ ~16% over 4 px, `180deg`.
   ```css
   background: repeating-linear-gradient(180deg,
     rgba(246,220,172,0.04) 0, transparent 2px,
     rgba(0,12,23,0.18) 4px);
   ```
   Keep it under `z-index: 1` (unchanged).

3. **Optional grid substrate.** A 1 px amber grid at ~6–10% alpha (Retro 82
   `--rt82-grid`) on `body`/`.panel` adds the arcade texture. Behind content
   only; skip on `.panel` if it hurts readability. *Optional — A/B screenshot.*

4. **Amber glow.** Add `--glow: 0 0 24px rgba(250,169,104,0.22);` and apply to:
   - `.input-wrap:focus-within` (focused input),
   - `#block-sum .sum-value` (the hero number),
   - `.nav-item.active`.
   This is the signature CRT bloom. Keep it off large text bodies.

5. **Selection + focus colours.** Add:
   ```css
   ::selection { background: var(--amber); color: var(--void); }
   ```
   (matches Retro 82 `selection_foreground/background`). Focus rings already use
   `var(--amber)`.

6. **Active nav as an inverse "status" chip.** Retro 82's selected states are
   accent-bg + inverse-text (the `NORMAL` badge in the preview). Change
   `.nav-item.active` from `color:var(--text); background:var(--lift)` to:
   ```css
   .nav-item.active { background: var(--amber); color: var(--void); }
   .nav-item.active .nav-sigil { color: var(--void); }
   ```
   Contrast of `--void` on `--amber` ≈ 11:1. This is the single highest-impact
   change for reading as "Retro 82".

7. **Optional chrome flourish.** The theme ships an ASCII sigil (`sig.txt`);
   the sidebar brand could render it as a `<pre>` in `--amber`. Nice-to-have,
   touches `nav.js` — defer to Phase 3.

---

## 6. Typography — **decided: JetBrains Mono Nerd Font**

- **Applied.** `--mono` is now:
  ```css
  --mono: "JetBrainsMono Nerd Font", "JetBrainsMono NF", "JetBrains Mono",
    ui-monospace, monospace;
  ```
  The Nerd Font family (`JetBrainsMono Nerd Font`, alias `JetBrainsMono NF`) is
  used where installed (e.g. Omarchy), with the Google-Fonts `JetBrains Mono`
  loaded in each `<head>` as the web fallback, then generic `monospace`.
- `--display` stays `var(--mono)` (no separate display face).
- The optional VT323 CRT face is **dropped** — Nerd Font is the requested look.

---

## 7. Phased task breakdown

**Phase 0 — safety net (done):**
- [x] `tools/contrast-audit.mjs` built + baseline passes.
- [x] Wired `node tools/contrast-audit.mjs` into `npm run verify` + CI.

**Phase 1 — palette swap (done):**
- [x] `:root` tokens remapped per §3.
- [x] Hardcoded colours fixed per §4 (incl. `border-radius` on the highlight).
- [x] `npm run verify` green (80 tests + assets) and contrast 28/28.
- [x] Visual check (headless Chromium screenshots: index, isikukood, karistuste-liitmine).

**Phase 2 — style language (done):**
- [x] Corners → 0 (`.pill-bar`, sidebar scrollbar thumb, highlight mark).
- [x] Scanline retune (§5.2).
- [x] `::selection` + `--glow` on focused inputs and the hero value (§5.4–5.5).
- [x] Active nav inverse chip (§5.6).
- [ ] Optional grid (§5.3) — **deferred**: palette + scanline already read as
      Retro 82; a grid risked noise behind dense tables. Revisit if wanted.

**Phase 3 — flourishes (optional, not started):**
- [~] Font — **Nerd Font applied** (§6); VT323 dropped.
- [ ] ASCII sigil in sidebar brand (`nav.js`).
- [ ] Dual-theme toggle (§9) if desired.

---

## 8. Verification & guardrails

- `npm run verify` — 80 headless Rehkendaja tests + asset/nav integrity
  (unchanged by this work; proves no structural breakage).
- `node tools/contrast-audit.mjs` — WCAG guard; **must stay 28/28**.
- `python3 tools/css_audit.py` — confirms page `<style>` blocks aren't
  reintroducing duplicate/overriding rules.
- Manual: open each page, tab through focus states, toggle unit switcher,
  paste sample text into Rehkendaja, check the highlight/excluded marks.

---

## 9. Risks, rollback & optional dual-theme

- **Risk:** derived tokens (`--lift`, `--line`) drifting from palette intent.
  Mitigation: they're only 2 tokens and audited.
- **Risk:** amber glow overdone on low-DPI → muddy text. Mitigation: glow only
  on focus/hero, never body text; easy to dial alpha.
- **Rollback:** all changes are confined to `noir.css` + 6 `rgba()` lines in
  `index.html` — a single revert, no markup change.
- **Optional dual-theme:** because everything is tokens, a future
  `:root[data-theme="retro82"] { … }` override makes themes swappable with no
  page edits. Out of scope now, but the architecture already allows it.

---

## 10. Out of scope

- Changing layout, markup, or JS behaviour.
- Copying theme assets (wallpapers, GTK, terminal configs) into this repo.
- Light mode.

