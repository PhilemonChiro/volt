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
    const headerH = HEADER_TOP + (rows - 1) * PITCH + PAD_H + 20;

    const LABEL_GUTTER = 86;
    const boardW = COL_GAP + PAD_W * 2 + BOARD_PAD_X * 2;
    const totalW = LABEL_GUTTER * 2 + boardW;
    const cx     = totalW / 2;
    const boardL = cx - boardW / 2;
    const boardR = cx + boardW / 2;
    const boardT = 26;
    const boardB = headerH;

    // Compose: header room (orientation marker), board area, title block
    const TITLE_BLOCK_H = 70;
    const innerH = boardB + 18 + TITLE_BLOCK_H + 14;

    const assignedByGpio = {};
    for (const a of assigned) {
        const gpio = String(a.gpio ?? a.pin_number ?? a.pin ?? "").trim();
        if (gpio) assignedByGpio[gpio] = a;
    }

    const pinsSvg = [
        ...board.columns[0].map((p, i) => drawPin(p, "left",  boardL + BOARD_PAD_X, HEADER_TOP + i * PITCH, cx, assignedByGpio, i + 1)),
        ...board.columns[1].map((p, i) => drawPin(p, "right", boardR - BOARD_PAD_X, HEADER_TOP + i * PITCH, cx, assignedByGpio, rightPhysical(board, i))),
    ].join("");

    const artSvg = drawArt(board, boardL, boardT, boardR, boardB, cx, assignedByGpio);
    const usbSvg = drawUsb(cx, boardT, board.art.usb);
    const orientationSvg = drawOrientation(cx, boardT);
    const legendSvg = drawLegend(boardR + 6, boardT - 4);
    const titleSvg = drawTitleBlock(board, boardL, boardB + 18, boardR - boardL, TITLE_BLOCK_H, assigned, assignedByGpio);

    return `
        <svg class="pinout-svg" viewBox="0 0 ${totalW} ${innerH}" preserveAspectRatio="xMidYMid meet">
            ${blueprintBackground(totalW, innerH)}
            <rect x="${boardL}" y="${boardT}" width="${boardR - boardL}" height="${boardB - boardT}"
                  rx="6" ry="6" class="bp-line" fill="none"/>
            ${cornerMarks(boardL, boardT, boardR, boardB)}
            ${dimensionLine(boardL, boardR, boardT - 16)}
            ${orientationSvg}
            ${usbSvg}
            ${artSvg}
            ${pinsSvg}
            ${legendSvg}
            ${titleSvg}
        </svg>
    `;
}

// Map right-column row-index → physical pin number on the board
function rightPhysical(board, rowIndex) {
    // Pico: row 0 of right column is pin 40, row 19 is pin 21
    if (board.chip === "rp2040") return 40 - rowIndex;
    // ESP32 DevKitC v4: row 0 right starts at the silkscreen position
    // (no canonical "pin number" beyond the label itself)
    return null;
}

// Horizontal dimension line above the board showing PCB width
function dimensionLine(L, R, y) {
    return `
        <g class="bp-dim">
            <line x1="${L}" y1="${y - 3}" x2="${L}" y2="${y + 3}" class="bp-line-thin"/>
            <line x1="${R}" y1="${y - 3}" x2="${R}" y2="${y + 3}" class="bp-line-thin"/>
            <line x1="${L}" y1="${y}"     x2="${R}" y2="${y}"     class="bp-line-thin"/>
            <text x="${(L + R) / 2}" y="${y - 5}" text-anchor="middle" class="bp-label-small">2.54mm pitch</text>
        </g>
    `;
}

// "USB ↑" orientation marker pointing into the USB connector
function drawOrientation(cx, boardT) {
    return `
        <g class="bp-orient">
            <text x="${cx - 70}" y="${boardT - 12}" text-anchor="end" class="bp-label-small">component side</text>
            <line x1="${cx - 64}" y1="${boardT - 16}" x2="${cx - 64}" y2="${boardT - 6}" class="bp-line-thin"/>
            <polyline points="${cx-67},${boardT-12} ${cx-64},${boardT-16} ${cx-61},${boardT-12}" class="bp-line-thin"/>
        </g>
    `;
}

