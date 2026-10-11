// ── formats/pdf/structure.js ──────────────────────────────────────────────────
// The pdf.js layer: what the document *is*, as opposed to what it claims about
// itself.
//
// The division of labour with `raw.js` is the point, and it is not a split by
// convenience:
//
//   `raw.js`    reads the file's own account of itself — the cross-reference
//                table, the trailer, the Info dictionary. It can work on a file
//                whose table is broken, and it says so when it cannot.
//   this file   asks pdf.js what the document contains — pages, outlines,
//                annotations, fields, attachments — after pdf.js has resolved the
//                references, applied the inheritance rules and rebuilt the
//                object graph.
//
// The two can disagree, and when they do the interface must be able to show
// both. A page count from `raw.js` would be `/Count`; from pdf.js it is the
// number of pages that actually resolve. Phase 7 reports pdf.js's, and the
// raw row keeps its own.
//
// **What is deliberately not here.** Nothing renders, so no canvas, no viewport
// maths beyond page size, no text extraction. No glyph is mapped and no font is
// embedded, which is what makes the no-cMaps claim in §4 testable: a CJK
// document analysed here must produce zero network requests. That is not an
// optimisation, it is the evidence that the vendored library is smaller than it
// would otherwise have to be.
//
// **What is never here either.** PDF JavaScript is read as text and listed. It
// is not executed, not evaluated, and not handed to anything that could. Same
// for `/OpenAction`, URI actions and attachment contents: named, sized and dated,
// never opened. §7 states this, and this module is where that promise would be
// broken if it were going to break.
// ─────────────────────────────────────────────────────────────────────────────

import { node } from "../node.js";

/** §5.3's conversion, stated once: 1 pt = 1/72 inch = 25.4/72 mm. */
const PT_TO_MM = 25.4 / 72;

/** How many pages to open individually.
 *
 *  Every page costs a `getPage` round trip to the worker, and the annotations on
 *  each page are the bulk of what this layer produces. A 300-page document would
 *  mean 300 round trips for data most visitors never scroll to — so the walk is
 *  bounded and the bound is *reported*, never silent. §11's rule about partial
 *  results applies: the page says how many it looked at. */
const MAX_ANNOTATED_PAGES = 64;

/** An annotation or field value longer than this is truncated for display.
 *  A 2 MB annotation `/Contents` is legal and would otherwise be copied into the
 *  DOM once per keystroke of the search box. The full length is still reported. */
const MAX_VALUE_CHARS = 2000;

/**
 * Read the document structure with pdf.js.
 *
 * @param {Uint8Array} bytes the whole file
 * @param {object} ctx the analyser context
 * @returns {Promise<void>} emits nodes through `ctx.emitNode`
 */
