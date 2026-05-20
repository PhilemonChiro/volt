// Pinout panel — interactive vector graphic generated from the JSON pin
// catalog. No external SVGs. The graphic is drawn freshly each render so
// every pixel is under our control and there's no possibility of marker
// drift.
//
// Layout: vertical PCB silhouette with USB at the top, two columns of
// gold THT pads down the long sides, a representation of the actual IC
// in the centre. The same pan/zoom canvas from v2.0.27 wraps it.
//
// Public API:
//   init(container)
//   render(chip, assignedPins)    assignedPins = [{ name, gpio, mode }]
//
// Click an assigned pin → fires 'pinout:jump' on document with
// { detail: { name } } so the editor can scroll to the declaration.

let _root = null;
let _boards = null;
let _state = { chip: null, assigned: [] };
let _vp = null;          // viewport: { svg, container, host, scale, tx, ty }

export function init(container) {
    _root = container;
    container.innerHTML = `
        <div class="pinout-canvas" id="pinoutCanvas">
            <div class="pinout-svg-host" id="pinoutSvgHost"></div>
        </div>
        <div class="pinout-controls">
            <button class="pinout-ctrl" id="pinoutZoomOut"  title="Zoom out">−</button>
            <button class="pinout-ctrl" id="pinoutZoomReset" title="Fit / reset">⤢</button>
            <button class="pinout-ctrl" id="pinoutZoomIn"   title="Zoom in">+</button>
        </div>
    `;
    document.getElementById("pinoutZoomIn").onclick    = () => zoomBy(1.25);
    document.getElementById("pinoutZoomOut").onclick   = () => zoomBy(0.8);
    document.getElementById("pinoutZoomReset").onclick = () => resetView();
}

export async function render(chip, assignedPins) {
    if (!_root) return;
    _state.chip = (chip || "").toLowerCase();
    _state.assigned = assignedPins || [];

    const board = await loadBoard(_state.chip);
    const host  = document.getElementById("pinoutSvgHost");
    if (!board) {
        host.innerHTML = `<div class="pinout-empty">No board diagram for ${escapeHtml(chip)} yet.</div>`;
        return;
    }
    host.innerHTML = drawBoard(board, _state.assigned);
    const svg = host.querySelector("svg");
    if (svg) {
        bindPinClicks(svg, _state.assigned);
        attachZoomPan(svg);
    }
}

// ============================================================
// Pin data loading + normalization
// ============================================================
const CHIP_TO_JSON = {
    esp32:     "esp32-devkitc.json",
    esp8266:   null,
    rp2040:    "pico.json",
    stm32f103: null,
};

async function loadBoard(chip) {
    if (!_boards) _boards = {};
    if (_boards[chip]) return _boards[chip];
    const file = CHIP_TO_JSON[chip];
    if (!file) return null;
    try {
        const data = await fetch(`assets/boards/${file}`).then(r => r.json());
        _boards[chip] = normalize(data);
        return _boards[chip];
    } catch (e) {
        console.warn("[pinout] failed to load", file, e);
        return null;
    }
}

