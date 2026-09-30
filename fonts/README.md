# Self-hosted webfont

`JetBrainsMonoNerdFont-{Regular,Bold}.woff2` — the site asks for
**JetBrainsMono Nerd Font** by name, and that family only exists as a patched
build (nerd-fonts), not on any font CDN. To guarantee every visitor sees the
intended typeface, the two weights the design actually uses are served from
here rather than relying on a local install.

| file | weight | style | size |
|---|---|---|---|
| `JetBrainsMonoNerdFont-Regular.woff2` | 400 | normal | ~81 KB |
| `JetBrainsMonoNerdFont-Bold.woff2` | 700 | normal | ~82 KB |

Italic is not included: nothing in the site sets `font-style: italic`.

## Provenance

- **Upstream:** JetBrains Mono — Copyright 2020 The JetBrains Mono Project
  Authors. Licensed under SIL Open Font License 1.1 (`OFL.txt`).
- **Patched build:** ryanoasis/nerd-fonts. Nerd Fonts only add glyphs to
  otherwise-unmapped private-use codepoints; the outlines and metrics of the
  covered characters are unchanged from upstream, and the OFL is retained.

## Subsetting

The full patched font is ~2.5 MB per weight because it carries ~11 k icon
glyphs this site never draws. These files are subset to **1462 glyphs**
(~81 KB) covering:

- Basic Latin, Latin-1 Supplement, Latin Extended-A/B — Estonian `ä ö ü õ š ž Õ Ä Ö Ü`
- Combining Diacritical Marks, so decomposed input still composes
- Greek — `data.json` contains stereoisomer prefixes (`Δαβγ`)
- General Punctuation, Currency (`€`), Letterlike, Arrows (`→`),
  Mathematical Operators (`∑ ±`), Box Drawing (`─ ═`), Geometric Shapes
  (`▲ ▾`), Miscellaneous Symbols (`☰`), Dingbats (`✓ ✗`)
- U+F000–U+F0FF — the Symbol private-use block, because the scraped
  `data.json` contains U+F0B7 (a Windows-origin bullet)

Excluded: the nerd-fonts icon blocks. Deliberately **not** covered, because the
upstream font has no glyph for it either: U+2011 NON-BREAKING HYPHEN. The
`unicode-range` in `noir.css` keeps that on the generic fallback rather than
rendering .notdef.

Regenerate with `fonttools subset` if the upstream font is ever updated; the
range list lives in the commit message for these files.
