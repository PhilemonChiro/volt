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
            <div class="pinout-popover" id="pinoutPopover" style="display:none"></div>
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

    // Dismiss popover on outside-click or Escape
    document.addEventListener("pointerdown", (e) => {
        const pop = document.getElementById("pinoutPopover");
        if (!pop || pop.style.display === "none") return;
        if (pop.contains(e.target)) return;
        if (e.target.closest(".pinout-pin")) return;   // re-click on another pin
        closePopover();
    }, true);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closePopover();
    });
}

// Lightweight regex extractor — pulls pin/bus/device declarations out of
// the editor source even when the full compiler can't parse it. Lets the
// pinout reflect what the user is typing in real time, not only on the
// debounced compile cycle.
//
// Scope is the hardware { … } block only (so a `pin` keyword inside a
// comment or string elsewhere can't fire).
//
// Matches:
//     pin <name> [: <Mode>] = <N>
//     bus <name>: <I2C|SPI|UART>(role: N, role: N, …)
//     device <name>: <Type> on <bus> at <addr>
//
// Returns:
//   {
//     pins:    [{ name, kind:"pin", gpio, mode, line }],
//     buses:   [{ name, kind:"bus", busType:"I2C"|"SPI"|"UART",
//                 roles: { sda:21, scl:22 }, line }],
//     devices: [{ name, type, bus, address, line }],
//     // flattened assignments by gpio (for board highlighting):
//     pinByGpio: { "21": {name,kind,role,...}, … }
//   }
export function extractHardware(source) {
    if (typeof source !== "string") return { pins: [], buses: [], devices: [], pinByGpio: {} };
    const m = source.match(/hardware\s*\{([\s\S]*?)\}/);
    if (!m) return { pins: [], buses: [], devices: [], pinByGpio: {} };
    const block = m[1];
    const blockStart = m.index + m[0].indexOf("{") + 1;

    const pins = [], buses = [], devices = [], pinByGpio = {};
    const lineOf = (offset) => source.slice(0, blockStart + offset).split("\n").length;

    // pin <name>[: Mode] = <N>
    const pinRe = /^\s*pin\s+([a-zA-Z_][a-zA-Z_0-9]*)(?:\s*:\s*([A-Za-z]+))?\s*=\s*(\d+)\s*$/gm;
    let mm;
    while ((mm = pinRe.exec(block)) !== null) {
        const pin = {
            name: mm[1],
            kind: "pin",
            mode: mm[2] || "Output",
            gpio: String(parseInt(mm[3], 10)),
            line: lineOf(mm.index),
        };
        pins.push(pin);
        if (!pinByGpio[pin.gpio]) pinByGpio[pin.gpio] = pin;
    }

    // bus <name>: TYPE(role: N, role: N, ...)
    const busRe = /^\s*bus\s+([a-zA-Z_][a-zA-Z_0-9]*)\s*:\s*(I2C|SPI|UART|i2c|spi|uart)\s*\(([^)]*)\)/gm;
    while ((mm = busRe.exec(block)) !== null) {
        const roles = {};
        const inner = mm[3] || "";
        for (const rolePair of inner.split(",")) {
            const r = rolePair.match(/^\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*:\s*(\d+)\s*$/);
            if (r) roles[r[1].toLowerCase()] = parseInt(r[2], 10);
        }
        const bus = {
            name: mm[1],
            kind: "bus",
            busType: mm[2].toUpperCase(),
            roles,
            line: lineOf(mm.index),
        };
        buses.push(bus);
        for (const [role, gpio] of Object.entries(roles)) {
            const gpioKey = String(gpio);
            // Don't overwrite a user's direct `pin foo = N` assignment with
            // a bus claim — if both exist, that's a conflict (user error).
            if (!pinByGpio[gpioKey]) {
                pinByGpio[gpioKey] = {
                    name: bus.name, kind: "bus", role,
                    busType: bus.busType, gpio: gpioKey, line: bus.line,
                };
            }
        }
    }

    // device <name>: <Type> on <bus> at <addr>
    const devRe = /^\s*device\s+([a-zA-Z_][a-zA-Z_0-9]*)\s*:\s*([A-Za-z_][A-Za-z_0-9]*)\s+on\s+([a-zA-Z_][a-zA-Z_0-9]*)\s+at\s+([^\s].*?)\s*$/gm;
    while ((mm = devRe.exec(block)) !== null) {
        devices.push({
            name: mm[1],
            type: mm[2],
            bus: mm[3],
            address: mm[4].trim(),
            line: lineOf(mm.index),
        });
    }

    return { pins, buses, devices, pinByGpio };
}