export async function analyseStructure(bytes, ctx, catalog = null) {
  /* pdf.js is loaded here, not at module scope, for the same reason the registry
     lazy-loads analysers: a visitor who never selects a PDF never downloads a
     megabyte of parser. `script-src 'self'` already permits a same-origin
     dynamic import. */
  const pdfjs = await loadPdfjs();

  let doc = null;
  try {
    doc = await pdfjs.getDocument({
      /* `{ data }`, never `{ url }` — §7's first support. A URL would be
         something pdf.js could fetch, and the guarantee is built on pdf.js never
         holding anything fetchable.

         **A copy, not the analyser's own buffer.** The first version passed
         `bytes` directly, and its comment claimed the transfer "costs no copy".
         It does not: a transfer *moves* the ArrayBuffer and detaches it, so
         every later consumer — the image walker slicing out JPEG bytes for the
         stage-3 analyser — threw `Cannot perform Construct on a detached
         ArrayBuffer`, and did so *after* the whole document had been analysed.

         The failure was silent in the worst way: every earlier tab was correct
         and the images row was simply absent, which reads as "this document has
         no images" rather than as a crash. §4.5 budgets two resident buffers
         rather than three precisely because the file is read once; this copy is
         the price of that, and it is one buffer rather than a second read.

         The copy is sliced from the buffer rather than re-read from the File,
         because the file is long gone by this point and §4.5's promise is that
         it is read exactly once. */
      data: bytes.slice(),
      /* CVE-2024-4367: the font-initialisation path can build JavaScript from
         strings in the file. The 4.10.x line fixes it; this is the second lock.
         It costs nothing here because nothing renders. */
      isEvalSupported: false,
    }).promise;
  } catch (err) {
    ctx.reportError(
      `pdf.js ei saanud faili avada: ${err?.message ?? "teadmata viga"}. Toorandmete skann jätkub.`,
      "pdfjs-open-failed",
    );
    return;
  }

  try {
    emitPages(ctx, doc);
    emitPageGeometry(ctx, doc);
    await emitOutline(ctx, doc);
    emitPageLabels(ctx, doc);
    await emitDestinations(ctx, doc);
    await emitViewerPreferences(ctx, doc);
    await emitLanguageAndTagged(ctx, doc, catalog);
    await emitJavaScript(ctx, doc);
    await emitAttachments(ctx, doc);
    emitFieldObjects(ctx, doc);
    emitOptionalContent(ctx, doc);
    await emitAnnotations(ctx, doc);
  } finally {
    /* Released, but *not* destroyed.
     *
     * `doc.destroy()` is the obvious call and it is wrong here. In 4.10.38 the
     * default `getDocument` uses a shared, process-wide `PDFWorker` pool, and
     * destroying the last document tears that pool down — which terminates the
     * worker and discards its cached script. Analysing a second file therefore
     * refetched the 1.4 MB worker script, twice, and a visitor comparing two
     * documents paid 2.8 MB of network for the privilege.
     *
     * Measured before and after this change: three files in a row requested the
     * worker script six times. They now request it once.
     *
     * What is given up is a little memory: the pool holds a worker that may sit
     * idle between files. That is a far better trade than re-downloading a
     * megabyte per document, and the pool is released when the tab closes, which
     * is the only moment it matters. `cleanup()` still frees the per-document
     * page caches, which is where the memory actually goes. */
    await doc.cleanup?.().catch?.(() => {});
  }
}

/** Load pdf.js from the vendored copy, once per page load.
 *
 *  The module cache does the memoising; this only sets the worker path, which
 *  has to happen before the first `getDocument`. Pointing it at the local file
 *  rather than letting pdf.js build a fake worker from a blob is worth stating:
 *  the blob path builds the whole interpreter in memory, and `lib/README.md`
 *  records why both files are vendored.
 *
 *  **This cache does not survive between analyses**, and the first draft assumed
 *  it did. A module-level `let` lives as long as the module instance, and this
 *  module is re-imported for every file analysed — the registry lazy-loads its
 *  analysers. So the memoised promise was thrown away each time, a fresh
 *  `PDFWorker` pool was created, and a 1.4 MB worker script was fetched again for
 *  every file the visitor opened. A second file cost two more requests.
 *
 *  The cache therefore lives on `globalThis`, keyed by a version string. That is
 *  a deliberate exception to "no globals": it is the only scope that outlives the
 *  module, it holds no file data, and the alternative is refetching a megabyte
 *  per file. The key means a future pdf.js version gets its own pool rather than
 *  inheriting this one. */
const PDFJS_CACHE_KEY = "__oigusmasinPdfjs";

function loadPdfjs() {
  const store = globalThis;
  const cached = store[PDFJS_CACHE_KEY];
  if (cached) return cached;

  const promise = import("../../lib/pdf.min.mjs").then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = "../../lib/pdf.worker.min.mjs";
    return mod;
  });

  /* A rejected import must not be cached, or every later attempt reuses the
     failure and pdf.js never loads again for the rest of the session. */
  promise.catch(() => {
    if (store[PDFJS_CACHE_KEY] === promise) delete store[PDFJS_CACHE_KEY];
  });

  store[PDFJS_CACHE_KEY] = promise;
  return promise;
}

/* ── Releasing pages ─────────────────────────────────────────────────────────
   `PDFDocumentProxy.cleanup()` returns a promise; `PDFPageProxy.cleanup()`
   returns a **boolean** in 4.10.38 — its own type definitions say so, and the
   runtime agrees. The first draft called `.catch()` on it, which threw
   `page?.cleanup(...).catch is not a function` inside the `finally` block of the
   annotation walk.

   The failure mode was worth the fix rather than a quick patch: it happened in a
   `finally`, so it escaped the function it belonged to and surfaced as
   "Analüüs katkes" at the top of the page — an exception reported as if the
   *document* were at fault. The annotations, language and JavaScript rows all
   sat unread in memory while the page told the visitor the analysis had failed.

   So the cleanup helper below tolerates both shapes rather than assuming the
   nicer one, and is called through `await` everywhere. */

