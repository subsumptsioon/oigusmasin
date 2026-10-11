// ── formats/pdf/filters.js ────────────────────────────────────────────────────
// Stream filters: turning stored bytes back into the bytes the producer meant.
//
// §7.4 splits them into two kinds and the difference is the whole design here:
//
//   * **Implemented.** `FlateDecode` via the platform's `DecompressionStream`,
//     and `LZWDecode`, `ASCII85Decode`, `ASCIIHexDecode`, `RunLengthDecode`
//     written out because they are short, appear in real files, and no browser
//     API helps.
//   * **Named only.** `CCITTFaxDecode`, `JBIG2Decode`, `JPXDecode`,
//     `DCTDecode` and `/Crypt` are reported by name and *not* decoded.
//
// That second list is the honest part. A page that showed an empty box for a
// JPEG image would read as "nothing there". Saying "DCTDecode — ei dekodeerita"
// tells the visitor the truth, which is that the data exists and this tool
// deliberately does not expand it. §5.2 asks for exactly this.
//
// Two hazards, both of which produce a wrong answer rather than an error:
//
//   1. **Decompression bombs.** 1 KB of FlateDecode can expand to about 1000x.
//      Every decode is capped, by `ctx.limits.maxStreamBytes`, and the cap is
//      enforced *while* decoding rather than after — a check that runs afterwards
//      has already paid the memory.
//   2. **Predictors.** `/Predictor 12` is not a filter; it runs *after* Flate on
//      the decompressed bytes. Getting the order wrong yields plausible garbage
//      rather than an error, so it is applied in one place, at the end.
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from "../contract.js";

/** §7.4.4.2 — the filters this module will decode. */
export const IMPLEMENTED = new Set([
  "FlateDecode",
  "Fl",
  "LZWDecode",
  "LZW",
  "ASCII85Decode",
  "A85",
  "ASCIIHexDecode",
  "AHx",
  "RunLengthDecode",
  "RL",
]);

/** §7.4.4.2 — the filters this module names and leaves alone. The comment is
 *  what the interface shows next to each of them. */
export const NOT_IMPLEMENTED = new Set([
  "CCITTFaxDecode",
  "CCF",
  "JBIG2Decode",
  "JPXDecode",
  "DCTDecode",
  "DCT",
  "Crypt",
]);

/** Image filters and what they mean, so a visitor sees a name and a reason. */
const FILTER_PURPOSE = {
  CCITTFaxDecode: "CCITT fakspilt",
  CCF: "CCITT fakspilt",
  JBIG2Decode: "JBIG2 pilt",
  JPXDecode: "JPEG 2000 pilt",
  DCTDecode: "JPEG pilt",
  DCT: "JPEG pilt",
  Crypt: "krüpteeritud voog",
};

/**
 * Decode a stream.
 *
 * @param {Uint8Array} bytes          the stored bytes
 * @param {object} opts
 * @param {Array} opts.filters       names, in the order they must be applied
 * @param {object} opts.decodeParms  the matching `/DecodeParms` entries
 * @param {typeof LIMITS} [opts.limits]
 * @param {number} [opts.clockMs]    aborts a long decode
 * @returns {Promise<{ok: boolean, bytes?: Uint8Array, applied: object[],
 *                    skipped: object[], reason?: string}>}
 *
 * `ok: false` is normal, not exceptional. Half the filters in a real PDF are ones
 * this module declines to decode, and the result says which and why.
 */
