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
    const rows  = Math.max(board.columns[0].length, board.columns[1].length);
    const innerH = HEADER_TOP + (rows - 1) * PITCH + PAD_H + HEADER_BOT;

    // Width derived from column gap + outer label area (75px each side)
    const LABEL_GUTTER = 75;
    const boardW = COL_GAP + PAD_W * 2 + BOARD_PAD_X * 2;
    const totalW = LABEL_GUTTER * 2 + boardW;
    const cx     = totalW / 2;
    const boardL = cx - boardW / 2;
    const boardR = cx + boardW / 2;
    const boardT = 14;
    const boardB = innerH - 6;

    const assignedByGpio = {};
    for (const a of assigned) {
        const gpio = String(a.gpio ?? a.pin_number ?? a.pin ?? "").trim();
        if (gpio) assignedByGpio[gpio] = a;
    }

    const pinsSvg = [
        ...board.columns[0].map((p, i) => drawPin(p, "left",  boardL + BOARD_PAD_X, HEADER_TOP + i * PITCH, cx, assignedByGpio)),
        ...board.columns[1].map((p, i) => drawPin(p, "right", boardR - BOARD_PAD_X, HEADER_TOP + i * PITCH, cx, assignedByGpio)),
    ].join("");

    const artSvg = drawArt(board, boardL, boardT, boardR, boardB, cx, assignedByGpio);
    const usbSvg = drawUsb(cx, boardT, board.art.usb);

    return `
        <svg class="pinout-svg" viewBox="0 0 ${totalW} ${innerH}" preserveAspectRatio="xMidYMid meet">
            ${defs()}
            <!-- Board body -->
            <g filter="url(#pcbShadow)">
                <rect x="${boardL}" y="${boardT}" width="${boardR - boardL}" height="${boardB - boardT}"
                      rx="14" ry="14" fill="url(#pcbBody)"
                      stroke="rgba(0,0,0,0.55)" stroke-width="1"/>
                <!-- Highlight along top edge -->
                <rect x="${boardL + 2}" y="${boardT + 2}" width="${boardR - boardL - 4}" height="1.5"
                      fill="rgba(255,255,255,0.18)" rx="1"/>
                <!-- Subtle silkscreen dot grid -->
                ${dotGrid(boardL + 24, boardT + 24, boardR - boardL - 48, boardB - boardT - 48, 20)}
            </g>
            ${usbSvg}
            ${artSvg}
            ${pinsSvg}
        </svg>
    `;
}

function defs() {
    return `
        <defs>
            <linearGradient id="pcbBody" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stop-color="#1f6253"/>
                <stop offset="55%" stop-color="#0e4135"/>
                <stop offset="100%" stop-color="#072821"/>
            </linearGradient>
            <linearGradient id="padGold" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stop-color="#f9e0a3"/>
                <stop offset="40%" stop-color="#d4af6a"/>
                <stop offset="100%" stop-color="#8d6a32"/>
            </linearGradient>
            <linearGradient id="usbShell" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stop-color="#e2e2e6"/>
                <stop offset="50%" stop-color="#9aa0a6"/>
                <stop offset="100%" stop-color="#5b6066"/>
            </linearGradient>
            <linearGradient id="icBody" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stop-color="#252525"/>
                <stop offset="50%" stop-color="#161616"/>
                <stop offset="100%" stop-color="#0a0a0a"/>
            </linearGradient>
            <linearGradient id="wroomShield" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stop-color="#dadada"/>
                <stop offset="50%" stop-color="#a8a8a8"/>
                <stop offset="100%" stop-color="#7c7c7c"/>
            </linearGradient>
            <radialGradient id="ledOff" cx="0.5" cy="0.45" r="0.6">
                <stop offset="0%"  stop-color="#5a5b5e"/>
                <stop offset="100%" stop-color="#2a2b2e"/>
            </radialGradient>
            <radialGradient id="ledOn" cx="0.5" cy="0.45" r="0.7">
                <stop offset="0%"  stop-color="#9bd6ff"/>
                <stop offset="60%" stop-color="#2b7cb3"/>
                <stop offset="100%" stop-color="#0e3c5c"/>
            </radialGradient>
            <filter id="pcbShadow" x="-10%" y="-5%" width="120%" height="115%">
                <feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity="0.5"/>
            </filter>
            <filter id="glowAssigned" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="2.5" result="blur"/>
                <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
        </defs>
    `;
}

