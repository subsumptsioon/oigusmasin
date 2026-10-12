/* Edge cases for the tokenizer. Each case is a trap that a regex-based stripper
 * falls into; `node --check` on the real files is the last line of defence. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ROOT } from "./root.mjs";
import { stripJs } from "./js-strip.mjs";

let pass = 0;
const failures = [];

function is(label, got, want) {
  if (got === want) {
    pass++;
    return;
  }
  failures.push(`${label}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);
}

const CASES = [
  // A comment alone on its line takes the line with it.
  ["own line, block", "a\n// gone\nb", "a\nb"],
  ["own line, multi-line block", "a\n/* one\n   two */\nb", "a\nb"],
  ["own line, leading indent", "a\n    // gone\n    b", "a\n    b"],
  ["own line, trailing spaces", "a\n// gone   \nb", "a\nb"],
  ["first line of file", "// gone\nkeep", "keep"],

  // Mixed content keeps the line, loses the comment.
  ["trailing on code line", "const a = 1; // note\n", "const a = 1;\n"],
  ["inline between statements", "a; /* x */ b;", "a;   b;"],

  // Token boundaries must survive.
  ["joins nothing", "const a = x/*x*/y;", "const a = x y;"],

  // Slashes that are not comments.
  ["url in string", 'const u = "https://example.com/a";', 'const u = "https://example.com/a";'],
  ["block marker in string", 'const s = "/* not a comment */";', 'const s = "/* not a comment */";'],
  ["escaped quote in string", 'const s = "a\\"// b";', 'const s = "a\\"// b";'],
  ["single-quoted url", "const u = 'http://x/y';", "const u = 'http://x/y';"],
  ["comment-looking template text", "const t = `// ${x}`;", "const t = `// ${x}`;"],

  // Regex literals.
  ["escaped slash in regex", 's.replace(/(\\d+)-(\\d+)\\/(\\d+)/, "$3/$2/$1");',
    's.replace(/(\\d+)-(\\d+)\\/(\\d+)/, "$3/$2/$1");'],
  ["slash in char class", 'const re = /(?<![.\\-/:])(?:\\d+-\\d+\\/\\d+)/;',
    'const re = /(?<![.\\-/:])(?:\\d+-\\d+\\/\\d+)/;'],
  ["char class with bare slash", "const re = /[/]/;", "const re = /[/]/;"],
  ["flags preserved", "const re = /a\\/b/gi;", "const re = /a\\/b/gi;"],
  ["regex after return", "function f() {\n  return /a\\/b/;\n}", "function f() {\n  return /a\\/b/;\n}"],
  ["regex after control paren", "if (x) /a/.test(y);", "if (x) /a/.test(y);"],

  // Division must not be read as a regex.
  ["division of identifiers", "const r = a / b;", "const r = a / b;"],
  ["division after paren", "const r = (a + b) / 2;", "const r = (a + b) / 2;"],
  ["division after number", "const r = 10 / 2 / 5;", "const r = 10 / 2 / 5;"],
  ["division after string", "const r = s / 2;", "const r = s / 2;"],

  // Templates.
  ["regex inside interpolation", "const t = `${/a/.test(b) ? 1 : 2}`;", "const t = `${/a/.test(b) ? 1 : 2}`;"],
  ["comment inside interpolation", "const t = `${a /* note */ + b}`;", "const t = `${a   + b}`;"],
  ["nested template", "const t = `a${`b${c}`}d`;", "const t = `a${`b${c}`}d`;"],
  ["division inside interpolation", "const t = `${a / b}`;", "const t = `${a / b}`;"],

  // Objects vs blocks, which decide what may follow a `}`.
  ["division after object literal", "const v = o.k / 2;", "const v = o.k / 2;"],
  ["division after call result", "const v = f() / 2;", "const v = f() / 2;"],
  ["regex after block", "if (a) { b() }\nconst re = /x\\/y/;", "if (a) { b() }\nconst re = /x\\/y/;"],
  ["regex after object literal", "const o = {};\nconst re = /x/;", "const o = {};\nconst re = /x/;"],
];

for (const [label, input, want] of CASES) {
  let got;
  try {
    got = stripJs(input);
  } catch (err) {
    got = `THREW: ${err.message}`;
  }
  is(label, got, want);

  // Stripping stripped output must be a no-op, or the file shrinks on every run.
  try {
    is(`${label} (idempotent)`, stripJs(got), got);
  } catch (err) {
    failures.push(`${label} (idempotent) THREW: ${err.message}`);
  }
}

/* The real files: stripped output must still parse, and stripping it again must
 * change nothing. Behavioural equivalence is not provable without a parser, so
 * `npm run release` proves it the other way — by running the full suites against
 * the stripped tree. */
const REAL = ["rehkendaja-core.js", "nav.js"];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "js-strip-"));

for (const file of REAL) {
  const src = fs.readFileSync(path.join(DEFAULT_ROOT, file), "utf8");
  let out;
  try {
    out = stripJs(src);
    pass++;
  } catch (err) {
    failures.push(`${file}: stripJs threw — ${err.message}`);
    continue;
  }

  is(`${file} (idempotent)`, stripJs(out), out);

  const dest = path.join(tmp, file);
  fs.writeFileSync(dest, out);
  try {
    execFileSync(process.execPath, ["--check", dest], { stdio: "pipe" });
    pass++;
  } catch (err) {
    failures.push(`${file}: stripped output does not parse — ${err.stderr?.toString() || err.message}`);
  }

  if (out.length >= src.length) {
    failures.push(`${file}: stripping removed nothing`);
  } else {
    pass++;
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("─".repeat(72));
console.log("js-strip — tokenizer edge cases");
console.log("─".repeat(72));
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(
  failures.length ? `\nFAIL  ${pass} passed, ${failures.length} failed` : `\nPASS  ${pass} passed, 0 failed`,
);
process.exit(failures.length ? 1 : 0);