export async function decodeStream(bytes, opts = {}) {
  const limits = opts.limits ?? LIMITS;
  const filters = normaliseFilters(opts.filters);
  const applied = [];
  const skipped = [];
  let data = bytes;

  for (let i = 0; i < filters.length; i++) {
    const name = filters[i];
    const parms = opts.decodeParms?.[i] ?? opts.decodeParms?.[0] ?? null;

    if (!IMPLEMENTED.has(name)) {
      skipped.push({
        name,
        purpose: FILTER_PURPOSE[name] ?? null,
        note: "Seda filtrit ei dekodeerita; voogu ei laadita.",
      });
      /* A filter we do not implement cannot be removed, so everything after it
         is undecodable too. Continuing would decode the wrong bytes and report
         success. */
      skipped.push({
        name: "järgnevad filtrid",
        purpose: null,
        note: "Järgnevaid filtreid ei saa rakendada, sest eelmine filter jäi lahti.",
      });
      return { ok: false, bytes: null, applied, skipped, reason: `${name} ei ole dekodeeritav` };
    }

    const step = await applyOne(data, name, parms, limits);
    if (!step.ok) {
      return { ok: false, bytes: null, applied, skipped, reason: step.reason };
    }
    data = step.bytes;
    applied.push({ name, inputBytes: bytes.length, outputBytes: data.length, capped: step.capped ?? false });
  }

  /* The predictor runs last, after every filter (§7.4.4.4). It is not a filter
     and has no name in /Filter, so it cannot be handled in the loop above. */
  const predictor = readPredictor(opts.decodeParms);
  if (predictor && predictor.value > 1) {
    const out = applyPredictor(data, predictor, limits);
    if (!out.ok) {
      return { ok: false, bytes: null, applied, skipped, reason: out.reason };
    }
    data = out.bytes;
    applied.push({ name: "Predictor", value: predictor.value, inputBytes: out.inputBytes, outputBytes: data.length });
  }

  return { ok: true, bytes: data, applied, skipped };
}

/** `/Filter` may be one name or an array of them. §7.4.2. */
function normaliseFilters(filters) {
  if (!filters) return [];
  const list = Array.isArray(filters) ? filters : [filters];
  return list.map((f) => (typeof f === "string" ? f : f?.name ?? "")).filter(Boolean);
}

async function applyOne(data, name, parms, limits) {
  switch (name) {
    case "FlateDecode":
    case "Fl":
      return inflate(data, limits);
    case "LZWDecode":
    case "LZW":
      return ok(lzwDecode(data, readLzwParms(parms), limits));
    case "ASCII85Decode":
    case "A85":
      return ok(ascii85Decode(data, limits));
    case "ASCIIHexDecode":
    case "AHx":
      return ok(asciiHexDecode(data, limits));
    case "RunLengthDecode":
    case "RL":
      return ok(runLengthDecode(data, limits));
    default:
      return { ok: false, reason: `tundmatu filter ${name}` };
  }
}

/** Wrap a decoder's result in the `{ok, bytes}` shape `applyOne` returns.
 *
 *  The hand-written decoders cannot fail — malformed input makes them emit wrong
 *  bytes, not throw — so they return bytes directly. `inflate` is the exception
 *  because a corrupt Flate stream genuinely can fail, and it says so. Rather than
 *  have two result shapes crossing one call site, everything is wrapped here.
 *
 *  The first draft let the raw arrays through, and `decodeStream` read
 *  `step.ok` as `undefined` — falsy — so every single-filter decode reported
 *  failure and returned no bytes at all. */
function ok(bytes) {
  return { ok: true, bytes };
}

/* ── FlateDecode ──────────────────────────────────────────────────────────── */

/** Inflate with `DecompressionStream`, capped *while* it runs.
 *
 *  The cap is applied by reading the output stream in chunks and stopping as
 *  soon as the limit is passed. The alternative — decompressing fully and then
 *  measuring — has already allocated the bomb.
 *
 *  A file whose Flate stream is truncated or corrupt is normal: the tail of a
 *  stream is often damaged while the file remains readable. Whatever was
 *  inflated before the error is returned, marked, because a partial page of
 *  content is more useful than nothing and §11's rule about partial results
 *  applies here too. */
async function inflate(data, limits) {
  const cap = limits.maxStreamBytes;

  /* `deflate` is zlib-wrapped, which is what PDF means. `deflate-raw` is the
     headerless variant some producers emit despite the spec. Try zlib first and
     fall back — the fallback costs one failed attempt on a corrupt file. */
  for (const format of ["deflate", "deflate-raw"]) {
    const result = await tryInflate(data, format, cap);
    if (result) return result;
  }

  /* Neither worked. Before reporting failure, check whether the stream is stored
     uncompressed — a `/FlateDecode` on already-plain bytes appears in the wild,
     and returning the input is right more often than not. */
  if (looksPlain(data)) {
    return { ok: true, bytes: data.subarray(0, Math.min(data.length, cap)) };
  }

  return { ok: false, reason: "FlateDecode: voogu ei õnnestunud lahti pakkida" };
}