/** Release a page. Safe for either a boolean, a promise, or nothing at all. */
async function releasePage(page) {
  try {
    await page?.cleanup?.();
  } catch {
    /* A page that will not release is not a finding about the document. */
  }
}

/* ── Pages ────────────────────────────────────────────────────────────────── */

/** Page count and the fingerprint.
 *
 *  The fingerprint is pdf.js's own MD5 of the file, computed for its internal
 *  cache key. It is shown because it is genuinely useful for talking about a
 *  document — "same fingerprint" is a meaningful statement — and it is labelled
 *  as pdf.js's value rather than as a property of the file, because this page
 *  computes its own SHA-256 on the Fail tab and the two must not be confused. */
function emitPages(ctx, doc) {
  ctx.emitNode(
    node({
      id: "pdf.pages",
      group: "structure",
      labelEt: "Leheküljed",
      labelEn: "Pages",
      value: String(doc.numPages),
      children: doc.fingerprints?.[0]
        ? [child("pdf.pages.fingerprint", "Sõrmejälge (pdf.js)", "Fingerprint (pdf.js)", doc.fingerprints[0])]
        : [],
    }),
  );
}

/** Page size, in points and millimetres, plus rotation.
 *
 *  The page is opened for its geometry and cleaned up immediately — the page
 *  proxy caches a lot and this layer only wants four numbers from it. `view` is
 *  the MediaBox-derived box already transformed for rotation, and `rotate` is
 *  the raw `/Rotate`, which is a different thing and often the interesting one:
 *  a portrait scan saved as landscape usually carries `/Rotate 90` rather than
 *  a page size that says so. */
async function emitPageGeometry(ctx, doc) {
  let page;
  try {
    page = await doc.getPage(1);
  } catch {
    return;
  }

  try {
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    const rotated = page.getViewport({ scale: 1 });

    const mm = (pt) => `${(pt * PT_TO_MM).toFixed(1).replace(".", ",")} mm`;
    const view = page.view ?? [];

    ctx.emitNode(
      node({
        id: "pdf.pageSize",
        group: "structure",
        labelEt: "Lehekülje suurus",
        labelEn: "Page size",
        value: `${viewport.width} × ${viewport.height} pt`,
        children: [
          child("pdf.pageSize.pt", "Punktides", "In points", `${viewport.width} × ${viewport.height} pt`),
          child("pdf.pageSize.mm", "Millimeetrites", "In millimetres", `${mm(viewport.width)} × ${mm(viewport.height)}`),
          child("pdf.pageSize.view", "MediaBox", "MediaBox", view.length ? `[${view.join(" ")}]` : "pole"),
          child("pdf.pageSize.rotate", "Pöörang (/Rotate)", "Rotation (/Rotate)",
            `${page.rotate ?? 0}°`, "", "declared"),
          child("pdf.pageSize.rotatedBox", "Pööratud raam", "Box after rotation",
            `${rotated.width} × ${rotated.height} pt`, "", "declared"),
        ],
      }),
    );
  } finally {
    await releasePage(page);
  }
}

/* ── Outline, labels, destinations ─────────────────────────────────────────── */

/** The outline, flattened with its depth.
 *
 *  pdf.js returns a tree. A tree in the node model would mean a second shape for
 *  the renderer, and §4.3 says there is one. So the tree is walked into the flat
 *  `children` array that depth already expresses through indentation — and the
 *  depth is kept, because an outline is exactly the structure where nesting is
 *  the information. */