// Back-compat alias — old callers asking for just pins still work.
// Returns the flat by-GPIO assignment list (pins + bus roles together).
export function extractPinsFromSource(source) {
    const h = extractHardware(source);
    return Object.values(h.pinByGpio);
}

// Detect duplicate GPIO assignments → returns Set<string> of conflicting gpios
export function findConflicts(assignedPins) {
    const seen = {};
    const conflicts = new Set();
    for (const p of assignedPins) {
        const g = String(p.gpio ?? p.pin_number ?? p.pin ?? "").trim();
        if (!g) continue;
        if (seen[g]) conflicts.add(g);
        else seen[g] = p;
    }
    return conflicts;
}

// Highlight one pin (e.g. the one matching the editor's cursor line).
// Pass null to clear.
export function setHighlight(gpio) {
    const svg = document.querySelector("#pinoutSvgHost svg");
    if (!svg) return;
    svg.querySelectorAll(".pinout-pin.is-cursor").forEach(g => g.classList.remove("is-cursor"));
    if (gpio == null) return;
    const target = svg.querySelector(`.pinout-pin[data-gpio="${CSS.escape(String(gpio))}"]`);
    if (target) target.classList.add("is-cursor");
}

export async function render(chip, assignedPins, hardware) {
    if (!_root) return;
    _state.chip = (chip || "").toLowerCase();
    _state.assigned = assignedPins || [];
    _state.conflicts = findConflicts(_state.assigned);
    // Optional full hardware extract → enables the bus popover details
    _state.hardware = hardware || null;

    const board = await loadBoard(_state.chip);
    const host  = document.getElementById("pinoutSvgHost");
    if (!board) {
        host.innerHTML = `<div class="pinout-empty">No board diagram for ${escapeHtml(chip)} yet.</div>`;
        return;
    }
    host.innerHTML = drawBoard(board, _state.assigned);
    const svg = host.querySelector("svg");
    if (svg) {
        bindPinClicks(svg, board, _state.assigned);
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

    // Title above the board — single line, mono, restrained
    const titleY = boardT - 10;
    const totalH = innerH + 18;   // room for title above
    return `
        <svg class="pinout-svg" viewBox="0 0 ${totalW} ${totalH}" preserveAspectRatio="xMidYMid meet">
            <text x="${cx}" y="${titleY + 18}" text-anchor="middle" class="bp-board-label">${escapeHtml(board.name)}</text>
            <g transform="translate(0 22)">
                <rect x="${boardL}" y="${boardT}" width="${boardR - boardL}" height="${boardB - boardT}"
                      rx="10" ry="10" class="bp-board" fill="none"/>
                ${pinsSvg}
            </g>
        </svg>
    `;
}


function drawPin(p, side, edgeX, y, assignedByGpio) {
    const gpio = String(p.gpio ?? "").trim();
    const assigned = gpio ? assignedByGpio[gpio] : null;
    const conflict = gpio && _state.conflicts && _state.conflicts.has(gpio);
    const type = p.type || "io";
    const labelX = side === "left" ? edgeX - 10 : edgeX + 10;
    const labelAnchor = side === "left" ? "end" : "start";
    const varX = side === "left" ? labelX - 56 : labelX + 56;

    // Pin kind drives the visual: 'pin' = volt accent, 'bus' = bus accent
    const kindCls = assigned ? `is-${assigned.kind || "pin"}` : "";
    const cls = `pinout-pin pin-type-${type}${assigned ? " is-assigned" : ""}${conflict ? " is-conflict" : ""} ${kindCls}`;
    // Variable label text — for bus pins show just the role (sda / scl /
    // mosi …). The bus name lives in the popover. For regular pins show
    // the variable name as before.
    const labelText = assigned
        ? (assigned.kind === "bus" ? (assigned.role || "?") : assigned.name)
        : "";
    // For bus pins, also list device names attached to that bus on the
    // FIRST role-pin only (so the list doesn't repeat on every lane).
    let devicesText = "";
    if (assigned && assigned.kind === "bus" && _state.hardware && _state.hardware.devices) {
        const bus = (_state.hardware.buses || []).find(b => b.name === assigned.name);
        if (bus) {
            // Decide which role is the "primary" — first key in the roles object
            const firstRole = Object.keys(bus.roles || {})[0];
            if (firstRole === assigned.role) {
                const devs = _state.hardware.devices
                    .filter(d => d.bus === assigned.name)
                    .map(d => d.name);
                if (devs.length) devicesText = devs.join(" · ");
            }
        }
    }
    let varLabelSvg = "";
    if (assigned) {
        varLabelSvg += `<text x="${varX}" y="${y + 4}" class="bp-var-label" text-anchor="${labelAnchor}"
                 data-line="${assigned.line || 0}">${escapeHtml(labelText)}</text>`;
        if (devicesText) {
            varLabelSvg += `<text x="${varX}" y="${y + 16}" class="bp-dev-label" text-anchor="${labelAnchor}">${escapeHtml(devicesText)}</text>`;
        }
    }

    return `
        <g class="${cls}" data-gpio="${escapeHtml(gpio)}" data-name="${escapeHtml(assigned ? assigned.name : "")}"
           data-kind="${assigned ? assigned.kind : ""}"
           data-line="${assigned && assigned.line ? assigned.line : 0}">
            <title>${escapeHtml(pinTooltip(p))}</title>
            <circle cx="${edgeX}" cy="${y}" r="4" class="bp-pin-outer"/>
            <circle cx="${edgeX}" cy="${y}" r="8" class="bp-pin-ring"/>
            <text x="${labelX}" y="${y + 4}" class="bp-pin-label" text-anchor="${labelAnchor}">${escapeHtml(p.label)}</text>
            ${varLabelSvg}
        </g>
    `;
}

function bindPinClicks(svg, board, assignedPins) {
    const byGpio = {};
    for (const a of assignedPins) {
        const gpio = String(a.gpio ?? a.pin_number ?? a.pin ?? "").trim();
        if (gpio) byGpio[gpio] = a;
    }
    // Build pin lookup from chip defs (the JSON loaded for this board)
    const pinByGpio = {};
    const pinByLabel = {};
    for (const col of board.columns) {
        for (const p of col) {
            const g = String(p.gpio ?? "").trim();
            if (g) pinByGpio[g] = p;
            pinByLabel[p.label] = p;
        }
    }
    svg.querySelectorAll(".pinout-pin").forEach(g => {
        g.addEventListener("click", (e) => {
            e.stopPropagation();
            const gpio = g.getAttribute("data-gpio");
            const pin  = pinByGpio[gpio] || pinByLabel[g.querySelector("text.bp-pin-label")?.textContent?.trim() || ""];
            if (!pin) return;
            const assigned = gpio ? byGpio[gpio] : null;
            openPopover(g, pin, assigned);
        });
        // Hover → tell the editor to highlight the declaration line
        g.addEventListener("pointerenter", () => {
            const line = parseInt(g.getAttribute("data-line"), 10);
            if (line > 0) document.dispatchEvent(new CustomEvent("pinout:hover", { detail: { line } }));
        });
        g.addEventListener("pointerleave", () => {
            document.dispatchEvent(new CustomEvent("pinout:hover", { detail: { line: 0 } }));
        });
    });
}

// ============================================================
// Pin info popover — opens on click, shows everything we know
// about the pin from chip defs (label, GPIO, type, alt functions,
// notes) + assigned variable + "Jump to declaration" action.
// ============================================================
function openPopover(pinEl, pin, assigned) {
    const pop = document.getElementById("pinoutPopover");
    const canvas = document.getElementById("pinoutCanvas");
    if (!pop || !canvas) return;

    pop.innerHTML = renderPopoverHTML(pin, assigned);
    pop.style.display = "";

    // Position next to the pin element. Use the pin's screen rect
    // (which already includes the pan/zoom transform).
    const pinRect = pinEl.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;

    // Prefer the side opposite the board centre — if pin is on the left
    // half, popup goes right of it, and vice versa.
    const pinCenterX = pinRect.left + pinRect.width / 2 - canvasRect.left;
    const canvasMidX = canvasRect.width / 2;
    let x = (pinCenterX < canvasMidX)
        ? pinRect.right - canvasRect.left + 12
        : pinRect.left  - canvasRect.left - popW - 12;
    let y = pinRect.top - canvasRect.top + pinRect.height / 2 - popH / 2;

    // Clamp to canvas bounds
    x = Math.max(8, Math.min(x, canvasRect.width  - popW - 8));
    y = Math.max(8, Math.min(y, canvasRect.height - popH - 8));
    pop.style.left = x + "px";
    pop.style.top  = y + "px";

    // Wire the Jump-to-declaration button
    const jumpBtn = pop.querySelector("[data-action='jump']");
    if (jumpBtn && assigned) {
        jumpBtn.onclick = () => {
            document.dispatchEvent(new CustomEvent("pinout:jump", { detail: { name: assigned.name } }));
            closePopover();
        };
    }
    const closeBtn = pop.querySelector("[data-action='close']");
    if (closeBtn) closeBtn.onclick = closePopover;
}

function closePopover() {
    const pop = document.getElementById("pinoutPopover");
    if (pop) { pop.style.display = "none"; pop.innerHTML = ""; }
}

function renderPopoverHTML(pin, assigned) {
    const gpio = pin.gpio ? `GPIO ${pin.gpio}` : "";
    const alts = (pin.alt && pin.alt.length)
        ? `<div class="pp-section">
             <div class="pp-section-title">Alternate functions</div>
             <ul class="pp-alts">
                ${pin.alt.map(a => `<li>${escapeHtml(a)}</li>`).join("")}
             </ul>
           </div>`
        : "";
    const note = pin.note
        ? `<div class="pp-section">
             <div class="pp-section-title">Note</div>
             <div class="pp-note">${escapeHtml(pin.note)}</div>
           </div>`
        : "";
    let assignedBlock;
    if (assigned && assigned.kind === "bus") {
        // List devices that ride on this bus (from the hardware extract)
        const devices = (_state.hardware && _state.hardware.devices) || [];
        const onThisBus = devices.filter(d => d.bus === assigned.name);
        const devicesHtml = onThisBus.length
            ? `<ul class="pp-alts">
                 ${onThisBus.map(d => `<li>${escapeHtml(d.name)} <span style="color:var(--t3)">${escapeHtml(d.type)} @ ${escapeHtml(d.address)}</span></li>`).join("")}
               </ul>`
            : `<div class="pp-note" style="font-size:11px">No devices declared on this bus yet.</div>`;
        assignedBlock = `
            <div class="pp-assigned pp-bus">
                <span class="pp-assigned-label">Bus role · ${escapeHtml(assigned.busType || "")}</span>
                <span class="pp-assigned-name">${escapeHtml(assigned.name)} → ${escapeHtml(assigned.role || "")}</span>
                <button class="pp-btn pp-btn-primary" data-action="jump">Jump to bus declaration</button>
            </div>
            <div class="pp-section">
                <div class="pp-section-title">Devices on ${escapeHtml(assigned.name)}</div>
                ${devicesHtml}
            </div>
        `;
    } else if (assigned) {
        assignedBlock = `
            <div class="pp-assigned">
                <span class="pp-assigned-label">Assigned to</span>
                <span class="pp-assigned-name">${escapeHtml(assigned.name)}</span>
                ${assigned.mode ? `<span class="pp-assigned-mode">${escapeHtml(assigned.mode)}</span>` : ""}
                <button class="pp-btn pp-btn-primary" data-action="jump">Jump to declaration</button>
            </div>`;
    } else {
        assignedBlock = `<div class="pp-unassigned">Not assigned. Use <code>pin name = ${escapeHtml(pin.gpio || pin.label)}</code> in your hardware block.</div>`;
    }
    return `
        <div class="pp-head">
            <div class="pp-head-title">
                <span class="pp-pin-label">${escapeHtml(pin.label)}</span>
                ${gpio ? `<span class="pp-pin-gpio">${gpio}</span>` : ""}
            </div>
            <button class="pp-close" data-action="close" aria-label="Close">×</button>
        </div>
        <div class="pp-body">
            ${pin.type ? `<div class="pp-type pp-type-${escapeHtml(pin.type)}">${escapeHtml(pin.type)}</div>` : ""}
            ${alts}
            ${note}
            ${assignedBlock}
        </div>
    `;
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
    if (e.target.closest(".pinout-pin, .pinout-popover")) return;
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
