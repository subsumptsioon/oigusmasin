// ── formats/pdf/streams.js ────────────────────────────────────────────────────
// Cross-reference streams and object streams: the two forms PDF 1.5 introduced,
// and the reason a modern Word or LibreOffice file is invisible to a parser that
// only reads classic tables.
//
// Both are ordinary stream objects carrying the same information the classic
// table holds in twenty bytes a line, and both are usually FlateDecode'd. So the
// structure here is: read the dictionary, decode the bytes with filters.js, then
// read a binary table out of them.
//
// **Cross-reference streams** (§7.5.8.2) store the table as fixed-width records
// whose column widths `/W` declares. A width of 0 for the *type* column is legal
// and means every entry in that subsection has the same type — a real
// optimisation that a parser reading the type unconditionally gets wrong.
//
// **Object streams** (§7.5.7) pack whole objects into one stream, so `/N` objects
// share a single offset and each is preceded by a pair of numbers: its position
// relative to `/First` and its own object number. Those two headers make the
// payload a self-describing index, which is why an object stream is worth
// decoding even when only one object in it is wanted.
// ─────────────────────────────────────────────────────────────────────────────

import { get, parseAt, parseDictAt } from "./lexer.js";
import { decodeStream } from "./filters.js";

/** §7.5.8.2 type field values. Type 0 is "free" and its offset field holds the
 *  *next* free object, not a byte offset — the same inversion the classic table
 *  has, and the same reason it must not be read as a position. */
const TYPE_FREE = 0;
const TYPE_UNCOMPRESSED = 1;
const TYPE_COMPRESSED = 2;

/**
 * Read a cross-reference stream.
 *
 * @param {Uint8Array} fileBytes
 * @param {number} offset  byte offset of the `N G obj` header
 * @param {{limits?: object, clock?: object}} opts
 * @returns {Promise<object|null>} an entry map plus the trailer dictionary
 */