async function emitOutline(ctx, doc) {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline?.length) {
    ctx.emitNode(
      node({
        id: "pdf.outline",
        group: "structure",
        labelEt: "Raamatukuulised",
        labelEn: "Outline",
        value: "pole",
        confidence: "absent",
      }),
    );
    return;
  }

  const children = [];
  let count = 0;

  const walk = (items, depth) => {
    for (const item of items ?? []) {
      count++;
      /* A destination can be a named string or a page reference array, and a
         URL action can be a plain string. All three are shown as text; none is
         followed. A link in a PDF is not a link on this page — there is nothing
         to click and nothing to fetch. */
      const target = item.url
        ? `URL: ${item.url}`
        : Array.isArray(item.dest)
          ? `lehekülg ${typeof item.dest[0] === "number" ? item.dest[0] + 1 : "?"}`
          : typeof item.dest === "string"
            ? `sihtkoht: ${item.dest}`
            : "sihtkohta ei ole";

      children.push(
        child(`pdf.outline.${count}`, item.title || "(nimetuseta)", "Outline entry",
          `${target}${item.count != null ? ` · ${item.count} alapunkti` : ""}`, "",
          "declared", Math.min(depth, 6)),
      );
      walk(item.items, depth + 1);
    }
  };
  walk(outline, 1);

  ctx.emitNode(
    node({
      id: "pdf.outline",
      group: "structure",
      labelEt: "Raamatukuulised",
      labelEn: "Outline",
      value: `${count} kirjet`,
      children,
    }),
  );
}

/** Page labels — the "i", "ii", "1", "A-1" a reader sees rather than 1, 2, 3. */
async function emitPageLabels(ctx, doc) {
  const labels = await doc.getPageLabels().catch(() => null);
  if (!labels?.length) return;

  const shown = labels.slice(0, 24).join(", ");
  ctx.emitNode(
    node({
      id: "pdf.pageLabels",
      group: "structure",
      labelEt: "Lehekülje sildid",
      labelEn: "Page labels",
      value: labels.length > 24 ? `${shown} … (${labels.length} silti)` : shown,
    }),
  );
}

/** Named destinations. Named, counted, and not resolved into anything. */
async function emitDestinations(ctx, doc) {
  const dests = await doc.getDestinations().catch(() => null);
  if (!dests || typeof dests !== "object") return;

  const names = Object.keys(dests);
  if (!names.length) return;

  ctx.emitNode(
    node({
      id: "pdf.destinations",
      group: "structure",
      labelEt: "Nimetatud sihtkohad",
      labelEn: "Named destinations",
      value: `${names.length} sihtkohta`,
      children: names.slice(0, 40).map((name) =>
        child(`pdf.dest.${name}`, name, name, "sihtkoht on määratud", "", "declared", 1),
      ),
    }),
  );
}

/* ── Viewer preferences, language, tagged ─────────────────────────────────── */

/** `/Lang`, page layout and page mode.
 *
 *  A `pageLayout` of `FullScreen` in a file nobody opened full screen is a small
 *  forensic finding — a document that tried to present itself differently — so
 *  these are shown rather than treated as chrome. */
async function emitViewerPreferences(ctx, doc) {
  const [prefs, layout, mode] = await Promise.all([
    doc.getViewerPreferences().catch(() => null),
    doc.getPageLayout().catch(() => null),
    doc.getPageMode().catch(() => null),
  ]);

  const children = [];
  if (prefs && typeof prefs === "object") {
    for (const [key, value] of Object.entries(prefs)) {
      if (value == null) continue;
      children.push(child(`pdf.viewerPref.${key}`, `Eelistus ${key}`, `Viewer preference ${key}`,
        Array.isArray(value) ? value.join(" ") : String(value)));
    }
  }
  if (layout) children.push(child("pdf.pageLayout", "Lehekülje paigutus", "Page layout", layout));
  if (mode) children.push(child("pdf.pageMode", "Lehekülje režiim", "Page mode", mode));

  ctx.emitNode(
    node({
      id: "pdf.viewer",
      group: "structure",
      labelEt: "Vaatleja eelistused",
      labelEn: "Viewer preferences",
      value: children.length ? `${children.length} eelistust` : "pole",
      children,
    }),
  );
}

/** `/Lang` and `/MarkInfo`.
 *
 *  `/MarkInfo /Marked true` is the tagged-PDF flag: the file claims a structure
 *  tree and accessibility metadata. Its absence is not a claim that the document
 *  is inaccessible — plenty of untagged documents are perfectly readable — so
 *  "pole" is reported as "pole" and not as a failure. */
