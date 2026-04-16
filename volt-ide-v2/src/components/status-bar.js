// Status bar — device status, cursor position, build info

export function setDevice(name, connected) {
    const el = document.getElementById("statusChip");
    if (el) el.innerHTML = `<span class="status-dot${connected ? ' connected' : ''}"></span> ${name || "No device"}`;
}

export function setLine(line, col) {
    const el = document.getElementById("statusLine");
    if (el) el.textContent = `Ln ${line}, Col ${col}`;
}

export function setBuild(text) {
    const el = document.getElementById("statusLine");
    if (el) el.textContent = text;
}
