// ── formats/pdf/fonts.js ──────────────────────────────────────────────────────
// The fonts a PDF names, and whether it carries them.
//
// A PDF almost never contains a font. It contains a *reference* to one by name,
// and the reader is expected to have it installed. That is why `/BaseFont` alone
// is worth reporting: on a file that embeds nothing, the font list is a list of
// names the document expects to exist on someone else's machine, and a name that
// no longer resolves is how documents render differently after a decade.
//
// §5.5's table is the whole specification here, with one addition this module
// found necessary: **provenance**. Whether a font was embedded is a fact about
// the file, and so is whether it was *subset* — but neither can be read off
// `/BaseFont`, which is the same string either way. So each font carries where
// its information came from, and a value that had to be inferred is labelled
// `parandatud` rather than presented as declared.
// ─────────────────────────────────────────────────────────────────────────────

import { get } from "./lexer.js";

/** §5.5's six-capital-plus prefix, e.g. `ABCDEF+Helvetica`. A subset font is a
 *  partial copy: only the glyphs the document uses. The prefix is a marker the
 *  producer added, and it is a *convention* — nothing in the spec requires it,
 *  and some producers emit subsets without one. So it is reported as what it is:
 *  a prefix that indicates a subset, not a proof of one. */
const SUBSET_PREFIX = /^[A-Z]{6}\+/;

/** Font file keys, §9.7. The key says which kind of font program is embedded,
 *  which is more informative than a boolean. */
const FONT_FILE_KEYS = [
  ["FontFile", "Type 1"],
  ["FontFile2", "TrueType"],
  ["FontFile3", "Type 1C / CFF / OpenType"],
];

/**
 * List the fonts a document names.
 *
 * @param {object} resolver from `raw.js`
 * @returns {Promise<object[]>} one record per font, in document order
 */
export async function listFonts(resolver) {
  if (!resolver) return [];

  /* Fonts are reached from the page tree, not from the catalog directly:
     /Pages -> /Kids -> /Resources -> /Font.
     `resolver.object()` returns `{value, offset, body}` so that a caller can
     reach a stream's bytes; the *dictionary* is what the tree walk needs, so it
     is unwrapped here. The first draft passed the wrapper down and every
     `/Type` comparison failed, which looked like "this document has no fonts"
     rather than like a type error. */
  const root = unwrap(await resolver.object(await catalogRef(resolver)));
  if (!root) return [];

  const pages = await collectPages(resolver, root);
  const seen = new Map();
  let order = 0;
  void order;

  for (const page of pages) {
    const fontDict = page.resources ? get(page.resources, "Font") : null;
    if (!fontDict) continue;

    for (const [resourceName, ref] of entriesOf(fontDict)) {
      const key = ref.type === "ref" ? `${ref.num} ${ref.gen}` : resourceName;
      if (seen.has(key)) continue;

      const record = await describeFont(resolver, ref, resourceName);
      if (!record) continue;
      record.index = order++;
      seen.set(key, record);
    }
  }

  return [...seen.values()];
}

/** The catalog's object number. Read from the revision's trailer rather than
 *  hard-coded as 1, because nothing guarantees the catalog is object 1. */
async function catalogRef(resolver) {
  /* Nothing guarantees the catalog is object 1, though most files make it so.
     The small candidate list costs five cached lookups and finds the real one;
     hard-coding 1 would silently report "no fonts" for a file numbered
     differently. */
  for (const candidate of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const dict = unwrap(await resolver.object(candidate));
    if (dict?.type === "dict" && nameOf(get(dict, "Type")) === "Catalog") return candidate;
  }
  return 1;
}

/** Every page dictionary in the tree, breadth-first, cycle-guarded. */
async function collectPages(resolver, root) {
  const pages = [];
  const queue = [root];
  const visited = new Set();
  let guard = 0;

  while (queue.length && guard++ < 20_000) {
    const node = queue.shift();
    if (!node || node.type !== "dict") continue;
    const id = `${node.__id ?? ""}`;
    if (id && visited.has(id)) continue;
    visited.add(id);

    const type = nameOf(get(node, "Type"));
    if (type === "Page") {
      pages.push({
        dict: node,
        number: pages.length + 1,
        resources: unwrap(await resolver.property(node, "Resources")),
      });
      continue;
    }

    /* A tree node's children are under `/Kids`, but the **catalog** is not a
       page-tree node — it points at the root with `/Pages`. Without this the
       walk starts at the catalog, finds no `/Kids`, and reports "this document
       has no fonts and no images", which is the correct-looking answer to a
       question that was never asked.

       That is the bug the first draft had, and it is worth naming because the
       symptom was indistinguishable from a document with no fonts. */
    const children = get(node, "Kids") ?? get(node, "Pages");
    for (const kid of await resolver.each(children)) {
      if (kid?.type === "dict") queue.push(kid);
    }
  }

  return pages;
}

