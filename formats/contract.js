// ── formats/contract.js ───────────────────────────────────────────────────────
// The whole interface, and the limits every analyser runs inside.
//
// Two responsibilities, deliberately:
//
//   1. The analyser shape — what a format must implement (§4.2).
//   2. The limits — recursion depth, object count, decompressed bytes, and a
//      wall-clock budget.
//
// The limits live here rather than in each analyser because §11 asks for
// concrete caps, and a cap written per analyser is a cap that drifts. One
// budget object, passed by reference to everything, is auditable in one place.
// ─────────────────────────────────────────────────────────────────────────────

/* ── Limits ────────────────────────────────────────────────────────────────
   Values are conservative guesses pending the memory test in §8; the file-size
   cap is set there, not here. */

export const LIMITS = {
  /** Nested containers — an object inside an object inside an array. A PDF that
   *  nests 10 000 deep is either hostile or broken, and either way the parser
   *  should have given up before the browser did. */
  maxDepth: 64,

  /** Objects, revisions or array entries in one analysis. */
  maxObjects: 2_000_000,

  /** Decompressed bytes for a single stream. Guards a decompression bomb: 1 MB
   *  of FlateDecode can expand to roughly 1000x, so this is the check that
   *  stands between a crafted file and a dead tab. */
  maxStreamBytes: 64 * 1024 * 1024,

  /** Decompressed bytes across the whole analysis. Two streams under the
   *  per-stream cap can still add up. */
  maxTotalBytes: 256 * 1024 * 1024,

  /** Wall-clock milliseconds for one analyser. On expiry it reports what it has
   *  and stops — a partial result with a visible gap beats no result. */
  maxWallClockMs: 30_000,
};

/** A per-analysis clock. `expired` is checked at every loop an analyser owns,
 *  which is why it is a method and not a bare timestamp: an analyser cannot
 *  forget to compare a number, but it can forget to call a function. */
export function makeClock(budgetMs = LIMITS.maxWallClockMs) {
  const started = performance.now();
  return {
    expired() {
      return performance.now() - started > budgetMs;
    },
    elapsed() {
      return performance.now() - started;
    },
  };
}

/* ── The analyser shape ───────────────────────────────────────────────────────
   JSDoc rather than a TypeScript interface, because there is no build step
   (requirement 7) and no type checker to read one. It documents; it does not
   enforce. `contract.md` in this directory says the same thing in prose.

   @typedef {Object} BlobRef
   @property {string}  mediaType  the container's own claim, e.g. "image/jpeg"
   @property {Uint8Array} bytes   the payload, sliced from the parent's buffer

   @typedef {Object} Ctx
   @property {typeof LIMITS} limits
   @property {ReturnType<makeClock>} clock
   @property {(n: import('./node.js').Node) => void} emitNode
   @property {(message: string, code?: string) => void} reportError

   @typedef {Object} Analyser
   @property {string}   id          stable, shown in the format badge
   @property {string}   labelEt     format name in Estonian
   @property {(bytes: Uint8Array, ctx: Ctx) => Promise<{nodes: Node[], blobs: BlobRef[]}>} analyse

   There is deliberately **no** `detect` on an analyser. Identification happens
   in formats/registry.js before anything is loaded, because loading a module to
   ask "are you needed?" is exactly what lazy loading exists to avoid — a format
   that is registered but never selected should cost a visitor nothing. So the
   registry entry carries its own probe, and an analyser is only ever constructed
   for a format that has already matched.

   An analyser never renders, never touches the DOM, and never receives anything
   it could send anywhere — bytes, not a URL. That is what makes the file-stays-
   local promise hold for a format that has not been written yet.
   ────────────────────────────────────────────────────────────────────────── */

/** Identity check used by the registry and by tests. Kept here rather than
 *  inlined so the shape is stated once. */
export function isAnalyser(candidate) {
  return (
    !!candidate &&
    typeof candidate.id === "string" &&
    typeof candidate.labelEt === "string" &&
    typeof candidate.analyse === "function"
  );
}