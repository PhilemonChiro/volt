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

export function setBuild(text) {
    const el = document.getElementById("statusLine");
    if (el) el.textContent = text === "Ready" ? "" : text;
}

export function setVersion(v) {
    const el = document.getElementById("statusVersion");
    if (el && v) el.textContent = `v${v}`;
}
