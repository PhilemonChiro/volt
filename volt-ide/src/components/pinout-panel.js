// Pinout panel — schematic-drawn vertical board diagram.
//
// We render the board ourselves from the per-chip JSON pin tables. This
// trades photo-realism for perfect alignment: markers and labels share
// the same coordinate system because they're emitted in the same pass.
//
// Public API:
//   init(container)              — mount the empty scaffold
//   render(chip, assignedPins)   — paint the board for this chip;
//                                  highlight pins in assignedPins
//                                  = [{ name, gpio, mode }, ...]
//
// Click a pin → fires 'pinout:jump' on document with { detail: { name } }
// so the editor can scroll to its declaration.

let _root = null;
let _boards = null;                  // { chip → pin table }
let _state = { chip: null, assigned: [] };

export function init(container) {
    _root = container;
    container.innerHTML = `
        <div class="pinout-wrap">
            <div class="pinout-stage" id="pinoutStage"></div>
            <div class="pinout-legend" id="pinoutLegend"></div>
        </div>
    `;
}

export async function render(chip, assignedPins) {
    if (!_root) return;
    _state.chip = (chip || "").toLowerCase();
    _state.assigned = assignedPins || [];

    const board = await loadBoard(_state.chip);
    const stage = document.getElementById("pinoutStage");
    const legend = document.getElementById("pinoutLegend");

    if (!board) {
        stage.innerHTML = `<div class="pinout-empty">No board diagram for ${escapeHtml(chip)}.</div>`;
        legend.innerHTML = "";
        return;
    }
    stage.innerHTML = renderSchematic(board, _state.assigned);
    bindPinClicks(stage, _state.assigned);
    renderLegend(legend, board, _state.assigned);
}

// ============================================================
// Board data
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

// Normalize different per-chip JSON shapes into one layout we can render.
// Output: { name, columns: [[pinRow,...], [pinRow,...]] }
// Each pinRow: { label, gpio, type, alt, note, side: "left"|"right" }
function normalize(data) {
    const name = data.board || data.chip;
    if (data.chip === "rp2040") {
        // Pico — 40 pins, 1..20 left, 21..40 right (right column reads
        // bottom-to-top per the datasheet so pin 21 sits opposite pin 20).
        const sorted = [...data.pins].sort((a, b) => a.pin_num - b.pin_num);
        const left = sorted.filter(p => p.pin_num <= 20);
        const rightRaw = sorted.filter(p => p.pin_num > 20);
        // Right column is pin 40 (top) ... pin 21 (bottom) when board is
        // drawn vertically with USB at the top. Row i on right == pin (40-i).
        const right = [];
        for (let i = 0; i < 20; i++) {
            right.push(rightRaw[19 - i]);   // pin 40 first row, pin 21 last
        }
        return {
            name,
            chip: "rp2040",
            columns: [left, right],
            usb: "USB",
        };
    }
    // ESP32 DevKitC v4 — 38 pins, 19 down each side. Order from the
    // breakout silkscreen (provided JSON's tspan order roughly matches).
    // We re-derive a clean left/right by chunking the unique pins.
    const seen = new Set();
    const uniq = [];
    for (const p of data.pins) {
        const key = p.label;
        if (seen.has(key) && key !== "GND") continue;   // multiple GNDs are fine
        seen.add(key);
        uniq.push(p);
    }
    // Canonical DevKitC v4 layout (USB at top, looking at the silkscreen):
    const LEFT  = ["EN","VP","VN","34","35","32","33","25","26","27","14","12","13","GND","VIN","D2","D3","CMD","CLK"];
    const RIGHT = ["3V3","GND","15","2","4","16","17","5","18","19","21","RX","TX","22","23","D0","D1","GND","5V"];
    // Map JSON entries by label for lookups
    const byLabel = {};
    for (const p of data.pins) {
        // First occurrence per label wins
        if (!(p.label in byLabel)) byLabel[p.label] = p;
    }
    const buildCol = (labels) => labels.map(lbl => byLabel[lbl] || { label: lbl, type: "ground" });
    return {
        name,
        chip: "esp32",
        columns: [buildCol(LEFT), buildCol(RIGHT)],
        usb: "USB",
    };
}

// ============================================================
// Render — schematic SVG
// ============================================================
const PIN_PITCH = 26;       // vertical gap between pins
const COL_GAP   = 130;       // horizontal gap between the two pin columns
const PIN_R     = 5;
const MARGIN_TOP = 60;       // for USB connector
const MARGIN_BOT = 40;

