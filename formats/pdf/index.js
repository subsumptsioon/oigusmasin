// ── formats/pdf/index.js ──────────────────────────────────────────────────────
// The PDF container analyser.
//
// Phase 5: the raw byte layer. `raw.js` reads what the file says about itself —
// header, revision chain, cross-reference table, Info dictionary, XMP packet —
// and this file decides how that reaches the visitor. The split is deliberate:
// the scanner has no Estonian in it and no opinion about layout, and this file
// has no byte handling in it. A change to either does not reach the other.
//
// Phase 6 adds the extensions — xref streams, object streams, filters,
// encryption flags, date and string decoding, and the repair mode that scans for
// `N G obj` when the table lies. `structure.js` adds the pdf.js layer in
// phase 7. Both register against the same context object, so nothing above this
// line changes when they land.
// ─────────────────────────────────────────────────────────────────────────────

import { node, formatValue } from "../node.js";
import { parseDate } from "./encoding.js";
import { scan } from "./raw.js";
import { compareWithInfo, parsePacket } from "./xmp.js";
import { listFonts } from "./fonts.js";
import { listImages } from "./images.js";
import { analyseStructure } from "./structure.js";

/** How much of the raw XMP packet to keep on the node.
 *
 *  A packet can be large, and it is copied into the DOM once per keystroke of
 *  the search box. The full length is always reported next to the excerpt, so
 *  nothing is hidden by the cap — it is a display limit, not a read limit. */
const MAX_XMP_RAW = 20_000;

export const analyser = {
  id: "pdf",
  labelEt: "PDF",

  async analyse(bytes, ctx) {
    const found = await scan(bytes, { limits: ctx.limits, clock: ctx.clock });

    ctx.emitNode(headerNode(found));

    /* Notes first. A file that could not be fully read has to say so before any
       number derived from it, or the visitor reads a confident partial table and
       believes it is the whole file. */
    for (const note of found.notes) {
      ctx.reportError(note.messageEt, note.code);
    }

    if (!found.revisions.length) {
      /* No usable cross-reference table. The header row, the notes and — above
         all — the repair scan are the findings here, and the repair scan is the
         one a visitor most needs: it is what says the file's objects *were*
         found despite the table being unreadable.

         An earlier draft returned without it, which meant the one file class
         where rebuilding the object map is the entire point showed nothing about
         having been rebuilt. The scan runs regardless of the table, so it is
         emitted here too. */
      emitInfo(ctx, found.info);
      emitXmp(ctx, found.xmp);
    emitXmpParsed(ctx, found);
      emitEncryption(ctx, found.encryption);
      emitRepair(ctx, found.repaired);
      /* pdf.js reconstructs broken references itself, so on precisely the files
         our own table reader gave up on, its reading is the one that still
         works. That is the second reason to run both layers. */
      await analyseStructure(bytes, ctx, found.catalog);
      return { nodes: [], blobs: [] };
    }

    ctx.emitNode(revisionNode(found));
    ctx.emitNode(markerNode(found.markers));
    ctx.emitNode(ambiguousNode(found.markers));

    for (const revision of found.revisions) {
      ctx.emitNode(revisionDetailNode(revision, found.revisions.length));
    }

    emitInfo(ctx, found.info);
    emitXmp(ctx, found.xmp);
    emitXmpParsed(ctx, found);
    emitEncryption(ctx, found.encryption);
    emitChanges(ctx, found.comparison);
    emitRepair(ctx, found.repaired);

    /* The pdf.js layer runs last and independently.
     *
     * Order is deliberate. `raw.js` is the file's own account of itself and
     * works even when the cross-reference table is broken; `structure.js` is
     * pdf.js's reading, which needs the references to resolve. Running the raw
     * layer first means a file pdf.js cannot open still shows its header,
     * markers, Info dictionary and repair scan — and `structure.js` reports its
     * own failure through `ctx.reportError` rather than throwing, so the two
     * layers degrade independently. That independence is the whole argument for
     * having written our own parser. */
    await analyseStructure(bytes, ctx, found.catalog);

    /* Fonts and images last, because both need the object resolver and both
       are the most expensive walk in the project — every page's /Resources and
       every XObject. Running them after the cheap layers means a visitor sees
       the page count and the Info dictionary before this work starts. */
    emitFonts(ctx, await listFonts(found.resolver));
    const pictures = await listImages(found.resolver, bytes, { limits: ctx.limits, clock: ctx.clock });
    emitImages(ctx, pictures.images, pictures.blobs, pictures.skipped);

    /* The blobs go back to the registry, which hands each one to the stage-3
       analyser registered for its media type. That analyser is the same module
       a visitor reaches by selecting the JPEG directly. */
    return { nodes: [], blobs: pictures.blobs };
  },
};

/* ── Header ───────────────────────────────────────────────────────────────── */

/** The header, and where it was found.
 *
 *  The offset is shown even when it is 0, because a reader who has been told a
 *  file has junk before its header can see that here rather than inferring it
 *  from every wrong offset in the table. */
function headerNode(found) {
  const header = found.header;
  const children = [];

  if (header?.found) {
    children.push(
      child("pdf.headerOffset", "Päise asukoht", "Header offset", `${header.offset} B`),
    );
    if (header.version) {
      children.push(child("pdf.headerVersion", "Päiseversioon", "Header version", header.version));
    }
    if (header.malformed) {
      /* "vigane päise" rather than "jah". The original stub said it, and the
         rewrite nearly dropped it for a boolean — which is a worse label in
         Estonian and says less about what is wrong with the file. */
      children.push(
        child("pdf.headerMalformed", "Päis", "Header", "vigane päise", header.version ?? "", "repaired"),
      );
    }
  } else {
    children.push(
      child(
        "pdf.headerMissing",
        "Päise asukoht",
        "Header offset",
        "ei leitud esimese 1024 baidi seest",
        "",
        "absent",
      ),
    );
  }

  return node({
    id: "pdf.header",
    group: "raw",
    labelEt: "Päis",
    labelEn: "Header",
    value: "",
    children,
  });
}

