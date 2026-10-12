/* Remove `//` and block comments from JavaScript without touching a single
 * character that is not provably a comment.
 *
 * A regex-based stripper cannot do this job: `rehkendaja-core.js` contains
 * /(?<![.\-/:])(?:\d+-\d+\/\d+)/ — an unescaped `/` inside a character class
 * and an escaped `\/` inside a literal — plus `String.raw` templates with
 * nested `${}`. To a pattern that looks for an opening comment marker, both
 * look like one.
 *
 * So this walks the source with a scanner that knows the four contexts where a
 * slash is not a comment: a string, a template, a character class, and the
 * escape `\//`. The only genuinely ambiguous case is `/` meaning division
 * versus the start of a regex literal, resolved by the token in front of it.
 *
 * Blanking a comment to a single space is safe but leaves gaps; a comment that
 * is alone on its line takes the line with it. `a/*x*\/b` therefore stays
 * `a b` rather than becoming the single token `ab`.
 */

const KEYWORDS_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

const CONTROL_KEYWORDS = new Set(["if", "while", "for", "with"]);

const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
const isIdentPart = (c) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c) => c >= "0" && c <= "9";

/* `/` after one of these is a division operator, not a regex. */
function prevAllowsDivision(prev) {
  if (prev.kind === "value") return true;
  if (prev.kind === "keyword") return !KEYWORDS_BEFORE_REGEX.has(prev.text);
  return false;
}

/** `(?<!x)` style lookbehind after `)` — not enough context on its own. */
function isLookbehind(src, i) {
  return src.slice(i - 4, i) === "(?<=" || src.slice(i - 5, i) === "(?<!" ;
}

