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
//   render(chip, assignedPins, hardware)    assignedPins = [{ name, gpio, mode }]
//   onPinClick(fn)    fn(gpio, boardPin, assigned, element) — the Hardware
//                     panel (hardware-panel.js) owns the popover + actions.

import * as chipSelector from "./chip-selector.js";

let _root = null;
let _boards = null;
let _state = { chip: null, assigned: [] };
let _vp = null;          // viewport: { svg, container, host, scale, tx, ty }

export function init(container) {
    _root = container;
    // Re-init invalidates any cached DOM refs and the zoom binding.
    _skeleton = { chip: null, refs: null, board: null };
    _zoomListenersBound = false;
    _vp = null;

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

let _onPinClick = () => {};
export function onPinClick(fn) { _onPinClick = fn; }

// Free-pin tint: { "23": "safe" | "caution" | "risky" | "unavailable" }.
let _safety = {};
export function setSafety(map) {
    _safety = map || {};
    if (_skeleton.refs) applyAssignments();
}

// Pick mode ("Move to another pin"): light these GPIOs, dim the rest.
export function setTargets(gpios) {
    const svg = document.querySelector("#pinoutSvgHost svg");
    const set = new Set((gpios || []).map(String));
    document.getElementById("pinoutCanvas")?.classList.toggle("is-picking", !!gpios);
    if (!svg) return;
    svg.querySelectorAll(".pinout-pin").forEach(g =>
        g.classList.toggle("is-target", set.has(g.getAttribute("data-gpio"))));
}

// The <g> drawn for a GPIO (popover anchor), or null.
export function pinElement(gpio) {
    return _skeleton.refs?.[String(gpio)]?.g || null;
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

    // device <name>: <Type>(role: N, …) — the device owns these GPIOs itself.
    const devArgRe = /^\s*device\s+([a-zA-Z_][a-zA-Z_0-9]*)\s*:\s*([A-Za-z_][A-Za-z_0-9]*)\s*\(([^)]*)\)\s*$/gm;
    while ((mm = devArgRe.exec(block)) !== null) {
        const dev = { name: mm[1], type: mm[2], bus: "", address: "", line: lineOf(mm.index), roles: {} };
        devices.push(dev);
        for (const pair of (mm[3] || "").split(",")) {
            const r = pair.match(/^\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*:\s*(\d+)\s*$/);
            if (!r) continue;
            const key = String(parseInt(r[2], 10));
            dev.roles[r[1].toLowerCase()] = parseInt(r[2], 10);
            if (!pinByGpio[key]) {
                pinByGpio[key] = { name: dev.name, kind: "device", role: r[1].toLowerCase(),
                    deviceType: dev.type, gpio: key, line: dev.line };
            }
        }
    }

    // Resolve 'orphan' devices — ones whose `on <name>` doesn't reference a
    // declared bus OR a declared pin. These are typically GPIO-attached
    // devices (DHT, HC-SR04, NEOPIXEL …) where the user hasn't yet declared
    // a pin for them. Anchor them to the GPIO in their `at <N>` clause so
    // the board shows the device at the right pin.
    const busNames = new Set(buses.map(b => b.name));
    const pinNames = new Set(pins.map(p => p.name));
    for (const d of devices) {
        if (d.roles || busNames.has(d.bus) || pinNames.has(d.bus)) continue;
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
// Highlight one GPIO, a list of them, or none (null / []).
export function setHighlight(gpios) {
    const svg = document.querySelector("#pinoutSvgHost svg");
    if (!svg) return;
    svg.querySelectorAll(".pinout-pin.is-cursor").forEach(g => g.classList.remove("is-cursor"));
    for (const gpio of [].concat(gpios ?? [])) {
        if (gpio == null || gpio === "") continue;
        const target = svg.querySelector(`.pinout-pin[data-gpio="${CSS.escape(String(gpio))}"]`);
        if (target) target.classList.add("is-cursor");
    }
}

// Where a GPIO sits on the current board drawing, with its silkscreen
// label, alternate functions and board note — or null.
export function boardPinInfo(gpio) {
    const board = _skeleton.board;
    if (!board) return null;
    const sides = board.columns.length === 2 ? ["left", "right"] : board.columns.map((_, i) => "column " + (i + 1));
    for (let c = 0; c < board.columns.length; c++) {
        const col = board.columns[c];
        for (let i = 0; i < col.length; i++) {
            const p = col[i];
            if (p && String(p.gpio ?? "") === String(gpio))
                return { board: board.name, header: sides[c], index: i + 1, label: p.label,
                    type: p.type || "", alt: p.alt || [], note: p.note || "" };
        }
    }
    return null;
}

// Compiler hardware messages for a GPIO (see setDiagnostics).
export function pinDiagnostics(gpio) {
    return _pinDiags[String(gpio)] || [];
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

    // Same chip + board → mutate the existing DOM. Otherwise rebuild.
    const boardId = boardIdFor(newChip);
    const key = newChip + ":" + boardId;
    if (_skeleton.chip === key && _skeleton.refs) {
        applyAssignments();
        return;
    }

    const board = await loadBoard(_state.chip, boardId);
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
    bindPinClicks(svg, board);
    attachZoomPan(svg);

    // Cache element refs by GPIO so subsequent renders mutate in place.
    _skeleton.chip  = key;
    _skeleton.board = board;
    _skeleton.refs  = {};
    svg.querySelectorAll(".pinout-pin").forEach(g => {
        const gpio = g.getAttribute("data-gpio");
        if (!gpio) return;
        _skeleton.refs[gpio] = {
            g,
            varLabel: g.querySelector(".bp-var-label"),
            warnMark: g.querySelector(".bp-warn-mark"),
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
        const role = roleOf(a);
        for (const r of ROLES) refs.g.classList.toggle("role-" + r, role === r);

        // data-* used by click-to-jump + hover events
        refs.g.setAttribute("data-name", a ? a.name : "");
        refs.g.setAttribute("data-kind", kind || "");
        refs.g.setAttribute("data-line", a && a.line ? a.line : 0);

        // Var label text — for bus pins show the role (sda/scl); for
        // device-anchored pins show the device name; for pin assignments
        // show the variable name.
        const labelText = a ? labelFor(a) : "";
        // Note: device kind uses a.name which is the device name (set in
        // extractHardware's orphan pass).
        if (refs.varLabel) {
            refs.varLabel.style.display = a ? "" : "none";
            if (refs.varLabel.textContent !== labelText) refs.varLabel.textContent = labelText;
            refs.varLabel.setAttribute("data-line", a && a.line ? a.line : 0);
        }

        const warn = a ? pinWarning(gpio) : "";
        if (refs.warnMark) {
            refs.warnMark.style.display = warn ? "" : "none";
            const t = refs.warnMark.querySelector("title");
            if (t && t.textContent !== warn) t.textContent = warn;
        }
        refs.g.classList.toggle("has-warning", !!warn);
        const safety = a ? "" : (_safety[gpio] || "");
        for (const s of ["safe", "caution", "risky", "unavailable"]) refs.g.classList.toggle("safe-" + s, safety === s);

        // Device cards on the graphic were too noisy; devices live in
        // the popover only now. Keep the dormant placeholder hidden.
        if (refs.devList) updateDevList(refs, []);
    }
}

// What a pin is used for → one colour each (legend in the corner).
const ROLES = ["out", "pwm", "in", "adc", "bus", "dev"];
export function roleOf(a) {
    if (!a) return null;
    if (a.kind === "bus") return "bus";
    if (a.kind === "device") return "dev";
    const m = (a.mode || "Output").toLowerCase();
    if (m === "pwm" || m === "servo") return "pwm";
    if (m.includes("analog") || m === "adc" || m === "dac") return "adc";
    if (m.includes("input") || m === "touch") return "in";
    return "out";
}

// "heater · PWM", "estop · pull-up", "i2c0 · SDA", "bin_level · trig"
export function labelFor(a) {
    if (a.kind === "bus") return `${a.name} · ${(a.role || "?").toUpperCase()}`;
    if (a.kind === "device") return a.role ? `${a.name} · ${a.role}` : a.name;
    const m = (a.mode || "Output").toLowerCase();
    const tag = m === "pwm" ? "PWM"
        : m === "servo" ? "servo"
        : m === "dac" ? "DAC"
        : m === "touch" ? "touch"
        : m.includes("analog") || m === "adc" ? "analog"
        : m.includes("pullup") ? "pull-up"
        : m.includes("pulldown") ? "pull-down"
        : m.includes("input") ? "input" : "output";
    return `${a.name} · ${tag}`;
}

// Wiring hazards worth a mark on the drawing (hover for the reason) — the
// compiler's hardware diagnostics, by GPIO. A diagnostic with a fix points
// at the offending pin number; otherwise it belongs to the pin on its line.
let _pinDiags = {}, _pinFixes = {};
export function setDiagnostics(diags, source) {
    const lines = (source || "").split("\n");
    const out = {}, fixes = {};
    for (const d of diags || []) {
        if (!d.code || d.code === "pin-note" || !/^(pin|bus)-/.test(d.code)) continue;
        let gpios = [];
        const f = d.fixes && d.fixes[0];
        if (f && f.line === f.end_line) {
            const n = (lines[f.line - 1] || "").slice(f.col - 1, f.end_col - 1).replace(/^GP/i, "");
            if (/^\d+$/.test(n)) gpios = [String(Number(n))];
        }
        if (!gpios.length)
            gpios = _state.assigned.filter(a => a.line === d.line && (a.kind || "pin") === "pin").map(a => String(a.gpio));
        for (const g of gpios) {
            (out[g] = out[g] || []).push(d.message);
            for (const fx of d.fixes || []) (fixes[g] = fixes[g] || []).push(fx);
        }
    }
    _pinDiags = out;
    _pinFixes = fixes;
    if (_skeleton.refs) applyAssignments();
}

// Compiler fixes for a GPIO's diagnostics ({title, line, col, end_line, end_col, text}).
export function pinFixes(gpio) {
    return _pinFixes[String(gpio)] || [];
}

function pinWarning(gpio) {
    return (_pinDiags[String(gpio ?? "")] || []).join("\n");
}

// Board choice: a chip can have several dev-board drawings; volt.toml's
// `board` picks one (the default is the first).
const BOARDS_BY_CHIP = {
    esp32: [
        { id: "esp32-devkitc-v4", label: "ESP32 DevKitC V4 (38-pin)" },
        { id: "esp32-devkit-v1",  label: "ESP32 DevKit V1 (30-pin)" },
    ],
};
export function boardsFor(chip) {
    return BOARDS_BY_CHIP[(chip || "").toLowerCase()] || [];
}
export function boardIdFor(chip) {
    const list = BOARDS_BY_CHIP[chip] || [];
    const want = chipSelector.getBoard();
    return (list.find(b => b.id === want) || list[0] || { id: "" }).id;
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

async function loadBoard(chip, boardId) {
    if (!_boards) _boards = {};
    const key = chip + ":" + boardId;
    if (_boards[key]) return _boards[key];
    const file = CHIP_TO_JSON[chip];
    if (!file) return null;
    try {
        const data = await fetch(`assets/boards/${file}`).then(r => r.json());
        _boards[key] = normalize(data, boardId);
        return _boards[key];
    } catch (e) {
        console.warn("[pinout] failed to load", file, e);
        return null;
    }
}

// Project per-chip JSON into one layout: { name, chip, columns, art }
//   columns = [ [pinRow, …], [pinRow, …] ]   left + right header
//   art     = chip-specific visual hints (IC, buttons, LED, antenna)
function normalize(data, boardId) {
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
    // DevKit V1 (DOIT, 30-pin) uses the same module, so the same pin facts,
    // in its own header order; it has VIN where the DevKitC has 5V.
    const v1 = boardId === "esp32-devkit-v1";
    const LEFT  = v1
        ? ["EN","VP","VN","34","35","32","33","25","26","27","14","12","13","GND","VIN"]
        : ["3V3","EN","VP","VN","34","35","32","33","25","26","27","14","12","GND","13","D2","D3","CMD","5V"];
    const RIGHT = v1
        ? ["23","22","TX","RX","21","19","18","5","17","16","4","2","15","GND","3V3"]
        : ["GND","23","22","TX","RX","21","GND","19","18","5","17","16","4","0","2","15","D1","D0","CLK"];
    const byLabel = {};
    for (const p of data.pins) if (!(p.label in byLabel)) byLabel[p.label] = p;
    const extra = { VIN: { label: "VIN", type: "power", alt: [], note: "5V input (from USB or external)" } };
    const buildCol = (labels) => labels.map(lbl => byLabel[lbl] || extra[lbl] || { label: lbl, type: "ground", alt: [] });
    return {
        name: v1 ? "ESP32 DevKit V1" : (data.board || "ESP32 DevKitC v4"),
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
    const labelGutter = 150;    // room outside the board for pin + "name · type" labels
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
    const warnX = side === "left" ? varX + 12 : varX - 12;
    // Named pins (VP, TX…) also show their GPIO number, which is what code uses.
    const shown = gpio && gpio !== p.label && type !== "reserved"
        ? (side === "left" ? `${p.label} ${gpio}` : `${gpio} ${p.label}`)
        : p.label;

    return `
        <g class="pinout-pin pin-type-${type}" data-gpio="${escapeHtml(gpio)}"
           data-name="" data-kind="" data-line="0"
           data-varx="${varX}" data-vary="${y + 4}" data-anchor="${labelAnchor}">
            <title>${escapeHtml(pinTooltip(p))}</title>
            <circle cx="${edgeX}" cy="${y}" r="4" class="bp-pin-outer"/>
            <circle cx="${edgeX}" cy="${y}" r="8" class="bp-pin-ring"/>
            <text x="${labelX}" y="${y + 4}" class="bp-pin-label" text-anchor="${labelAnchor}">${escapeHtml(shown)}</text>
            <text x="${warnX}" y="${y + 4}" class="bp-warn-mark" text-anchor="middle" style="display:none">⚠<title></title></text>
            <text x="${varX}" y="${y + 4}" class="bp-var-label"
                  text-anchor="${labelAnchor}" data-line="0" style="display:none"></text>
            <g class="bp-dev-list" style="display:none"></g>
        </g>
    `;
}

function bindPinClicks(svg, board) {
    const assignedAt = (gpio) => _state.assigned.find(a =>
        String(a.gpio ?? a.pin_number ?? a.pin ?? "").trim() === gpio) || null;
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
            const assigned = gpio ? assignedAt(gpio) : null;
            _onPinClick(gpio, pin, assigned, g);
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
    if (e.target.closest(".pinout-pin")) return;
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
