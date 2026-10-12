// ── formats/pdf/raw.js ────────────────────────────────────────────────────────
// The byte-level layer: what the file says about itself, read without trusting
// it.
//
// This is the part pdf.js does not expose and the reason the project has its own
// parser. A PDF carries two accounts of itself — the cross-reference table,
// which is a claim, and the bytes, which are the fact — and they disagree more
// often than producers admit. Every number here is reported with its provenance:
// a value the file declares, a value this module derived from the bytes, or a
// value it could not read.
//
// Phase 5 covers the classic cross-reference table. Xref streams, object streams
// and the filters are phase 6, and this module says so plainly where it meets
// one rather than guessing at its contents.
//
// The four questions it answers, in order:
//
//   1. Where is the header, and is it where a header belongs?
//   2. Where are the `%%EOF` markers, the `startxref` pointers and the `xref`
//      keywords — and which of those are structural rather than coincidences?
//   3. What does the cross-reference chain say, revision by revision?
//   4. What is in the Info dictionary and the XMP packet?
//
// Question 2 is where a naive parser goes wrong, and §5.2 says why: `xref`
// occurs inside `startxref`, inside compressed streams and inside binary image
// data. A file can therefore contain the word `xref` a hundred times and have
// one cross-reference table. Counting matches is not counting structure.
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from "../contract.js";
import { get, parseDictAt, toObject } from "./lexer.js";
import { decodeStream } from "./filters.js";
import { namesOf, parmsOf, readObjectStream, readXrefStream } from "./streams.js";

/** The header is `%PDF-` (§7.5.2). §7.5.2 also lets a conforming file place it
 *  within the first 1024 bytes, which the registry already allows; this records
 *  where it actually was rather than assuming offset 0. */
const HEADER = "%PDF-";

/** `startxref` (§7.5.5) and `%%EOF` (§7.5.5) are the two markers that close a
 *  revision. */
const STARTXREF = "startxref";
const EOF_MARKER = "%%EOF";

/** How much context to keep beside an unverified candidate. Enough to recognise
 *  the match in a hex editor, short enough that a thousand of them cannot fill
 *  the page. */
const CONTEXT_BYTES = 24;

/** A scan refuses to enumerate more than this many marker matches. A file built
 *  to make the scanner work hard gets a truncated list, not a frozen tab. */
const MAX_MATCHES = 2000;

/* ── Public API ─────────────────────────────────────────────────────────────── */

/**
 * Scan a PDF for everything phase 5 reports on.
 *
 * @param {Uint8Array} bytes the whole file
 * @param {{limits?: object, clock?: object}} [opts]
 * @returns {object} the findings, shaped for formats/pdf/index.js to turn into
 *   nodes. Never throws: a malformed file is a finding, not a failure.
 */
export async function scan(bytes, opts = {}) {
  const limits = opts.limits ?? LIMITS;
  const clock = opts.clock ?? { expired: () => false, elapsed: () => 0 };
  const source = latin1(bytes);
  const notes = [];

  try {
    const header = readHeader(source);
    const markers = findMarkers(source, clock);
    const revisions = await readRevisionChain(bytes, source, header, markers, limits, clock, notes);
    const current = revisions[0] ?? null;
    const info = await readInfo(bytes, source, current, revisions, limits, clock, notes);
    const xmp = readXmp(source);
    const catalog = await readCatalog(bytes, source, revisions, limits, clock, notes);
    const resolver = makeResolver(bytes, source, revisions, limits, clock, notes);
    const encryption = await readEncryption(bytes, source, current, revisions, limits, clock, notes);

    return {
      header,
      markers,
      revisions: revisions.map(stripForOutput),
      info,
      xmp,
      catalog,
      resolver,
      encryption,
      comparison: await compareRevisions(bytes, source, revisions, limits, clock, notes),
      repaired: repairScan(bytes, source, revisions, limits, clock),
      notes,
    };
  } catch (err) {
    /* The scan is the analyser's evidence, and the analyser must still produce
       something. An exception here would land in the registry's catch and be
       reported as "analüüs katkes", which is true but far less useful than the
       partial finding plus the reason it stopped. */
    notes.push({
      code: "scan-incomplete",
      messageEt: `Toorandmete skann katkes: ${err?.message ?? "teadmata viga"}`,
    });
    return {
      header: null,
      markers: { startxref: [], eof: [], xref: [], truncated: false },
      revisions: [],
      info: { present: false, reason: "skann katkes enne Infodiktsiooni lugemist" },
      xmp: { present: false, reason: "skann katkes enne XMP-paketi lugemist" },
      catalog: { present: false, reason: "skann katkes enne kataloogi lugemist" },
      resolver: null,
      notes,
    };
  }
}

/* ── 1. The header ──────────────────────────────────────────────────────────── */

/** Find `%PDF-` and read the version after it.
 *
 *  The offset is a finding in its own right. A header at offset 0 is normal; a
 *  header at 1 024 bytes inside the file means something was prepended — a mail
 *  gateway banner, an HTML error page saved as a PDF — and every offset in the
 *  cross-reference table is measured from byte 0 regardless, so the parser has
 *  to know. §7.5.2 lets the reader accept it; it does not make it normal. */
function readHeader(source) {
  const limit = Math.min(source.length, 1024);
  const at = source.indexOf(HEADER, 0);
  if (at === -1 || at >= limit) {
    return { found: false, offset: null, version: null, complete: at !== -1 && at >= limit };
  }
  const version = readVersionAt(source, at + HEADER.length);
  return {
    found: true,
    offset: at,
    version: version.value,
    malformed: version.malformed,
  };
}

function readVersionAt(source, at) {
  const major = source[at];
  const minor = source[at + 2];
  const valid = /^[0-9]$/.test(major ?? "") && /^[0-9]$/.test(minor ?? "");
  const value = valid ? `${major}.${minor}` : null;
  return { value, malformed: !valid };
}

/* ── 2. Markers ─────────────────────────────────────────────────────────────── */

/** Every `startxref`, `%%EOF` and `xref` occurrence, each classified.
 *
 *  This is a plain byte scan over the whole buffer, deliberately not a regex and
 *  not bounded to any region: `%%EOF` legitimately appears once per revision,
 *  and a file whose revisions were produced by an unknown tool may put them
 *  anywhere. The classification afterwards is what separates structure from
 *  coincidence. */
