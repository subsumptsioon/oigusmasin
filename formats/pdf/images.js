// ── formats/pdf/images.js ─────────────────────────────────────────────────────
// Images a PDF carries, and the bytes of the ones worth carrying out.
//
// §5.5 is specific about the split, and it is the important architectural
// decision in this file:
//
//   **This module does not parse JPEG.** It finds the image, reads the
//   dictionary the PDF already wrote about it — dimensions, colour space, bits
//   per component, filter, stored size — and hands the *bytes* out through the
//   `blobs` channel (§4.2) with a declared media type. `formats/images/jpeg.js`
//   picks them up, and the same module then serves a JPEG the visitor selected
//   directly, with no PDF-specific branch anywhere in it.
//
//   That is why this file never imports exifr. If it did, the JPEG knowledge
//   would live inside the PDF code and the module could not be reused; instead
//   the blob crosses a boundary and the knowledge sits on the far side.
//
// **Images are not displayed.** §5.5 says so, and it keeps them out of the DOM
// and keeps `img-src` near-empty. Nothing here produces a URL, a data: URI or a
// blob: object URL — the plan has no exit path from this page, and an image the
// visitor can save is that exit by another name.
//
// **Storing the bytes is bounded.** A 200-page scanned document holds hundreds
// of megabytes of image data. Copying every one into a blob list would cost more
// memory than the analysis is worth, so only images whose *filter says they are
// worth handing on* are emitted: `DCTDecode` streams are JPEG, which is the one
// format a stage-3 analyser can actually read. Everything else is described from
// its dictionary, and the size of what was skipped is reported.
// ─────────────────────────────────────────────────────────────────────────────

import { get } from "./lexer.js";
import { decodeStream } from "./filters.js";

/** How many image bytes to hold in total. A blob list is a promise to keep
 *  them alive for as long as the analysis lasts, so this is a real allocation.
 *  Exceeding it is reported, never silent. */
const MAX_TOTAL_BLOB_BYTES = 32 * 1024 * 1024;

/** How many images to hand out, whatever their size. */
const MAX_BLOBS = 64;

/**
 * Find the images.
 *
 * @param {object} resolver from `raw.js`
 * @param {Uint8Array} bytes  the whole file, needed to slice stream payloads
 * @param {{limits?: object, clock?: object}} opts
 * @returns {Promise<{images: object[], blobs: object[], skipped: object[]}>}
 */
export async function listImages(resolver, bytes, opts = {}) {
  const limits = opts.limits;
  const clock = opts.clock ?? { expired: () => false };
  if (!resolver) return { images: [], blobs: [], skipped: [] };

  const root = unwrap(await resolver.object(await catalogNumber(resolver)));
  if (!root) return { images: [], blobs: [], skipped: [] };

  const pages = await collectPages(resolver, root);
  const images = [];
  const blobs = [];
  const skipped = [];
  const seen = new Set();

  let totalBlobBytes = 0;

  for (const page of pages) {
    if (clock.expired()) break;
    if (!page.resources) continue;

    const xobjects = get(page.resources, "XObject");
    if (!xobjects || xobjects.type !== "dict") continue;

    for (const [name, ref] of xobjects.entries.map((e) => [e.key, e.value])) {
      if (clock.expired()) break;
      const key = ref?.type === "ref" ? `${ref.num} ${ref.gen}` : name;
      if (seen.has(key)) continue;
      seen.add(key);

      const entry = await resolver.resolveObject(ref);
      const dict = entry?.value ?? entry;
      if (!dict || dict.type !== "dict") continue;
      if (nameOf(get(dict, "Subtype")) !== "Image") continue;

      const record = await describeImage(resolver, dict, entry, bytes, limits);
      record.resourceName = name;
      record.page = page.number;
      images.push(record);

      /* Only a JPEG is worth carrying out. Everything else stays described. */
      if (!record.isJpeg) {
        skipped.push({
          name,
          page: page.number,
          storedBytes: record.storedBytes,
          reason: record.filters?.[0] ?? "filtreita",
        });
        continue;
      }

      if (record.imageBytes == null) continue;
      if (blobs.length >= MAX_BLOBS || totalBlobBytes + record.imageBytes.length > MAX_TOTAL_BLOB_BYTES) {
        skipped.push({
          name,
          page: page.number,
          storedBytes: record.storedBytes,
          reason: "piir: kasutatav pilte või baitide koguruuma on ületatud",
        });
        continue;
      }

      totalBlobBytes += record.imageBytes.length;
      blobs.push({
        /* The container's own claim about its content. §4.2's `mediaType`, and
           the only thing the stage-3 analyser is told about where these bytes
           came from. */
        mediaType: "image/jpeg",
        bytes: record.imageBytes,
        origin: {
          format: "pdf",
          objectName: name,
          page: page.number,
          storedBytes: record.storedBytes,
        },
      });
    }
  }

  return { images, blobs, skipped };
}

