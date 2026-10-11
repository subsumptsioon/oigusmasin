# Õigusmasin — metaandmete analüüs

A page that shows what is inside a PDF or a JPEG. The visitor picks a file, and
the page tells them what that file says about itself: metadata, dates, authors,
revision history, embedded fonts, images, and the internal structure that
produced them.

**The file never leaves the visitor's machine.** Not "is not uploaded" — never
leaves. There is no server component, no upload endpoint, and no way to export
what the page reads.

---

## What the promise is, precisely

> **The file never leaves the visitor's machine.**

Three things hold it up, and each is checked by a test rather than by intent.

**1. The code cannot send it anywhere.** The `File` is read by exactly two
consumers, in one place each. pdf.js is given `{ data }` and never a URL — a URL
would be something it could fetch. No `fetch`, `XMLHttpRequest`, `sendBeacon`,
`WebSocket` or form post carries file content anywhere in the project.
`tools/check-assets.mjs` fails the build if one appears.

**2. The browser is watched, not trusted.** `tools/privacy-tests.mjs` drives a
real Chromium through CDP's Network domain and asserts, for every registered
format: no request carries a body, no request leaves the origin, the page never
requests the file by name, and every request happens before the file is read.
It iterates the registry rather than a list of test files, so a format added
later is covered the day it is registered.

**3. There is no exit.** No export, no download, no share, no "save results",
no copy-the-whole-result. Individual fields may be copied — you are already
looking at them — but there is no control that takes the analysis out of the
page. The same check fails the build if `Blob`, `createObjectURL`, a `download`
attribute or a file-save API appears in our sources.

A visitor can verify the third one themselves: open DevTools, look for a download
button, and there is none to find. That is the design, not an omission.

---

## What this does **not** promise

Stated plainly, because a privacy claim with an asterisk is not a privacy claim.

- **GitHub Pages sees the page load.** Your IP address, user agent and the time
  of the request, in its own logs. This is true of every static page on the
  internet. It never sees the file you analyse, because the file is never sent.
- **The guarantee is about this page's code.** It does not survive a modified
  copy of the site — which is why the source is open, the tests are in CI, and
  the CSP is locked to `script-src 'self'` so injected third-party script cannot
  turn the page into an exfiltration path.
- **The CSP is a `<meta>` tag, because that is all this host allows.** GitHub
  Pages does not support custom HTTP response headers — no `_headers`, no
  `.htaccess`, no configuration file. Re-verified in phase 11: the feature is
  still absent. (Codeberg Pages added a limited `_headers` allowlist in February
  2026; GitHub Pages has not.) A meta policy applies only from the point it is
  parsed, so it is the first element in `<head>`, and `tools/check-assets.mjs`
  fails the build if a `<script>` or `<style>` moves above it.
- **A meta CSP ignores `frame-ancestors`, `report-uri` and `sandbox`.** Those
  directives are silently ineffective in this form. They are not written here,
  because writing a directive that does nothing is worse than not writing it.
- **Only this page has the CSP.** The other Õigusmasin pages do not. Extending
  it to them is separate work, and until it is done a visitor should not assume
  the rest of the site has the same protection.
- **Analysing a document puts it on screen.** A file with GPS coordinates in it,
  shown on someone else's screen, has had those coordinates shown. This is
  inherent to showing anything, and it is why sensitive values are labelled
  `tundlik` rather than quietly listed.
- **The privacy tests run against a local server**, not against GitHub Pages.
  They prove the code's behaviour. They say nothing about the host's discretion.

---

## Limits

| | |
|---|---|
| **Maximum file size** | **200 MB**, enforced before the file is read |
| Memory, measured | 50 MB → 475 MB · 200 MB → 1758 MB · 300 MB → 2151 MB |
| Analysis time | 50 MB → 3.4 s · 200 MB → 12.2 s · 300 MB → 18.1 s |
| Formats | PDF (1.0–2.0) and JPEG |
| Browsers | any current Chrome, Edge, Firefox or Safari |

The memory figures are the resident set of every browser process, measured while
a real parseable PDF of each size was analysed. **They are roughly
`206 MB + 6.85 × the file size`** — not the two buffers an earlier draft of this
document promised. The bytes exist as the `File`, as the `Uint8Array`, as the
latin1 string the raw scanner works on, as the copy given to pdf.js, and again
inside the worker. Five, not two.

200 MB is where that becomes comfortable: about 1.8 GB and twelve seconds, which
an ordinary 8 GB laptop survives with another tab open. Above the cap the page
says so in Estonian and stops, in a fraction of a second, rather than starting a
job that would cost two gigabytes.

### It will not work from `file://`

`crypto.subtle` needs a secure context, and browsers block workers from
`file://` URLs — so the SHA-256, SHA-1 and the PDF worker all fail before the
page is useful. **Serve the directory over HTTP**, even from your own machine:

```
python3 -m http.server 8000     # then open http://localhost:8000/metaandmed.html
```

`http://localhost` counts as a secure context, so nothing else changes.

---

## Adding a format

Four steps, and **no edit anywhere else**. Not in the page, not in the stylesheet,
not in the tabs, not in the privacy tests. If a step below needs any of those, the
architecture has regressed and that is worth knowing.

This is not a claim — it is the project's definition of done, and it was checked
by following these exact instructions for a format that does not exist.

### 1. Create `formats/<name>/index.js`