function renderSchematic(board, assignedPins) {
    const rows = Math.max(board.columns[0].length, board.columns[1].length);
    const w = COL_GAP + 220;                    // labels extend outward both sides
    const h = MARGIN_TOP + rows * PIN_PITCH + MARGIN_BOT;
    const cx = w / 2;
    const boardLeft  = cx - COL_GAP / 2 - 30;
    const boardRight = cx + COL_GAP / 2 + 30;
    const boardTop   = MARGIN_TOP - 20;
    const boardBot   = h - MARGIN_BOT + 10;

    // Build a quick lookup of which GPIOs are assigned (and the variable name)
    const assignedByGpio = {};
    for (const a of assignedPins) {
        const gpio = String(a.gpio ?? a.pin_number ?? a.pin ?? "").trim();
        if (gpio) assignedByGpio[gpio] = a;
    }

    // Pin rows for each column
    const leftSvg  = board.columns[0].map((p, i) =>
        renderPin(p, "left",  boardLeft,  MARGIN_TOP + i * PIN_PITCH, assignedByGpio)).join("");
    const rightSvg = board.columns[1].map((p, i) =>
        renderPin(p, "right", boardRight, MARGIN_TOP + i * PIN_PITCH, assignedByGpio)).join("");

    return `
        <svg class="pinout-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet"
             style="width:100%;height:auto;display:block">
            <!-- Board body -->
            <rect x="${boardLeft}" y="${boardTop}"
                  width="${boardRight - boardLeft}" height="${boardBot - boardTop}"
                  rx="6" ry="6"
                  class="pinout-board-body"/>
            <!-- USB connector at top -->
            <rect x="${cx - 22}" y="${boardTop - 14}" width="44" height="14"
                  class="pinout-usb"/>
            <text x="${cx}" y="${boardTop - 2}" class="pinout-usb-label" text-anchor="middle">${escapeHtml(board.usb)}</text>
            <!-- Chip name centered -->
            <text x="${cx}" y="${(boardTop + boardBot) / 2}" class="pinout-chip-name" text-anchor="middle"
                  dominant-baseline="middle">${escapeHtml(board.name)}</text>
            ${leftSvg}
            ${rightSvg}
        </svg>
    `;
}

function renderPin(p, side, boardEdgeX, y, assignedByGpio) {
    const gpio = String(p.gpio ?? "").trim();
    const assigned = gpio ? assignedByGpio[gpio] : null;
    const type = p.type || "io";
    const padX = side === "left" ? boardEdgeX - 8 : boardEdgeX + 8;
    const labelX = side === "left" ? padX - 10 : padX + 10;
    const labelAnchor = side === "left" ? "end" : "start";
    const ptype = `pin-type-${type}`;
    const assignedCls = assigned ? "is-assigned" : "";
    const varLabel = assigned
        ? `<text x="${side === 'left' ? labelX - 60 : labelX + 60}" y="${y + 4}"
                  class="pinout-var-label" text-anchor="${labelAnchor}">${escapeHtml(assigned.name)}</text>`
        : "";

    return `
        <g class="pinout-pin ${ptype} ${assignedCls}"
           data-gpio="${escapeHtml(gpio)}"
           data-name="${escapeHtml(assigned ? assigned.name : "")}">
            <title>${escapeHtml(pinTooltip(p))}</title>
            <!-- Pad (drawn on the board edge) -->
            <rect x="${padX - 4}" y="${y - 4}" width="8" height="8" class="pinout-pad"/>
            <!-- Marker circle (highlights on assignment) -->
            <circle cx="${padX}" cy="${y}" r="${PIN_R}" class="pinout-dot"/>
            <!-- Pin label -->
            <text x="${labelX}" y="${y + 4}" class="pinout-pin-label"
                  text-anchor="${labelAnchor}">${escapeHtml(p.label)}</text>
            ${varLabel}
        </g>
    `;
}

function bindPinClicks(stage, assignedPins) {
    const byGpio = {};
    for (const a of assignedPins) {
        const gpio = String(a.gpio ?? a.pin_number ?? a.pin ?? "").trim();
        if (gpio) byGpio[gpio] = a;
    }
    stage.querySelectorAll(".pinout-pin").forEach(g => {
        g.onclick = () => {
            const gpio = g.getAttribute("data-gpio");
            const a = byGpio[gpio];
            if (a) document.dispatchEvent(new CustomEvent("pinout:jump", { detail: { name: a.name } }));
        };
    });
}

function renderLegend(legend, board, assigned) {
    if (!assigned || !assigned.length) {
        legend.innerHTML = `
            <div class="pinout-legend-empty">
                Declare pins in your <code>hardware { }</code> block to highlight them.
            </div>`;
        return;
    }
    legend.innerHTML = `
        <div class="pinout-legend-title">Assigned (${assigned.length})</div>
        <ul class="pinout-legend-list">
            ${assigned.map(a => `
                <li>
                    <span class="pinout-legend-name">${escapeHtml(a.name)}</span>
                    <span class="pinout-legend-pin">GP${escapeHtml(String(a.gpio ?? a.pin_number ?? a.pin ?? "?"))}</span>
                    <span class="pinout-legend-type">${escapeHtml(a.mode || a.type || "")}</span>
                </li>
            `).join("")}
        </ul>`;
}

function pinTooltip(p) {
    const parts = [];
    parts.push(p.label + (p.gpio && p.gpio !== p.label ? `  (GPIO ${p.gpio})` : ""));
    if (p.type) parts.push("Type: " + p.type);
    if (p.alt && p.alt.length) parts.push("Alt: " + p.alt.join(", "));
    if (p.note) parts.push(p.note);
    return parts.join("\n");
}

function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
