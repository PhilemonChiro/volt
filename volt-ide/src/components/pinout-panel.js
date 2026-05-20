// Pinout panel — your board SVG with baked pin markers + pan/zoom.
//
// The SVGs in assets/boards/ have been pre-processed (scripts/refine-
// board-svgs.py). Each pin label has a sibling
//   <circle id="pin-N" class="pin-marker" data-pin-label="…">
// at its exact rendered center. The ESP32 SVG is also rotated 90° INSIDE
// its own viewBox so it's intrinsically vertical (no CSS rotation —
// keeps coordinates honest for hit-testing).
//
// Public API:
//   init(container)
//   render(chip, assignedPins)   assignedPins = [{ name, gpio, mode }]
//
// Click an assigned marker → fires 'pinout:jump' on document.

let _root = null;
let _boards = null;
let _state = { chip: null, assigned: [] };
let _viewport = null;            // { svg, container, scale, tx, ty }

export function init(container) {
    _root = container;
    container.innerHTML = `
        <div class="pinout-canvas" id="pinoutCanvas">
            <div class="pinout-svg-host" id="pinoutSvgHost"></div>
        </div>
        <div class="pinout-controls">
            <button class="pinout-ctrl" id="pinoutZoomOut"  title="Zoom out (−)">−</button>
            <button class="pinout-ctrl" id="pinoutZoomReset" title="Reset zoom">⤢</button>
            <button class="pinout-ctrl" id="pinoutZoomIn"   title="Zoom in (+)">+</button>
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
    const host = document.getElementById("pinoutSvgHost");
    if (!board) {
        host.innerHTML = `<div class="pinout-empty">No board diagram for ${escapeHtml(chip)} yet.</div>`;
        return;
    }
    host.innerHTML = board.svgText;
    const svg = host.querySelector("svg");
    if (!svg) return;

    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.maxWidth = "100%";
    svg.style.height  = "auto";
    svg.style.display = "block";
    const t = svg.querySelector("title");
    if (t) t.remove();

    annotateAssignedPins(svg, board.pinMap, _state.assigned);
    attachZoomPan(svg);
}

// ============================================================
// Loading
// ============================================================
const CHIP_TO_BOARD = {
    esp32:     { svg: "esp32-devkitc.svg",  json: "esp32-devkitc.json" },
    esp8266:   null,
    rp2040:    { svg: "pico.svg",           json: "pico.json"          },
    stm32f103: null,
};

async function loadBoard(chip) {
    if (!_boards) _boards = {};
    if (_boards[chip]) return _boards[chip];
    const refs = CHIP_TO_BOARD[chip];
    if (!refs) return null;
    try {
        const [svgText, pinMap] = await Promise.all([
            fetch(`assets/boards/${refs.svg}`).then(r => r.text()),
            fetch(`assets/boards/${refs.json}`).then(r => r.json()),
        ]);
        _boards[chip] = { svgText, pinMap };
        return _boards[chip];
    } catch (e) {
        console.warn("[pinout] failed to load", chip, e);
        return null;
    }
}

// ============================================================
// Annotate — apply highlight class to baked markers
// ============================================================
function annotateAssignedPins(svg, pinMap, assignedPins) {
    // Clean any prior annotation overlays
    svg.querySelectorAll("[data-volt-overlay]").forEach(n => n.remove());
    svg.querySelectorAll(".pin-marker.is-assigned").forEach(n => n.classList.remove("is-assigned"));

    const assignedByGpio = {};
    for (const a of assignedPins) {
        const gpio = String(a.gpio ?? a.pin_number ?? a.pin ?? "").trim();
        if (gpio) assignedByGpio[gpio] = a;
    }

    // For each pin in the JSON, find its <circle.pin-marker> in the SVG.
    // The ESP32 markers are id="pin-<label>" (label = "2", "21", "GND"…);
    // the Pico markers are id="pin-<pin_num>" (pin_num = 1..40).
    const xmlns = "http://www.w3.org/2000/svg";
    for (const p of pinMap.pins) {
        const gpio = String(p.gpio || "").trim();
        const a = gpio ? assignedByGpio[gpio] : null;
        if (!a) continue;

        // Try label-keyed id first (ESP32), then pin_num (Pico)
        let marker = svg.querySelector(`#pin-${cssEscape(p.label)}`);
        if (!marker && p.pin_num != null) {
            marker = svg.querySelector(`#pin-${p.pin_num}`);
        }
        if (!marker) continue;
        marker.classList.add("is-assigned");

        // Append a visible ring + label as a sibling of the marker
        const cx = parseFloat(marker.getAttribute("cx"));
        const cy = parseFloat(marker.getAttribute("cy"));
        const r  = parseFloat(marker.getAttribute("r")) || 12;

        const grp = document.createElementNS(xmlns, "g");
        grp.setAttribute("data-volt-overlay", "1");
        grp.setAttribute("class", "pinout-overlay-grp");

        const ring = document.createElementNS(xmlns, "circle");
        ring.setAttribute("cx", cx);
        ring.setAttribute("cy", cy);
        ring.setAttribute("r", r + 2);
        ring.setAttribute("class", "pinout-overlay-ring");
        grp.appendChild(ring);

        // Variable name label — offset radially outward from board center.
        // We approximate "outward" by the X-distance to viewBox center; pins
        // on the left side get the label to the left, right side to the right.
        const [vx, vy, vw, vh] = svg.getAttribute("viewBox").split(/\s+/).map(Number);
        const cxBoard = vx + vw / 2;
        const labelLeft = cx < cxBoard;
        const lblX = cx + (labelLeft ? -(r + 8) : (r + 8));
        const lblY = cy + 4;
        const lbl = document.createElementNS(xmlns, "text");
        lbl.setAttribute("x", lblX);
        lbl.setAttribute("y", lblY);
        lbl.setAttribute("text-anchor", labelLeft ? "end" : "start");
        lbl.setAttribute("class", "pinout-overlay-name");
        lbl.textContent = a.name;
        grp.appendChild(lbl);

        marker.parentNode.appendChild(grp);

        marker.addEventListener("click", () => {
            document.dispatchEvent(new CustomEvent("pinout:jump", { detail: { name: a.name } }));
        });
    }
}

