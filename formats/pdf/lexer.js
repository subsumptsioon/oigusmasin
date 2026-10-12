// ── formats/pdf/lexer.js ───────────────────────────────────────────────────────
// PDF object syntax: dictionaries, arrays, names, strings, numbers, references.
//
// Phase 5 needs this for exactly three things — the trailer, the Info dictionary
// and the catalog — so it is deliberately small. It is not a general parser:
//
//   * it does not resolve indirect references. That is the scanner's job, and
//     only the scanner knows the xref; asking the lexer for object 5 here would
//     mean parsing the whole file twice.
//   * it decodes nothing but PDF string escapes. UTF-16BE, PDFDocEncoding and
//     date conversion are phase 6, and until then a value is a string plus the
//     bytes it was made of.
//   * it stops at a token it does not understand instead of guessing. A
//     half-parsed trailer that is reported as such is worth more than a
//     confident wrong one, because §11 says a repaired number must be labelled
//     repaired and a guessed one cannot be.
//
// Two invariants every entry point keeps:
//
//   * Nothing runs without a bound. Every loop consults `limits` and `clock`,
//     because the input is a file a stranger chose.
//   * Nothing loses its raw form. Each value reports its type, and strings
//     report both the decoded characters and the flag saying whether the file
//     wrote them as a literal `(...)` or a hex `<...>`. Phase 6 needs that
//     distinction to be right about encoding.
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from "../contract.js";

/** Whitespace per §7.2. NUL included: it is explicitly a whitespace character in
 *  PDF, and it is also the byte that pads out a binary comment line, so files
 *  contain plenty of it. */
const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/** Delimiters per §7.2. Anything that ends a token. */
const DELIMITER = new Set([
  0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20,
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
]);

/** Thrown for input that cannot be parsed at all. Callers catch it and report a
 *  readable reason; it never escapes to the page. */
export class LexError extends Error {
  constructor(message, offset) {
    super(message);
    this.offset = offset;
  }
}

/* ── Cursor ──────────────────────────────────────────────────────────────────
   A single object rather than a position passed through every return value. The
   recursion in `parseValue` would otherwise carry `pos` in and `pos` out of five
   different shapes, and one missed update means an infinite loop rather than a
   wrong answer. */

function cursor(source, limits = LIMITS, clock = { expired: () => false }) {
  return { src: source, pos: 0, limits, clock };
}

/** The cost of one iteration, checked where an unbounded loop could live. */
function budget(ctx, cost = 1) {
  ctx.used = (ctx.used ?? 0) + cost;
  if (ctx.used > ctx.limits.maxObjects) {
    throw new LexError("objektide arv ületab piiri", ctx.pos);
  }
  if (ctx.clock.expired()) {
    throw new LexError("analüüsi ajapiir ületatud", ctx.pos);
  }
}

/* ── Lexical helpers ──────────────────────────────────────────────────────── */

function isWhitespace(ch) {
  return WHITESPACE.has(ch);
}

function isDelimiter(ch) {
  return DELIMITER.has(ch);
}

function isRegular(ch) {
  return !isWhitespace(ch) && !isDelimiter(ch);
}

/** Skip whitespace and comments.
 *
 *  Comments are `%` to end of line. A `%%EOF` inside a dictionary would
 *  otherwise be read as a comment swallowing the rest of the trailer, so this
 *  runs everywhere a value may start. */
function skipSpace(ctx) {
  while (ctx.pos < ctx.src.length) {
    const ch = ctx.src.charCodeAt(ctx.pos);
    if (isWhitespace(ch)) {
      ctx.pos++;
    } else if (ch === 0x25) {
      // % comment to end of line. A stray CR does not end a comment; §7.2.4
      // says an end-of-line marker, and a bare CR inside one is data.
      while (ctx.pos < ctx.src.length) {
        const c = ctx.src.charCodeAt(ctx.pos);
        if (c === 0x0a || c === 0x0d) break;
        ctx.pos++;
      }
    } else {
      return;
    }
  }
}

