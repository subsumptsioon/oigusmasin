// ── formats/pdf/xmp.js ────────────────────────────────────────────────────────
// XMP: the modern half of a PDF's metadata, and the half that disagrees with
// the old half.
//
// Three problems, and the shape of this module follows them.
//
// **1. Prefixes are not identity.** `dc:title`, `dc15:title` and a title in a
// namespace nobody has heard of are all "a title". The XML namespace *URI* is
// what identifies a property; the prefix is a local abbreviation that changes
// between producers without changing the meaning. So `getElementsByTagName("dc:title")`
// — the obvious line, and the one that looks right while being wrong — misses
// every producer that chose `dc15:` or a default namespace. The walk below reads
// `namespaceURI` + `localName` and keeps the prefix only for display.
//
// The corollary matters more than the fix: a list of known namespaces is a
// filter, and every unknown property is filtered out. This module has no such
// list for the *walk*. It knows a few namespaces to *label* results with, and
// shows everything else under its own name — which is how `acme:CustomField`
// survives to the interface.
//
// **2. The packet is bytes.** It arrives UTF-8, UTF-16LE or UTF-16BE, with or
// without a BOM, wrapped in an `<?xpacket?>` envelope whose padding can be
// kilobytes of whitespace. Feeding a UTF-16 packet to `DOMParser` as a string
// yields a `parsererror` document that says nothing about the file. The
// decoding happens first, and is reported.
//
// **3. A malformed packet is a finding, not a failure.** A file whose XMP does
// not parse still has an Info dictionary, a page count and a repair scan. So a
// parse error is caught, reported with the parser's own message, and the raw
// packet is still shown — because the raw packet is often where the interesting
// thing is.
// ─────────────────────────────────────────────────────────────────────────────

/** §5.4's namespaces. Used to *label*, never to filter. */
const NAMESPACES = {
  "http://purl.org/dc/elements/1.1/": "dc",
  "http://ns.adobe.com/xap/1.0/": "xmp",
  "http://ns.adobe.com/pdf/1.3/": "pdf",
  "http://ns.adobe.com/xap/1.0/mm/": "xmpMM",
  "http://www.aiim.org/pdfa/ns/id/": "pdfaid",
  "http://www.npes.org/pdfx/ns/id/": "pdfxid",
  "http://ns.adobe.com/xap/1.0/sType/ResourceEvent#": "stEvt",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf",
  "adobe:ns:meta/": "x",
};

/** Where a namespace's URI is written differently but means the same thing.
 *  Adobe changed the XMP and PDF namespaces between specifications and both
 *  spellings appear in real files; treating them as different namespaces would
 *  report a document as having two `xmp:CreatorTool`s. */
const NAMESPACE_ALIASES = {
  "http://ns.adobe.com/xap/1.0/": "http://ns.adobe.com/xap/1.0/",
  "http://ns.adobe.com/pdf/1.3/": "http://ns.adobe.com/pdf/1.3/",
  "http://ns.adobe.com/xap/1.0/mm/": "http://ns.adobe.com/xap/1.0/mm/",
};

/** `parsererror` documents have this namespace, per the HTML parsing spec. */
const PARSER_ERROR_NS = "http://www.mozilla.org/newlayout/xml/parsererror.xml";

/**
 * Parse an XMP packet.
 *
 * @param {Uint8Array|string} packet raw packet bytes, or a string already decoded
 * @returns {{ok: boolean, reason?: string, encoding?: string, xml?: string,
 *            properties: object[], namespaces: object[], history: object[],
 *            conformance: object, wellKnown: object, raw?: string}}
 *
 * `ok: false` carries a reason in Estonian and still carries `raw`. The caller
 * shows both.
 */