function findMarkers(source, clock) {
  const startxref = [];
  const eof = [];
  const xref = [];
  let truncated = false;

  let from = 0;
  for (;;) {
    if (clock.expired()) {
      truncated = true;
      break;
    }
    const at = source.indexOf(STARTXREF, from);
    if (at === -1) break;
    if (startxref.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    startxref.push(classifyStartxref(source, at));
    from = at + STARTXREF.length;
  }

  from = 0;
  for (;;) {
    if (eof.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    const at = source.indexOf(EOF_MARKER, from);
    if (at === -1) break;
    eof.push(classifyEof(source, at));
    from = at + EOF_MARKER.length;
  }

  from = 0;
  for (;;) {
    if (xref.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    const at = source.indexOf("xref", from);
    if (at === -1) break;
    xref.push(classifyXref(source, at));
    from = at + 4;
  }

  return { startxref, eof, xref, truncated };
}

/** `startxref` at a line start, followed by a number, is a pointer. Anywhere else
 *  — inside a stream, mid-line, or with nothing numeric after it — it is a
 *  *kahtlane kandidaat* (§5.2): a coincidence worth showing, not structure. */
function classifyStartxref(source, at) {
  const atLineStart = isAtLineStart(source, at);
  const after = source.slice(at + STARTXREF.length).match(/^[ \t\r\n]*(\d+)/);
  const target = after ? Number(after[1]) : null;
  /* §7.5.5: startxref then a number then %%EOF. The marker need not be at the
     very end — trailing whitespace is normal, and some producers append more —
     so the EOF test is bounded to the next 64 bytes rather than "is it last". */
  const eofNear = source.indexOf(EOF_MARKER, at + STARTXREF.length);
  const eofWithin64 = eofNear !== -1 && eofNear - at < 64;
  const structural = atLineStart && target !== null;
  return {
    offset: at,
    target,
    structural,
    atLineStart,
    followedByEof: eofWithin64,
    context: contextBytes(source, at),
  };
}

/** A `%%EOF` that ends a line is the marker proper. One in the middle of a line
 *  or inside a stream is a coincidence — and because compressed streams are
 *  mostly noise, a big file produces a great many of those. */
function classifyEof(source, at) {
  const structural = isAtLineStart(source, at);
  return { offset: at, structural, context: contextBytes(source, at) };
}

/** The distinction §5.2 spells out, in three conditions:
 *
 *   1. at the start of a line;
 *   2. *not* the tail of `startxref` — which is why the previous four bytes are
 *      checked for "start", and why a plain `indexOf("xref")` is not enough;
 *   3. followed by a syntactically plausible table header, i.e. two integers
 *      separated by whitespace: the `start count` of a subsection.
 *
 *  Only then is it a table. Everything else is reported with its context bytes
 *  and a reason, because "this file contains the word xref 400 times, 398 of
 *  them inside a JPEG" is itself the kind of finding that section is for. */
function classifyXref(source, at) {
  const previous = source.slice(Math.max(0, at - 5), at);
  const followsStartxref = previous.toLowerCase().endsWith("start");
  const atLineStart = isAtLineStart(source, at);

  const after = source.slice(at + 4);
  const header = after.match(/^[ \t\r\n]+(\d+)[ \t\r\n]+(\d+)/);
  const plausibleHeader = !!header;

  /* Whether a `trailer` follows is recorded but is *not* part of the structural
     test. It was, and it made every real table read as a coincidence: the
     keyword's test looked for `trailer` immediately after the table header, when
     the entries sit in between. §5.2 names exactly three conditions — line
     start, not the tail of `startxref`, plausible header — and those are what
     this tests. */
  const trailerNear = /^[ \t\r\n]*trailer\b/.test(after);

  const structural = atLineStart && !followsStartxref && plausibleHeader;

  let reason = null;
  if (followsStartxref) reason = "startxref-i sõnaots";
  else if (!atLineStart) reason = "rea alguses mitte";
  else if (!plausibleHeader) reason = "puudub tabeli päise";

  return {
    offset: at,
    structural,
    reason,
    atLineStart,
    plausibleHeader,
    trailerNear,
    context: contextBytes(source, at),
  };
}

/** True when only whitespace separates `at` from the start of a line, or from
 *  the start of the file. §7.2.3 defines a line by its end-of-line marker, and a
 *  line start may be the file start. */
function isAtLineStart(source, at) {
  for (let i = at - 1; i >= 0; i--) {
    const ch = source.charCodeAt(i);
    if (ch === 0x0a || ch === 0x0d) return true;
    if (ch !== 0x20 && ch !== 0x09 && ch !== 0x00) return false;
  }
  return true;
}

/** Bytes around a match, for the visitor to recognise in a hex editor. Rendered
 *  as hex with printable ASCII beside it, which is how a hex editor shows it —
 *  the context is there to be compared, not to be read as prose. */
function contextBytes(source, at) {
  const start = Math.max(0, at - 4);
  const end = Math.min(source.length, at + CONTEXT_BYTES);
  const slice = source.slice(start, end);
  let hex = "";
  let printable = "";
  for (let i = 0; i < slice.length; i++) {
    const code = slice.charCodeAt(i);
    hex += code.toString(16).padStart(2, "0") + (i === 3 ? " " : "");
    printable += code >= 0x20 && code < 0x7f ? slice[i] : ".";
  }
  return { start, hex, printable };
}

/* ── 3. The revision chain ─────────────────────────────────────────────────── */

/** Follow `startxref`, then `/Prev`, and read each cross-reference section.
 *
 *  The chain is walked newest-first: the last `startxref` names the current
 *  revision, and each trailer's `/Prev` names the one before it. The walk is
 *  bounded twice over — by `maxDepth` revisions and by a set of visited offsets
 *  — because a damaged file can have a `/Prev` that points at itself or
 *  forwards, and a loop is the one failure this code cannot afford. */
async function readRevisionChain(fileBytes, source, header, markers, limits, clock, notes) {
  const revisions = [];

  const structuralPointers = markers.startxref.filter((m) => m.structural);
  /* The last structural pointer is the current revision. If there is none the
     file claims no usable pointer, which is a finding, and the chain starts
     from the file's own structure instead — which is phase 6's repair mode, so
     here it is recorded and nothing more. */
  let start = structuralPointers.at(-1)?.target ?? null;
  if (start === null) {
    notes.push({
      code: "no-startxref",
      messageEt:
        "Failis ei leitud kasutatavat startxref-viitit. Ristviidestikku ei saanud faili järgi lugeda.",
    });
    return revisions;
  }

  const visited = new Set();
  while (start !== null && revisions.length < limits.maxDepth) {
    if (clock.expired()) {
      notes.push({ code: "chain-timeout", messageEt: "Versioonide ahela lugemine katkes ajapiiri tõttu." });
      break;
    }
    if (visited.has(start)) {
      notes.push({
        code: "prev-loop",
        messageEt: `Ristviidestiku ahel tsüklistatud asukohal ${start}.`,
      });
      break;
    }
    if (start < 0 || start >= source.length) {
      notes.push({
        code: "xref-offset-out-of-range",
        messageEt: `startxref-viit ${start} jääb failist välja.`,
      });
      break;
    }
    visited.add(start);

    let section = readXrefSection(source, start, limits, clock, notes);
    if (!section) break;

    /* A cross-reference stream is an ordinary object whose payload has to be
       decoded before it can be read, so this is where phase 5's "not yet" note
       is replaced by the real thing. */
    if (section.kind === "stream-pending") {
      section = await readXrefStream(fileBytes, section.xrefOffset, {
        source, notes, limits, clock,
      });
      if (!section) break;
    }

    revisions.push({
      index: revisions.length,
      xrefOffset: start,
      kind: section.kind,
      entries: section.entries,
      inUse: section.inUse,
      free: section.free,
      subsections: section.subsections,
      declaredSize: section.declaredSize,
      trailerObj: section.trailer,
      prev: section.prev,
      xrefStm: section.xrefStm,
      hasEncrypt: section.hasEncrypt,
      encrypt: section.encrypt,
      root: section.root,
      info: section.info,
      id: section.id,
    });

    start = section.prev;
  }

  if (revisions.length === 0) {
    notes.push({
      code: "no-xref-read",
      messageEt: "Ristviidestikku ei õnnestunud lugeda.",
    });
  }
  return revisions;
}

/** Read one cross-reference section at a byte offset.
 *
 *  Two forms exist. The classic table is the one phase 5 handles: the keyword
 *  `xref`, subsections of `start count` followed by that many fixed-width
 *  entries, and a `trailer` dictionary. An xref stream (§7.5.8.2) is an indirect
 *  object holding the same information in binary and compressed; it is phase 6,
 *  and it is recognised here so the file can say which kind it has rather than
 *  the report implying none was found. */
function readXrefSection(source, offset, limits, clock, notes) {
  const at = source.slice(offset, offset + 32);

  if (/^\s*xref/.test(at)) {
    return readClassicXref(source, offset, limits, clock, notes);
  }

  /* `N G obj << /Type /XRef` — the xref stream form. */
  const streamHeader = at.match(/^\s*(\d+)\s+(\d+)\s+obj/);
  if (streamHeader) {
    return {
      kind: "stream-pending",
      streamObjectNumber: Number(streamHeader[1]),
      generation: Number(streamHeader[2]),
      xrefOffset: offset,
    };
  }

  notes.push({
    code: "xref-unreadable",
    messageEt: `Asukohal ${offset} ei ole loetav ristviidestik.`,
  });
  return null;
}

/** A classic cross-reference table.
 *
 *  Each subsection header is `start count`, and each entry is exactly twenty
 *  bytes: ten digits of offset, a space, five digits of generation, a space, and
 *  `n` or `f`. The spec says twenty bytes exactly, and real files disagree —
 *  some use bare LF, some CR, some CRLF, some pad with spaces — so the entries
 *  are read by matching the shape rather than by counting twenty. What is *not*
 *  relaxed is the offset: an entry that does not parse is kept as a count of
 *  bad entries rather than silently dropped, because a table full of them is a
 *  finding. */
function readClassicXref(source, offset, limits, clock, notes) {
  const { dict: trailer, end } = readTrailer(source, offset, limits, clock, notes);
  const trailerObj = toObject(trailer);
  const entries = new Map();
  const subsections = [];
  let inUse = 0;
  let free = 0;
  let badEntries = 0;

  let pos = offset;
  /* Step to just past the `xref` keyword. */
  const keywordEnd = source.indexOf("xref", pos);
  pos = keywordEnd === -1 ? offset : keywordEnd + 4;

  for (;;) {
    if (clock.expired()) {
      notes.push({ code: "table-timeout", messageEt: "Ristviidetabeli lugemine katkes ajapiiri tõttu." });
      break;
    }
    const mark = pos;
    pos = skipWs(source, pos);

    /* `trailer` ends the section. */
    if (source.startsWith("trailer", pos)) break;

    /* A subsection header: two integers. Anything else means the table is over
       or malformed, and both are reported by the caller through `notes`. */
    const header = source.slice(pos, pos + 64).match(/^(\d+)[\x00\t\n\f\r ]+(\d+)/);
    if (!header) {
      if (pos < end || pos < source.length) {
        notes.push({
          code: "table-malformed",
          messageEt: `Ristviidetabeli lõpp ei loetud asukohast ${pos}.`,
        });
      }
      break;
    }
    const start = Number(header[1]);
    const count = Number(header[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 0) {
      notes.push({ code: "table-bad-header", messageEt: `Ristviidetabeli jaotis ${start} ${count} ei ole loetav.` });
      break;
    }
    subsections.push({ start, count });
    pos = skipWs(source, pos + header[0].length);

    /* The count. Bounded by `maxObjects` so a header claiming four billion
       entries cannot turn into four billion loop iterations. */
    const wanted = Math.min(count, limits.maxObjects);
    if (wanted < count) {
      notes.push({
        code: "table-oversized",
        messageEt: `Ristviidetabeli jaotis ${start} ${count} ületab objektide piiri; loeti ${wanted}.`,
      });
    }

    for (let i = 0; i < wanted; i++) {
      if (clock.expired()) {
        notes.push({ code: "table-timeout", messageEt: "Ristviidetabeli lugemine katkes ajapiiri tõttu." });
        break;
      }
      const entry = readXrefEntry(source, pos);
      if (!entry) {
        badEntries++;
        pos = skipWs(source, pos);
        if (pos === mark) break;
        continue;
      }
      const objNum = start + i;
      /* First writer wins within a section: the table is ordered, and a
         duplicate is a defect the caller reports rather than a reason to prefer
         the later row. */
      if (!entries.has(objNum)) {
        entries.set(objNum, entry);
      }
      if (entry.free) free++;
      else inUse++;
      pos = entry.next;
    }
    if (pos === mark) break;
  }

  if (badEntries > 0) {
    notes.push({
      code: "table-bad-entries",
      messageEt: `${badEntries} ristviidetabeli kirjet ei olnud loetavad.`,
    });
  }

  return {
    kind: "classic",
    entries,
    inUse,
    free,
    subsections,
    declaredSize: intOf(get(trailer, "Size")),
    trailer,
    prev: intOf(get(trailer, "Prev")),
    xrefStm: get(trailer, "XRefStm"),
    hasEncrypt: get(trailer, "Encrypt") !== null,
    encrypt: get(trailer, "Encrypt"),
    root: get(trailer, "Root"),
    info: get(trailer, "Info"),
    id: get(trailer, "ID"),
  };
}

/** One twenty-byte entry, read by shape.
 *
 *  `nnnnnnnnnn ggggg n` for in use, `nnnnnnnnnn ggggg f` for free. The trailing
 *  two bytes are the end-of-line marker and are not matched, because the three
 *  common spellings differ and a strict twenty-byte read rejects files that
 *  every reader opens. */
function readXrefEntry(source, pos) {
  const slice = source.slice(pos, pos + 32);
  const m = slice.match(/^(\d{10})[\x00\t\n\f\r ](\d{5})[\x00\t\n\f\r ]([nf])/);
  if (!m) return null;
  const free = m[3] === "f";
  /* For a free entry the first field is the next free object, not an offset, and
     `nextFree` records that rather than pretending it points at bytes. */
  const entry = {
    offset: free ? null : Number(m[1]),
    gen: Number(m[2]),
    free,
    nextFree: free ? Number(m[1]) : null,
  };
  /* Advance past the end-of-line marker. §7.5.4 fixes the entry at twenty bytes
     with exactly one EOL character, but the byte at index 18 is *either* the
     type letter *or* padding, because the common spellings are `n \r\n`, `n \n`
     and `n\r\n` — three bytes after the letter, two, or two with no space. So
     the type letter is matched optionally-preceded by a space, and what follows
     is skipped by shape rather than counted.

     The first draft counted CRLF exactly. On a file padded with a trailing space
     it left the cursor on that space, the next entry failed to match, and every
     object number after the first came out one too low — an error that looks
     like plausible data rather than a crash, which is the worst kind. */
  let next = pos + m[0].length;
  while (next < source.length && /[\x00\t\n\f\r ]/.test(source[next])) {
    /* Stop at the next digit so a table whose entries run together with no EOL at
       all still advances one entry at a time instead of swallowing the section. */
    if (/[0-9]/.test(source[next])) break;
    next++;
  }
  entry.next = next;
  return entry;
}

/** The `trailer` dictionary following a classic table.
 *
 *  `/Prev` is where the chain continues; `/XRefStm` is the hybrid-reference file
 *  of §7.5.8.4 and is recorded but not followed, since it is itself a stream. */
function readTrailer(source, offset, limits, clock, notes) {
  let pos = source.indexOf("xref", offset);
  pos = pos === -1 ? offset : pos + 4;
  /* Find the trailer keyword at or after here. A bounded search: the table ends
     at its trailer, and a file with no trailer must not cost a whole-file scan
     here. */
  const trailerAt = findTrailer(source, pos);
  if (trailerAt === -1) {
    notes.push({ code: "trailer-missing", messageEt: "Ristviidetabeli järel pole trailer-diktsiooni." });
    return { dict: null, end: pos };
  }
  try {
    const parsed = parseDictAt(source, trailerAt + "trailer".length, limits, clock);
    return { dict: parsed.dict, end: parsed.end };
  } catch (err) {
    notes.push({
      code: "trailer-unreadable",
      messageEt: `Trailer-diktsiooni ei saanud lugeda: ${err?.message ?? "teadmata viga"}`,
    });
    return { dict: null, end: trailerAt };
  }
}

/** The next `trailer` keyword at a line start, within a sane distance. */
function findTrailer(source, from) {
  let pos = from;
  for (let guard = 0; guard < MAX_MATCHES; guard++) {
    const at = source.indexOf("trailer", pos);
    if (at === -1) return -1;
    if (isAtLineStart(source, at)) return at;
    pos = at + 7;
  }
  return -1;
}

/* ── 4. Info and XMP ───────────────────────────────────────────────────────── */

/** The Info dictionary, as the current revision declares it.
 *
 *  `/Info` is an indirect reference, so the object has to be found in the table
 *  and then read at the offset the table gives. If the table is wrong the object
 *  is not found — and that is reported as "not found", because guessing an
 *  object number the file did not claim would be exactly the over-claiming §11
 *  warns about. Phase 6's repair mode scans for `N G obj` directly. */
async function readInfo(fileBytes, source, revision, revisions, limits, clock, notes) {
  /* Always an object, never null. "There is no Info dictionary" and "there is
     no Info dictionary *because the file could not be read*" are both results,
     and a caller that has to null-check before it can tell them apart will
     eventually forget and render an empty tab as a silent failure. The reason
     travels with the `present: false`, so the page can say which it was. */
  if (!revision) {
    return {
      present: false,
      reason: "versiooni ei leitud, seega Infodiktsiooni ei saanud lugeda",
    };
  }
  const ref = revision.info;
  if (!ref || ref.type !== "ref") {
    return { present: false, reason: "traileris puudub /Info" };
  }

  const located = await locateObject(fileBytes, source, ref.num, ref.gen, revisions, limits, clock, notes);
  if (!located) {
    return {
      present: false,
      refNum: ref.num,
      reason: "objekti ei leitud ristviidestikust",
    };
  }
  /* Two shapes reach here. An Info dictionary is usually a direct object, so the
     table gives a byte offset and the object header is verified — a table
     pointing at the wrong bytes yields a dictionary that parses cleanly and says
     something untrue, which is the worst outcome available because it looks like
     data. But it may equally be packed inside an object stream, where there is
     no `N G obj` at any offset in the file and the bytes come from that
     stream's own index instead.

     Both are checked; neither is assumed. */
  let dictValue = null;
  let provenance = null;

  if (located.packed) {
    dictValue = located.packed;
    provenance = `objektivoogus #${located.stream}`;
  } else {
    const header = readObjectHeader(source, located.offset);
    if (!header.ok) {
      return {
        present: false,
        refNum: ref.num,
        reason: `asukohas ${located.offset} pole oodatud objekti (${ref.num} ${ref.gen} obj)`,
      };
    }
    if (header.num !== ref.num) {
      return {
        present: false,
        refNum: ref.num,
        offset: located.offset,
        reason: `ristviidestik osutab objektile ${header.num}, kuid Infodiktsioon on ${ref.num}`,
      };
    }
    try {
      const parsed = parseDictAt(source, header.body, limits, clock);
      if (!parsed.dict) {
        return { present: false, refNum: ref.num, offset: located.offset, reason: "objekt ei ole Infodiktsioon" };
      }
      dictValue = parsed.dict;
      provenance = `asukoht ${located.offset} B`;
    } catch (err) {
      return {
        present: false,
        refNum: ref.num,
        offset: located.offset,
        reason: `Infodiktsiooni ei saanud lugeda: ${err?.message ?? "teadmata viga"}`,
      };
    }
  }

  if (!dictValue || dictValue.type !== "dict") {
    return { present: false, refNum: ref.num, reason: "objekt ei ole Infodiktsioon" };
  }

  const fields = dictValue.entries.map((entry) => ({
    key: entry.key,
    type: entry.value.type,
    text: valueText(entry.value),
    raw: entry.value.raw,
  }));

  return {
    present: true,
    refNum: ref.num,
    offset: located.offset ?? null,
    packedIn: located.packed ? located.stream : null,
    provenance,
    declared: located.offset ?? null,
    entries: dictValue.entries,
    fields,
    raw: dictValue.raw ?? "",
  };
}

/* ── Catalog ────────────────────────────────────────────────────────────────
   The catalog is the document's root object (§7.7.2) and the one structure
   pdf.js 4.10.38 exposes no public getter into — `_pdfInfo` carries only
   `numPages` and `fingerprints`. `/Lang` lives there, so a visitor asking which
   language a document declares has to be answered from the catalog, and the
   catalog is read once for it.

   Only the entries this project needs are extracted. The catalog holds a great
   deal more, and dumping all of it would be a page of its own. */

async function readCatalog(fileBytes, source, revisions, limits, clock, notes) {
  const rootRef = revisions[0]?.root ?? null;
  if (!rootRef) return { present: false, reason: "traileris puudub /Root" };

  const located = await locateObject(fileBytes, source, rootRef.num, rootRef.gen, revisions, limits, clock, notes);
  let dict = null;
  if (located?.packed) {
    dict = located.packed;
  } else if (located?.offset != null) {
    const header = readObjectHeader(source, located.offset);
    if (header.ok && header.num === rootRef.num) {
      try {
        dict = parseDictAt(source, header.body, limits, clock).dict;
      } catch (err) {
        notes.push({ code: "catalog", messageEt: `Kataloogi ei saanud lugeda: ${err?.message ?? "viga"}` });
      }
    }
  }

  if (!dict || dict.type !== "dict") {
    return { present: false, reason: "kataloogi ei leitud" };
  }

  const lang = get(dict, "Lang");

  /* The XMP packet lives in the object the catalog's /Metadata names (§7.11.1),
     and that stream is usually FlateDecode'd — so the packet is not findable by
     searching the file. The first draft searched the bytes for `<?xpacket`, which
     works only for a producer that stored the packet uncompressed, and reported
     every other file as having no XMP at all.

     That is §5.4's subject matter: modern producers compress it, so a raw scan
     finds nothing and the packet looks absent when it is merely encoded. */
  const metadata = await readMetadataStream(fileBytes, source, dict, revisions, limits, clock, notes);

  return {
    present: true,
    metadata,
    version: get(dict, "Version")?.raw ?? null,
    pageMode: nameOf(get(dict, "PageMode")),
    pageLayout: nameOf(get(dict, "PageLayout")),
    /* A /Lang written as a name (`/et-EE`) is legal and common; as a string it
       is the usual form. Both are read, and the distinction is kept, because
       "et-EE" as a name and `(et-EE)` as a string come from different tools and
       a reader comparing files may want to know which. */
    lang: lang?.type === "string" ? lang.text : lang?.type === "name" ? lang.name : null,
    langRaw: lang?.raw ?? null,
    langIsName: lang?.type === "name",
    hasMarkInfo: get(dict, "MarkInfo") !== null,
    hasAcroForm: get(dict, "AcroForm") !== null,
    hasOutlines: get(dict, "Outlines") !== null,
    hasNames: get(dict, "Names") !== null,
    hasOpenAction: get(dict, "OpenAction") !== null,
    hasOCProperties: get(dict, "OCProperties") !== null,
  };
}

/* ── The metadata stream ─────────────────────────────────────────────────────
   §7.11.1: the catalog's `/Metadata` names an indirect object holding the XMP
   packet. It is almost always compressed, which is why searching the file for
   `<?xpacket` finds nothing on a modern document — the bytes are Flate, and the
   packet exists only after decoding.

   Both routes are kept. The stream is the correct one and is tried first; the
   byte scan remains as a fallback because some files put the packet somewhere
   the catalog does not name, and a packet found that way is still a packet. */

async function readMetadataStream(fileBytes, source, catalog, revisions, limits, clock, notes) {
  const ref = get(catalog, "Metadata");
  if (!ref || ref.type !== "ref") return null;

  const located = await locateObject(fileBytes, source, ref.num, ref.gen, revisions, limits, clock, notes);
  if (!located) return null;

  /* An object stream cannot contain a stream object, so a packed Metadata would
     itself be malformed. It is reported rather than silently skipped. */
  if (located.packed) {
    notes.push({ code: "metadata-packed", messageEt: "/Metadata objekt on objektivoogus, mida PDF ei luba." });
    return null;
  }

  const header = readObjectHeader(source, located.offset);
  if (!header.ok || header.num !== ref.num) return null;

  let dict;
  try {
    dict = parseDictAt(source, header.body, limits, clock).dict;
  } catch (err) {
    notes.push({ code: "metadata-dict", messageEt: `/Metadata sõnastikku ei saanud lugeda: ${err?.message ?? "viga"}` });
    return null;
  }
  if (!dict?.stream) return null;

  const filters = namesOf(get(dict, "Filter"));
  const parms = parmsOf(get(dict, "DecodeParms"));

  /* Uncompressed is the common case in small files and worth skipping a decode
     for; `decodeStream` returns the input unchanged for an empty filter list, so
     this is an optimisation rather than a separate path. */
  const decoded = await decodeStream(
    fileBytes.subarray(dict.stream.start, dict.stream.end),
    { filters, decodeParms: parms, limits },
  );

  if (!decoded.ok) {
    notes.push({
      code: "metadata-filter",
      messageEt: `XMP-paketi voogu ei saanud lahti pakkida: ${decoded.reason}`,
    });
    return null;
  }

  return {
    refNum: ref.num,
    offset: located.offset,
    storedBytes: dict.stream.end - dict.stream.start,
    decodedBytes: decoded.bytes.length,
    filters,
    appliedFilters: decoded.applied.map((a) => a.name),
    skippedFilters: decoded.skipped,
    truncated: decoded.truncated ?? false,
    bytes: decoded.bytes,
  };
}

/* ── Object resolution ───────────────────────────────────────────────────────
   Fonts and images live several references deep: a page's /Resources names a
   font dictionary, which names a /FontDescriptor, which names a /FontFile3. None
   of those is at a known offset without the cross-reference table, and several
   may be packed inside an object stream.

   `locateObject` above finds *where* an object is; this turns that into the
   parsed value, following one level of indirection. It is deliberately not a
   general resolver: it caches by object number and refuses to chase a cycle,
   because a PDF can name itself and a recursive walk over a cyclic graph has no
   natural termination. */

function makeResolver(fileBytes, source, revisions, limits, clock, notes) {
  const cache = new Map();
  const inProgress = new Set();

  /** The parsed value of object `num`, or null. */
  async function object(num) {
    if (cache.has(num)) return cache.get(num);
    if (inProgress.has(num)) {
      /* A cycle. Returning null here is what stops a crafted document from
         making this walk forever; the caller sees a missing object, which is
         what the cycle amounts to. */
      return null;
    }
    inProgress.add(num);

    let value = null;
    try {
      const located = await locateObject(fileBytes, source, num, 0, revisions, limits, clock, notes);
      if (located?.packed) {
        value = located.packed;
      } else if (located?.offset != null) {
        const header = readObjectHeader(source, located.offset);
        if (header.ok && header.num === num) {
          const parsed = parseDictAt(source, header.body, limits, clock);
          value = parsed.dict ?? null;
          /* A stream object needs its dictionary *and* its payload span; a plain
             dict parse keeps the stream, so nothing is lost, but the offset is
             recorded for images that need the bytes. */
          value = { value, offset: located.offset, body: header.body };
        }
      }
    } catch {
      value = null;
    }

    inProgress.delete(num);
    cache.set(num, value);
    return value;
  }

  /** `get(dict, key)`, followed one level if it is an indirect reference. */
  async function property(dict, key) {
    const direct = get(dict, key);
    if (!direct) return null;
    if (direct.type === "ref") {
      const found = await object(direct.num);
      return found ? found.value ?? found : null;
    }
    return direct;
  }

  /** The same, but keeping the object header so a stream's bytes are reachable. */
  async function propertyObject(dict, key) {
    const direct = get(dict, key);
    if (!direct) return null;
    if (direct.type === "ref") {
      return await object(direct.num);
    }
    return { value: direct, offset: null, body: null };
  }

  /** Walk an array of references, resolving each.
   *
   *  A single reference is accepted as a one-element list, because `/Pages` on
   *  the catalog is one ref while `/Kids` on a tree node is an array, and both
   *  mean "the children are over there". The first version required an array,
   *  so the page walk started at the catalog, read `/Pages`, was handed a ref,
   *  and returned an empty list — reporting "no fonts, no images" for a
   *  document that had both. */
  async function each(arrayValue, limit = 4096) {
    if (!arrayValue) return [];
    if (arrayValue.type === "ref" || arrayValue.type === "dict") {
      const one = await resolve(arrayValue);
      return one?.type === "dict" ? [one] : [];
    }
    if (arrayValue.type !== "array") return [];
    const out = [];
    for (const item of arrayValue.items.slice(0, limit)) {
      out.push(await resolve(item));
    }
    return out;
  }

  /** One value, with a reference followed. */
  async function resolve(value) {
    if (!value) return null;
    if (value.type === "ref") {
      const found = await object(value.num);
      return found ? found.value ?? found : null;
    }
    return value;
  }

  /** The value *and* its object header, for streams. */
  async function resolveObject(value) {
    if (!value) return null;
    if (value.type === "ref") {
      return await object(value.num);
    }
    return { value, offset: null, body: null };
  }

  return { object, property, propertyObject, each, resolve, resolveObject, cache };
}

/* -- Encryption ---------------------------------------------------------------
   Section 5.2 is explicit about what a forensic reader must say about an
   encrypted file, and the important part is not the algorithm -- it is which
   values stay readable. Strings inside /Info **are** encrypted. The strings
   inside /Encrypt itself are not, and neither is the trailer's /ID. So the flags,
   the key length and the owner hash are all reportable from an encrypted file,
   while the document's own metadata is not -- and the interface has to make that
   distinction rather than showing an empty table.

   Nothing here decrypts. A file protected by a user password stays protected;
   this reads what the file says about its own protection. */

async function readEncryption(fileBytes, source, revision, revisions, limits, clock, notes) {
  const encryptRef = revision?.encrypt ?? null;
  if (!encryptRef) return { present: false };

  let dict = null;
  let provenance = null;

  if (encryptRef.type === "dict") {
    dict = encryptRef;
    provenance = "traileris otse";
  } else if (encryptRef.type === "ref") {
    const located = await locateObject(fileBytes, source, encryptRef.num, encryptRef.gen, revisions, limits, clock, notes);
    if (located?.packed) {
      dict = located.packed;
      provenance = `objektivoogus #${located.stream}`;
    } else if (located?.offset != null) {
      const header = readObjectHeader(source, located.offset);
      if (header.ok && header.num === encryptRef.num) {
        try {
          const parsed = parseDictAt(source, header.body, limits, clock);
          if (parsed.dict) {
            dict = parsed.dict;
            provenance = `asukoht ${located.offset} B`;
          }
        } catch (err) {
          notes.push({ code: "encrypt-dict", messageEt: `/Encrypt sõnastikku ei saanud lugeda: ${err?.message ?? "viga"}` });
        }
      }
    }
  }

  if (!dict) {
    return { present: true, readable: false, reason: "/Encrypt leitud, kuid selle sisu ei saanud lugeda" };
  }

  const v = intOf(get(dict, "V"));
  const r = intOf(get(dict, "R"));
  const length = intOf(get(dict, "Length"));

  return {
    present: true,
    readable: true,
    provenance,
    filter: nameOf(get(dict, "Filter")),
    version: v,
    revision: r,
    keyLengthBits: length ?? (v === 5 ? 256 : null),
    keyLengthSource: length != null ? "/Length" : v === 5 ? "V5 vaikimisi" : null,
    permissions: decodePermissions(dict),
    hasOwnerPasswordEntry: get(dict, "O") !== null,
    hasUserPasswordEntry: get(dict, "U") !== null,
    encryptMetadata: get(dict, "EncryptMetadata")?.value ?? null,
    streamFilter: nameOf(get(dict, "StmF")),
    trailerIdStillReadable: revision?.id != null,
    readableSummary:
      "/Encrypt võtmeid ja lukuõigusi saab lugeda; /Info stringid on krüpteeritud ja ilma paroolita loetamatud.",
  };
}

/** Section 7.6.3.1, Table 23. Three details in this table each cost an
 *  afternoon, and all three were caught by diffing against
 *  `qpdf --show-encryption` rather than by reading it carefully — because a
 *  misread produces a confidently wrong field, not an error:
 *
 *  1. **Bit 1 is the least significant bit**, so "bit 3" is `>>> 2`. Two
 *     plausible readings exist: counting from the left, as the table's own
 *     layout invites, gives `>>> 29` and reports *every* permission as allowed.
 *     Counting from the right with an off-by-one gives `>>> 3`, which is wrong
 *     for exactly one flag — high-resolution printing — and therefore looks
 *     right on a file that does not test it. Only the corpus file
 *     `encrypted.pdf`, whose /P has bits 3–6 clear and everything else set,
 *     distinguishes the three.
 *  2. **The /P value is a signed 32-bit integer.** `-3904` and `4294963392` are
 *     the same bit pattern, and a file may write either.
 *  3. Bits 7 and 8 are reserved and must be 1. They are checked, so a file that
 *     clears them is reported as malformed rather than quietly decoded.
 */
function decodePermissions(dict) {
  const p = get(dict, "P");
  if (!p || p.type !== "number") return null;
  const bits = p.value < 0 ? p.value >>> 0 : p.value;

  /* `[tableBit, key, labelEt]`, with tableBit as Table 23 writes it: 1-based from
     the least significant bit. */
  const flags = [
    [3, "print", "drukida"],
    [4, "modify", "muuta dokumenti"],
    [5, "copy", "teksti ja pilti kopeerida"],
    [6, "annotate", "märkmeid lisada ja muuta"],
    [9, "fillForms", "vormivälju täita"],
    [10, "extractForAccessibility", "teksti välja võtta abivahenditeks"],
    [11, "assemble", "lehekülgi ühendada ja järjestada"],
    [12, "printHighRes", "kõrglahutusega printida"],
  ];

  return {
    raw: p.value,
    unsigned: bits,
    items: flags.map(([tableBit, key, labelEt]) => ({
      key,
      labelEt,
      allowed: ((bits >>> (tableBit - 1)) & 1) === 1,
    })),
    reservedBitsValid: ((bits >>> 6) & 1) === 1 && ((bits >>> 7) & 1) === 1,
  };
}

function nameOf(value) {
  return value?.type === "name" ? value.name : null;
}

/* -- Revision comparison ------------------------------------------------------
   Section 5.2 asks for the Info dictionary of each revision so the interface
   can show what changed and when. The comparison is textual and deliberately
   so: two revisions disagreeing about a *decoded* value is a weaker statement
   than two revisions disagreeing about the *bytes*, and the bytes are what the
   file actually says. */

async function compareRevisions(fileBytes, source, revisions, limits, clock, notes) {
  if (revisions.length < 2) return { available: false, reason: "ainult üks versioon" };

  /* Each revision's Info is read against **that revision's table alone**.
   *
   * `locateObject` searches newest-first, which is right for "what does this file
   * say now" and exactly wrong here: asking for revision 2's Info with the full
   * chain in scope resolves object 2 to the offset in revision 1's table — the
   * *newer* definition — so both revisions reported the same values and the
   * comparison found nothing to compare. The very thing being looked for is the
   * change, and the search order hid it.

   * Scoping the search to one revision is what makes each row mean "what this
   * revision said", which is the only reading under which a difference is
   * evidence of an edit. */
  const perRevision = [];
  for (const revision of revisions) {
    const info = await readInfo(fileBytes, source, revision, [revision], limits, clock, notes);
    perRevision.push({ index: revision.index, info });
  }

  const newest = perRevision[0]?.info;
  if (!newest?.present) {
    return { available: false, reason: "praeguse versiooni Infodiktsiooni ei saanud lugeda" };
  }

  const changes = [];
  for (const older of perRevision.slice(1)) {
    if (!older.info.present) continue;
    for (const field of newest.fields) {
      const before = older.info.fields.find((f) => f.key === field.key);
      if (!before) {
        changes.push({ key: field.key, kind: "added", to: field.text, fromRevision: older.index });
      } else if (before.raw !== field.raw) {
        changes.push({
          key: field.key,
          kind: "changed",
          from: before.text,
          to: field.text,
          fromRevision: older.index,
        });
      }
    }
    for (const field of older.info.fields) {
      if (!newest.fields.some((f) => f.key === field.key)) {
        changes.push({ key: field.key, kind: "removed", from: field.text, fromRevision: older.index });
      }
    }
  }

  return { available: true, changes, revisionCount: revisions.length };
}

/* -- Repair mode --------------------------------------------------------------
   Section 5.2: when `startxref` is wrong or the table is inconsistent, scan the
   whole file for `N G obj`, rebuild the object map from that, and mark every
   affected number as *parandatud*. Real files with bad xrefs are the main
   forensic case, and this is what the hand-written parser is actually for.

   The word doing the work is "mark". A repaired offset is not the file's claim
   about itself; it is this module's inference, and section 11 requires the
   interface to say which is which. Nothing here writes a file -- there is no
   export path, and the point of the page is that the file stays where it is. */

function repairScan(fileBytes, source, revisions, limits, clock) {
  const found = new Map();
  const conflicts = [];
  let scanned = 0;

  /* `N G obj` at a token boundary. The leading-whitespace requirement is what
     stops `13 0 obj` from also matching at offset 1 inside `113 0 obj` — a
     spurious match that would invent an object 1 and overwrite a real one. */
  const re = /(^|[\x00\t\n\f\r ])(\d+)[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+obj\b/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    scanned++;
    /* Group 1 is the boundary character, so the object number starts right
       after it. */
    const at = match.index + match[1].length;
    const num = Number(match[2]);
    if (!Number.isSafeInteger(num)) continue;
    if (found.has(num)) {
      /* A duplicate object number is the commonest sign of an incremental update
         written badly — and a finding in its own right, not an error to resolve
         silently. The *last* one wins, which is what a reader does. */
      conflicts.push({ num, first: found.get(num).offset, second: at });
      found.set(num, { offset: at, gen: Number(match[3]) });
      continue;
    }
    found.set(num, { offset: at, gen: Number(match[3]) });
    if (found.size > limits.maxObjects) break;
    if (clock.expired()) break;
  }
  void fileBytes;

  /* Compare with what the table claimed. The difference is what "repaired"
     means: not that a scan happened, but that these specific objects moved,
     were duplicated, or were missing. */
  const declared = new Map();
  for (const revision of revisions) {
    for (const [num, entry] of revision.entries) {
      if (!entry.free && entry.compressedIn == null && !declared.has(num)) {
        declared.set(num, entry.offset);
      }
    }
  }

  const changed = [];
  const missingFromScan = [];
  for (const [num, offset] of declared) {
    if (!found.has(num)) missingFromScan.push(num);
    else if (found.get(num).offset !== offset) changed.push({ num, declared: offset, found: found.get(num).offset });
  }
  const absentFromTable = [];
  for (const num of found.keys()) {
    if (!declared.has(num)) absentFromTable.push(num);
  }

  return {
    available: true,
    scanned,
    objectCount: found.size,
    objects: found,
    conflicts,
    changed,
    missingFromScan,
    absentFromTable,
    tableBroken: declared.size === 0 || missingFromScan.length > 0 || changed.length > 0,
  };
}

/** The XMP packet, raw.
 *
 *  A packet normally lives in a metadata stream, which is compressed — so the
 *  bytes are not readable without decoding, and decoding is phase 6. But the
 *  packet's delimiters are also frequently present uncompressed in the file, and
 *  where they are, the raw packet can be shown now. The search is for
 *  `<?xpacket begin`, which is what §7.5.2's wrapper looks like, and the packet
 *  ends at the matching `<?xpacket end` or `</x:xmpmeta>`. */
function readXmp(source) {
  const beginAt = source.indexOf("<?xpacket begin");
  if (beginAt === -1) {
    return { present: false, reason: "pakett ei leitud toorandmetest" };
  }

  const endAt = source.indexOf("<?xpacket end", beginAt);
  const metaEnd = source.indexOf("</x:xmpmeta>", beginAt);
  /* The packet's own delimiter is `<?xpacket end`, and that is what bounds it.
     `</x:xmpmeta>` is the end of the metadata *inside* the wrapper, so treating
     it as the end drops the closing `<?xpacket end="w"?>` — the line that says
     the packet is complete rather than cut short, which is the single most
     useful thing about it. It is used only when the real terminator is missing,
     which means the packet was truncated by the file itself. */
  const stop = endAt !== -1 ? endAt : metaEnd !== -1 ? metaEnd : source.length;
  const terminator = endAt !== -1 ? "xpacket" : metaEnd !== -1 ? "xmpmeta" : null;

  return {
    present: true,
    offset: beginAt,
    length: stop - beginAt,
    raw: source.slice(beginAt, stop),
    terminator,
    truncated: stop === source.length,
  };
}

/** A value as the visitor reads it before phase 6 decodes it properly. */
function valueText(value) {
  switch (value.type) {
    case "string": return value.text;
    case "name": return `/${value.name}`;
    case "number": return String(value.value);
    case "boolean": return value.value ? "true" : "false";
    case "ref": return `${value.num} ${value.gen} R`;
    case "array": return `[${value.items.map(valueText).join(" ")}]`;
    case "dict": return "<<…>>";
    case "null": return "null";
    default: return value.raw ?? "";
  }
}

/* ── Object location ───────────────────────────────────────────────────────── */

/** Read `N G obj` at an offset and say where the object's body starts.
 *
 *  `ok` false means there is no object header there at all. `body` is the offset
 *  of the value itself, which for a dictionary is the `<<`. */
function readObjectHeader(source, offset) {
  const slice = source.slice(offset, offset + 64);
  const m = slice.match(/^\s*(\d+)\s+(\d+)\s+obj/);
  if (!m) return { ok: false, num: null, gen: null, body: offset };
  return {
    ok: true,
    num: Number(m[1]),
    gen: Number(m[2]),
    body: offset + m[0].length,
  };
}

/** Find the byte offset of an object, searching the newest revision first.
 *
 *  The newest table that mentions an object wins, because that is the revision a
 *  reader would open: an incremental update replaces an object by saying so in
 *  its own table. This is why the chain is walked newest-first and why the
 *  entries map is searched in order rather than merged. */
async function locateObject(fileBytes, source, num, gen, revisions, limits, clock, notes) {
  for (const revision of revisions) {
    const entry = revision.entries.get(num);
    if (!entry || entry.free) continue;
    /* The generation must match where one is known. A mismatch means the table
       points at a superseded generation of the object, which is a finding and
       not a match. */
    if (gen != null && !entry.compressedIn && entry.gen !== gen) continue;

    if (entry.compressedIn != null) {
      /* The object lives inside an object stream, so its byte offset comes from
         that stream's own index rather than from the table. */
      const header = locateDirectOffset(source, entry.compressedIn, revisions);
      if (header === null) continue;
      const packed = await readObjectStream(fileBytes, header, { source, limits, clock, notes });
      if (packed?.has(num)) return { packed: packed.get(num).value, stream: entry.compressedIn };
      continue;
    }
    if (entry.offset == null) continue;
    return { offset: entry.offset };
  }
  return null;
}

/** The byte offset of an object that is stored directly in the file, used to
 *  find an object stream's own header. */
function locateDirectOffset(source, num, revisions) {
  for (const revision of revisions) {
    const entry = revision.entries.get(num);
    if (entry && !entry.free && entry.compressedIn == null && entry.offset != null) {
      return entry.offset;
    }
  }
  return null;
}

/* ── Small helpers ─────────────────────────────────────────────────────────── */

/** The file as one latin1 string: byte-per-character, so a byte offset in the
 *  string is the same number as a byte offset in the file, which every offset in
 *  this module depends on. `TextDecoder("utf-8")` would be wrong twice over —
 *  it would corrupt bytes above 0x7f and it would report *characters*, not
 *  positions. */
function latin1(bytes) {
  let out = "";
  /* Chunked so a large file does not build one enormous intermediate array. */
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return out;
}

function skipWs(source, pos) {
  while (pos < source.length) {
    const ch = source.charCodeAt(pos);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0x00 || ch === 0x0c) {
      pos++;
    } else {
      break;
    }
  }
  return pos;
}

/** A value as a number, or null. A `/Prev` written as a reference is a malformed
 *  file; treating it as absent and saying so beats carrying a bogus offset. */
function intOf(value) {
  if (!value) return null;
  if (value.type === "number" && Number.isSafeInteger(value.value)) return value.value;
  return null;
}

/** Drop the Map and the lexer objects before the result leaves the scanner.
 *
 *  They are useful inside this module and useless outside it: a Map cannot be
 *  JSON-serialised, the page has no use for them, and handing out the raw
 *  trailer object would let a caller mutate the scan's own state. */
function stripForOutput(revision) {
  const { trailerObj, entries, ...rest } = revision;
  void trailerObj;
  return {
    ...rest,
    objectCount: entries.size,
    entries: [...entries.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([num, entry]) => ({ num, ...entry, next: undefined })),
  };
}