/** Skip whitespace only. Used where a comment is not legal, i.e. inside the run
 *  of digits after `startxref`, where a comment would mean the file is not the
 *  shape it claims to be. */
function skipWhitespace(ctx) {
  while (ctx.pos < ctx.src.length && isWhitespace(ctx.src.charCodeAt(ctx.pos))) {
    ctx.pos++;
  }
}

/* ── Tokens ───────────────────────────────────────────────────────────────── */

const TOKEN_END = /[\x00\t\n\f\r ()<>\[\]{}\/%]/;

/** Read a regular-character run: a number, a keyword, `true`, `false`, `null`,
 *  or the `R` of a reference. */
function readRegular(ctx) {
  const start = ctx.pos;
  while (ctx.pos < ctx.src.length && !TOKEN_END.test(ctx.src[ctx.pos])) {
    ctx.pos++;
  }
  return ctx.src.slice(start, ctx.pos);
}

/** Read a `/Name`.
 *
 *  §7.3.5 gives `#` as the escape for any byte outside the regular set, so a
 *  name is stored as its bytes and decoded once, here. Names are the only place
 *  where a slash can be part of the data rather than the syntax, and getting
 *  this wrong would make `/A#20B` and `/A B` look like two different keys. */
function readName(ctx) {
  const start = ctx.pos;
  ctx.pos++; // the slash
  let out = "";
  while (ctx.pos < ctx.src.length) {
    const ch = ctx.src[ctx.pos];
    /* charCodeAt, not the character: WHITESPACE and DELIMITER hold byte codes,
       and handing them a one-character string makes every test return false. That
       failure is silent and total — the name swallows the rest of the file — so
       the two are kept as separate bindings rather than one, which is how this
       bug happened once already. */
    if (!isRegular(ctx.src.charCodeAt(ctx.pos))) break;
    if (ch === "#") {
      const hex = ctx.src.slice(ctx.pos + 1, ctx.pos + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        ctx.pos += 3;
        continue;
      }
      // A `#` that is not followed by two hex digits is literal, per §7.3.5.
    }
    out += ch;
    ctx.pos++;
  }
  if (out === "") {
    // A lone `/` is not a name. Producers emit one as a placeholder for a value
    // they declined to write, and treating it as the empty name would collide
    // with every other such placeholder.
    return { type: "badname", raw: ctx.src.slice(start, ctx.pos) };
  }
  return { type: "name", name: out, raw: ctx.src.slice(start, ctx.pos) };
}

/** Read a literal string `(...)`, decoding only the escapes §7.3.4.2 defines.
 *
 *  Balanced parentheses: an unescaped `(` inside a string is literal, which is
 *  why this counts depth rather than stopping at the first `)`. A file with an
 *  unbalanced one is malformed, and the depth cap is what stops a crafted file
 *  from making this loop for minutes. */
