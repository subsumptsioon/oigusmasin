# PDF Metadata Analyser: Project Plan

Status: plan only, nothing built or tested yet.

Convention used below: statements marked **[verify]** are things I believe but have
not confirmed, and must be tested before relying on them.

This page is a **subpage of Õigusmasin**, not a separate site.

**Language convention.** Every user-visible term is shown in Estonian with the
English in parentheses. Where the PDF specification has a key name, the key *is*
the English form and is written as-is: `CreationDate`, `Producer`, `/Info`.
Elsewhere the English is a gloss — "inkrementaalne versioon (revision)". The
interface is Estonian only; the parentheses are for this document, not for the
running page. The glossary in §6 fixes the wording before implementation starts,
so the strings are decided once rather than invented per layer.

---

## 0. What changed in each revision, and why

### Revision 14 — phase 12, the number that was wrong by three, and the format that vanished

| Change | Reason |
|---|---|
| §4.5's memory model corrected from "two copies" to the measured `206 MB + 6.85 × file size` | The estimate counted the design rather than the implementation. The bytes exist five times over: `File`, `Uint8Array`, the latin1 scanner string, pdf.js's copy, and the worker's. Publishing `2 ×` would have put a number in the README that no measurement agreed with |
| Cap set at 200 MB, enforced against `File.size` before the read | The memory test §8 asked for exists now, and it decided this (§12.1). A 2 GB file costs a property lookup and an Estonian sentence, not the tab |
| `tools/make-corpus.mjs` written; 28 fixtures regenerate byte-for-byte | §12.2 resolved as "commit them *and* generate them". The generator is the drift check: it exits non-zero when a byte moved, so a fixture that has quietly stopped matching its generator is a build failure |
| README gained hosting, limits, `file://`, checksums and a four-step "Adding a format" | §12's release item |
| `tools/extensibility-proof.mjs` added to `verify` and CI | §13's last item, executed. It found a defect no other test could: a new format's group was silently dropped because tabs were filtered from a static constant. §6 said that case worked; it did not |
| Tabs now derive from the nodes that exist (`allGroups`), and a registry entry may name its own groups | Restores §6's promise for formats that do not exist yet, without moving the tab list out of the analyser's hands. A group with no nodes still gets no tab |
| The proof compares file **contents**, not mtimes | The version that did not could not tell a restored file from an edited one, which is the only thing it was built to tell |

### Revision 13 — phase 11, the proof, and a failing example of our own

| Change | Reason |
|---|---|
| `tools/privacy-tests.mjs` added; `npm run privacy` in `verify` and CI | §7's second support is the only one that observes rather than asserts. It uses CDP's Network domain, so it can see a **request body** — which `performance.getEntriesByType()` cannot |
| It iterates `FORMATS`, now exported by the registry | A hard-coded file list tests today's formats and silently stops testing tomorrow's. Sharing the registry means a new format is covered when it lands, with no edit |
| **Verified by planting `navigator.sendBeacon`** | The only way a passing privacy test proves anything. It failed, and the failure named the CSP directive that stopped it — two independent layers catching the same line |
| `check-assets.mjs` gained the no-exit and outbound checks | §7's third support, made a build failure. Comments and strings are stripped first, so this file's own prose about `createObjectURL` does not fail the build |
| `check-assets.mjs` gained a CSP audit | A policy can be present, correct-looking, and not apply. `unsafe-eval`, a `<script>` above the meta tag, and a missing directive were each planted and caught |
| `README.md` written, leading with what the promise **is not** | §7 lists seven limits; a visitor who reads only the README should meet them, not infer them |
| `check-language.mjs` now documents that ASCII Estonian passes | The plan's own example, `kaust`, contains no Estonian letter and does not fail. Recording that is more useful than a test that quietly cannot catch it |

### Revision 12 — phase 10, the interface, and a test that could not fail

| Change | Reason |
|---|---|
| **Toorandmed** shows raw text only where it differs from the value | Most fields store the text that is displayed. A raw line under every value doubles the height of every table to repeat the line above it |
| **Kopeeri** reuses `nav.js`'s `copyButton()` | §6 names the existing helper, and three pages had already drifted on the confirmation label and the clipboard-rejection path before it was factored out |
| Copy buttons hidden with `opacity`, not `display: none` | `display: none` removes a control from the tab order. A keyboard user who cannot hover would lose 76 buttons |
| **Tundlik** marks §5.7's GPS values, with a word as well as a border | A colour alone survives neither a screen reader nor a greyscale printout |
| Page errors collected from **CDP**, not `window.__pageErrors` | The page never defined that variable, so the "does not crash" assertions were reading `undefined`, stringifying to `"[]"`, and passing against a page throwing on every file |
| Every error state asserts the status line is **no longer "Analüüsin…"** | That string is the exact residue of a silently-failed analysis. Nine phases of suites asserted on status-line *content*, and "Analüüsin…" is content — so a total failure read as a slow file |
| Node tree published read-only for the string audit | §10's "no second representation" is a property of the running page, not of the source. 221 drawn strings, 0 untraceable |
| `state.showRaw` survives a re-render but not a new file | §6 requires nothing to survive from one file to the next; losing the toggle on re-render was the other half of that |

### Revision 11 — phase 9, the blob stage, and the second off-by-one

| Change | Reason |
|---|---|
| **Stage 3 implemented.** Blob analysers registered by media type | §4.1 drew it and §4.2 defined `BlobRef`, but the registry collected blobs and returned them to nobody. Keying by *media type* rather than blob index is what keeps one implementation serving both routes |
| `exifr` 7.1.3 vendored — the **full** build | `lite` drops XMP and `mini` is EXIF only. A narrower build reports fewer fields for reasons unrelated to the file, which is the same error as a hard-coded namespace list |
| pdf.js is given `bytes.slice()` | A transfer detaches the buffer. Every other consumer then threw, and the symptom was a *missing row* rather than an error |
| "No EXIF" vs "could not read it" are separate answers | `silentErrors: true` returns `{errors:[…]}`, which is truthy and was being reported as metadata |
| Page-tree walk follows `/Pages` **and** `/Kids` | The catalog uses the former, a tree node the latter. Missing the first reported "no fonts, no images" for a document with both |
| `check-syntax.mjs` resolves relative `import()` paths on disk | The browser clamps a path above the origin root, so a wrong depth passes every page test. The second time this happened is what turned it into a check |
| Font rows carry provenance (`/FontDescriptor` missing, subset by prefix only) | Whether a font is embedded is a fact about the file; the `ABCDEF+` prefix is a convention, not a guarantee. The two are not the same kind of claim |

### Revision 10 — phase 8, the XMP layer, and a missing check

| Change | Reason |
|---|---|
| **`tools/check-syntax.mjs` added, first in `verify` and first in CI** | A module with a syntax error passed every other check, because all of them read our code as *text*. `vm.SourceTextModule` compiles without evaluating, so `metaandmed.js` — which touches `document` at top level — parses rather than failing |
| XMP is read from the **metadata stream**, with the byte scan as fallback | §7.11.1: modern producers store the packet Flate-compressed. Phase 7's raw byte scan found nothing there, and reported "no XMP" for a file that plainly had some. The UTF-16 corpus file is the sharp case — its bytes never contain the ASCII `<?xpacket` at all |
| `parsererror` is searched for **anywhere** in the document, not only at the root | Chromium and WebKit put it inside the partially-parsed tree. Checking only the root reported a malformed packet as "parsed, six properties" |
| Info/XMP dates compared as **instants** | `/Info` and XMP write the same moment in different syntaxes; comparing the strings reports every document as disagreeing with itself |
| Conformance identifiers worded as a **claim** ("the file declares this") | Verifying PDF/A needs an independent validator. Reporting the identifier as fact would be the over-claiming §11 forbids |
| Unknown namespaces listed last rather than dropped | `acme:` from the corpus reaches the interface intact, which is the feature §5.4 describes |
| `Cache-Control: no-store` on the dev server | Chromium caches ES modules heuristically with no cache header, so a fixed bug kept serving its old bytes. A file server that serves changing source should say so |

### Revision 9 — phase 7, the pdf.js layer, and a vendored library

| Change | Reason |
|---|---|
| `pdfjs-dist` 4.10.38 vendored, pinned, with licence text and `lib/README.md` | The plan's reason for vendoring is §7's promise without asterisks: a CDN script would need a CSP relaxation *and* would hand a third party an IP address on every page load. 4.10.38 is the last 4.x line, and the `>= 4.2.67` floor is CVE-2024-4367 |
| The getter set was read from 4.10.38's type definitions **before** any code | §5.3 asks for it explicitly, and the plan already predicted the risk. It was correct: `getJavaScript` does not exist in this version, and `getPermissions` returns a bitmask. Writing against a 3.x-shaped API would have produced a layer that silently reported "no JavaScript" on every document |
| **`/Lang` is read by `raw.js`, not pdf.js** | pdf.js 4.10.38 exposes no getter for it. Reaching into a private field returned `undefined` and reported a document as having no language when it declares one. This is the clearest vindication yet of keeping our own parser |
| `doc.destroy()` removed; `cleanup()` kept | `destroy()` tears down pdf.js's shared worker pool, so every later document respawns it. CDP confirms the resulting worker-script loads carry no body |
| pdf.js cached on `globalThis` | The registry re-imports analysers per file, so a module-level cache was discarded each time. The one deliberate exception to "no globals"; it holds no file data |
| Privacy now verified with CDP's Network domain, not `performance.getEntriesByType()` | Counting requests cannot tell a script load from a transfer. Observing that **no request carries a body** is what §7 actually promises, and it is checkable |
| §8's "which pdf.js getters exist" row is answered | Replaced by what was actually found, including the one that does not exist |

### Revision 8 — phase 6, the raw parser extended

| Change | Reason |
|---|---|
| `encoding.js`, `filters.js`, `streams.js` split out of `raw.js` | Split by what each knows, not by what it does. Encoding knows bytes→text; filters know stored→stored; streams know the two binary table formats. `raw.js` is now the orchestrator and holds no decoding of its own, so a phase 9 filter lands in one file instead of three |
| **A file with an unusable xref now gets the repair row** | The early return skipped `emitRepair`, so the one class of file where rebuilding the object map is the entire point showed nothing about having been rebuilt |
| The Info row's provenance is shown ("asukoht 925 B" / "objektivoogus #4") | A visitor comparing two revisions needs to know *where* each value was read from, and an object stream has no byte offset a visitor could check in a hex editor |
| Date rows show the original, the precision and any caveat | `D:2024` is a year, not 1 January. Rendering it as `2024-01-01` without that caveat is a false statement about the document |
| `Z` dates are flagged, not corrected | The producer's bug is the finding. Guessing an offset would hide it |
| The PDFDocEncoding table was checked against Ghostscript's | `/usr/share/ghostscript/Resource/Init/gs_pdf_e.ps` defines the same table. It confirmed 0x80–0x9E and showed that 0x9F is `.notdef` — the obvious guess (`ſ`) was wrong |
| ASCII85 verified against Python's `a85decode` | qpdf's `--filtered-stream-data` returns nothing for that filter, so the one filter qpdf could not confirm was confirmed against a second independent implementation instead |

### Revision 7 — phase 5, the raw parser