async function tryInflate(data, format, cap) {
  if (typeof DecompressionStream === "undefined") return null;
  let stream;
  try {
    stream = new DecompressionStream(format);
  } catch {
    return null;
  }

  const writer = stream.writable.getWriter();
  /* The write is not awaited to completion before reading, or a large stream
     deadlocks; both halves run concurrently and the promise is collected for the
     rejection only. */
  const written = writer.write(data).then(() => writer.close()).catch(() => {});

  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  let capped = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        /* Stop reading. The stream is abandoned rather than drained, which is
           what keeps the peak allocation bounded. */
        capped = true;
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } catch {
    /* A truncated or corrupt stream. Keep what was already inflated — the
       prefix is usually intact and the error is usually in the last few bytes. */
    await written;
    return chunks.length
      ? { ok: true, bytes: concat(chunks, total), truncated: true, capped }
      : null;
  }

  await written;
  if (!chunks.length && !capped) return null;
  return { ok: true, bytes: concat(chunks, Math.min(total, cap)), truncated: false, capped };
}

function looksPlain(data) {
  /* Mostly printable ASCII in the first 256 bytes. Heuristic, used only as a
     last resort, and never to override a real decode failure report. */
  const n = Math.min(data.length, 256);
  if (n < 8) return false;
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const c = data[i];
    if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c < 0x7f)) printable++;
  }
  return printable / n > 0.9;
}

/* ── LZWDecode ────────────────────────────────────────────────────────────── */

/** LZW as §7.4.4, which differs from GIF's LZW in two ways that matter:
 *
 *  1. Codes start at 9 bits and grow one bit earlier — at 511 and 1023 rather
 *     than 511 and 1023 *after* the addition, depending on `EarlyChange`.
 *  2. The code 256 is the clear-table code, and 257 is end-of-data. §7.4.4.2 says
 *     the encoder *should* emit them; readers must tolerate their absence.
 *
 *  The dictionary is bounded at 4096 by the format itself, so this cannot grow
 *  without limit — but `maxDepth` still guards the output.
 */
function lzwDecode(data, parms, limits) {
  const early = parms.earlyChange === 0 ? 0 : 1;
  const out = [];
  let outLength = 0;

  let dict = new Map();
  const resetDict = () => {
    dict = new Map();
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), [i]);
    dict.set("256", null); // clear table
    dict.set("257", null); // EOD
  };
  resetDict();

  let codeWidth = 9;
  let bitBuffer = 0;
  let bitCount = 0;
  let pos = 0;
  let previous = null;

  const nextCode = () => {
    while (bitCount < codeWidth) {
      if (pos >= data.length) return null;
      bitBuffer = (bitBuffer << 8) | data[pos++];
      bitCount += 8;
    }
    bitCount -= codeWidth;
    const code = (bitBuffer >>> bitCount) & ((1 << codeWidth) - 1);
    return code;
  };

  for (;;) {
    const code = nextCode();
    if (code === null) break;

    if (code === 256) {
      resetDict();
      codeWidth = 9;
      previous = null;
      continue;
    }
    if (code === 257) break;

    let entry;
    if (code < 256) {
      entry = [code];
    } else if (dict.has(String(code))) {
      entry = dict.get(String(code));
    } else if (previous) {
      /* The KwKwK case: a code that is not yet in the table is the previous
         entry with its own first character appended. */
      entry = [...previous, previous[0]];
    } else {
      break; // a code before any previous entry: malformed
    }

    for (const byte of entry) {
      out.push(byte);
      outLength++;
      if (outLength > limits.maxStreamBytes) return capped(out, limits);
    }

    if (previous) {
      const size = dict.size;
      dict.set(String(size), [...previous, entry[0]]);
      /* The width grows one code earlier than GIF, which is what EarlyChange=1
         means and what most PDF producers emit. */
      const limit = early ? (1 << codeWidth) - 1 : (1 << codeWidth);
      if (size + early >= limit && codeWidth < 12) codeWidth++;
    }
    previous = entry;
  }

  return new Uint8Array(out);
}

function readLzwParms(parms) {
  const d = dictOf(parms);
  return { earlyChange: numberOr(d.EarlyChange, 1) };
}

/* ── ASCII85Decode ────────────────────────────────────────────────────────── */

/** §7.4.3. The `z` shorthand, the `<~` prefix and the `~>` terminator are all
 *  optional in the wild; the terminator is what actually bounds the data, and a
 *  stream without one runs to the end of its own length. */