export function stripJs(src) {
  let out = "";
  let i = 0;

  // What the scanner last saw, for the regex-vs-division decision.
  let prev = { kind: "none" };
  // Open `(` and `{` frames, so `}` and `)` know what they are closing.
  const parens = [];
  const braces = [];

  const noteValue = () => { prev = { kind: "value" }; };
  const noteKeyword = (text) => { prev = { kind: "keyword", text }; };

  const endOfLine = (from) => {
    const nl = src.indexOf("\n", from);
    return nl === -1 ? src.length : nl;
  };

  /* Drop `start..end` when it is the only thing on its line, otherwise leave a
   * space. Returns the new index to continue from. */
  const consumeComment = (start, end) => {
    const lineStart = out.lastIndexOf("\n") + 1;
    const beforeIsBlank = out.slice(lineStart).trim() === "";
    const afterIsBlank = src.slice(end, endOfLine(end)).trim() === "";

    if (beforeIsBlank && afterIsBlank) {
      out = out.slice(0, lineStart);
      let j = end;
      if (src[j] === "\n") j++;
      // A multi-line comment leaves its interior newlines behind; swallow any
      // run of whitespace-only lines so the output has no holes.
      for (;;) {
        const nl = src.indexOf("\n", j);
        const line = src.slice(j, nl === -1 ? src.length : nl);
        if (line.trim() !== "") break;
        if (nl === -1) {
          j = src.length;
          break;
        }
        j = nl + 1;
      }
      return j;
    }

    out += " ";
    return end;
  };

  const readString = (from) => {
    const quote = src[from];
    let j = from + 1;
    while (j < src.length) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === quote) return j + 1;
      j++;
    }
    throw new Error(`unterminated string at ${from}`);
  };

  const readRegex = (from) => {
    let j = from + 1;
    let inClass = false;
    while (j < src.length) {
      const c = src[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        j++;
        while (j < src.length && isIdentPart(src[j])) j++;
        return j;
      } else if (c === "\n") {
        throw new Error(`unterminated regex at ${from}`);
      }
      j++;
    }
    throw new Error(`unterminated regex at ${from}`);
  };

  /* Template literals nest: `${` re-enters code, and that code may hold another
   * template. Recursing into stripJs restarts the `prev` tracking, which is what
   * the expression needs, and the stripped expression is written back — a comment
   * inside `${}` is a real comment and has to go. */
  const readTemplate = (from) => {
    let j = from + 1;
    let text = "`";
    while (j < src.length) {
      const c = src[j];
      if (c === "\\") {
        text += src.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (c === "`") return { text: text + "`", end: j + 1 };
      if (c === "$" && src[j + 1] === "{") {
        let depth = 1;
        let k = j + 2;
        while (k < src.length && depth > 0) {
          const e = src[k];
          if (e === "{") { depth++; k++; continue; }
          if (e === "}") { depth--; k++; continue; }
          if (e === '"' || e === "'") { k = readString(k); continue; }
          if (e === "`") { k = readTemplate(k).end; continue; }
          if (e === "/" && src[k + 1] === "/") { k = endOfLine(k); continue; }
          if (e === "/" && src[k + 1] === "*") {
            const close = src.indexOf("*/", k + 2);
            k = close === -1 ? src.length : close + 2;
            continue;
          }
          k++;
        }
        text += "${" + stripJs(src.slice(j + 2, k - 1)) + "}";
        j = k;
        continue;
      }
      text += c;
      j++;
    }
    throw new Error(`unterminated template at ${from}`);
  };

  while (i < src.length) {
    const c = src[i];

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      out += c;
      i++;
      continue;
    }

    if (c === "/" && src[i + 1] === "/") {
      const nl = endOfLine(i);
      i = consumeComment(i, nl);
      continue;
    }

    /* Annex B HTML-like comment. Only at the start of a line: anywhere else it
     * is ordinary punctuation and turning it into a comment could eat code. */
    if (src.startsWith("<!--", i) && out.slice(out.lastIndexOf("\n") + 1).trim() === "") {
      const nl = endOfLine(i);
      i = consumeComment(i, nl);
      continue;
    }

    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? src.length : close + 2;
      i = consumeComment(i, end);
      continue;
    }

    if (c === '"' || c === "'") {
      const end = readString(i);
      out += src.slice(i, end);
      i = end;
      noteValue();
      continue;
    }

    if (c === "`") {
      const { text, end } = readTemplate(i);
      out += text;
      i = end;
      noteValue();
      continue;
    }

    if (c === "/" && !prevAllowsDivision(prev) && !isLookbehind(src, i)) {
      const end = readRegex(i);
      out += src.slice(i, end);
      i = end;
      noteValue();
      continue;
    }

    if (c === "(") {
      parens.push(prev.kind === "keyword" && CONTROL_KEYWORDS.has(prev.text));
      out += c;
      i++;
      prev = { kind: "punct" };
      continue;
    }

    if (c === ")") {
      const wasControl = parens.pop() === true;
      out += c;
      i++;
      prev = { kind: wasControl ? "punct" : "value" };
      continue;
    }

    if (c === "{") {
      // An expression in flight means an object literal; otherwise a block.
      braces.push(prev.kind === "value");
      out += c;
      i++;
      prev = { kind: "punct" };
      continue;
    }

    if (c === "}") {
      const wasObject = braces.pop() === true;
      out += c;
      i++;
      prev = { kind: wasObject ? "value" : "punct" };
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < src.length && isIdentPart(src[j])) j++;
      const text = src.slice(i, j);
      out += text;
      i = j;
      noteKeyword(text);
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      let j = i;
      while (j < src.length && /[0-9a-fA-FxXoObBnE._+-]/.test(src[j])) {
        // Stop before a `+`/`-` that belongs to the next operator, not this literal.
        if ((src[j] === "+" || src[j] === "-") && !/[eE]/.test(src[j - 1])) break;
        j++;
      }
      out += src.slice(i, j);
      i = j;
      noteValue();
      continue;
    }

    out += c;
    i++;
    prev = { kind: "punct" };
  }

  return out;
}