| Change | Reason |
|---|---|
| Requirement 3 and §7 item 2 rewritten: **zero requests** → **no request carries file content, none leaves the origin, all precede the file read** | Phase 5 falsified our own claim. Selecting a PDF lazily fetches `index.js`, `raw.js`, `lexer.js` from this origin. They carry no file content, so the promise was never in danger — but a test that says "zero" against a page that makes three requests gets quietly weakened until it passes. The weaker-sounding wording is the one that can actually be enforced |
| `lexer.js` and `raw.js` split | The lexer has no Estonian and no opinion about layout; `raw.js` decides nothing about presentation. Phase 6's filters belong to the lexer, phase 8's parsing belongs to neither |
| The XMP packet ends at `<?xpacket end`, not `</x:xmpmeta>` | The first cut dropped the wrapper's closing line — the one that says the packet is complete rather than truncated |
| `readInfo` verifies the object header the table points at | A wrong offset yields a dictionary that parses cleanly and lies. Detection only; repair is phase 6 |
| The header version became a row with children | The offset belongs beside the version. A single flat value had nowhere to put it |
| Cross-checked against **qpdf**, not a hex editor | A hex editor proves one number. qpdf parses the file with an independent implementation, so every offset agreeing is real evidence. The hex-editor check is kept as the second assertion — each offset must point at its own `N 0 obj` |
| The ambiguous-candidate row is a first-class node | §5.2 asks for it explicitly, and it is the row that proves the classification does something: one structural `xref` and its rejected neighbours, side by side, with a reason each |

### Revision 6 — phase 4, the file layer

| Change | Reason |
|---|---|
| Digests computed **before** the detection gate | An earlier draft returned early on an unknown format, leaving a file the tool could not read with no checksum at all. "What is this file" is most often exactly the question when the format is unrecognised, and digests describe bytes, not formats |
| One full read, used twice | Web Crypto needs the whole message and the analyser needs the same bytes. Reading twice doubled peak memory for nothing |
| MD5 implemented from RFC 1321 rather than vendored | No licence to ship and no version to pin. Verified against `md5sum` at 27 lengths across the padding boundaries and against all seven of RFC 1321's vectors — trusted, not hoped |
| SHA-2 and SHA-1 run concurrently, MD5 does not | Two independent native calls versus one synchronous JavaScript loop. On a large file MD5 is the slowest thing on the page, which is the price of supporting the digest people actually quote |
| Digest failure is reported, never fatal | A file too large to digest should still show its page count. Losing the whole analysis because one checksum did not fit is the worse failure |

### Revision 5 — phase 3 delivered, and two corrections it forced

| Change | Reason |
|---|---|
| The analyser has **no `detect()`**; the registry entry owns identification | Lazy loading exists so an unselected format costs nothing. Asking a module "are you needed?" means loading it, which defeats the thing. The registry entry probes without loading; an analyser is only ever constructed for a format that already matched |
| `DETECT_BYTES` is 1024, not 16 | §7.9.1 puts the `%PDF` header anywhere in the first 1024 bytes. The first draft read 16 and gated on offset 0, so a prefixed PDF — a conforming file — was reported as unknown |
| `search()` deleted, `filterTree()` written instead | The flat version returned matches with their parent row dropped, so a hit would have been searched for and not seen |
| A buggy `ArrayBuffer`/`Uint8Array` conversion found by the error path | `arrayBuffer()` has no `subarray()`. Worth recording *how*: the status line read "Analüüs katkes: bytes.subarray is not a function" instead of the tab dying. §4.1's try/catch earning its keep on day one |
| `tools/check-language.mjs` added | Phase 3b. Found that my own first version stripped comments before scanning, which passed a file containing `// märkus: …` — the inverse of the rule. Caught only because the check was planted with a deliberate failure |
| Language check scoped to the analyser's code, not the repo | `tools/` and the older pages contain "Õigusmasin" and "ennetähtaegne-vabastamine" in otherwise-English comments. A regex cannot tell a product name from a sentence written in Estonian, and an allowlist growing one line per proper noun stops being a rule. One line to widen, once those comments are reworded |

### Revision 4 — display only, no export

| Change | Reason |
|---|---|
| JSON export, download and share **removed** | The page displays what it reads. Nothing else. A download button is the only feature that turns "the file never leaves this machine" into something a visitor can hand onward — and with §5.7's GPS and device data in scope, that is a real risk, not a theoretical one |
| A static test asserts no export code exists | §7's promise was only ever a promise about code. This makes it a build failure instead: `Blob`, `URL.createObjectURL`, `download` attributes and file-save APIs are grepped out of our own sources |
| `blob:` dropped from `img-src` | It existed for the export object URL. `worker-src blob:` stays, because pdf.js may need it |
| The bilingual label now renders on the page | `labelEn` had no consumer once the export went. The glossary surfaces in the UI instead: *Loomiskuupäev (`CreationDate`)* |
| Requirement 12: English code, Estonian content | A hard boundary with a test, not a convention. Found while writing phase 2: it is easy to leak a translated string into an identifier, and once two do it, nothing catches the third |

### Revision 3 — extensible by construction

| Change | Reason |
|---|---|
| `formats/` spine: contract, common node, registry, lazy loading | Image and other document formats must be addable later without touching the UI or the tabs. §4, §5.7, §13 |
| The JPEG path is reframed as a stage-3 blob analyser | It was already the right shape; it was written as if it were PDF code. Now the same module serves an embedded image and a selected one |
| Tabs derived from node `group` values, with a format badge | Empty groups hide themselves, and a second format gets its own tabs without a UI change |
| Privacy test iterates the registry, not a PDF list | A format added later is covered by CI automatically, so §7's promise cannot silently lapse |
| New risk: extraction sensitivity | More format coverage means GPS coordinates and device identifiers surface; labelled and called out in the summary |
| **Accept** attribute and page name kept | Renaming the URL when format two arrives is a broken-link problem for a page that has been public |

### Revision 2 — Estonian, and a corrected privacy model

| Change | Reason |
|---|---|
| Interface is Estonian, terms documented with English in parentheses | The page sits in an Estonian sidebar next to Estonian pages. One English page reads as a mistake. |
| `script-src` stays locked to `'self'` | Third-party script is the only real path from file content to the network. This is what makes "the file cannot leave" a guarantee rather than a promise. |
| `connect-src` loosened from `'none'` to `'self'` | The page may use other Õigusmasin resources. It still permits no outside origin. |
| `style-src`, `font-src` open to `https:` | External fonts are allowed. Not needed today — `noir.css:23-45` vendors JetBrains Mono as local woff2 — so this is headroom, not a dependency. |
| The privacy guarantee moved from the CSP into the code | A Content-Security-Policy cannot express "you may connect, but never with file content". The policy and the guarantee are now stated separately, and the guarantee is verified by observing behaviour. |

### Revision 1 — subpage reality, and five corrections

| Change | Reason |
|---|---|
| pdf.js **3.x → pdfjs-dist 4.10.38**, loaded as ES modules | CVE-2024-4367 (GHSA-wgrm-67xf-hhpq, high) affects pdfjs-dist ≤ 4.1.392: a crafted PDF executes arbitrary JavaScript in this site's origin. Pin 4.10.38, not the newest 6.x, because 4.10.x has the widest browser floor. |
| `lib/pdf.min.js` → `lib/pdf.min.mjs` + `lib/pdf.worker.min.mjs` | 4.x ships ES modules only. The old premise — "3.x is the last line with plain builds" — is true but irrelevant: GitHub Pages serves over HTTPS and every target browser supports ESM. |
| `cmaps/` and `standard_fonts/` dropped from the tree | Nothing is ever rendered (`render()` and `getTextContent()` are never called), so pdf.js never needs them. Removes ~2.5 MB of vendored bytes. |
| Data flow sends the `File`, not an `ArrayBuffer` | The old flow allocated the file three times. See §4. |
| Broken-xref repair mode added to Layer 2 | This is the feature that justifies a hand-written parser. See §5.2. |
| MD5 now in scope, not optional | It is the identifier people actually quote when asking "is this the same file". Identification, not security. |
| Offline requirement reworded; no service worker | A static GitHub Pages subpage cannot promise a cold offline load. |
| Verification steps become automated | `tools/cdp.mjs` already drives headless Chromium. "Zero network requests during analysis" is one CDP call, not a manual DevTools session. |

---

## 1. Goal and scope

A page on Õigusmasin where a visitor selects a PDF already on their own machine
and receives as much metadata and structural information as can be extracted.
The file is read with the File API and analysed entirely in the visitor's browser.

**The single promise: the PDF never leaves the visitor's machine.** No request
carrying file content is ever made. §7 states how that promise is kept and how a
visitor can check it.

**In scope**
- File-level data, raw byte-level forensic data, document structure, XMP, fonts,
  images (including EXIF from embedded JPEGs).
- **Display only.** The page renders everything it reads and stops there.

**Out of scope**
- Rendering page previews. A decision, not an oversight: without rendering there is
  no need for cmaps or standard font data, and `img-src` stays near-empty.
- **JSON export, file download, sharing, or any output the visitor can hand to
  someone else.** No `Blob`, no object URL, no `download` attribute, no
  copy-the-whole-result. The reason is in §7: an export button is the one feature
  that can move data off the page, and this page's entire claim is that it does
  not.
- Digital signature analysis (decided).
- Any server-side processing or upload.
- Password cracking. Encrypted files are reported as far as possible without a
  password.
- Cold offline load via a service worker (see requirement 3).

**Extensible by construction.** PDF is the first container, not the architecture.
Requirement 10 and §4 make the pipeline format-agnostic from the first commit;
§5.7 lists what an image or office-format analyser would add and what it costs.

**Terminology note:** PDFs do not carry EXIF themselves. The PDF equivalents are
the Info dictionary and the XMP packet. EXIF only exists inside embedded JPEG
images, and many PDF producers strip it.

---

## 2. Hard requirements

1. **The PDF never leaves the visitor's machine.** No `fetch`, `XHR`,
   `sendBeacon`, `WebSocket` or form post ever carries file content.
2. No outside origin is contacted during analysis. Other Õigusmasin resources and
   external font hosts are permitted before and around the analysis.
3. After the page has loaded, analysis issues **zero** requests that carry file
   content, and no request to any origin but this one. A cold load with no network
   is explicitly **not** promised — that would need a service worker, which is not
   in scope.
   → **Corrected in revision 7.** This used to read "zero network requests", and
   phase 5 falsified it: a format's modules are loaded lazily, so selecting a PDF
   fetches `index.js`, `raw.js` and `lexer.js` from this origin. They carry no
   file content and they are code we wrote, so the promise was never in danger —
   but a test that says "zero" and a page that makes three requests is a test
   that will be quietly weakened until it passes. The requirement is now the one
   that actually protects the file, and the test below checks the stronger claim:
   every request is same-origin *and* happens before any file is read.
4. Static files only, served over HTTPS from this repository's GitHub Pages site.
5. All libraries vendored locally, pinned to an exact version, each with its
   licence text under `lib/LICENSES/`.
6. Interface in Estonian. Technical identifiers, PDF key names and code comments
   in English either way — see requirement 12.
7. **No build step.** No bundler, no transpiler, no npm install at build time.
   The served files are the authored files. This is what makes §11's "anyone can
   host their own copy" true.
8. SI units: bytes, kB (1000 B), MB (1000 kB), millimetres. The exact byte count is
   always shown next to the rounded figure.
9. The page must pass the repository's existing gates: `npm run verify`
   (`test`, `check`, `contrast`, `css`) and `npm run smoke`.
