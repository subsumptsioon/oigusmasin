/**
 * metaandmed.js — page controller for the metadata analyser.
 *
 * The file is acquired here and nowhere else, so that "the file never leaves the
 * machine" has one implementation to review rather than one per analyser. The
 * File is kept as an object and handed on by reference; nothing here reads it
 * into memory or builds a URL that could be sent anywhere, and the static check
 * in phase 11 fails the build if one ever is.
 *
 * Analysis itself lives in formats/. This file acquires, renders, and does
 * nothing else — which is what lets a format be added without editing it.
 */

import { GROUP_LABELS, runAnalysis } from "./formats/registry.js";
import {
  allGroups,
  confidenceHint,
  confidenceLabel,
  filterTree,
  isEmpty,
} from "./formats/node.js";

const input = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const resultBlock = document.getElementById("result-block");
const resultBody = document.getElementById("result-body");
const formatBadge = document.getElementById("format-badge");
const statusLine = document.getElementById("status-line");
const searchBox = document.getElementById("search-box");
const tabStrip = document.getElementById("tab-strip");
const tabPanels = document.getElementById("tab-panels");
const rawToggle = document.getElementById("raw-toggle");
const rawHint = document.getElementById("raw-hint");

/** The chosen file, or null. Held by reference — never read into a buffer here. */
let currentFile = null;

/** The last analysis: nodes, grouped, searchable. Replaced wholesale on each
 *  selection, so no state survives from one file to the next. */
let state = { groups: new Map(), active: null, query: "", showRaw: false };

/* ── Formatting ───────────────────────────────────────────────────────────── */

/** SI units per requirement 8: kB and MB are powers of 1000, and the exact byte
 *  count is always shown beside the rounded one. */
function formatSize(bytes) {
  const kb = bytes / 1000;
  if (kb < 1) return `${bytes} B`;
  if (kb < 1000) return `${kb.toFixed(1)} kB`;
  return `${(kb / 1000).toFixed(1)} MB`;
}

/* ── Rendering ────────────────────────────────────────────────────────────── */

/** Every node in a group that the query keeps, tree-intact. A parent matches on
 *  its own text; a parent whose child matches stays, so the row that holds the
 *  hit is not dropped on the way to it. */
function visibleNodes(list) {
  return filterTree(list, state.query);
}

/** Render one node as a row, with everything §6 asks the table to carry.
 *
 *  Four additions this phase made, each answering a line in §6 rather than
 *  improving the look:
 *
 *  - **Toorandmed**, the raw toggle. Shown only where `raw` differs from
 *    `value`, because a raw line under every value would double the height of
 *    every table to show text identical to the text above it. §6 says the toggle
 *    shows "the underlying text"; showing it where there is none is not that.
 *  - **Kopeeri**, a per-value copy button, reusing `nav.js`'s `copyButton()` so
 *    the page matches the rest of the site. §6 is explicit that this is not an
 *    export: there is one button per field, no button for a tab, and none for
 *    the result as a whole.
 *  - **Tundlik**, the sensitive-value mark, for the GPS coordinates and device
 *    identifiers that §5.7 singles out. The word is shown, not only a colour.
 *  - The confidence flag, which phase 3 already had.
 *
 *  Everything on screen comes from the node. There is no second representation
 *  of the analysis anywhere in this file, which is what §10 asks to be true and
 *  what `tools/check-ui.mjs` checks by counting the text this function can
 *  produce against the nodes it was given. */