/* ── Revisions ────────────────────────────────────────────────────────────── */

/** The summary row: how many revisions, how many objects, whether encrypted. */
function revisionNode(found) {
  const revisions = found.revisions;
  const current = revisions[0];
  const objects = revisions.reduce((sum, r) => sum + (r.inUse ?? 0), 0);
  const free = revisions.reduce((sum, r) => sum + (r.free ?? 0), 0);

  return node({
    id: "pdf.revisions",
    group: "revisions",
    labelEt: "Versioonid",
    labelEn: "Revisions",
    value:
      revisions.length === 1
        ? "üks versioon"
        : `${revisions.length} versiooni`,
    children: [
      child("pdf.revisionCount", "Versioonide arv", "Revision count", String(revisions.length)),
      child("pdf.xrefKind", "Ristviidestiku vorm", "Cross-reference form",
        current.kind === "classic" ? "klassikaline tabel" : current.kind === "stream" ? "ristviidevoog" : current.kind),
      child("pdf.objectCount", "Objektide arv", "Object count", String(objects)),
      child("pdf.freeCount", "Vabaks märgitud objektid", "Free objects", String(free)),
      current.hasEncrypt
        ? child("pdf.encrypted", "Krüpteerimine", "Encryption", "/Encrypt leitud", "", "declared")
        : child("pdf.encrypted", "Krüpteerimine", "Encryption", "pole", "", "absent"),
      current.xrefStm
        ? child("pdf.hybrid", "Hübriidfail", "Hybrid file", "/XRefStm leitud", "", "declared")
        : child("pdf.hybrid", "Hübriidfail", "Hybrid file", "pole", "", "absent"),
    ],
  });
}

/** One row per revision, newest first — the order a reader would meet them. */
function revisionDetailNode(revision, total) {
  const children = [
    child("pdf.revXrefOffset", "Ristviidetabeli asukoht", "Cross-reference offset", `${revision.xrefOffset} B`),
    child("pdf.revInUse", "Kasutatud kirjeid", "In-use entries", String(revision.inUse)),
    child("pdf.revFree", "Vabu kirjeid", "Free entries", String(revision.free)),
    child("pdf.revObjects", "Objekte kokku", "Objects total", String(revision.objectCount)),
  ];

  if (revision.declaredSize !== null && revision.declaredSize !== undefined) {
    children.push(
      child("pdf.revSize", "/Size", "/Size", String(revision.declaredSize)),
    );
  }
  if (revision.prev !== null && revision.prev !== undefined) {
    children.push(child("pdf.revPrev", "/Prev", "/Prev", `${revision.prev} B`));
  }
  if (revision.root) {
    children.push(child("pdf.revRoot", "/Root", "/Root", describeRef(revision.root)));
  }
  if (revision.info) {
    children.push(child("pdf.revInfo", "/Info", "/Info", describeRef(revision.info)));
  }
  if (revision.id) {
    children.push(child("pdf.revId", "/ID", "/ID", describeId(revision.id)));
  }
  children.push(
    child(
      "pdf.revIsCurrent",
      "Võrreldav versioon",
      "Compared revision",
      revision.index === 0 ? "praegune" : total > 1 ? `eelmine (${total} versiooni)` : "",
    ),
  );

  return node({
    id: `pdf.revision.${revision.index}`,
    group: "revisions",
    labelEt: total > 1 ? `Versioon ${revision.index + 1}` : "Versioon 1",
    labelEn: `Revision ${revision.index + 1}`,
    value: "",
    children,
  });
}

/* ── Markers ──────────────────────────────────────────────────────────────── */

/** The structural markers — the ones that count.
 *
 *  Offsets are shown because §5.2's promise is that a visitor can check them
 *  against a hex editor. Showing only the count would make that impossible. */
function markerNode(markers) {
  const children = [];

  const startxrefs = markers.startxref.filter((m) => m.structural);
  children.push(
    child("pdf.startxrefCount", "startxref-viidid", "startxref pointers", String(startxrefs.length)),
  );
  for (const m of startxrefs) {
    children.push(
      child(`pdf.startxref.${m.offset}`, "startxref-viit", "startxref pointer",
        `asukoht ${m.offset} B → ristviidestik ${m.target} B`, m.context.printable, "declared", 1),
    );
  }

  const eofs = markers.eof.filter((m) => m.structural);
  children.push(child("pdf.eofCount", "%%EOF-märgid", "%%EOF markers", String(eofs.length)));
  for (const m of eofs) {
    children.push(
      child(`pdf.eof.${m.offset}`, "%%EOF-märk", "%%EOF marker", `asukoht ${m.offset} B`, m.context.printable, "declared", 1),
    );
  }

  const xrefs = markers.xref.filter((m) => m.structural);
  children.push(child("pdf.xrefCount", "xref-tabelid", "xref tables", String(xrefs.length)));
  for (const m of xrefs) {
    children.push(
      child(`pdf.xref.${m.offset}`, "xref-tabel", "xref table", `asukoht ${m.offset} B`, m.context.printable, "declared", 1),
    );
  }

  if (markers.truncated) {
    children.push(
      child("pdf.markersTruncated", "Märgistik loetud", "Marker list truncated",
        "osalist loendit, märke on rohkem kui loendis", "", "repaired"),
    );
  }

  return node({
    id: "pdf.markers",
    group: "raw",
    labelEt: "Struktuurimärgid",
    labelEn: "Structural markers",
    value: "",
    children,
  });
}

