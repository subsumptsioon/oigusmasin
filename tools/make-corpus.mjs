#!/usr/bin/env node
/**
 * make-corpus.mjs — generates every file in `test-pdfs/`.
 *
 * §12 decision 2 was "whether to keep `test-pdfs/` in the repository at all, or
 * generate them". The answer is **both, and for different reasons**: the files
 * are committed, and they can also be rebuilt byte for byte from this script.
 *
 *   Committed, because the corpus is an input to the test suite. A test that
 *   regenerates its own fixtures has a failure mode a committed fixture does
 *   not — the generator is code, so a bug in it silently changes what is being
 *   tested, and a fixture that no longer exercises the bug stops reproducing it
 *   without anyone noticing.
 *
 *   Generatable, because 21 opaque binaries in a repository are a review
 *   problem. Nobody can see what changed in `classic.pdf` in a diff; everyone can
 *   read this file. The corpus exists to check claims like "the MD5 matches at
 *   27 padding boundaries" and "a subset font is detected", and every one of
 *   those claims is a sentence in this script rather than an assertion about a
 *   blob.
 *
 * Every file is constructed to the byte, with values the tests then assert on.
 * Nothing here is a real document and nothing here contains anyone's data.
 *
 * Usage:  node tools/make-corpus.mjs [--out test-pdfs]
 * Exit:   0 written, 1 a mismatch against an existing file, 2 harness error.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const outArg = process.argv.indexOf("--out");
const OUT = path.resolve(ROOT, outArg !== -1 ? process.argv[outArg + 1] : "test-pdfs");

/* ── PDF assembly ──────────────────────────────────────────────────────────────
   The smallest thing that produces a structurally valid file: header, objects
   with recorded offsets, a classic cross-reference table, a trailer and a
   startxref. Everything the tests need is built on top of this. */

function classic(objects, { root = 1, info = null, extra = "", version = "1.7" } = {}) {
  const offsets = new Map();

  /* `Buffer.concat` rather than `out.write`: Node 26's `Buffer.write` takes a
   * string and rejects a Buffer outright, so appending an object's body the
   * obvious way throws `argument must be a string` on every file. The pieces are
   * concatenated once, which is both correct and faster for a corpus. */
  const parts = [Buffer.from(`%PDF-${version}\n%âãÏÓ\n`, "latin1")];
  for (const [num, body] of objects) {
    offsets.set(num, Buffer.concat(parts).length);
    parts.push(Buffer.from(`${num} 0 obj\n`, "latin1"));
    parts.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
    parts.push(Buffer.from("\nendobj\n", "latin1"));
  }
  const assembled = Buffer.concat(parts);

  const xref = assembled.length;
  const size = Math.max(...offsets.keys()) + 1;
  const tail = [Buffer.from(`xref\n0 ${size}\n0000000000 65535 f \n`, "latin1")];
  for (let i = 1; i < size; i++) {
    tail.push(Buffer.from(String(offsets.get(i) ?? 0).padStart(10, "0") + " 00000 n \n", "latin1"));
  }
  const infoPart = info === null ? "" : ` /Info ${info} 0 R`;
  tail.push(Buffer.from(`trailer\n<< /Size ${size} /Root ${root} 0 R${infoPart} ${extra}>>\n`, "latin1"));
  tail.push(Buffer.from(`startxref\n${xref}\n%%EOF\n`, "latin1"));
  return Buffer.concat([assembled, ...tail]);
}

const stream = (dict, data) =>
  Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"),
    Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1"),
    Buffer.from("\nendstream", "latin1"),
  ]);

/* ── Filters ───────────────────────────────────────────────────────────────── */

