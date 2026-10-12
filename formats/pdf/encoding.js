// ── formats/pdf/encoding.js ───────────────────────────────────────────────────
// Turning PDF bytes into text a person reads, and PDF dates into dates.
//
// Two things live here and both are places where a file lies quietly:
//
//   1. **String decoding.** A PDF string is not text. It is bytes, and which
//      text they are depends on how the file wrote them — a BOM, the
//      `/Encoding` on a font, or the absence of either. Guessing produces
//      mojibake that looks like a finding, so every result carries how it was
//      read.
//
//   2. **Date conversion.** `D:20240315103000+02'00'` is a date, an offset and a
//      set of producer bugs in one string. §5.2 asks for the original beside the
//      converted value and for the common bug of writing local time with a `Z` to
//      be flagged — because that bug is a *finding about the producer*, and a
//      silent "fix" would destroy it.
//
// Nothing here renders. A Date goes back as a Date and the page formats it
// (§4.3 keeps formatting out of analysers), and the raw string always travels
// alongside.
// ─────────────────────────────────────────────────────────────────────────────

/* ── PDFDocEncoding ─────────────────────────────────────────────────────────
   §7.9.6.2, Annex D. It is not Latin-1: the low range agrees with ASCII except
   that the quotes, accented letters and currency signs sit in 0x18–0x1F and
   0x80–0x9F where Latin-1 has control characters. Those twenty-odd slots are why
   this table exists at all, and why `TextDecoder("latin1")` — the obvious
   one-liner — is wrong for exactly the characters a reader most wants to see. */

const PDF_DOC = new Map();

(function buildPdfDocEncoding() {
  for (let i = 0x20; i <= 0x7e; i++) PDF_DOC.set(i, String.fromCharCode(i));
  PDF_DOC.set(0x09, "\t");
  PDF_DOC.set(0x0a, "\n");
  PDF_DOC.set(0x0d, "\r");

  /* The accented range. These are the mappings that differ from Latin-1 and the
     reason the whole table is here rather than a TextDecoder. */
  const accents = {
    0x18: "˘", 0x19: "ˇ", 0x1a: "ˆ", 0x1b: "˙", 0x1c: "˝", 0x1d: "˛",
    0x1e: "˚", 0x1f: "˜",
    0x80: "•", 0x81: "†", 0x82: "‡", 0x83: "…", 0x84: "—",
    0x85: "–", 0x86: "ƒ", 0x87: "⁄", 0x88: "‹", 0x89: "›",
    0x8a: "−", 0x8b: "‰", 0x8c: "„", 0x8d: "“", 0x8e: "”",
    0x8f: "‘", 0x90: "’", 0x91: "‚", 0x92: "™", 0x93: "ﬁ",
    0x94: "ﬂ", 0x95: "Ł", 0x96: "Œ", 0x97: "Š", 0x98: "Ÿ",
    0x99: "Ž", 0x9a: "ı", 0x9b: "ł", 0x9c: "œ", 0x9d: "š",
    0x9e: "ž",
    /* 0x9F is deliberately absent. Ghostscript's PDFDocEncoding — the reference
       this table was checked against — defines it as .notdef, and mapping it to
       `ſ` (which is what a guess would produce, since 0xDF is `ſ` in Latin-1) is
       exactly the kind of confident wrong character §11 warns about. It falls
       through to U+FFFD below. */
    0xa0: "€",
  };
  for (const [code, char] of Object.entries(accents)) {
    PDF_DOC.set(Number(code), char);
  }

  /* Latin letters with diacritics live in 0xC0–0xFF, and there they agree with
     Latin-1 — so the table is filled from there rather than 256 lines of source. */
  for (let i = 0xc0; i <= 0xff; i++) PDF_DOC.set(i, String.fromCharCode(i));
})();

/* ── String decoding ──────────────────────────────────────────────────────── */

/** Decode a PDF string, saying how it was read.
 *
 *  @param {Uint8Array} bytes
 *  @param {{encoding?: string}} [opts] `/UTF-16` or a font `/Encoding` name
 *  @returns {{text: string, source: string, note?: string}}
 *
 *  The three cases, in the order §7.9.2.2 puts them:
 *
 *   1. A `FE FF` BOM says UTF-16BE outright. That is the only reliable signal.
 *   2. `/UTF-16LE` without a BOM, which some producers write.
 *   3. Otherwise PDFDocEncoding — with the BOM still taking priority, because a
 *      file that declares `/UTF-16` and writes a BOM means both.
 *
 *  `source` names the branch taken, and the page shows it. A name like
 *  "Muu tekst" (PDFDocEncoding) sitting next to "Küsimus: kas fail on UTF-16?"
 *  is the honest report; a clean string that is silently Latin-1 is not. */