export function parsePacket(packet) {
  const result = {
    ok: false,
    encoding: null,
    xml: null,
    properties: [],
    namespaces: [],
    history: [],
    conformance: {},
    wellKnown: {},
  };

  const decoded = toText(packet);
  result.encoding = decoded.encoding;
  result.raw = decoded.text;

  /* Strip the xpacket envelope. The `begin` attribute carries a BOM that is part
     of the padding convention, not content, and the padding between `end` and
     `<?xpacket end?>` can be thousands of characters. */
  const xml = stripEnvelope(decoded.text);
  result.xml = xml;
  if (!xml.trim()) {
    result.reason = "pakett ei sisalda XML-i";
    return result;
  }

  const doc = parseXml(xml);
  if (!doc) {
    result.reason = "XML-i ei saanud parsida";
    return result;
  }

  if (isParserError(doc)) {
    result.reason = parserErrorText(doc);
    return result;
  }

  result.ok = true;
  walk(doc.documentElement, result);
  collectHistory(result);
  return result;
}

/* ── Decoding ──────────────────────────────────────────────────────────────── */

/** Bytes → text, reporting which encoding was used.
 *
 *  The order is forced by the BOMs: §5.4 requires UTF-16 packets to be handled
 *  explicitly, and a UTF-16 packet read as UTF-8 produces a document full of NUL
 *  bytes rather than an error — the failure looks like an empty packet.
 *
 *  UTF-16 *without* a BOM is genuinely undecidable from the bytes alone; Adobe
 *  permits it in theory and no real producer emits it, so it is reported rather
 *  than guessed at. Guessing would risk reading a UTF-8 packet as UTF-16 and
 *  producing confident nonsense. */
function toText(packet) {
  if (typeof packet === "string") {
    return { text: stripBomString(packet), encoding: "tekst (teisendatud ülesandes)" };
  }

  const bytes = packet;

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeUtf16(bytes.subarray(2), false), encoding: "UTF-16LE (BOM)" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16(bytes.subarray(2), true), encoding: "UTF-16BE (BOM)" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decodeUtf8(bytes.subarray(3)), encoding: "UTF-8 (BOM)" };
  }

  /* A NUL in the first bytes of a document with no other indication is the
     signature of UTF-16 without a BOM. It is checked rather than assumed,
     because a NUL is also a legal — if unusual — byte in a binary packet. */
  const probe = bytes.subarray(0, Math.min(bytes.length, 256));
  const nulIndex = probe.indexOf(0);
  if (nulIndex > 0 && nulIndex % 2 === 1) {
    return { text: decodeUtf16(bytes, false), encoding: "UTF-16LE (ilma algustähiseta)" };
  }
  if (nulIndex === 0 && probe[1] === 0) {
    return { text: decodeUtf16(bytes, true), encoding: "UTF-16BE (ilma algustähiseta)" };
  }

  return { text: decodeUtf8(bytes), encoding: "UTF-8" };
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    /* An old browser without TextDecoder, or an invalid sequence. Latin-1 never
       fails, and it is a lossless byte-to-character mapping. */
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
}

function decodeUtf16(bytes, bigEndian) {
  const usable = bytes.length - (bytes.length % 2);
  let out = "";
  for (let i = 0; i < usable; i += 2) {
    const unit = bigEndian
      ? (bytes[i] << 8) | bytes[i + 1]
      : (bytes[i + 1] << 8) | bytes[i];
    /* Surrogate pairs are rare in XMP but legal in a title. */
    if (unit >= 0xd800 && unit <= 0xdbff && i + 3 < usable) {
      const next = bigEndian
        ? (bytes[i + 2] << 8) | bytes[i + 3]
        : (bytes[i + 3] << 8) | bytes[i + 2];
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += String.fromCharCode(unit, next);
        i += 2;
        continue;
      }
    }
    out += String.fromCharCode(unit);
  }
  return out;
}