function ascii85(data) {
  /* The Adobe form: `z` for an all-zero group, `<~` once, `~>` once. */
  let out = "<~";
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4);
    if (chunk.length === 4 && chunk.every((b) => b === 0)) { out += "z"; continue; }
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (chunk[k] ?? 0);
    const five = [];
    for (let k = 0; k < 5; k++) { five.unshift(v % 85); v = Math.floor(v / 85); }
    out += String.fromCharCode(...five.slice(0, chunk.length + 1));
  }
  return Buffer.from(out + "~>", "latin1");
}

function asciiHex(data) {
  return Buffer.concat([Buffer.from(data.toString("hex"), "latin1"), Buffer.from(">", "latin1")]);
}

function runLength(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    let run = 1;
    while (i + run < data.length && data[i + run] === data[i] && run < 128) run++;
    if (run > 1 || data[i] === 0x80) {
      out.push(257 - run, data[i]);
      i += run;
    } else {
      let j = i;
      while (j < data.length && data[j] !== 0x80 && (j === i || data[j] !== data[j - 1]) && j - i < 128) j++;
      out.push(j - i - 1, ...data.subarray(i, j));
      i = j;
    }
  }
  out.push(128);
  return Buffer.from(out);
}

/** LZW as §7.4.4, with the clear-table code 256 and EOD 257 emitted, which is
 *  what the spec requires and what the decoder is tested against. */
function lzw(data) {
  const out = [];
  let bitBuf = 0, bitCount = 0, codeLen = 9;
  const table = new Map();
  for (let i = 0; i < 256; i++) table.set(String.fromCharCode(i), i);
  let next = 258;

  const emit = (code) => {
    bitBuf = (bitBuf << codeLen) | code;
    bitCount += codeLen;
    while (bitCount >= 8) { out.push((bitBuf >>> (bitCount - 8)) & 0xff); bitCount -= 8; }
  };

  let w = Buffer.alloc(0);
  for (const ch of data) {
    const wc = Buffer.concat([w, Buffer.from([ch])]);
    if (table.has(wc.toString("latin1"))) { w = wc; continue; }
    emit(table.get(w.toString("latin1")));
    table.set(wc.toString("latin1"), next++);
    if (next + 1 - 1 >= 1 << codeLen && codeLen < 12) codeLen++;
    w = Buffer.from([ch]);
  }
  if (w.length) emit(table.get(w.toString("latin1")));
  emit(257);
  if (bitCount) out.push((bitBuf << (8 - bitCount)) & 0xff);
  return Buffer.from(out);
}

/* ── A JPEG with known EXIF ──────────────────────────────────────────────────
   Built byte by byte so every value is one the tests can assert. `file(1)`
   reads it back as "Exif Standard, manufacturer=TestMaker", which is how the
   fixture was confirmed to be a real image rather than a plausible one. */

