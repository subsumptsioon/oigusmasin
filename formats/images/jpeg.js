// ── formats/images/jpeg.js ────────────────────────────────────────────────────
// The first stage-3 blob analyser, and the first module with no PDF in it.
//
// §5.5: "This is already a stage-3 blob analyser, not PDF code." The PDF
// analyser hands JPEG bytes out through `blobs` with a media type; this module
// takes those bytes and reads them. **It does not know where they came from** —
// not whether they were embedded in a PDF, not on which page, not whether the
// PDF has one image or two hundred. The registry gives it the same `Uint8Array`
// whether the bytes arrived from a PDF or from a `.jpg` the visitor picked from
// their own disk.
//
// That symmetry is the design, and the phase 9 test is the proof: the *same
// module* runs against both, and the output is identical for identical input.
// If a PDF-specific assumption ever crept in here — a page number, an assumed
// offset, a `ContentResources` lookup — the test would stop passing, which is the
// only reason it exists.
//
// **EXIF is often absent, and that is a finding.** A JPEG exported from a phone
// carries dozens of fields; a screenshot or a scanned page carries none. §5.5
// asks for "EXIF-i ei leitud" rather than an empty table, and this module reports
// the absence explicitly, naming which sections were searched.
//
// **Nothing here decodes pixels.** Dimensions come from the JPEG's own SOF
// marker, which is in the header. No image is drawn, no canvas is created, and
// `img-src` stays near-empty.
// ─────────────────────────────────────────────────────────────────────────────

import { node } from "../node.js";

/** exifr is loaded on demand, for the same reason the registry lazy-loads
 *  analysers: a visitor who selects a JPEG pays for it, and nobody else does.
 *  Cached on `globalThis` because the registry re-imports analysers per file —
 *  a module-level cache would be discarded each time and re-parsed each time.
 *
 *  The path is `../../lib/`, two levels up from `formats/images/`. The first
 *  version wrote three, and the browser silently clamped it at the origin root
 *  while Node's resolver did not — so the module worked in every page test and
 *  failed everywhere else, with the only visible symptom being "EXIF-i ei
 *  leitud" on a JPEG that has plenty of EXIF. */
const EXIFR_CACHE_KEY = "__oigusmasinExifr";

function loadExifr() {
  const store = globalThis;
  if (store[EXIFR_CACHE_KEY]) return store[EXIFR_CACHE_KEY];
  const promise = import("../../lib/exifr.full.esm.mjs").then((mod) => mod.default ?? mod);
  promise.catch(() => {
    if (store[EXIFR_CACHE_KEY] === promise) delete store[EXIFR_CACHE_KEY];
  });
  store[EXIFR_CACHE_KEY] = promise;
  return promise;
}