10. **Nothing in the interface assumes PDF.** The tabs, the tables and the search
    are driven by a common node structure, not by the PDF layers in §5. Today
    exactly one container analyser is registered; the architecture is built so that
    image and other document formats can be added without touching §5 or §6. See
    §4.4 and §5.7.
11. **Display only.** No export, download, share or save path exists in the code.
    Not "hidden by default", not "disabled for now" — absent. A static test fails
    the build if `Blob`, `URL.createObjectURL`, a `download` attribute or a
    file-save API appears in the page's own sources.
12. **English code, Estonian content.** The split is a hard boundary and it does
    not bend:

    | English — code | Estonian — content |
    |---|---|
    | class, id and `data-*` names | visible text: headings, labels, hints, messages |
    | variable, function, module and file names | `aria-label` and `alt`, which are read aloud |
    | CSS selectors, custom property names | values shown in the tables |
    | node keys: `group`, `labelEn`, `confidence`, `raw` | `labelEt`, and every string in §6.1 |
    | code comments, and this document's prose | error messages and status lines |

    `group` is the sharp end of this. A tab's identity is an English key
    (`info`, `structure`), because it routes, compares and appears in the search
    index. Its Estonian name (`Infodiktsioon`) is a *label*, carried separately and
    looked up at render time. Routing must never depend on a translatable string,
    or translating the interface breaks the tabs.

    A static test fails the build if an Estonian character appears in a `.js` or
    `.css` file outside a string literal, or in an HTML `class`, `id`, `name` or
    `data-*` attribute. Phase 11.

---

## 3. Where this lives in the repo

```
oigusmasin/
├── metaandmed.html          the page: file input, tabs, tables
├── metaandmed.js            UI, tabs, search  (module)
├── formats/                 one directory per container or blob format
│   ├── registry.js          format id, magic bytes, MIME, loader  (the only
│   │                        place that knows which formats exist)
│   ├── contract.js          the analyser interface every format implements
│   ├── node.js              the common node shape the UI consumes
│   ├── pdf/
│   │   ├── raw-scanner.js   raw-byte PDF parser, a classic Web Worker
│   │   └── structure.js     the pdf.js layer
│   └── images/              future: JPEG, PNG, TIFF — see §5.7
├── lib/
│   ├── pdf.min.mjs          pdfjs-dist 4.10.38
│   ├── pdf.worker.min.mjs   same version
│   ├── exifr.min.js         EXIF reader, loaded lazily on first JPEG
│   └── LICENSES/            Apache-2.0 for pdf.js, MIT for exifr
└── test-pdfs/               small corpus; excluded from the deployed site
```

`formats/` exists on day one with only `pdf/` in it. An empty sibling directory
with a README line is cheaper than restructuring later, when the UI and the tests
have all grown assumptions about PDF.

**Naming** follows the existing convention: lowercase ASCII kebab-case, umlauts
dropped (`ennetahtaegne-vabastamine.html`). The page is `metaandmed.html` and the
nav entry reads `Metaandmed` — **no format name in the filename, in the nav, or
in the `<h1>`**, so the second format needs no rename and no redirect. PDF is the
first analyser in the registry, not the name of the page.

**Integration work this implies**
- `nav.js`: add `{ label: "Metaandmed", href: "metaandmed.html" }` to `NAV_ITEMS`.
  One line, in the only file every page shares.
- The page must include `nav.js` and `noir.css` and carry the
  `#sidebar` / `#sidebar-overlay` / `#sidebar-toggle` scaffold, or
  `tools/check-assets.mjs` fails the build.
- **Styling goes in `noir.css`, not a page stylesheet.** An earlier draft of this
  plan said otherwise and was wrong on two counts. `tools/check-css.mjs` lints
  `noir.css` only — it does not scan every stylesheet — and its `checkNoInlineCss`
  rule fails the build on a `<style>` block with the message *"all CSS lives in
  noir.css"*. A separate `metaandmed.css` would therefore have been a second,
  unlinted stylesheet, which is exactly what the site avoids. The page's own rules
  go under a `── METAANDMED ──` section in `noir.css`, which is also where the
  file's own comment at `noir.css:1222` says single-page rules belong.
- A `<style>` block is also impossible under the CSP: `style-src` has no
  `unsafe-inline`. The same applies to inline `<script>`, which every existing
  page uses and this one must not — so `metaandmed.js` is an external module.
- `noir.css` has **zero** `style="..."` attributes anywhere in the site and only
  three CSSOM writes (`el.style.x = ...`), which CSP does not block. A strict
  `style-src` is therefore safe here. **[verify]** — checked in phase 2: the page
  loads with a clean console and only same-origin requests.
- `test-pdfs/` must stay out of the published site. **[verify]** which mechanism
  applies to this site.

**One tooling change is required before anything can be tested**
`tools/cdp.mjs` serves unknown extensions as `application/octet-stream`
(`tools/cdp.mjs:64`). Chromium refuses to execute an ES module with a
non-JavaScript MIME type, so `.mjs` files would fail to load in every headless
run. Add `".mjs": "text/javascript; charset=utf-8"` to the `MIME` map as step 1.

---

## 4. Architecture

### 4.1 Pipeline

Four stages. Only stage 2 knows what a PDF is; stages 1, 3 and 4 do not.

```
File
 │
 ▼
[1] identification ──► format id from magic bytes, not from the file extension
 │                     never trusts the name; a renamed file is reported as
 │                     "suspicious: extension does not match content"
 ▼
[2] container analyser (plugin)  ── formats/pdf/ today
 │      may also emit nested blobs: an embedded JPEG, a font program, an
 │      attachment, an ICC profile
 ▼
[3] blob analysers (plugin)  ── formats/images/ later; today: JPEG → exifr
 │      run over any Uint8Array, whether it came from a chosen file or from a
 │      container, so one implementation serves both
 ▼
[4] normaliser ──► common node tree ──► tabs, tables, search
```

The pipeline stops at stage 4. There is no stage 5, and that is deliberate: the
tree is rendered and discarded when the visitor selects another file. Nothing is
retained, cached or written anywhere.

The rule that keeps this cheap: **a format analyser never renders anything and
never touches the DOM.** It returns data. That is what lets the same code run in a
worker today and anywhere later, and it is also why the CSP stays as tight as §7
describes.

### 4.2 The contract

Every analyser implements the same three functions. `formats/contract.js` holds
the shapes; nothing in the UI references a PDF type.

```js
// formats/contract.js — the whole interface, in full
export const analyser = {
  id: "pdf",                       // stable id, shown in the format badge
  labelEt: "PDF",                  // shown in the format badge
  detect(bytes) { /* → 0..100 confidence, from magic bytes */ },
  async analyse(bytes, ctx) {
    // ctx = { limits, onProgress, emitNode, reportError }
    // returns { nodes, blobs, summary }
  },
};
```

`ctx.limits` carries the caps from §11 so no analyser invents its own. `emitNode`
lets a worker stream partial results so the UI can fill in progressively.

`blobs` is the extension point that matters for this revision: a container
analyser does not parse its embedded objects, it **hands them out** with a
declared media type, and stage 3 picks them up.

### 4.3 The common node

`formats/node.js` defines one shape used by every tab and by the search index.

```js
{
  id: "pdf.info.creationdate",   // English: identity and lookup
  group: "info",                 // English: tab routing key, never translated
  groupLabelEt: "Infodiktsioon", // Estonian: what the tab is called
  labelEt: "Loomiskuupäev",      // Estonian: what the visitor reads
  labelEn: "CreationDate",       // shown in parentheses after labelEt
  value: "2004-06-01T12:00:00+03:00",
  raw: "D:20040601120000+03'00", // the toorandmed toggle
  children: [],                  // for tables and trees
  confidence: "declared",        // declared | repaired | unreadable | absent
}
```

**`group` is English on purpose** (requirement 12). It is the routing key: the UI
groups by it, the search indexes it, and a tab exists because some node carries
it. If it were `infodiktsioon`, translating the interface would break the tabs.
The Estonian name travels separately in `groupLabelEt`, resolved once at render
time.

`labelEn` is shown on the page, not consumed by an export: the user reads
*Loomiskuupäev (`CreationDate`)* and recognises the key they know from the PDF
spec. `confidence` carries the honesty requirements from §5.2 (parandatud) and
§5.4 (vastuolu) into the UI, instead of each tab inventing its own wording.

### 4.4 Registry and lazy loading

`formats/registry.js` is the only file that knows which formats exist:

```js
export const FORMATS = [
  { id: "pdf", detect: pdfMagic,   load: () => import("./pdf/index.js") },
  { id: "jpeg", detect: jpegMagic, load: () => import("../images/jpeg.js") },
];
```

- Detection runs on the first bytes only, is cheap, and is done for every
  registered format, so an unknown file still gets a correct "tundmatu formaat"
  answer rather than nothing.
- A format's code loads **only when its format is detected**, through a dynamic
  `import()`. This keeps the initial payload at PDF-only size, and each addition
  costs nothing until someone selects a file it can read. `script-src 'self'`
  already permits same-origin dynamic imports; no CSP change is needed.
- The `<input accept>` attribute is derived from the registry rather than
  hard-coded, and is only a convenience — detection does not depend on it.
- Adding a format is therefore one new directory, one registry line, one corpus
  folder, and **nothing else**.

### 4.5 Memory

Read the file once per analyser, not once per stage. The `File` is
structured-cloneable by reference, so posting it to a worker copies no bytes; each
consumer calls `blob.arrayBuffer()` inside itself and releases it when done.
pdf.js receives `{ data }`, never `{ url }` — the first half of the
file-stays-local guarantee is that pdf.js is never handed anything it could
fetch.

The previous design read the file once in the main thread and cloned it onwards,
which meant three resident copies (main thread, scanner, pdf.js). The current one
peaks at two. A 250 MB file therefore costs roughly 500 MB, not 750 MB.

**[verify] measured, and the prediction was wrong by a factor of three.**
Phase 12 ran the test §8 asked for — 50 MB, 200 MB and 300 MB, each in a fresh
browser process, each a real parseable PDF — and watched every process's resident
set, not the page's JS heap:

| File | Peak resident | Time | Pages |
|---|---|---|---|
| 49.9 MB | ~475 MB | 3.4 s | 796 |
| 199.8 MB | ~1758 MB | 12.2 s | 3185 |
| 299.7 MB | ~2151 MB | 18.1 s | 4778 |

That is `206 MB + 6.85 × the file size`, not `2 ×`. The copies are real and they
are all identifiable: the `File`, the `Uint8Array` read from it, the latin1
string the raw scanner works on, the copy handed to pdf.js, and that copy again
inside the worker. Five, not two — the estimate counted the design, not the
implementation. Publishing `2 ×` would have been a number no measurement agreed
with, so the figures above replace it.

The JS heap itself is flat: ~52 MB after a forced GC on every file, with no
per-file growth, and the browser's process count constant. The growth is the
allocator holding pages it has not returned, plus the worker's own copy — which
is why the honest number is resident memory, not heap size.

**Hashing.** `crypto.subtle.digest` takes the whole message at once, so hashing a
250 MB file costs one full buffer. It runs once, in the identification stage,
before any analyser starts, and is not repeated. MD5 is a small vendored
implementation (no Web Crypto equivalent); it runs on the same buffer in the same
pass.