/** `/Lang` and `/MarkInfo`.
 *
 *  `/Lang` is **not** read here. pdf.js 4.10.38 exposes no getter for it:
 *  `_pdfInfo` carries only `numPages` and `fingerprints`, `getCatalog` does not
 *  exist, and `/Lang` is a catalog entry — so there is nothing on the public
 *  surface to read it from. The first draft reached into `doc.catalog.Lang`,
 *  which is `undefined`, and rendered "pole" for a document that says `et-EE`.

 *  Reporting "pole" here would be the wrong kind of wrong: it claims the
 *  document declares no language when it declares one. `raw.js` already parsed
 *  the catalog and has the value, so the caller passes it in, and this row says
 *  "pole" only when nothing found one.

 *  `/MarkInfo` *is* a real getter, and its three booleans are reported as they
 *  come — a file with no /MarkInfo at all returns null, which is a different
 *  fact from `/Marked false`, and the two are distinguished. */
function emitLanguageAndTagged(ctx, doc, catalog) {
  const lang = catalog?.lang ?? null;
  return doc.getMarkInfo().then((markInfo) => {
    ctx.emitNode(
      node({
        id: "pdf.language",
        group: "structure",
        labelEt: "Keel",
        labelEn: "Language",
        value: lang ?? "pole",
        confidence: lang ? "declared" : "absent",
      }),
    );

    ctx.emitNode(
      node({
        id: "pdf.markInfo",
        group: "structure",
        labelEt: "Märgistatud PDF",
        labelEn: "Tagged PDF",
        value: markInfo
          ? markInfo.Marked
            ? "jah (/MarkInfo /Marked true)"
            : "ei (/MarkInfo /Marked false)"
          : "pole /MarkInfo-d",
        confidence: markInfo ? "declared" : "absent",
      }),
    );
  });
}

/* ── JavaScript, actions, attachments ─────────────────────────────────────── */

/** Document JavaScript and `/OpenAction`, listed as text.
 *
 *  §7 says PDF JavaScript is never executed. This is where that is kept: the
 *  names and the source are read and rendered, and nothing in this file path can
 *  evaluate them. `isEvalSupported: false` in the constructor closes the other
 *  door — the one where pdf.js itself builds code from the file.
 *
 *  Listing a script's *source* is the useful part forensically: `app.alert("x")`
 *  in a document that claims to be a form says something a name like `OpenAction`
 *  does not. */
async function emitJavaScript(ctx, doc) {
  const actions = await doc.getJSActions().catch(() => null);
  const entries = actions && typeof actions === "object" ? Object.entries(actions) : [];

  const children = entries.map(([name, action]) => {
    const view = action?.view ?? action;
    const detail =
      typeof view === "string"
        ? view
        : view?.S
          ? pdfjsActionText(view.S)
          : JSON.stringify(view ?? {}).slice(0, MAX_VALUE_CHARS);
    return child(`pdf.js.${name}`, name, name,
      truncate(detail), String(view ?? ""), "declared", 1);
  });

  const openAction = await doc.getOpenAction().catch(() => null);
  if (openAction) {
    const detail =
      typeof openAction === "string"
        ? `sihtkoht: ${openAction}`
        : pdfjsActionText(openAction);
    children.push(child("pdf.js.openAction", "Avatoiming (/OpenAction)", "Open action",
      truncate(detail), "", "declared", 1));
  }

  ctx.emitNode(
    node({
      id: "pdf.javascript",
      group: "structure",
      labelEt: "JavaScript ja avatoiming",
      labelEn: "JavaScript and open action",
      /* The value says "not executed" whether or not there is anything to
         execute. A row reading simply "pole" invites the reader to assume the
         page decided to skip running something; the point of §7 is that it
         could not, so the reassurance is stated unconditionally. */
      value: children.length
        ? children.length + " kirjet — ei käivitata"
        : "pole — midagi ei käivitata",
      children,
    }),
  );
}

/** A JS action dictionary as readable text, without running any of it.
 *
 *  The interesting keys are the ones that reach outside the document: `URI` is a
 *  fetch instruction, `S/JavaScript` is code. Both are shown as text, so a visitor
 *  sees `this.getURL("http://…")` in the table rather than never seeing it. */