// Pin-type colour key, top-right of the board
function drawLegend(x, y) {
    const items = [
        { label: "GPIO",     cls: "pin-type-io" },
        { label: "POWER",    cls: "pin-type-power" },
        { label: "GROUND",   cls: "pin-type-ground" },
        { label: "RESERVED", cls: "pin-type-reserved" },
    ];
    const rows = items.map((it, i) => `
        <g class="pinout-pin ${it.cls}" style="cursor:default">
            <circle cx="${x + 8}" cy="${y + i * 14 + 8}" r="3.5" class="bp-pin-outer"/>
            <circle cx="${x + 8}" cy="${y + i * 14 + 8}" r="1" class="bp-pin-inner"/>
            <text x="${x + 18}" y="${y + i * 14 + 11}" class="bp-label-small">${it.label}</text>
        </g>
    `).join("");
    return `
        <g class="bp-legend">
            <rect x="${x - 4}" y="${y - 2}" width="78" height="${items.length * 14 + 8}"
                  class="bp-title-block-bg"/>
            <rect x="${x - 4}" y="${y - 2}" width="78" height="${items.length * 14 + 8}"
                  class="bp-title-block-line"/>
            ${rows}
        </g>
    `;
}

// Engineering title block at the bottom — board, chip, pin counts, assigned
function drawTitleBlock(board, L, top, W, H, assigned, assignedByGpio) {
    const assignedCount = assigned.length;
    const totalIo = countBy(board, p => p.type === "io" || p.type === "input");
    const totalPins = board.columns[0].length + board.columns[1].length;
    const cellW = W / 3;
    const cellH = H / 2;
    return `
        <g class="bp-title-block">
            <rect x="${L}" y="${top}" width="${W}" height="${H}" class="bp-title-block-bg"/>
            <rect x="${L}" y="${top}" width="${W}" height="${H}" class="bp-title-block-line"/>
            <line x1="${L + cellW}"     y1="${top}" x2="${L + cellW}"     y2="${top + H}" class="bp-title-block-line"/>
            <line x1="${L + cellW * 2}" y1="${top}" x2="${L + cellW * 2}" y2="${top + H}" class="bp-title-block-line"/>
            <line x1="${L}" y1="${top + cellH}" x2="${L + W}" y2="${top + cellH}" class="bp-title-block-line"/>

            ${tbCell(L,             top,           cellW, cellH, "BOARD",    board.name)}
            ${tbCell(L + cellW,     top,           cellW, cellH, "MCU",      board.art.ic.label)}
            ${tbCell(L + cellW * 2, top,           cellW, cellH, "HEADER",   `${totalPins} pins · 2.54mm`)}
            ${tbCell(L,             top + cellH,   cellW, cellH, "TARGET",   "Volt IDE")}
            ${tbCell(L + cellW,     top + cellH,   cellW, cellH, "GPIO",     `${totalIo} available`)}
            ${tbCell(L + cellW * 2, top + cellH,   cellW, cellH, "ASSIGNED", `${assignedCount} / ${totalIo}`)}
        </g>
    `;
}

function tbCell(x, y, w, h, label, value) {
    return `
        <text x="${x + 6}" y="${y + 11}" class="bp-tb-label">${escapeHtml(label)}</text>
        <text x="${x + 6}" y="${y + h - 8}" class="bp-tb-value">${escapeHtml(value)}</text>
    `;
}

function countBy(board, pred) {
    let n = 0;
    for (const col of board.columns) for (const p of col) if (pred(p)) n++;
    return n;
}

// Soft drafting grid behind the board — major + minor lines, like a
// drafting blueprint sheet.
function blueprintBackground(w, h) {
    const minor = 10, major = 50;
    return `
        <rect x="0" y="0" width="${w}" height="${h}" class="bp-paper"/>
        <pattern id="bpGridMinor" width="${minor}" height="${minor}" patternUnits="userSpaceOnUse">
            <path d="M ${minor} 0 L 0 0 0 ${minor}" class="bp-grid-minor" fill="none"/>
        </pattern>
        <pattern id="bpGridMajor" width="${major}" height="${major}" patternUnits="userSpaceOnUse">
            <rect width="${major}" height="${major}" fill="url(#bpGridMinor)"/>
            <path d="M ${major} 0 L 0 0 0 ${major}" class="bp-grid-major" fill="none"/>
        </pattern>
        <rect x="0" y="0" width="${w}" height="${h}" fill="url(#bpGridMajor)"/>
    `;
}

