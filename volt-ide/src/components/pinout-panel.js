// Pinout panel — your board SVG, interactive.
//
// ESP32: the supplied SVG already contains <text> elements per pin label
//   ("2", "21", "GND", "VP", …). At runtime we find them by text content,
//   call getBBox() to learn their actual rendered position (accounting
//   for any parent transforms — fixes the "markers don't line up" bug
//   from v2.0.24), and tag them with classes when assigned. A small <g>
//   sibling with a coloured ring + variable name is appended at the
//   same position.
//
// Pico: the supplied SVG is purely decorative (paths only, no labels).
//   We overlay HTML buttons positioned via the JSON's x/y coordinates.
//
// Vertical orientation: the ESP32 DevKitC SVG is wide-landscape, so we
//   rotate it 90° in CSS to fit the side panel column.

let _root = null;
let _boards = null;
let _state = { chip: null, assigned: [] };

export function init(container) {
    _root = container;
    container.innerHTML = `<div class="pinout-board" id="pinoutBoard"></div>`;
}

export async function render(chip, assignedPins) {
    if (!_root) return;
    _state.chip = (chip || "").toLowerCase();
    _state.assigned = assignedPins || [];

    const board = await loadBoard(_state.chip);
    const stage = document.getElementById("pinoutBoard");
    if (!board) {
        stage.innerHTML = `<div class="pinout-empty">No board diagram for ${escapeHtml(chip)} yet.</div>`;
        return;
    }
    stage.innerHTML = board.svgText;
    const svg = stage.querySelector("svg");
    if (!svg) return;

    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.maxWidth = "100%";
    svg.style.height = "auto";
    svg.style.display = "block";
    const t = svg.querySelector("title");
    if (t) t.remove();
    stage.classList.toggle("is-rotated", board.pinMap.orientation === "rotate90");

    if (board.pinMap.chip === "esp32") {
        annotateEspBySvgText(svg, board.pinMap, _state.assigned);
    } else {
        renderHtmlOverlay(stage, svg, board.pinMap, _state.assigned);
    }
}

// ============================================================
// Loading
// ============================================================
const CHIP_TO_BOARD = {
    esp32:     { svg: "esp32-devkitc.svg",  json: "esp32-devkitc.json",  orientation: "rotate90" },
    esp8266:   null,
    rp2040:    { svg: "pico.svg",           json: "pico.json",           orientation: "auto" },
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
        pinMap.orientation = refs.orientation;
        _boards[chip] = { svgText, pinMap };
        return _boards[chip];
    } catch (e) {
        console.warn("[pinout] failed to load", chip, e);
        return null;
    }
}

// ============================================================
// ESP32 — runtime SVG annotation via getBBox()
// ============================================================
function annotateEspBySvgText(svg, pinMap, assignedPins) {
    // Map: pin-label-string → assigned-variable-info
    const assignedByGpio = {};
    for (const a of assignedPins) {
        const gpio = String(a.gpio ?? a.pin_number ?? a.pin ?? "").trim();
        if (gpio) assignedByGpio[gpio] = a;
    }
    // Each label string ("2", "21", "GND") maps to one or more pin records.
    // We accept the first JSON entry whose label matches.
    const byLabelText = {};
    for (const p of pinMap.pins) {
        if (!byLabelText[p.label]) byLabelText[p.label] = p;
    }

    // Remove any previous annotations we added
    svg.querySelectorAll("[data-volt-annotation]").forEach(n => n.remove());
    svg.querySelectorAll("[data-volt-pinlbl]").forEach(n => {
        n.classList.remove("is-assigned");
        n.removeAttribute("data-volt-pinlbl");
    });

    // Walk every text element and check its tspan text content
    for (const text of svg.querySelectorAll("text")) {
        const content = (text.textContent || "").trim();
        const pin = byLabelText[content];
        if (!pin) continue;

        text.setAttribute("data-volt-pinlbl", content);

        const a = assignedByGpio[pin.gpio || ""];
        if (!a) continue;

        // Get actual rendered position via getBBox (handles any nested transforms)
        let bbox;
        try { bbox = text.getBBox(); } catch (_) { continue; }
        const x = bbox.x + bbox.width / 2;
        const y = bbox.y + bbox.height / 2;

        text.classList.add("is-assigned");
        // Append a sibling group with a ring + variable label
        const xmlns = "http://www.w3.org/2000/svg";
        const grp = document.createElementNS(xmlns, "g");
        grp.setAttribute("data-volt-annotation", pin.gpio || pin.label);
        grp.setAttribute("class", "pinout-anno");

        const ring = document.createElementNS(xmlns, "circle");
        ring.setAttribute("cx", x);
        ring.setAttribute("cy", y);
        ring.setAttribute("r", Math.max(bbox.width, bbox.height) / 2 + 3);
        ring.setAttribute("class", "pinout-anno-ring");
        grp.appendChild(ring);

        const lbl = document.createElementNS(xmlns, "text");
        lbl.setAttribute("x", x);
        // place the variable name slightly above the pin
        lbl.setAttribute("y", y - bbox.height);
        lbl.setAttribute("text-anchor", "middle");
        lbl.setAttribute("class", "pinout-anno-name");
        lbl.textContent = a.name;
        grp.appendChild(lbl);

        text.parentNode.appendChild(grp);

        grp.addEventListener("click", () => {
            document.dispatchEvent(new CustomEvent("pinout:jump", { detail: { name: a.name } }));
        });
    }
}

// ============================================================
// Pico — HTML overlay from JSON coords
// ============================================================
function renderHtmlOverlay(stage, svg, pinMap, assignedPins) {
    // Clear any prior overlay layer
    stage.querySelector(".pinout-overlay")?.remove();

    const assignedByGpio = {};
    for (const a of assignedPins) {
        const gpio = String(a.gpio ?? a.pin_number ?? a.pin ?? "").trim();
        if (gpio) assignedByGpio[gpio] = a;
    }

    const [vx, vy, vw, vh] = (pinMap.viewBox || "0 0 1 1").split(/\s+/).map(Number);
    const overlay = document.createElement("div");
    overlay.className = "pinout-overlay";
    for (const p of pinMap.pins) {
        const a = p.gpio ? assignedByGpio[p.gpio] : null;
        const btn = document.createElement("button");
        btn.className = `pinout-pin pinout-pin-${p.type || "io"}` + (a ? " is-assigned" : "");
        btn.style.left = ((p.x - vx) / vw * 100) + "%";
        btn.style.top  = ((p.y - vy) / vh * 100) + "%";
        btn.title = pinTooltip(p);
        btn.innerHTML = `
            <span class="pinout-pin-dot"></span>
            ${a ? `<span class="pinout-pin-name">${escapeHtml(a.name)}</span>` : ""}
        `;
        if (a) btn.onclick = () => document.dispatchEvent(new CustomEvent("pinout:jump", { detail: { name: a.name } }));
        overlay.appendChild(btn);
    }
    // Position overlay over the SVG: parent must be position:relative
    stage.appendChild(overlay);
}

function pinTooltip(p) {
    const parts = [];
    parts.push(p.label + (p.gpio && p.gpio !== p.label ? ` (GPIO ${p.gpio})` : ""));
    if (p.alt && p.alt.length) parts.push("Alt: " + p.alt.join(", "));
    if (p.note) parts.push(p.note);
    return parts.join("\n");
}

function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