/** The unverified candidates.
 *
 *  This row exists because §5.2 asks for it explicitly, and it is the row that
 *  proves the classification is doing something: a file whose streams contain the
 *  word `xref` shows one structural match here and several non-structural ones,
 *  side by side, with the reason each was rejected. */
function ambiguousNode(markers) {
  const ambiguous = [
    ...markers.xref.filter((m) => !m.structural).map((m) => ({ ...m, kind: "xref" })),
    ...markers.startxref.filter((m) => !m.structural).map((m) => ({ ...m, kind: "startxref" })),
    ...markers.eof.filter((m) => !m.structural).map((m) => ({ ...m, kind: "%%EOF" })),
  ];

  const children = [
    child("pdf.ambiguousCount", "Kahtlased kandidaadid", "Ambiguous candidates", String(ambiguous.length)),
  ];

  for (const m of ambiguous) {
    const why = m.kind === "xref" ? m.reason : m.atLineStart ? "pole struktuurne" : "rea alguses mitte";
    children.push(
      child(
        `pdf.ambiguous.${m.kind}.${m.offset}`,
        `${m.kind} asukohal ${m.offset} B`,
        `${m.kind} at ${m.offset}`,
        `hinnatud kahtlaseks: ${why}`,
        m.context.hex,
        "repaired",
        1,
      ),
    );
  }

  return node({
    id: "pdf.ambiguous",
    group: "raw",
    labelEt: "Kahtlased kandidaadid",
    labelEn: "Ambiguous candidates",
    value: ambiguous.length === 0 ? "pole" : String(ambiguous.length),
    children,
  });
}

/* ── Info ─────────────────────────────────────────────────────────────────── */

function emitInfo(ctx, info) {
  if (!info?.present) {
    ctx.emitNode(
      node({
        id: "pdf.info",
        group: "info",
        labelEt: "Infodiktsioon",
        labelEn: "Info dictionary",
        value: info?.reason ?? "pole",
        confidence: "absent",
      }),
    );
    return;
  }

  /* Every Info field goes through `presentValue`, which is where decoding
     happens. The rule it follows: **the raw text stays, and the decoded reading
     is added beside it.** §5.2 asks for the original beside the converted value
     for dates, and the same principle is applied to strings — a name written in
     UTF-16 and a name written in PDFDocEncoding are the same name, but a reader
     looking at the bytes needs to see which it was, and a reader who distrusts
     the decoder needs the original.

     The one thing never shown alone is a decoded value with no indication of how
     it was decoded. §11's over-claiming rule applies to encodings exactly as it
     applies to offsets. */
  const children = info.fields.map((f) => {
    const shown = presentValue(f);
    return child(
      `pdf.info.${f.key}`,
      f.key,
      f.key,
      shown.value,
      f.raw,
      shown.confidence,
      1,
    );
  });

  const where = info.packedIn
    ? `objekt ${info.refNum}, ${info.provenance}`
    : `objekt ${info.refNum}, asukoht ${info.offset} B`;

  ctx.emitNode(
    node({
      id: "pdf.info",
      group: "info",
      labelEt: "Infodiktsioon",
      labelEn: "Info dictionary",
      value: where,
      raw: info.raw,
      children,
    }),
  );
}

/** `Im1 (lehekülg 3)`, or just `Im1` on a single-page document.
 *
 *  Written as a helper rather than a nested template literal because a template
 *  inside `${}` defeats the language checker's string stripper — the Estonian
 *  inside it is then invisible to the rule that Estonian belongs in strings. */
function withPage(name, word, page) {
  return page ? name + " (" + word + " " + page + ")" : name;
}

/* ── Fonts ────────────────────────────────────────────────────────────────────
   §5.5's table, one row per font, grouped so a document with twelve fonts does
   not produce a wall.

   The grouping is by *embedding*, because that is the question a reader has:
   fonts the file carries render everywhere; fonts it only names render only
   where they are installed. That is why embedded and non-embedded fonts are
   separate rows rather than one list with a column. */