export async function readXrefStream(fileBytes, offset, opts = {}) {
  const source = opts.source ?? latin1Of(fileBytes);
  const notes = opts.notes ?? [];
  const limits = opts.limits;

  const header = source.slice(offset, offset + 64).match(/^\s*(\d+)\s+(\d+)\s+obj/);
  if (!header) {
    notes.push({ code: "xref-stream-unreadable", messageEt: `Asukohal ${offset} ei loe ristviidevoogu.` });
    return null;
  }

  let parsed;
  try {
    parsed = parseDictAt(source, offset + header[0].length, limits, opts.clock);
  } catch (err) {
    notes.push({
      code: "xref-stream-dict",
      messageEt: `Ristviidevoogu sõnastikku ei saanud lugeda: ${err?.message ?? "teadmata viga"}`,
    });
    return null;
  }
  const dict = parsed.dict;
  if (!dict) {
    notes.push({ code: "xref-stream-dict", messageEt: "Ristviidevoogul pole loetavat sõnastikku." });
    return null;
  }

  const streamInfo = dict.stream;
  if (!streamInfo) {
    notes.push({ code: "xref-stream-empty", messageEt: "Ristviidevoogul pole voogu." });
    return null;
  }

  const filters = namesOf(get(dict, "Filter"));
  const parms = parmsOf(get(dict, "DecodeParms"));
  const decoded = await decodeStream(fileBytes.subarray(streamInfo.start, streamInfo.end), {
    filters,
    decodeParms: parms,
    limits,
  });

  if (!decoded.ok) {
    notes.push({
      code: "xref-stream-filter",
      messageEt: `Ristviidevoogu voogu ei saanud lahti pakkida: ${decoded.reason}`,
    });
    return null;
  }

  /* `/W` is three integers. A missing or short one means the file cannot be read
     by anyone, and guessing widths would produce a table of plausible garbage —
     so this refuses rather than assumes. */
  const w = intsOf(get(dict, "W"));
  if (!w || w.length < 3) {
    notes.push({ code: "xref-stream-now", messageEt: "Ristviidevoogul puudub loetav /W." });
    return null;
  }
  const width = w.map((n) => Math.max(0, Math.trunc(n)));
  const entryWidth = width.reduce((a, b) => a + b, 0);
  if (entryWidth <= 0) {
    notes.push({ code: "xref-stream-zero-width", messageEt: "Ristviidevoogu kirje on nulli lai." });
    return null;
  }

  /* `/Size` is the highest object number plus one; `/Index` says which runs of
     object numbers the stream actually describes, as pairs. Absent /Index means
     one run covering 0 to Size-1.

     `/Size` is a *scalar*, not an array — reading it with the array helper made
     it null, and a null /Size silently produced zero ranges and therefore a
     cross-reference table with no entries in it and no error anywhere. A parser
     that reports an empty table for a file full of objects is worse than one
     that reports a malformed one. */
  const size = intOf(get(dict, "Size"));
  const indexRaw = get(dict, "Index");
  let ranges;
  if (indexRaw && indexRaw.type === "array" && indexRaw.items.length >= 2) {
    ranges = [];
    for (let i = 0; i + 1 < indexRaw.items.length; i += 2) {
      const a = indexRaw.items[i];
      const b = indexRaw.items[i + 1];
      if (a?.type === "number" && b?.type === "number") ranges.push([a.value, b.value]);
    }
  } else {
    ranges = size === null ? [] : [[0, Math.max(0, size)]];
  }

  const data = decoded.bytes;
  const entries = new Map();
  const subsections = [];
  let inUse = 0;
  let free = 0;
  let defaultType = null;

  let at = 0;
  for (const [start, count] of ranges) {
    subsections.push({ start, count });
    for (let i = 0; i < count; i++) {
      if (at + entryWidth > data.length) break;

      /* Width 0 means "absent", and for the type column that means the same type
         as the previous entry — per §7.5.8.2. A parser that reads a missing type
         as 0 turns a run of in-use objects into a run of free ones, and the file
         then looks like it has no objects at all. */
      let type = defaultType;
      let fieldAt = at;
      let typeWidth = width[0];
      if (typeWidth === 0) {
        type = defaultType ?? TYPE_UNCOMPRESSED;
      } else {
        const read = readBigEndian(data, fieldAt, typeWidth);
        fieldAt += typeWidth;
        /* An unknown type value means the stream is not what it claims; treating
           it as free would erase the object silently. */
        type = read;
        defaultType = read;
      }
      if (type !== TYPE_FREE) defaultType = type;

      const offsetField = readBigEndian(data, fieldAt, width[1]);
      fieldAt += width[1];
      const genField = width[2] > 0 ? readBigEndian(data, fieldAt, width[2]) : 0;

      const num = start + i;
      if (!entries.has(num)) {
        const entry = {
          free: type === TYPE_FREE,
          type,
          /* For type 2 the offset field is the containing object stream's number
             and the generation field is the object's index within it. */
          offset: type === TYPE_COMPRESSED ? null : offsetField,
          gen: genField,
          compressedIn: type === TYPE_COMPRESSED ? offsetField : null,
          indexIn: type === TYPE_COMPRESSED ? genField : null,
        };
        entries.set(num, entry);
        if (entry.free) free++;
        else inUse++;
      }
      at += entryWidth;
    }
  }

  return {
    kind: "stream",
    entries,
    inUse,
    free,
    subsections,
    declaredSize: size,
    trailer: dict,
    prev: intOf(get(dict, "Prev")),
    xrefStm: get(dict, "XRefStm"),
    hasEncrypt: get(dict, "Encrypt") !== null,
    encrypt: get(dict, "Encrypt"),
    root: get(dict, "Root"),
    info: get(dict, "Info"),
    id: get(dict, "ID"),
    appliedFilters: decoded.applied,
    decodedBytes: data.length,
  };
}

/**
 * Read the objects packed inside an object stream.
 *
 * @param {Uint8Array} fileBytes
 * @param {number} offset      byte offset of the object stream's `N G obj`
 * @param {{limits?: object, clock?: object, source?: string, notes?: object[]}} opts
 * @returns {Promise<Map<number, {value: object, raw: string, index: number}>|null>}
 *
 * The payload is `First` bytes of `N obj M 001 ...` headers followed by the
 * object bodies. §7.5.7. The headers are what make it an index rather than a
 * blob, and they are the only way to find an object without parsing every one.
 */