function dotGrid(x, y, w, h, spacing) {
    const dots = [];
    for (let i = x; i < x + w; i += spacing) {
        for (let j = y; j < y + h; j += spacing) {
            dots.push(`<circle cx="${i}" cy="${j}" r="0.6" fill="rgba(255,255,255,0.06)"/>`);
        }
    }
    return dots.join("");
}

function drawUsb(cx, boardT, label) {
    const w = 76, h = 22;
    const x = cx - w / 2;
    const y = boardT - h + 4;
    return `
        <!-- USB connector — metallic shell with darker port window -->
        <g>
            <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ry="3"
                  fill="url(#usbShell)" stroke="rgba(0,0,0,0.55)" stroke-width="0.75"/>
            <rect x="${x + 8}" y="${y + 4}" width="${w - 16}" height="${h - 8}" rx="1" ry="1"
                  fill="#1a1a1a"/>
            <rect x="${x + 14}" y="${y + 8}" width="${w - 28}" height="${h - 16}" rx="0.5"
                  fill="#ffffff" opacity="0.55"/>
            <text x="${cx}" y="${y - 6}" text-anchor="middle" class="pinout-usb-label">${escapeHtml(label)}</text>
        </g>
    `;
}

function drawArt(board, boardL, boardT, boardR, boardB, cx, assignedByGpio) {
    const cy = (boardT + boardB) / 2;
    if (board.chip === "rp2040") return drawPicoArt(board, boardL, boardT, boardR, boardB, cx, cy, assignedByGpio);
    if (board.chip === "esp32")  return drawEspArt(board, boardL, boardT, boardR, boardB, cx, cy, assignedByGpio);
    return "";
}

function drawPicoArt(board, boardL, boardT, boardR, boardB, cx, cy, assignedByGpio) {
    const chipSize = 70;
    const chipX = cx - chipSize / 2;
    const chipY = cy - chipSize / 2;
    const ledOn = !!assignedByGpio[board.art.ledGpio];
    return `
        <!-- RP2040 QFN -->
        <g>
            <rect x="${chipX}" y="${chipY}" width="${chipSize}" height="${chipSize}" rx="3" ry="3"
                  fill="url(#icBody)" stroke="rgba(255,255,255,0.16)" stroke-width="0.8"/>
            <!-- IC pin nubs around the edges -->
            ${icEdgePins(chipX, chipY, chipSize)}
            <!-- Label etched on chip top -->
            <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="pinout-ic-name">${escapeHtml(board.art.ic.label)}</text>
            <text x="${cx}" y="${cy + 10}" text-anchor="middle" class="pinout-ic-sub">QFN-56</text>
        </g>
        <!-- Silkscreen board name above chip -->
        <text x="${cx}" y="${chipY - 16}" text-anchor="middle" class="pinout-silk-title">${escapeHtml(board.art.ic.silk)}</text>
        <!-- BOOTSEL button — between chip and right header, near top -->
        <g class="pinout-button">
            <title>BOOTSEL — hold while plugging USB to enter bootloader</title>
            <rect x="${cx + 30}" y="${chipY - 30}" width="18" height="12" rx="2" ry="2"
                  fill="#efefef" stroke="rgba(0,0,0,0.5)" stroke-width="0.6"/>
            <rect x="${cx + 33}" y="${chipY - 27}" width="12" height="6" rx="1" ry="1"
                  fill="#d0d0d0"/>
            <text x="${cx + 39}" y="${chipY - 38}" text-anchor="middle" class="pinout-silk-tiny">BOOTSEL</text>
        </g>
        <!-- On-board LED at GP25 -->
        <g class="pinout-led ${ledOn ? "is-on" : ""}">
            <title>On-board LED (GP${board.art.ledGpio})</title>
            <rect x="${cx - 46}" y="${chipY - 12}" width="10" height="6" rx="1.5"
                  fill="${ledOn ? "url(#ledOn)" : "url(#ledOff)"}"
                  stroke="rgba(0,0,0,0.5)" stroke-width="0.5"
                  filter="${ledOn ? "url(#glowAssigned)" : ""}"/>
            <text x="${cx - 41}" y="${chipY - 16}" text-anchor="middle" class="pinout-silk-tiny">${escapeHtml(board.art.ledLabel)}</text>
        </g>
        <!-- Decorative capacitor near bottom -->
        <rect x="${cx - 30}" y="${boardB - 26}" width="14" height="8" rx="1" fill="#704030"
              stroke="rgba(0,0,0,0.4)" stroke-width="0.4"/>
        <rect x="${cx + 16}" y="${boardB - 26}" width="14" height="8" rx="1" fill="#704030"
              stroke="rgba(0,0,0,0.4)" stroke-width="0.4"/>
    `;
}

