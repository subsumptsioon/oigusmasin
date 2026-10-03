// ── nav.js ────────────────────────────────────────────────────────────────────
// Single source of truth for sidebar navigation.
// Writes the sidebar and wires the mobile toggle.
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