**Blob handling.** Embedded objects are already in memory as part of the file, so
stage 3 slices from the same buffer rather than re-reading. Only the payload of
a `DCTDecode` image is copied out, and only when an image analyser is registered
— otherwise the copy never happens.

**The cap.** 200 MB, enforced in `formats/registry.js` before anything reads the
file. It is checked against `File.size`, so a 2 GB file costs one property lookup
and one Estonian sentence rather than the tab's memory. See §12 decision 1.

### 4.6 Library choice

- `pdfjs-dist@4.10.38` (Apache-2.0), pinned. `lib/pdf.min.mjs` +
  `lib/pdf.worker.min.mjs`, imported with `<script type="module">`. pdf.js creates
  a module worker of its own; `worker-src 'self' blob:` covers it.
- `getDocument()` is called with `isEvalSupported: false`. The patched pdf.js no
  longer uses `eval` at all, but setting the flag removes the whole class of
  question and costs nothing here, since nothing is rendered.
- pdf-lib is deliberately left out. The custom parser plus pdf.js covers everything
  planned.
- **No `cmaps/`, no `standard_fonts/`.** Nothing is rendered, so pdf.js never looks
  for them. If a future version wants page previews or a text layer, this decision
  is revisited and `connect-src` is revisited with it.
- exifr is loaded dynamically, only when the first `DCTDecode` image is found —
  which under §4.4 means "only when an image analyser that uses it is registered",
  not a special case in the PDF path.
- Checksums for every library are recorded in `README.md` next to the version.
  A format added later adds its own line there, not a rewrite.

---

## 5. Analysis layers — the PDF container analyser

These are the layers the **PDF analyser** produces. They are not the tabs, and
they are not the only thing the page can produce: §4 maps them onto the common
node shape, and §5.7 lists what plugs in beside them.

Field names below follow the language convention in the preamble.

### 5.1 Failitaseme andmed (file level) — File API, Web Crypto

| Estonian | English / key |
|---|---|
| Failinimi | name |
| Suurus | size — bytes, kB, MB |
| MIME-tüüp | MIME type, as reported by the browser |
| Muudetud | last modified |
| SHA-256 kontrollsumma | SHA-256 digest |
| SHA-1 kontrollsumma | SHA-1 digest |
| MD5 kontrollsumma | MD5 digest |
| Päiseversioon | header version, `%PDF-x.y` |
| Päise asukoht | header offset — not always byte 0; the spec allows it anywhere in the first 1024 bytes, and real files have prefixes |
| Binaarne märkus | binary marker comment after the header |
| Andmed päise ees | bytes before the header |
| Andmed pärast viimast `%%EOF` | trailing data — junk or appended content |

### 5.2 Toorandmete skann (raw byte scan) — own parser

The main forensic value, and not exposed by pdf.js.

- **Asendid (offsets)** of every `%%EOF` and `startxref`. For `xref` and
  `trailer`, raw byte matching is not enough: `xref` occurs inside `startxref`,
  inside binary streams, and inside compressed data. Only a `xref` at the start of
  a line, not preceded by `start`, and followed by a syntactically plausible table
  header counts as structural. Everything else is listed separately as
  *kahtlane kandidaat* (unverified candidate), with its context bytes shown.
- **Inkrementaalsed versioonid (revisions)**: reconstruct the `/Prev` chain.
- Per revision: **tüvi** (`trailer`), `/Root`, `/Info`, `/ID` paar (pair),
  **objektide arv** (object count).
- Info dictionaries compared across revisions, so the UI can show what changed and
  when.
- **Ristviidestik** (cross-reference): **klassikaline tabel** (classic table),
  **ristviidevoog** (xref stream), or **hübriid** (hybrid, `/XRefStm`).
  **Objektifooog** (object stream) present.
- **Parandusrežiim** (repair mode). When `startxref` is wrong or the table is
  inconsistent, scan the whole file for `N G obj`, rebuild the object map from
  that, and mark every affected number as *parandatud* (repaired) rather than
  *deklareritud* (declared). Real-world files with bad xrefs are the main
  forensic case; this is what the hand-written parser is actually for.
- **Lineariseerimine** (linearisation) parameters.
- **Krüpteerimine** (encryption): presence of `/Encrypt`, `/Filter`, `/V`, `/R`,
  **võtme pikkus** (key length), **lukuõigused** (permission flags) decoded.
  For encrypted files the UI must state what stays readable: strings inside
  `/Info` **are** encrypted; only the strings in `/Encrypt` itself and the trailer
  `/ID` are not. The ciphertext length of an `/Info` string leaks the plaintext
  length, which is worth showing.
- **Infodiktsioon** (Info dictionary) and **XMP-kott** (XMP packet), raw, as text.
- **Kuupäevade teisendus** (date conversion): PDF date strings
  (`D:YYYYMMDDHHmmSSOHH'mm'`) to ISO 8601, original shown beside. Flag the common
  producer bug of writing local time with a `Z` offset.
- **Tekstikodeering** (string decoding): UTF-16BE (BOM `FE FF`) and PDFDocEncoding.
- **Filtrid** (stream filters). `DecompressionStream('deflate')` covers
  `FlateDecode`, the overwhelming majority; **PNG-prediktor** (`/Predictor 12`) is
  applied afterwards by hand. `LZWDecode`, `ASCII85Decode`, `ASCIIHexDecode` and
  `RunLengthDecode` are implemented directly — short, they appear in real files,
  and no browser API helps. `CCITTFaxDecode`, `JBIG2Decode`, `JPXDecode`,
  `DCTDecode` and `/Crypt` are reported by name but not decoded, and the UI says
  so rather than silently showing nothing.
- **Ristviidevood** (xref streams) specifically: `/W`, `/Index`, `/Size`, and the
  hybrid `/XRefStm` pointer. The PNG predictor is the smallest part of this, not
  the whole of it.
- **Objektifooad** (object streams): `/N`, `/First`, `/Filter`, `/Extends` chains.
- **Viitamata objektid** (unreferenced objects) and **vabaks märgitud objektid**
  (free objects), as an indicator of deleted content.

### 5.3 Dokumendi struktuur (document structure) — pdf.js

| Estonian | English / key |
|---|---|
| Lehekülgede arv | page count |
| Lehekülje suurus | page size in points → mm (1 pt = 25.4/72 mm ≈ 0.3528 mm) |
| Pöörang | `/Rotate` |
| Kastid | `MediaBox`, `CropBox`, other boxes where exposed |
| Raamatukuulised | outlines / bookmarks |
| Lehekülje sildid | page labels |
| Nimetatud sihtkohad | named destinations |
| Manused | embedded attachments — name, size, date; listed, never auto-opened |
| JavaScript ja avatoiming | document JavaScript and `/OpenAction`, listed as text only, never executed |
| Märkused | annotations — type, author `/T`, dates, contents |
| Vormiväljad | form fields and their types |
| Vaatleja eelistused | viewer preferences, page layout and mode |
| Keel | `/Lang` |
| Märgistatud PDF | tagged-PDF flag `/MarkInfo` |
| Valikuline sisu | optional content (layers) |

**[verify]** the exact getter set on 4.10.38 — `getJavaScript` and
`getPermissions` have been reshuffled across majors — before writing this layer.

### 5.4 XMP

- `DOMParser` does **not** resolve prefixes. `getElementsByTagName("dc:title")`
  will not work, and a hard-coded namespace list silently drops everything it does
  not know. Instead: walk every node reading `namespaceURI` plus `localName`, and
  keep the prefix separately for display. Unknown namespaces then appear instead
  of vanishing.
- Handle the `parsererror` document explicitly, and packets arriving as UTF-16.
- Show the **ehitusskott** (parsed tree) and the **toorpakk** (raw packet).
- Highlight **nimeruumid** (namespaces) `dc`, `xmp`, `pdf`, `xmpMM`, `pdfaid`,
  `pdfxid`: **vahend** (creator tool), `DocumentID`, `InstanceID`, the
  `xmpMM:History` **muudatuslogi** (edit log), and PDF/A and PDF/X
  **vastavusnäitajad** (conformance identifiers).
- Flag any **vastuolu** (disagreement) between the Info dictionary and XMP, for
  example differing dates or titles.

### 5.5 Kirjatüübid ja pildid (fonts and images)

| Estonian | English / key |
|---|---|
| Põhinimi | font base name |
| Tüüp | font type |
| Manustatud | embedded, or not |
| Alamhulk | subset — the six-capital-plus prefix, e.g. `ABCDEF+` |
| Kodeering | encoding |
| Mõõtmed | image dimensions |
| Bitte komponendi kohta | bits per component |
| Värviruum | colour space |
| Filter | filter, e.g. `DCTDecode` |
| Talletatud suurus | approximate stored size |

Images with `DCTDecode` are JPEG streams, so the raw bytes go to exifr. Expect EXIF
to be absent in many files, and say "EXIF-i ei leitud" rather than an empty table.

Images are not displayed. That keeps them out of the DOM and keeps `img-src`
near-empty.

**This is already a stage-3 blob analyser, not PDF code.** §5.5 does not parse
JPEG; it hands the payload out through the `blobs` channel in §4.2 with a declared
media type, and a separate `images/jpeg.js` module picks it up. The same module
then serves a JPEG the visitor selects directly, with no PDF-specific branch
anywhere. Extracting more from that JPEG — IPTC, XMP, ICC profile, PNG textual
chunks — is a change inside that one module.

### 5.6 Kokkuvõte (summary)

Facts only, no interpretation: number of revisions; producer and creator; creation
against modification dates; encryption; attachments; JavaScript present; XMP/Info
mismatches. The interface states only what the file contains. It does not conclude
who made a file or whether it was tampered with.

### 5.7 Edasised vormingud (future formats) — what plugs in, and what it costs

Not a phase list; a check that the architecture in §4 has the right seams. Each
row is one new directory under `formats/`, one registry line, one corpus folder,
and no change to §5 or §6.

| Format | Detected by | Adds | Notes |
|---|---|---|---|
| PNG | `89 50 4E 47` | `eXIf`, `tEXt`/`iTXt`/`zTXt`, `pHYs`, `iCCP`, `tIME` | Easy: chunk walk, no library needed |
| TIFF | `II*\0` / `MM\0*` | full IFD tag set, Exif IFD, GPS IFD, MakerNote | Hard: MakerNotes are vendor-specific and the main source of pain |
| JPEG (standalone) | `FF D8 FF` | already reachable via §5.5; only the registry line is new | The same module, a different entry point |
| WebP, AVIF | `RIFF`/`ftyp` | container boxes, EXIF/XMP | AVIF needs an ISO-BMFF box parser first |
| OpenType, TrueType, CFF | `00 01 00 00` / `OTTO` / `CFF ` | `name`, `OS/2`, `post`, `fvar`, `STAT` tables | Extends §5.5's font side; embedded font programs are already blobs |
| ICC profiles | `acsp` | header, tag table, description, colour space | Small and self-contained |
| ZIP-based office documents | `PK\x03\x04` | `mimetype`, `docProps/core.xml`, `app.xml` | The same core-properties shape as XMP; reuses §5.4's tree walk |
| JBIG2, JPX, CCITT | — | container structure only | Decoding stays out of scope, as in §5.2 |

**Two consequences to accept up front.**

1. **Extraction sensitivity.** Reading more out of an image means surfacing GPS
   coordinates, device serial numbers and capture timestamps — data the PDF layer
   never sees. Any such value gets an explicit Estonian label and is called out in
   the summary as *tundlikuks loetud metadata* (sensitive metadata read), so a
   visitor sees on screen that the machine holds it — and because there is no
   export (§1), that is where it stays.