function jpeg({ width = 64, height = 48, gps = true } = {}) {
  const parts = [];
  const chunk = (marker, body) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, body]);
  };

  parts.push(Buffer.from([0xff, 0xd8]));
  parts.push(chunk(0xe0, Buffer.from("JFIF\0\0\0\0\0\0", "latin1")));

  /* TIFF, little-endian. IFD0 at 8. */
  const make = Buffer.from("TestMaker\0", "latin1");
  const model = Buffer.from("TestCam\0", "latin1");
  const dt = Buffer.from("2024:05:06 14:20:00\0", "latin1");

  const ifd0N = gps ? 6 : 5;
  const ifd0Size = 2 + ifd0N * 12 + 4;
  const makeOff = 8 + ifd0Size;
  const modelOff = makeOff + make.length;
  const dtOff = modelOff + model.length;

  const gpsOff = dtOff + dt.length;
  const gpsN = 4;
  const gpsSize = 2 + gpsN * 12 + 4;
  const latOff = gpsOff + gpsSize;
  const lonOff = latOff + 8;

  const ifd = (entries, next = 0) => {
    const b = Buffer.alloc(2 + entries.length * 12 + 4);
    b.writeUInt16LE(entries.length, 0);
    entries.forEach(([tag, type, count, value], i) => {
      const at = 2 + i * 12;
      b.writeUInt16LE(tag, at);
      b.writeUInt16LE(type, at + 2);
      b.writeUInt32LE(count, at + 4);
      b.writeUInt32LE(value, at + 8);
    });
    b.writeUInt32LE(next, 2 + entries.length * 12);
    return b;
  };

  const e0 = [
    [0x010f, 2, make.length, makeOff],
    [0x0110, 2, model.length, modelOff],
    [0x0132, 2, dt.length, dtOff],
  ];
  if (gps) e0.push([0x8825, 4, 1, gpsOff]);
  e0.push([0x8769, 4, 1, 0]);
  e0.push([0x8827, 3, 1, 400]);

  const ge = gps ? [
    [0x0001, 2, 2, Buffer.from("N\0\0\0", "latin1").readUInt32LE(0)],
    [0x0002, 5, 1, latOff],
    [0x0003, 2, 2, Buffer.from("E\0\0\0", "latin1").readUInt32LE(0)],
    [0x0004, 5, 1, lonOff],
  ] : [];

  const lat = Buffer.alloc(8); lat.writeUInt32LE(56, 0); lat.writeUInt32LE(1, 4);
  const lon = Buffer.alloc(8); lon.writeUInt32LE(24, 0); lon.writeUInt32LE(1, 4);

  const tiff = Buffer.concat([
    (() => { const b = Buffer.alloc(8); b.writeUInt16LE(0x4949, 0); b.writeUInt16LE(0x002a, 2); b.writeUInt32LE(8, 4); return b; })(),
    ifd(e0), make, model, dt, ...(gps ? [ifd(ge), lat, lon] : []),
  ]);
  parts.push(chunk(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])));

  /* SOF0: precision, height, width, component count, then one 3-byte entry
     per component. All the multi-byte fields are big-endian, and the segment
     length counts everything after the length field.

     The first draft hand-built this as a flat array of shifted bytes and got
     12288×2048 with 64 components out of it — `file(1)` reported it happily,
     because the bytes were all present and all in range, just arranged as if
     they were little-endian. It is exactly the kind of fixture that passes a
     check that does not know what it is looking at. */
  const sof = Buffer.alloc(15);
  sof.writeUInt8(8, 0);
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof.writeUInt8(3, 5);
  sof.writeUInt8(1, 6); sof.writeUInt8(0x11, 7); sof.writeUInt8(0, 8);
  sof.writeUInt8(2, 9); sof.writeUInt8(0x11, 10); sof.writeUInt8(1, 11);
  sof.writeUInt8(3, 12); sof.writeUInt8(0x11, 13); sof.writeUInt8(1, 14);
  parts.push(chunk(0xc0, sof));
  const table = Buffer.concat([Buffer.from([1]), Buffer.alloc(16, 1)]);
  parts.push(chunk(0xc4, Buffer.concat([Buffer.from([0x00]), table])));
  parts.push(chunk(0xc4, Buffer.concat([Buffer.from([0x10]), table])));
  parts.push(chunk(0xda, Buffer.from([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0])));
  parts.push(Buffer.alloc(64), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/* ── XMP packets ────────────────────────────────────────────────────────────── */

const pdfaPacket = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Oigusmasin">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">PDF/A dokument</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Koostaja A</rdf:li></rdf:Seq></dc:creator>
   <xmp:CreatorTool>Oigusmasin analyyser</xmp:CreatorTool>
   <xmp:CreateDate>2024-03-15T10:30:00+02:00</xmp:CreateDate>
   <xmp:ModifyDate>2024-03-16T11:45:00+02:00</xmp:ModifyDate>
   <xmp:ModifyCount>3</xmp:ModifyCount>
   <pdf:Producer>pdf.js test</pdf:Producer>
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
   <pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>
   <xmpMM:DocumentID>xmpdoc:9f8e7d6c-5b4a-3210-fedc-ba9876543210</xmpMM:DocumentID>
   <xmpMM:InstanceID>xmp:i:0123456789abcdef</xmpMM:InstanceID>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

/* An unknown namespace, deliberately: §5.4's whole argument is that a
   hard-coded namespace list would drop it. */
const historyPacket = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:acme="http://example.invalid/ns/acme/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Pealkiri XMP-s</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Autor XMP-st</rdf:li></rdf:Seq></dc:creator>
   <xmp:CreatorTool>Ajalaisa tariysta</xmp:CreatorTool>
   <xmp:CreateDate>2024-01-01T09:00:00+02:00</xmp:CreateDate>
   <xmp:ModifyDate>2024-05-06T14:20:00+03:00</xmp:ModifyDate>
   <xmp:ModifyCount>2</xmp:ModifyCount>
   <pdf:Producer>ajakausa</pdf:Producer>
   <xmpMM:DocumentID>xmpdoc:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</xmpMM:DocumentID>
   <acme:CustomField>Tundmatu nimeruum</acme:CustomField>
   <acme:revision>42</acme:revision>
   <xmpMM:History>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <stEvt:action xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#">created</stEvt:action>
      <stEvt:instanceID xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#">xmp:i:aaaa</stEvt:instanceID>
      <stEvt:when xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#" stEvt:formattedDate="2024-01-01T09:00:00+02:00">2024-01-01T09:00:00+02:00</stEvt:when>
      <stEvt:agentAgent xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#">writer</stEvt:agentAgent>
     </rdf:li>
     <rdf:li rdf:parseType="Resource">
      <stEvt:action xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#">modified</stEvt:action>
      <stEvt:instanceID xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#">xmp:i:bbbb</stEvt:instanceID>
      <stEvt:when xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#" stEvt:formattedDate="2024-05-06T14:20:00+03:00">2024-05-06T14:20:00+03:00</stEvt:when>
      <stEvt:agentAgent xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#">editor</stEvt:agentAgent>
     </rdf:li>
    </rdf:Seq>
   </xmpMM:History>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

/* ── The corpus ─────────────────────────────────────────────────────────────── */

const CONTENT = Buffer.from("BT /F1 12 Tf 72 700 Td (Filter test) Tj ET", "latin1");
const TEXT_PAGES = (label) => [
  [1, "<< /Type /Catalog /Pages 2 0 R >>"],
  [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] >>"],
  [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>"],
  [4, stream("/Filter /FlateDecode", zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 72 700 Td (${label}) Tj ET`, "latin1")))],
];

function build() {
  const files = new Map();

  /* — the classic table, the shape phase 5 reads — */
  files.set("classic.pdf", classic([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Annots [5 0 R] >>"],
    [4, stream("/Filter /FlateDecode", zlib.deflateSync(CONTENT))],
    [5, "<< /Type /Annot /Subtype /Text /Rect [10 700 30 720] /T (Märkuse autor) /Contents (Siin on märkuse sisu) /M (D:20240401120000+02'00') /Name /Comment >>"],
    [6, "<< /Title (Oigusmasin testdokument) /Author (Testautor) /Producer (qpdf kontroll) /CreationDate (D:20240315103000+02'00') /ModDate (D:20240316114500+02'00') >>"],
  ], { info: 6 }));

  /* — a file with no /Info at all, so "absent" is distinguishable from "empty" — */
  files.set("nominfo.pdf", classic(TEXT_PAGES("Info puudub"), {}));

  /* — the same words inside a stream: §5.2's candidate-filtering case — */
  const decoy = Buffer.from("xref\nstartxref\n999999\n%%EOF\nnot really a table", "latin1");
  files.set("decoy.pdf", classic([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>"],
    [4, stream("/Filter /FlateDecode", zlib.deflateSync(decoy))],
  ], {}));

  /* — an incremental update: a second revision that /Prev-points at the first — */
  {
    const first = classic([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>"],
      [4, stream("/Filter /FlateDecode", zlib.deflateSync(CONTENT))],
      [5, "<< /Title (Oigusmasin testdokument) /Author (Testautor) /Subject (Algne) /Producer (fase) /CreationDate (D:20240315103000+02'00') >>"],
    ], { info: 5 });
    const prev = Number(/startxref\s+(\d+)/.exec(first.toString("latin1"))[1]);
    const body = [];
    let at = first.length;
    const obj = Buffer.from(
      "2 0 obj\n<< /Title (Oigusmasin testdokument) /Author (Teineautor) /Subject (Muudetud) " +
      "/Producer (fase) /CreationDate (D:20240315103000+02'00') /ModDate (D:20240401120000+03'00') >>\nendobj\n",
      "latin1");
    body.push(obj);
    const objOff = at; at += obj.length;
    const xref2 = at;
    body.push(Buffer.from(`xref\n0 1\n0000000000 65535 f \n2 1\n${String(objOff).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R /Info 2 0 R /Prev ${prev} >>\nstartxref\n${xref2}\n%%EOF\n`, "latin1"));
    files.set("incremental.pdf", Buffer.concat([first, ...body]));
  }

  /* — a startxref that points outside the file: the everyday damage — */
  {
    const good = files.get("incremental.pdf").toString("latin1");
    const at = good.lastIndexOf("startxref");
    files.set("brokenxref.pdf", Buffer.from(
      good.slice(0, at) + "startxref\n999999\n%%EOF\n", "latin1"));
  }

  /* — an uncompressed XMP packet — */
  files.set("withxmp.pdf", classic([
    [1, "<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>"],
    [4, stream("/Filter /FlateDecode", zlib.deflateSync(CONTENT))],
    [5, stream("/Type /Metadata /Subtype /XML", Buffer.from(pdfaPacket, "latin1"))],
    [6, "<< /Title (XMP-pakkett) >>"],
  ], { info: 6 }));

  /* — PDF/A conformance identifiers — */
  files.set("pdfa.pdf", classic([
    [1, "<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>"],
    [4, stream("/Filter /FlateDecode", zlib.deflateSync(CONTENT))],
    [5, stream("/Type /Metadata /Subtype /XML", Buffer.from(pdfaPacket, "latin1"))],
    [6, "<< /Title (PDF/A dokument) /Author (Koostaja A) /Producer (pdf.js test) /CreationDate (D:20240315103000+02'00') /ModDate (D:20240316114500+02'00') >>"],
  ], { info: 6 }));

  /* — xmpMM:History, an unknown namespace, and an Info that disagrees — */
  files.set("history.pdf", classic([
    [1, "<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>"],
    [4, stream("/Filter /FlateDecode", zlib.deflateSync(CONTENT))],
    [5, stream("/Type /Metadata /Subtype /XML", Buffer.from(historyPacket, "latin1"))],
    [6, "<< /Title (TEINE pealkiri) /Author (TEINE autor) /Producer (teine tootja) /CreationDate (D:20240202090000+02'00') /ModDate (D:20240707140000+03'00') >>"],
  ], { info: 6 }));

  /* — a UTF-16 packet: the case a raw byte scan cannot see at all — */
  {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(pdfaPacket.replace(/Õigusmasin analyyser/g, "UTF-16 tööriist"), "utf16le"),
    ]);
    files.set("xmp-utf16.pdf", classic([
      [1, "<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>"],
      [4, stream("/Filter /FlateDecode", zlib.deflateSync(CONTENT))],
      [5, stream("/Type /Metadata /Subtype /XML", utf16)],
      [6, "<< /Title (UTF-16 pealkiri) >>"],
    ], { info: 6 }));
  }

  /* — a packet that is not well-formed XML — */
  files.set("xmp-broken.pdf", classic([
    [1, "<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>"],
    [4, stream("/Filter /FlateDecode", zlib.deflateSync(CONTENT))],
    [5, stream("/Type /Metadata /Subtype /XML", Buffer.from(
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/">\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n   <xmp:CreatorTool>Poolik pakett\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>', "latin1"))],
    [6, "<< /Title (Poolik) >>"],
  ], { info: 6 }));

  /* — every implemented filter, over one known payload — */
  for (const [name, filtered] of [
    ["flate", zlib.deflateSync(CONTENT)],
    ["lzw", lzw(CONTENT)],
    ["ascii85", ascii85(CONTENT)],
    ["asciihex", asciiHex(CONTENT)],
    ["runlength", runLength(CONTENT)],
  ]) {
    files.set(`filter-${name}.pdf`, classic([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>"],
      [4, stream(`/Filter /${name === "flate" ? "FlateDecode" : name === "lzw" ? "LZWDecode" : name === "ascii85" ? "ASCII85Decode" : name === "asciihex" ? "ASCIIHexDecode" : "RunLengthDecode"}`, filtered)],
    ], {}));
  }

  /* — a PNG Up predictor over a small image — */
  {
    const rows = 4;
    let prev = [0, 0, 0];
    const filtered = [];
    const plain = [];
    for (let r = 0; r < rows; r++) {
      const cur = [(10 + 5 * (r + 1)) & 0xff, (20 - 3 * (r + 1)) & 0xff, (30 + 8 * (r + 1)) & 0xff];
      filtered.push(2, ...cur.map((c, i) => (c - prev[i]) & 0xff));
      plain.push(...cur);
      prev = cur;
    }
    files.set("pngpredictor.pdf", classic([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 9 12] >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 9 12] /Contents 4 0 R >>"],
      [4, stream("/Filter /FlateDecode /DecodeParms << /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns 3 >>", zlib.deflateSync(Buffer.from(filtered)))],
    ], {}));
    files.set("pngpredictor-expected.bin", Buffer.from(plain));
  }

  /* — encryption: V2/R3, 128-bit, permission flags that qpdf can be diffed against — */
  files.set("encrypted.pdf", classic([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>"],
    [4, "<< /Title (Krüpteeritud) /Producer (test) >>"],
    [5, "<< /Filter /Standard /V 2 /R 3 /Length 128 /P -3904 /O <28BF4E5E4E758A416E4E0E2C455F4E0E> /U <28BF4E5E4E758A416E4E0E2C455F4E0E> >>"],
  ], { info: 4, extra: "/Encrypt 5 0 R " }));

  /* — a structure-rich document: outline, named destinations, rotation, /Lang,
       /MarkInfo, viewer preferences, an annotation — */
  files.set("structure.pdf", classic([
    [1, "<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /Names << /Dests 11 0 R >> /PageMode /UseOutlines /Lang (et-EE) /MarkInfo << /Marked true >> /ViewerPreferences << /HideToolbar true /FitWindow true >> >>"],
    [2, "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /MediaBox [0 0 595 842] >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Rotate 90 /Contents 4 0 R /Annots [5 0 R] >>"],
    [4, stream("/Filter /FlateDecode", zlib.deflateSync(Buffer.from("BT /F1 12 Tf 72 700 Td (Struktuur) Tj ET", "latin1")))],
    [5, "<< /Type /Annot /Subtype /Text /Rect [10 700 30 720] /T (Märkuse autor) /Contents (Siin on märkuse sisu) /M (D:20240401120000+02'00') /Name /Comment >>"],
    [6, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 7 0 R >>"],
    [7, stream("/Filter /FlateDecode", zlib.deflateSync(Buffer.from("BT /F1 12 Tf 72 700 Td (Struktuur) Tj ET", "latin1")))],
    [8, "<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>"],
    [9, "<< /Title (Esimene raamatukuulis) /Parent 8 0 R /Dest [3 0 R /Fit] >>"],
    [10, "<< /Title (Infodiktsioon) /Producer (struktuuritest) >>"],
    [11, "<< /Names [(Eesmärk) [3 0 R /Fit] (Lisa) [6 0 R /Fit]] >>"],
  ], { info: 10 }));

  /* — a PDF carrying JavaScript that would be catastrophic if it ran — */
  {
    const js = Buffer.from(
      "<< /S /JavaScript /JS (app.alert('X');this.exportDataObject && this.exportDataObject()) >>", "latin1");
    files.set("javascript.pdf", classic([
      [1, "<< /Type /Catalog /Pages 2 0 R /Names << /JavaScript 5 0 R >> /OpenAction << /S /URI /URI (https://example.invalid/should-never-load) >> >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>"],
      [4, stream("/Filter /FlateDecode", zlib.deflateSync(CONTENT))],
      [5, "<< /Names [(Ohtlik) 6 0 R] >>"],
      [6, js],
      [7, "<< /Title (JavaScripti test) /Producer (turvatest) >>"],
    ], { info: 7 }));
  }

  /* — a JPEG, and the same JPEG embedded in a PDF: phase 9's symmetry test — */
  files.set("photo.jpg", jpeg({ gps: true }));
  files.set("photo-nogps.jpg", jpeg({ gps: false }));
  {
    const jpg = files.get("photo.jpg");
    const cc = zlib.deflateSync(Buffer.from("q 100 0 0 100 0 0 cm /Im1 Do Q BT /F1 12 Tf 72 700 Td (Pilt) Tj ET", "latin1"));
    files.set("withphoto.pdf", classic([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /XObject << /Im1 7 0 R >> /Font << /F1 5 0 R /F2 8 0 R >> >> >>"],
      [4, stream("/Filter /FlateDecode", cc)],
      [5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"],
      [7, stream("/Type /XObject /Subtype /Image /Width 64 /Height 48 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", jpg)],
      [8, "<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Times-Roman /FirstChar 32 /LastChar 126 /FontDescriptor 9 0 R >>"],
      [9, "<< /Type /FontDescriptor /FontName /ABCDEF+Times-Roman /Flags 32 /FontBBox [-100 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 10 0 R >>"],
      [10, stream("", Buffer.from([0, 1, 0, 0]))],
      [11, "<< /Title (Pildidokument) /Producer (fase9) >>"],
    ], { info: 11 }));
  }

  /* — a cross-reference stream and an object stream: PDF 1.5+, which is what
       Word and LibreOffice actually produce and what phase 5 could not read at
       all. Built by hand because nothing else here emits the binary form. */
  {
    const inner = [];
    const header = [];
    let at = 0;
    for (const [num, body] of [
      [9, "<< /Title (Objektvoogudokument) /Producer (objstm) /Author (Voog Autor) >>"],
      [7, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"],
    ]) {
      const b = Buffer.from(body, "latin1");
      header.push(`${num} ${at} `);
      inner.push(b, Buffer.from(" ", "latin1"));
      at += b.length + 1;
    }
    const payload = Buffer.concat([Buffer.from(header.join(""), "latin1"), ...inner]);
    const first = Buffer.from(header.join(""), "latin1").length;

    const chunks = [Buffer.from("%PDF-1.5\n%âãÏÓ\n", "latin1")];
    const offsets = new Map();
    const emit = (num, body) => {
      offsets.set(num, Buffer.concat(chunks).length);
      chunks.push(Buffer.from(`${num} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1"));
    };

    emit(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
    emit(2, Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"));
    emit(3, Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R >>", "latin1"));
    emit(5, stream("/Filter /FlateDecode", zlib.deflateSync(CONTENT)));
    emit(6, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "latin1"));

    const stm = zlib.deflateSync(payload);
    emit(4, Buffer.from(
      `<< /Type /ObjStm /N 2 /First ${first} /Filter /FlateDecode /Length ${stm.length} >>\nstream\n`, "latin1")
      .toString("latin1") ? stream(`/Type /ObjStm /N 2 /First ${first} /Filter /FlateDecode`, stm) : Buffer.alloc(0));

    /* The xref stream. Type 2 entries carry the *containing* stream's object
       number and the object's index within it — getting that wrong produces a
       file every reader rejects, which is why qpdf checks this one below. */
    const xrefAt = Buffer.concat(chunks).length;
    offsets.set(8, xrefAt);
    const W = [1, 4, 2];
    const size = 10;
    /* Row 0 is object 0, free, generation 65535 — six bytes, like every other
       row, because every row is W[0]+W[1]+W[2] = 1+4+2. The first draft wrote
       six here and seven everywhere else, so the stream was one byte short and
       every reader rejected it: "Cross-reference stream data has the wrong
       size; expected = 70; actual = 69". */
    const row = (type, field2, field3) => {
      const b = Buffer.alloc(7);
      b.writeUInt8(type, 0);
      b.writeUInt32BE(field2, 1);
      b.writeUInt16BE(field3, 5);
      return b;
    };
    const rows = [row(0, 0, 0xFFFF)];
    for (let n = 1; n < size; n++) {
      if (offsets.has(n)) {
        rows.push(row(1, offsets.get(n), 0));
      } else if (n === 7 || n === 9) {
        /* Type 2: field 2 is the containing object stream's number (4), field 3
           the object's index within it. Swapping them is the mistake qpdf names
           as "object stream id … is impossibly large". */
        rows.push(row(2, 4, n === 9 ? 0 : 1));
      } else {
        rows.push(row(0, 0, 0));
      }
    }
    const xdata = zlib.deflateSync(Buffer.concat(rows));
    chunks.push(Buffer.from(
      `8 0 obj\n<< /Type /XRef /Size ${size} /W [${W.join(" ")}] /Root 1 0 R /Info 9 0 R ` +
      `/Filter /FlateDecode /Length ${xdata.length} >>\nstream\n`, "latin1"),
      xdata, Buffer.from("\nendstream\nendobj\n", "latin1"),
      Buffer.from(`startxref\n${xrefAt}\n%%EOF\n`, "latin1"));
    files.set("xrefstream.pdf", Buffer.concat(chunks));
  }

  /* — the five damaged files §6 names — */
  files.set("empty.pdf", Buffer.alloc(0));
  files.set("notapdf.pdf", Buffer.from("See ei ole PDF, see on tavaline tekst.\n".repeat(40), "utf8"));
  files.set("corrupt.pdf", Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.from(Array.from({ length: 800 }, (_, i) => (i * 37 + 11) & 0xff)),
  ]));
  files.set("truncated.pdf", files.get("classic.pdf").subarray(0, Math.floor(files.get("classic.pdf").length / 2)));

  return files;
}

/* ── Main ──────────────────────────────────────────────────────────────────── */

function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  let written = 0;
  let unchanged = 0;
  const changed = [];

  for (const [name, data] of build()) {
    const target = path.join(OUT, name);
    const sha = createHash("sha256").update(data).digest("hex").slice(0, 16);

    if (fs.existsSync(target)) {
      const before = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
      const after = createHash("sha256").update(data).digest("hex");
      if (before === after) { unchanged++; continue; }
      changed.push(name);
    }

    fs.writeFileSync(target, data);
    written++;
    console.log(`  ${name.padEnd(26)} ${String(data.length).padStart(8)} B  ${sha}`);
  }

  console.log("");
  console.log(`${written} written, ${unchanged} already identical.`);
  if (changed.length) {
    console.log(`\x1b[33m${changed.length} file(s) differ from what was committed:\x1b[0m`);
    for (const c of changed) console.log(`  ${c}`);
    console.log("A corpus that drifts is a corpus whose tests no longer test what they claim.");
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error("harness error:", err?.message || err);
  process.exit(2);
}