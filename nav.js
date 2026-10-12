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
    restore,
  );
}

(function () {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  const currentFile = window.location.pathname.split("/").pop() || "index.html";

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
