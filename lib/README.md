# Vendored libraries

Every library in `lib/` is pinned to an exact version, copied here rather than
loaded from a CDN, and listed below. Nothing in this directory is ours to edit.

## Why vendored at all

Three reasons, in order of weight:

1. **`script-src 'self'` is locked.** A CDN script would need a CSP relaxation,
   and relaxing it would turn the page's privacy guarantee into a suggestion.
2. **The file-stays-local promise.** If the library were fetched from a third
   party on every page load, that request would carry an IP address and a user
   agent to that host. It still would not carry the PDF — but the plan's promise
   in §7 is stated without asterisks, and this is the one place an asterisk would
   have to go.
3. **Reproducibility.** A pinned version in the repository is a version that
   cannot change under us between a release and a bug report.

## Updating a version

Manual and deliberate. Change the version below, re-download, re-run the whole
test suite, and commit the new files in the same commit as the version bump so
the two can never disagree.

## Checksums

SHA-256 of the exact bytes in this directory, so a reader can confirm they have
the files this document describes and not something that has taken their place
since. Recompute with `sha256sum lib/*.mjs` after any deliberate update, and
expect these to change — that is the point.

| File | Size | SHA-256 |
|---|---|---|
| `pdf.min.mjs` | 344 KB | `27fc2a057a00f92a4334ad06e17dbd7259912954e9fb7f76400bcca5fd190a9c` |
| `pdf.worker.min.mjs` | 1.3 MB | `1baa1844c89c80a5b2797c916e75ab29254be46d8e9cb53cb6364d7aad84be36` |
| `exifr.full.esm.mjs` | 74 KB | `71e59a46f2d09263485da3d77cd7d9bf5c6a61f69e5e7e39a22a7b8e9066001c` |

These are recorded here rather than only in the commit history on purpose: the
history says *when* the file changed, this says *what* should be there now, and
the question a checksum answers is asked months later, by someone who has not
read the history.

## pdfjs-dist 4.10.38

| | |
|---|---|
| Package | `pdfjs-dist` |
| Version | `4.10.38` (exact; no range) |
| Source | https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-4.10.38.tgz |
| Licence | Apache-2.0 — full text in `LICENSES/pdfjs-dist-LICENSE` |
| Files | `pdf.min.mjs` (345 KB), `pdf.worker.min.mjs` (1.4 MB) |
| Why 4.10.x | ≥ 4.2.67 fixes CVE-2024-4367, the arbitrary-code-execution flaw in `FontMatrix` handling. 4.10.38 is the last 4.x release. |
| Not vendored | `cmaps/`, `standard_fonts/`, `web/`, `legacy/`, and the source maps (8.9 MB combined) |

**`isEvalSupported: false` is set by our code, not by the library's default.**
CVE-2024-4367 is reachable through the font-initialisation path, and pdf.js
fixes it by refusing to build JavaScript from PDF strings. Turning that off is a
belt to the braces, and it costs nothing on a page that renders nothing.

**The worker is configured with `workerSrc` pointing at the local file.** pdf.js
will otherwise fall back to a fake worker created from a blob URL, which means
building the whole interpreter in memory. The vendored `pdf.worker.min.mjs`
avoids that, and `worker-src 'self' blob:` in the CSP covers both paths.

## exifr 7.1.3

| | |
|---|---|
| Package | `exifr` |
| Version | `7.1.3` (exact; no range) |
| Source | https://registry.npmjs.org/exifr/-/exifr-7.1.3.tgz |
| Licence | MIT — full text in `LICENSES/exifr-LICENSE` |
| File | `exifr.full.esm.mjs` (76 KB) |
| Why | §5.5: a JPEG found inside a PDF is handed out through the `blobs` channel and read by `formats/images/jpeg.js`. Nothing in this project parses EXIF |

**The `full` build, not `lite`.** The three builds differ in what they parse:
`mini` is EXIF only, `lite` drops XMP, `full` covers EXIF, IPTC, XMP, JFIF and
PNG chunks. This page exists to show what a file carries, and §5.4's argument
about namespaces applies here too — a narrower build would report fewer fields
for reasons that have nothing to do with the file.

**Loaded lazily, from a `globalThis` cache.** A visitor who selects no JPEG
downloads nothing; a visitor who selects a JPEG pays once. The cache is on
`globalThis` rather than module scope because the registry re-imports analysers
per file, so a module-level cache would be discarded on every selection.

## A note on the two pdf.js files

**`cmaps/` and `standard_fonts/` are deliberately absent.** This page does not
render, so no glyph is ever mapped and no font is ever embedded — a
"no cMaps needed" claim that is testable by the absence of those requests. Phase
7 verifies it: analysing a CJK PDF must produce zero network requests. If a
future phase adds previews, that claim lapses and both directories come back.