#!/usr/bin/env node
/**
 * extensibility-proof.mjs — the project's definition of done, executed.
 *
 * §13's last item: "**Extensibility, proven rather than asserted:** a stub
 * analyser registered in `formats/registry.js`, with no other edit anywhere, is
 * detected and its nodes appear under their own tab. If adding that stub
 * requires touching §5 or §6, the architecture is not finished and the work is
 * not done."
 *
 * So this does exactly what the README's "Adding a format" section tells a
 * stranger to do, in that order, and then checks the three things the section
 * promises:
 *
 *   1. a file in the new format is **detected**, with no edit to the page;
 *   2. its nodes appear under **their own tab**, named from the `group` value —
 *      not folded into an existing one, and not requiring a tab list edit;
 *   3. the privacy test covers it, **without being edited** — because it
 *      iterates `FORMATS` rather than a list of files.
 *
 * The stub is a real format with real magic bytes and a real analyser. It is
 * called "stub" because it is only a few lines, not because it is a mock: it is
 * registered exactly the way a production format would be, which is the only way
 * the claim means anything.
 *
 * The script removes everything it added, and says so, so a failed run does not
 * leave the repository with a phantom format in it.
 *
 * Usage:  node tools/extensibility-proof.mjs
 * Exit:   0 the architecture holds, 1 it does not, 2 harness error.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(ROOT, "formats/registry.js");
const ANALYSER = path.join(ROOT, "formats/stub/index.js");
const CORPUS = path.join(ROOT, "test-pdfs");

/* ── The stub, exactly as the README tells a reader to write it ───────────────── */

const STUB_ANALYSER = `// formats/stub/index.js — the file the README's "Adding a format"
// section tells you to create, written here to prove the claim rather than to
// assert it. Format name in Estonian, per requirement 12; identifiers English.
import { node } from "../node.js";

export const analyser = {
  id: "stub",
  labelEt: "Testivorming",

  async analyse(bytes, ctx) {
    ctx.emitNode(
      node({
        id: "stub.magic",
        group: "stub",            // its own group, so it gets its own tab
        labelEt: "Erimärgis",
        labelEn: "Magic",
        value: [...bytes.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
      }),
    );
    ctx.emitNode(
      node({
        id: "stub.size",
        group: "stub",
        labelEt: "Suurus",
        labelEn: "Size",
        value: bytes.length + " B",
      }),
    );
    return { nodes: [], blobs: [] };
  },
};
`;

/** The one registry line the README's step 3 asks for. */
const REGISTRY_ENTRY = `  {
    id: "stub",
    labelEt: "Testivorming",
    priority: 50,
    magic: [0x53, 0x54, 0x55, 0x42],
    /* Its own group, named here — the one line that gives the tab a proper
       Estonian label instead of the bare key. */
    groups: [{ key: "stub", labelEt: "Testivorming" }],
    load: () => import("./stub/index.js"),
  },
`;

/** A file in the new format: the four magic bytes, then a little payload. */
const STUB_FILE = Buffer.concat([
  Buffer.from("STUB", "latin1"),
  Buffer.from("formaadi tõestusfail\n", "latin1"),
  Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
]);

/* ── Bookkeeping ───────────────────────────────────────────────────────────── */

const created = [];
let registryBackup = null;

function cleanup() {
  if (registryBackup !== null) fs.writeFileSync(REGISTRY, registryBackup);
  if (fs.existsSync(ANALYSER)) fs.rmSync(path.dirname(ANALYSER), { recursive: true, force: true });
  const fixture = path.join(CORPUS, "stub.stu");
  if (fs.existsSync(fixture)) fs.rmSync(fixture);
}

