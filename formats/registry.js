// ── formats/registry.js ───────────────────────────────────────────────────────
// The only file that knows which formats exist (§4.4).
//
// Detection is synchronous and cheap, because it runs against every entry on
// every selection. The analyser code itself loads lazily, and only after a
// format has matched — so PNG, TIFF and office support can sit in this list
// without costing a visitor who selected a PDF a single byte of them.
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS, makeClock } from "./contract.js";
import { digests } from "./hash.js";
import { node } from "./node.js";

/* ── Entries ──────────────────────────────────────────────────────────────────
   `priority` breaks ties between formats whose magic bytes share a prefix.

   `detect` is optional. It defaults to "these bytes start with `magic`", which
   is the right answer for everything except PDF, and is stated here as a
   default rather than written out five times. The PDF entry overrides it. */

const ENTRIES = [
  {
    id: "pdf",
    labelEt: "PDF",
    priority: 100,
    magic: [0x25, 0x50, 0x44, 0x46], // %PDF
    load: () => import("./pdf/index.js"),
    /* §7.9.1 lets the header sit anywhere in the first 1024 bytes, because real
       files have prefixes. A file whose %PDF is at byte 0 is still a PDF, so the
       entry claims it and the offset is reported by the analyser rather than
       guessed at here. Nothing else gets this: a JPEG with a prepended byte is
       a broken JPEG, not a slightly-less-certain one. */
    detect: pdfDetect,
  },
  {
    id: "jpeg",
    labelEt: "JPEG",
    priority: 70,
    magic: [0xff, 0xd8, 0xff],
    load: () => import("./images/jpeg.js"),
  },
];

/* ── Stage 3: blob analysers ─────────────────────────────────────────────────
   These do not detect files. They are handed bytes by stage 2 through the
   `blobs` channel (§4.2), and they are keyed by the *media type* of what they
   were given, not by the format of the container.

   That indirection is the whole point of phase 9, and it is why this list is
   separate from `ENTRIES`: a JPEG reaches this stage identically whether it was
   embedded in a PDF or chosen from the visitor's disk. The first version loaded
   the analyser by blob index, which would have made "embedded in a PDF" and
   "selected directly" two different code paths wearing one name. */

const BLOB_ANALYSERS = [
  {
    mediaType: "image/jpeg",
    load: () => import("./images/jpeg.js"),
  },
];

const blobAnalyserCache = new Map();

/** The stage-3 analyser for a media type, or null. Null means "no analyser for
 *  this kind of payload", which is a normal outcome — a PNG inside a PDF gets a
 *  description from the container and nothing further. */
async function blobAnalyserFor(mediaType) {
  const wanted = String(mediaType ?? "").split(";")[0].trim().toLowerCase();
  const entry = BLOB_ANALYSERS.find((b) => b.mediaType === wanted);
  if (!entry) return null;

  if (!blobAnalyserCache.has(entry.mediaType)) {
    blobAnalyserCache.set(entry.mediaType, entry.load());
  }
  try {
    const mod = await blobAnalyserCache.get(entry.mediaType);
    return mod.analyser ?? mod.default ?? null;
  } catch {
    return null;
  }
}

/* Exported so the privacy test can iterate the same list the page uses.
 *
 * A behavioural test with its own hard-coded format list tests the formats that
 * exist today and silently stops testing whatever is added next — which is the
 * failure mode §4.4's lazy-loading design creates, not one it removes. Sharing
 * the registry means a format added in a later phase is covered the day it
 * lands, with no edit here. */
export const FORMATS = ENTRIES;

/**
 * Estonian names for groups a format invents, collected from the registry.
 *
 * `formats/node.js` knows the seven groups this project uses and their order. A
 * format added later will have groups nobody has a name for, and the tab would
 * otherwise read as the bare key — "stub", "epub", "wbmp" — which is requirement
 * 12 failing on a technicality. So a registry entry may declare
 *
 *   groups: [{ key: "stub", labelEt: "Testivorming" }]
 *
 * and that is the *whole* of the naming requirement: still one line in one file,
 * still no edit to the page. Keys declared here win over the fallback, and a key
 * declared by two formats simply takes the first — a collision is a duplicate
 * group, not a broken page.
 */