2. **Namerahustus kinni** (naming settled). The page was named `metaandmed.html`
   in phase 2 rather than `pdf-metaandmed.html`, because a format name in the URL
   or the nav is a rename waiting to happen. §5.7's second consequence is
   therefore resolved and removed: nothing needs renaming, redirecting or
   keeping alive when format two arrives. The `<h1>` is *Metaandmed* and the
   detected format appears in a **formaadimärk** (format badge), never in the
   page title.

---

## 6. Interface, and the glossary

- Single page, one **loohtimisala** (drop zone) and one **failivalija** (file
  button), styled with the existing `noir.css` tokens.
- **Edenemine** (progress) per layer; tabs render as each layer completes, so a
  slow file is still useful early.
- Tabs: **Kokkuvõte · Fail · Versioonid · Info ja XMP · Struktuur · Kirjatüübid ja
  pildid · Toorandmed** (Summary, File, Revisions, Info and XMP, Structure, Fonts
  and images, Raw).
- **Tabs come from the node tree, not from a hard-coded list.** Each tab is a
  `group` value in §4.3 — an English routing key, with its Estonian name in
  `groupLabelEt`. A group with no nodes is hidden, so a file with no annotations
  does not get an empty Annotations tab, and a future format that emits different
  groups gets its own tabs for free.
- A **formaadimärk** (format badge) sits in the header, showing what was detected
  rather than what the extension claims. Today it always reads `PDF`; it is there
  so that adding a second format is a change to the registry, not to the header.
- **Toorandmete** (raw) toggle on every table, showing the underlying text.
- One **otsing** (search) box across all fields.
- **Näitamine ainult** (display only). There is no export button, no download, no
  "save results", no share link and no copy-the-whole-result. The metadata is
  rendered on the page and goes no further. §7 explains why this is a feature and
  not an omission.
- Selecting a second file replaces the first. Nothing is kept, and no state
  survives the tab.
- Individual values may carry a copy button, reusing the site's existing
  `copyButton()` helper from `nav.js:39`, so the page matches the rest of
  Õigusmasin. Copying one field the visitor is already looking at is not export;
  there is no control that copies a whole tab, let alone the whole result. Whether
  these stay at all is open decision §12.5.
- Keyboard-operable tabs with the correct ARIA pattern (roving tabindex,
  `aria-selected`), labelled controls, contrast from the existing palette.
- **Veakatted** (error states), each with a clear Estonian message: *rikutud fail*
  (corrupt), *katkendlik fail* (truncated), *krüptitud fail* (encrypted),
  *tühi fail* (zero-byte), *fail ei ole PDF* (non-PDF renamed to `.pdf`).

### 6.1 Terminology glossary (decides the strings once)

Two columns, two jobs, and requirement 12 draws the line between them. The
**Estonian** column is display text — it goes in `labelEt` or `groupLabelEt` and
appears on the page. The **English** column is either the code key, where one
exists (`Producer` is a PDF key and also a node id segment), or a gloss shown in
parentheses after the Estonian label. Neither column is ever used for routing.

| Group | Estonian (English) | `group` key |
|---|---|---|
| Tabs | Kokkuvõte (summary), Fail (file), Versioonid (revisions), Info ja XMP, Struktuur (structure), Kirjatüübid ja pildid (fonts and images), Toorandmed (raw) | `summary`, `file`, `revisions`, `info`, `structure`, `fonts`, `raw` |
| Revisions | inkrementaalne versioon (revision), ristviide (cross-reference), ristviidevoog (xref stream), tüvi (trailer), objekt (object), voog (stream), parandatud (repaired), deklareritud (declared), viitamata (unreferenced), vabaks märgitud (free) | `confidence` values: `repaired`, `declared` |
| Fields | tootja (`Producer`), looja (`Creator`), pealkiri (`Title`), autor (`Author`), teema (`Subject`), märksõnad (`Keywords`), loomiskuupäev (`CreationDate`), muudiskuupäev (`ModDate`), infodiktsioon (Info dictionary), kontrollsumma (checksum), krüpteerimine (encryption), lukuõigus (permission) | — |
| Structure | lehekülg (page), märkus (annotation), vormiväli (form field), manus (attachment), raamatukuulis (bookmark), manustatud (embedded), alamhulk (subset), värviruum (colour space), märgistatud PDF (tagged PDF), valikuline sisu (optional content) | `info`, `structure` |
| Chrome | loohtimisala (drop zone), failivalija (file picker), edenemine (progress), otsing (search), viga (error), kahtlane kandidaat (unverified candidate), tundlik metadata (sensitive metadata), kopeeri (copy) | — |

---

## 7. Privacy: what is actually guaranteed

The promise is one sentence: **the PDF never leaves the visitor's machine.**
This section states how it is kept, because the guarantee does *not* live in the
Content-Security-Policy.

**Why not the CSP.** A policy cannot express "you may connect, but never with file
content". It gates *origins*, not *payloads*. The guarantee therefore has exactly
three supports:

1. **Code.** The `File` is read only by `blob.arrayBuffer()`, in exactly two
   consumers. pdf.js is given `{ data }`, never `{ url }`, so it holds nothing it
   could fetch. No `fetch`, `XHR`, `sendBeacon`, `WebSocket` or form post anywhere
   in the project carries file content. Any future contributor who adds one is
   visible in review, because there is nowhere else for file content to go.
2. **Behaviour.** Phase 11 asserts, automatically, that **no request carries file
   content**, that **no request leaves the origin**, and that every request a
   format makes happens **before the file is read** — which is what lazy loading
   is supposed to guarantee. This observes what happened, not what was
   configured — stronger evidence than any policy line.
3. **Absence of an exit.** There is no export, no download and no share path, so
   there is no way for data to leave by any route other than the network — and the
   network is covered by 1 and 2. Requirement 11 makes this testable: the build
   fails if `Blob`, `URL.createObjectURL`, a `download` attribute or a file-save
   API appears in the page's own sources.

The third point is the one that makes the promise hold on a machine the visitor
does not control their own software on: without an export there is nothing to
copy, attach or mail, so the worst case for an attacker who gets the page to run
their script is *reading* what the visitor opened, which is what they can see
anyway.

**The CSP's actual job** is to stop injected third-party script from turning the
page into an exfiltration path. That is why `script-src` stays `'self'` even
though fonts may come from outside. Loosening it would turn the promise into a
promise.

```
default-src 'none';
script-src 'self';
style-src 'self' https:;
font-src 'self' https:;
img-src 'self' data:;
worker-src 'self' blob:;
connect-src 'self';
base-uri 'none';
form-action 'none'
```

- `script-src 'self'` — **locked deliberately.** No CDN, no analytics, no third
  party of any kind, at any point. This is the load-bearing line.
- `connect-src 'self'` — other Õigusmasin resources are reachable; no outside
  origin is. Analysis itself needs none of this, which is why the behavioural test
  in phase 11 still passes.
- `style-src`/`font-src` `https:` — headroom for an external font. Not needed today:
  `noir.css:23-45` vendors JetBrains Mono as local woff2, so the page renders with
  zero outside requests unless someone deliberately changes that.
- `img-src 'self' data:` — nothing is rendered. `blob:` was in the earlier draft
  for the export object URL and is now gone; it returns only with previews.
  `worker-src blob:` stays, because pdf.js may fall back to a blob worker.
- **[verify]** by loading the page with the console open; loosen only what is
  demonstrably needed, and `script-src` never.
- PDF JavaScript is never executed and never rendered. URI actions and links found
  in the file are listed as text and never followed.
- **A format added later inherits all of this without re-deciding it.** Every
  analyser receives a `Uint8Array`, not a URL, so there is nothing new it could
  send anywhere; the `script-src 'self'` lock covers its code as it covers pdf.js;
  and the phase 11 behavioural test counts requests for every registered format,
  not only PDF. A new format that reached the network would fail CI.

**Limits to state honestly in `README.md`**
- GitHub Pages sees the ordinary page-load request — IP address, user agent, time —
  in its own logs. It never sees the PDF.
- GitHub Pages on github.com does not allow custom HTTP response headers.
  **[verify] re-checked in phase 11** — still absent. Codeberg Pages added a
  limited `_headers` allowlist in February 2026, so the meta form is the only
  option on this host rather than a workaround. The CSP is a meta tag, it is the
  first element in `<head>`, and `check-assets.mjs` fails the build if anything
  executable moves above it.
- A meta-tag CSP ignores `frame-ancestors`, `report-uri` and `sandbox`. It also
  applies only from the point it is parsed, so it must be the first element in
  `<head>`.
- This page has the CSP; the other Õigusmasin pages do not. Extending it to them is
  a separate piece of work.
- The guarantee is about this page's code. It does not survive a modified copy of
  the site — hence the open source, hence the phase 11 test, and hence the static
  check that keeps the exit shut.

**How a visitor can verify**
1. Open DevTools, Network tab, reload, then analyse a PDF.
2. Nothing appears after file selection.
3. Look for an export or download button. There is none to find — that is the
   design, not an oversight.
4. Switch the device to airplane mode and analyse a PDF. (With the page already
   open — see requirement 3.)

---

## 8. Open technical questions

| Question | Why it matters | How to check |
|---|---|---|
| ~~Is `blob:` needed in `worker-src`?~~ **answered in revision 9** | pdf.js can fall back to a fake worker, which would break under this policy | Not needed: `workerSrc` points at the vendored file and the real worker is used. Keep `blob:` in the policy as the safety net |
| ~~Does pdf.js 4.10.38 run under this policy with no cMaps?~~ **answered in revision 9** | It is the premise of §4 | Yes: loads and reads under the locked CSP, vendored worker used, **zero cMaps requested** on every corpus file |
| `DecompressionStream` support on target browsers | Needed for `FlateDecode` | Test Chrome, Firefox, Safari; fall back to pdf.js data if absent |
| Exact peak memory and the resulting file-size cap | Sets the number published to visitors | Test 50 MB, 200 MB, 300 MB; watch the tab's memory |
| Does the CSP break `noir.css` or `nav.js`? | Whole-page styling and navigation | Load with the console open; `npm run contrast` still passes |
| Encrypted PDFs | Some strings and streams are unreadable without a password | Test RC4 and AES variants; show what is readable and say what is not |
| ~~Which pdf.js getters exist in 4.10.38~~ **answered in revision 9** | §5.3 is written against the 3.x API | Read: `getJSActions`, not `getJavaScript`; `getPermissions` returns a bitmask; **`/Lang` has no getter at all** and is read by `raw.js` instead |
| How are `test-pdfs/` kept off the published site | Size and licensing | Check what the Pages build includes |
| Does `emitNode` streaming survive structured clone of a node with `children` | §4.2's progressive rendering depends on it | Build the smallest possible version, then test a large file |
| Detection on magic bytes alone: false positives? | A truncated or ambiguous file must be reported as such, not guessed at | Feed the corpus in §10 plus every damaged variant |

---

## 9. Build phases

Each phase has a verification step before moving on.

1. **Tooling prerequisite**
   Add `.mjs` to the `MIME` map in `tools/cdp.mjs`.
   → verify: `node tools/smoke-test.mjs` still exits 0.

