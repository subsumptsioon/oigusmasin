// ── rehkendaja-core.js ───────────────────────────────────────────────────────
// Pure detection and formatting logic.
// Shared between rehkendaja.html and rehkendaja-test.html.
// No DOM access. No side effects.
// ─────────────────────────────────────────────────────────────────────────────

// ── Unit mode ────────────────────────────────────────────────────────────────
let mode = "eur";

// ── Regex patterns (compact JS‑compatible versions) ──────────────────────────

// EURO — full expression highlight
const EURO_RE =
  /(?<!\d)(?:€\s*(?<num>[0-9](?:[0-9 .,\u00A0]*[0-9])?)|(?<num>[0-9](?:[0-9 .,\u00A0]*[0-9])?)\s*€|(?<num>[0-9](?:[0-9 .,\u00A0]*[0-9])?)\s*(?<word>eur|euro|eurot)\b|(?<word>eur|euro|eurot)\s*(?<num>[0-9](?:[0-9 .,\u00A0]*[0-9])?))/gi;

// GRAM — full expression highlight
const G_RE =
  /(?<!\d)(?:(?<num>[0-9](?:[0-9 .,\u00A0]*[0-9])?)\s*(?<unit>g\.?|gramm(?:i|ides)?|grammi|gramm|gram)\b|(?<unit>gramm(?:i|ides)?|grammi|gramm|gram)\b\s*(?<num>[0-9](?:[0-9 .,\u00A0]*[0-9])?))/gi;

// NUM — standalone numbers (excluding dates/times/case numbers)
const N_RE =
  /(?<!\d)(?<![.\-/:])(?!(?:\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}))(?!(?:\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}))(?!(?:\d{1,2}:\d{2}))(?!(?:\d+-\d+\/\d+))(?<num>[0-9](?:[0-9 .,\u00A0]*[0-9])?)/gi;

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
  let s = raw.replace(/\s/g, "");
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
function _formatNumber(n, decimals) {
  if (mode === "eur") {
    return n.toLocaleString("et-EE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  const d = decimals !== undefined ? Math.min(decimals, 10) : 10;
  return n.toLocaleString("et-EE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: d,
  });
}

function formatValue(n, decimals) {
  const s = _formatNumber(n, decimals);
  if (mode === "eur") return s + " €";
  if (mode === "g") return s + " g";
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