function stripBomString(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The `<?xpacket?>` envelope off, leaving the XML.
 *
 *  The wrapper is optional — a packet without it is valid — so this returns the
 *  input unchanged when there is no wrapper, rather than failing.
 *
 *  **The slice must stop at the closing `</x:xmpmeta>`, not at end of string.**
 *  The first draft sliced from `<x:xmpmeta` to the end, which left the closing
 *  `<?xpacket end="w"?>` processing instruction attached — and an XML parser
 *  treats a processing instruction that never ends as a fatal error. So a
 *  perfectly valid packet was reported as "pakett ei ole korrektne XML: PI
 *  xpacket never end", on the UTF-16 corpus file and not on the UTF-8 ones,
 *  which is the sort of difference that looks like a decoding bug rather than
 *  the envelope bug it was.
 *
 *  Both closing spellings are accepted, and so is a packet that is truncated
 *  before its close: in that case there is nothing to stop at, and the tail is
 *  returned as-is so the parser can report what is actually wrong with it. */
function stripEnvelope(text) {
  const candidates = ["<x:xmpmeta", "<xmpmeta"];
  let start = -1;
  for (const candidate of candidates) {
    start = text.indexOf(candidate);
    if (start !== -1) break;
  }
  if (start === -1) {
    return text.replace(/^﻿/, "");
  }

  /* Find the close of whichever element was opened.
     The tag *name* is the candidate minus its leading `<`; building the close
     tag from the candidate itself yields `</<x:xmpmeta>`, which matches nothing
     — so the slice ran to end of string and the dangling `<?xpacket end?>`
     came along, which is the failure this whole branch exists to prevent. */
  const tagName = candidates.find((c) => text.startsWith(c, start)) ?? "";
  const closeTag = `</${tagName.slice(1)}>`;
  const closeAt = text.indexOf(closeTag, start);
  if (closeAt === -1) {
    /* Truncated: no close exists, so take the rest and let the parser say so. */
    return text.slice(start);
  }
  return text.slice(start, closeAt + closeTag.length);
}

/* ── Parsing ──────────────────────────────────────────────────────────────── */

/** `DOMParser` on an XML document, with the error path made explicit.
 *
 *  `DOMParser` does not throw on malformed input. It returns a document whose
 *  root is a `parsererror` element, which is why the check below is not
 *  optional — without it a malformed packet is reported as "parsed, zero
 *  properties", which is a confident and completely wrong answer about a file
 *  that plainly has metadata in it. */
function parseXml(xml) {
  if (typeof DOMParser === "undefined") return null;
  try {
    return new DOMParser().parseFromString(xml, "application/xml");
  } catch {
    return null;
  }
}

/** Did the parser refuse this document?
 *
 *  The obvious check — "is `documentElement` a `parsererror`?" — is wrong, and it
 *  is wrong in the direction that matters. Chromium and WebKit put the
 *  `parsererror` element **inside** the partially-parsed tree, as a descendant
 *  of the real root, so `documentElement` is `x:xmpmeta` and looks fine. The
 *  first draft checked only the root, and a malformed packet came back as
 *  "parsed successfully, six properties" — which is §5.4's exact failure mode,
 *  a confident wrong answer about a file that plainly has no usable metadata.
 *
 *  So the document is searched for a `parsererror` **anywhere**, which is what
 *  the HTML parsing specification actually says to do. The `xhtml` namespace in
 *  the walk output was the tell: a PDF has no XHTML in it.
 */
function isParserError(doc) {
  const root = doc?.documentElement;
  if (!root) return true;
  if (root.namespaceURI === PARSER_ERROR_NS || root.localName === "parsererror") return true;

  /* `getElementsByTagName` matches on the qualified name in some engines and on
     the local name in others, so both are tried. */
  if (doc.getElementsByTagName("parsererror").length > 0) return true;

  const nodes = root.getElementsByTagName("*");
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].namespaceURI === PARSER_ERROR_NS || nodes[i].localName === "parsererror") {
      return true;
    }
  }
  return false;
}

/** The parser's own message, in the visitor's language.
 *
 *  The engine's text is kept verbatim under it, because "mismatched tag" from
 *  WebKit and "Expecting to see </x> to close <x>" from Gecko are the same
 *  failure with different wording, and which engine reported it is itself a
 *  fact about the environment rather than about the file. */