// Project per-chip JSON into one layout: { name, chip, columns, art }
//   columns = [ [pinRow, …], [pinRow, …] ]   left + right header
//   art     = chip-specific visual hints (IC, buttons, LED, antenna)
function normalize(data) {
    if (data.chip === "rp2040") {
        const sorted = [...data.pins].sort((a, b) => a.pin_num - b.pin_num);
        const left  = sorted.filter(p => p.pin_num <= 20);
        const rightSrc = sorted.filter(p => p.pin_num > 20);
        const right = [];
        for (let i = 0; i < 20; i++) right.push(rightSrc[19 - i]);
        return {
            name: data.board || "Raspberry Pi Pico",
            chip: "rp2040",
            columns: [left, right],
            art: {
                ic:       { kind: "qfn", label: "RP2040", silk: "Raspberry Pi Pico" },
                buttons:  [ { label: "BOOTSEL", side: "top", x: 0.62, y: 0.42 } ],
                ledGpio:  "25",                  // on-board LED
                ledLabel: "LED",
                usb:      "USB",
            },
        };
    }
    // ESP32 DevKitC v4 — canonical column order from the Espressif datasheet,
    // looking at the component side with USB at the top.
    // https://docs.espressif.com/projects/esp-idf/en/latest/esp32/hw-reference/esp32/get-started-devkitc.html
    const LEFT  = ["3V3","EN","VP","VN","34","35","32","33","25","26","27","14","12","GND","13","D2","D3","CMD","5V"];
    const RIGHT = ["GND","23","22","TX","RX","21","GND","19","18","5","17","16","4","0","2","15","D1","D0","CLK"];
    const byLabel = {};
    for (const p of data.pins) if (!(p.label in byLabel)) byLabel[p.label] = p;
    const buildCol = (labels) => labels.map(lbl => byLabel[lbl] || { label: lbl, type: "ground", alt: [] });
    return {
        name: data.board || "ESP32 DevKitC v4",
        chip: "esp32",
        columns: [buildCol(LEFT), buildCol(RIGHT)],
        art: {
            ic:       { kind: "wroom", label: "ESP-WROOM-32", silk: "ESPRESSIF" },
            buttons:  [ { label: "EN", side: "left", x: -0.1, y: 0.85 },
                        { label: "BOOT", side: "right", x: 1.1, y: 0.85 } ],
            ledGpio:  "2",
            ledLabel: "LED",
            usb:      "MICRO USB",
        },
    };
}

// ============================================================
// Draw — build the schematic as inline SVG
// ============================================================
const PITCH       = 22;        // distance between pins vertically
const COL_GAP     = 130;        // gap between the two pin rows
const PAD_W       = 18;
const PAD_H       = 14;
const BOARD_PAD_X = 36;         // horizontal margin from pads to board edge
const HEADER_TOP  = 90;         // y-coord of first pin row (USB above)
const HEADER_BOT  = 28;         // bottom margin

function drawBoard(board, assigned) {
    const rows = Math.max(board.columns[0].length, board.columns[1].length);
    // Vertical sizing
    const topPad    = 26;
    const bottomPad = 26;
    const innerH    = topPad + (rows - 1) * PITCH + bottomPad;

    // Horizontal sizing
    const labelGutter = 84;     // room outside the board for pin labels
    const innerBoardW = COL_GAP + 24;
    const boardW = innerBoardW;
    const totalW = labelGutter * 2 + boardW;
    const cx     = totalW / 2;
    const boardL = cx - boardW / 2;
    const boardR = cx + boardW / 2;
    const boardT = 14;
    const boardB = innerH - 10;

    const assignedByGpio = {};
    for (const a of assigned) {
        const gpio = String(a.gpio ?? a.pin_number ?? a.pin ?? "").trim();
        if (gpio) assignedByGpio[gpio] = a;
    }

    const pinsSvg = [
        ...board.columns[0].map((p, i) => drawPin(p, "left",  boardL, topPad + i * PITCH, assignedByGpio)),
        ...board.columns[1].map((p, i) => drawPin(p, "right", boardR, topPad + i * PITCH, assignedByGpio)),
    ].join("");

    const cy = (boardT + boardB) / 2;
    return `
        <svg class="pinout-svg" viewBox="0 0 ${totalW} ${innerH}" preserveAspectRatio="xMidYMid meet">
            <rect x="${boardL}" y="${boardT}" width="${boardR - boardL}" height="${boardB - boardT}"
                  rx="10" ry="10" class="bp-board" fill="none"/>
            <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle"
                  class="bp-board-label">${escapeHtml(board.name)}</text>
            ${pinsSvg}
        </svg>
    `;
}