2. **Skeleton**
   `metaandmed.html` with the CSP meta tag as the first element in `<head>`,
   `lang="et"`, file input, drag-and-drop drop zone and nav scaffold; nav.js entry;
   page styles under a `── METAANDMED ──` section in `noir.css`; strings from the
   §6.1 glossary. Both scripts external — the CSP has no `unsafe-inline`.
   → verify: `npm run verify` and `npm run smoke` both pass; the page loads over
   HTTPS; console clean.

3. **Format spine**
`formats/contract.js`, `formats/node.js`, `formats/registry.js`, the four-stage
    pipeline, magic-byte detection, lazy `import()`, and one analyser registered:
    `formats/pdf/`. Tabs render from `group` values. **The PDF layers come later;
    this phase ships an empty-but-working pipeline with a stub analyser.**
    → verify: an unknown file reports *tundmatu formaat* cleanly; a PDF is
    detected and routed; the tab scaffolding already renders from `group` values,
    empty.

3b. **Language split, enforced** — *done in revision 5*
    `tools/check-language.mjs`, wired into `npm run verify` and `test.yml`.
    No Estonian outside a string literal in `.js`/`.css`, and none in an HTML
    `class`, `id`, `name` or `data-*` attribute. `aria-label`, `alt` and body text
    are exempt — they are content.
    → verified by planting each violation: Estonian identifier, Estonian comment
    in `.js`, Estonian comment in `.css`, Estonian `class` — all four fail. Estonian
    in `aria-label` and body text — passes. **Comments are deliberately *not*
    stripped before scanning**, because requirement 12 puts comments on the
    English side; an earlier draft stripped them and passed a file containing
    `// märkus: …`, which is the exact failure the check exists to prevent.

    Scope is the analyser's code, not the whole repo: `tools/` and the older pages
    predate the rule and contain "Õigusmasin" and the filename
    "ennetähtaegne-vabastamine" in otherwise-English comments. A regex cannot
    tell a product name from a sentence written in Estonian. Widening the check
    is one line once those two comments are reworded.

    **Module loading, settled.** `formats/*.js` are ESM for the browser; Node
    refuses to import them cleanly (`MODULE_TYPELESS_PACKAGE_JSON`, because
    `package.json` has no `"type": "module"`). No test needs to: both static
    checks are pure text processing over files, and the behavioural check runs in
    Chromium through the page. Renaming to `.mjs` or adding `"type": "module"`
    would be a repo-wide change bought for nothing.

4. **File layer** — *done in revision 6*
   Failitaseme andmed and hashes, in the identification stage.
   → verified: all three digests match `sha256sum`, `sha1sum` and `md5sum` on the
   same file, in the browser, on a 69-byte PDF, a duplicate of it, and a 300 KB
   non-PDF. MD5 additionally matches `md5sum` at 27 lengths chosen to straddle
   the 56/64-byte padding boundaries, plus all seven of RFC 1321's own vectors.

   SHA-256 and SHA-1 come from Web Crypto; **MD5 is implemented from RFC 1321**,
   because the platform exposes no MD5 and requirement 8 asks for one. Written
   here rather than vendored, so there is no licence to ship and no version to
   pin — and verified against the system tool rather than trusted.

   **Hashing runs before the detection gate.** An earlier draft returned early on
   an unknown format, which left a file the tool could not read with no checksum
   at all. "What is this file" is most often exactly the question someone has when
   the format is unrecognised, and the digests describe bytes, not formats. The
   cost is that a large unrecognised file is read in full; §12's file-size cap has
   to be tested against an unknown format, not only against a PDF.

5. **Raw parser, core** — *done in revision 7*
   Päise asukoht, `%%EOF`/`startxref` skann koos kandidaatide filtreerimisega,
   `/Prev` ahel, klassikalised ristviidetabelid, Info ja XMP toorandmed.
   → verified against **qpdf**, an independent implementation, on three files:
   every cross-reference offset matches qpdf's byte for byte, and every in-use
   offset is separately confirmed to point at its own `N 0 obj` header.
   A fourth file carries a `/Prev` chain and is checked for revision ordering and
   for the newest Info winning over the superseded one. A fifth has a `startxref`
   pointing outside the file and must report that rather than invent a revision.

   Two files split the module: `lexer.js` for PDF object syntax and `raw.js` for
   the byte-level scan. The lexer holds no Estonian and no opinion about layout;
   `raw.js` decides nothing about presentation. Neither reaches the other.

   **Four bugs the cross-check caught that no unit test had.**
   - `readName` compared a *character* against a `Set` of *byte codes*, so every
     name ran to end of file and one key swallowed the whole trailer. Silent, and
     total.
   - `readXrefSection` called `readClassicXref` without passing `notes`, so the
     first diagnostic raised inside the table reader threw on `undefined.push` —
     and the outer catch turned it into a bare "scan failed".
   - The entry cursor advanced past a fixed CRLF, but the common spellings are
     `n \r\n`, `n \n` and `n\r\n`. On a space-padded file it stopped on the space
     and **every object number came out one too low** — an error that looks like
     plausible data rather than a crash, which is the worst kind to have.
   - `readInfo` read `.info` off a lexer dictionary, where it does not exist.

   One §5.2 requirement was corrected rather than met. The XMP packet was cut at
   `</x:xmpmeta>`, dropping the closing `<?xpacket end="w"?>` — the line that says
   the packet is complete rather than cut short, which is the most useful thing
   about it. `</x:xmpmeta>` ends the metadata *inside* the wrapper, not the
   wrapper.

   `readInfo` also now verifies the object header at the offset the table gives
   and compares its object number with the one requested. A table pointing at the
   wrong bytes yields a dictionary that parses cleanly and says something untrue;
   this turns that into a reportable mismatch. It is the cheapest form of the
   repair mode phase 6 will do properly: detection, no repair.

   And this phase falsified a privacy claim of our own — see requirement 3 in §2
   and §7's item 2, both rewritten. The old wording promised zero network requests
   during analysis; lazy module loading makes three, same-origin and contentless.
   The requirement is now the invariant that actually protects the file, and the
   test asserts the stronger claim: every request is same-origin, every request
   precedes the file read, and a second file triggers none at all.

6. **Raw parser, extensions** — *done in revision 8*
   Ristviidevood, objektifooad, the other filters, PNG predictor, encryption
   flags, date and string decoding, revision comparison, parandusrežiim.
   → verified: a hand-built xref-stream + object-stream file, which phase 5
   reported as unreadable, now yields all ten objects and an Info dictionary
   read out of the object stream. All five implemented filters decode a stream to
   the exact bytes qpdf produces from the same file — and ASCII85 is checked
   against Python's `a85decode`, because qpdf returns nothing for that one.
   The PNG predictor is checked against the plain bytes it was built from.
   All eight encryption permission flags are diffed against
   `qpdf --show-encryption`, by name. The repair scan is checked on a file whose
   `startxref` points outside itself.

   Three new modules, split by what they know rather than by what they do:
   `encoding.js` (bytes→text, and dates), `filters.js` (stored bytes→stored
   bytes), `streams.js` (xref streams and object streams). None imports the
   others' concerns and none emits a node — `index.js` still owns presentation
   entirely.

   **Five bugs the cross-checks caught, each invisible rather than loud.**
   - **The `/P` bit order.** §7.6.3.1's Table 23 numbers bits in a way that
     invites reading them from the wrong end. `>>> 3` is off by exactly one, so
     every flag except high-resolution printing came out right — and the corpus
     file `encrypted.pdf`, built precisely to distinguish the three candidate
     mappings, is what caught it. qpdf denies all eight; the parser allowed two.
   - **`/Size` read with the array helper.** `/Size` is a scalar. Reading it as a
     one-element array returned `null`, which produced an empty range list and
     therefore a cross-reference table with **no entries and no error anywhere**.
     A parser that reports an empty table for a file full of objects is worse
     than one that reports a malformed one.
   - **The PNG predictor's stride.** A row *occupies* `rowLength + 1` bytes —
     the filter-type byte plus the data — but the arithmetic spans only
     `rowLength`. Dividing by `rowLength` made each row's type byte the previous
     row's last data byte, so every row after the first decoded to wrong values
     that looked like a plausible image.
   - **`locateObject`'s search order in the comparison.** Resolving an object
     newest-first is right for "what does this file say now" and exactly wrong
     for "what did revision 2 say" — both revisions resolved to the newest
     definition, so the comparison found **nothing to compare**. The feature
     worked; it just never saw a difference.
   - **`capped()` on a plain array.** The decompression-bomb guard called
     `.subarray` on an `Array`, so the cap threw at exactly the moment it was
     needed — turning a bounded failure into an unbounded one.

   **The repair row is now emitted for files whose table could not be read.** An
   earlier draft returned early in that case, which meant the one class of file
   where rebuilding the object map is the entire point showed nothing about
   having been rebuilt.

   A fifth, structural: the phase-5 statement that a hand-written parser exists
   "for the forensic case" is now true rather than aspirational. `brokenxref.pdf`
   reports its dead pointer, then lists the six objects found by scanning, and
   marks the disagreement **parandatud**. Nothing is written and nothing is
   fixed — there is no export path — so "repaired" describes this module's
   reading of the bytes, never the file.

7. **pdf.js layer** — *done in revision 9*
   Leheküljed, kastid, raamatukuulised, manused, märkused, vormiväljad,
   JavaScripti loetelu.
   → verified: **the getter set was read from 4.10.38's own type definitions
   before any code was written**, as §5.3 requires. That paid for itself: the plan
   flagged `getJavaScript` and `getPermissions` as reshuffled, and both are wrong
   for 4.10.38 — it is `getJSActions`, and `getPermissions` returns a bitmask
   rather than a list. Also verified in a browser: version exactly 4.10.38, the
   vendored worker used, and **no cMaps requested** on any file — which is the
   evidence behind §4's claim that cmaps and standard fonts are not needed.

   A two-page document with an outline, a named-destination tree, a `/Rotate 90`
   page, a text annotation, `/Lang`, `/MarkInfo` and viewer preferences is read
   correctly, page size reported in both points and millimetres.

   **PDF JavaScript is displayed and never executed**, and that is tested rather
   than asserted. `javascript.pdf` carries a script calling `app.alert()` and an
   `/OpenAction` naming `https://example.invalid/`. Analysing it: the script body
   appears in the interface as text, `alert` is never called, the page never
   navigates, and `example.invalid` is never requested.

   **The privacy claim was measured with CDP's Network domain rather than
   `performance.getEntriesByType()`.** Over three consecutive files, **not one
   request carries a body**. That is stronger than counting requests and it is
   what §7 actually promises.

   Four bugs, and the first two would have shipped invisible:
   - **`PDFPageProxy.cleanup()` returns a boolean, not a promise.** The call site
     used `.catch()`, which threw *inside a `finally` block* — so it escaped its
     function and surfaced at the top of the page as "Analüüs katkes". The
     annotations, language and JavaScript rows all sat unread in memory while the
     page told the visitor the analysis had failed. An exception inside cleanup
     reported as a fault in the visitor's file.
   - **Annotation fields are `{str, dir}` objects**, not strings, and the date
     key is `modificationDate`, not `modDate`. Reading `a.title` yields
     `undefined`, which renders as a document with no annotation author — a wrong
     answer rather than an empty one. Caught by probing the runtime, because the
     type definitions are `any`.
   - **`/Lang` has no pdf.js getter at all.** `_pdfInfo` carries only `numPages`
     and `fingerprints`. Reaching into `doc.catalog.Lang` yields `undefined`, so
     a document declaring `et-EE` was reported as declaring no language. The
     catalog is read by `raw.js` instead, which already parses it. **A missing
     getter is a stronger argument for the hand-written parser than a present one
     would have been.**
   - **A `../../` path written as `../../../`.** The browser clamps a relative
     import at the origin root, so the page worked; Node's resolver does not
     clamp, and `spine-test.mjs` caught it on the next run. Worth remembering that
     one harness was forgiving and the other was not.

   Two changes made for reasons other than correctness, both measured:
   - **pdf.js is cached on `globalThis`, not in a module-level `let`.** The
     registry re-imports its analysers for every file, so a module-level cache
     died with the module and each file paid for the import again.
   - **`doc.destroy()` was removed.** It tears down pdf.js's shared worker pool,
     so every subsequent document respawns it. `cleanup()` still frees the
     per-document page caches. The residual cost is that the browser records a
     worker-script load per document — CDP confirms none of those requests
     carries a body, so this is script loading, not a transfer.

