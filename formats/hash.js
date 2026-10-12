// ── formats/hash.js ───────────────────────────────────────────────────────────
// The three digests shown in the Fail tab.
//
// SHA-256 and SHA-1 come from Web Crypto. MD5 does not: the platform exposes
// SHA-2 and SHA-3 families only, and MD5 is here because it is the identifier
// people actually quote when asking "is this the same file" — not because it is
// fit for anything security-shaped. Requirement 8 calls for a vendored
// implementation; this one is written from RFC 1321 and verified against
// `md5sum` in tools/, so there is no licence to ship and no dependency to pin.
//
// All three take the whole message at once. Web Crypto has no incremental digest
// and there is no reason to want one here: stage 1 already holds the entire file
// for the analyser, so hashing costs a second pass over memory rather than a
// second copy of it.
// ─────────────────────────────────────────────────────────────────────────────

/* ── Web Crypto ───────────────────────────────────────────────────────────── */

/** SubtleCrypto is undefined outside a secure context, which is every non-HTTPS
 *  origin and `file://`. Throwing a sentence the page can show beats a
 *  `TypeError: Cannot read properties of undefined` — the README already warns
 *  that the page needs a server, and this is what that warning looks like. */
function subtle() {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "Web Crypto pole saadaval. Leht peab töötama HTTPS-i või localhosti kaudu.",
    );
  }
  return globalThis.crypto.subtle;
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function sha(algorithm, bytes) {
  return subtle()
    .digest(algorithm, bytes)
    .then(toHex);
}

/* ── MD5 ─────────────────────────────────────────────────────────────────────
   RFC 1321, reference formulation: four rounds, each with its own shift
   schedule and its own nonlinear function. The constants are
   floor(2^32 × |sin(i + 1)|), which is a description of the algorithm rather
   than 64 magic numbers nobody can check.

   Operands are Int32 in the loop and >>> 0 on the way out, because JavaScript's
   bitwise operators are signed 32-bit and MD5's are not. Every addition that can
   leave the unsigned range is truncated explicitly. */

const SHIFTS = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
}

/** Rotation, written out because `<<` on a 32-bit value in JavaScript loses the
 *  bits that leave the top of the register — the classic way to get MD4, MD5 and
 *  SHA-1 subtly wrong in JavaScript. */
function rotateLeft(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

export function md5(bytes) {
  /* Pad to a multiple of 64 bytes: the message, a 0x80 byte, zeros, then the
     bit length as a 64-bit little-endian integer. */
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const bitLength = bytes.length * 8;
  for (let i = 0; i < 8; i++) {
    /* Little-endian, and split across two words: the low 32 bits are a bitwise
       op, the high 32 bits need division, because a 1 GB file overflows the
       unsigned 32-bit range the moment it is multiplied by 8. */
    padded[padded.length - 8 + i] = (bitLength >>> (i * 8)) & 0xff;
  }
  const high = Math.floor(bitLength / 4294967296);
  for (let i = 0; i < 4; i++) {
    padded[padded.length - 4 + i] = (high >>> (i * 8)) & 0xff;
  }

  const view = new DataView(padded.buffer);
  const words = new Int32Array(16);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(chunk + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const sum = (f + a + K[i] + words[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft(sum, SHIFTS[i])) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  /* The four state words, little-endian, in order a, b, c, d. */
  const digest = new Uint8Array(16);
  const out = new DataView(digest.buffer);
  [a0, b0, c0, d0].forEach((word, i) => out.setUint32(i * 4, word, true));
  return toHex(digest.buffer);
}

/* ── All three ───────────────────────────────────────────────────────────── */

/**
 * SHA-256, SHA-1 and MD5 of the same bytes.
 *
 * SHA-2 and SHA-1 run concurrently because they are independent native calls
 * and a 200 MB file makes the difference visible. MD5 is synchronous JavaScript
 * and cannot join them — on a large file it is the slowest thing on the page by
 * a wide margin, which is the price of supporting the one digest people quote.
 */
export async function digests(bytes) {
  const [sha256, sha1] = await Promise.all([
    sha("SHA-256", bytes),
    sha("SHA-1", bytes),
  ]);
  return { sha256, sha1, md5: md5(bytes) };
}