export async function readObjectStream(fileBytes, offset, opts = {}) {
  const source = opts.source ?? latin1Of(fileBytes);
  const notes = opts.notes ?? [];
  const limits = opts.limits;

  let parsed;
  try {
    parsed = parseDictAt(source, offset + matchObjectHeader(source, offset), limits, opts.clock);
  } catch (err) {
    notes.push({ code: "objstm", messageEt: `Objektivoogu ei saanud lugeda: ${err?.message ?? "teadmata viga"}` });
    return null;
  }
  const dict = parsed.dict;
  if (!dict?.stream) {
    notes.push({ code: "objstm", messageEt: "Objektivoogul pole loetavat voogu." });
    return null;
  }

  const count = intOf(get(dict, "N"));
  const first = intOf(get(dict, "First"));
  if (count === null || first === null) {
    notes.push({ code: "objstm", messageEt: "Objektivoogul puuduvad /N või /First." });
    return null;
  }

  const decoded = await decodeStream(
    fileBytes.subarray(dict.stream.start, dict.stream.end),
    { filters: namesOf(get(dict, "Filter")), decodeParms: parmsOf(get(dict, "DecodeParms")), limits },
  );
  if (!decoded.ok) {
    notes.push({ code: "objstm-filter", messageEt: `Objektivoogu voogu ei saanud lahti pakkida: ${decoded.reason}` });
    return null;
  }

  const body = decoded.bytes;
  const payload = latin1Of(body);
  const found = new Map();

  /* The header block is `First` bytes of `objnum offset objnum offset …`, and
     the offsets it lists are relative to `First` — not to the stream start. That
     indirection is the whole reason this is easy to get wrong: adding the wrong
     base yields a dictionary that parses as something else entirely. */
  const headerBlock = payload.slice(0, first);
  const pairs = headerBlock.match(/\d+\s+\d+/g) ?? [];
  if (!pairs.length) {
    notes.push({ code: "objstm-header", messageEt: "Objektivoogu päise ei ole loetav." });
    return null;
  }

  const wanted = Math.min(count, pairs.length);
  for (let i = 0; i < wanted; i++) {
    const [numText, offText] = pairs[i].split(/\s+/);
    const num = Number(numText);
    const rel = Number(offText);
    if (!Number.isSafeInteger(num) || !Number.isSafeInteger(rel)) continue;
    const start = first + rel;
    if (start < 0 || start >= payload.length) {
      notes.push({ code: "objstm-offset", messageEt: `Objekti ${num} asukoht ${start} on voogust väljas.` });
      continue;
    }
    try {
      const { value } = parseAt(payload, start, limits, opts.clock);
      if (value.type !== "eof") found.set(num, { value, raw: value.raw ?? "", index: i });
    } catch (err) {
      notes.push({ code: "objstm-parse", messageEt: `Objekti ${num} ei saanud parsida: ${err?.message ?? "teadmata viga"}` });
    }
  }

  return found;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function matchObjectHeader(source, offset) {
  const m = source.slice(offset, offset + 64).match(/^\s*\d+\s+\d+\s+obj/) ?? source.slice(offset, offset + 64).match(/^\s*/);
  return m?.[0].length ?? 0;
}

/** An integer from a PDF value, or null. A `/Size` written as `12.0` is an
 *  integer by §7.3.2; one written as `12.5` is not, and is not rounded. */
function intOf(value) {
  if (!value) return null;
  if (value.type === "number" && Number.isSafeInteger(value.value)) return value.value;
  if (value.type === "number" && Number.isInteger(value.value)) return value.value;
  return null;
}

function intsOf(value) {
  if (!value || value.type !== "array") return null;
  const out = [];
  for (const item of value.items) {
    const n = intOf(item);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

/** `/Filter` may be a name or an array of names. */
export function namesOf(value) {
  if (!value) return [];
  if (value.type === "name") return [value.name];
  if (value.type === "array") return value.items.filter((i) => i.type === "name").map((i) => i.name);
  return [];
}

export function parmsOf(value) {
  if (!value) return null;
  if (value.type === "dict") return [value];
  if (value.type === "array") return value.items;
  return null;
}

/** Big-endian unsigned read of `width` bytes. Widths above 6 are clamped: no
 *  file has a real offset that large, and a huge width from a damaged `/W` would
 *  otherwise produce a number with no meaning. */
function readBigEndian(data, at, width) {
  if (width <= 0) return 0;
  const take = Math.min(width, 6);
  let value = 0;
  for (let i = 0; i < take; i++) {
    value = value * 256 + (data[at + i] ?? 0);
  }
  return value;
}

function latin1Of(bytes) {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return out;
}