export function decodeString(bytes, opts = {}) {
  const declared = (opts.encoding ?? "").replace(/^\//, "");

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      text: decodeUtf16(bytes.subarray(2), true),
      source: "UTF-16BE (BOM)",
      note: "BOM järgi on tekst UTF-16BE.",
    };
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    /* A little-endian BOM in a format that expects big-endian. Real files do
       this. §7.9.2.2 has nothing to say about it, so it is decoded as written
       and flagged rather than silently corrected. */
    return {
      text: decodeUtf16(bytes.subarray(2), false),
      source: "UTF-16LE (BOM)",
      note: "Failis on UTF-16LE algustähis, kuigi PDF tähistab UTF-16BE-d.",
    };
  }

  if (declared === "UTF-16LE") {
    return { text: decodeUtf16(bytes, false), source: "UTF-16LE" };
  }

  if (declared === "UTF-16") {
    /* No BOM but declared UTF-16: the bytes are big-endian by default per
       §7.9.2.2. An odd trailing byte is a producer bug; `decodeUtf16` drops it
       rather than throwing, and the odd length is reported here. */
    const result = {
      text: decodeUtf16(bytes, true),
      source: "UTF-16BE",
    };
    if (bytes.length % 2 !== 0) {
      result.note = `Teksti pikkus ${bytes.length} B on paarisarvuline paaripaarisena; viimane bait jäi lugemata.`;
    }
    return result;
  }

  return { text: decodePdfDoc(bytes), source: "PDFDocEncoding" };
}

/** UTF-16 to a string.
 *
 *  `TextDecoder("utf-16be")` is available and correct, but it throws on an odd
 *  byte count and replaces lone surrogates silently. Doing it by hand keeps the
 *  odd-byte case a reportable fact rather than an exception, and lets a lone
 *  surrogate become U+FFFD visibly instead of vanishing. */
function decodeUtf16(bytes, bigEndian) {
  const usable = bytes.length - (bytes.length % 2);
  const units = new Uint16Array(usable / 2);
  for (let i = 0; i < usable; i += 2) {
    units[i / 2] = bigEndian
      ? (bytes[i] << 8) | bytes[i + 1]
      : (bytes[i + 1] << 8) | bytes[i];
  }
  let out = "";
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    /* A high surrogate not followed by a low one, or a low surrogate with no
       high before it, cannot be a character. U+FFFD says so on screen; dropping
       it silently would shorten a name without explaining why. */
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = units[i + 1];
      if (next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
        out += String.fromCharCode(unit, next);
        i++;
        continue;
      }
      out += "�";
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) out += "�";
    else out += String.fromCharCode(unit);
  }
  return out;
}

function decodePdfDoc(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes[i];
    const mapped = PDF_DOC.get(code);
    /* An unmapped byte is not dropped and is not guessed at. §7.9.2.2 says such
       a string is to be interpreted with the font's encoding, which is not
       available here; U+FFFD is the honest marker. */
    out += mapped ?? "�";
  }
  return out;
}

/** Bytes of a JavaScript string as latin1, for the reverse direction — turning a
 *  decoded string back into the bytes an `/Info` key holds. Needed to compare an
 *  Info value across revisions byte for byte rather than after a lossy decode. */
export function toBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/* ── Dates ────────────────────────────────────────────────────────────────── */

/** Parse a PDF date string.
 *
 *  `D:YYYYMMDDHHmmSSOHH'mm'` (§7.9.4), with almost every part optional. A file
 *  may write `D:2024`, `D:202403`, `D:20240315`, and each means a different
 *  thing about how precisely the producer knew the moment.
 *
 *  Three traps, all of which produce a wrong date rather than an error:
 *
 *   1. **Trailing digits after the seconds.** A producer writing `1234567` means
 *      fractional seconds; reading it as `SSmmm` gives a date 100 000 years out.
 *   2. **`Z` on local time.** §7.9.4.2 defines `Z` as UTC, but many producers
 *      write their *local* time and append `Z` anyway. The date is then wrong by
 *      the UTC offset — hours, not minutes. This is flagged, never corrected: the
 *      offset is unknown, and inventing one would hide the producer's bug, which
 *      is exactly the thing being examined.
 *   3. **No offset at all.** Local time with nothing to say what local means.
 *      Flagged as well, for the same reason.
 *
 *  @returns {{date: Date|null, precision: string, original: string, utc: boolean,
 *            offset: string|null, issues: string[], iso: string|null}} */