8. **XMP layer** — *done in revision 10*
   Nimeruumidest sõltumatu läbimine, muudatuslogi, vastavusnäitajad, Info ja XMP
   võrdlus.
   → verified against the two files §8 asks for: **a PDF/A file** (part 2,
   conformance B, PDF/X-4, DocumentID, InstanceID, creator tool — all read) and
   **a file with a known edit history** (`xmpMM:History` with two `stEvt` events,
   in order, with agents and `formattedDate` attributes). Both packets are also
   parsed independently by Python's `ElementTree`, which agrees on every value.

   **`DOMParser` does not resolve prefixes, so the walk never uses them.** Every
   element is read by `namespaceURI` + `localName`, and the prefix is carried
   alongside for display only. The consequence is the test that matters: the
   corpus carries an `acme:` namespace this project has never heard of, and both
   of its fields reach the interface with their values intact. A hard-coded
   namespace list would have dropped them silently — which is §5.4's whole
   warning, and the reason a list of *known* namespaces is used here only to
   sort the display, never to filter the walk.

   **A malformed packet is reported, with the parser's own words.** The obvious
   check — "is `documentElement` a `parsererror`?" — is wrong in the direction
   that matters: Chromium and WebKit put the `parsererror` element *inside* the
   partially-parsed tree, so the root looks fine. The first draft reported a
   broken packet as "parsed successfully, six properties", which is exactly the
   confident wrong answer §5.4 warns about. The check now searches the whole
   document, and the visitor sees the engine's message.

   **Info/XMP disagreements are surfaced, never resolved.** Dates are compared as
   instants rather than as strings — `/Info` writes `D:20240315103000+02'00'` and
   XMP writes ISO 8601, so a string comparison would report every document in
   existence as disagreeing with itself. Both values are shown for every
   conflict, because which dictionary a reader trusts is their decision.

   Three bugs, and the tooling gap the first one exposed:
   - **`stripEnvelope` sliced to end of string**, leaving the closing
     `<?xpacket end="w"?>` attached — and a processing instruction that never ends
     is fatal to an XML parser. A valid packet was reported as malformed. Only
     the UTF-16 file showed it, which made it look like a decoding bug rather
     than the envelope bug it was. The cause was one character: the close tag was
     built as `</${tagName}>` where `tagName` already began with `<`.
   - **`rawScanPacketChildren` was called but never written**, and `MAX_XMP_RAW`
     was a `const` declared *after* its use — in the temporal dead zone. Both
     are the same mistake: a long function written in one pass and wired in
     before it was checked.
   - **Chromium cached the edited module.** `tools/cdp.mjs` sent no cache header,
     so an ES module kept serving its previous contents and a fixed bug looked
     unfixed. The server now sends `Cache-Control: no-store`, which is correct
     for a file server whose whole purpose is to serve source that changes.

   ### The tooling gap, recorded because it generalises

   A scripted edit replaced a template literal's closing backtick with a double
   quote. **Every check in `verify` passed it** — the language check reads files
   as text, the CSS check reads CSS, the asset check resolves references, and
   none of them parse JavaScript as JavaScript. The error reached a browser as
   `SyntaxError: missing ) after argument list`.

   `tools/check-syntax.mjs` now compiles every module with
   `vm.SourceTextModule`, which links the graph **without evaluating it** —
   `metaandmed.js` and `nav.js` touch `document` at top level, and a check that
   imports them reports `document is not defined` and has stopped being a
   parser. It runs first in `verify` and first in CI, and it was validated by
   planting the exact bug and watching it fail with a line number while the other
   five checks passed it.

9. **Fonts and images** — *done in revision 11*
   Loendid, and the `blobs` channel; the first stage-3 analyser,
   `formats/images/jpeg.js`, loaded dynamically via exifr.
   → verified against a PDF built from a photo whose EXIF values are known
   (Make, Model, DateTimeOriginal, GPS latitude and longitude), checking that
   they survive the round trip; **and** against that same JPEG selected directly.
   The second test compares the two **node trees**, not the two pages: identical
   bytes must produce an identical tree, and no node id may mention a PDF object,
   a page or a container. An assertion on rendered text would not have caught a
   stray `/Pages` lookup — it would simply have returned nothing and changed no
   line.

   **Stage 3 existed as a diagram and not as code.** §4.1 has always drawn the
   blob stage and §4.2 has always defined `BlobRef`; the registry collected
   `blobs` into an array and returned it to nobody. This phase wrote it: blob
   analysers are registered by **media type**, not by blob index, because keying
   by index would have made "embedded in a PDF" and "selected directly" two
   different code paths wearing one name — which is the exact thing §5.5 says
   must not happen.

   **`images.js` never imports exifr.** That is the whole architectural point:
   the PDF layer describes an image from the dictionary the PDF already wrote and
   hands the *bytes* across a boundary. If it parsed JPEG itself, the knowledge
   would live inside the PDF code and the module could not be reused.

   Three bugs, and one of them was a security-relevant failure of honesty:
   - **`bytes.slice()` before handing them to pdf.js.** The code claimed the
     transfer "costs no copy". It does not: a transfer *moves* the ArrayBuffer
     and detaches it, so the image walker's `subarray` threw
     `Cannot perform Construct on a detached ArrayBuffer` — after the whole
     document had been analysed successfully. Every earlier tab was correct and
     the images row was simply absent, which reads as "this document has no
     images" rather than as a crash.
   - **`exifr.parse()` with `silentErrors: true` does not throw.** It returns an
     object whose only key is `errors`. That object is truthy, so a four-byte
     truncated file was reported as "1 väärtust" of EXIF. The check is now "did
     it return anything other than its own errors", which is the only thing that
     distinguishes *no EXIF* from *could not read it*.
   - **The catalog reaches the page tree through `/Pages`, not `/Kids`.** Both
     walks started at the catalog, found no `/Kids`, and reported "this document
     has no fonts and no images" — the correct-looking answer to a question that
     was never asked. `resolver.each()` now accepts a single reference as well as
     an array, because `/Pages` is one ref and `/Kids` is an array and both mean
     "the children are over there".

   ### The second off-by-one, and the check that now catches both

   `images/jpeg.js` loaded exifr from `../../../lib/` — three levels up from a
   file two levels deep. The browser clamps a path that climbs above the origin
   root, so **every page test passed** and the module silently fell back to
   "EXIF-i ei leitud" on a JPEG full of EXIF. Only Node's stricter resolver
   complained, and only where nobody was looking.

   This is the same mistake `structure.js` made in phase 7, so `check-syntax.mjs`
   now resolves every relative dynamic `import()` on disk. The message says why
   it is a separate check — a browser clamping a bad path is a fact worth writing
   down rather than rediscovering.

   **exifr is the `full` build, not `lite`.** `mini` is EXIF only and `lite`
   drops XMP; §5.4's argument about dropping what you do not recognise applies
   here too — a narrower build reports fewer fields for reasons that have nothing
   to do with the file.

10. **UI** — *done in revision 12*
    Tabs from node groups, otsing, toorandmete lüliti, formaadimärk, bilingual
    labels, per-value copy buttons, veakatted.
    → verified: all five of §6's error states — *rikutud*, *katkendlik*,
    *krüpteeritud*, *tühi*, *fail ei ole PDF* — produce a finished analysis, an
    Estonian sentence, and a result block. None crashes.

    **"No second representation" is measured, not asserted.** §10 asks that every
    displayed value be rendered from a node and nothing else, which cannot be
    checked by reading code. So it is checked arithmetically: the node tree is
    published read-only, every string the page draws is collected, and each is
    required to be a node string, to contain one, or to be chrome §6.1 names.
    On the richest corpus file: **221 strings drawn, 265 available, 0
    untraceable.** A renderer that invented a value would appear in the first
    column and neither of the others.

    **Toorandmed** shows the raw text only where `raw` differs from `value`.
    Most fields store the text that is displayed, so a raw line under every value
    would double the height of every table to repeat the line above it. Where the
    underlying text *is* the value, §6's requirement is already met on screen.

    **Kopeeri** reuses `nav.js`'s `copyButton()`, so the page matches the rest of
    the site and does not become the fourth copy of it. 76 buttons on a rich
    file, each with an accessible name naming its field, hidden at rest by
    `opacity` rather than `display: none` — a keyboard user who cannot hover can
    still reach them.

    **Tundlik** marks the GPS coordinates §5.7 singles out. The word is shown as
    well as a border, so the distinction survives being read aloud or printed in
    greyscale.

    Two bugs, both of the same kind: **an edit that silently broke every
    analysis.**
    - A `__lastNodes` line was inserted into `renderTabs()` instead of
      `select()`, because the two shared an anchor line. `renderTabs()` has no
      `result`, so every file died with `ReferenceError: result is not defined`
      and the page sat on **"Analüüsin…"** forever — a message that looks like a
      slow file rather than a crashed one.
    - **No earlier suite caught it, and the reason is worth recording.** Every
      error-state assertion checked the *status line's content* — and "Analüüsin…"
      is content. The crash test read `window.__pageErrors`, which **the page
      never defines**, so `JSON.stringify(undefined || [])` was `"[]"` and six
      "does not crash" assertions passed against a page that was throwing on
      every single file.

      Two assertions were added: page errors are now collected from CDP's
      `Runtime.exceptionThrown`, and every error state asserts the status line is
      **no longer "Analüüsin…"** — because that string is the exact residue of a
      silently-failed analysis, and no suite had been looking for it.