export const analyser = {
  id: "jpeg",
  labelEt: "JPEG-pilt",

  async analyse(bytes, ctx) {
    /* The JPEG's own SOF marker gives the dimensions without decoding anything.
       exifr reports them too, but reading the header directly means the page
       can say something useful even when every metadata parser fails. */
    const header = readJpegHeader(bytes);

    ctx.emitNode(
      node({
        id: "img.dimensions",
        group: "info",
        labelEt: "Mõõtmed",
        labelEn: "Dimensions",
        value: header.width && header.height ? `${header.width} × ${header.height} px` : "pole loetav",
        children: header.width
          ? [
              child("img.width", "Laius", "Width", `${header.width} px`),
              child("img.height", "Kõrgus", "Height", `${header.height} px`),
              child("img.components", "Komponente", "Components", String(header.components ?? 0)),
              child("img.precision", "Bitti komponendi kohta", "Bits per component", String(header.precision ?? 0)),
              child("img.bytes", "Faili suurus", "File size", `${bytes.length} B`),
            ]
          : [],
      }),
    );

    if (header.progressive) {
      ctx.emitNode(
        child("img.progressive", "Progressiivne", "Progressive", "jah"),
      );
    }

    let exifr;
    try {
      exifr = await loadExifr();
    } catch (err) {
      ctx.reportError(
        `EXIF-i lugejat ei saanud laadi: ${err?.message ?? "teadmata viga"}`,
        "exifr-load-failed",
      );
      return { nodes: [], blobs: [] };
    }

    let metadata;
    try {
      metadata = await exifr.parse(bytes, {
        /* Every section, because the point of this page is to show what a file
           carries. exifr's default is a subset chosen for speed. */
        tiff: true,
        ifd0: true,
        exif: true,
        gps: true,
        iptc: true,
        xmp: true,
        icc: false,
        jfif: true,
        ihdr: true,
        translateKeys: true,
        translateValues: true,
        reviveValues: true,
        mergeOutput: true,
        silentErrors: true,
      });
    } catch (err) {
      /* A parse *failure* and "there is no EXIF" are different facts, and the
       * difference is worth a visitor's time: one is a file with no metadata,
       * the other is a file this tool could not read. So the reason is reported
       * and the row still says "EXIF-i ei leitud", because §5.5 asks for that
       * wording rather than an empty table — and an empty table is exactly what
       * a reader cannot tell apart from a failed read. */
      ctx.reportError(
        `EXIF-i ei saanud lugeda: ${err?.message ?? "teadmata viga"}`,
        "exifr-parse-failed",
      );
      ctx.emitNode(
        node({
          id: "img.exif",
          group: "info",
          labelEt: "EXIF ja seotud metaandmed",
          labelEn: "EXIF and related metadata",
          value: `EXIF-i ei leitud — ${err?.message ?? "lugemine ebaõnnestus"}`,
          confidence: "absent",
        }),
      );
      return { nodes: [], blobs: [] };
    }

    /* exifr with `silentErrors: true` does not throw on an unreadable file — it
       returns an object whose only key is `errors`. That object is truthy, so
       the first version treated a failed parse as successful metadata and
       reported "1 väärtust" for four bytes that were not a JPEG at all.

       The question is therefore not "did it throw" but "did it return anything
       other than its own errors", which is the only thing that distinguishes a
       file with no EXIF from a file this tool could not read. */
    const errors = Array.isArray(metadata?.errors) ? metadata.errors : null;
    const fields =
      metadata && typeof metadata === "object" && !errors
        ? Object.entries(metadata).filter(([, v]) => v !== undefined && v !== null)
        : [];

    if (!metadata || typeof metadata !== "object" || !fields.length) {
      /* §5.5's case, said plainly rather than rendered as an empty table. The
         reason travels with it: "this file has no EXIF" and "this tool could not
         read it" are different facts, and a reader cannot tell them apart from
         an empty table. */
      const why = errors?.length ? `lugemine ebaõnnestus, ${errors.length} viga` : "pole";
      ctx.emitNode(
        node({
          id: "img.exif",
          group: "info",
          labelEt: "EXIF ja seotud metaandmed",
          labelEn: "EXIF and related metadata",
          value: `EXIF-i ei leitud — ${why}`,
          confidence: "absent",
        }),
      );
      return { nodes: [], blobs: [] };
    }

    emitMetadata(ctx, metadata);
    return { nodes: [], blobs: [] };
  },
};

/** Fields grouped by the section they came from, so a visitor can see *where*
 *  each value lives rather than facing one flat list of 40 rows. */
