/* Build the release branch from `dev` and open a PR for it.
 *
 *   node tools/release.mjs              build + gates only, touches no git state
 *   node tools/release.mjs --push       also branch, commit, push, open the PR
 *   node tools/release.mjs --dry-run    git steps without pushing
 *
 * The branch is cut from `release` tip, not from `dev` tip. That is the whole
 * reason the daily data.json commit survives: starting from dev would revert it.
 * The very first run has no release to build on and starts from dev instead.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ROOT } from "./root.mjs";
import { shippedFiles, verifyFiles, stripFile, write, check, isStrippable } from "./strip-comments.mjs";

const SOURCE = "dev";
const TARGET = "release";
const PR_BRANCH = "release-candidate";

const argv = process.argv.slice(2);
const PUSH = argv.includes("--push");
const DRY = argv.includes("--dry-run");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oigusmasin-release-"));
const tree = path.join(tmp, "site");

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", cwd: DEFAULT_ROOT, ...opts }).trim();

const gates = [];
const gate = (name, fn) => {
  const started = Date.now();
  try {
    fn();
    gates.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ok    ${name}`);
  } catch (err) {
    gates.push({ name, ok: false, ms: Date.now() - started, error: err });
    console.log(`  FAIL  ${name}`);
    console.log(
      String(err.stdout || err.stderr || err.message)
        .split("\n")
        .map((l) => `        ${l}`)
        .join("\n"),
    );
  }
};

/* Inline <script> bodies, for `node --check`. Parsing only — the code never
 * runs here, so `document` being undefined does not matter. */
function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    if (m[2].trim()) out.push(m[2]);
  }
  return out;
}

console.log("─".repeat(72));
console.log(`Release build — source ${SOURCE}, target ${TARGET}`);
console.log("─".repeat(72));

fs.mkdirSync(tree, { recursive: true });
const stats = write(tree, DEFAULT_ROOT);
console.log(`Stripped ${stats.files} files -> ${tree}`);
console.log(
  `  ${(stats.bytesIn / 1024).toFixed(1)} kB -> ${(stats.bytesOut / 1024).toFixed(1)} kB (${Math.round((1 - stats.bytesOut / stats.bytesIn) * 100)}% smaller)`,
);
console.log("");

const run = (script, label, args = []) => {
  const r = spawnSync(process.execPath, [path.join(DEFAULT_ROOT, "tools", script), ...args], {
    encoding: "utf8",
    cwd: DEFAULT_ROOT,
  });
  if (r.status !== 0) {
    const out = (r.stdout || "") + (r.stderr || "");
    const lines = out.split("\n").filter((l) => /FAIL|✗|Error|not ok|expected/i.test(l));
    throw new Error(`${label} failed\n${(lines.length ? lines : out.split("\n").slice(-12)).join("\n")}`);
  }
  return r.stdout;
};

gate("stripped JavaScript parses", () => {
  const dir = path.join(tmp, "syntax");
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const rel of verifyFiles(DEFAULT_ROOT)) {
    if (!rel.endsWith(".js")) continue;
    const dest = path.join(dir, path.basename(rel));
    fs.writeFileSync(dest, stripFile(rel, fs.readFileSync(path.join(DEFAULT_ROOT, rel), "utf8")));
    execFileSync(process.execPath, ["--check", dest], { stdio: "pipe" });
    n++;
  }
  for (const rel of verifyFiles(DEFAULT_ROOT)) {
    if (!rel.endsWith(".html")) continue;
    const html = stripFile(rel, fs.readFileSync(path.join(DEFAULT_ROOT, rel), "utf8"));
    inlineScripts(html).forEach((body, i) => {
      const dest = path.join(dir, `${path.basename(rel)}.${i}.js`);
      fs.writeFileSync(dest, body);
      execFileSync(process.execPath, ["--check", dest], { stdio: "pipe" });
      n++;
    });
  }
  if (!n) throw new Error("no JavaScript found to check");
});

gate("stripping is a fixed point", () => {
  for (const rel of verifyFiles(tree)) {
    if (!isStrippable(rel)) continue;
    const content = fs.readFileSync(path.join(tree, rel), "utf8");
    if (stripFile(rel, content) !== content) {
      throw new Error(`${rel} still changes on a second strip`);
    }
  }
});

gate("no comments remain in the output", () => {
  const violations = check(tree);
  if (violations.length) {
    throw new Error(violations.map((v) => `${v.rel}: ${v.reason}`).join("\n"));
  }
});