11. **Privacy and language verification, automated** — *done in revision 13*
    Three tests, all added to `npm run verify` and to `.github/workflows/test.yml`.

    *Behavioural.* `tools/privacy-tests.mjs` on top of `tools/cdp.mjs`: `Network.enable`,
    load the page, select each test file, assert that **no request carries a
    body**, that none leaves the origin, that the page never requests the file by
    name, and that the analysis finished. It also asserts **zero CSP violations
    and zero uncaught exceptions** across every file. The test iterates the
    **registry** (`FORMATS`, now exported by `formats/registry.js`) rather than a
    hard-coded PDF list, so a format added later is covered the day it lands.

    → **verified by planting the failure**, which is the only way a test that
    passes proves anything. `navigator.sendBeacon("https://example.invalid/…",
    bytes)` was added to the registry and the test failed — and it failed with
    *"Connecting to … violates the following Content Security Policy directive:
    `connect-src 'self'`. The action has been blocked."* The CSP stopped the file
    in the browser before a byte left, and `check-assets.mjs` caught the same
    line statically. Two independent layers, both proven.

    *Static, no exit.* In `tools/check-assets.mjs`, over `metaandmed.{html,js}`
    and `formats/**`, with **comments and strings stripped first** — otherwise
    this file's own explanation of the rule fails the build, which is a false
    positive that teaches people to ignore the check. `lib/` is excluded: the
    claim is that *we* wrote no exit, not that no library contains one.

    → verified by planting: `new Blob` is caught, a `download="x.json"`
    attribute is caught, `sendBeacon` is caught, and **a comment naming
    `createObjectURL` is correctly ignored**.

    *Static, language split.* Requirement 12, already in place since phase 3b.

    → verified by planting `class="… märgistus"`, which fails with a line number.
    **And by planting the example this plan itself names, `kaust`, which does
    not fail — because `kaust` contains no Estonian letter.** `tulemus` and
    `seade` do not either. The check is a high-confidence filter for the mistakes
    that actually happen, not a language detector, and `check-language.mjs` now
    says so in the place a reader will look. A phase's own verification example
    that does not work is worth more in the record than a quietly passing test.

    **The CSP is now audited, not assumed.** `check-assets.mjs` asserts the
    policy is present, carries `default-src 'none'`, `script-src 'self'`,
    `connect-src 'self'`, `base-uri 'none'` and `form-action 'none'`, contains
    no `unsafe-inline`/`unsafe-eval`/`data:`/`blob:` in a script directive, and
    that **no `<script>` or `<style>` precedes it** — a meta policy applies only
    from the point it is parsed, so one byte of script above it governs less than
    it appears to. All three failure modes were planted and caught.

    The GitHub Pages header limitation was **re-verified at release time** as §7
    asks: GitHub Pages still sends no custom response headers. Codeberg Pages
    added a limited `_headers` allowlist in February 2026, so the meta form is
    not merely a workaround — it is the only option on this host.

    **`README.md` states what the promise is not**, because a privacy claim with
    an asterisk is not a privacy claim: GitHub Pages sees the page load; the
    guarantee is about this page's code; a meta CSP ignores `frame-ancestors`,
    `report-uri` and `sandbox`; the other Õigusmasin pages have no CSP; showing a
    document shows its GPS data on someone's screen; and the tests run locally
    and say nothing about the host.

12. **Documentation and release**
    README with the privacy promise and how it is kept, library versions and
    checksums, licence texts, the file-size cap, **how to add a new format** (the
    contract in §4.2, the registry line, the corpus folder), and a note that
    `file://` will not work (`crypto.subtle` needs a secure context and workers
    are blocked from `file://`, so a local server is required).
    → verify: another person can follow the README to host their own copy, and the
    README's "add a format" section is followed end to end by adding a stub format
    and seeing it detected.

    **Delivered, and what it cost.** The README gained a hosting section, a
    measured limits table, the `file://` warning, a four-step "Adding a format"
    section and a corpus section. `lib/README.md` gained SHA-256 checksums for all
    three vendored files. `tools/make-corpus.mjs` regenerates all 28 fixtures
    byte-for-byte. The cap is 200 MB, enforced before the read.

    Then the README's own instructions were followed verbatim, by
    `tools/extensibility-proof.mjs`, and **they did not work**:

    - the stub format was detected, and its badge read correctly, but it had **no
      tab at all** — `renderTabs()` filtered the static `GROUPS` constant, so a
      group a new analyser invented was silently discarded. §6 had promised the
      opposite, in these words: "a future format that emits different groups gets
      its own tabs for free." The plan was wrong and the page was wrong in the
      same way;
    - once a tab existed, it was labelled with the bare key `stub`, because
      nothing in the registry carried a name for it. Fixed with a `groups` field
      on the registry entry — still one line, still no edit to the page — so
      requirement 12 holds for formats that do not exist yet;
    - the proof's own cleanup check compared mtimes and reported a perfectly
      restored file as changed, which is the check that should have been
      comparing contents.

    That is the argument for executing §13's last item instead of asserting it.
    The first version of the page satisfied every test in the repository and
    still dropped a whole format's output on the floor, because no test asked.

---

## 10. Test corpus

A small set of deliberately varied files, created or obtained legally. No
confidential documents. Kept out of the published site.

- Simple PDF from Word and from LibreOffice (these produce xref streams and object
  streams, not classic tables).
- PDF from a browser print-to-PDF.
- PDF 1.4-era file with a classic xref table and an `LZWDecode` stream.
- PDF 2.0 file.
- Scanned PDF with a hidden text layer, plus one with CJK text, to prove the no-
  cMaps claim.
- PDF with incremental updates (edited and saved twice).
- Linearised ("fast web view") PDF.
- PDF with a broken `startxref`, to exercise parandusrežiim.
- PDF/A-1b and PDF/A-2b.
- Encrypted PDF: owner password only, and user password.
- PDF with attachments, bookmarks, annotations, form fields, JavaScript.
- PDF containing JPEG images with and without EXIF.
- Deliberately damaged files: truncated, bad xref offsets, trailing junk, zero
  bytes, a non-PDF renamed `.pdf`.

**They are generated, and they are also committed.** `tools/make-corpus.mjs`
rebuilds all 28 fixtures byte-for-byte and exits non-zero if any byte moved; the
fixtures are in the repository so they can be reviewed in a diff, opened by hand
and opened by a bug report. `npm run corpus` and CI both run it, so a fixture
that has drifted from its generator is a build failure rather than a surprise
found months later.

Two fixtures earned their place by being wrong first:

- `xrefstream.pdf` (cross-reference stream + object stream, the PDF 1.5 form Word
  and LibreOffice actually produce) was rejected by qpdf with "Cross-reference
  stream data has the wrong size; expected = 70; actual = 69" — its row 0 was six
  bytes where every other row was seven;
- `photo.jpg` was a **12288×2048, 64-component** image, built by writing the
  SOF0 fields in the wrong byte order. `file(1)` reported it happily, because the
  bytes were all present and all in range. It is exactly the kind of fixture that
  passes a check that does not know what it is looking at.

---

## 11. Risks and mitigations

- **Malformed or hostile input, in any format.** An analyser must never loop
  forever or allocate unbounded memory. The limits live in `ctx.limits` (§4.2), are
  written once, and are enforced for every analyser rather than per format:
  recursion depth, object count, a decompressed-bytes cap per stream and in total,
  and a wall-clock budget per analyser after which it reports what it has and stops.
- **A crafted PDF executing script in this origin.** Mitigated three ways: a patched
  pdf.js (≥ 4.2.67, pinned), `isEvalSupported: false`, and `script-src 'self'`
  with no `unsafe-eval`.
- **The file leaving the machine.** The one guarantee that matters. Held by four
  things: no analyser ever receives a URL, the absence of any upload-capable API
  call, the locked `script-src`, and the two phase 11 tests. The absence of an
  export path is the fourth, and it is the one a visitor can see for themselves.
- **Data on screen, therefore data in the visitor's screenshot.** A visitor who
  analyses a document with GPS metadata on someone else's screen has shown it.
  That is inherent to showing anything, and it is why sensitive values are labelled
  as such (§5.7) rather than quietly listed.
- **Large files.** Read once per analyser. The peak is **measured, not assumed** —
  §4.5's `206 MB + 6.85 × file size` — and the 200 MB cap is documented in the
  README and enforced against `File.size` before the read starts. The risk this
  mitigates is the one the first estimate hid: not that a file is large, but that
  the published figure was wrong by a factor of three.
- **Browser differences.** Test current Chrome, Firefox, Safari and Edge.
- **Library updates.** Pinned versions, with version, source URL and checksum in
  the README; updates are manual and checked. One library per concern, so a format
  added later does not drag in a dependency the PDF path already uses.
- **Over-claiming.** The interface shows only what the file contains. Repaired
  values are labelled parandatud; encrypted values are labelled unreadable.
- **More data means more sensitive data.** Adding image and office formats
  surfaces GPS coordinates and device identifiers (§5.7). Those values are labelled
  as sensitive and called out in the summary, so the visitor sees them flagged
  rather than buried in a table.
- **Scope creep.** Rendering is out of scope, and saying so is what keeps `img-src`
  and the vendored bytes small.

---

## 12. Decisions still open

**Resolved in phase 12:**

1. ~~Maximum supported file size~~ — **200 MB**, enforced before the read in
   `formats/registry.js`. Measured: 200 MB costs ~1.8 GB and 12 s, 300 MB costs
   ~2.1 GB and 18 s (§4.5). The line is not about what the page can do; it is
   about what it should do on a machine whose memory it has never seen.
2. ~~Whether to keep `test-pdfs/`, or generate them~~ — **both**, which is the
   only answer that works. `tools/make-corpus.mjs` regenerates all 28 fixtures
   byte-for-byte and exits non-zero if any byte moved, so the repository is not
   the source of truth and drift is still a build failure. Generating without
   committing would have meant a corpus that cannot be reviewed; committing
   without a generator would have meant one that cannot be rebuilt.

**Still open:**

3. Whether to extend the CSP to the other Õigusmasin pages. Not this project's
   to decide — it needs `_headers` on the host, and the only supported host is
   the one that does not offer it. Carried forward with the finding attached:
   Codeberg Pages honours a `_headers` allowlist, GitHub Pages does not.
4. Whether a second format should be announced in the sidebar, or left to be
   discovered through the file picker. Now a real question rather than a
   hypothetical — JPEG is implemented — and the answer stays deferred until the
   decision can be made against a live page rather than a plan.
5. Whether per-value copy buttons stay (§6). **Kept**, as the default said, and
   they are in the shipped page.

---

## 13. Definition of done

- A visitor on the live site can select a PDF and see every layer in §5.
- No network request occurs during analysis, asserted automatically by
  `tools/privacy-tests.mjs` for every registered format — which iterates the
  registry, so a format added later is covered the day it lands.
- No CSP violation appears in the console during a normal run.
- Every string on the page comes from the §6.1 glossary.
- Every identifier, class, id and comment is English (requirement 12), checked by
  the static test rather than by reading.
- **No export, download or share path exists in the code**, and the static check
  in phase 11 fails the build if one is added.
- `npm run verify` and `npm run smoke` pass. `verify` now also includes
  `npm run corpus` (regenerate and compare) and `npm run extensible` (§13's last
  item, executed rather than asserted).
- Every verification step in §9 is recorded, not just performed.
- The README states the privacy promise, how it is kept, and the limits in §7.
- **Extensibility, proven rather than asserted:** a stub analyser registered in
  `formats/registry.js`, with no other edit anywhere, is detected and its nodes
  appear under their own tab. **`tools/extensibility-proof.mjs` performs this
  check** — it follows README.md's own "Adding a format" section verbatim, asserts
  that only the three files the README names changed, drives a real browser
  through detection and rendering, confirms the new tab exists with a proper
  Estonian name, confirms the privacy test covers the new format without being
  edited, and then removes everything it added. It is run by `npm run verify` and
  by CI. Writing it found a real defect: tabs were built by filtering the static
  `GROUPS` constant, so a group invented by a new analyser was silently dropped —
  the format was detected, the badge was right, and its data was nowhere on the
  page. The plan said that case was handled; it was not. If adding that stub
  requires touching §5 or §6, the
  architecture is not finished and the work is not done.