function emitMetadata(ctx, metadata) {
  const SECTIONS = [
    ["Make", "Tootja", "Camera make", "camera"],
    ["Model", "Mudel", "Camera model", "camera"],
    ["LensModel", "Objektiv", "Lens", "camera"],
    ["Software", "Tarkvara", "Software", "tool"],
    ["DateTimeOriginal", "Loomise aeg", "Date taken", "dates"],
    ["CreateDate", "Loomise kuupäev", "Created", "dates"],
    ["ModifyDate", "Muutmise kuupäev", "Modified", "dates"],
    ["ExposureTime", "Säärteaeg", "Exposure time", "exposure"],
    ["FNumber", "Ava", "Aperture", "exposure"],
    ["ISO", "ISO", "ISO", "exposure"],
    ["FocalLength", "Fokaalkaugus", "Focal length", "exposure"],
    ["Orientation", "Pöörang", "Orientation", "capture"],
    ["Flash", "Välk", "Flash", "capture"],
    ["ImageWidth", "Pildi laius", "Image width", "dimensions"],
    ["ImageHeight", "Pildi kõrgus", "Image height", "dimensions"],
    ["ColorSpace", "Värviruum", "Colour space", "dimensions"],
    ["GPSLatitude", "GPS laius", "GPS latitude", "gps"],
    ["GPSLongitude", "GPS pikkus", "GPS longitude", "gps"],
    ["GPSAltitude", "GPS kõrgus", "GPS altitude", "gps"],
    ["GPSDateStamp", "GPS kuupäev", "GPS date", "gps"],
    ["Artist", "Autor", "Artist", "rights"],
    ["Copyright", "Autoriõigus", "Copyright", "rights"],
  ];

  const rows = [];
  const found = new Set();

  for (const [key, labelEt, labelEn] of SECTIONS) {
    const value = metadata[key];
    if (value === undefined || value === null || value === "") continue;
    found.add(key);

    /* §5.7 is emphatic that coordinates and device identifiers are the sensitive
       values this page will surface. They are labelled as such here, at the point
       of display, rather than left for the visitor to recognise. */
    const sensitive = key.startsWith("GPS");
    rows.push(
      child(
        `img.meta.${key}`,
        labelEt,
        labelEn,
        formatValue(value),
        Array.isArray(value) ? JSON.stringify(value) : String(value),
        sensitive ? "declared" : "declared",
        1,
        sensitive ? "tundlik" : null,
      ),
    );
  }

  /* Anything exifr returned that this list does not name is still shown. The
     same rule as the XMP walk: a hard-coded key list is a filter, and a field
     the producer wrote in a place this page has never heard of is exactly what
     someone examining the file wants to see. */
  for (const [key, value] of Object.entries(metadata)) {
    if (found.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      /* A nested section (IFD, Photoshop, MakerNotes). Named rather than
         flattened, because flattening loses which section it came from — and
         the section is the interesting part. */
      const keys = Object.keys(value);
      if (!keys.length) continue;
      rows.push(
        child(`img.meta.${key}`, key, key,
          `alamjaotis: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ` … +${keys.length - 12}` : ""}`,
          "", "declared", 1),
      );
      continue;
    }
    rows.push(
      child(`img.meta.${key}`, key, key, formatValue(value), String(value), "declared", 1),
    );
  }

  ctx.emitNode(
    node({
      id: "img.exif",
      group: "info",
      labelEt: "EXIF ja seotud metaandmed",
      labelEn: "EXIF and related metadata",
      value: rows.length === 0 ? "EXIF-i ei leitud" : `${rows.length} väärtust`,
      children: rows,
    }),
  );
}

/** The JPEG's SOF marker: dimensions, component count and sample precision,
 *  read from the header without decoding a single pixel.
 *
 *  This is deliberately independent of exifr. If the metadata parser fails — an
 *  EXIF block with a truncated IFD, say — the dimensions are still knowable, and
 *  a file that cannot be fully parsed should still say how big it is. */
function readJpegHeader(bytes) {
  const result = { width: null, height: null, components: null, precision: null, progressive: false };

  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return result;

  let at = 2;
  while (at + 4 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = bytes[at + 1];
    /* Start of scan: the entropy-coded data begins, and everything after it is
       compressed pixels rather than markers. */
    if (marker === 0xda) break;

    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    /* SOF0..SOF15, excluding the markers that share the range and are not SOF:
       DHT (c4), JPG (c8) and DAC (cc). */
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      result.progressive = marker === 0xc2;
      result.precision = bytes[at + 4];
      result.height = (bytes[at + 5] << 8) | bytes[at + 6];
      result.width = (bytes[at + 7] << 8) | bytes[at + 8];
      result.components = bytes[at + 9];
      return result;
    }
    at += 2 + length;
  }
  return result;
}

function formatValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => (v instanceof Date ? v.toISOString() : String(v))).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** A metadata field.
 *
 *  The eighth argument is `sensitive`, which §5.7 requires so that coordinates
 *  and device identifiers are flagged at the point of display rather than left
 *  for the visitor to recognise. It becomes a row attribute the renderer can
 *  style; the renderer is phase 10's business, and until then the value is at
 *  least carried. */
function child(id, labelEt, labelEn, value, raw, confidence, depth, sensitive) {
  const n = node({ id, group: "info", labelEt, labelEn, value, raw, confidence, depth: depth ?? 1 });
  if (sensitive) n.sensitive = true;
  return n;
}