function cssEscape(s) {
    // CSS doesn't allow starting with a digit etc.; escape via CSS.escape
    if (window.CSS && window.CSS.escape) return CSS.escape(String(s));
    return String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}

// ============================================================
// Pan + zoom
// ============================================================
function attachZoomPan(svg) {
    const container = document.getElementById("pinoutCanvas");
    const host = document.getElementById("pinoutSvgHost");
    _viewport = { svg, container, host, scale: 1, tx: 0, ty: 0 };

    // Wheel zoom — anchor around cursor
    container.addEventListener("wheel", onWheel, { passive: false });
    // Drag to pan
    container.addEventListener("pointerdown", onPointerDown);
    apply();
}

function onWheel(e) {
    if (!_viewport) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : (1 / 1.12);
    zoomAt(e.clientX, e.clientY, factor);
}

let _drag = null;
function onPointerDown(e) {
    if (e.button !== 0) return;
    // Don't start a pan if we clicked on an interactive marker
    if (e.target.closest(".pin-marker.is-assigned, .pinout-overlay-grp")) return;
    _viewport.container.setPointerCapture(e.pointerId);
    _viewport.container.classList.add("is-panning");
    _drag = { x: e.clientX, y: e.clientY, startTx: _viewport.tx, startTy: _viewport.ty };
    _viewport.container.addEventListener("pointermove", onPointerMove);
    _viewport.container.addEventListener("pointerup",   onPointerUp);
    _viewport.container.addEventListener("pointercancel", onPointerUp);
}
function onPointerMove(e) {
    if (!_drag || !_viewport) return;
    _viewport.tx = _drag.startTx + (e.clientX - _drag.x);
    _viewport.ty = _drag.startTy + (e.clientY - _drag.y);
    apply();
}
function onPointerUp(e) {
    if (!_viewport) return;
    _viewport.container.classList.remove("is-panning");
    _viewport.container.removeEventListener("pointermove", onPointerMove);
    _viewport.container.removeEventListener("pointerup",   onPointerUp);
    _viewport.container.removeEventListener("pointercancel", onPointerUp);
    _drag = null;
}

function zoomAt(clientX, clientY, factor) {
    if (!_viewport) return;
    const rect = _viewport.container.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const newScale = Math.max(0.5, Math.min(8, _viewport.scale * factor));
    // Adjust translation so the cursor stays anchored to the same point
    _viewport.tx = mx - (mx - _viewport.tx) * (newScale / _viewport.scale);
    _viewport.ty = my - (my - _viewport.ty) * (newScale / _viewport.scale);
    _viewport.scale = newScale;
    apply();
}

function zoomBy(factor) {
    if (!_viewport) return;
    const rect = _viewport.container.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

function resetView() {
    if (!_viewport) return;
    _viewport.scale = 1; _viewport.tx = 0; _viewport.ty = 0;
    apply();
}

function apply() {
    if (!_viewport) return;
    _viewport.host.style.transform = `translate(${_viewport.tx}px, ${_viewport.ty}px) scale(${_viewport.scale})`;
}

function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