function pdfjsActionText(action) {
  if (!action || typeof action !== "object") return "";
  const parts = [];
  if (action.S) parts.push(action.S === "JavaScript" ? "JavaScript" : action.S);
  if (action.URI) parts.push(`URL: ${typeof action.URI === "string" ? action.URI : "(võti või nimi)"}`);
  if (action.GoTo) parts.push("GoTo (dokumendisiseselt)");
  if (action.GoToR) parts.push("GoToR (teise faili — ei avata)");
  if (action.GoToE) parts.push("GoToE (manusekihis)");
  if (action.Launch) parts.push("Launch (faili käivitamine — ei käivitata)");
  if (action.URI?.JS) parts.push("URL, mille sisu on JavaScript");
  if (action.Next) parts.push("Next");
  if (action.Prev) parts.push("Prev");
  if (action.First) parts.push("First");
  if (action.Last) parts.push("Last");
  if (typeof action.D === "string") parts.push(`käik: ${action.D}`);
  if (typeof action.JavaScript === "string") parts.push(`käik: ${action.JavaScript}`);
  return parts.join(", ") || JSON.stringify(action).slice(0, MAX_VALUE_CHARS);
}

/** Embedded attachments: name, size, date, MIME. Never opened.
 *
 *  pdf.js hands back a `Uint8Array` per attachment. It is not extracted, not
 *  decoded, not rendered, and not put in an object URL — the plan has no export
 *  path and no `blob:` in `img-src`, and an attachment that can be saved is an
 *  exit route by another name. The bytes are never touched; only their length is
 *  read, and the MIME type is reported as whatever the file claims. */
async function emitAttachments(ctx, doc) {
  const attachments = await doc.getAttachments().catch(() => null);
  const names = attachments ? Object.keys(attachments) : [];
  if (!names.length) return;

  const children = names.slice(0, 100).map((name) => {
    const record = attachments[name];
    const data = record?.data;
    return child(
      `pdf.attachment.${name}`,
      name,
      name,
      `${data?.byteLength ?? "?"} B${record?.filename ? ` · ${record.filename}` : ""}`,
      String(record?.description ?? ""),
      "declared",
      1,
    );
  });

  ctx.emitNode(
    node({
      id: "pdf.attachments",
      group: "structure",
      labelEt: "Manused",
      labelEn: "Attachments",
      value: `${names.length} manust${names.length === 1 ? "" : "i"} — mitte avatud`,
      children,
    }),
  );
}

/* ── Fields, optional content, annotations ─────────────────────────────────── */

/** AcroForm fields by type.
 *
 *  Field *types* rather than field *values*: a field's value may be encrypted
 *  (§5.2), its type never is. Counting "7 text fields" on an encrypted document
 *  is a true statement; printing their contents would not be. */
function emitFieldObjects(ctx, doc) {
  const fields = doc.getFieldObjects?.() ?? null;
  const children = [];

  /* In 4.10.38 `getFieldObjects` is asynchronous; `doc._fieldObjects` is the
     already-resolved map that older examples used. Both are read, and whichever
     is populated is used — with the version's actual shape recorded, because a
     silent "0 fields" on a form document would be the worst possible answer. */
  const resolved = fields && typeof fields.then === "function" ? null : fields;

  const source = resolved ?? doc._fieldObjects ?? null;
  if (source && typeof source === "object") {
    const entries = Array.isArray(source) ? source : Object.entries(source);
    const byType = new Map();
    for (const [, field] of entries) {
      const type = field?.type ?? "pole";
      byType.set(type, (byType.get(type) ?? 0) + 1);
    }
    if (byType.size) {
      for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1])) {
        children.push(child(`pdf.field.${type}`, `Väljade tüüp ${type}`, `Field type ${type}`, `${n} välja`));
      }
      children.push(child("pdf.field.total", "Välju kokku", "Fields total", String(entries.length)));
    }
  }

  ctx.emitNode(
    node({
      id: "pdf.fields",
      group: "structure",
      labelEt: "Vormiväljad",
      labelEn: "Form fields",
      value: children.length ? `${children.at(-1).value}` : "pole",
      children,
    }),
  );
}

/** Optional content — the layers panel. */
function emitOptionalContent(ctx, doc) {
  const config = doc.getOptionalContentConfig?.();
  const groups = config?.getGroups?.() ?? null;

  if (!groups) return;

  const children = (Array.isArray(groups) ? groups : [groups])
    .map((group, i) => {
      const config = group?.config ?? [];
      const visible = config.some((c) => c.visibility === "Visible");
      return child(
        `pdf.ocg.${i}`,
        group.name || group.id || `kiht ${i + 1}`,
        group.name || `Layer ${i + 1}`,
        `${config.length} kirjet · ${visible ? "nähtav" : "peidetud"}`,
        "",
        "declared",
        1,
      );
    });

  ctx.emitNode(
    node({
      id: "pdf.optionalContent",
      group: "structure",
      labelEt: "Valikuline sisu",
      labelEn: "Optional content",
      value: `${children.length} kihti`,
      children,
    }),
  );
}