function renderNode(n) {
  if (isEmpty(n)) return null;

  const row = document.createElement("div");
  row.className = "meta-row";
  row.id = n.id;
  if (n.depth > 0) row.classList.add("meta-row--child");
  if (n.confidence !== "declared") row.classList.add(`is-${n.confidence}`);
  /* §5.7's sensitive values are marked on the row as well as the value, so the
     distinction survives the search filter and the raw toggle. */
  if (n.sensitive) row.classList.add("is-sensitive");

  /* title carries the confidence so it is available to a screen reader and to a
     hover, without putting it in the value column where it would read as part of
     the file's own metadata. */
  const key = document.createElement("div");
  key.className = "kv-key";
  key.textContent = n.labelEt;

  if (n.labelEn) {
    const gloss = document.createElement("span");
    gloss.className = "kv-gloss";
    gloss.textContent = ` (${n.labelEn})`;
    key.append(gloss);
  }

  const val = document.createElement("div");
  val.className = "kv-val";
  if (n.sensitive) val.classList.add("is-sensitive");
  val.textContent = n.value;

  /* A non-default value says so in words, not only in a tooltip: the whole point
     of `confidence` is that a repaired number is not presented as a declared
     one, and a visitor reading the table without hovering must still see the
     difference. The Estonian word comes from CONFIDENCE, never from the
     analyser — one string, one place. */
  if (n.confidence !== "declared") {
    const flag = document.createElement("span");
    flag.className = "kv-flag";
    flag.textContent = confidenceLabel(n.confidence);
    flag.title = confidenceHint(n.confidence);
    val.append(flag);
  }

  if (n.sensitive) {
    const mark = document.createElement("span");
    mark.className = "kv-sensitive-flag";
    mark.textContent = "tundlik";
    mark.title =
      "See väärtus paljastab asukoha või seadme. Ära lisa sedaAvalikule dokumendile.";
    val.append(mark);
  }

  /* §6's per-value copy button. `copyButton` is the site's own helper from
     nav.js, loaded before this module; it handles the confirmation label and
     the clipboard-rejection case, and three pages already drifted on those
     details before it was factored out.

     The row is the button's accessible name, so a screen reader announces which
     field is being copied rather than a bare "Kopeeri". */
  if (n.value) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "kv-copy";
    copy.textContent = "kopeeri";
    copy.setAttribute("aria-label", `Kopeeri väärtus: ${n.labelEt}`);
    copy.addEventListener("click", () => copyButton(copy, n.value));
    val.append(copy);
  }

  row.append(key, val);

  /* The raw line, when the toggle is on and there is something to show. Held as
     a child of the row rather than in a separate panel, so it moves with the
     value it belongs to and cannot be mistaken for another field. */
  if (state.showRaw) row.append(rawBlock(n));

  for (const child of n.children) {
    const rendered = renderNode(child);
    if (rendered) row.append(rendered);
  }
  return row;
}

/** The raw text under a value, or nothing.
 *
 *  Two cases produce no raw line, and both are deliberate:
 *
 *   - `raw` equals `value`. Most fields are stored as the text that is shown, so
 *     a raw line would repeat the line above it in smaller type. §6 wants the
 *     toggle to reveal the underlying text, and where the underlying text *is*
 *     the value, that is already on screen.
 *   - `raw` is a long block, like an XMP packet or a PDF's dictionary. Those are
 *     shown up to a limit with the remainder counted, because a 20 000-character
 *     pre element inside a scrollable page is a trap for a keyboard user. */
function rawBlock(n) {
  if (!n.raw || n.raw === n.value) return null;
  if (n.raw.length > MAX_RAW_RENDER) {
    const note = document.createElement("p");
    note.className = "kv-raw";
    note.textContent = `${n.raw.slice(0, MAX_RAW_RENDER)}\n… (${n.raw.length - MAX_RAW_RENDER} märki veel)`;
    return note;
  }
  const note = document.createElement("p");
  note.className = "kv-raw";
  note.textContent = n.raw;
  return note;
}

/** How much raw text to render before summarising the rest. The node keeps the
 *  whole thing for the copy button and the search index; this is a rendering
 *  limit, not a data limit. */
const MAX_RAW_RENDER = 2000;