export const GROUP_LABELS = new Map(
  ENTRIES.flatMap((e) => (e.groups ?? []).map((g) => [g.key, g.labelEt])),
);

/* ── Matching ────────────────────────────────────────────────────────────────
   How many bytes identification may read.

   1024, not 16, and the number comes from the PDF rule rather than from taste:
   the header may legally sit anywhere in the first 1024 bytes, so reading fewer
   would miss a conforming file. A kilobyte is still nothing — this is not the
   file, and stage 2 decides when a real buffer exists. */

export const DETECT_BYTES = 1024;

/** Does `head` start with this entry's magic? A zero-length magic never
 *  matches — an empty signature would claim every file, including an empty one. */
function matchesMagic(head, magic) {
  if (!magic.length || head.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (head[i] !== magic[i]) return false;
  }
  return true;
}

/** The entry's own detection, or prefix matching on its magic. 100 when the
 *  bytes are there, 0 when they are not — deliberately binary, because for a
 *  magic number there is no such thing as a near miss. The number exists so the
 *  loop can rank, not so the interface can hedge. */
function entryConfidence(entry, head) {
  return entry.detect ? entry.detect(head) : matchesMagic(head, entry.magic) ? 100 : 0;
}

/** PDF: `%PDF` anywhere in the first 1024 bytes, confidence falling as it moves
 *  back so a file that starts with it always outranks one that does not. */
function pdfDetect(head) {
  const limit = Math.min(head.length, 1024) - 4;
  for (let i = 0; i <= limit; i++) {
    if (
      head[i] === 0x25 &&
      head[i + 1] === 0x50 &&
      head[i + 2] === 0x44 &&
      head[i + 3] === 0x46
    ) {
      return i === 0 ? 100 : Math.round(100 - i / 11);
    }
  }
  return 0;
}

/**
 * The best entry for these bytes, or null.
 *
 * An empty or unrecognised file returns null, which the caller reports as
 * *tundmatu formaat* — never as a format guessed from the extension.
 */
export function detectFormat(head) {
  const bytes = head instanceof Uint8Array ? head : new Uint8Array(head ?? []);

  let best = null;
  for (const entry of ENTRIES) {
    const confidence = entryConfidence(entry, bytes);
    if (confidence === 0) continue;
    /* Confidence decides, then priority. Both are needed: PDF and a future
       container could share a signature, and neither should win on array order. */
    if (
      !best ||
      confidence > best.confidence ||
      (confidence === best.confidence && entry.priority > best.entry.priority)
    ) {
      best = { entry, confidence };
    }
  }

  if (!best) return null;
  return { id: best.entry.id, labelEt: best.entry.labelEt, confidence: best.confidence };
}

/* ── Pipeline ────────────────────────────────────────────────────────────────
   Four stages. Stage 2 and stage 3 are plugins; this file owns stages 1 and 4
   because they are the parts that must behave identically for every format. */

/* ── The file-size cap ───────────────────────────────────────────────────────
   §11 requires the cap to be "documented and enforced in the UI before the read
   starts", and the number comes from a measurement rather than from taste.

   Measured in phase 12 by watching the resident set of every Chromium process
   while a real, parseable PDF of each size was analysed:

       50 MB file  →  475 MB peak,  3.4 s,  796 pages
     200 MB file  → 1758 MB peak, 12.2 s, 3185 pages
     300 MB file  → 2151 MB peak, 18.1 s, 4778 pages

   That is roughly `206 MB + 6.85 × the file`, not the "peak two buffers" §4.5
   predicted. The reason is visible in the code: the bytes exist as the `File`,
   as the `Uint8Array`, as the latin1 string the raw scanner works on, as the
   copy handed to pdf.js, and again inside the worker. Five, not two — and the
   correction is written into §4.5 rather than quietly left as a number that is
   wrong by three times.

   200 MB is the published limit: it measured at 1.8 GB of peak resident memory
   and 12 seconds, which an ordinary 8 GB laptop survives with another tab open.
   300 MB measured at 2.1 GB and 18 seconds — workable, not comfortable, and the
   difference between the two is the whole argument for a line.

   The line is not about what the page *can* do. It is about what it should do on
   a machine whose memory it has never seen: an 8 GB laptop with a video call and
   four other tabs cannot afford a 2 GB spike it did not ask for. Refusing costs
   the visitor one sentence and 0.3 seconds; proceeding might cost them the tab,
   and with it the analysis they came for.

   The check is here, before anything reads the file, so a 2 GB file costs a
   `File.size` lookup and an Estonian sentence rather than a tab that dies. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

/** The message, in one place, so the number and the sentence cannot drift apart. */
export function tooLargeMessage(file) {
  const mb = (file.size / (1024 * 1024)).toFixed(0);
  return (
    `Fail on liiga suur (${mb} MB). Analüüsi piir on ${MAX_FILE_BYTES / (1024 * 1024)} MB. ` +
    `Suurema faili analüüs vajab ligikaudu kuus korda rohkem mälu, kui faili enda suurus.`
  );
}