function emitFonts(ctx, fonts) {
  const children = [];

  if (!fonts.length) {
    ctx.emitNode(
      node({
        id: "pdf.fonts",
        group: "fonts",
        labelEt: "Kirjatüübid",
        labelEn: "Fonts",
        value: "ühtegi pole",
        confidence: "absent",
      }),
    );
    return;
  }

  const embedded = fonts.filter((f) => f.embedded);
  const named = fonts.filter((f) => !f.embedded);

  children.push(
    child("pdf.fonts.total", "Kirjatüüpe kokku", "Fonts total", String(fonts.length)),
    child("pdf.fonts.embedded", "Manustatud", "Embedded", `${embedded.length} / ${fonts.length}`),
    child("pdf.fonts.subsets", "Alahulgud", "Subsets",
      `${fonts.filter((f) => f.subset).length} alamhulka`),
  );

  for (const font of fonts) {
    const childrenOfFont = [
      child(`pdf.font.${font.resourceName}.name`, "Põhinimi", "Base font",
        font.baseFont ?? "(nimetuseta)", font.baseFontFrom ?? ""),
      child(`pdf.font.${font.resourceName}.type`, "Tüüp", "Type", font.subtype ?? "pole"),
      child(`pdf.font.${font.resourceName}.embedded`, "Manustatud", "Embedded",
        font.embedded
          ? `jah (${font.embedding.program})`
          : `ei — ${font.embedding.reason}`,
        font.embedding.key ?? ""),
    ];

    if (font.subset) {
      childrenOfFont.push(
        child(`pdf.font.${font.resourceName}.subset`, "Alahulk", "Subset", "jah (prefiks +)", "", "declared", 1),
      );
    }
    if (font.encoding) {
      childrenOfFont.push(
        child(`pdf.font.${font.resourceName}.encoding`, "Kodeering", "Encoding", font.encoding),
      );
    }
    if (font.embedding.declaredBytes != null) {
      childrenOfFont.push(
        child(`pdf.font.${font.resourceName}.bytes`, "Talletatud pikkus", "Stored length",
          `${font.embedding.declaredBytes} B`),
      );
    }
    if (font.toUnicode) {
      childrenOfFont.push(
        child(`pdf.font.${font.resourceName}.tounicode`, "/ToUnicode", "/ToUnicode", "olemas"),
      );
    }

    children.push(
      child(
        `pdf.font.${font.resourceName}`,
        `${font.resourceName}: ${font.baseFont ?? "nimetuseta"}`,
        `${font.resourceName}: ${font.baseFont ?? "unnamed"}`,
        font.embedded ? "manustatud" : "nimetatud, mitte manustatud",
        font.subtype ?? "",
        font.embedded ? "declared" : "absent",
        1,
      ),
    );
    /* The per-font detail hangs off a flat sibling so the renderer needs no
       nested-tree support (§4.3 keeps `children` flat and expresses depth by
       indentation). */
    children.push(...childrenOfFont.map((c) => ({ ...c, depth: 2 })));
  }

  ctx.emitNode(
    node({
      id: "pdf.fonts",
      group: "fonts",
      labelEt: "Kirjatüübid",
      labelEn: "Fonts",
      value: `${fonts.length} kirjatüüpi — ${embedded.length} manustatud`,
      children,
    }),
  );
}

/* ── Images ───────────────────────────────────────────────────────────────── */

/** Images, and what happened to each one.
 *
 *  The value line states plainly how many were *handed on* to the stage-3
 *  analyser as well as how many were found. A document with forty images where
 *  two were readable says so, rather than showing a list of forty rows and
 *  leaving the visitor to work out which two meant anything. */
function emitImages(ctx, images, blobs, skipped) {
  const children = [];

  if (!images.length) {
    ctx.emitNode(
      node({
        id: "pdf.images",
        group: "fonts",
        labelEt: "Pildid",
        labelEn: "Images",
        value: "pole",
        confidence: "absent",
      }),
    );
    return;
  }

  const analysed = blobs.filter((b) => b.analysedBy).length;

  children.push(
    child("pdf.images.total", "Pildid kokku", "Images total", String(images.length)),
    child("pdf.images.blobs", "Edasi antud JPEG-e", "JPEGs handed on", `${analysed} / ${images.length}`),
  );

  if (skipped.length) {
    children.push(
      child("pdf.images.skipped", "Edasi ei antud", "Not handed on",
        `${skipped.length} pilti`, skipped.slice(0, 5).map((s) => `${s.name}: ${s.reason}`).join(" · ")),
    );
  }

  for (const image of images) {
    const detail = [
      image.width && image.height ? `${image.width} × ${image.height} px` : null,
      image.colourSpace,
      image.bitsPerComponent ? `${image.bitsPerComponent} bitti komponendi kohta` : null,
      image.filters.length ? `filter: ${image.filters.join(", ")}` : "filtreita",
      image.storedBytes != null ? `talletatud ${image.storedBytes} B` : null,
      image.imageBytes ? "edasi antud EXIF-ile" : null,
    ].filter(Boolean).join(" · ");

    children.push(
      child(
        `pdf.image.${image.resourceName}`,
        withPage(image.resourceName, "lehekülg", image.page),
        withPage(image.resourceName, "page", image.page),
        detail,
        "",
        image.imageBytes ? "declared" : "absent",
        1,
      ),
    );
  }

  ctx.emitNode(
    node({
      id: "pdf.images",
      group: "fonts",
      labelEt: "Pildid",
      labelEn: "Images",
      value: `${images.length} pilti — ${analysed} JPEG-i analüüsiti`,
      children,
    }),
  );
}

/* ── XMP ──────────────────────────────────────────────────────────────────── */

/** The raw XMP packet.
 *
 *  The packet is shown as text and not parsed. Parsing it is phase 8, and the
 *  reason is §5.4: `DOMParser` does not resolve prefixes, so a namespace-blind
 *  parse silently drops exactly the fields this tool exists to show. Until that
 *  layer exists the honest presentation is the bytes the file actually contains.
 *
 *  `raw` is capped on the node, not on the file. A multi-megabyte packet would
 *  otherwise be copied into the DOM for every keystroke of the search box, and
 *  the visitor can already read the whole packet in the metadata stream. */
function emitXmp(ctx, xmp) {
  const MAX_RAW = 20_000;

  if (!xmp?.present) {
    ctx.emitNode(
      node({
        id: "pdf.xmp",
        group: "info",
        labelEt: "XMP-pakett",
        labelEn: "XMP packet",
        value: xmp?.reason ?? "pole",
        confidence: "absent",
      }),
    );
    return;
  }

  const body = xmp.raw.length > MAX_RAW
    ? `${xmp.raw.slice(0, MAX_RAW)}\n… (${xmp.length - MAX_RAW} B veel)`
    : xmp.raw;

  ctx.emitNode(
    node({
      id: "pdf.xmp",
      group: "info",
      labelEt: "XMP-pakett",
      labelEn: "XMP packet",
      value: `asukoht ${xmp.offset} B, ${xmp.length} B${xmp.truncated ? ", katkend" : ""}`,
      raw: body,
      children: [
        child("pdf.xmp.length", "Paketi pikkus", "Packet length", `${xmp.length} B`),
        child("pdf.xmp.terminator", "Lõpetaja", "Terminator",
          xmp.terminator ?? "puudub", "", xmp.terminator === "xpacket" ? "declared" : "repaired"),
      ],
    }),
  );
}

