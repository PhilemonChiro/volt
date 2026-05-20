// Pinout panel — live board diagram in the side panel.
//
// Renders the chip's board SVG (background) and an overlay layer of
// interactive pin markers driven by JSON coordinate maps in
// volt-ide/assets/boards/. When the user declares pins in their hardware{}
// block (parsed by the compiler), those pins get highlighted with the
// declared variable name.
//
// Public API:
//   init(container)     — mount the empty scaffold
//   render(chip, assignedPins)  — paint the board for this chip;
//                                 highlight pins in assignedPins
//                                 = [{ name, pin, type }, ...]
//
// Click a pin → fires a custom event 'pinout:jump' on document with
// { detail: { name } } so the editor can scroll to its declaration.

let _root = null;
let _boards = null;   // cache of { chip → { svgText, pinMap } }
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

// Called by side-panel.update() whenever the compile result changes OR
// the user switches chips. Idempotent — safe to re-call with same args.
export async function render(chip, assignedPins) {
    if (!_root) return;
    _state.chip = chip;
    _state.assigned = assignedPins || [];

    const board = await loadBoard(chip);
    if (!board) {
        document.getElementById("pinoutStage").innerHTML =
            `<div class="pinout-empty">No board diagram yet for ${escapeHtml(chip)}.</div>`;
        document.getElementById("pinoutLegend").innerHTML = "";
        return;
    }

    paintBoard(board, _state.assigned);
}

// ============================================================
// Board loading
// ============================================================
const CHIP_TO_BOARD = {
    esp32:     { svg: "esp32-devkitc.svg",  json: "esp32-devkitc.json" },
    esp8266:   null,   // no asset yet — falls back to "no diagram"
    rp2040:    { svg: "pico.svg",           json: "pico.json" },
    stm32f103: null,
};

async function loadBoard(chip) {
    if (!_boards) _boards = {};
    if (_boards[chip]) return _boards[chip];

    const key = (chip || "").toLowerCase();
    const refs = CHIP_TO_BOARD[key];
    if (!refs) return null;

    try {
        const [svgText, pinMap] = await Promise.all([
            fetch(`assets/boards/${refs.svg}`).then(r => r.text()),
            fetch(`assets/boards/${refs.json}`).then(r => r.json()),
        ]);
        _boards[chip] = { svgText, pinMap };
        return _boards[chip];
    } catch (e) {
        console.warn("[pinout] failed to load board for", chip, e);
        return null;
    }
}

// ============================================================
// Rendering
// ============================================================
function paintBoard(board, assigned) {
    const stage = document.getElementById("pinoutStage");
    const legend = document.getElementById("pinoutLegend");
    if (!stage || !legend) return;

    // Inline the SVG so we can hit its elements with querySelector + CSS.
    // The Pico has no embedded pin markers (decorative SVG only) — for that
    // chip we render an HTML overlay layer of buttons positioned via the
    // JSON. The ESP32 SVG already has <circle class="pin-hit" id="pin-N"/>
    // injected at build time.
    stage.innerHTML = `<div class="pinout-svg-wrap">${board.svgText}</div>`;

    // Style any pre-existing inline title so it doesn't dominate the panel
    const inlineTitle = stage.querySelector("title");
    if (inlineTitle) inlineTitle.remove();

    // Make the SVG fluid — strip fixed width/height, use viewBox sizing
    const svg = stage.querySelector("svg");
    if (svg) {
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svg.style.maxWidth = "100%";
        svg.style.height = "auto";
        svg.style.display = "block";
    }

    // For boards with HTML overlay markers (Pico), inject the layer
    if (board.pinMap.pins.length && board.pinMap.pins[0].x != null) {
        renderHtmlOverlay(stage, board.pinMap, assigned);
    } else {
        // ESP32 path — apply highlight classes onto the embedded <circle> markers
        highlightEmbeddedPins(stage, board.pinMap, assigned);
    }

    renderLegend(legend, board.pinMap, assigned);
}

