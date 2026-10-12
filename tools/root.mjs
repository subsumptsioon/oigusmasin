/* Every tool scans the repo root. `--root <dir>` repoints them at a generated
 * tree, which is how the same suites run against the comment-stripped output
 * of `npm run release` without a second copy of any test. */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ROOT = path.resolve(__dirname, "..");

export function resolveRoot(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--root");
  if (i === -1) return DEFAULT_ROOT;

  const value = argv[i + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--root needs a directory argument");
  }
  return path.resolve(value);
}