// Small L-shaped marks at each board corner — common on engineering drawings
function cornerMarks(L, T, R, B) {
    const s = 6;
    return `
        <g class="bp-corner">
            <path d="M ${L - 8} ${T + s} L ${L - 8} ${T - 8} L ${L + s} ${T - 8}"/>
            <path d="M ${R - s} ${T - 8} L ${R + 8} ${T - 8} L ${R + 8} ${T + s}"/>
            <path d="M ${L + s} ${B + 8} L ${L - 8} ${B + 8} L ${L - 8} ${B - s}"/>
            <path d="M ${R + 8} ${B - s} L ${R + 8} ${B + 8} L ${R - s} ${B + 8}"/>
        </g>
    `;
}

function drawUsb(cx, boardT, label) {
    const w = 70, h = 20;
    const x = cx - w / 2;
    const y = boardT - h + 6;
    return `
        <g>
            <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" ry="2"
                  class="bp-line" fill="none"/>
            <!-- Port slot inside the shell -->
            <rect x="${x + 8}" y="${y + 4}" width="${w - 16}" height="${h - 8}" rx="1"
                  class="bp-line-thin" fill="none"/>
            <text x="${cx}" y="${y - 6}" text-anchor="middle" class="bp-label-small">${escapeHtml(label)}</text>
        </g>
    `;
}

function drawArt(board, boardL, boardT, boardR, boardB, cx, assignedByGpio) {
    const cy = (boardT + boardB) / 2;
    if (board.chip === "rp2040") return drawPicoArt(board, boardL, boardT, boardR, boardB, cx, cy, assignedByGpio);
    if (board.chip === "esp32")  return drawEspArt(board, boardL, boardT, boardR, boardB, cx, cy, assignedByGpio);
    return "";
}

// Blueprint art — line drawings only. No fills, no shadows, no realism.
function drawPicoArt(board, boardL, boardT, boardR, boardB, cx, cy, assignedByGpio) {
    const chipSize = 64;
    const chipX = cx - chipSize / 2;
    const chipY = cy - chipSize / 2;
    const ledOn = !!assignedByGpio[board.art.ledGpio];
    return `
        <!-- IC outline (RP2040) -->
        <rect x="${chipX}" y="${chipY}" width="${chipSize}" height="${chipSize}" rx="2" ry="2"
              class="bp-line" fill="none"/>
        ${icEdgeTicks(chipX, chipY, chipSize)}
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="bp-label-ic">${escapeHtml(board.art.ic.label)}</text>
        <text x="${cx}" y="${cy + 9}"  text-anchor="middle" class="bp-label-small">QFN-56</text>
        <text x="${cx}" y="${chipY - 14}" text-anchor="middle" class="bp-label-title">${escapeHtml(board.art.ic.silk)}</text>
        <!-- BOOTSEL button — outline -->
        <g class="pinout-button">
            <title>BOOTSEL — hold while plugging USB to enter bootloader</title>
            <rect x="${cx + 30}" y="${chipY - 26}" width="20" height="12" rx="1.5"
                  class="bp-line" fill="none"/>
            <text x="${cx + 40}" y="${chipY - 30}" text-anchor="middle" class="bp-label-small">BOOTSEL</text>
        </g>
        <!-- On-board LED — small circle, filled when assigned -->
        <g class="pinout-led ${ledOn ? "is-on" : ""}">
            <title>On-board LED (GP${board.art.ledGpio})</title>
            <circle cx="${cx - 40}" cy="${chipY - 18}" r="3.5" class="bp-led"/>
            <text x="${cx - 40}" y="${chipY - 24}" text-anchor="middle" class="bp-label-small">${escapeHtml(board.art.ledLabel)}</text>
        </g>
    `;
}

