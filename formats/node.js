// ── formats/node.js ───────────────────────────────────────────────────────────
// The vocabulary every format speaks and the page renders.
//
// Two parts, and the split is the whole point:
//
//   GROUPS   English routing keys. Identity, ordering, search indexing. Never
//            translated, never a display string.
//   LABELS   Estonian display text. The only Estonian in the project outside the
//            HTML page itself (requirement 12).
//
// Keeping them apart is not tidiness. A tab exists because some node carries its
// group; the search indexes the group; the tab is *called* something. Collapse
// the two and translating the interface silently unbuilds the navigation. The
// first draft of the plan had `group: "infodiktsioon"` and was wrong.
// ─────────────────────────────────────────────────────────────────────────────

/* ── Groups ─────────────────────────────────────────────────────────────────
   Order here is tab order. A group with no nodes is not rendered, so adding one
   costs an entry here and nothing else.

   `file` and `summary` are produced by the pipeline itself rather than by any
   analyser, because both exist for every format. Everything else is a PDF layer
   for now, and a future format contributes new keys beside these. */

export const GROUPS = [
  { key: "summary", labelEt: "Kokkuvõte" },
  { key: "file", labelEt: "Fail" },
  { key: "revisions", labelEt: "Versioonid" },
  { key: "info", labelEt: "Info ja XMP" },
  { key: "structure", labelEt: "Struktuur" },
  { key: "fonts", labelEt: "Kirjatüübid ja pildid" },
  { key: "raw", labelEt: "Toorandmed" },
];

/**
 * Every group that has nodes, in tab order.
 *
 * §6 promises that "a group with no nodes is hidden, so a file with no
 * annotations does not get an empty Annotations tab, **and a future format that
 * emits different groups gets its own tabs for free**". The first half held and
 * the second did not: the page built its tabs by filtering the `GROUPS` list
 * above, so a group invented by a new analyser was *dropped* — not shown, not
 * named, simply gone. The extensibility proof caught it by following the README
 * literally: the new format was detected, its badge was right, and it had no tab
 * and no rows anywhere on the page.
 *
 * `GROUPS` stays the authority on **order and on the Estonian names of the groups
 * this project knows**. A group it does not know is appended after them and named
 * from `labels` — the `GROUP_LABELS` the registry collected from the format's own
 * entry — falling back to its key. So a format added tonight is visible tonight
 * and properly named tonight, still without an edit to this file or to the page.
 */
export function allGroups(usedKeys = [], labels = new Map()) {
  const known = GROUPS.filter((g) => usedKeys.includes(g.key));
  const unknown = usedKeys
    .filter((key) => !known.some((g) => g.key === key))
    /* Sort alphabetically rather than by first appearance: a group's tab
       position should not depend on which analyser emitted it first. */
    .sort()
    .map((key) => ({ key, labelEt: labels.get(key) ?? key, unknown: true }));
  return [...known, ...unknown];
}

const GROUP_LABELS = new Map(GROUPS.map((g) => [g.key, g.labelEt]));

/** The display name of a group, or the key itself if nothing claims it. A node
 *  with an unknown group renders rather than disappearing — which is what lets a
 *  format added later ship before this file learns its key. */
export function groupLabel(key) {
  return GROUP_LABELS.get(key) ?? key;
}

/* ── Confidence ───────────────────────────────────────────────────────────────
   How the analyser came by this value. §11's honesty requirement: a repaired
   number, a number behind a password, and a number read from the file are three
   different claims and the interface must not blur them. English keys, Estonian
   text, resolved once per node at render time. */

export const CONFIDENCE = {
  declared: {
    labelEt: "deklareritud",
    hintEt: "Väärtus on failis selle kujul, nagu tootja selle kirjutas.",
  },
  repaired: {
    labelEt: "parandatud",
    hintEt:
      "Faili ristviide oli vigane. Väärtus leiti failist otsides, mitte faili põhjal.",
  },
  unreadable: {
    labelEt: "lugematatu",
    hintEt: "Väärtus on krüpteeritud ja seda ei saa ilma paroolita lugeda.",
  },
  absent: {
    labelEt: "puudub",
    hintEt: "Failis pole seda välja.",
  },
};

export function confidenceLabel(key) {
  return CONFIDENCE[key]?.labelEt ?? key;
}

export function confidenceHint(key) {
  return CONFIDENCE[key]?.hintEt ?? "";
}

/* ── Nodes ──────────────────────────────────────────────────────────────────
   One flat shape. `children` is a flat array of the same shape rather than
   nested objects, so a row, a field and a nested structure are one code path in
   the renderer and in the search index. Depth is expressed by indentation
   instead of by a second shape that would need its own renderer.

   `id` is the analyser's, not ours. It is what makes emitNode able to replace a
   streamed placeholder with the real value, and what lets search results point
   at one field rather than at a whole tab. */

let seq = 0;

/** A node.
 *
 *  id          stable within one analysis; the renderer replaces by id
 *  group       a GROUPS key, or any string a future format invents
 *  labelEt     Estonian, what the visitor reads
 *  labelEn     shown in parentheses after labelEt; a PDF key where one exists
 *  value       the parsed value, rendered as text
 *  raw         the original text, shown by the toorandmed toggle; may equal value
 *  confidence  a CONFIDENCE key; defaults to "declared"
 *  depth       0 for a row, 1 for a field inside it
 *  children    same shape, any depth
 *  searchText  lowercased haystack; built here so no analyser has to remember */
export function node(fields) {
  const labelEt = fields.labelEt ?? "";
  const labelEn = fields.labelEn ?? "";
  const value = fields.value ?? "";
  const children = fields.children ?? [];
  return {
    id: fields.id ?? `n${seq++}`,
    group: fields.group,
    labelEt,
    labelEn,
    value,
    raw: fields.raw ?? value,
    confidence: fields.confidence ?? "declared",
    depth: fields.depth ?? 0,
    children,
    searchText: [labelEt, labelEn, value, fields.raw ?? ""]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  };
}

/** True for a leaf: nothing below it and nothing to show. An empty row and a row
 *  whose only content is an empty value both render as nothing. */
export function isEmpty(n) {
  return !n.children.length && n.value === "";
}

/* ── Search ───────────────────────────────────────────────────────────────────
   One filter for the whole tree, so a query reaches a nested field without the
   renderer knowing how deep anything is.

   `filterTree` keeps ancestors of a match rather than returning a flat list: the
   row that holds the hit has to stay on screen, or the hit is invisible. This
   replaced a flat `search()` in an earlier draft, which would have dropped the
   parent row and shown an orphaned field. */

export function filterTree(list, needle) {
  if (!needle) return list;
  return list.filter((n) => matchesTree(n, needle));
}

function matchesTree(n, needle) {
  if (n.searchText.includes(needle)) return true;
  return n.children.some((c) => matchesTree(c, needle));
}

/* ── Presentation ─────────────────────────────────────────────────────────────
   Formatting a value is rendering, not parsing, so it lives with rendering. An
   analyser that pre-formatted its own values would bake in one presentation and
   §8's per-browser differences would arrive as inconsistent text. */

const dateFormatter = new Intl.DateTimeFormat("et-EE", {
  dateStyle: "medium",
  timeStyle: "medium",
});

/** A Date → locale, or the original string if it is not a real date. Parsing is
 *  the analyser's job; this only formats what it was handed. */
export function formatValue(v) {
  if (v instanceof Date) return dateFormatter.format(v);
  return String(v ?? "");
}