function readLiteralString(ctx) {
  ctx.pos++; // the opening paren
  let out = "";
  // Parens nest, and an unescaped `(` inside a string is literal. So the loop
  // counts depth rather than stopping at the first `)`: a date like
  // `(D:2024(01)01)` would otherwise end at the first closing paren it meets.
  let depth = 1;
  while (ctx.pos < ctx.src.length) {
    budget(ctx);
    const ch = ctx.src[ctx.pos];
    if (ch === "\\") {
      ctx.pos++;
      const esc = ctx.src[ctx.pos];
      switch (esc) {
        case "n": out += "\n"; ctx.pos++; break;
        case "r": out += "\r"; ctx.pos++; break;
        case "t": out += "\t"; ctx.pos++; break;
        case "b": out += "\b"; ctx.pos++; break;
        case "f": out += "\f"; ctx.pos++; break;
        case "(": out += "("; ctx.pos++; break;
        case ")": out += ")"; ctx.pos++; break;
        case "\\": out += "\\"; ctx.pos++; break;
        case "\r":
          // Line continuation: the backslash-newline is removed along with the
          // newline. §7.3.4.2 treats CR and CRLF as one end-of-line here.
          ctx.pos++;
          if (ctx.src[ctx.pos] === "\n") ctx.pos++;
          break;
        case "\n":
          ctx.pos++;
          break;
        default: {
          const octal = /^[0-7]{1,3}/.exec(ctx.src.slice(ctx.pos, ctx.pos + 3));
          if (octal) {
            out += String.fromCharCode(parseInt(octal[0], 8) & 0xff);
            ctx.pos += octal[0].length;
          } else {
            // §7.3.4.2 says an unknown escape drops the backslash. That is what
            // `\q` means, not a syntax error.
            out += esc ?? "";
            ctx.pos++;
          }
        }
      }
      continue;
    }
    if (ch === "(") {
      depth++;
      out += ch;
      ctx.pos++;
      continue;
    }
    if (ch === ")") {
      depth--;
      ctx.pos++;
      if (depth === 0) return out;
      out += ch;
      continue;
    }
    out += ch;
    ctx.pos++;
  }
  // Unterminated. Returning what was read is better than discarding the whole
  // dictionary: a truncated file is exactly what phase 5 is meant to survive.
  return out;
}

/** Read a hex string `<...>`. An odd digit count is padded with a trailing zero
 *  per §7.3.4.3, which is a real behaviour of real files and not an error. */
function readHexString(ctx) {
  const start = ctx.pos;
  ctx.pos++; // the opening angle bracket
  let hex = "";
  while (ctx.pos < ctx.src.length) {
    const ch = ctx.src[ctx.pos];
    if (ch === ">") {
      ctx.pos++;
      break;
    }
    if (/[0-9A-Fa-f]/.test(ch)) hex += ch;
    ctx.pos++;
  }
  if (hex.length % 2 === 1) hex += "0";
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return { text: out, raw: ctx.src.slice(start, ctx.pos) };
}

/* ── Values ───────────────────────────────────────────────────────────────── */

/** One value at `ctx.pos`.
 *
 *  Numbers are the one place a lookahead happens, because `12 0 R` is three
 *  tokens that mean one reference. The lookahead is bounded and non-destructive:
 *  if it does not match, the cursor is put back and the integer stands alone. */
export function parseValue(ctx, depth = 0) {
  if (depth > ctx.limits.maxDepth) {
    throw new LexError("südamiku sügavus ületab piiri", ctx.pos);
  }
  budget(ctx);
  skipSpace(ctx);
  if (ctx.pos >= ctx.src.length) {
    return { type: "eof", raw: "" };
  }

  const ch = ctx.src[ctx.pos];

  if (ch === "/") return readName(ctx);

if (ch === "(") {
    const start = ctx.pos;
    const text = readLiteralString(ctx);
    return { type: "string", text, hex: false, raw: ctx.src.slice(start, ctx.pos) };
  }

  if (ch === "<") {
    if (ctx.src[ctx.pos + 1] === "<") return parseDictionary(ctx, depth);
    const hex = readHexString(ctx);
    return { type: "string", text: hex.text, hex: true, raw: hex.raw };
  }

  if (ch === "[") return parseArray(ctx, depth);

  if (ch === "]" || ch === ">" || ch === "}") {
    // A closing delimiter where a value was expected. Reported rather than
    // skipped: it means the dictionary is unbalanced, and the caller decides
    // whether that is worth continuing past.
    return { type: "unexpected", raw: ch };
  }

  if (ch === "{") {
    // PostScript calculator function body. §7.3.10 puts it in a dictionary but
    // it is not a PDF object; consuming it as an opaque run keeps the keys
    // around it readable instead of losing the dictionary to the braces.
    const start = ctx.pos;
    let level = 0;
    while (ctx.pos < ctx.src.length) {
      const c = ctx.src[ctx.pos];
      if (c === "{" || c === "(") level++;
      else if (c === "}" || c === ")") {
        level--;
        if (level === 0) {
          ctx.pos++;
          break;
        }
      }
      ctx.pos++;
    }
    return { type: "function", raw: ctx.src.slice(start, ctx.pos) };
  }

  const regular = readRegular(ctx);
  if (regular === "true") return { type: "boolean", value: true, raw: regular };
  if (regular === "false") return { type: "boolean", value: false, raw: regular };
  if (regular === "null") return { type: "null", raw: regular };

  const number = parseNumber(regular);
  if (number === null) {
    return { type: "keyword", raw: regular };
  }

  const ref = maybeReference(ctx, number, regular);
  return ref ?? { type: "number", value: number, raw: regular };
}