gate("Rehkendaja unit suite (stripped tree)", () => run("run-rehkendaja-tests.mjs", "unit", ["--root", tree]));
gate("asset + nav integrity (stripped tree)", () => run("check-assets.mjs", "assets", ["--root", tree]));
gate("WCAG contrast audit (stripped tree)", () => run("contrast-audit.mjs", "contrast", ["--root", tree]));
gate("CSS convention lint (stripped tree)", () => run("check-css.mjs", "css", ["--root", tree]));
gate("DOM regression suite (stripped tree)", () => run("dom-tests.mjs", "dom", ["--root", tree]));

const failed = gates.filter((g) => !g.ok);
console.log("");
console.log(`Gates: ${gates.length - failed.length}/${gates.length} passed`);

if (failed.length) {
  console.log("Not touching git — fix the failing gate first.");
  process.exit(1);
}

if (!PUSH) {
  console.log(`Build only. Re-run with --push to cut ${PR_BRANCH} and open a PR.`);
  console.log(`Preview tree: ${tree}`);
  process.exit(0);
}

/* ── Git ─────────────────────────────────────────────────────────────────── */

sh("git", ["fetch", "origin", "--prune"]);

let base;
try {
  sh("git", ["rev-parse", "--verify", `origin/${TARGET}`]);
  base = `origin/${TARGET}`;
  console.log(`\nBuilding on top of ${TARGET} (keeps the daily data.json commit).`);
} catch {
  base = `origin/${SOURCE}`;
  console.log(`\n${TARGET} does not exist yet — first release, building from ${SOURCE}.`);
}

const wt = path.join(tmp, "worktree");
sh("git", ["worktree", "add", "--detach", wt, base]);

// Ship the manifest, and nothing else: whatever else is in the target goes.
for (const entry of fs.readdirSync(wt)) {
  if (entry === ".git") continue;
  fs.rmSync(path.join(wt, entry), { recursive: true, force: true });
}
for (const rel of shippedFiles(DEFAULT_ROOT)) {
  const dest = path.join(wt, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(tree, rel), dest);
}

sh("git", ["add", "-A"], { cwd: wt });
const changed = sh("git", ["status", "--porcelain"], { cwd: wt });

if (!changed) {
  console.log("\nNothing to release — the target already matches dev.");
  sh("git", ["worktree", "remove", "--force", wt]);
  process.exit(0);
}

const files = changed.split("\n").length;
console.log(`\n${files} change(s) staged in the release tree.`);

if (DRY) {
  console.log("--dry-run: not committing. Clean up with:");
  console.log(`  git worktree remove --force ${wt} && rm -rf ${tmp}`);
  process.exit(0);
}

sh("git", ["commit", "-q", "-m", "chore: release — regenerated from dev, comments stripped"], { cwd: wt });
sh("git", ["push", "-q", "-f", "origin", `HEAD:refs/heads/${PR_BRANCH}`], { cwd: wt });
sh("git", ["worktree", "remove", "--force", wt]);

const existing = spawnSync("gh", ["pr", "list", "--head", PR_BRANCH, "--state", "open"], { encoding: "utf8" }).stdout;
let prUrl;
if (existing.trim()) {
  prUrl = spawnSync("gh", ["pr", "edit", PR_BRANCH, "--title", `chore: release ${SOURCE} -> ${TARGET}`], {
    encoding: "utf8",
  }).stdout;
} else {
  const body = [
    `Regenerated from \`${SOURCE}\` by \`npm run release\`. Every file here is the`,
    `stripped, comment-free copy of its counterpart on \`${SOURCE}\`; the diff is`,
    `comment deletions and the removal of anything outside the shipping manifest`,
    `(tools, workflows, journals, the scraper, the test page, \`data/stats.json\`).`,
    "",
    "Gates that ran before this commit was cut:",
    ...gates.map((g) => `- ${g.name}`),
    "",
    `Merge this, then move the GitHub Pages source to \`${TARGET}\`.`,
  ].join("\n");
  const r = spawnSync(
    "gh",
    ["pr", "create", "--base", TARGET, "--head", PR_BRANCH, "--title", `chore: release ${SOURCE} -> ${TARGET}`, "--body", body],
    { encoding: "utf8", cwd: DEFAULT_ROOT },
  );
  if (r.status !== 0) {
    console.log(`Could not open the PR automatically:\n${r.stderr}`);
    process.exit(1);
  }
  prUrl = r.stdout.trim();
}

console.log(`\nPR: ${prUrl}`);
console.log(`Review, merge, then set the Pages source to ${TARGET}.`);
fs.rmSync(tmp, { recursive: true, force: true });