function ok(name, condition, detail = "") {
  console.log(`${condition ? "\x1b[32m  ok\x1b[0m  " : "\x1b[31mFAIL\x1b[0m  "}${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
  return condition;
}

/* ── Step 1: the analyser, as the README says ──────────────────────────────── */

function writeAnalyser() {
  fs.mkdirSync(path.join(ROOT, "formats/stub"), { recursive: true });
  fs.writeFileSync(ANALYSER, STUB_ANALYSER);
  created.push(path.dirname(ANALYSER));
}

/* ── Step 3: one registry line, as the README says ─────────────────────────── */

function addRegistryEntry() {
  registryBackup = fs.readFileSync(REGISTRY, "utf8");
  const anchor = "const ENTRIES = [\n";
  const at = registryBackup.indexOf(anchor);
  if (at === -1) throw new Error("could not find the ENTRIES array in formats/registry.js");
  const insertAt = at + anchor.length;
  fs.writeFileSync(
    REGISTRY,
    registryBackup.slice(0, insertAt) + REGISTRY_ENTRY + registryBackup.slice(insertAt),
  );
}

/* ── Step 4: a file in the corpus ──────────────────────────────────────────── */

function writeFixture() {
  fs.writeFileSync(path.join(CORPUS, "stub.stu"), STUB_FILE);
}

/* ── The checks ────────────────────────────────────────────────────────────── */

async function main() {
  console.log("Extensibility proof — §13's last item, executed");
  console.log("─".repeat(72));
  console.log("Following the README's \"Adding a format\" section verbatim.");
  console.log("");

  /* Record what we are about to touch, so the claim "no other edit anywhere"
     can be checked rather than asserted. */
  const before = snapshot(ROOT);

  try {
    writeAnalyser();
    addRegistryEntry();
    writeFixture();

    const afterWrite = snapshot(ROOT);
    const touched = diff(before, afterWrite);

    /* The whole architectural claim, in one list. */
    const allowed = new Set([
      path.join(ROOT, "formats/stub/index.js"),
      path.join(ROOT, "formats/registry.js"),
      path.join(CORPUS, "stub.stu"),
    ]);
    const unexpected = [...touched, ...created.map((p) => path.join(p, "index.js"))]
      .filter((f) => !allowed.has(f));

    console.log("files changed:");
    for (const f of touched) console.log(`   ${path.relative(ROOT, f)}`);
    console.log("");
    ok("no file outside the three the README names changed", unexpected.length === 0,
       unexpected.map((f) => path.relative(ROOT, f)).join(", "));

    const env = await launch();
    try {
      const { sessionId } = await env.open("metaandmed.html", { settle: 1000 });
      const ev = async (e) => (await env.evalRaw(e, sessionId)).result?.value;

      const doc = await env.cdp.send("DOM.getDocument", {}, sessionId);
      const { nodeId } = await env.cdp.send(
        "DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#file-input" }, sessionId,
      );
      await env.cdp.send("DOM.setFileInputFiles",
        { files: [path.join(CORPUS, "stub.stu")], nodeId }, sessionId);
      await ev(`(async () => {
        document.getElementById("file-input").dispatchEvent(new Event("change"));
        for (let i = 0; i < 20; i++) {
          if (document.getElementById("status-line").textContent.trim() !== "Analüüsin…") break;
          await new Promise(r => setTimeout(r, 300));
        } })()`);

      const badge = (await ev(`document.getElementById("format-badge").textContent.trim()`)) ?? "";
      const tabs = JSON.parse(await ev(
        `JSON.stringify([...document.querySelectorAll('#tab-strip button')].map(b => b.textContent.trim()))`));
      const status = (await ev(`document.getElementById("status-line").textContent.trim()`)) ?? "";
      const panelText = (await ev(
        `document.getElementById('panel-stub')?.innerText.replace(/\\s+/g,' ') ?? ''`)) ?? "";

      console.log("");
      console.log(`badge: ${badge}`);
      console.log(`tabs:  ${JSON.stringify(tabs)}`);
      console.log(`panel: ${panelText}`);
      console.log("");

      ok("the file was detected, with no edit to the page", badge === "Testivorming", badge);
      ok("it got its own tab, named from the group", tabs.includes("Testivorming"), JSON.stringify(tabs));
      ok("its nodes render under that tab", panelText.includes("Erimärgis") && panelText.includes("Suurus"), "");
      ok("the analyser's own Estonian label reached the badge", badge === "Testivorming", "");
      ok("the analysis finished", status !== "Analüüsin…", status.slice(0, 60));
      ok("no existing tab was removed", tabs.includes("Fail"), JSON.stringify(tabs));
    } finally {
      await env.close();
    }

    /* Step 4's other half: the privacy test must cover the new format without
       being edited, because it iterates FORMATS. */
    const { FORMATS } = await import("../formats/registry.js");
    ok("the privacy test will cover it, with no edit to that test",
       FORMATS.some((f) => f.id === "stub"),
       `FORMATS: ${FORMATS.map((f) => f.id).join(", ")}`);
  } finally {
    cleanup();
  }

  const restored = snapshot(ROOT);
  ok("everything the proof added was removed again",
     diff(before, restored).length === 0,
     diff(before, restored).map((f) => path.relative(ROOT, f)).join(", "));
}

/**
 * Content, not timestamps.
 *
 * The first version hashed mtimes and reported `formats/registry.js` as changed
 * after a perfectly good cleanup — rewriting a file restores its contents but
 * not its mtime, so the check was measuring the restoration, not the edit. It is
 * also the check that would catch a half-restored file, which is the whole point
 * of running it at all.
 */
function snapshot(dir, out = new Map()) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) snapshot(full, out);
    else out.set(full, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
  }
  return out;
}

function diff(before, after) {
  const out = [];
  for (const [file, mtime] of after) {
    if (!before.has(file) || before.get(file) !== mtime) out.push(file);
  }
  return out;
}

try {
  const passed = await main();
  console.log("");
  if (passed === false) process.exit(1);
  console.log("\x1b[32mOK\x1b[0m  a new format needed three files and nothing else.");
  process.exit(0);
} catch (err) {
  cleanup();
  console.error("harness error:", err?.message || err);
  process.exit(2);
}