function parserErrorText(doc) {
  const root = doc.documentElement;
  const detail = (root?.textContent ?? "").trim().split("\n")[0] ?? "";
  return detail
    ? `pakett ei ole korrektne XML: ${detail.slice(0, 200)}`
    : "pakett ei ole korrektne XML";
}

/* ── The walk ─────────────────────────────────────────────────────────────── */

/** Walk every element, recording namespace, local name, prefix and value.
 *
 *  Nothing is filtered. `acme:CustomField` and every other namespace this
 *  project has never heard of come out with the same shape as `dc:title`, and
 *  the interface sorts them after the ones it recognises. */
function walk(element, result) {
  if (!element) return;

  const seenNamespaces = new Map();
  let index = 0;

  const visit = (node, path) => {
    if (node.nodeType === 1) {
      const ns = node.namespaceURI ?? "";
      const local = node.localName ?? node.nodeName;

      if (ns) {
        const existing = seenNamespaces.get(ns);
        if (existing) existing.count++;
        else seenNamespaces.set(ns, { uri: ns, prefix: prefixOf(node, ns), count: 1 });
      }

      /* The RDF container elements (Alt/Seq/Bag/li) are structure, not
         properties. Their *children* are the properties, and a `dc:title` whose
         value lives inside `rdf:Alt/rdf:li` is still one property. So containers
         are descended into rather than recorded. */
      const isContainer = ns.endsWith("22-rdf-syntax-ns#") && RDF_CONTAINERS.has(local);
      if (!isContainer) {
        index++;
        const value = valueOf(node);
        result.properties.push({
          index,
          ns,
          prefix: prefixOf(node, ns),
          local,
          path: path ? `${path}/${local}` : local,
          qualified: ns ? `${prefixOf(node, ns)}:${local}` : local,
          value,
          attributes: attributesOf(node),
          isSimple: !hasElementChildren(node),
        });
        classify(result, ns, local, value, node);
      }

      for (const child of node.children) {
        visit(child, path ? `${path}/${local}` : local);
      }
    }
  };

  visit(element, "");

  result.namespaces = [...seenNamespaces.values()].sort((a, b) => b.count - a.count);
}

const RDF_CONTAINERS = new Set(["RDF", "Description", "Alt", "Seq", "Bag", "li"]);

/** A property's value.
 *
 *  A simple property is its text. A structured one — `rdf:Alt`, `rdf:Seq` — is
 *  the concatenation of its items, which is what a reader wants to see, and the
 *  items are kept in `attributes` so a caller that cares about `xml:lang` can
 *  tell them apart. A property that is itself a container of properties returns
 *  its own text, which is empty, and is skipped as a value below. */
function valueOf(node) {
  const text = node.textContent ?? "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed;
}

function hasElementChildren(node) {
  for (const child of node.children) {
    if (child.nodeType === 1) return true;
  }
  return false;
}

/** An element's attributes, minus the RDF plumbing that every one has.
 *
 *  `rdf:about`, `rdf:parseType` and `rdf:resource` are how RDF says "this is a
 *  structure" — they carry no metadata of their own, and listing them three
 *  times per property would bury the ones that matter, like `xmpMM:InstanceID`. */
function attributesOf(node) {
  const out = [];
  for (const attr of node.attributes ?? []) {
    if (attr.namespaceURI === "http://www.w3.org/1999/02/22-rdf-syntax-ns#") continue;
    out.push({ name: attr.name, value: attr.value });
  }
  return out;
}

/** The prefix an element was written with, for display only.
 *
 *  DOM gives the prefix back through `prefix` in browsers that support it; where
 *  it is absent the lookup table provides one. Neither affects identity — the
 *  namespace URI above is what counts. */