An analyser is three fields. Copy `formats/images/jpeg.js` as the model: it is the
smallest module that is a complete analyser.

```js
import { node } from "../node.js";

export const analyser = {
  id: "tmy",                       // stable; shows in the format badge
  labelEt: "TMY",                  // Estonian, shown to the visitor

  async analyse(bytes, ctx) {
    ctx.emitNode(node({
      id: "tmy.something",
      group: "info",               // a group key from formats/node.js's GROUPS
      labelEt: "Midagi",           // Estonian — the visitor reads this
      labelEn: "Something",        // English gloss, shown in parentheses
      value: "väärtus",            // the parsed value
    }));
    return { nodes: [], blobs: [] };
  },
};
```

**What you get from `ctx`:** `limits` (the shared budgets — depth, object count,
decompressed bytes, wall clock), `clock`, `emitNode(node)`, and
`reportError(messageEt, code)`.

**What you must not do:** touch the DOM, render anything, or build a URL. You
receive a `Uint8Array` and nothing that could be fetched. That is what makes
phase 11's privacy test cover your format without being edited.

### 2. Create `formats/<name>/detection.js` if detection is not one magic number

Most formats start with `magic: [0x89, 0x50]` in the registry line. A format
needing more can export a `detect(bytes)` returning `{id, labelEt}` or `null`.

### 3. Add one entry to `formats/registry.js`

```js
{
  id: "tmy",
  labelEt: "TMY",
  priority: 50,
  magic: [0x89, 0x50],
  groups: [{ key: "tmy", labelEt: "TMY-tingimused" }],   // only if your group is new
  load: () => import("./tmy/index.js"),
},
```

That is the whole change. **The tabs come from the `group` values your nodes
carry** — no tab list to edit. If your group is one this project already knows
(`summary`, `file`, `revisions`, `info`, `structure`, `fonts`, `raw`) you need no
`groups` line; if it is new, the line above gives it a tab *and* its Estonian
name. The search indexes the nodes, the privacy test picks your format up from
`FORMATS` without being edited, and the file picker accepts whatever your magic
bytes match.

### 4. Add a file to `test-pdfs/`

One real file in your format, and — if it should be reproducible — a few lines in
`tools/make-corpus.mjs`. The privacy test and the corpus check both fail without
one, which is deliberate: a format with no fixture is a format nobody tested.

### And if the format contains another format

Return `blobs` from `analyse`. Each blob needs a `mediaType`, and the registry
hands it to whichever analyser is registered for that media type. That is how a
JPEG inside a PDF is read by `formats/images/jpeg.js` — the same module that
handles a JPEG the visitor selects directly, with no PDF-specific branch in it.

---

## Running it

No build step, no dependencies to install, no server to configure.

```
npm run verify      # everything: syntax, tests, assets, CSP, privacy, language, contrast
npm run dom         # interactive page tests
npm run smoke       # load every page in Chromium, fail on any console error
```

Open `metaandmed.html` directly in a browser, or serve the directory with
anything static. The page works from `file://` with no server at all.

### Checks

| Command | What it proves |
|---|---|
| `npm run syntax` | Every module parses, and every relative `import()` resolves |
| `npm run check` | Local references resolve; no exit path exists; the CSP is intact |
| `npm run privacy` | No request carries a body or leaves the origin, for every format |
| `npm run lang` | English code, Estonian content — as a boundary, not a convention |
| `npm run contrast` | Every colour pair meets its WCAG threshold |
| `npm run css` | No inline styles, no undefined tokens, no invented values |

`npm run syntax` and `npm run check` are listed first in CI on purpose. Both were
added after a bug got past every other check, and the reason they exist is
written up in `pdf-metadata-analyser-plan.md`.

---

## Layout

```
metaandmed.html          the page
metaandmed.js            acquisition and rendering, and nothing else
noir.css                 the site's stylesheet — the only one

formats/
  registry.js            identification, stage ordering, the blob channel
  node.js                the common node shape, group keys, confidence
  contract.js            the analyser interface and the resource limits
  hash.js                SHA-256, SHA-1, MD5
  pdf/                   the PDF container
    lexer.js             PDF object syntax
    raw.js               header, markers, revision chain, Info, XMP bytes
    streams.js           cross-reference streams, object streams
    filters.js           Flate, LZW, ASCII85, ASCIIHex, RunLength, predictors
    encoding.js          string decoding and date conversion
    xmp.js               XMP: namespace-independent walk, edit history
    fonts.js             font inventory
    images.js            image inventory, and the bytes handed onward
    structure.js         the pdf.js layer
    index.js             the analyser that composes them
  images/
    jpeg.js              EXIF — and the proof the blob channel is not PDF-specific

lib/                     vendored, pinned, licensed separately (see lib/README.md)
test-pdfs/               the corpus; generated, never a real document
tools/                   the checks
pdf-metadata-analyser-plan.md   the plan this was built from, with its revisions
```

Adding a format is **one new directory, one registry entry, one corpus folder,
and nothing else.** The tabs, the search, the tabs' names and the privacy tests
all follow from the registry and from the node shape.

---

## Third-party code

Two libraries are vendored under `lib/`, pinned to exact versions, with their
licence texts in `lib/LICENSES/`. See `lib/README.md` for versions, sources, why
those versions, and how to update them. Nothing is loaded from a CDN, at any
point, for any reason.