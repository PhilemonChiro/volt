// Status bar — device status, cursor position, build info

export function setDevice(name, connected) {
    const el = document.getElementById("statusChip");
    if (!el) return;
    // Nothing to say without a board (the toolbar already shows "No device").
    el.hidden = !name;
    el.innerHTML = name ? `<span class="status-dot${connected ? ' connected' : ''}"></span> ${name}` : "";
}

export function setLine(line, col) {
    const el = document.getElementById("statusLine");
    if (el) el.textContent = `Ln ${line}, Col ${col}`;
}

// The tone colours the status bar so build state reads at a glance.
function toneOf(text) {
    if (/^no errors|ok$|^exported/i.test(text)) return "ok";
    if (/fail|error/i.test(text)) return "err";
    if (/warning/i.test(text)) return "warn";
    if (/(\.\.\.|…)$/.test(text)) return "busy";
    return "";
}

export function setBuild(text) {
    const el = document.getElementById("statusLine");
    if (!el) return;
    el.textContent = text === "Ready" ? "" : text;
    const bar = document.getElementById("statusBar");
    if (bar) bar.dataset.tone = toneOf(text);
}

export function setVersion(v) {
    const el = document.getElementById("statusVersion");
    if (el && v) el.textContent = `v${v}`;
}