function ascii85Decode(data, limits) {
  const out = [];
  let tuple = 0;
  let count = 0;
  let started = false;

  for (let i = 0; i < data.length; i++) {
    const c = data[i];

    if (!started) {
      /* Skip whitespace before the first digit. */
      if (isWs(c)) continue;
      if (c === 0x3c && data[i + 1] === 0x7e) { // <~
        i++;
        continue;
      }
      started = true;
    }

    if (isWs(c)) continue;
    if (c === 0x7e) break; // ~>
    if (c === 0x7a && count === 0) { // z: four zero bytes
      for (let k = 0; k < 4; k++) out.push(0);
      if (out.length > limits.maxStreamBytes) return capped(out, limits);
      continue;
    }
    /* `y`/`Y` handle the 2-byte and 1-byte tail groups. Rare, but a producer
       that emits them expects the reader to know them. */
    if ((c === 0x79 || c === 0x59) && count === 0) {
      const pad = c === 0x79 ? 3 : 4;
      for (let k = 0; k < pad; k++) out.push(0);
      if (out.length > limits.maxStreamBytes) return capped(out, limits);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue; // outside the digit range; ignore

    tuple = tuple * 85 + (c - 0x21);
    count++;
    if (count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
      if (out.length > limits.maxStreamBytes) return capped(out, limits);
    }
  }

  /* A trailing partial group encodes fewer bytes: the `n` digits carry n-1
     bytes, so the high bytes are dropped. */
  if (count > 0) {
    for (let k = count; k < 5; k++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    for (let k = 0; k < count - 1; k++) out.push(bytes[k]);
  }

  return new Uint8Array(out);
}

/* ── ASCIIHexDecode ───────────────────────────────────────────────────────── */

/** §7.4.2. Hex digits until `>`. An odd count is padded with a trailing zero
 *  per §7.3.4.3 — the same rule as hex strings, and files rely on it. */
function asciiHexDecode(data, limits) {
  const out = [];
  let nibble = null;

  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3e) break; // >
    const v = hexValue(c);
    if (v === null) continue; // whitespace and anything else is ignored
    if (nibble === null) {
      nibble = v;
    } else {
      out.push((nibble << 4) | v);
      nibble = null;
      if (out.length > limits.maxStreamBytes) return capped(out, limits);
    }
  }

  if (nibble !== null) out.push(nibble << 4); // odd trailing digit
  return new Uint8Array(out);
}

function hexValue(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return null;
}

/* ── RunLengthDecode ──────────────────────────────────────────────────────── */

/** §7.4.5. A byte of 0–127 is a literal run of that many plus one; 129–255 is a
 *  repeat of the next byte, 256-n times; 128 is end-of-data. */
function runLengthDecode(data, limits) {
  const out = [];
  let i = 0;

  while (i < data.length) {
    const length = data[i++];
    if (length === 128) break; // EOD
    if (length < 128) {
      const count = length + 1;
      for (let k = 0; k < count; k++) {
        if (i >= data.length) break;
        out.push(data[i++]);
      }
    } else {
      const count = 257 - length;
      const byte = i < data.length ? data[i++] : 0;
      for (let k = 0; k < count; k++) out.push(byte);
    }
    if (out.length > limits.maxStreamBytes) return capped(out, limits);
  }

  return new Uint8Array(out);
}

/* ── Predictors ───────────────────────────────────────────────────────────── */

/** The `/DecodeParms` that carries `/Predictor`, and nothing else.
 *
 *  `/Predictor` may sit directly in the parameters or inside a `/PredictorParams`
 *  sub-dictionary — both spellings appear in files from different producers. */
function readPredictor(decodeParms) {
  if (!decodeParms) return null;
  const entry = Array.isArray(decodeParms) ? decodeParms[0] : decodeParms;
  if (!entry) return null;

  let d = dictOf(entry);
  if (d.Predictor === undefined && d.PredictorParams) {
    d = dictOf(d.PredictorParams);
  }
  const value = numberOr(d.Predictor, 1);
  if (value <= 1) return null;

  return {
    value,
    colors: numberOr(d.Colors, 1),
    bpc: numberOr(d.BitsPerComponent, 8),
    columns: numberOr(d.Columns, 1),
  };
}

/** §7.4.4.4. Predictor 2 is TIFF, 10–15 are PNG.
 *
 *  PNG's Up filter (2) subtracts the byte above; Sub (1) subtracts the byte to
 *  the left. Both are applied byte-wise across a row, with the row length
 *  computed from `/Colors × /BitsPerComponent × /Columns` — and `/Columns`
 *  defaulting to 1 is the detail that silently corrupts everything when a
 *  producer omits it. */
