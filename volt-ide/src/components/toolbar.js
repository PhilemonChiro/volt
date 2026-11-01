// Toolbar — button handlers, device selector

const api = window.volt;

export function init({ onNew, onOpen, onClose, onRun, onMonitor, onCheck, onFormat, onSave, onExport, onSettings, onHelp }) {
    bind("runBtn", onRun);
    bind("exportBtn", onExport);
    bind("monitorBtn", onMonitor);
    bind("checkBtn", onCheck);
    bind("formatBtn", onFormat);
    bind("saveBtn", onSave);
    bind("newProjectBtn", onNew);
    bind("openProjectBtn", onOpen);
    bind("closeProjectBtn", onClose);
    bind("settingsBtn", onSettings);
    bind("helpBtn", onHelp);

    initMenus();

    // Window controls
    bind("winMinimize", () => api.minimize());
    bind("winMaximize", () => api.maximize());
    bind("winClose", () => api.close());
}

// Toolbar menus (File): open on hover or click; arrows move, Esc closes,
// picking an item closes it until the pointer leaves.
function initMenus() {
    for (const menu of document.querySelectorAll(".tb-menu")) {
        const trigger = menu.querySelector(".tb-menu-trigger");
        const items = () => [...menu.querySelectorAll(".tb-menu-item")].filter(i => i.style.display !== "none");
        const setOpen = (on) => { menu.classList.toggle("is-open", on); trigger.setAttribute("aria-expanded", on); };
        trigger.addEventListener("click", () => setOpen(!menu.classList.contains("is-open")));
        // Hover opens it; leaving closes it only after a grace period, so a
        // pointer that drifts past the edge on the way to an item keeps it.
        let leaveTimer = null;
        menu.addEventListener("mouseenter", () => {
            clearTimeout(leaveTimer);
            if (!menu.classList.contains("is-dismissed")) setOpen(true);
        });
        menu.addEventListener("mouseleave", () => {
            clearTimeout(leaveTimer);
            leaveTimer = setTimeout(() => { setOpen(false); menu.classList.remove("is-dismissed"); }, 350);
        });
        menu.addEventListener("click", (e) => {
            if (!e.target.closest(".tb-menu-item")) return;
            setOpen(false);
            menu.classList.add("is-dismissed");
        });
        menu.addEventListener("keydown", (e) => {
            const list = items();
            const i = list.indexOf(document.activeElement);
            if (e.key === "Escape") { setOpen(false); trigger.focus(); }
            else if (e.key === "ArrowDown" || (e.target === trigger && (e.key === "Enter" || e.key === " "))) {
                e.preventDefault(); setOpen(true); list[(i + 1) % list.length]?.focus();
            } else if (e.key === "ArrowUp") { e.preventDefault(); setOpen(true); list[(i - 1 + list.length) % list.length]?.focus(); }
        });
        document.addEventListener("click", (e) => { if (!menu.contains(e.target)) setOpen(false); });
    }
}

function bind(id, handler) {
    const el = document.getElementById(id);
    if (el && handler) el.addEventListener("click", handler);
}

// Update device selector display
export function setDevice(name, connected) {
    const label = document.getElementById("deviceLabel");
    const dot = document.getElementById("deviceDot");
    if (label) label.textContent = name || "No device";
    if (dot) dot.classList.toggle("connected", !!connected);
}

// Show/hide project-only buttons (Run, Monitor, Check, Format, Save, Close)
export function setProjectOpen(open) {
    document.querySelectorAll(".project-only").forEach(el => {
        el.style.display = open ? "" : "none";
    });
}

// Highlight save button when unsaved
export function setSaveUnsaved(unsaved) {
    const btn = document.getElementById("saveBtn");
    if (btn) btn.classList.toggle("unsaved", unsaved);
}