function drawPin(p, side, edgeX, y, assignedByGpio) {
    const gpio = String(p.gpio ?? "").trim();
    const assigned = gpio ? assignedByGpio[gpio] : null;
    const type = p.type || "io";
    // Pin marker sits ON the board edge; label outside; variable name
    // further outside.
    const labelX = side === "left" ? edgeX - 10 : edgeX + 10;
    const labelAnchor = side === "left" ? "end" : "start";
    const varX = side === "left" ? labelX - 56 : labelX + 56;

    const cls = `pinout-pin pin-type-${type}${assigned ? " is-assigned" : ""}`;
    const varLabelSvg = assigned
        ? `<text x="${varX}" y="${y + 4}" class="bp-var-label" text-anchor="${labelAnchor}">${escapeHtml(assigned.name)}</text>`
        : "";

    return `
        <g class="${cls}" data-gpio="${escapeHtml(gpio)}" data-name="${escapeHtml(assigned ? assigned.name : "")}">
            <title>${escapeHtml(pinTooltip(p))}</title>
            <circle cx="${edgeX}" cy="${y}" r="4" class="bp-pin-outer"/>
            <circle cx="${edgeX}" cy="${y}" r="8" class="bp-pin-ring"/>
            <text x="${labelX}" y="${y + 4}" class="bp-pin-label" text-anchor="${labelAnchor}">${escapeHtml(p.label)}</text>
            ${varLabelSvg}
        </g>
    `;
}

function bindPinClicks(svg, assignedPins) {
    const byGpio = {};
    for (const a of assignedPins) {
        const gpio = String(a.gpio ?? a.pin_number ?? a.pin ?? "").trim();
        if (gpio) byGpio[gpio] = a;
    }
    svg.querySelectorAll(".pinout-pin").forEach(g => {
        g.addEventListener("click", () => {
            const a = byGpio[g.getAttribute("data-gpio")];
            if (a) document.dispatchEvent(new CustomEvent("pinout:jump", { detail: { name: a.name } }));
        });
    });
}

function pinTooltip(p) {
    const parts = [];
    parts.push(p.label + (p.gpio && p.gpio !== p.label ? ` (GPIO ${p.gpio})` : ""));
    if (p.type) parts.push("Type: " + p.type);
    if (p.alt && p.alt.length) parts.push("Alt: " + p.alt.join(", "));
    if (p.note) parts.push(p.note);
    return parts.join("\n");
}

// ============================================================
// Pan + zoom (unchanged from v2.0.27 — wheel anchored, drag to pan)
// ============================================================
function attachZoomPan(svg) {
    const container = document.getElementById("pinoutCanvas");
    const host = document.getElementById("pinoutSvgHost");
    _vp = { svg, container, host, scale: 1, tx: 0, ty: 0 };
    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("pointerdown", onPointerDown);
    apply();
}
function onWheel(e) {
    if (!_vp) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}
let _drag = null;
function onPointerDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest(".pinout-pin.is-assigned, .pinout-led, .pinout-button")) return;
    _vp.container.setPointerCapture(e.pointerId);
    _vp.container.classList.add("is-panning");
    _drag = { x: e.clientX, y: e.clientY, startTx: _vp.tx, startTy: _vp.ty };
    _vp.container.addEventListener("pointermove", onPointerMove);
    _vp.container.addEventListener("pointerup",   onPointerUp);
    _vp.container.addEventListener("pointercancel", onPointerUp);
}
function onPointerMove(e) {
    if (!_drag || !_vp) return;
    _vp.tx = _drag.startTx + (e.clientX - _drag.x);
    _vp.ty = _drag.startTy + (e.clientY - _drag.y);
    apply();
}
function onPointerUp() {
    if (!_vp) return;
    _vp.container.classList.remove("is-panning");
    _vp.container.removeEventListener("pointermove", onPointerMove);
    _vp.container.removeEventListener("pointerup",   onPointerUp);
    _vp.container.removeEventListener("pointercancel", onPointerUp);
    _drag = null;
}
function zoomAt(clientX, clientY, factor) {
    if (!_vp) return;
    const rect = _vp.container.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    const newScale = Math.max(0.5, Math.min(8, _vp.scale * factor));
    _vp.tx = mx - (mx - _vp.tx) * (newScale / _vp.scale);
    _vp.ty = my - (my - _vp.ty) * (newScale / _vp.scale);
    _vp.scale = newScale;
    apply();
}
function zoomBy(factor) {
    if (!_vp) return;
    const r = _vp.container.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
}
function resetView() {
    if (!_vp) return;
    _vp.scale = 1; _vp.tx = 0; _vp.ty = 0;
    apply();
}
function apply() {
    if (!_vp) return;
    _vp.host.style.transform = `translate(${_vp.tx}px, ${_vp.ty}px) scale(${_vp.scale})`;
}

function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
