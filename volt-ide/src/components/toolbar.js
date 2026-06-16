// Toolbar — button handlers, device selector

const api = window.volt;

export function init({ onNew, onOpen, onClose, onRun, onMonitor, onCheck, onFormat, onSave, onSettings, onHelp }) {
    bind("runBtn", onRun);
    bind("monitorBtn", onMonitor);
    bind("checkBtn", onCheck);
    bind("formatBtn", onFormat);
    bind("saveBtn", onSave);
    bind("newProjectBtn", onNew);
    bind("openProjectBtn", onOpen);
    bind("closeProjectBtn", onClose);
    bind("settingsBtn", onSettings);
    bind("helpBtn", onHelp);

    // Window controls
    bind("winMinimize", () => api.minimize());
    bind("winMaximize", () => api.maximize());
    bind("winClose", () => api.close());
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