function drawEspArt(board, boardL, boardT, boardR, boardB, cx, cy, assignedByGpio) {
    const moduleW = 130;
    const moduleH = 170;
    const mx = cx - moduleW / 2;
    const my = cy - moduleH / 2 + 20;
    const ledOn = !!assignedByGpio[board.art.ledGpio];
    return `
        <!-- ESP-WROOM-32 RF shield (metallic) -->
        <g>
            <rect x="${mx}" y="${my}" width="${moduleW}" height="${moduleH}" rx="4" ry="4"
                  fill="url(#wroomShield)" stroke="rgba(0,0,0,0.55)" stroke-width="0.8"/>
            <!-- Antenna notch at top -->
            <rect x="${mx + 22}" y="${my - 14}" width="${moduleW - 44}" height="16"
                  fill="url(#wroomShield)" stroke="rgba(0,0,0,0.55)" stroke-width="0.8"/>
            <!-- Subtle inner highlight -->
            <rect x="${mx + 3}" y="${my + 3}" width="${moduleW - 6}" height="2" rx="1"
                  fill="rgba(255,255,255,0.25)"/>
            <text x="${cx}" y="${my + 28}" text-anchor="middle" class="pinout-ic-name">${escapeHtml(board.art.ic.label)}</text>
            <text x="${cx}" y="${my + moduleH - 14}" text-anchor="middle" class="pinout-silk-tiny">ESPRESSIF</text>
        </g>
        <!-- EN button on the board left of the module -->
        <g class="pinout-button">
            <title>EN — chip enable / reset</title>
            <rect x="${boardL + 8}" y="${my + 8}" width="18" height="12" rx="2" fill="#202020"
                  stroke="rgba(255,255,255,0.18)" stroke-width="0.5"/>
            <rect x="${boardL + 11}" y="${my + 11}" width="12" height="6" rx="1" fill="#3a3a3a"/>
            <text x="${boardL + 17}" y="${my + 4}" text-anchor="middle" class="pinout-silk-tiny">EN</text>
        </g>
        <!-- BOOT button to the right -->
        <g class="pinout-button">
            <title>BOOT — hold while resetting to enter bootloader</title>
            <rect x="${boardR - 26}" y="${my + 8}" width="18" height="12" rx="2" fill="#202020"
                  stroke="rgba(255,255,255,0.18)" stroke-width="0.5"/>
            <rect x="${boardR - 23}" y="${my + 11}" width="12" height="6" rx="1" fill="#3a3a3a"/>
            <text x="${boardR - 17}" y="${my + 4}" text-anchor="middle" class="pinout-silk-tiny">BOOT</text>
        </g>
        <!-- On-board user LED at GPIO 2 -->
        <g class="pinout-led ${ledOn ? "is-on" : ""}">
            <title>On-board LED (GPIO ${board.art.ledGpio})</title>
            <rect x="${cx + moduleW / 2 - 22}" y="${my + moduleH - 26}" width="10" height="6" rx="1.5"
                  fill="${ledOn ? "url(#ledOn)" : "url(#ledOff)"}"
                  stroke="rgba(0,0,0,0.5)" stroke-width="0.5"
                  filter="${ledOn ? "url(#glowAssigned)" : ""}"/>
            <text x="${cx + moduleW / 2 - 17}" y="${my + moduleH - 14}" text-anchor="middle" class="pinout-silk-tiny">${escapeHtml(board.art.ledLabel)}</text>
        </g>
    `;
}

