// ── rehkendaja-core.js ───────────────────────────────────────────────────────
// Pure detection and formatting logic.
// Shared between rehkendaja.html and rehkendaja-test.html.
// No DOM access. No side effects.
// ─────────────────────────────────────────────────────────────────────────────

// ── Unit mode ────────────────────────────────────────────────────────────────
let mode = "eur";

// ── Regex patterns (compact JS‑compatible versions) ──────────────────────────
// The three patterns are built from one shared number fragment rather than
// spelled out as literals. <num> appears in all four EURO alternatives and both
// GRAM ones, so a hand-written sign would have to be repeated seven times and
// would eventually drift out of one of them.

// A leading sign is part of the number. Both ASCII "-" and U+2212 MINUS SIGN
// are accepted: et-EE's Intl.NumberFormat emits U+2212, so the tool has to be
// able to read back its own output.
const NUM_SRC = String.raw`[-\u2212]?[0-9](?:[0-9 .,\u00A0]*[0-9])?`;

// An amount may not start in the middle of a word. `(?<!\d)` alone is not
// enough once a sign is in play: without this, the "-" in "COVID-19" would open
// a match and turn "COVID-19 EUR" into -19 €.
const NOT_AFTER_WORD = String.raw`(?<![\p{L}\p{N}])`;

// EURO — full expression highlight
const EURO_RE = new RegExp(
  String.raw`${NOT_AFTER_WORD}(?:€\s*(?<num>${NUM_SRC})|(?<num>${NUM_SRC})\s*€|(?<num>${NUM_SRC})\s*(?<word>eur|euro|eurot)\b|(?<word>eur|euro|eurot)\s*(?<num>${NUM_SRC}))`,
  "giu",
);

// GRAM — full expression highlight
// The second alternative deliberately omits the bare "g": a unit never precedes
// its number ("g 1.5" is not a weight), which is why "10g5g" is also not found.
const G_RE = new RegExp(
  String.raw`${NOT_AFTER_WORD}(?:(?<num>${NUM_SRC})\s*(?<unit>g\.?|gramm(?:i|ides)?|grammi|gramm|gram)\b|(?<unit>gramm(?:i|ides)?|grammi|gramm|gram)\b\s*(?<num>${NUM_SRC}))`,
  "giu",
);

// NUM — standalone numbers (excluding dates/times/case numbers)
// The date guards are sign-tolerant: without `-?` a date written as
// "-12.03.2024" would slip past them and be read as a negative amount.
const N_RE = new RegExp(
  String.raw`${NOT_AFTER_WORD}(?<![.\-/:])(?!(?:-?\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}))(?!(?:-?\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}))(?!(?:\d{1,2}:\d{2}))(?!(?:\d+-\d+\/\d+))(?<num>${NUM_SRC})`,
  "giu",
);

function activeRe() {
  let re;
  if (mode === "eur") re = EURO_RE;
  else if (mode === "g") re = G_RE;
  else if (mode === "n") re = N_RE;
  else re = N_RE;

  re.lastIndex = 0;
  return re;
}

// ── Parsing ───────────────────────────────────────────────────────────────────
function parseAmount(raw) {
  // U+2212 MINUS SIGN is what et-EE formatting emits, but parseFloat only
  // accepts an ASCII "-"; without this a negative amount would come back NaN
  // and be dropped from the result entirely.
  let s = raw.replace(/\u2212/g, "-").replace(/\s/g, "");
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  if (hasDot && hasComma) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    s = s.replace(",", ".");
  }

  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ── Decimal counting ──────────────────────────────────────────────────────────
function countDecimals(raw) {
  const s = raw.replace(/\s/g, "");
  const di = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (di === -1) return 0;
  return s.length - di - 1;
}

// ── Extraction ────────────────────────────────────────────────────────────────
function extractAmounts(text) {
  const re = activeRe();
  const results = [];
  let match;

  while ((match = re.exec(text)) !== null) {
    // EUR / G / N modes
    const rawNum = match.groups?.num;
    if (!rawNum) continue;

    const amount = parseAmount(rawNum);
    if (amount === null) continue;

    results.push({
      raw: match[0], // full expression
      amount,
      decimals: countDecimals(rawNum),
      index: match.index,
      matchLen: match[0].length,
    });
  }

  return results;
}

// ── Formatting ────────────────────────────────────────────────────────────────
// Cached Intl.NumberFormat instances — n.toLocaleString(locale, opts) builds a
// formatter on every call; reusing one (or one per variable-decimal bucket) is
// much cheaper and produces byte-identical output.
const _fmtEur = new Intl.NumberFormat("et-EE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const _fmtVarCache = {};
function _fmtVarFor(d) {
  let f = _fmtVarCache[d];
  if (!f) {
    f = _fmtVarCache[d] = new Intl.NumberFormat("et-EE", {
      minimumFractionDigits: 0,
      maximumFractionDigits: d,
    });
  }
  return f;
}

function _formatNumber(n, decimals) {
  if (mode === "eur") return _fmtEur.format(n);
  const d = decimals !== undefined ? Math.min(decimals, 10) : 10;
  return _fmtVarFor(d).format(n);
}

function formatValue(n, decimals) {
  const s = _formatNumber(n, decimals);
  // Non-breaking space between the amount and the € so the pair stays on one
  // line when pasted into a word processor (e.g. Word).
  if (mode === "eur") return s + "\u00A0\u20ac";
  if (mode === "g") return s + "\u00A0g";
  return s;
}

function unitShort() {
  if (mode === "eur") return "€";
  if (mode === "g") return "g";
  return "";
}

function formatNumeric(n, decimals) {
  return _formatNumber(n, decimals);
}