export async function runAnalysis(file) {
  const clock = makeClock();
  const nodes = [];
  const blobs = [];
  const errors = [];

  if (file.size > MAX_FILE_BYTES) {
    return {
      nodes: [],
      blobs: [],
      errors: [{ code: "file-too-large", messageEt: tooLargeMessage(file) }],
      detected: null,
    };
  }

  /* Stage 1 — identification. Identifies the format and reports the file-level
     facts every format shares.

     Two reads, deliberately different in size. The first is a kilobyte, purely
     to answer "which format is this", and it happens before anything is loaded —
     an unknown file costs a kilobyte, not a whole buffer. The second is the file
     itself, and it is read once and used twice: Web Crypto needs the whole
     message to digest it, and the stage-2 analyser needs the same bytes. Reading
     it twice would double peak memory for no reason. */
  const head = new Uint8Array(await file.slice(0, DETECT_BYTES).arrayBuffer());
  const detected = detectFormat(head);
  nodes.push(...fileNodes(file, detected));

  /* Wrapped: arrayBuffer() hands back an ArrayBuffer, which has no subarray, no
     byteLength index and no slice — an analyser that indexes bytes would get
     "not a function" on its first line, and the stack would point at the
     analyser rather than at the call that should have converted it. */
  const bytes = new Uint8Array(await file.slice(0, file.size).arrayBuffer());

  /* Hashing happens before the detection gate, and that ordering is deliberate.
     An earlier draft returned early on an unknown format, which left a file the
     tool could not read with no checksum at all — and "what is this file" is
     most often exactly the question someone has when the format is unrecognised.
     The digests describe bytes, not formats, so they are the one thing every
     file gets. The cost is that a large unrecognised file is read in full; the
     file-size cap in §12 is what bounds that, and it has to be tested against an
     unknown format rather than a PDF. */
  await addDigests(file, bytes, nodes, errors);

  if (!detected) {
    errors.push({
      code: "unknown-format",
      messageEt:
        "Faili vormingut ei saanud tuvastada. Kui see on PDF, kontrolli, et fail pole rikutud.",
    });
    return { nodes, blobs, errors, detected: null };
  }

  /* Stage 2 — the container analyser, loaded only now. */
  const entry = ENTRIES.find((e) => e.id === detected.id);
  const mod = await entry.load();
  const analyser = mod.analyser ?? mod.default;

  const ctx = {
    limits: LIMITS,
    clock,
    emitNode: (n) => nodes.push(n),
    reportError: (messageEt, code) => errors.push({ code, messageEt }),
  };

  try {
    const result = await analyser.analyse(bytes, ctx);
    nodes.push(...(result?.nodes ?? []));
    blobs.push(...(result?.blobs ?? []));
  } catch (err) {
    /* An analyser that throws is a fact about the file, not a crash: a
       truncated or hostile PDF should read as "we got this far and no further",
       never as a dead tab with the visitor's file still selected. */
    errors.push({
      code: "analyser-failed",
      messageEt: `Analüüs katkes: ${err?.message ?? "teadmata viga"}`,
    });
  }

  /* Stage 3 — blob analysers. Each blob is handed to the analyser registered
     for its media type, and the nodes it produces join the same tree.
     *
     * A blob analyser that throws is contained exactly as a container analyser
     * is: a corrupt EXIF block inside an otherwise perfect PDF must not cost the
     * visitor the page count, the Info dictionary and the revision chain. The
     * failure is reported against the blob, so the visitor sees that the picture
     * inside was unreadable and not that the document was. */
  for (const blob of blobs) {
    const blobAnalyser = await blobAnalyserFor(blob.mediaType);
    if (!blobAnalyser) {
      /* No analyser for this payload type. Not an error — a PNG inside a PDF is
         described by the container and needs nothing further. It is counted, so
         "we read 4 of 7 images" is a claim the page can make honestly. */
      blob.unanalysed = true;
      continue;
    }
    try {
      const result = await blobAnalyser.analyse(blob.bytes, ctx);
      nodes.push(...(result?.nodes ?? []));
      blob.analysedBy = blobAnalyser.id;
    } catch (err) {
      errors.push({
        code: "blob-analyser-failed",
        messageEt:
          `Manuse ${blob.origin?.objectName ?? blob.mediaType} analüüs katkes: ` +
          `${err?.message ?? "teadmata viga"}`,
      });
      blob.failed = true;
    }
  }

  /* Stage 4 — normalise. Every node is rebuilt through the shape so an analyser
     cannot smuggle a field the renderer does not know about, or a group the
     tabs do not recognise. */
  return { nodes: nodes.map(node), blobs, errors, detected };
}