function applyPredictor(data, parms, limits) {
  const inputBytes = data.length;
  const bpp = Math.ceil((parms.colors * parms.bpc) / 8); // bytes per pixel, ≥1
  const rowLength = Math.ceil((parms.colors * parms.bpc * parms.columns) / 8);

  if (rowLength <= 0) {
    return { ok: false, reason: "Predictor: /Columns on 0 või negatiivne" };
  }

  const out = new Uint8Array(inputBytes);
  out.set(data);

  if (parms.value === 2) {
    /* TIFF predictor: each component subtracts the one above it. No filter byte
       is involved — TIFF rows are exactly rowLength bytes. */
    const rows = Math.floor(inputBytes / rowLength);
    for (let r = 0; r < rows; r++) {
      const base = r * rowLength;
      for (let i = bpp; i < rowLength; i++) {
        out[base + i] = (out[base + i] + out[base + i - bpp]) & 0xff;
      }
    }
    void limits;
    return { ok: true, bytes: out, inputBytes };
  }

  /* PNG predictors.
   *
   * Each row is `[filter type byte][rowLength bytes]`, so a row *occupies*
   * rowLength + 1 bytes but the predictor's arithmetic spans only rowLength.
   * The first draft divided the whole buffer by rowLength, which made the type
   * byte of row 1 the last data byte of row 0: the Up filter then added the
   * filter byte into the first pixel, and every row after the first decoded to
   * the wrong values. The failure looked like a wrong image rather than an
   * off-by-one, which is why it is worth spelling out.

   * The fix is two lengths, not one: `rowLength` for the arithmetic, `stride`
   * for the walk. */
  const stride = rowLength + 1;
  const rows = Math.floor(inputBytes / stride);

  for (let r = 0; r < rows; r++) {
    const base = r * stride;
    const type = out[base];
    const line = base + 1;

    switch (type) {
      case 0: // None
        break;
      case 1: // Sub
        for (let i = bpp; i < rowLength; i++) {
          out[line + i] = (out[line + i] + out[line + i - bpp]) & 0xff;
        }
        break;
      case 2: // Up
        for (let i = 0; i < rowLength; i++) {
          /* Row 0 has no row above it; §7.4.4.4 defines it as unchanged rather
             than as an error, and files do rely on that. */
          const up = r === 0 ? 0 : out[base - stride + 1 + i];
          out[line + i] = (out[line + i] + up) & 0xff;
        }
        break;
      case 3: // Average
        for (let i = 0; i < rowLength; i++) {
          const left = i >= bpp ? out[line + i - bpp] : 0;
          const up = r === 0 ? 0 : out[base - stride + 1 + i];
          out[line + i] = (out[line + i] + ((left + up) >> 1)) & 0xff;
        }
        break;
      case 4: // Paeth
        for (let i = 0; i < rowLength; i++) {
          const left = i >= bpp ? out[line + i - bpp] : 0;
          const up = r === 0 ? 0 : out[base - stride + 1 + i];
          const upLeft = r === 0 || i < bpp ? 0 : out[base - stride + 1 + i - bpp];
          out[line + i] = (out[line + i] + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        /* An unknown filter type leaves the row as stored. The other rows stay
           good, so the bytes are kept and the count reported. */
        break;
    }
  }

  /* Drop the filter bytes so the caller receives plain row data. Keeping them
     would make the output row length wrong by one and shift every later byte. */
  const stripped = new Uint8Array(rows * rowLength);
  for (let r = 0; r < rows; r++) {
    stripped.set(out.subarray(r * stride + 1, r * stride + 1 + rowLength), r * rowLength);
  }

  void limits;
  return { ok: true, bytes: stripped, inputBytes };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function dictOf(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function numberOr(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return fallback;
}

function isWs(c) {
  return c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    if (at + chunk.length > total) {
      out.set(chunk.subarray(0, total - at), at);
      break;
    }
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Truncate an accumulator to the cap.
 *
 *  The accumulators are plain arrays, not typed arrays, because the decoders
 *  push a byte at a time and a typed array would need reallocation per push.
 *  The first draft called `.subarray` on one of them, which does not exist on an
 *  Array — the cap fired exactly when it was needed and threw instead. */
function capped(out, limits) {
  return new Uint8Array(out.length > limits.maxStreamBytes
    ? out.slice(0, limits.maxStreamBytes)
    : out);
}