/** Read what the PDF's own dictionary says about an image. */
async function describeImage(resolver, dict, entry, bytes, limits) {
  const filters = namesOf(get(dict, "Filter"));
  const width = intOf(get(dict, "Width"));
  const height = intOf(get(dict, "Height"));
  const bpc = intOf(get(dict, "BitsPerComponent"));
  const colourSpace = describeColourSpace(await resolver.resolve(get(dict, "ColorSpace")));
  const isJpeg = filters.includes("DCTDecode") || filters.includes("DCT");

  const storedBytes = dict.stream ? dict.stream.end - dict.stream.start : null;

  /* The DCTDecode bytes are the stream verbatim — a JPEG decoder wants the
     whole file, markers and all, so nothing is decoded and nothing is trimmed.
     For every other filter the data would have to be reconstructed first, and
     that is not worth it for a byte count the dictionary already gives. */
  let imageBytes = null;
  if (isJpeg && dict.stream && bytes) {
    imageBytes = bytes.subarray(dict.stream.start, dict.stream.end);
  } else if (dict.stream && bytes && filters.length === 0) {
    /* No filter at all means the data *is* the image, which for an
       /Image XObject with no /Filter and no /DecodeParms means raw samples —
       not a viewable format. Not exported; only its size is reported. */
    void limits;
  }

  void entry;
  void resolver;

  return {
    name: null,
    width,
    height,
    bitsPerComponent: bpc,
    colourSpace,
    filters,
    isJpeg,
    storedBytes,
    imageBytes,
    pixelBytes: width && height && bpc ? Math.round((width * height * bpc * colourComponents(colourSpace)) / 8) : null,
  };
}

/** §8.7.1 device colour spaces, and the indirect forms a name can take. */
function describeColourSpace(value) {
  if (!value) return null;
  if (value.type === "name") return value.name;
  if (value.type === "array") {
    const family = nameOf(value.items?.[0]);
    if (family === "ICCBased") {
      const n = intOf(value.items?.[1]);
      return `ICCBased${n ? ` (${n} kanalit)` : ""}`;
    }
    if (family === "Indexed") {
      return `Indexed / ${nameOf(value.items?.[1]) ?? "pole"}`;
    }
    if (family === "CalRGB" || family === "CalGray" || family === "Lab") return family;
    return "muu massiiv";
  }
  return value.raw ?? null;
}

/** Components per pixel, for the approximate decoded size. */
function colourComponents(space) {
  if (!space) return 1;
  if (/^ICCBased/.test(space)) {
    const m = /\((\d+)/.exec(space);
    return m ? Number(m[1]) : 3;
  }
  if (/^(DeviceRGB|CalRGB|Lab)/.test(space)) return 3;
  if (/^DeviceCMYK$/.test(space)) return 4;
  if (/^DeviceGray$|^CalGray$|Gray$/.test(space)) return 1;
  return 1;
}

/* ── Page walk ────────────────────────────────────────────────────────────── */

async function catalogNumber(resolver) {
  /* Nothing guarantees the catalog is object 1. The candidate list is cheap —
     the resolver caches by object number — and hard-coding 1 reports "no images"
     for a document numbered differently. */
  for (const candidate of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const found = await resolver.object(candidate);
    const dict = found?.value ?? found;
    if (dict?.type === "dict" && nameOf(get(dict, "Type")) === "Catalog") return candidate;
  }
  return 1;
}

async function collectPages(resolver, root) {
  const pages = [];
  const queue = [root];
  let guard = 0;

  while (queue.length && guard++ < 20_000) {
    const node = queue.shift();
    if (!node || node.type !== "dict") continue;

    if (nameOf(get(node, "Type")) === "Page") {
      pages.push({
        dict: node,
        number: pages.length + 1,
        resources: unwrap(await resolver.property(node, "Resources")),
      });
      continue;
    }
    /* The catalog reaches the page tree through /Pages, not /Kids — same
       omission as in fonts.js, and the same misleading symptom. */
    const children = get(node, "Kids") ?? get(node, "Pages");
    for (const kid of await resolver.each(children)) {
      if (kid?.type === "dict") queue.push(kid);
    }
  }

  return pages;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** The dictionary out of the resolver's `{value, offset, body}` wrapper. */
function unwrap(found) {
  if (!found) return null;
  return found.value ?? found;
}


function namesOf(value) {
  if (!value) return [];
  if (value.type === "name") return [value.name];
  if (value.type === "array") return value.items.filter((i) => i.type === "name").map((i) => i.name);
  return [];
}

function nameOf(value) {
  return value?.type === "name" ? value.name : null;
}

function intOf(value) {
  return value?.type === "number" && Number.isSafeInteger(value.value) ? value.value : null;
}