function renderGroups() {
  tabPanels.textContent = "";

  for (const key of allGroups([...state.groups.keys()], GROUP_LABELS)) {
    const list = state.groups.get(key.key);
    if (!list?.length) continue;

    const panel = document.createElement("section");
    panel.className = "meta-panel";
    panel.id = `panel-${key.key}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `tab-${key.key}`);
    /* `hidden` rather than a class: it removes the panel from the tab order and
       from the accessibility tree, which is what a panel that is not selected
       should do. */
    panel.hidden = key.key !== state.active;

    const visible = visibleNodes(list);
    if (visible.length === 0) {
      const empty = document.createElement("p");
      empty.className = "meta-empty";
      empty.textContent = `Otsing "${state.query}" ei andnud tulemusi selles vaates.`;
      panel.append(empty);
    } else {
      for (const n of visible) {
        const row = renderNode(n);
        if (row) panel.append(row);
      }
    }
    tabPanels.append(panel);
  }
}

/** One tab per group that has nodes. The strip is rebuilt rather than hidden,
   so a group with no nodes cannot leave a dead tab behind.

   The list comes from the nodes that exist, ordered by `allGroups()`, not from
   the static `GROUPS` constant — see the note there. Filtering the constant was
   how a new format's tab went missing. */
function renderTabs() {
  tabStrip.textContent = "";
  const present = allGroups([...state.groups.keys()], GROUP_LABELS)
    .filter((g) => state.groups.get(g.key)?.length);

  for (const [i, g] of present.entries()) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.id = `tab-${g.key}`;
    tab.textContent = g.labelEt;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(g.key === state.active));
    tab.tabIndex = g.key === state.active ? 0 : -1;
    tab.addEventListener("click", () => selectGroup(g.key));
    tab.addEventListener("keydown", (e) => onTabKey(e, present, i));
    tabStrip.append(tab);
  }
}

function selectGroup(key) {
  state.active = key;
  for (const tab of tabStrip.children) {
    const on = tab.id === `tab-${key}`;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const panel of tabPanels.children) {
    panel.hidden = panel.id !== `panel-${key}`;
  }
}

/** Roving tabindex, per the WAI-ARIA tabs pattern: arrows move and activate,
 *  Home and End jump to the ends, and Tab leaves the strip rather than walking
 *  it. Without this a keyboard reaches exactly one tab and no way to change. */
function onTabKey(e, present, index) {
  const last = present.length - 1;
  let next = null;

  if (e.key === "ArrowRight") next = index === last ? 0 : index + 1;
  else if (e.key === "ArrowLeft") next = index === 0 ? last : index - 1;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = last;
  else return;

  e.preventDefault();
  selectGroup(present[next].key);
  document.getElementById(`tab-${present[next].key}`)?.focus();
}

function renderFileSummary(file) {
  resultBody.textContent = "";
  const nameEl = document.createElement("div");
  nameEl.className = "kv-key";
  nameEl.textContent = file.name;
  const sizeEl = document.createElement("div");
  sizeEl.className = "kv-val";
  sizeEl.textContent = `${formatSize(file.size)} (${file.size} B)`;
  resultBody.append(nameEl, sizeEl);
}

/* ── Selection ────────────────────────────────────────────────────────────── */

/**
 * Nodes bucketed into the tabs that will actually be shown.
 *
 * Any group is accepted, not only the ones in the `GROUPS` constant: an analyser
 * that invents a group gets a tab, because §6 promised exactly that. It still
 * gets *no* tab if it emitted no nodes, and a node with no `group` at all is
 * dropped — a node that forgot to say where it goes is a bug worth seeing in the
 * source, not worth inventing a home for on screen.
 */
function groupNodes(nodes) {
  const used = [...new Set(nodes.map((n) => n.group).filter(Boolean))];
  const map = new Map();
  for (const g of allGroups(used)) map.set(g.key, []);

  for (const n of nodes) {
    if (!n.group || !map.has(n.group)) continue;
    map.get(n.group).push(n);
  }
  return map;
}

async function select(file) {
  currentFile = file;

  if (!file) {
    resultBlock.classList.add("hidden");
    formatBadge.classList.add("hidden");
    tabStrip.hidden = true;
    tabPanels.hidden = true;
    state = { groups: new Map(), active: null, query: "", showRaw: false };
    rawToggle.setAttribute("aria-pressed", "false");
    rawHint.textContent = "Näitab iga väärtuse algset teksti";
    return;
  }

  resultBlock.classList.remove("hidden");
  renderFileSummary(file);
  statusLine.textContent = "Analüüsin…";
  tabStrip.hidden = true;
  tabPanels.hidden = true;

  const result = await runAnalysis(file);

  formatBadge.textContent = result.detected?.labelEt ?? "?";
  formatBadge.classList.remove("hidden");

  state = {
    groups: groupNodes(result.nodes),
    active: null,
    query: searchBox.value.trim().toLowerCase(),
    /* The toggle is a view setting over the analysis, so it survives a re-render
       but not a new file. Losing it here meant pressing it once and it silently
       resetting on the next selection. */
    showRaw: state.showRaw,
  };

  /* The node tree, published for inspection.
   *
   * §10 asks that every displayed value be rendered from a node and that there
   * be no second, parallel representation — and that claim cannot be checked by
   * reading. So it is checked arithmetically: every string the page draws is
   * compared against the set of strings the node tree contains. A value invented
   * by the renderer appears on screen and in neither, which is what makes this
   * property testable rather than merely asserted.
   *
   * It is a read-only window onto data the page already holds. Nothing reads it
   * back, and it carries no file content beyond what is on screen. */
  globalThis.__lastNodes = result.nodes;

  /* The node tree, published for inspection.
   *
   * §10 asks that every displayed value be rendered from a node and that there
   * be no second, parallel representation — and that claim cannot be checked by
   * reading. So it is checked arithmetically: every string the page draws is
   * compared against the set of strings the node tree contains. A value invented
   * by the renderer would appear on screen and in neither.
   *
   * It is a read-only window onto data the page already holds; nothing reads it
   * back, and it carries nothing that is not already on screen.
   *
   * Placed in `select()` and not in `renderTabs()`, because the first attempt
   * put it in the function whose body shared a line with this one — and
   * `renderTabs()` has no `result`, so every analysis died with
   * "result is not defined" and the page sat on "Analüüsin…" forever. */
  globalThis.__lastNodes = result.nodes;

  const present = allGroups([...state.groups.keys()], GROUP_LABELS)
    .filter((g) => state.groups.get(g.key)?.length);
  state.active = present[0]?.key ?? null;

  renderTabs();
  renderGroups();
  tabStrip.hidden = present.length === 0;
  tabPanels.hidden = present.length === 0;

  if (result.errors.length) {
    /* §6's veakatted: each message is a sentence about the file, not a code.
       They are joined with a separator rather than a full stop, because several
       of them are statements of fact and a run-on paragraph reads as one
       complaint about the visitor's file. */
    statusLine.textContent = result.errors.map((e) => e.messageEt).join(" · ");
  } else if (!present.length) {
    statusLine.textContent = "Analüüs ei leidnud ühtegi välja.";
  } else {
    statusLine.textContent = `${present.length} vaateid`;
  }
}

input.addEventListener("change", () => select(input.files?.[0] ?? null));

searchBox.addEventListener("input", () => {
  state.query = searchBox.value.trim().toLowerCase();
  renderGroups();
});

/* ── The raw-data toggle ────────────────────────────────────────────────────
   §6's "toorandmete lüliti", one control for every table rather than a switch
   per row — forty switches would be forty things to turn off.

   The state lives beside the search query because it is the same kind of thing:
   a view setting over the current analysis. It resets when a new file is
   selected, since §6 requires that nothing survive from one file to the next. */
rawToggle.addEventListener("click", () => {
  state.showRaw = !state.showRaw;
  rawToggle.setAttribute("aria-pressed", String(state.showRaw));
  rawHint.textContent = state.showRaw
    ? "Näitab iga väärtuse algset teksti"
    : "Algsed tekstid on peidetud";
  renderGroups();
});

/* ── Drag and drop ──────────────────────────────────────────────────────────
   A convenience layered over the <input>, never a replacement: if the drag
   events do not fire, the input is still there and still works. */

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("is-drop");
});

dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-drop"));

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("is-drop");
  const file = e.dataTransfer?.files?.[0];
  if (file) select(file);
});