/* ── Digests ─────────────────────────────────────────────────────────────────
   Hashing is a fact about the file, not about its format, so it lives here in
   stage 1 rather than in any analyser: a JPEG and a PDF get the same three rows,
   and a future format gets them for free.

   A failure to hash is reported, never fatal. A file too large for Web Crypto to
   digest should still show its page count and its metadata — losing the whole
   analysis because one digest did not fit would be a worse failure than a
   missing row. */
async function addDigests(file, bytes, nodes, errors) {
  try {
    const { sha256, sha1, md5 } = await digests(bytes);
    for (const [id, label, value] of [
      ["file.sha256", "SHA-256", sha256],
      ["file.sha1", "SHA-1", sha1],
      ["file.md5", "MD5", md5],
    ]) {
      nodes.push(
        node({ id, group: "file", labelEt: `${label} kontrollsumma`, labelEn: label, value }),
      );
    }
  } catch (err) {
    errors.push({
      code: "digest-failed",
      messageEt: `Kontrollsummasid ei saanud arvutada: ${err?.message ?? "teadmata viga"}`,
    });
  }
}

/** Stage 1's output. Same for every format, which is why it is not a layer. */
function fileNodes(file, detected) {
  const out = [
    node({ id: "file.name", group: "file", labelEt: "Failinimi", value: file.name }),
    node({
      id: "file.size",
      group: "file",
      labelEt: "Suurus",
      labelEn: "Size",
      value: `${file.size} B`,
    }),
    node({
      id: "file.type",
      group: "file",
      labelEt: "MIME-tüüp",
      labelEn: "MIME type",
      // What the browser claims, which is derived from the name and is often
      // empty or wrong. Reported as a claim, never as a detection.
      value: file.type || "(puudub)",
    }),
    node({
      id: "file.lastModified",
      group: "file",
      labelEt: "Muudetud",
      labelEn: "Last modified",
      // The filesystem's timestamp, not the file's. A document can carry a
      // creation date in its metadata that is years away from this, and §5.4
      // reports that disagreement rather than resolving it.
      value: file.lastModified
        ? new Date(file.lastModified).toLocaleString("et-EE")
        : "(teadmata)",
    }),
  ];

  if (detected) {
    out.push(
      node({
        id: "file.format",
        group: "file",
        labelEt: "Tuvastatud vorming",
        labelEn: "Detected format",
        value: detected.labelEt,
      }),
    );
  } else {
    out.push(
      node({
        id: "file.format",
        group: "file",
        labelEt: "Tuvastatud vorming",
        labelEn: "Detected format",
        value: "tundmatu",
        confidence: "absent",
      }),
    );
  }

  return out;
}