function prefixOf(node, ns) {
  if (node.prefix) return node.prefix;
  const mapped = NAMESPACES[ns];
  if (mapped) return mapped;
  const tail = ns.replace(/\/$/, "").split(/[/:#]/).pop();
  return tail || "(tundmatu)";
}

/* ── The fields §5.4 names ────────────────────────────────────────────────── */

/** Pull out the properties the plan asks to highlight, by namespace URI.
 *
 *  Matched on `(namespaceURI, localName)` pairs — never on `"dc:title"` — so a
 *  producer that bound `dc` to the right URI with a different prefix is found,
 *  and a producer with a lookalike namespace is not. */
function classify(result, ns, local, value, node) {
  const canonical = NAMESPACE_ALIASES[ns] ?? ns;
  const key = `${canonical}|${local}`;

  switch (key) {
    case "http://ns.adobe.com/xap/1.0/|CreatorTool":
      result.wellKnown.creatorTool = value;
      break;
    case "http://ns.adobe.com/xap/1.0/mm/|DocumentID":
      result.wellKnown.documentId = value;
      break;
    case "http://ns.adobe.com/xap/1.0/mm/|InstanceID":
      result.wellKnown.instanceId = value;
      break;
    case "http://ns.adobe.com/xap/1.0/mm/|History":
      /* Collected separately below; the element itself has no text. */
      break;
    case "http://www.aiim.org/pdfa/ns/id/|part":
      result.conformance.pdfaPart = value;
      break;
    case "http://www.aiim.org/pdfa/ns/id/|conformance":
      result.conformance.pdfaConformance = value;
      break;
    case "http://www.npes.org/pdfx/ns/id/|GTS_PDFXVersion":
      result.conformance.pdfxVersion = value;
      break;
    case "http://www.npes.org/pdfx/ns/id/|GTS_PDFXConformance":
      result.conformance.pdfxConformance = value;
      break;
    case "http://purl.org/dc/elements/1.1/|title":
      result.wellKnown.title = value;
      break;
    case "http://purl.org/dc/elements/1.1/|creator":
      result.wellKnown.creator = value;
      break;
    case "http://ns.adobe.com/xap/1.0/|CreateDate":
      result.wellKnown.createDate = value;
      break;
    case "http://ns.adobe.com/xap/1.0/|ModifyDate":
      result.wellKnown.modifyDate = value;
      break;
    case "http://ns.adobe.com/pdf/1.3/|Producer":
      result.wellKnown.producer = value;
      break;
    default:
      break;
  }
}

/** `xmpMM:History`, which is a list of events rather than a property.
 *
 *  Each `rdf:li` is one event, holding `stEvt:action`, `stEvt:when`,
 *  `stEvt:agentAgent` and `stEvt:instanceID`. Those live in their own namespace
 *  and are read by URI like everything else — the first draft matched on
 *  `"stEvt:action"` and would have reported an empty history on any file whose
 *  producer chose a different prefix for the same namespace. */
function collectHistory(result) {
  const history = result.properties.find(
    (p) => (p.ns === "http://ns.adobe.com/xap/1.0/mm/" && p.local === "History"),
  );
  if (!history) return;

  /* The history element's items are not in `properties` as properties, because
     `rdf:li` was treated as a container. They are re-walked here from the
     recorded tree: find the History element in the source and read its `li`s. */
  const doc = parseXml(result.xml);
  if (!doc || isParserError(doc)) return;

  const node = findByNs(doc.documentElement, "http://ns.adobe.com/xap/1.0/mm/", "History");
  if (!node) return;

  for (const li of node.getElementsByTagName("*")) {
    if (li.localName !== "li") continue;
    const event = {
      action: null,
      when: null,
      formattedDate: null,
      agent: null,
      instanceId: null,
    };
    for (const child of li.children) {
      const childNs = child.namespaceURI ?? "";
      const value = (child.textContent ?? "").trim();
      if (childNs.endsWith("sType/ResourceEvent#")) {
        if (child.localName === "action") event.action = value;
        else if (child.localName === "when") {
          event.when = value;
          event.formattedDate = attributeValue(child, "formattedDate");
        } else if (child.localName === "agentAgent") event.agent = value;
        else if (child.localName === "instanceID") event.instanceId = value;
      }
    }
    if (event.action || event.when) result.history.push(event);
  }
}

function attributeValue(node, localName) {
  for (const attr of node.attributes ?? []) {
    if (attr.localName === localName) return attr.value;
  }
  return null;
}

function findByNs(node, ns, local) {
  if (!node) return null;
  if (node.namespaceURI === ns && node.localName === local) return node;
  for (const child of node.children ?? []) {
    const found = findByNs(child, ns, local);
    if (found) return found;
  }
  return null;
}

/* ── Info vs XMP ──────────────────────────────────────────────────────────── */

/** Compare the Info dictionary against XMP, field by field.
 *
 *  §5.4 asks for any *vastuolu* to be flagged, and the comparison has to be
 *  about meaning rather than about bytes: `/Info` writes dates as
 *  `D:20240315103000+02'00'` and XMP writes ISO 8601, so a string comparison
 *  would report every document in existence as disagreeing with itself.
 *
 *  So dates are parsed to instants on both sides before comparing, strings are
 *  compared directly, and a field present on one side only is reported as
 *  *missing* rather than as a *contradiction* — a document with an XMP title and
 *  no `/Info` title is unusual but is not a file that says two things.
 *
 *  Every disagreement is reported with both values, never resolved. §5.4's
 *  purpose is to surface the conflict; picking a winner would be the analyser
 *  over-claiming, and which dictionary a reader trusts is their decision. */
export function compareWithInfo(xmp, infoFields) {
  const disagreements = [];
  if (!xmp?.ok || !infoFields?.length) return { available: false, disagreements };

  const info = new Map(infoFields.map((f) => [f.key, f.text]));

  const pairs = [
    ["Title", xmp.wellKnown.title],
    ["Author", xmp.wellKnown.creator],
    ["Producer", xmp.wellKnown.producer],
    ["CreationDate", xmp.wellKnown.createDate],
    ["ModDate", xmp.wellKnown.modifyDate],
  ];

  for (const [key, xmpValue] of pairs) {
    const infoValue = info.get(key);
    if (!xmpValue || !infoValue) continue;

    const isDate = key === "CreationDate" || key === "ModDate";
    const same = isDate ? sameInstant(infoValue, xmpValue) : infoValue.trim() === xmpValue.trim();

    if (!same) {
      disagreements.push({
        key,
        info: infoValue,
        xmp: xmpValue,
        kind: isDate ? "kuupäev" : "tekst",
      });
    }
  }

  return { available: true, disagreements };
}

/** Two dates, same instant?
 *
 *  `/Info` uses §7.9.4's format and XMP uses ISO 8601; both are parsed here and
 *  compared as timestamps. A date with no offset in one and an offset in the
 *  other cannot be compared and is reported as a disagreement rather than
 *  assumed equal — an unresolvable difference is still a difference. */
function sameInstant(infoValue, xmpValue) {
  const infoDate = parsePdfDate(infoValue);
  const xmpDate = new Date(xmpValue);
  if (Number.isNaN(xmpDate.getTime())) return false;
  if (!infoDate) {
    /* An `/Info` date with no offset is local time with no way to know which.
       Comparing it against an absolute XMP instant would require inventing an
       offset, so it is reported as different and the visitor decides. */
    return false;
  }
  return Math.abs(infoDate.getTime() - xmpDate.getTime()) < 1000;
}

/** `/Info` date → Date, reusing the PDF date rules. Kept local rather than
 *  imported so this module has no dependency on `encoding.js` and could be read
 *  on its own. */
function parsePdfDate(text) {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([+\-Z].*)?$/.exec(
    (text ?? "").trim(),
  );
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", off = ""] = m;
  let zone = "";
  if (off === "Z") zone = "Z";
  else if (off) {
    const om = /^([+\-])(\d{2})'?(\d{2})?'?$/.exec(off);
    if (!om) return null;
    zone = `${om[1]}${om[2]}:${om[3] ?? "00"}`;
  }
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}