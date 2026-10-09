#!/usr/bin/env node
/**
 * dom-tests.mjs — regression tests for the DOM tool pages (headless Chromium).
 *
 * The Rehkendaja core is covered by tools/run-rehkendaja-tests.mjs (pure, Node
 * VM). The other pages' inline logic is only reachable in a browser, so this
 * runner loads each affected page once and evaluates assertions in its global
 * scope. No npm deps: drives Chromium over CDP via Node's built-in WebSocket.
 *
 * Requires `chromium` on PATH (not wired into `npm run verify`/CI, which run
 * dependency-free Node checks only).
 *
 * Usage:  node tools/dom-tests.mjs [--verbose]
 * Exit:   0 all pass, 1 any fail, 2 harness error.
 */
import { launch } from "./cdp.mjs";

const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

// ── Checks: {page, label, expr, expect} — expect compared by JSON equality ──
const J = JSON.stringify;
const CHECKS = [
  // isikukood — ID parsing / checksum
  { page: "isikukood.html", label: "parseIdCode: valid checksum", expr: "parseIdCode('49001012115')", expect: { valid: true, checksumOk: true, born: { y: 1990, m: 1, d: 1 } } },
  { page: "isikukood.html", label: "parseIdCode: wrong checksum", expr: "parseIdCode('37605030000').checksumOk", expect: false },
  { page: "isikukood.html", label: "parseIdCode: first digit out of range", expr: "parseIdCode('07605030000').valid", expect: false },
  { page: "isikukood.html", label: "parseIdCode: length", expr: "parseIdCode('123').valid", expect: false },
  { page: "isikukood.html", label: "parseIdCode: century map 1->1800", expr: "parseIdCode('10001010000').born ? parseIdCode('10001010000').born.y : parseIdCode('10001010000').error", expect: 1800 },

  // isikukood — age (regression: negative-days bug)
  { page: "isikukood.html", label: "calcAge: 31.01 -> 01.03 = 0y 1m 1d", expr: "calcAge({y:2020,m:1,d:31},{y:2020,m:3,d:1})", expect: { years: 0, months: 1, days: 1 } },
  { page: "isikukood.html", label: "calcAge: leap-day -> non-leap", expr: "calcAge({y:2020,m:2,d:29},{y:2021,m:2,d:28})", expect: { years: 1, months: 0, days: 0 } },
  { page: "isikukood.html", label: "calcAge: normal case unchanged", expr: "calcAge({y:2000,m:5,d:10},{y:2026,m:9,d:26})", expect: { years: 26, months: 4, days: 16 } },
  { page: "isikukood.html", label: "calcAge: never negative", expr: "(()=>{for(let y=1990;y<=2001;y++)for(let m=1;m<=12;m++)for(let d=1;d<=31;d++){const bd=new Date(y,m-1,d);if(bd.getMonth()!==m-1||bd.getDate()!==d)continue;for(let rm=1;rm<=12;rm++)for(let rd=1;rd<=31;rd++){const r=new Date(y+30,rm-1,rd);if(r.getMonth()!==rm-1||r.getDate()!==rd)continue;const a=calcAge({y,m,d},{y:y+30,m:rm,d:rd});if(a.years<0||a.months<0||a.days<0)return false;}}return true;})()", expect: true },
  { page: "isikukood.html", label: "parseDMY: rejects impossible dates", expr: "[parseDMY('31.02.2020'), parseDMY('01.13.2020'), parseDMY('29.02.2020')]", expect: [null, null, { y: 2020, m: 2, d: 29 }] },

  // narkonimekirjad — highlight must not corrupt escaped entities
  { page: "narkonimekirjad.html", label: "highlight: query 'amp' keeps entity intact", expr: "highlight('Amphetamine & co', 'amp')", expect: "<mark>Amp</mark>hetamine &amp; co" },
  { page: "narkonimekirjad.html", label: "highlight: query '&' escapes the mark", expr: "highlight('a & b', '&')", expect: "a <mark>&amp;</mark> b" },
  { page: "narkonimekirjad.html", label: "highlight: query '<' escapes the mark", expr: "highlight('a < b', '<')", expect: "a <mark>&lt;</mark> b" },
  { page: "narkonimekirjad.html", label: "highlight: no entity match when absent", expr: "highlight('hello', 'zzz')", expect: "hello" },
  { page: "narkonimekirjad.html", label: "esc: escapes &<>", expr: "esc('a & b < c > d')", expect: "a &amp; b &lt; c &gt; d" },

  // index — detection, sum, exclusion round-trip
  { page: "index.html", label: "eur sum", expr: "(()=>{mode='eur';inputEl.value='1 234,56 € ning 89.50 €';update();return valSum.textContent;})()", expect: "1324,06\u00a0€" },
  { page: "index.html", label: "gram sum", expr: "(()=>{mode='g';inputEl.value='0,5g heroiini ja 1.2g';update();return valSum.textContent;})()", expect: "1,7\u00a0g" },
  { page: "index.html", label: "exclude one of two", expr: "(()=>{mode='eur';inputEl.value='10 € ja 20 €';update();toggleExclude(0);return [valSum.textContent, valCount.textContent];})()", expect: ["20,00\u00a0€", "1 / 2"] },
  { page: "index.html", label: "negative amount reduces the sum", expr: "(()=>{mode='eur';inputEl.value='100 € ja -40 €';update();return valSum.textContent;})()", expect: "60,00\u00a0€" },
  { page: "index.html", label: "negatives cancel to zero", expr: "(()=>{mode='eur';inputEl.value='100 € ja -100 €';update();return [valSum.textContent, valCount.textContent];})()", expect: ["0,00\u00a0€", "2"] },

  // index — escHtml / highlight builders (the inline logic, not the core)
  { page: "index.html", label: "escHtml escapes & < >", expr: "escHtml('a & b < c > d')", expect: "a &amp; b &lt; c &gt; d" },
  { page: "index.html", label: "escHtml leaves quotes alone", expr: "escHtml('say \"hi\" it\\'s')", expect: "say \"hi\" it's" },
  { page: "index.html", label: "escHtml escapes an ampersand only once", expr: "escHtml('&amp;')", expect: "&amp;amp;" },
  { page: "index.html", label: "buildHighlightHtml with no matches", expr: "buildHighlightHtml('100 & 200', [])", expect: "100 &amp; 200" },
  { page: "index.html", label: "buildHighlightHtml marks each amount", expr: "(()=>{mode='eur';excluded.clear();const t='kokku 100 € ja 200 €';return buildHighlightHtml(t, extractAmounts(t));})()", expect: "kokku <mark data-idx=\"0\">100 €</mark> ja <mark data-idx=\"1\">200 €</mark><span></span>" },
  { page: "index.html", label: "buildHighlightHtml escapes inside a mark", expr: "(()=>{mode='eur';excluded.clear();const t='a<b 100 €';return buildHighlightHtml(t, extractAmounts(t));})()", expect: "a&lt;b <mark data-idx=\"0\">100 €</mark><span></span>" },
  { page: "index.html", label: "buildHighlightHtml trailing newline hack", expr: "(()=>{mode='eur';excluded.clear();const t='100 €\\n';return buildHighlightHtml(t, extractAmounts(t));})()", expect: "<mark data-idx=\"0\">100 €</mark>\n <span></span>" },
  /* Asserted on the parsed marks rather than on innerHTML: toggling a class
     appends `class` after `data-idx`, so the attribute order differs from the
     freshly-rendered markup. That is serialisation, not behaviour — this check
     is about which mark carries the class. buildHighlightHtml's own output
     format is pinned by the three checks above. */
  { page: "index.html", label: "excluded mark carries the class", expr: "(()=>{mode='eur';excluded.clear();inputEl.value='10 € ja 20 €'.replace(/€/g,'€');update();toggleExclude(0);return [...highlightEl.querySelectorAll('mark')].map(m=>[m.dataset.idx,m.className,m.textContent]);})()", expect: [["0","excluded","10 €"],["1","","20 €"]] },

  // index — exclusion re-indexing. lastFound is rebuilt on every keystroke, so
  // exclusions are re-matched by raw text with a +/-10 character position
  // tolerance (update(), index.html). Each check clears the set first so it
  // does not depend on the checks before it.
  { page: "index.html", label: "exclusion survives a 10-char shift", expr: "(()=>{mode='eur';excluded.clear();inputEl.value='10 € ja 20 €';update();toggleExclude(0);inputEl.value=' '.repeat(10)+'10 € ja 20 €';update();return [[...excluded], valSum.textContent, valCount.textContent];})()", expect: [[0], "20,00\u00a0€", "1 / 2"] },
  { page: "index.html", label: "exclusion is dropped past the 10-char tolerance", expr: "(()=>{mode='eur';excluded.clear();inputEl.value='10 € ja 20 €';update();toggleExclude(0);inputEl.value=' '.repeat(12)+'y 10 € ja 20 €';update();return [[...excluded], valSum.textContent, valCount.textContent];})()", expect: [[], "30,00\u00a0€", "2"] },
  // A letter in front of an amount is not a sign, and it also stops the amount
  // from being detected at all — so "x10 €" yields only the 20 €.
  { page: "index.html", label: "letter prefix drops the amount", expr: "(()=>{mode='eur';excluded.clear();inputEl.value='x10 € ja 20 €';update();return [lastFound.map(x=>x.raw), valSum.textContent];})()", expect: [["20 €"], "20,00\u00a0€"] },

  // index — render states
  { page: "index.html", label: "empty input resets the panel", expr: "(()=>{inputEl.value='';update();return [valSum.textContent, valCount.textContent, valList.textContent];})()", expect: ["0", "0", "–"] },
  { page: "index.html", label: "text with no amounts", expr: "(()=>{mode='eur';inputEl.value='pole raha';update();return [valSum.textContent, valCount.textContent, valList.textContent.trim()];})()", expect: ["0,00\u00a0€", "0", "// ühtegi elementi ei leitud"] },
  { page: "index.html", label: "everything excluded", expr: "(()=>{mode='eur';inputEl.value='10 €';update();toggleExclude(0);return [valSum.textContent, valCount.textContent];})()", expect: ["0,00\u00a0€", "0 / 1"] },
  { page: "index.html", label: "list is numbered from 01", expr: "(()=>{mode='eur';inputEl.value='1 € ja 2 € ja 3 €';update();return [...valList.querySelectorAll('.el-num')].map(el=>el.textContent);})()", expect: ["01", "02", "03"] },

  // index — the sum is already glued with U+00A0 before the unit, because
  // et-EE's Intl.NumberFormat uses U+00A0 as its group separator. That makes
  // the copy handler's / (?=[€g])/g replace a no-op: there is never a plain
  // space left in front of the unit to convert.
  { page: "index.html", label: "sum already uses U+00A0 before the unit", expr: "(()=>{mode='eur';inputEl.value='1234567 €';update();const t=valSum.textContent;return [t.includes('\\u00A0'), t.replace(/ (?=[\\u20ACg])/g,'\\u00A0')===t];})()", expect: [true, true] },

  // karistuste-liitmine — duration carry
  { page: "karistuste-liitmine.html", label: "carry: 11m + 11m = 1y 10m", expr: "(()=>{const set=(id,v)=>document.getElementById(id).value=v;set('a-years',1);set('a-months',11);set('a-days',0);set('b-years',0);set('b-months',11);set('b-days',20);const r=compute();return {y:r.rYears,m:r.rMonths,d:r.rDays};})()", expect: { y: 2, m: 10, d: 20 } },
  { page: "karistuste-liitmine.html", label: "carry: 25 days -> 0m 25d", expr: "(()=>{const set=(id,v)=>document.getElementById(id).value=v;set('a-years',0);set('a-months',0);set('a-days',25);set('b-years',0);set('b-months',0);set('b-days',0);const r=compute();return {y:r.rYears,m:r.rMonths,d:r.rDays};})()", expect: { y: 0, m: 0, d: 25 } },

  // ennetähtaegne-vabastamine — calendar arithmetic + entity fix
  { page: "ennetahtaegne-vabastamine.html", label: "addCalendarDuration clamps to month end", expr: "(()=>{const f=d=>formatDate(d);return [f(addCalendarDuration(new Date(2021,0,31),0,1,0)), f(addCalendarDuration(new Date(2020,0,31),0,1,0)), f(addCalendarDuration(new Date(2020,1,29),1,0,0))];})()", expect: ["28.02.2021", "29.02.2020", "28.02.2021"] },
  { page: "ennetahtaegne-vabastamine.html", label: "compute applies 4-month minimum", expr: "(()=>{const r=compute(new Date(2021,0,1),0,3,0,1,2);return {date:formatDate(r.resultDate), min:r.minApplied};})()", expect: { date: "01.05.2021", min: true } },
  { page: "ennetahtaegne-vabastamine.html", label: "legal label has no literal &nbsp", expr: "document.querySelector('.result-legal-label').textContent.includes('&nbsp')", expect: false },
];