/* ── Decoding for display ──────────────────────────────────────────────────── */

/** How one Info value should read on the page.
 *
 *  Three cases, and the choice between them is the whole point of phase 6:
 *
 *  - A **date** gets the converted value, the original, and the precision the
 *    file declared. `D:2024` is a year, not 1 January, and saying "2024-01-01"
 *    without that caveat is a false statement about the document.
 *  - A **string** gets its decoded text and, when the decoding was not the
 *    plain default, a note saying how it was read.
 *  - Everything else is shown as the file wrote it.
 *
 *  A date with a known producer bug — local time marked `Z` — keeps the
 *  confidence at *deklareritud* and carries the caveat in the text rather than
 *  being downgraded to *parandatud*, because the file did declare it. Repairing
 *  it would mean guessing an offset, and a guessed offset presented as a reading
 *  is the exact failure §11 exists to prevent. */
function presentValue(field) {
  const DATE_KEYS = new Set(["CreationDate", "ModDate"]);

  if (DATE_KEYS.has(field.key) && typeof field.text === "string") {
    const parsed = parseDate(field.text);
    if (!parsed.date) {
      /* No date, but a reason. An unparseable date is a finding, not a blank. */
      const note = parsed.issues.length ? ` (${parsed.issues.join(" ")})` : "";
      return {
        value: parsed.iso ? `${parsed.iso} — ei saa üheselt määrata${note}` : `${field.text}${note}`,
        confidence: "declared",
      };
    }
    const caveat = parsed.issues.length ? ` (${parsed.issues.join(" ")})` : "";
    return {
      value: `${formatValue(parsed.date)} — ${parsed.original} (täpsus: ${parsed.precision})${caveat}`,
      confidence: "declared",
    };
  }

  return { value: field.text, confidence: "declared" };
}

/** The XMP packet, parsed.
 *
 *  Phase 7 showed the raw packet and nothing else, with a comment saying parsing
 *  was phase 8's job because `DOMParser` does not resolve prefixes. That is
 *  still true — and `xmp.js` does not try to. It walks `namespaceURI` +
 *  `localName`, so a producer that writes `dc15:title` is read correctly, and one
 *  that invents a namespace is shown rather than dropped.
 *
 *  Three sources are tried in order, and which one answered is reported:
 *
 *   1. the **metadata stream**, which is where a modern producer puts it and the
 *      only route that works for a compressed packet;
 *   2. the **raw byte scan** from phase 5, which finds an uncompressed packet
 *      the catalog does not name;
 *   3. neither, which is reported as absent rather than as empty.
 *
 *  A packet that fails to parse is a finding. The raw text is still shown
 *  beside it, because the interesting thing about a malformed packet is usually
 *  what it says. */
function emitXmpParsed(ctx, found) {
  const stream = found.catalog?.metadata ?? null;
  const rawScan = found.xmp ?? null;

  const bytes = stream?.bytes ?? null;
  const parsed = bytes ? parsePacket(bytes) : null;

  if (!stream && !rawScan?.present) {
    ctx.emitNode(
      node({
        id: "pdf.xmp.parsed",
        group: "info",
        labelEt: "XMP-andmed",
        labelEn: "XMP properties",
        value: "pakett puudub",
        confidence: "absent",
      }),
    );
    return;
  }

  if (!stream && rawScan?.present) {
    /* Found by scanning the bytes, so the catalog never named it. Parsing the
       text is still worth doing — it costs nothing, and it may recover a packet
       that a compressed stream would have hidden. */
    const scanned = parsePacket(rawScan.raw);

    if (!scanned.ok) {
      ctx.emitNode(
        node({
          id: "pdf.xmp.parsed",
          group: "info",
          labelEt: "XMP-andmed",
          labelEn: "XMP properties",
          value: scanned.reason ?? "pakett ei ole loetav",
          raw: (rawScan.raw ?? "").slice(0, MAX_XMP_RAW),
          confidence: "repaired",
          children: [
            child("pdf.xmp.encoding", "Teksti kodeering", "Text encoding", scanned.encoding ?? "pole teada"),
            child("pdf.xmp.source", "Allikas", "Source",
              `otsing failist asukohal ${rawScan.offset} B — kataloog ei nimeta /Metadata-d`),
          ],
        }),
      );
      return;
    }

    ctx.emitNode(
      node({
        id: "pdf.xmp.parsed",
        group: "info",
        labelEt: "XMP-andmed",
        labelEn: "XMP properties",
        value: `${scanned.properties.length} omadust — leitud ainult otsinguga`,
        raw: (rawScan.raw ?? "").slice(0, MAX_XMP_RAW),
        confidence: "repaired",
        children: [
          child("pdf.xmp.encoding", "Teksti kodeering", "Text encoding", scanned.encoding),
          child("pdf.xmp.source", "Allikas", "Source",
            `otsing failist asukohal ${rawScan.offset} B — kataloog ei nimeta /Metadata-d`),
          ...namespaceChildren(scanned),
          ...conformanceChildren(scanned.conformance),
          ...wellKnownChildren(scanned.wellKnown),
          ...historyChildren(scanned.history),
          ...propertyChildren(scanned.properties),
        ],
      }),
    );
    emitXmpConflicts(ctx, found, scanned);
    return;
  }

  const source = [];
  if (stream) {
    source.push(`voog, objekt ${stream.refNum} (${stream.storedBytes} B -> ${stream.decodedBytes} B)`);
    if (stream.appliedFilters?.length) source.push(`filtrid: ${stream.appliedFilters.join(", ")}`);
  }

  if (!parsed?.ok) {
    ctx.emitNode(
      node({
        id: "pdf.xmp.parsed",
        group: "info",
        labelEt: "XMP-andmed",
        labelEn: "XMP properties",
        value: parsed?.reason ?? "pakett ei ole loetav",
        raw: (parsed?.raw ?? "").slice(0, MAX_XMP_RAW),
        confidence: "repaired",
        children: [
          child("pdf.xmp.encoding", "Teksti kodeering", "Text encoding", parsed?.encoding ?? "pole teada"),
          ...(source.length ? [child("pdf.xmp.source", "Allikas", "Source", source.join(" · "))] : []),
        ],
      }),
    );
    return;
  }

  const children = [
    child("pdf.xmp.encoding", "Teksti kodeering", "Text encoding", parsed.encoding),
    ...(source.length ? [child("pdf.xmp.source", "Allikas", "Source", source.join(" · "))] : []),
    ...namespaceChildren(parsed),
    ...conformanceChildren(parsed.conformance),
    ...wellKnownChildren(parsed.wellKnown),
    ...historyChildren(parsed.history),
    ...propertyChildren(parsed.properties),
  ];

  ctx.emitNode(
    node({
      id: "pdf.xmp.parsed",
      group: "info",
      labelEt: "XMP-andmed",
      labelEn: "XMP properties",
      value: `${parsed.properties.length} omadust ${parsed.namespaces.length} nimeruumist`,
      raw: (parsed.raw ?? "").slice(0, MAX_XMP_RAW),
      children,
    }),
  );

  emitXmpConflicts(ctx, found, parsed);
}