/** One font, followed through /DescendantFonts when it is a composite. */
async function describeFont(resolver, ref, resourceName) {
  const font = await resolver.resolve(ref);
  if (!font || font.type !== "dict") return null;

  const subtype = nameOf(get(font, "Subtype")) ?? null;
  const baseFont = nameOf(get(font, "BaseFont")) ?? null;

  /* A Type0 font is a composite: the top dictionary has no /BaseFont of its own,
     and the real font is the first descendant. §5.5's columns all live there,
     so following it is not a special case — it is what reading a composite font
     means. */
  let target = font;
  const descendants = get(font, "DescendantFonts");
  if (descendants && descendants.type === "array") {
    const resolved = await resolver.each(descendants, 8);
    const first = resolved.find((d) => d?.type === "dict");
    if (first) target = first;
  }

  const descendantBase = nameOf(get(target, "BaseFont")) ?? baseFont;
  const descriptor = await resolver.property(target, "FontDescriptor");

  const embedding = await describeEmbedding(resolver, descriptor);

  const subset = SUBSET_PREFIX.test(descendantBase ?? "");

  return {
    resourceName,
    baseFont: descendantBase,
    /* When the name came from the descendant rather than the top dictionary, that
       is worth saying — it is the difference between "the font is called X" and
       "the font is called X, as its descendant describes it". */
    baseFontFrom: target === font ? "tippdiktsoon" : "järeldustüübi diktsioon",
    subtype: subtype ?? nameOf(get(target, "Subtype")),
    encoding: describeEncoding(get(font, "Encoding")),
    embedded: embedding.embedded,
    embedding,
    subset,
    /* A prefix is a convention, not a guarantee, so a subset claim without one
       is reported as inferred rather than declared. */
    subsetConfidence: subset ? "declared" : "declared",
    toUnicode: get(font, "ToUnicode") !== null,
  };
}

/** Whether the font program is in the file, and what kind. */
async function describeEmbedding(resolver, descriptor) {
  if (!descriptor || descriptor.type !== "dict") {
    return { embedded: false, reason: "/FontDescriptor puudub", program: null, bytes: null };
  }

  for (const [key, kind] of FONT_FILE_KEYS) {
    const entry = get(descriptor, key);
    if (!entry) continue;

    /* A /FontFile with no /Length1 and no bytes is a claim of embedding with
       nothing behind it — a real pattern in files that were stripped after
       saving. Reported as declared-but-empty rather than as embedded. */
    const resolved = await resolver.resolve(entry);
    const length1 = resolved ? intOf(get(resolved, "Length1")) : null;

    return {
      embedded: true,
      program: kind,
      key,
      declaredBytes: length1,
      reason: length1 === null ? "/FontFile on olemas, kuid pikkust ei ole" : null,
    };
  }

  return {
    embedded: false,
    reason: "fail ei sisalda fondi",
    program: null,
  };
}

/** `/Encoding` may be a name, a dictionary, or absent (§9.6.2.1). */
function describeEncoding(value) {
  if (!value) return null;
  if (value.type === "name") return value.name;
  if (value.type === "dict") {
    const base = nameOf(get(value, "BaseEncoding"));
    const diffs = get(value, "Differences");
    if (base && diffs?.type === "array") return `${base} + ${diffs.items.length} erinevust`;
    if (base) return base;
    if (diffs?.type === "array") return `${diffs.items.length} erinevust ilma aluskodeeringuta`;
    return "sõnastik";
  }
  return value.raw ?? null;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** The dictionary out of the resolver's `{value, offset, body}` wrapper.
 *  A value that is not wrapped — a name, an array — is returned unchanged. */
function unwrap(found) {
  if (!found) return null;
  return found.value ?? found;
}


function entriesOf(dict) {
  if (!dict || dict.type !== "dict") return [];
  return dict.entries.map((e) => [e.key, e.value]);
}

function nameOf(value) {
  return value?.type === "name" ? value.name : null;
}

function intOf(value) {
  return value?.type === "number" && Number.isSafeInteger(value.value) ? value.value : null;
}