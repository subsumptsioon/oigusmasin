// ── nav.js ────────────────────────────────────────────────────────────────────
// Single source of truth for sidebar navigation, plus the site-wide UI helpers
// every page needs. Loaded by every page (npm run check enforces it).
// Writes the sidebar, wires the mobile toggle, and defines copyButton().
// Usage: <script src="nav.js"></script> anywhere after the sidebar/overlay divs.
//
// To add a page:    add an entry to NAV_ITEMS below.
// To rename a page: change the label in NAV_ITEMS below.
// The active item is detected automatically from window.location.pathname.
// ─────────────────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { label: "Rehkendaja", href: "index.html" },
  { label: "Karistuste liitmine", href: "karistuste-liitmine.html" },
  { label: "Narkonimekirjad I–VI", href: "narkonimekirjad.html" },
  {
    label: "Ennetähtaegne vabastamine",
    href: "ennetahtaegne-vabastamine.html",
  },
  { label: "Vanus", href: "isikukood.html" },
];

const NAV_BRAND = "Tööriistad";
const NAV_AUTHOR = "© Andraš Tšitškan";

// ── copyButton ────────────────────────────────────────────────────────────────
// The one copy-to-clipboard button on the site: writes `text`, swaps the label
// for a confirmation, then puts the original back. The `is-on` class doubles as
// the in-flight guard, so a double click cannot queue a second timer and leave
// the label stuck on the confirmation.
//
// Three pages had this inline and each had drifted on the details (one used
// "Kopeeritud ✓", the other two "✓"; one put the text on a DOM expando rather
// than passing it in). Pass the text — this is a copy button, not a formatter.
//
// Clipboard writes are async and can reject (denied permission, no secure
// context). The old `is-on` guard then stranded the button in its busy state
// forever, so the failure path clears it too.
function copyButton(btn, text, confirmLabel) {
  if (btn.classList.contains("is-on")) return;

  const orig = btn.textContent;
  const restore = () => {
    btn.textContent = orig;
    btn.classList.remove("is-on");
  };

  btn.classList.add("is-on");
  navigator.clipboard.writeText(text).then(
    () => {
      btn.textContent = confirmLabel || "Kopeeritud ✓";
      setTimeout(restore, 1800);
    },
    /* The guard is held for the whole 1800ms so a second click cannot queue a
     * second timer and strand the label on the confirmation. On failure there
     * is nothing to confirm, so release it at once rather than leaving a button
     * that looks busy and no longer is. */
    restore,
  );
}

(function () {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  // Detect current page — match on filename only
  const currentFile = window.location.pathname.split("/").pop() || "index.html";

  // ── Build sidebar HTML ─────────────────────────────────────────────────────
  const items = NAV_ITEMS.map((item, i) => {
    const active = item.href === currentFile;
    const cls = active ? "nav-item active" : "nav-item";
    const cur = active ? ' aria-current="page"' : "";
    return `<a class="${cls}"${cur} href="${item.href}">
      <span class="nav-sigil">${String(i + 1).padStart(2, "0")}</span>
      ${item.label}
    </a>`;
  }).join("\n    ");

  sidebar.innerHTML = `
    <a class="sidebar-brand" href="index.html">
      <div class="brand-mark"></div>
      <div class="brand-name">${NAV_BRAND}</div>
    </a>
    ${items}
    <div class="sidebar-foot">
      ${NAV_AUTHOR}&nbsp;${new Date().getFullYear()}
    </div>`;

  // ── Mobile toggle ──────────────────────────────────────────────────────────
  const overlay = document.getElementById("sidebar-overlay");
  const togBtn = document.getElementById("sidebar-toggle");
  if (!overlay || !togBtn) return;

  const setOpen = (on) => {
    sidebar.classList.toggle("open", on);
    overlay.classList.toggle("visible", on);
  };
  togBtn.addEventListener("click", () =>
    setOpen(!sidebar.classList.contains("open")),
  );
  overlay.addEventListener("click", () => setOpen(false));
})();