/** The namespaces, with the ones §5.4 names first and the rest after them.
 *
 *  An unknown namespace appearing here is the feature working: a hard-coded
 *  namespace list would have dropped it, and this file would then have nothing
 *  to say about a field the producer put in it. */
function namespaceChildren(parsed) {
  const known = new Set(["dc", "xmp", "pdf", "xmpMM", "pdfaid", "pdfxid"]);
  const sorted = [...parsed.namespaces].sort((a, b) => {
    const aKnown = known.has(a.prefix) ? 1 : 0;
    const bKnown = known.has(b.prefix) ? 1 : 0;
    return bKnown - aKnown || b.count - a.count;
  });
  return [
    child("pdf.xmp.ns.count", "Nimeruumide arv", "Namespace count", String(sorted.length)),
    ...sorted.map((n) =>
      child(
        `pdf.xmp.ns.${n.prefix}`,
        `${n.prefix} (${n.count})`,
        n.prefix,
        n.uri,
        "",
        known.has(n.prefix) ? "declared" : "repaired",
        1,
      ),
    ),
  ];
}

/** PDF/A and PDF/X conformance identifiers.
 *
 *  These are a *claim* the file makes about itself. Section 5.4 calls them the
 *  conformance identifiers, and the wording here says "the file declares this"
 *  rather than "this file is", because verifying PDF/A properly needs an
 *  independent validator and this page is not one. Reporting it as fact would be
 *  the over-claiming that §11 forbids. */
function conformanceChildren(conformance) {
  const rows = [];
  if (conformance.pdfaPart || conformance.pdfaConformance) {
    rows.push(
      child("pdf.xmp.pdfa", "PDF/A", "PDF/A",
        `osa ${conformance.pdfaPart ?? "?"} · vastavus ${conformance.pdfaConformance ?? "?"} — fail väitab seda`,
        "", "declared"),
    );
  }
  if (conformance.pdfxVersion || conformance.pdfxConformance) {
    rows.push(
      child("pdf.xmp.pdfx", "PDF/X", "PDF/X",
        (conformance.pdfxVersion ?? "?") + " · " + (conformance.pdfxConformance ?? "?") + " — fail väitab seda",
        "", "declared"),
    );
  }
  if (!rows.length) {
    rows.push(child("pdf.xmp.conformance", "Vastavusnäitajad", "Conformance identifiers", "pole"));
  }
  return rows;
}

function wellKnownChildren(known) {
  const rows = [];
  const add = (id, labelEt, labelEn, value) => {
    if (value) rows.push(child(`pdf.xmp.${id}`, labelEt, labelEn, value));
  };
  add("creatorTool", "Vahend (CreatorTool)", "Creator tool", known.creatorTool);
  add("documentId", "DocumentID", "DocumentID", known.documentId);
  add("instanceId", "InstanceID", "InstanceID", known.instanceId);
  return rows;
}

/** `xmpMM:History`, in file order — oldest first, which is the order it happened
 *  in. Reversing it would make an edit log read backwards. */
function historyChildren(history) {
  if (!history.length) {
    return [child("pdf.xmp.history", "Muudatuslogi", "Edit history", "pole")];
  }
  return [
    child("pdf.xmp.history.count", "Muudatuslogi", "Edit history", history.length + " sündmust"),
    ...history.map((event, i) =>
      child(
        `pdf.xmp.history.${i}`,
        `${i + 1}. ${event.action ?? "teadmata"}`,
        `${i + 1}. ${event.action ?? "unknown"}`,
        [event.when, event.agent, event.instanceId].filter(Boolean).join(" · "),
        event.formattedDate ?? "",
        "declared",
        1,
      ),
    ),
  ];
}

/** Every property, including the ones this project has never heard of. */
function propertyChildren(properties) {
  return [
    child("pdf.xmp.props.count", "Omadusi kokku", "Properties total", String(properties.length)),
    ...properties.map((p) =>
      child(
        `pdf.xmp.prop.${p.index}`,
        p.qualified,
        p.local,
        p.value || (p.attributes.length ? p.attributes.map((a) => `${a.name}=${a.value}`).join(" ") : "(tühi)"),
        p.attributes.map((a) => `${a.name}="${a.value}"`).join(" "),
        "declared",
        1,
      ),
    ),
  ];
}

