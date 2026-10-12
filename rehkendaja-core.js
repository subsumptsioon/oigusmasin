let mode = "eur";

const NUM_SRC = String.raw`[-\u2212]?[0-9](?:[0-9 .,\u00A0]*[0-9])?`;

const NOT_AFTER_WORD = String.raw`(?<![\p{L}\p{N}])`;

const EURO_RE = new RegExp(
  String.raw`${NOT_AFTER_WORD}(?:€\s*(?<num>${NUM_SRC})|(?<num>${NUM_SRC})\s*€|(?<num>${NUM_SRC})\s*(?<word>eur|euro|eurot)\b|(?<word>eur|euro|eurot)\s*(?<num>${NUM_SRC}))`,
  "giu",
);

const G_RE = new RegExp(
  String.raw`${NOT_AFTER_WORD}(?:(?<num>${NUM_SRC})\s*(?<unit>g\.?|gramm(?:i|ides)?|grammi|gramm|gram)\b|(?<unit>gramm(?:i|ides)?|grammi|gramm|gram)\b\s*(?<num>${NUM_SRC}))`,
  "giu",
);

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

function parseAmount(raw) {
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

function countDecimals(raw) {
  const s = raw.replace(/\s/g, "");
  const di = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (di === -1) return 0;
  return s.length - di - 1;
}

function extractAmounts(text) {
  const re = activeRe();
  const results = [];
  let match;

  while ((match = re.exec(text)) !== null) {
    const rawNum = match.groups?.num;
    if (!rawNum) continue;

    const amount = parseAmount(rawNum);
    if (amount === null) continue;

    results.push({
      raw: match[0],
      amount,
      decimals: countDecimals(rawNum),
      index: match.index,
      matchLen: match[0].length,
    });
  }

  return results;
}

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
