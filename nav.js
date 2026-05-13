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
  { sigil: "01", label: "Rehkendaja", href: "rehkendaja.html" },
  {
    sigil: "02",
    label: "Karistuste liitmine",
    href: "karistuste-liitmine.html",
  },
  { sigil: "03", label: "Narkonimekirjad I–VI", href: "index.html" },
  {
    sigil: "04",
    label: "Ennetähtaegne vabastamine",
    href: "ennetahtaegne-vabastamine.html",
  },
  // { sigil: "03", label: "Isikukood ja vanus", href: "isikukood.html" },
  // { sigil: "04", label: "Lausepank", href: "lausepank.html" },
];

const NAV_BRAND = "Tööriistad";
const NAV_AUTHOR = "© Andraš Tšitškan";

(function () {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  // Detect current page — match on filename only
  const currentFile = window.location.pathname.split("/").pop() || "index.html";

  // ── Build sidebar HTML ─────────────────────────────────────────────────────
  const items = NAV_ITEMS.map((item) => {
    const isActive = item.href === currentFile;
    return `<a class="nav-item${isActive ? " active" : ""}" href="${item.href}">
      <span class="nav-sigil">${item.sigil}</span>
      ${item.label}
    </a>`;
  }).join("\n    ");

  sidebar.innerHTML = `
    <a class="sidebar-brand" href="index.html">
      <div class="brand-mark"></div>
      <div class="brand-name">${NAV_BRAND}</div>
    </a>
    <div class="nav-section-label"></div>
    ${items}
    <div class="sidebar-foot">
      ${NAV_AUTHOR}&nbsp;<span class="nav-year"></span>
    </div>`;

  // Fill year
  const yr = new Date().getFullYear();
  sidebar.querySelectorAll(".nav-year").forEach((el) => (el.textContent = yr));

  // ── Mobile toggle ──────────────────────────────────────────────────────────
  const overlay = document.getElementById("sidebar-overlay");
  const togBtn = document.getElementById("sidebar-toggle");
  if (!overlay || !togBtn) return;

  function openSidebar() {
    sidebar.classList.add("open");
    overlay.classList.add("visible");
  }
  function closeSidebar() {
    sidebar.classList.remove("open");
    overlay.classList.remove("visible");
  }

  togBtn.addEventListener("click", () =>
    sidebar.classList.contains("open") ? closeSidebar() : openSidebar(),
  );
  overlay.addEventListener("click", closeSidebar);
})();