/** PDF numbers are not JavaScript numbers: `4.` and `-.002` and `34.5` are all
 *  legal, and so is `--5` from a broken producer, which this reads as the
 *  keyword it really is. */
function parseNumber(text) {
  if (!/^[+-]?(\d+\.?\d*|\.\d+|\d*\.\d*)$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** `int int R` is a reference. Anything else leaves the cursor untouched and
 *  returns null, so `12 0` stays two integers — which is what an array of two
 *  numbers really is. */
function maybeReference(ctx, first, firstRaw) {
  const mark = ctx.pos;
  skipWhitespace(ctx);
  const secondRaw = readRegular(ctx);
  if (secondRaw === "" || !/^\d+$/.test(secondRaw)) {
    ctx.pos = mark;
    return null;
  }
  skipWhitespace(ctx);
  const thirdRaw = readRegular(ctx);
  if (thirdRaw === "R" && Number.isInteger(first) && first >= 0) {
    return { type: "ref", num: first, gen: Number(secondRaw), raw: `${firstRaw} ${secondRaw} R` };
  }
  ctx.pos = mark;
  return null;
}

/** `[...]`. Elements keep their order because some of them matter: `/ID` is a
 *  pair, and a viewer that reversed it would show two different values as one. */
function parseArray(ctx, depth) {
  ctx.pos++; // [
  const items = [];
  for (;;) {
    budget(ctx);
    skipSpace(ctx);
    if (ctx.pos >= ctx.src.length) break;
    if (ctx.src[ctx.pos] === "]") {
      ctx.pos++;
      break;
    }
    const before = ctx.pos;
    const value = parseValue(ctx, depth + 1);
    if (value.type === "eof" || value.type === "unexpected") break;
    items.push(value);
    // No forward progress means a construct this parser does not understand.
    // Stop rather than spin; the caller sees the short array and says so.
    if (ctx.pos === before) break;
  }
  return { type: "array", items };
}

/** `<<...>>`, plus the `stream` keyword and its payload when one follows.
 *
 *  Duplicate keys are kept as separate entries rather than collapsed. §7.3.10
 *  says the last one wins, but a file carrying two `/Author` keys is itself a
 *  finding, and collapsing them here would hide it. `toObject` applies the rule
 *  for callers that want the ordinary answer. */
function parseDictionary(ctx, depth) {
  const start = ctx.pos;
  ctx.pos += 2; // <<
  const entries = [];
  for (;;) {
    budget(ctx);
    skipSpace(ctx);
    if (ctx.pos >= ctx.src.length) break;
    if (ctx.src[ctx.pos] === ">" && ctx.src[ctx.pos + 1] === ">") {
      ctx.pos += 2;
      break;
    }
    if (ctx.src[ctx.pos] !== "/") {
      // A key must be a name. Anything else means the dictionary is malformed;
      // stop here so the entries already read are still returned.
      const junk = parseValue(ctx, depth + 1);
      if (junk.type === "eof" || ctx.pos === ctx.pos) break;
      if (junk.type === "unexpected") break;
      continue;
    }
    const key = readName(ctx);
    const value = parseValue(ctx, depth + 1);
    entries.push({ key: key.name ?? key.raw, value, keyRaw: key.raw });
    if (value.type === "eof") break;
  }

  const dict = { type: "dict", entries, raw: ctx.src.slice(start, ctx.pos) };
  const afterDict = ctx.pos;
  skipSpace(ctx);
  if (ctx.src.startsWith("stream", ctx.pos)) {
    const stream = readStreamPayload(ctx);
    if (stream) dict.stream = stream;
  } else {
    ctx.pos = afterDict;
  }
  return dict;
}

/** The bytes of a stream object, from after the `stream` keyword's end-of-line
 *  marker to `endstream`.
 *
 *  §7.3.8.1 is exact about this and files are routinely wrong: the keyword may
 *  be followed by CRLF, LF or nothing at all, and `endstream` may be preceded by
 *  whitespace that is not part of the data. The length comes from `/Length`
 *  when it is a direct integer, but that value is untrusted, so the end is found
 *  by searching and the declared length is only used as a hint to start from. */
function readStreamPayload(ctx) {
  const keywordEnd = ctx.pos + "stream".length;
  ctx.pos = keywordEnd;
  // An end-of-line marker is required, CRLF counting as one.
  if (ctx.src[ctx.pos] === "\r") ctx.pos++;
  if (ctx.src[ctx.pos] === "\n") ctx.pos++;
  else if (ctx.src[ctx.pos] === "\r") {
    // A bare CR also ends the keyword. Already consumed above.
  }
  const dataStart = ctx.pos;

  const end = ctx.src.indexOf("endstream", dataStart);
  if (end === -1) {
    // No terminator: the file is truncated. Everything from the keyword on is
    // the data, which is what a truncated file actually holds.
    const endPos = ctx.src.length;
    ctx.pos = endPos;
    return { start: dataStart, end: endPos, truncated: true };
  }
  // Trim the whitespace before `endstream`; §7.3.8.1 says it is not data.
  let dataEnd = end;
  while (dataEnd > dataStart && isWhitespace(ctx.src.charCodeAt(dataEnd - 1))) {
    dataEnd--;
  }
  ctx.pos = end + "endstream".length;
  return { start: dataStart, end: dataEnd, truncated: false };
}

/* ── The public shape ──────────────────────────────────────────────────────── */

/** A dictionary as a plain object, for callers that want the ordinary answer.
 *  Last duplicate wins, per §7.3.10. Use `entries` when the duplicates matter. */
export function toObject(dict) {
  const out = {};
  if (!dict || dict.type !== "dict") return out;
  for (const e of dict.entries) out[e.key] = e.value;
  return out;
}

/** The first value for a key, or null. Named separately from `toObject` so a
 *  caller that wants the *first* of a duplicated pair says so. */
export function get(dict, key) {
  if (!dict || dict.type !== "dict") return null;
  for (const e of dict.entries) {
    if (e.key === key) return e.value;
  }
  return null;
}

/** All values for a key. The difference between this and `get` is the whole of
 *  what a duplicate-key finding is. */
export function getAll(dict, key) {
  if (!dict || dict.type !== "dict") return [];
  return dict.entries.filter((e) => e.key === key).map((e) => e.value);
}

/** Parse one value at a position. The entry point every caller uses; the `ctx`
 *  is built here so no caller has to. */
export function parseAt(source, offset = 0, limits, clock) {
  const ctx = cursor(source, limits, clock);
  ctx.pos = offset;
  const value = parseValue(ctx);
  return { value, end: ctx.pos };
}

/** Parse a whole dictionary starting at `offset`, for the trailer and the Info
 *  dictionary, where the caller knows the offset and wants the object. */
export function parseDictAt(source, offset, limits, clock) {
  const ctx = cursor(source, limits, clock);
  ctx.pos = offset;
  skipSpace(ctx);
  if (!ctx.src.startsWith("<<", ctx.pos)) {
    return { dict: null, end: ctx.pos };
  }
  return { dict: parseDictionary(ctx, 0), end: ctx.pos };
}