/** Info against XMP.
 *
 *  §5.4 calls these *vastuolu* — disagreements — and the row is labelled with
 *  that word rather than with "error". Two dictionaries in one file disagreeing
 *  is a fact about the file, not a fault in it: plenty of documents were written
 *  by tools that updated `/Info` and left XMP behind, and the disagreement is
 *  precisely what someone examining the file wants to see.
 *
 *  Both values are shown. Nothing is resolved, because §11 requires that a
 *  conflict between two sources be surfaced rather than silently decided. */
function emitXmpConflicts(ctx, found, parsed) {
  const result = compareWithInfo(parsed, found.info?.fields);

  if (!result.available) {
    ctx.emitNode(
      node({
        id: "pdf.xmp.conflicts",
        group: "info",
        labelEt: "Info ja XMP vastuolu",
        labelEn: "Info and XMP disagreement",
        value: "pole võrreldavat Infodiktsiooni",
        confidence: "absent",
      }),
    );
    return;
  }

  if (!result.disagreements.length) {
    ctx.emitNode(
      node({
        id: "pdf.xmp.conflicts",
        group: "info",
        labelEt: "Info ja XMP vastuolu",
        labelEn: "Info and XMP disagreement",
        value: "pole",
        confidence: "declared",
      }),
    );
    return;
  }

  ctx.emitNode(
    node({
      id: "pdf.xmp.conflicts",
      group: "info",
      labelEt: "Info ja XMP vastuolu",
      labelEn: "Info and XMP disagreement",
      value: `${result.disagreements.length} vastuolu`,
      children: result.disagreements.map((d) =>
        child(
          `pdf.xmp.conflict.${d.key}`,
          d.key,
          d.key,
          `Info: „${d.info}” — XMP: „${d.xmp}”`,
          d.kind === "kuupäev" ? "kuupäevade võrdlus hetkena" : "tekstide võrdlus",
          "repaired",
          1,
        ),
      ),
    }),
  );
}


/* ── Encryption ─────────────────────────────────────────────────────────────── */

/** The encryption row.
 *
 *  The permission list is the point. §5.2 asks for the flags decoded, and it
 *  asks in the same breath for the interface to state what stays readable — and
 *  those two halves are the reason this row exists at all. An encrypted file
 *  whose metadata table is empty tells the visitor nothing about whether the
 *  document was protected or merely unreadable; the flags answer that, and the
 *  summary line says which parts of the file those flags actually govern. */
function emitEncryption(ctx, encryption) {
  if (!encryption?.present) {
    ctx.emitNode(
      node({
        id: "pdf.encryption",
        group: "info",
        labelEt: "Krüpteerimine",
        labelEn: "Encryption",
        value: "pole",
        confidence: "absent",
      }),
    );
    return;
  }

  if (!encryption.readable) {
    ctx.emitNode(
      node({
        id: "pdf.encryption",
        group: "info",
        labelEt: "Krüpteerimine",
        labelEn: "Encryption",
        value: encryption.reason ?? "/Encrypt leitud",
        confidence: "unreadable",
      }),
    );
    return;
  }

  const children = [
    child("pdf.encrypt.version", "Algoritmi versioon", "Algorithm version", `V ${encryption.version ?? "pole"}`),
    child("pdf.encrypt.revision", "Revisioon", "Revision", `R ${encryption.revision ?? "pole"}`),
    child("pdf.encrypt.keyLength", "Võtme pikkus", "Key length",
      encryption.keyLengthBits ? `${encryption.keyLengthBits} bitti` : "pole teada",
      encryption.keyLengthSource ?? ""),
    child("pdf.encrypt.filter", "Filter", "Filter", encryption.filter ?? "pole"),
  ];

  if (encryption.permissions) {
    for (const item of encryption.permissions.items) {
      children.push(
        child(
          `pdf.encrypt.perm.${item.key}`,
          item.labelEt,
          item.key,
          item.allowed ? "luba" : "keelatud",
          "",
          item.allowed ? "declared" : "absent",
        ),
      );
    }
    children.push(
      child("pdf.encrypt.perm.raw", "/P", "/P", String(encryption.permissions.raw)),
      child("pdf.encrypt.perm.reserved", "Reserveeritud bitid 7–8", "Reserved bits 7-8",
        encryption.permissions.reservedBitsValid ? "korrektsed" : "vigased",
        "", encryption.permissions.reservedBitsValid ? "declared" : "repaired"),
    );
  }

  children.push(
    child("pdf.encrypt.owner", "Omaniku parool", "Owner password",
      encryption.hasOwnerPasswordEntry ? "/O leitud" : "pole", ""),
    child("pdf.encrypt.user", "Kasutaja parool", "User password",
      encryption.hasUserPasswordEntry ? "/U leitud" : "pole", ""),
    child("pdf.encrypt.trailerId", "Traileri /ID", "Trailer /ID",
      encryption.trailerIdStillReadable ? "loetav" : "puudub", ""),
  );

  ctx.emitNode(
    node({
      id: "pdf.encryption",
      group: "info",
      labelEt: "Krüpteerimine",
      labelEn: "Encryption",
      value: encryption.readableSummary,
      raw: `V ${encryption.version} R ${encryption.revision}${encryption.keyLengthBits ? ` /Length ${encryption.keyLengthBits}` : ""}`,
      children,
    }),
  );
}

/* ── Revision changes ──────────────────────────────────────────────────────── */

