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

// Global listeners bound once across the lifetime of the page so toggling
// the panel doesn't pile up duplicates.
let _globalListenersBound = false;
function ensureGlobalListeners() {
    if (_globalListenersBound) return;
    _globalListenersBound = true;
    document.addEventListener("pointerdown", (e) => {
        const pop = document.getElementById("pinoutPopover");
        if (!pop || pop.style.display === "none") return;
        if (pop.contains(e.target)) return;
        if (e.target.closest(".pinout-pin")) return;
        closePopover();
    }, true);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closePopover();
    });
}

export function init(container) {
    _root = container;
    // Re-init invalidates any cached DOM refs and the zoom binding.
    _skeleton = { chip: null, refs: null, board: null };
    _zoomListenersBound = false;
    _vp = null;

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

    ensureGlobalListeners();
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
// Find the byte range of the first `hardware { … }` block, brace-balanced
// so a nested `{` (e.g. an expression literal inside a value) doesn't cut
// the block short.
function findHardwareBlock(source) {
    const m = source.match(/hardware\s*\{/);
    if (!m) return null;
    const open = m.index + m[0].length;     // first char inside the block
    let depth = 1;
    for (let i = open; i < source.length; i++) {
        const c = source[i];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return { open, close: i, block: source.slice(open, i) };
        }
    }
    return null;
}

// Strip `// …` line comments outside of string literals so a commented-out
// pin / bus / device declaration never appears on the board.
function stripLineComments(s) {
    let out = "";
    let inStr = false, quote = "";
    for (let i = 0; i < s.length; i++) {
        const c = s[i], next = s[i + 1];
        if (inStr) {
            out += c;
            if (c === "\\" && next != null) { out += next; i++; continue; }
            if (c === quote) inStr = false;
            continue;
        }
        if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
        if (c === "/" && next === "/") {
            // skip until newline (preserve the newline so line numbers stay aligned)
            while (i < s.length && s[i] !== "\n") i++;
            i--;   // for-loop will i++ past it
            continue;
        }
        out += c;
    }
    return out;
}

export function extractHardware(source) {
    if (typeof source !== "string") return { pins: [], buses: [], devices: [], pinByGpio: {} };
    const hw = findHardwareBlock(source);
    if (!hw) return { pins: [], buses: [], devices: [], pinByGpio: {} };
    const block = stripLineComments(hw.block);
    const blockStart = hw.open;

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

    // Resolve 'orphan' devices — ones whose `on <name>` doesn't reference a
    // declared bus OR a declared pin. These are typically GPIO-attached
    // devices (DHT, HC-SR04, NEOPIXEL …) where the user hasn't yet declared
    // a pin for them. Anchor them to the GPIO in their `at <N>` clause so
    // the board shows the device at the right pin.
    const busNames = new Set(buses.map(b => b.name));
    const pinNames = new Set(pins.map(p => p.name));
    for (const d of devices) {
        if (busNames.has(d.bus) || pinNames.has(d.bus)) continue;
        // Address may be decimal (4), hex (0x4), or a trailing fragment;
        // parseInt(str) with no radix handles "0x" prefix automatically.
        const gpio = parseInt(d.address);
        if (isNaN(gpio)) continue;
        const key = String(gpio);
        if (!pinByGpio[key]) {
            pinByGpio[key] = {
                name: d.name,
                kind: "device",
                gpio: key,
                line: d.line,
                deviceType: d.type,
            };
        }
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

// Cache of the static SVG built per chip. Subsequent renders mutate
// classes / textContent only — no innerHTML rebuilds, no element
// recreation, no event re-attachment. This is what makes the realtime
// update smooth across keystrokes.
let _skeleton = { chip: null, refs: null, board: null };

export async function render(chip, assignedPins, hardware) {
    if (!_root) return;
    const newChip = (chip || "").toLowerCase();
    _state.chip = newChip;
    _state.assigned = assignedPins || [];
    _state.conflicts = findConflicts(_state.assigned);
    _state.hardware = hardware || null;

    // Same chip → mutate the existing DOM. Different chip → rebuild.
    if (_skeleton.chip === newChip && _skeleton.refs) {
        applyAssignments();
        return;
    }

    const board = await loadBoard(_state.chip);
    const host  = document.getElementById("pinoutSvgHost");
    if (!board) {
        host.innerHTML = `<div class="pinout-empty">No board diagram for ${escapeHtml(chip)} yet.</div>`;
        _skeleton = { chip: null, refs: null, board: null };
        return;
    }
    // Build the skeleton — board + every pin's full element set (outer
    // ring, hit ring, pin label, dormant var label, dormant dev label).
    // Pin coordinates are baked in; we never move elements after this.
    host.innerHTML = drawBoard(board, _state.assigned);
    const svg = host.querySelector("svg");
    if (!svg) return;
    bindPinClicks(svg, board, _state.assigned);
    attachZoomPan(svg);

    // Cache element refs by GPIO so subsequent renders mutate in place.
    _skeleton.chip  = _state.chip;
    _skeleton.board = board;
    _skeleton.refs  = {};
    svg.querySelectorAll(".pinout-pin").forEach(g => {
        const gpio = g.getAttribute("data-gpio");
        if (!gpio) return;
        _skeleton.refs[gpio] = {
            g,
            varLabel: g.querySelector(".bp-var-label"),
            devList:  g.querySelector(".bp-dev-list"),
            varX:     parseFloat(g.getAttribute("data-varx") || "0"),
            varY:     parseFloat(g.getAttribute("data-vary") || "0"),
            anchor:   g.getAttribute("data-anchor") || "start",
        };
    });

    applyAssignments();
}

// Surgically mutate the cached DOM to reflect _state.assigned.
// No element creation/removal — every pin's var-label and dev-label
// already exist in the skeleton with display:none; we toggle classes
// + update textContent + data-line attributes only.
function applyAssignments() {
    if (!_skeleton.refs) return;
    resetCardLayout();    // fresh occupancy ledger each frame
    // Invalidate per-pin card snapshots — column placement is a global
    // function of the whole frame's cards, so we can't trust last-frame's
    // cache if anything changed.
    for (const refs of Object.values(_skeleton.refs)) {
        if (refs.devList) refs.devList.removeAttribute("data-snap");
    }
    const assignedByGpio = {};
    for (const a of _state.assigned) {
        const gpio = String(a.gpio ?? a.pin_number ?? a.pin ?? "").trim();
        if (gpio) assignedByGpio[gpio] = a;
    }

    for (const [gpio, refs] of Object.entries(_skeleton.refs)) {
        const a = assignedByGpio[gpio];
        const conflict = _state.conflicts && _state.conflicts.has(gpio);
        const kind = a ? (a.kind || "pin") : null;

        // Toggle pin-state classes in one pass
        refs.g.classList.toggle("is-assigned", !!a);
        refs.g.classList.toggle("is-conflict", !!conflict);
        refs.g.classList.toggle("is-bus",    kind === "bus");
        refs.g.classList.toggle("is-pin",    kind === "pin");
        refs.g.classList.toggle("is-device", kind === "device");

        // data-* used by click-to-jump + hover events
        refs.g.setAttribute("data-name", a ? a.name : "");
        refs.g.setAttribute("data-kind", kind || "");
        refs.g.setAttribute("data-line", a && a.line ? a.line : 0);

        // Var label text — for bus pins show the role (sda/scl); for
        // device-anchored pins show the device name; for pin assignments
        // show the variable name.
        const labelText = a
            ? (kind === "bus" ? (a.role || "?") : a.name)
            : "";
        // Note: device kind uses a.name which is the device name (set in
        // extractHardware's orphan pass).
        if (refs.varLabel) {
            refs.varLabel.style.display = a ? "" : "none";
            if (refs.varLabel.textContent !== labelText) refs.varLabel.textContent = labelText;
            refs.varLabel.setAttribute("data-line", a && a.line ? a.line : 0);
        }

        // Device list — attach to the pin on the board.
        //   bus pins  → on the primary lane only, list everything that
        //               targets that bus.
        //   regular pin → list any device whose 'on <name>' references
        //               this pin's variable name.
        //   device-anchored pin → the device that anchored here (user
        //               hadn't declared a pin for it).
        let devices = [];
        if (a && _state.hardware && _state.hardware.devices) {
            if (kind === "bus") {
                const bus = (_state.hardware.buses || []).find(b => b.name === a.name);
                if (bus) {
                    const firstRole = Object.keys(bus.roles || {})[0];
                    if (firstRole === a.role) {
                        devices = _state.hardware.devices.filter(d => d.bus === a.name);
                    }
                }
            } else if (kind === "pin") {
                devices = _state.hardware.devices.filter(d => d.bus === a.name);
            } else if (kind === "device") {
                // Direct GPIO attachment — find the device(s) whose 'at'
                // numerically targets this GPIO and whose 'on <name>' isn't
                // a declared bus or pin.
                const busNames = new Set((_state.hardware.buses || []).map(b => b.name));
                const pinNames = new Set((_state.hardware.pins  || []).map(p => p.name));
                devices = _state.hardware.devices.filter(d => {
                    if (busNames.has(d.bus) || pinNames.has(d.bus)) return false;
                    return parseInt(d.address) === parseInt(a.gpio, 10);
                });
            }
        }
        if (refs.devList) updateDevList(refs, devices);
    }
}

// ============================================================
// Device cards — anti-collision layout
// ============================================================
//
// Cards live in dedicated columns OUTBOARD of the var-labels so they
// never share Y-space with other pins' annotations. For each side
// (left / right) we maintain an occupancy ledger keyed by column,
// each column tracking [top, bottom] intervals already taken. When
// updateDevList places cards for a pin, it finds (or opens) the
// nearest column with vertical room for the whole stack — pushing
// further outward only when the current column would overlap an
// existing claim.
//
// _cardLayout is reset on every applyAssignments() run so the ledger
// reflects only the CURRENT frame's cards.

const CARD_W       = 150;
const CARD_H       = 18;
const CARD_GAP     = 4;
const COL_GUTTER   = 18;       // gap between var-label X and the first card column
const COL_PITCH    = CARD_W + 12;  // distance to the next outboard column

let _cardLayout = null;
function resetCardLayout() {
    _cardLayout = { left: [], right: [] };
}

// Reserve a vertical run [top, bottom] in a column on `side`. Returns the
// chosen column's left-X. If the requested column collides, walks outward
// to the next free column.
function reserveColumn(side, top, bottom) {
    const list = _cardLayout[side];
    for (let i = 0; ; i++) {
        const col = list[i] || (list[i] = []);
        const collide = col.some(([t, b]) => !(bottom <= t || top >= b));
        if (!collide) {
            col.push([top, bottom]);
            return i;
        }
    }
}

function updateDevList(refs, devices) {
    const list = refs.devList;
    if (!list) return;
    if (!devices.length) {
        list.style.display = "none";
        while (list.firstChild) list.removeChild(list.firstChild);
        list.removeAttribute("data-snap");
        return;
    }
    list.style.display = "";

    // Per-frame snapshot — skip work if nothing changed AND no column
    // shift would have happened (we rebuild on changes anyway).
    const want = devices.map(d => `${d.name}|${d.type}|${d.address || ""}|${d.line || 0}`).join(";");
    if (list.getAttribute("data-snap") === want) return;
    list.setAttribute("data-snap", want);
    while (list.firstChild) list.removeChild(list.firstChild);

    const isLeft = refs.anchor === "end";
    const side = isLeft ? "left" : "right";
    const xmlns = "http://www.w3.org/2000/svg";

    // Total stack height — anchor the stack so its centre lines up with
    // the var-label's Y (the source pin's row). Cards above and below.
    const stackH = devices.length * CARD_H + (devices.length - 1) * CARD_GAP;
    const stackTop = refs.varY - stackH / 2 + CARD_H / 2;  // top of first card
    const stackBot = stackTop + stackH;

    // Pad the occupancy claim by 2px so cards from adjacent buses don't
    // touch edge-to-edge.
    const colIndex = reserveColumn(side, stackTop - 2, stackBot + 2);
    const colDist = COL_GUTTER + colIndex * COL_PITCH;
    const cardX = isLeft ? refs.varX - colDist - CARD_W : refs.varX + colDist;
    const axisX = isLeft ? cardX + CARD_W : cardX;   // inboard edge of the column

    // Horizontal trunk from var-label to the column's inboard edge,
    // then a vertical trunk down the column spanning the cards.
    const tHoriz = document.createElementNS(xmlns, "line");
    tHoriz.setAttribute("x1", refs.varX);
    tHoriz.setAttribute("y1", refs.varY);
    tHoriz.setAttribute("x2", axisX);
    tHoriz.setAttribute("y2", refs.varY);
    tHoriz.setAttribute("class", "bp-dev-trunk");
    list.appendChild(tHoriz);

    if (devices.length > 1) {
        const tVert = document.createElementNS(xmlns, "line");
        tVert.setAttribute("x1", axisX);
        tVert.setAttribute("y1", stackTop);
        tVert.setAttribute("x2", axisX);
        tVert.setAttribute("y2", stackBot - CARD_H / 2);   // run to last card centre
        tVert.setAttribute("class", "bp-dev-trunk");
        list.appendChild(tVert);
    }

    devices.forEach((d, i) => {
        const top = stackTop + i * (CARD_H + CARD_GAP) - CARD_H / 2;
        const cy = top + CARD_H / 2;
        const textX = isLeft ? cardX + CARD_W - 8 : cardX + 8;

        // Branch line from axis to card
        const branch = document.createElementNS(xmlns, "line");
        branch.setAttribute("x1", axisX);
        branch.setAttribute("y1", cy);
        branch.setAttribute("x2", isLeft ? cardX + CARD_W : cardX);
        branch.setAttribute("y2", cy);
        branch.setAttribute("class", "bp-dev-branch");
        list.appendChild(branch);

        const card = document.createElementNS(xmlns, "g");
        card.setAttribute("class", "bp-dev-card");
        card.setAttribute("data-line", String(d.line || 0));
        card.setAttribute("data-name", d.name);

        const rect = document.createElementNS(xmlns, "rect");
        rect.setAttribute("x", cardX);
        rect.setAttribute("y", top);
        rect.setAttribute("width", CARD_W);
        rect.setAttribute("height", CARD_H);
        rect.setAttribute("rx", CARD_H / 2);
        rect.setAttribute("ry", CARD_H / 2);
        rect.setAttribute("class", "bp-dev-card-bg");
        card.appendChild(rect);

        const t = document.createElementNS(xmlns, "text");
        t.setAttribute("x", textX);
        t.setAttribute("y", cy + 3);
        t.setAttribute("text-anchor", isLeft ? "end" : "start");
        t.setAttribute("class", "bp-dev-card-text");
        // Truncate display text so it fits roughly inside the pill.
        const make = (cls, txt, dx) => {
            const s = document.createElementNS(xmlns, "tspan");
            s.setAttribute("class", cls);
            if (dx != null) s.setAttribute("dx", String(dx));
            s.textContent = txt;
            return s;
        };
        t.appendChild(make("bp-dev-name", d.name));
        t.appendChild(make("bp-dev-sep", "·", 5));
        t.appendChild(make("bp-dev-type", d.type, 5));
        if (d.address) t.appendChild(make("bp-dev-addr", "@ " + d.address, 6));
        card.appendChild(t);
        list.appendChild(card);
    });
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
const PITCH    = 22;        // distance between pins vertically
const COL_GAP  = 130;       // gap between the two pin rows
// (PAD_W/PAD_H/BOARD_PAD_X/HEADER_TOP/HEADER_BOT removed — unused since
// the schematic rewrite.)

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
        ...board.columns[0].map((p, i) => drawPin(p, "left",  boardL, topPad + i * PITCH)),
        ...board.columns[1].map((p, i) => drawPin(p, "right", boardR, topPad + i * PITCH)),
    ].join("");

    // Title above the board — single line, mono, restrained
    const titleY = boardT - 10;
    const totalH = innerH + 18;   // room for title above
    return `
        <svg class="pinout-svg" viewBox="0 0 ${totalW} ${totalH}" preserveAspectRatio="xMidYMid meet"
             overflow="visible" style="overflow:visible">
            <text x="${cx}" y="${titleY + 18}" text-anchor="middle" class="bp-board-label">${escapeHtml(board.name)}</text>
            <g transform="translate(0 22)">
                <rect x="${boardL}" y="${boardT}" width="${boardR - boardL}" height="${boardB - boardT}"
                      rx="10" ry="10" class="bp-board" fill="none"/>
                ${pinsSvg}
            </g>
        </svg>
    `;
}


// Static skeleton emitter. Always renders ALL static elements plus a
// dormant <g> placeholder for the dynamic device list (filled per-pin
// in applyAssignments). Position metadata is stored as data-* so
// mutations don't need a position lookup.
function drawPin(p, side, edgeX, y) {
    const gpio = String(p.gpio ?? "").trim();
    const type = p.type || "io";
    const labelX = side === "left" ? edgeX - 10 : edgeX + 10;
    const labelAnchor = side === "left" ? "end" : "start";
    const varX = side === "left" ? labelX - 56 : labelX + 56;

    return `
        <g class="pinout-pin pin-type-${type}" data-gpio="${escapeHtml(gpio)}"
           data-name="" data-kind="" data-line="0"
           data-varx="${varX}" data-vary="${y + 4}" data-anchor="${labelAnchor}">
            <title>${escapeHtml(pinTooltip(p))}</title>
            <circle cx="${edgeX}" cy="${y}" r="4" class="bp-pin-outer"/>
            <circle cx="${edgeX}" cy="${y}" r="8" class="bp-pin-ring"/>
            <text x="${labelX}" y="${y + 4}" class="bp-pin-label" text-anchor="${labelAnchor}">${escapeHtml(p.label)}</text>
            <text x="${varX}" y="${y + 4}" class="bp-var-label"
                  text-anchor="${labelAnchor}" data-line="0" style="display:none"></text>
            <g class="bp-dev-list" style="display:none"></g>
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
            // Clicking a device row dispatches a jump to that device's line,
            // not the pin popover. Identify by .bp-dev-item ancestor.
            const devItem = e.target.closest(".bp-dev-item");
            if (devItem) {
                e.stopPropagation();
                const name = devItem.getAttribute("data-name");
                if (name) document.dispatchEvent(new CustomEvent("pinout:jump", { detail: { name } }));
                return;
            }
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
        // For regular pin assignments, also surface any GPIO-bound devices
        // ('device dht1: DHT11 on <thisPin> at 4') so the popover reads
        // 'led' or 'dht_pin → DHT11 attached' instead of just the pin.
        const devices = (_state.hardware && _state.hardware.devices) || [];
        const onThisPin = devices.filter(d => d.bus === assigned.name);
        const devicesHtml = onThisPin.length
            ? `<div class="pp-section">
                 <div class="pp-section-title">Devices attached</div>
                 <ul class="pp-alts">
                    ${onThisPin.map(d => `<li>${escapeHtml(d.name)} <span style="color:var(--t3)">${escapeHtml(d.type)} @ ${escapeHtml(d.address)}</span></li>`).join("")}
                 </ul>
               </div>`
            : "";
        assignedBlock = `
            <div class="pp-assigned">
                <span class="pp-assigned-label">Assigned to</span>
                <span class="pp-assigned-name">${escapeHtml(assigned.name)}</span>
                ${assigned.mode ? `<span class="pp-assigned-mode">${escapeHtml(assigned.mode)}</span>` : ""}
                <button class="pp-btn pp-btn-primary" data-action="jump">Jump to declaration</button>
            </div>
            ${devicesHtml}`;
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
// Pan + zoom (wheel anchored, drag to pan).
// Zoom/pan state persists across re-renders so an edit doesn't reset
// the user's view — they can stay zoomed into a region of the board
// while they type.
// ============================================================
let _zoomState = { scale: 1, tx: 0, ty: 0 };  // module-scoped, survives renders
let _zoomListenersBound = false;

function attachZoomPan(svg) {
    const container = document.getElementById("pinoutCanvas");
    const host = document.getElementById("pinoutSvgHost");
    // Reuse the persisted scale/pan rather than resetting on each render
    _vp = { svg, container, host, ..._zoomState };
    if (!_zoomListenersBound) {
        container.addEventListener("wheel", onWheel, { passive: false });
        container.addEventListener("pointerdown", onPointerDown);
        _zoomListenersBound = true;
    }
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
    // Persist so the next render (after an edit) picks the same view back up
    _zoomState.scale = _vp.scale;
    _zoomState.tx    = _vp.tx;
    _zoomState.ty    = _vp.ty;
}

function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