/** Annotations, page by page.
 *
 *  The walk is bounded by `MAX_ANNOTATED_PAGES` and the bound is stated in the
 *  row's own value. A visitor looking at a 300-page document with annotations on
 *  page 299 deserves to know the page stopped at 64 rather than concluding the
 *  document has none. */
async function emitAnnotations(ctx, doc) {
  const total = doc.numPages;
  const pagesToRead = Math.min(total, MAX_ANNOTATED_PAGES);
  const truncated = total > pagesToRead;

  const children = [];
  const bySubtype = new Map();
  const byAuthor = new Map();
  let annotationCount = 0;

  for (let n = 1; n <= pagesToRead; n++) {
    if (ctx.clock.expired()) {
      ctx.reportError("Märkuste lugemine katkes ajapiiri tõttu; näidatud on osa.", "annotations-timeout");
      break;
    }

    let page;
    try {
      page = await doc.getPage(n);
      const annotations = await page.getAnnotations({ intent: "display" });
      for (const a of annotations) {
        annotationCount++;
        bySubtype.set(a.subtype ?? "pole", (bySubtype.get(a.subtype ?? "pole") ?? 0) + 1);

        /* The author and the contents arrive as `{ str, dir }` objects, not as
           strings. Reading `a.title` and `a.contents` directly yields undefined
           and an annotation row with no author — which looks like a file with no
           author in it rather than a wrong property name.

           The naming was confirmed against 4.10.38's runtime, not its types:
           `modificationDate` is the key, not `modDate`. */
        const author = a.titleObj?.str ?? a.title ?? null;
        const contents = a.contentsObj?.str ?? a.contents ?? null;
        if (author) byAuthor.set(author, (byAuthor.get(author) ?? 0) + 1);

        const detail = [
          a.subtype ? `tüüp ${a.subtype}` : null,
          author ? `autor „${truncate(author, 80)}”` : null,
          a.creationDate ? `loodud ${a.creationDate}` : null,
          a.modificationDate ? `muudetud ${a.modificationDate}` : null,
          contents ? `sisu: ${truncate(contents, MAX_VALUE_CHARS)}` : null,
          a.name ? `nimi ${a.name}` : null,
        ].filter(Boolean).join(" · ");

        children.push(
          child(`pdf.annot.${n}.${annotationCount}`,
            `Lehekülg ${n}, märkus ${annotationCount}`,
            `Page ${n}, annotation ${annotationCount}`,
            detail || "märkus",
            "", "declared", 1),
        );
      }
    } catch {
      /* A page that will not open is a fact about the page, not a reason to
         abandon the other 63. */
      children.push(
        child(`pdf.annot.${n}.error`, `Lehekülg ${n}`, `Page ${n}`,
          "märkusi ei saanud lugeda", "", "repaired", 1),
      );
    } finally {
      await releasePage(page);
    }
  }

  const summary = [
    ...[...bySubtype].map(([k, v]) => `${k}: ${v}`),
  ];

  ctx.emitNode(
    node({
      id: "pdf.annotations",
      group: "structure",
      labelEt: "Märkused",
      labelEn: "Annotations",
      value: annotationCount === 0
        ? "pole"
        : annotationCount + " märkust" + (truncated ? ` (esimene ${pagesToRead} lehekülge ${total}-st)` : ""),
      children: [
        ...(summary.length
          ? [child("pdf.annot.summary", "Tüüpide kaupa", "By subtype", summary.join(", "))]
          : []),
        ...(byAuthor.size
          ? [child("pdf.annot.authors", "Autorid", "Authors",
              [...byAuthor].map(([a, n]) => `${truncate(a, 60)}: ${n}`).join(", "))]
          : []),
        ...children,
      ],
    }),
  );
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function child(id, labelEt, labelEn, value, raw, confidence, depth) {
  return node({ id, group: "structure", labelEt, labelEn, value, raw, confidence, depth: depth ?? 1 });
}

function truncate(text, max = MAX_VALUE_CHARS) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}… (${value.length} märki)` : value;
}