/** What changed between revisions.
 *
 *  This is the row §5.2's revision chain exists to produce. Without it an
 *  incremental update is invisible: the file looks like a single document with a
 *  current `/Author`, and the older value — which may name a person who no longer
 *  has anything to do with it — is gone from the interface while remaining
 *  readable in the bytes.
 *
 *  Every change is *parandatud*-free and confidence-declared: this is what the
 *  file says, compared with what the file said before. No inference is involved,
 *  so nothing here claims to be repaired. */
function emitChanges(ctx, comparison) {
  if (!comparison?.available) {
    ctx.emitNode(
      node({
        id: "pdf.changes",
        group: "revisions",
        labelEt: "Muutused versioonide vahel",
        labelEn: "Changes between revisions",
        value: comparison?.reason ?? "pole",
        confidence: "absent",
      }),
    );
    return;
  }

  const VERB = {
    changed: "muutis",
    added: "lisas",
    removed: "eemaldas",
  };

  const children = comparison.changes.map((change) =>
    child(
      `pdf.change.${change.key}`,
      change.key,
      change.key,
      change.kind === "changed"
        ? `versioon ${change.fromRevision + 1} „${change.from}” → versioon 1 „${change.to}”`
        : change.kind === "added"
          ? `versioon ${change.fromRevision + 1} puudus, versioonis 1 „${change.to}”`
          : `versioonis 1 puudub, versioonis ${change.fromRevision + 1} „${change.from}”`,
      VERB[change.kind],
      "declared",
      1,
    ),
  );

  ctx.emitNode(
    node({
      id: "pdf.changes",
      group: "revisions",
      labelEt: "Muutused versioonide vahel",
      labelEn: "Changes between revisions",
      value: comparison.changes.length === 0
        ? "muutusi ei leitud"
        : `${comparison.changes.length} muutust ${comparison.revisionCount} versiooni vahel`,
      children,
    }),
  );
}

/* ── Repair ───────────────────────────────────────────────────────────────── */

/** The repair scan.
 *
 *  The label that matters here is **parandatud**, and it applies to the *scan*,
 *  never to the file. Nothing is written, nothing is fixed: the page has no
 *  export path and this module has no writer. What is reported is the evidence —
 *  what the table claimed, what the bytes contain, and where they disagree.
 *
 *  A file with no problems still gets the row, with "kooskõlas" and nothing
 *  under it. That is deliberate: §5.2 asks whether the file is consistent, and
 *  an absent row answers nothing while a present one answers "yes". */
function emitRepair(ctx, repaired) {
  if (!repaired?.available) return;

  const children = [
    child("pdf.repair.scanned", "Skaneeritud `N G obj` kirjeid", "Scanned N G obj records", String(repaired.scanned)),
    child("pdf.repair.objects", "Objekte leitud otsimisel", "Objects found by scanning", String(repaired.objectCount)),
    child("pdf.repair.consistent", "Ristviidestiku ja baitide kooskõla", "Table and bytes agree",
      repaired.tableBroken ? "ei kooskõlas" : "kooskõlas", "", repaired.tableBroken ? "repaired" : "declared"),
  ];

  for (const change of repaired.changed) {
    children.push(
      child(`pdf.repair.changed.${change.num}`, `Objekt ${change.num}`, `Object ${change.num}`,
        "fail ütleb " + change.declared + " B, otsing leidis " + change.found + " B", "", "repaired", 1),
    );
  }
  for (const num of repaired.missingFromScan) {
    children.push(
      child(`pdf.repair.missing.${num}`, `Objekt ${num}`, `Object ${num}`,
        "deklareritud, kuid otsing ei leidnud", "", "repaired", 1),
    );
  }
  /* A duplicate object number is the commonest sign of an incremental update
     written badly. Both offsets are shown, because "which one won" is not this
     tool's decision to make — a reader opening the file in a viewer sees what
     that viewer does with them, and the raw pair is the evidence. */
  for (const conflict of repaired.conflicts) {
    children.push(
      child(`pdf.repair.conflict.${conflict.num}`, `Objekt ${conflict.num} mitu korda`, `Object ${conflict.num} appears more than once`,
        `asukohad ${conflict.first} B ja ${conflict.second} B`, "", "repaired", 1),
    );
  }

  ctx.emitNode(
    node({
      id: "pdf.repair",
      group: "raw",
      labelEt: "Parandusrežiim",
      labelEn: "Repair mode",
      value: repaired.tableBroken
        ? "ristviidestik ei vasta faili baitidele; väärtused on parandatud"
        : "ristviidestik vastab faili baitidele",
      children,
    }),
  );
}

/* ── Node helpers ─────────────────────────────────────────────────────────── */

/** A field inside a row. One helper for all of them, so no node in this file
 *  can invent a shape the renderer does not know — §4.3 is a contract, and the
 *  cheapest way to keep it is to make the alternative require more typing. */
function child(id, labelEt, labelEn, value, raw, confidence, depth) {
  return node({ id, group: "raw", labelEt, labelEn, value, raw, confidence, depth: depth ?? 1 });
}

/** An indirect reference as `N G R`, or a plain description for anything else. */
function describeRef(value) {
  if (!value) return "puudub";
  if (value.type === "ref") return `${value.num} ${value.gen} R`;
  if (value.type === "number") return String(value.value);
  return value.raw ?? value.type;
}

/** `/ID` is a pair of byte strings. Shown as the file wrote them — hex-encoded
 *  if it wrote them hex — because the point of the value is that it is a hash
 *  the file asserts about itself, and reformatting it would hide the difference
 *  between a 16-byte ID and a 32-byte one. */
function describeId(value) {
  if (value.type !== "array") return describeRef(value);
  return value.items.map((item) => {
    if (item.type === "string") return item.hex ? `<${item.text.length * 2} hex>` : `"${item.text}"`;
    return describeRef(item);
  }).join(" ");
}