function drawEspArt(board, boardL, boardT, boardR, boardB, cx, cy, assignedByGpio) {
    const moduleW = 130;
    const moduleH = 170;
    const mx = cx - moduleW / 2;
    const my = cy - moduleH / 2 + 18;
    const ledOn = !!assignedByGpio[board.art.ledGpio];
    return `
        <!-- ESP-WROOM-32 outline -->
        <rect x="${mx}" y="${my}" width="${moduleW}" height="${moduleH}" rx="3"
              class="bp-line" fill="none"/>
        <!-- Antenna notch -->
        <rect x="${mx + 22}" y="${my - 14}" width="${moduleW - 44}" height="14"
              class="bp-line" fill="none"/>
        <text x="${cx}" y="${my + 26}"           text-anchor="middle" class="bp-label-ic">${escapeHtml(board.art.ic.label)}</text>
        <text x="${cx}" y="${my + moduleH - 16}" text-anchor="middle" class="bp-label-small">ESPRESSIF</text>
        <!-- EN button outline -->
        <g class="pinout-button">
            <title>EN — chip enable / reset</title>
            <rect x="${boardL + 10}" y="${my + 8}" width="20" height="12" rx="1.5"
                  class="bp-line" fill="none"/>
            <text x="${boardL + 20}" y="${my + 4}" text-anchor="middle" class="bp-label-small">EN</text>
        </g>
        <!-- BOOT button outline -->
        <g class="pinout-button">
            <title>BOOT — hold while resetting to enter bootloader</title>
            <rect x="${boardR - 30}" y="${my + 8}" width="20" height="12" rx="1.5"
                  class="bp-line" fill="none"/>
            <text x="${boardR - 20}" y="${my + 4}" text-anchor="middle" class="bp-label-small">BOOT</text>
        </g>
        <!-- On-board LED -->
        <g class="pinout-led ${ledOn ? "is-on" : ""}">
            <title>On-board LED (GPIO ${board.art.ledGpio})</title>
            <circle cx="${cx + moduleW / 2 - 18}" cy="${my + moduleH - 24}" r="3.5" class="bp-led"/>
            <text x="${cx + moduleW / 2 - 18}" y="${my + moduleH - 30}" text-anchor="middle" class="bp-label-small">${escapeHtml(board.art.ledLabel)}</text>
        </g>
    `;
}

// Tiny perimeter tick marks indicating IC pins
function icEdgeTicks(x, y, size) {
    const count = 8;
    const step = (size - 6) / (count - 1);
    const t = 3;
    const ticks = [];
    for (let i = 0; i < count; i++) {
        const off = 3 + i * step;
        ticks.push(`<line x1="${x + off}" y1="${y}" x2="${x + off}" y2="${y - t}" class="bp-line-thin"/>`);
        ticks.push(`<line x1="${x + off}" y1="${y + size}" x2="${x + off}" y2="${y + size + t}" class="bp-line-thin"/>`);
        ticks.push(`<line x1="${x}" y1="${y + off}" x2="${x - t}" y2="${y + off}" class="bp-line-thin"/>`);
        ticks.push(`<line x1="${x + size}" y1="${y + off}" x2="${x + size + t}" y2="${y + off}" class="bp-line-thin"/>`);
    }
    return ticks.join("");
}

function drawPin(p, side, edgeX, y, cx, assignedByGpio, physicalNum) {
    const gpio = String(p.gpio ?? "").trim();
    const assigned = gpio ? assignedByGpio[gpio] : null;
    const type = p.type || "io";
    const labelX = side === "left" ? edgeX - PAD_W / 2 - 4 : edgeX + PAD_W / 2 + 4;
    const labelAnchor = side === "left" ? "end" : "start";
    const varX = side === "left" ? labelX - 56 : labelX + 56;
    // Physical pin number — small drafting marker INSIDE the board, between
    // the pin pad and the IC. Tells the user "this is pin 14 of the header".
    const phyX = side === "left" ? edgeX + 12 : edgeX - 12;
    const phyAnchor = side === "left" ? "start" : "end";

    const isStrapping = /strapping/i.test(p.note || "");
    const cls = `pinout-pin pin-type-${type}${assigned ? " is-assigned" : ""}${isStrapping ? " is-strapping" : ""}`;
    const varLabelSvg = assigned
        ? `<text x="${varX}" y="${y + 4}" class="bp-var-label" text-anchor="${labelAnchor}">${escapeHtml(assigned.name)}</text>`
        : "";
    const strapMarker = isStrapping
        ? `<polygon points="${edgeX-2},${y-9} ${edgeX+2},${y-9} ${edgeX},${y-13}" class="bp-strap-mark"/>`
        : "";
    const phyLabel = physicalNum != null
        ? `<text x="${phyX}" y="${y + 3}" class="bp-phy-num" text-anchor="${phyAnchor}">${physicalNum}</text>`
        : "";

    return `
        <g class="${cls}" data-gpio="${escapeHtml(gpio)}" data-name="${escapeHtml(assigned ? assigned.name : "")}">
            <title>${escapeHtml(pinTooltip(p))}</title>
            <!-- Pin marker — drafting circle -->
            <circle cx="${edgeX}" cy="${y}" r="5"   class="bp-pin-outer"/>
            <circle cx="${edgeX}" cy="${y}" r="1.6" class="bp-pin-inner"/>
            <circle cx="${edgeX}" cy="${y}" r="9"   class="bp-pin-ring"/>
            ${strapMarker}
            ${phyLabel}
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