const eq = (a, b) => J(a) === J(b);

async function main() {
  const env = await launch();
  let exit = 0;
  try {
    const pageList = [...new Set(CHECKS.map((c) => c.page))];
    let pass = 0, fail = 0;
    const failures = [];

    for (const page of pageList) {
      const { targetId, sessionId } = await env.open(page, { settle: 1200 });

      for (const c of CHECKS.filter((c) => c.page === page)) {
        let got, threw = null;
        try {
          got = await env.eval(c.expr, sessionId);
        } catch (err) {
          threw = err.message;
        }
        if (threw) {
          fail++; failures.push({ ...c, threw });
        } else if (eq(got, c.expect)) {
          pass++;
          if (VERBOSE) console.log(`  \x1b[32m\u2713\x1b[0m ${page} :: ${c.label}`);
        } else {
          fail++; failures.push({ ...c, got });
        }
      }
      await env.close_(targetId);
    }

    console.log(`DOM regression tests  (${pass + fail} checks across ${pageList.length} pages)`);
    console.log("\u2500".repeat(64));
    for (const f of failures) {
      console.error(`\x1b[31m\u2717\x1b[0m ${f.page} :: ${f.label}`);
      if (f.threw) console.error(`    threw: ${f.threw}`);
      else { console.error(`    got      ${J(f.got)}`); console.error(`    expected ${J(f.expect)}`); }
    }
    console.log("\u2500".repeat(64));
    if (fail) { console.log(`\x1b[31mFAIL\x1b[0m  ${pass} passed, ${fail} failed`); exit = 1; }
    else console.log(`\x1b[32mPASS\x1b[0m  ${pass} passed, 0 failed`);
  } catch (err) {
    console.error("harness error:", err?.message || err);
    exit = 2;
  } finally {
    await env.close();
  }
  process.exit(exit);
}

main();