// Tiny pin nubs on the four edges of a QFN-style chip
function icEdgePins(x, y, size) {
    const w = 1.5, h = 4, count = 10;
    const step = (size - 8) / (count - 1);
    const nubs = [];
    for (let i = 0; i < count; i++) {
        const off = 4 + i * step;
        // Top edge
        nubs.push(`<rect x="${x + off - w/2}" y="${y - h}" width="${w}" height="${h}" fill="#888"/>`);
        // Bottom edge
        nubs.push(`<rect x="${x + off - w/2}" y="${y + size}" width="${w}" height="${h}" fill="#888"/>`);
        // Left edge
        nubs.push(`<rect x="${x - h}" y="${y + off - w/2}" width="${h}" height="${w}" fill="#888"/>`);
        // Right edge
        nubs.push(`<rect x="${x + size}" y="${y + off - w/2}" width="${h}" height="${w}" fill="#888"/>`);
    }
    return nubs.join("");
}

function drawPin(p, side, edgeX, y, cx, assignedByGpio) {
    const gpio = String(p.gpio ?? "").trim();
    const assigned = gpio ? assignedByGpio[gpio] : null;
    const type = p.type || "io";
    // Pad is drawn straddling the board edge
    const padX = side === "left" ? edgeX - PAD_W / 2 : edgeX - PAD_W / 2;
    const padY = y - PAD_H / 2;
    const holeX = side === "left" ? edgeX : edgeX;
    // Pin label sits OUTSIDE the board
    const labelX = side === "left" ? edgeX - PAD_W / 2 - 4 : edgeX + PAD_W / 2 + 4;
    const labelAnchor = side === "left" ? "end" : "start";
    // Variable label sits FURTHER OUT than the pin label
    const varX = side === "left" ? labelX - 56 : labelX + 56;

    const cls = `pinout-pin pin-type-${type}${assigned ? " is-assigned" : ""}`;
    const varLabelSvg = assigned
        ? `<text x="${varX}" y="${y + 4}" class="pinout-var-label" text-anchor="${labelAnchor}">${escapeHtml(assigned.name)}</text>`
        : "";

    return `
        <g class="${cls}" data-gpio="${escapeHtml(gpio)}" data-name="${escapeHtml(assigned ? assigned.name : "")}">
            <title>${escapeHtml(pinTooltip(p))}</title>
            <!-- Gold pad with hole -->
            <rect x="${padX}" y="${padY}" width="${PAD_W}" height="${PAD_H}" rx="2.5" ry="2.5"
                  class="pinout-pad" fill="url(#padGold)"
                  stroke="rgba(0,0,0,0.4)" stroke-width="0.6"/>
            <circle cx="${holeX}" cy="${y}" r="2.3" fill="rgba(0,0,0,0.55)"/>
            <!-- Highlight ring (visible on hover / assigned) -->
            <circle cx="${holeX}" cy="${y}" r="${PAD_W / 2 + 2}" class="pinout-ring"/>
            <!-- Pin label -->
            <text x="${labelX}" y="${y + 4}" class="pinout-pin-label" text-anchor="${labelAnchor}">${escapeHtml(p.label)}</text>
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