function renderHtmlOverlay(stage, pinMap, assigned) {
    // Build a lookup of gpio → assigned name (when the variable comes from a
    // GPIO-numbered pin). We use both the gpio string and the variable
    // name (e.g. `pin led = 2` → assigned to GP2).
    const assignedByGpio = {};
    for (const a of assigned || []) {
        const gpio = String(a.pin ?? a.pin_number ?? "");
        if (gpio) assignedByGpio[gpio] = a;
    }

    const wrap = stage.querySelector(".pinout-svg-wrap");
    const overlay = document.createElement("div");
    overlay.className = "pinout-overlay";

    const [, , vw, vh] = pinMap.viewBox.split(/\s+/).map(Number);

    for (const p of pinMap.pins) {
        const btn = document.createElement("button");
        const a = assignedByGpio[p.gpio || ""];
        btn.className = `pinout-pin pinout-pin-${p.type}` + (a ? " is-assigned" : "");
        btn.style.left = `${(p.x / vw) * 100}%`;
        btn.style.top  = `${(p.y / vh) * 100}%`;
        btn.setAttribute("data-pin", p.gpio || p.label);
        btn.innerHTML = `
            <span class="pinout-pin-dot"></span>
            ${a ? `<span class="pinout-pin-label">${escapeHtml(a.name)}</span>` : ""}
        `;
        btn.title = pinTooltip(p);
        btn.onclick = () => {
            if (a) {
                document.dispatchEvent(new CustomEvent("pinout:jump", { detail: { name: a.name } }));
            }
        };
        overlay.appendChild(btn);
    }
    wrap.appendChild(overlay);
}

function highlightEmbeddedPins(stage, pinMap, assigned) {
    // ESP32 path — the SVG has <circle id="pin-N" class="pin-hit"/> markers
    // pre-injected by build-boards.py. Toggle classes by GPIO match.
    const assignedByGpio = {};
    for (const a of assigned || []) {
        const gpio = String(a.pin ?? a.pin_number ?? "");
        if (gpio) assignedByGpio[gpio] = a;
    }
    for (const p of pinMap.pins) {
        const el = stage.querySelector(`#${p.id}`);
        if (!el) continue;
        const a = assignedByGpio[p.gpio || ""];
        el.classList.toggle("is-assigned", !!a);
        el.classList.add(`pin-type-${p.type}`);
        if (a) {
            el.setAttribute("data-assigned-name", a.name);
        } else {
            el.removeAttribute("data-assigned-name");
        }
        // Add a sibling text element with the variable name (so it appears
        // even on the embedded SVG without HTML overlay)
        const existingLabel = stage.querySelector(`text[data-for="${p.id}"]`);
        if (a) {
            if (!existingLabel) {
                const xmlns = "http://www.w3.org/2000/svg";
                const lbl = document.createElementNS(xmlns, "text");
                lbl.setAttribute("data-for", p.id);
                lbl.setAttribute("x", el.getAttribute("cx"));
                lbl.setAttribute("y", String(parseFloat(el.getAttribute("cy")) - 16));
                lbl.setAttribute("text-anchor", "middle");
                lbl.setAttribute("class", "pin-assigned-label");
                lbl.textContent = a.name;
                el.parentNode.appendChild(lbl);
            } else {
                existingLabel.textContent = a.name;
            }
            el.addEventListener("click", () => {
                document.dispatchEvent(new CustomEvent("pinout:jump", { detail: { name: a.name } }));
            }, { once: false });
        } else if (existingLabel) {
            existingLabel.remove();
        }
    }
}

function renderLegend(legend, pinMap, assigned) {
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
                    <span class="pinout-legend-pin">${escapeHtml(`GP${a.pin ?? a.pin_number ?? ""}`)}</span>
                    <span class="pinout-legend-type">${escapeHtml(a.type || "")}</span>
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