export function parseDate(raw) {
  const text = (raw ?? "").trim();
  const issues = [];

  if (!text.startsWith("D:")) {
    return { date: null, precision: "pole", original: raw ?? "", utc: false, offset: null, issues: [], iso: null };
  }

  let body = text.slice(2);

  /* Split the trailing offset off first. It has the most distinctive shape:
     +HH'mm' / -HH'mm' / +HH'mm / Z.

     Order matters here, and getting it wrong is invisible: §7.9.4.3 puts
     fractional seconds *after* the offset, so a string ending `+02'00'123` has
     the offset in the middle, not the end. The first draft anchored the offset
     pattern to the end of the string, failed to match, reported "no offset" and
     then read the offset's own digits as part of the seconds — a wrong date with
     a correct-looking ISO string attached.

     So: trailing digits are stripped first (they are fractional seconds), and
     only what remains is searched for the offset. */
  let trailingDigits = "";
  const fracMatch = /(\d+)$/.exec(body);
  if (fracMatch && fracMatch[1].length > 0) {
    const digitsSeen = fracMatch[1];
    /* Only digits that follow a complete date+offset are fractional. A bare
       `D:2024` ends in digits too, so the length is what distinguishes them:
       fractional seconds arrive after at least 14 digits of date. */
    const before = body.slice(0, body.length - digitsSeen.length);
    if (digitsSeen.length > 14 || (before.length >= 14 && /[+\-]/.test(before))) {
      trailingDigits = digitsSeen;
      body = before;
    }
  }

  let offsetPart = "";
  let digits = body;

  const zAt = body.indexOf("Z");
  if (zAt !== -1 && /^\d*$/.test(body.slice(0, zAt))) {
    digits = body.slice(0, zAt);
    offsetPart = "Z";
  } else {
    const signAt = body.search(/[+\-]/);
    /* Only treat a sign as an offset if digits follow it in the offset shape.
       A `-` elsewhere would be malformed anyway, and mistaking it for an offset
       would move the date to another century. */
    if (signAt !== -1 && /^[+\-]\d{2}'?\d{0,2}'?$/.test(body.slice(signAt))) {
      digits = body.slice(0, signAt);
      offsetPart = body.slice(signAt);
    }
  }

  let fractional = trailingDigits || null;

  const num = (at, len) => {
    const slice = digits.slice(at, at + len);
    return /^\d+$/.test(slice) && slice.length === len ? Number(slice) : null;
  };

  const year = num(0, 4);
  const month = num(4, 2);
  const day = num(6, 2);
  const hour = num(8, 2);
  const minute = num(10, 2);
  const second = num(12, 2);

  if (year === null) {
    return { date: null, precision: "pole", original: text, utc: false, offset: null, issues, iso: null };
  }

  /* §7.9.4.2: omitted components are *not* zero. A date of `D:2024` means "some
     time in 2024", not 1 January 1904. So precision is recorded and the missing
     parts are left at the start of the period, which is the one choice that
     cannot place the date outside its own range. */
  if (fractional) {
    issues.push("Murdosakundid on olemas, kuid teisenduses jäetakse need vahele.");
  }

  let precision = "aasta";
  if (month !== null) precision = "kuu";
  if (day !== null) precision = "päev";
  if (hour !== null) precision = "tund";
  if (minute !== null) precision = "minut";
  if (second !== null) precision = "sekund";

  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const y = pad(year, 4);
  const mo = month === null ? "01" : pad(month);
  const d = day === null ? "01" : pad(day);
  const h = hour === null ? "00" : pad(hour);
  const mi = minute === null ? "00" : pad(minute);
  const s = second === null ? "00" : pad(second);

  /* A month or day outside its range is a producer bug. `new Date` would roll
     20241301 over into the next year without complaint, which is the whole
     failure mode this check exists to catch. */
  if (month !== null && (month < 1 || month > 12)) {
    issues.push(`Kuu ${month} ei ole vahemikus 1–12; kuupäeva ei teisendata.`);
    return { date: null, precision, original: text, utc: false, offset: null, issues, iso: null };
  }
  if (day !== null && (day < 1 || day > daysInMonth(year, month))) {
    issues.push(`Päev ${day} ei ole kuus ${month} vahemikus 1–${daysInMonth(year, month)}; kuupäeva ei teisendata.`);
    return { date: null, precision, original: text, utc: false, offset: null, issues, iso: null };
  }
  if (hour !== null && hour > 23) issues.push("Tund on üle 23; tõlgendatakse valevahemikus.");
  if (minute !== null && minute > 59) issues.push("Minut on üle 59; tõlgendatakse valevahemikus.");

  const local = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  const utc = offsetPart === "Z";

  /* No offset: the string is local time and local is unknown. Constructing a
     Date without one makes the browser apply the *visitor's* timezone, so the
     displayed time would silently be the reader's, not the producer's. That is
     the wrong answer in a way nobody could detect, so no Date is produced and
     the raw string is shown instead. */
  if (offsetPart === "") {
    issues.push("Aeg Zone puudub; kellaaega ei saa üheselt määrata.");
    return { date: null, precision, original: text, utc: false, offset: null, issues, iso: local };
  }

  if (utc) {
    issues.push("Märgis Z tähendab ülesande järgi UTC-d, kuid paljud tootjad kirjutavad selle kohaliku ajaga.");
  }

  const iso = `${local}${utc ? "Z" : normaliseOffset(offsetPart)}`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    issues.push("Kuupäeva ei õnnestunud teisendada.");
    return { date: null, precision, original: text, utc, offset: offsetPart, issues, iso: null };
  }

  return {
    date: parsed,
    precision,
    original: text,
    utc,
    offset: offsetPart,
    issues,
    iso,
    fractionalSeconds: fractional,
  };
}

/** `+02'00'` → `+02:00`, because that is what `Date` and `toISOString` want. */
function normaliseOffset(part) {
  const m = /^([+\-])(\d{2})'?(\d{2})?'?$/.exec(part);
  if (!m) return "";
  return `${m[1]}${m[2]}:${m[3] ?? "00"}`;
}

function daysInMonth(year, month) {
  /* Day 0 of the next month is the last day of this one. */
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}