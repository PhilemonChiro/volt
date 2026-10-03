// Hardware — the Board tab (wide board + pin card + list) and the Hardware
// side panel (list + docked card). The code stays the source of truth:
// every action is a single undoable edit to the hardware block
// (hardware-edit.js), the views redraw from the edited source, and a toast
// shows the exact line written with Undo / Show in code.
//
// Fast by default: adding is ONE action — a part tile on a free pin, or
// "Add part" (Ctrl+Shift+A) → type → Enter. parts.js picks pins, bus,
// address and name; the card that follows shows how to wire it and lets
// you rename (type + Enter), change, move or remove it.

import * as pinout from "./pinout-panel.js";
import * as chipSelector from "./chip-selector.js";
import { MODES, chip, pinTable, supportsMode, takenGpios, rankFreePins, tagFor, busPins, busPinsNow, deviceFacts, deviceFactsNow, BUS_SIGNALS } from "./pin-facts.js";
import { applyEdits, insertDecl, insertDecls, deleteDecl, fixToEdit, flashLine, modernizeHardware } from "./hardware-edit.js";
import { catalogue, placePart, fitsPin, deviceWiring } from "./parts.js";
import * as picker from "./part-picker.js";

// Two hosts share the list + card code: { name, el, list, card, toast }
const _hosts = {};
let _hw = { pins: [], buses: [], devices: [], pinByGpio: {} };
let _pick = null;          // { targets, onPick } while picking a pin on the board
let _view = "code";

function editor() {
    return typeof monaco !== "undefined" ? monaco.editor.getEditors()[0] || null : null;
}
function source() {
    const ed = editor();
    return ed ? ed.getValue() : "";
}
function showView(v) {
    import("./diagrams-view.js").then(m => m.showView(v));
}

// ---- parts (assets/parts/basic.json + device library, via parts.js) ----

let _parts = [];
catalogue().then(c => { _parts = c; for (const h of Object.values(_hosts)) renderList(h); });
const basicParts = () => _parts.filter(e => e.kind === "pin");
const useOf = mode => basicParts().find(u => u.mode === (mode || "Output"))
    || { id: mode, label: mode || "Output", mode, name: "pin", wiring: [], example: "{name}" };
const partForType = type => _parts.find(e => e.kind === "device" && e.type.toLowerCase() === String(type).toLowerCase());
const fill = (s, gpio, name) => s.replace(/\{gpio\}/g, gpio).replace(/\{name\}/g, name || "…");

// Plain-language pin safety: { level: good|ok|avoid|no, label, text }.
function plainSafety(info, gpio) {
    if (!info) return { level: "ok", label: "", text: "" };
    const r = info.reason || "";
    const text = {
        "on-board LED": "Also lights the board's own LED. Fine for outputs; avoid buttons here.",
        "strapping": Number(gpio) === 12 ? "Pulled HIGH at power-up, the board won't start. Avoid for buttons and sensors."
            : Number(gpio) === 0 ? "This is the BOOT button pin — held LOW at power-up, your program won't start."
            : "Used by the chip while it starts up. Outputs are usually fine; avoid buttons here.",
        "UART0 TX": "Used by the USB cable to talk to your computer. Using it breaks uploading and the Serial Monitor.",
        "UART0 RX": "Used by the USB cable to talk to your computer. Using it breaks uploading and the Serial Monitor.",
        "JTAG": "Fine to use — it only matters if you use a hardware debugger.",
        "PSRAM": "Fine on most boards (WROOM). Only a problem on WROVER boards with extra memory.",
        "errata": "Input-only. Fine for buttons and sensors.",
        "not on DevKit": "Not on the header of most boards.",
        "unavailable": "Wired to the board's memory chip — using it crashes the board.",
    }[r] || (info.notes && info.notes[0]) || "";
    switch (info.safety) {
        case "safe": return { level: "good", label: "Good pin", text: "— free and safe to use." };
        case "caution": return { level: "ok", label: "OK to use", text };
        case "risky": return { level: "avoid", label: "Avoid if you can", text };
    }
    return { level: "no", label: "Can't be used", text };
}

function statusLine(info, gpio) {
    const s = plainSafety(info, gpio);
    if (!s.label) return "";
    const icon = { good: "✓", ok: "●", avoid: "⚠", no: "⨯" }[s.level];
    return `<div class="hwp-status is-${s.level}"><b>${icon} ${esc(s.label)}</b>${s.text ? `<span>${esc(s.text)}</span>` : ""}</div>`;
}

// Pin modes this GPIO supports, as buttons.
const modesFor = info => MODES.filter(m => !info || supportsMode(info, m.mode));
const MODE_NAME = { Output: "out", Input: "input", PullUpInput: "button", PullDownInput: "button", Analog: "analog",
    PWM: "pwm", Servo: "servo", DAC: "dac", Touch: "touch" };
const nameForMode = (mode, gpio) => uniqueName((MODE_NAME[mode] || "pin") + gpio);
function modeTiles(info, activeMode) {
    return `<div class="hwp-uses" role="group">${modesFor(info).map(m =>
        `<button class="hwp-use${m.mode === activeMode ? " is-active" : ""}" data-mode="${m.mode}" aria-pressed="${m.mode === activeMode}">
            <b>${m.mode}</b><span>${esc(m.doc)}</span></button>`).join("")}</div>`;
}

// Add `pin <name>: <Mode> = <gpio>` — one edit, then the pin's card.
function addPin(h, gpio, mode, name) {
    const t = `pin ${name || nameForMode(mode, gpio)}: ${mode} = ${gpio}`;
    const line = insertDecls([t], { flash: _view === "code" })[0];
    done(h, "Added", t, line, () => editCardFor(h, line, !name));
}

function wireList(lines) {
    return `<ul class="hwp-wire">${lines.map(w => typeof w === "string"
        ? `<li>${esc(w)}</li>`
        : `<li>${esc(w.text)}${w.note ? ` <span class="hwp-muted">— ${esc(w.note)}</span>` : ""}</li>`).join("")}</ul>`;
}

// ---- add (one action) ----

// Add `entry` with everything decided by parts.placePart; then show its
// card (name field focused — type to rename, or just carry on).
export async function quickAdd(h, entry, opts = {}) {
    h = h || await ensureHost();
    const plan = await placePart(entry, _hw, opts);
    if (plan.error) { notice(h, plan.error); return null; }
    const lines = insertDecls(plan.texts, { flash: _view === "code" });
    const line = lines[lines.length - 1];
    const last = plan.texts[plan.texts.length - 1];
    done(h, "Added " + entry.label.split(" / ")[0] + (plan.texts.length > 1 ? " + bus" : ""), last, line, () => {
        if (entry.kind === "pin") editCardFor(h, line, true);
        else itemCard(h, "device", line, null, true);
    }, plan.note);
    return plan.name;
}

// The searchable "Add part" dialog; from a pin it lists parts that fit it.
// Where results show: the Board tab's card, else the Hardware side panel
// (opened on demand — only once something is actually added).
async function ensureHost() {
    if (_view === "board" && _hosts.board) return _hosts.board;
    if (!_hosts.side) {
        (await import("./side-panel.js")).open("hardware");
        for (let i = 0; i < 50 && !_hosts.side; i++) await new Promise(r => setTimeout(r, 10));
    }
    return _hosts.side || _hosts.board;
}

// Warm the caches so the dialogs open instantly.
export function prefetch() {
    pinTable();
    busPins();
    deviceFacts();
    catalogue();
}

// kind: "pin" (LEDs, buttons…) / "device" (library) / undefined (both).
export async function openPicker(h, gpio, kind) {
    if (kind === "pin" && gpio == null) return openPinPicker(h);
    const info = gpio != null ? (await pinTable()).find(i => String(i.gpio) === String(gpio)) : null;
    if (!kind) kind = "device";   // pins have their own form (Add pin)
    const title = kind === "pin" ? "Add a pin" : kind === "device" ? "Add a device" : "Add a part";
    picker.open({ title: gpio != null ? `${title} on GPIO ${gpio}` : title, info, kind,
        onPick: e => quickAdd(h || null, e, gpio != null ? { gpio } : {}) });
}

// Add pin: compact form — every free pin on the board header, in number
// order (no suggestion), then the types that pin supports, then a name.
async function openPinPicker(h) {
    const table = await pinTable();
    const taken = takenGpios(_hw);
    const onBoard = pinout.boardsFor(chip()).length;
    // Unsafe pins can be chosen (with a red note); prohibited ones (flash)
    // are listed but disabled, so it's clear why they can't be used.
    const pins = table
        .filter(i => !taken.has(String(i.gpio)) && (!onBoard || pinout.boardPinInfo(i.gpio)))
        .sort((a, b) => a.gpio - b.gpio)
        .map(i => {
            const w = pinout.boardPinInfo(i.gpio);
            const level = { safe: "", caution: "warning", risky: "issue", unavailable: "blocked" }[i.safety] || "";
            return { gpio: String(i.gpio), label: w ? w.label : String(i.gpio), level,
                note: i.safety === "safe" ? "" : plainSafety(i, i.gpio).text, info: i };
        });
    picker.openPin({
        pins,
        modesFor: g => modesFor(pins.find(p => p.gpio === g).info),
        nameFor: (mode, g) => nameForMode(mode, g),
        nameProblem: n => nameProblem(n),
        onPick: async (g, mode, n) => addPin(h || await ensureHost(), g, mode, n),
    });
}

function notice(h, msg) {
    const t = h.toast;
    t.innerHTML = `<span class="hwp-toast-what">⚠ ${esc(msg)}</span>`;
    t.style.display = "";
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.style.display = "none"; }, 5000);
}

// ---- setup ----

// The Board tab. Called once when the editor first opens, so the board is
// loaded for the editor's pin hovers even before the tab is shown.
export function initBoard(el) {
    if (_hosts.board) return;
    el.innerHTML = `
        <div class="bv-bar">
            <select class="hwp-board" title="Which dev board you're wiring"></select>
            <div class="bv-legend">
                <span class="role-out"><i></i>Output</span><span class="role-pwm"><i></i>PWM / Servo</span>
                <span class="role-in"><i></i>Input / Touch</span><span class="role-adc"><i></i>Analog / DAC</span>
                <span class="role-bus"><i></i>Bus</span><span class="role-dev"><i></i>Device</span>
                <span class="bv-legend-free">Free pins:
                    <i class="ring good"></i>good <i class="ring caution"></i>OK <i class="ring risky"></i>avoid</span>
            </div>
            <span class="bv-stats"></span>
            <button class="pp-btn pp-btn-ghost bv-add" data-kind="device" title="Add a sensor, display or module">+ Add device</button>
            <button class="pp-btn pp-btn-ghost bv-add" data-kind="pin" title="Add an LED, button, servo… (Ctrl+Shift+A)">+ Add pin</button>
            <button class="pp-btn pp-btn-ghost bv-more" title="More" aria-label="More actions">⋯</button>
        </div>
        <div class="bv-body">
            <div class="bv-canvas"></div>
            <div class="bv-side">
                <div class="hwp-card"></div>
                <div class="hwp-list"></div>
            </div>
            <div class="hwp-banner" style="display:none" role="status"></div>
            <div class="hwp-toast" style="display:none" role="status"></div>
            <div class="hwp-tip" style="display:none"></div>
        </div>`;
    _hosts.board = host("board", el);
    el.querySelectorAll(".bv-add").forEach(b => b.onclick = () => openPicker(_hosts.board, null, b.dataset.kind));
    const more = el.querySelector(".bv-more");
    more.onclick = () => moreMenu(_hosts.board, more);
    pinout.init(el.querySelector(".bv-canvas"));
    pinout.onPinClick(onBoardClick);
    pinout.onPinHover(showTip);
    bindGlobal();
    emptyCard(_hosts.board);
    refresh();
}

// The Hardware side panel (Code view).
export function initSide(el) {
    if (!el.querySelector(".hws")) {
        el.innerHTML = `
            <div class="hws">
                <div class="hwp-list"></div>
                <div class="hwp-toast" style="display:none"></div>
                <div class="hwp-card" style="display:none"></div>
            </div>`;
        _hosts.side = host("side", el);
        bindGlobal();
    }
    refresh();
}

function host(name, el) {
    return { name, el, list: el.querySelector(".hwp-list"), card: el.querySelector(".hwp-card"),
        toast: el.querySelector(".hwp-toast"), selGpios: [], selLine: 0 };
}

let _globalBound = false;
function bindGlobal() {
    if (_globalBound) return;
    _globalBound = true;
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (_pick) { endPick(); return; }
        if (_view === "board" && _hosts.board) emptyCard(_hosts.board);
        if (_view === "code" && _hosts.side && _hosts.side.card.style.display !== "none") closeCard(_hosts.side);
    });
    document.addEventListener("volt:view", (e) => {
        _view = e.detail.view;
        if (_view !== "board") endPick();
        if (_view === "board") refresh();
    });
}

// Re-read the source (every keystroke) and redraw.
export function refresh(src = source()) {
    // The parser needs device facts and the chip's bus pins; redraw once
    // they arrive.
    if (!busPinsNow() || !deviceFactsNow()) Promise.all([busPins(), deviceFacts()]).then(() => refresh());
    _hw = pinout.extractHardware(src);
    const c = chip();
    if (_hosts.board) {
        pinout.render(c, Object.values(_hw.pinByGpio), _hw);
        renderBoardPicker(c);
        pinTable().then(t => {
            _tipTable = t;
            pinout.setSafety(Object.fromEntries(t.map(i => [String(i.gpio), i.safety])));
            renderStats(t);
        });
    }
    for (const h of Object.values(_hosts)) renderList(h);
}

// Open the card for the hardware declaration on `line` (gutter dot click).
export function showLine(line) {
    const h = (_view === "board" ? _hosts.board : _hosts.side) || _hosts.board;
    if (!h) return;
    const p = _hw.pins.find(x => x.line === line);
    if (p) return editCard(h, p);
    if (_hw.buses.some(b => b.line === line)) return itemCard(h, "bus", line);
    if (_hw.devices.some(d => d.line === line)) return itemCard(h, "device", line);
}

export function setDiagnostics(diags, src) {
    pinout.setDiagnostics(diags, src);
    for (const h of Object.values(_hosts)) renderList(h);
}

function renderBoardPicker(c) {
    const sel = _hosts.board.el.querySelector(".hwp-board");
    const list = pinout.boardsFor(c);
    const id = pinout.boardIdFor(c);
    const key = c + ":" + id;
    if (sel.dataset.key !== key) {
        sel.dataset.key = key;
        sel.innerHTML = list.length
            ? list.map(b => `<option value="${esc(b.id)}"${b.id === id ? " selected" : ""}>${esc(b.label)}</option>`).join("")
            : `<option>${esc(c.toUpperCase())}</option>`;
        sel.disabled = list.length < 2;
    }
    sel.onchange = async () => {
        await chipSelector.setBoard(sel.value);
        refresh();
    };
}

function renderStats(table) {
    const taken = takenGpios(_hw);
    const free = table.filter(i => !taken.has(String(i.gpio)) && i.safety !== "unavailable");
    const safe = free.filter(i => i.safety === "safe").length;
    const used = _hw.pins.length;
    _hosts.board.el.querySelector(".bv-stats").textContent =
        `${used} pin${used === 1 ? "" : "s"} used · ${safe} good pin${safe === 1 ? "" : "s"} free`;
}

// ---- list ----

function renderList(h) {
    const el = h.list;
    const { pins, devices } = _hw;
    const buses = _hw.buses.filter(b => !b.implicit);
    // One add bar on top (the Board tab has the same buttons in its toolbar).
    const bar = h.name === "board" ? "" : `<div class="hwl-bar">
        <button class="pp-btn pp-btn-ghost hwl-add" data-kind="device" title="Add a sensor, display or module">+ Add device</button>
        <button class="pp-btn pp-btn-ghost hwl-add" data-kind="pin" title="Add an LED, button, servo… (Ctrl+Shift+A)">+ Add pin</button>
        <button class="pp-btn pp-btn-ghost hwl-more" title="More" aria-label="More actions">⋯</button>
    </div>`;
    const title = (t, n) => `<div class="hw-section-title hwl-title">${t}<span class="hwl-count">${n}</span></div>`;
    let html;
    if (!pins.length && !buses.length && !devices.length) {
        html = `<div class="panel-empty">
            <div class="empty-title">No hardware yet</div>
            <div class="empty-hint">Add an LED, button, sensor or display — Volt picks the pins.</div>
        </div>`;
    } else {
        html = "";
        if (_hw.legacy) html += `<button class="hwl-legacy hwl-modernize" title="Rewrite the hardware block in the current syntax (one undo step)">
            Old hardware syntax — <b>Modernize</b></button>`;
        html += `<div class="hw-section">${title("Devices", devices.length)}`;
        if (!devices.length) html += `<div class="hwl-none">Sensors, displays, radios… on a bus or their own pins.</div>`;
        for (const d of devices) {
            const own = Object.entries(d.roles || {});
            const bus = _hw.buses.find(b => b.name === d.bus);
            const where = [bus && !(bus.implicit && bus.owner) && bus.name, ...own.map(([r, g]) => r + " " + g),
                bus && bus.busType === "I2C" && d.address].filter(Boolean).join(" · ");
            html += row(d, "device", deviceGpios(d), d.name, d.type, where, []);
        }
        // The chip's default buses aren't in the code: one muted line.
        const auto = _hw.buses.filter(b => b.implicit && !b.owner);
        if (auto.length) html += `<div class="hwl-auto">default ${auto.map(b =>
            `<button class="hwl-autobus" data-line="${b.line}" title="${esc(b.busType)} bus on the chip's standard pins">${esc(b.busType)} ${Object.values(b.roles).join("/")}</button>`).join(" · ")}</div>`;
        html += "</div>";
        html += `<div class="hw-section">${title("Pins", pins.length)}`;
        if (!pins.length) html += `<div class="hwl-none">LEDs, buttons, servos… wired to one pin.</div>`;
        for (const p of pins)
            html += row(p, "pin", [p.gpio], p.name, p.mode || "Output", "GPIO " + p.gpio, pinout.pinDiagnostics(p.gpio));
        html += "</div>";
        if (buses.length) {
            html += `<div class="hw-section">${title("Buses", buses.length)}`;
            for (const b of buses) html += row(b, "bus", Object.values(b.roles), b.name, b.busType,
                Object.entries(b.roles).map(([r, g]) => r + " " + g).join(" · "), []);
            html += "</div>";
        }
    }
    html = bar + html;
    el.innerHTML = html;
    if (h.selLine) el.querySelector(`.hwl-row[data-line="${h.selLine}"]`)?.classList.add("is-selected");

    el.querySelectorAll(".hwl-add[data-kind]").forEach(b => b.onclick = () => openPicker(h, null, b.dataset.kind));
    const more = el.querySelector(".hwl-more");
    if (more) more.onclick = () => moreMenu(h, more);
    el.querySelectorAll(".hwl-autobus").forEach(b => b.onclick = () => itemCard(h, "bus", Number(b.dataset.line)));
    const modern = el.querySelector(".hwl-modernize");
    if (modern) modern.onclick = async () => {
        if (!await modernizeHardware({ flash: _view === "code" })) notice(h, "Couldn't modernize — fix the errors in the hardware block first.");
    };
    el.querySelectorAll(".hwl-row").forEach(r => {
        const line = Number(r.dataset.line);
        const gpios = r.dataset.gpios ? r.dataset.gpios.split(",") : [];
        r.onclick = () => {
            if (r.dataset.kind === "pin") {
                const p = _hw.pins.find(x => x.line === line);
                if (p) editCard(h, p);
            } else itemCard(h, r.dataset.kind, line);
        };
        r.onpointerenter = () => {
            if (_pick) return;     // keep the pin being moved highlighted
            pinout.setHighlight(gpios);
            document.dispatchEvent(new CustomEvent("pinout:hover", { detail: { line } }));
        };
        r.onpointerleave = () => {
            if (_pick) return;
            pinout.setHighlight(h.selGpios);
            document.dispatchEvent(new CustomEvent("pinout:hover", { detail: { line: 0 } }));
        };
    });
}

// ⋯ next to the add buttons: the rarer actions.
export function moreMenu(h, anchor) {
    document.querySelector(".hwl-menu")?.remove();
    const items = [["bus", "Add bus", "Custom I2C / SPI / UART pins"]];
    if (_hw.legacy) items.push(["modernize", "Modernize hardware", "Rewrite in the current syntax"]);
    const menu = document.createElement("div");
    menu.className = "hwl-menu";
    menu.innerHTML = items.map(([a, t, d]) => `<button data-act="${a}"><b>${t}</b><span>${d}</span></button>`).join("");
    const r = anchor.getBoundingClientRect();
    menu.style.top = r.bottom + 4 + "px";
    menu.style.right = window.innerWidth - r.right + "px";
    document.body.appendChild(menu);
    const close = (e) => {
        if (e && menu.contains(e.target)) return;
        menu.remove();
        document.removeEventListener("pointerdown", close, true);
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true));
    menu.querySelector("[data-act='bus']").onclick = () => { close(); busWizard(); };
    const mod = menu.querySelector("[data-act='modernize']");
    if (mod) mod.onclick = async () => {
        close();
        if (!await modernizeHardware({ flash: _view === "code" })) notice(h, "Couldn't modernize — fix the errors in the hardware block first.");
    };
}

function row(item, kind, gpios, name, tag, detail, warn) {
    const role = kind === "bus" ? "bus" : kind === "device" ? "dev" : pinout.roleOf(item);
    return `<div class="hw-item hwl-row role-${role}" data-kind="${kind}" data-line="${item.line}" data-gpios="${esc(gpios.join(","))}">
        <i class="hwl-dot"></i>
        <span class="hw-name">${esc(name)}</span>
        <span class="hwl-tag">${esc(tag || "")}</span>
        <span class="hw-detail">${esc(detail)}</span>
        ${warn.length ? `<span class="hwl-warn${gpios.some(g => pinout.pinSeverity(g) === "error") ? " is-error" : ""}" title="${esc(warn.join("\n"))}">⚠</span>` : ""}
    </div>`;
}

function deviceGpios(d) {
    const own = Object.values(d.roles || {});
    if (own.length) return own.map(String);
    const bus = _hw.buses.find(b => b.name === d.bus);
    if (bus) return Object.values(bus.roles).map(String);
    const anchor = _hw.pinByGpio[String(parseInt(d.address))];
    return anchor && anchor.line === d.line ? [anchor.gpio] : [];
}

// ---- board hover hint ----

let _tipTable = [];

function showTip(gpio, boardPin, assigned, el) {
    const tip = _hosts.board && _hosts.board.el.querySelector(".hwp-tip");
    if (!tip) return;
    if (gpio === null || !el) { tip.style.display = "none"; return; }
    let title, text, more = "";
    if (_pick) {
        [title, text] = _pick.describe && gpio ? _pick.describe(String(gpio))
            : _pick.targets.includes(gpio) ? [`GPIO ${gpio}`, "Click to choose this pin"] : [boardPin.label, "Not available for this"];
    } else if (assigned && (assigned.kind || "pin") === "pin") {
        title = assigned.name;
        text = `${assigned.mode || "Output"} on GPIO ${gpio} — click to change`;
    } else if (assigned) {
        title = assigned.name;
        text = assigned.kind === "bus" ? `${(assigned.role || "").toUpperCase()} of the ${assigned.busType} bus` : `${assigned.deviceType || "device"} pin`;
    } else if (gpio) {
        const info = _tipTable.find(i => String(i.gpio) === String(gpio));
        const s = plainSafety(info, gpio);
        title = `GPIO ${gpio}` + (boardPin.label !== String(gpio) ? ` (${boardPin.label})` : "");
        text = s.level === "no" ? "Can't be used" : "Free · " + s.label;
        more = s.level === "good" ? "Click to use it" : s.level === "no" ? s.text : s.text + " Click to use it anyway.";
    } else {
        title = boardPin.label;
        text = { power: "Power", ground: "Ground (GND) — connect your parts' – here" }[boardPin.type] || boardPin.note || "Not a GPIO";
    }
    tip.innerHTML = `<b>${esc(title)}</b><span>${esc(text)}</span>${more ? `<em>${esc(more)}</em>` : ""}`;
    tip.style.display = "";
    const host = tip.parentElement.getBoundingClientRect(), r = el.getBoundingClientRect();
    // Outward for free pins (nothing there); toward the middle for used
    // pins, whose name label sits outside.
    const canvas = el.closest(".bv-canvas").getBoundingClientRect();
    const leftSide = r.left + r.width / 2 < canvas.left + canvas.width / 2;
    const outward = !assigned;
    const toLeft = leftSide === outward;
    tip.style.top = (r.top - host.top + r.height / 2 - tip.offsetHeight / 2) + "px";
    tip.style.left = (toLeft ? r.left - host.left - tip.offsetWidth - 40 : r.right - host.left + 40) + "px";
}

// ---- board clicks ----

function onBoardClick(gpio, boardPin, assigned) {
    const h = _hosts.board;
    if (_pick) {
        if (_pick.targets.includes(gpio)) _pick.onPick(gpio);
        else if (_pick.from.includes(String(gpio))) endPick();
        return;
    }
    if (assigned && (assigned.kind || "pin") === "pin") {
        const p = _hw.pins.find(x => x.line === assigned.line);
        if (p) return editCard(h, p);
    }
    if (assigned) return itemCard(h, assigned.kind, assigned.line, boardPin);
    if (!gpio) return infoCard(h, boardPin);
    addCard(h, gpio);
}

// ---- card ----

function select(h, gpios, line) {
    h.selGpios = gpios.map(String);
    h.selLine = line || 0;
    pinout.setHighlight(h.selGpios);
    h.list.querySelectorAll(".hwl-row").forEach(r => r.classList.toggle("is-selected", !!line && Number(r.dataset.line) === line));
}

function showCard(h, html) {
    endPick();
    h.card.innerHTML = html;
    h.card.style.display = "";
    h.card.classList.remove("is-empty");
    const close = h.card.querySelector("[data-act='close']");
    if (close) close.onclick = () => (h.name === "board" ? emptyCard(h) : closeCard(h));
    // Keep the selected row visible next to the card.
    h.list.querySelector(".hwl-row.is-selected")?.scrollIntoView({ block: "nearest" });
    return h.card;
}

function emptyCard(h) {
    endPick();
    select(h, [], 0);
    h.card.classList.add("is-empty");
    // Just the hint: the add buttons live in the toolbar.
    h.card.innerHTML = `<div class="hwp-hint">
        <span class="hwp-muted">Click a <i class="hwp-dot is-good"></i> green pin to put something on it, or <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>A</kbd>.
            Every change is a normal edit — Ctrl+Z undoes it.</span>
    </div>`;
}

function closeCard(h) {
    select(h, [], 0);
    h.card.style.display = "none";
    h.card.innerHTML = "";
}

function head(title, sub) {
    return `<div class="pp-head">
        <div class="pp-head-title">
            <span class="pp-pin-label">${esc(title)}</span>
            ${sub ? `<span class="pp-pin-gpio">${esc(sub)}</span>` : ""}
        </div>
        <button class="pp-close" data-act="close" aria-label="Close" title="Close (Esc)">×</button>
    </div>`;
}

// "right header, pin 7" — where to find the GPIO on the physical board.
function whereText(gpio) {
    const w = pinout.boardPinInfo(gpio);
    return w ? `${w.header} header, pin ${w.index}` + (w.label !== String(gpio) ? ` (“${w.label}”)` : "") : "";
}

function codeLine(text) {
    return `<code class="hwp-code">${esc(text.trim())}</code>`;
}

function modeChips(modes, active) {
    return `<div class="hwp-modes">${modes.map(m =>
        `<button class="hwp-chip${m === active ? " is-active" : ""}" data-mode="${m}" title="${esc((MODES.find(x => x.mode === m) || {}).doc || "")}">${m}</button>`).join("")}</div>`;
}

function altLine(gpio) {
    const where = pinout.boardPinInfo(gpio);
    return where && where.alt.length ? `<div class="hwp-muted">Also: ${esc(where.alt.join(", "))}</div>` : "";
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function nameProblem(name, own) {
    if (!IDENT.test(name)) return "Use letters, digits and _ (not starting with a digit).";
    const taken = [..._hw.pins, ..._hw.buses, ..._hw.devices].some(x => x.name === name && x.name !== own);
    return taken ? `“${name}” is already used in the hardware block.` : "";
}

function uniqueName(base) {
    const names = new Set([..._hw.pins, ..._hw.buses, ..._hw.devices].map(x => x.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(base + "_" + i)) return base + "_" + i;
}

// Free pin → one click adds a part here (tiles), or "More parts…".
async function addCard(h, gpio) {
    const table = await pinTable();
    const info = table.find(i => String(i.gpio) === String(gpio));
    const where = pinout.boardPinInfo(gpio);
    if (!info) return infoCard(h, where || { label: "GPIO " + gpio, gpio, alt: [] });
    select(h, [gpio], 0);
    const sub = whereText(gpio);
    if (info.safety === "unavailable") {
        showCard(h, head("GPIO " + gpio, sub) + `<div class="pp-body">${statusLine(info, gpio)}</div>`);
        return;
    }
    const safety = plainSafety(info, gpio);
    const card = showCard(h, head("GPIO " + gpio, sub) + `<div class="pp-body">
        ${statusLine(info, gpio)}
        ${safety.level !== "good" ? `<button class="hwp-link" data-act="safer">Use a better pin instead</button>` : ""}
        <div class="pp-section-title">Use as</div>
        ${modeTiles(info)}
        <button class="hwp-link" data-act="more">More parts — sensors, displays, modules…</button>
        ${altLine(gpio)}
    </div>`);
    card.querySelectorAll(".hwp-use").forEach(t => t.onclick = () => addPin(h, gpio, t.dataset.mode));
    card.querySelector("[data-act='more']").onclick = () => openPicker(h, gpio);
    card.querySelector(".hwp-use")?.focus();
    const safer = card.querySelector("[data-act='safer']");
    if (safer) {
        const rank = { safe: 0, caution: 1, risky: 2 };
        const best = rankFreePins(table, "Output", takenGpios(_hw)).find(i => rank[i.safety] < rank[info.safety]);
        if (!best) safer.remove();
        else safer.onclick = () => addCard(h, String(best.gpio));
    }
}

// Re-open the card for whatever pin now sits on `line` (after an edit).
function editCardFor(h, line, focusName) {
    const p = _hw.pins.find(x => x.line === line);
    if (p) editCard(h, p, focusName);
    else if (h.name === "board") emptyCard(h);
    else closeCard(h);
}

// Used pin → name (type + Enter renames every use), how to wire it, any
// problem + its fix, then Change part / Move / Remove.
async function editCard(h, p, focusName) {
    const table = await pinTable();
    const info = table.find(i => String(i.gpio) === String(p.gpio));
    const current = p.mode || "Output";
    const use = useOf(current);
    select(h, [p.gpio], p.line);

    const warns = pinout.pinDiagnostics(p.gpio);
    const isErr = pinout.pinSeverity(p.gpio) === "error";
    const seen = new Set();
    const fixes = pinout.pinFixes(p.gpio).filter(f => f.title && !seen.has(f.title) && seen.add(f.title)).slice(0, 2);
    const lineText = editor()?.getModel().getLineContent(p.line) || "";
    const onboard = (pinout.boardPinInfo(p.gpio) || {}).onboard;
    const card = showCard(h, `<div class="pp-head hwp-namehead">
            ${nameField(p.name)}
            <button class="pp-close" data-act="close" aria-label="Close" title="Close (Esc)">×</button>
        </div><div class="pp-body">
        <div class="hwp-muted">${esc(current)} · GPIO ${esc(p.gpio)} · ${esc(whereText(p.gpio))}${onboard ? " · " + esc(onboard) : ""}</div>
        ${warns.length ? `<div class="hwp-status ${isErr ? "is-avoid" : "is-ok"}"><b>⚠ ${isErr ? "Problem with this pin" : "Check this pin"}</b><span>${esc(plainSafety(info, p.gpio).text || warns[0])}</span>
            ${fixes.length ? `<div class="hwp-actions">${fixes.map((f, i) =>
                `<button class="pp-btn pp-btn-primary" data-fix="${i}">${esc(f.title)}</button>`).join("")}</div>` : ""}</div>`
            : info && info.safety !== "safe" ? statusLine(info, p.gpio) : ""}
        <div class="pp-section-title">Wire it</div>
        ${wireList(use.wiring.map(w => fill(w, p.gpio, p.name)))}
        <div class="hwp-muted">In code: <code>${esc(fill(use.example, p.gpio, p.name))}</code></div>
        <div class="hwp-actions hwp-acts" role="group" aria-label="Actions">
            <button class="pp-btn pp-btn-ghost" data-act="change">Change mode</button>
            <button class="pp-btn pp-btn-ghost" data-act="move">Move</button>
            <button class="pp-btn pp-btn-ghost pp-btn-danger" data-act="free">Remove</button>
        </div>
        <div class="hwp-panel" hidden></div>
        <details class="hwp-details"><summary>Details</summary>
            <button class="hwp-codebtn" data-act="jump" title="Show in code">${codeLine(lineText)}<span>line ${p.line} ↗</span></button>
            ${warns.map(w => `<div class="hwp-muted">${esc(w)}</div>`).join("")}
            ${altLine(p.gpio)}
        </details>
    </div>`);

    bindName(card, p.name, focusName, async (n) => {
        const uses = await savePin(p, n, current);
        done(h, `Renamed${uses ? ` + ${uses} use${uses > 1 ? "s" : ""}` : ""}`,
            editor().getModel().getLineContent(p.line), p.line, () => editCardFor(h, p.line));
    });

    const panel = card.querySelector(".hwp-panel");
    const acts = card.querySelectorAll(".hwp-acts button");
    const open = (act, html) => {
        const same = panel.dataset.act === act && !panel.hidden;
        acts.forEach(b => b.classList.toggle("is-active", !same && b.dataset.act === act));
        panel.hidden = same;
        panel.dataset.act = same ? "" : act;
        panel.innerHTML = same ? "" : html;
        return !same;
    };
    card.querySelector("[data-act='change']").onclick = () => {
        if (!open("change", `<div class="pp-section-title">Mode</div>${modeTiles(info, current)}`)) return;
        panel.querySelector(".hwp-use.is-active, .hwp-use")?.focus();
        panel.querySelectorAll(".hwp-use").forEach(t => t.onclick = async () => {
            const mode = t.dataset.mode;
            if (mode === current) return;
            await savePin(p, p.name, mode);
            done(h, "Mode " + mode, editor().getModel().getLineContent(p.line), p.line, () => editCardFor(h, p.line));
        });
    };
    card.querySelector("[data-act='move']").onclick = () => startPick(p);
    card.querySelector("[data-act='jump']").onclick = () => jumpTo(p.line);
    card.querySelectorAll("[data-fix]").forEach(b => b.onclick = () => {
        const f = fixes[Number(b.dataset.fix)];
        applyEdits([fixToEdit(f)], { flash: _view === "code" });
        done(h, f.title, editor().getModel().getLineContent(f.line), f.line, () => editCardFor(h, p.line));
    });
    card.querySelector("[data-act='free']").onclick = async () => {
        const uses = (await symbolFor(p)).refs.filter(r => r.line !== p.line).length;
        if (!uses) return removeLine(h, p.line, p.name, lineText);
        if (!open("free", `<div class="hwp-muted">Your code uses <code>${esc(p.name)}</code> in ${uses} place${uses > 1 ? "s" : ""} — those lines will show errors until you change them.</div>
            <div class="hwp-row"><button class="pp-btn pp-btn-ghost pp-btn-danger" data-act="do-free">Remove anyway</button></div>`)) return;
        panel.querySelector("[data-act='do-free']").onclick = () => removeLine(h, p.line, p.name, lineText);
    };
}

// The card title is the name itself: edit it in place, Enter renames.
function nameField(name) {
    return `<input class="hwp-title-name" value="${esc(name)}" spellcheck="false" aria-label="Name — type to rename, Enter to apply"
        title="Rename: type a new name, press Enter">`;
}
function bindName(card, current, focus, apply) {
    const input = card.querySelector(".hwp-title-name");
    const err = document.createElement("div");
    err.className = "hwp-err";
    err.setAttribute("role", "alert");
    card.querySelector(".pp-body").prepend(err);
    const go = () => {
        const n = input.value.trim();
        if (n === current) return;
        const bad = nameProblem(n, current);
        if (bad) { err.textContent = bad; input.classList.add("is-bad"); return; }
        apply(n);
    };
    input.oninput = () => { err.textContent = ""; input.classList.remove("is-bad"); input.classList.toggle("is-dirty", input.value.trim() !== current); };
    input.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); go(); }
        else if (e.key === "Escape" && input.value !== current) { e.stopPropagation(); input.value = current; input.oninput(); }
    };
    if (focus) { input.focus({ preventScroll: true }); input.select(); }
}

function removeLine(h, line, name, text) {
    deleteDecl(line);
    done(h, "Removed " + name, text, 0, () => h.name === "board" ? emptyCard(h) : closeCard(h));
}

// The compiler's symbol for a pin (definition + references), or just the
// declaration when the source doesn't parse.
async function symbolFor(p) {
    try {
        const syms = await window.volt.findSymbols(source());
        const s = (syms || []).find(x => x.name === p.name && x.def_line === p.line);
        if (s) return s;
    } catch (_) {}
    return { refs: [] };
}

// Rename (declaration + every use) and/or change mode — one undo step.
// Returns how many uses were renamed.
async function savePin(p, name, mode) {
    const ed = editor();
    if (!ed) return 0;
    const text = ed.getModel().getLineContent(p.line);
    const m = text.match(/^(\s*pin\s+)(\w+)(\s*:\s*\w+)?/);
    if (!m) return 0;
    const keepMode = mode === (p.mode || "Output") && !m[3];
    const edits = [{ range: { startLine: p.line, startCol: m[1].length + 1, endLine: p.line, endCol: m[0].length + 1 },
        text: name + (keepMode ? "" : `: ${mode}`) }];
    if (name !== p.name) {
        for (const r of (await symbolFor(p)).refs) {
            if (r.line === p.line) continue;
            edits.push({ range: { startLine: r.line, startCol: r.col, endLine: r.line, endCol: r.col + p.name.length }, text: name });
        }
    }
    applyEdits(edits, { flash: _view === "code" });
    return edits.length - 1;
}

// ---- bus / device / power pins ----

function itemCard(h, kind, line, boardPin, focusName) {
    if (kind === "device") return deviceCard(h, line, focusName);
    const item = _hw.buses.find(b => b.line === line);
    if (!item) return;
    const gpios = Object.values(item.roles).map(String);
    select(h, gpios, line);
    // Implicit buses have no line: the chip's default I2C / SPI pins, or a
    // serial module's own UART (its tx / rx live on the device line).
    let body = item.implicit
        ? `<div class="hwp-muted">${item.owner
            ? `${esc(item.owner)}'s own UART — change tx / rx on the device.`
            : `The default ${esc(item.busType)} bus on the chip's standard pins — every ${esc(item.busType)} device without <code>on</code> uses it.`}</div>`
        : `<button class="hwp-codebtn" data-act="jump" title="Show in code">${codeLine(editor()?.getModel().getLineContent(line) || "")}<span>line ${line} ↗</span></button>`;
    body += `<div class="hwp-roles">${Object.entries(item.roles).map(([r, g]) =>
        `<span><b>${esc(r.toUpperCase())}</b> GPIO ${g}<em>${esc(whereText(g))}</em></span>`).join("")}</div>`;
    const riders = _hw.devices.filter(d => d.bus === item.name);
    body += riders.length
        ? `<div class="pp-section"><div class="pp-section-title">Devices on ${esc(item.name)}</div>
            <ul class="pp-alts">${riders.map(d => `<li>${esc(d.name)} <span style="color:var(--t3)">${esc(d.type)} @ ${esc(d.address)}</span></li>`).join("")}</ul></div>`
        : `<div class="hwp-muted">No devices on this bus yet.</div>`;
    for (const g of gpios) for (const w of pinout.pinDiagnostics(g)) body += `<div class="pp-note pp-warn">⚠ ${esc(w)}</div>`;
    if (boardPin && boardPin.alt && boardPin.alt.length) body += `<div class="hwp-muted">Also: ${esc(boardPin.alt.join(", "))}</div>`;
    if (!item.implicit && BUS_SIGNALS[item.busType.toLowerCase()]) body += `<div class="hwp-actions">
        <button class="pp-btn pp-btn-ghost" data-act="edit">Edit bus</button>
        <button class="pp-btn pp-btn-ghost pp-btn-danger" data-act="remove">Remove bus</button></div>`;
    const card = showCard(h, head(item.name, `${item.busType} bus`) + `<div class="pp-body">${body}</div>`);
    const jump = card.querySelector("[data-act='jump']");
    if (jump) jump.onclick = () => jumpTo(line);
    const edit = card.querySelector("[data-act='edit']");
    if (edit) edit.onclick = () => busWizard(item);
    const remove = card.querySelector("[data-act='remove']");
    if (remove) remove.onclick = () => {
        if (riders.length && !remove.dataset.confirm) {
            remove.dataset.confirm = "1";
            remove.textContent = `${riders.length} device${riders.length > 1 ? "s" : ""} use${riders.length > 1 ? "" : "s"} it — remove anyway`;
            return;
        }
        removeLine(h, line, "bus " + item.name, editor()?.getModel().getLineContent(line) || "");
    };
}

// Device → name (type + Enter renames), what it is and where, I2C
// address (alternates one click away), how to wire it, remove.
function deviceCard(h, line, focusName) {
    const d = _hw.devices.find(x => x.line === line);
    if (!d) return;
    const entry = partForType(d.type);
    select(h, deviceGpios(d), line);
    const bus = _hw.buses.find(b => b.name === d.bus);
    const lineText = editor()?.getModel().getLineContent(line) || "";
    const clash = bus && bus.busType === "I2C"
        ? _hw.devices.find(x => x !== d && x.bus === d.bus && parseInt(x.address) === parseInt(d.address)) : null;
    const addrs = entry && bus && bus.busType === "I2C" ? entry.addresses : [];
    const usedOnBus = new Set(_hw.devices.filter(x => x !== d && x.bus === d.bus).map(x => parseInt(x.address)));
    const method = entry && Object.keys(entry.dev.methods || {})[0];
    // UART tx / rx are pins, shown above; baud and the rest are settings.
    const params = Object.entries((entry && entry.dev.params) || {});
    const where = bus ? `on ${bus.name}` + (bus.busType === "I2C" ? ` at ${d.address}` : bus.busType === "SPI" ? `, select GPIO ${d.address}` : "")
        : Object.entries(d.roles || {}).map(([r, g]) => `${r} GPIO ${g}`).join(", ");
    const card = showCard(h, `<div class="pp-head hwp-namehead">
            ${nameField(d.name)}
            <button class="pp-close" data-act="close" aria-label="Close" title="Close (Esc)">×</button>
        </div><div class="pp-body">
        <div class="hwp-muted">${esc(d.type)}${entry && entry.sub ? " · " + esc(entry.sub) : ""} · ${esc(where)}</div>
        ${clash ? `<div class="hwp-status is-avoid"><b>⚠ Address clash</b><span>${esc(clash.name)} also uses ${esc(d.address)} on ${esc(d.bus)}.${addrs.length > 1 ? " Pick another address below (and set the board's ADDR pin to match)." : " Use a second I2C bus or an I2C multiplexer."}</span></div>` : ""}
        ${addrs.length > 1 ? `<div class="hwp-addr"><span class="pp-section-title">Address</span>${addrs.map(a =>
            `<button class="hwp-chip${parseInt(a) === parseInt(d.address) ? " is-active" : ""}${usedOnBus.has(parseInt(a)) ? " is-taken" : ""}" data-addr="${a}"
                title="${usedOnBus.has(parseInt(a)) ? "Used by another device on this bus" : "Use " + a}">${a}</button>`).join("")}</div>` : ""}
        ${Object.keys(d.roles || {}).length ? `<div class="pp-section-title">Pins <span class="hwp-muted">— click one to move it</span></div>
            <div class="hwp-slots">${Object.entries(d.roles).map(([r, g]) =>
                `<button class="hwp-slot" data-role="${esc(r)}"><b>${esc(r.toUpperCase())}</b><span>GPIO ${esc(g)}</span><em>${esc(whereText(g))}</em></button>`).join("")}</div>` : ""}
        ${params.length ? `<div class="pp-section-title">Settings</div><div class="hwp-params">${params.map(([k, p]) =>
            `<label class="hwp-param"><span>${esc(k)}</span><input class="hwp-name" data-param="${esc(k)}" value="${esc(d.params[k] ?? p.default ?? "")}"
                ${p.type === "int" ? 'inputmode="numeric"' : ""} spellcheck="false"></label>`).join("")}</div>` : ""}
        ${entry && entry.wiringPins.length ? `<div class="pp-section-title">Wire it</div>${wireList(deviceWiring(entry, d, _hw))}` : ""}
        ${method ? `<div class="hwp-muted">In code: <code>${esc(d.name)}.${esc(method)}()</code></div>` : ""}
        ${entry && entry.tips[0] ? `<div class="hwp-muted">Tip: ${esc(entry.tips[0])}</div>` : ""}
        <div class="hwp-actions"><button class="pp-btn pp-btn-ghost pp-btn-danger" data-act="remove">Remove</button></div>
        <details class="hwp-details"><summary>Details</summary>
            <button class="hwp-codebtn" data-act="jump" title="Show in code">${codeLine(lineText)}<span>line ${line} ↗</span></button>
            ${entry && entry.dev.datasheet ? `<a class="hwp-link" href="${esc(entry.dev.datasheet)}" target="_blank" rel="noopener">Datasheet ↗</a>` : ""}
        </details>
    </div>`);
    bindName(card, d.name, focusName, async (n) => {
        const uses = await renameDecl(line, d.name, n);
        done(h, `Renamed${uses ? ` + ${uses} use${uses > 1 ? "s" : ""}` : ""}`,
            editor().getModel().getLineContent(line), line, () => deviceCard(h, line));
    });
    card.querySelectorAll("[data-addr]").forEach(b => b.onclick = () => {
        const text = editor().getModel().getLineContent(line);
        if (parseInt(b.dataset.addr) === parseInt(d.address)) return;
        const m = text.match(/^(.*\bat\s+)(\S+)/);
        const end = text.replace(/\s+$/, "").length;
        applyEdits([m ? { range: { startLine: line, startCol: m[1].length + 1, endLine: line, endCol: m[0].length + 1 }, text: b.dataset.addr }
            : { range: { startLine: line, startCol: end + 1, endLine: line, endCol: end + 1 }, text: " at " + b.dataset.addr }],
            { flash: _view === "code" });
        done(h, "Address " + b.dataset.addr, editor().getModel().getLineContent(line), line, () => deviceCard(h, line));
    });
    card.querySelector("[data-act='jump']").onclick = () => jumpTo(line);
    card.querySelector("[data-act='remove']").onclick = () => removeLine(h, line, d.name, lineText);
    card.querySelectorAll(".hwp-slot[data-role]").forEach(b => b.onclick = () => moveDevicePin(d, b.dataset.role));
    card.querySelectorAll("input[data-param]").forEach(inp => inp.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        const k = inp.dataset.param, v = inp.value.trim();
        const spec = entry.dev.params[k] || {};
        if (!v || spec.type === "int" && !/^\d+$/.test(v)) { inp.classList.add("is-bad"); return; }
        if (setDeviceArg(line, k, v)) done(h, `${d.name} ${k} = ${v}`, editor().getModel().getLineContent(line), line, () => deviceCard(h, line));
    });
}

// Set `key: value` in a device's argument list — replace it, add it to the
// parens, or open parens after the type. One undo step.
function setDeviceArg(line, key, value) {
    const text = editor().getModel().getLineContent(line);
    const head = text.match(/^(\s*device\s+\w+\s*:\s*\w+)(\s*\(([^)]*)\))?/);
    if (!head) return false;
    let at, endAt, ins;
    const own = head[2] && head[0].match(new RegExp(`([(,]\\s*${key}\\s*:\\s*)([^,)\\s]+)`));
    if (own) {
        at = own.index + own[1].length; endAt = at + own[2].length; ins = value;
    } else if (head[2]) {
        at = endAt = head[0].length - 1;
        ins = (head[3].trim() ? ", " : "") + `${key}: ${value}`;
    } else {
        at = endAt = head[1].length; ins = `(${key}: ${value})`;
    }
    applyEdits([{ range: { startLine: line, startCol: at + 1, endLine: line, endCol: endAt + 1 }, text: ins }], { flash: _view === "code" });
    return true;
}

// Move one of a device's own pins (trig, echo, pin, cs …) on the board.
async function moveDevicePin(d, role) {
    // Inputs (echo, a UART's rx) may use input-only pins.
    const entry = partForType(d.type);
    const input = role === "rx" || role === "miso" || (entry && entry.inputs && entry.inputs.has(role));
    const from = d.roles[role];
    const { targets, tags, swaps, risky, describe } = await moveOptions(input ? "Input" : "Output", from, d.line, role);
    const who = `${d.name} ${role.toUpperCase()}`;
    if (_view !== "board") showView("board");
    if (_hosts.side) closeCard(_hosts.side);
    const self = { kind: "device", name: d.name, role, line: d.line };
    tags[String(from)] = { moving: true };
    pick(targets, gpio => {
        const swapped = applyMove(self, from, gpio, swaps);
        if (swapped === false) return;
        done(_hosts.board, `${d.name} ${role} → GPIO ${gpio}${swapped}`, editor().getModel().getLineContent(d.line), d.line, () => deviceCard(_hosts.board, d.line));
    }, [String(from)], !targets.length ? "No free pin for this."
        : `New pin for <b>${esc(d.name)} ${esc(role.toUpperCase())}</b> <span class="hwp-muted">(now GPIO ${esc(from)})</span>` + riskyNote(risky),
        tags, g => describe(g, who));
}

// Rename a declaration on `line` plus every use — one undo step.
async function renameDecl(line, oldName, newName) {
    const ed = editor();
    const text = ed.getModel().getLineContent(line);
    const m = text.match(/^(\s*(?:pin|bus|device|i2c|spi|uart)\s+)(\w+)/);
    if (!m || m[2] !== oldName) return 0;
    const edits = [{ range: { startLine: line, startCol: m[1].length + 1, endLine: line, endCol: m[0].length + 1 }, text: newName }];
    for (const r of (await symbolFor({ name: oldName, line })).refs) {
        if (r.line === line) continue;
        edits.push({ range: { startLine: r.line, startCol: r.col, endLine: r.line, endCol: r.col + oldName.length }, text: newName });
    }
    applyEdits(edits, { flash: _view === "code" });
    return edits.length - 1;
}

function infoCard(h, pin) {
    select(h, [], 0);
    let body = "";
    if (pin.type) body += `<div class="pp-type pp-type-${esc(pin.type)}">${esc(pin.type)}</div>`;
    if (pin.note) body += `<div class="pp-note">${esc(pin.note)}</div>`;
    if (pin.alt && pin.alt.length) body += `<div class="hwp-muted">Also: ${esc(pin.alt.join(", "))}</div>`;
    if (!body) body = `<div class="hwp-muted">Not a GPIO — nothing to assign here.</div>`;
    showCard(h, head(pin.label, "") + `<div class="pp-body">${body}</div>`);
}

// ---- bus wizard (Board tab) ----

const BUS_DOC = {
    i2c: "Two wires, many devices by address — sensors, displays, port expanders.",
    spi: "Fast, one chip-select per device — SD cards, TFT screens, radios.",
    uart: "Serial link to one module — GPS, GSM / LTE, another board.",
};
const BAUDS = ["9600", "19200", "38400", "57600", "115200"];

function nextBusName(type) {
    const names = new Set([..._hw.pins, ..._hw.buses, ..._hw.devices].map(x => x.name));
    for (let i = type === "uart" ? 1 : 0; ; i++) if (!names.has(type + i)) return type + i;
}

// New bus, or edit `existing` (a bus from the extract). Lives on the Board
// tab: each signal is a slot; click one, then a lit pin.
async function busWizard(existing) {
    if (_view !== "board") showView("board");
    if (_hosts.side) closeCard(_hosts.side);
    const h = _hosts.board;
    const [table, native] = await Promise.all([pinTable(), busPins()]);
    const line = existing ? existing.line : 0;
    let type = existing ? existing.busType.toLowerCase() : "i2c";
    let nameEdited = !!existing;
    let slots = {};             // role -> gpio (string, "" = not picked)
    let active = null;          // role being picked
    const writeAs = {};         // role -> spelling in the source (clk may be "sck")
    const extra = {};           // params kept as written (speed, baud, cs, …)

    const sigs = () => BUS_SIGNALS[type];
    const info = g => table.find(i => String(i.gpio) === String(g));
    const nativePin = role => native[type] && native[type][role] != null ? String(native[type][role]) : "";
    const takenElse = role => {
        const t = takenGpios(_hw, line);
        for (const [r, g] of Object.entries(slots)) if (r !== role && g) t.add(g);
        return t;
    };
    const candidates = role => {
        const sig = sigs().find(x => x.role === role);
        return pickable(table, sig.out ? "Output" : "Input", takenElse(role)).targets;
    };
    const suggest = () => {
        slots = {};
        for (const sig of sigs()) {
            const n = nativePin(sig.role), c = candidates(sig.role);
            slots[sig.role] = n && c.includes(n) ? n : (c[0] || "");
        }
    };
    if (existing) {
        const roles = { ...existing.roles };
        if (roles.sck != null && roles.clk == null) { roles.clk = roles.sck; delete roles.sck; writeAs.clk = "sck"; }
        for (const sig of sigs()) slots[sig.role] = roles[sig.role] != null ? String(roles[sig.role]) : "";
        for (const [r, g] of Object.entries(roles)) if (!sigs().some(x => x.role === r)) extra[r] = g;
        Object.assign(extra, existing.params || {});
    } else suggest();

    const card = showCard(h, head(existing ? existing.name : "New bus", existing ? existing.busType + " bus" : "") + `<div class="pp-body">
        ${existing ? "" : `<div class="pp-section-title">Type</div>
            <div class="hwp-modes hwp-types">${Object.keys(BUS_SIGNALS).map(t =>
                `<button class="hwp-chip${t === type ? " is-active" : ""}" data-type="${t}">${t.toUpperCase()}</button>`).join("")}</div>
            <div class="hwp-muted hwp-typedoc"></div>`}
        <label class="pp-section-title" for="hwpBusName">Name</label>
        <input class="hwp-name" id="hwpBusName" value="${esc(existing ? existing.name : nextBusName(type))}" spellcheck="false">
        <div class="hwp-err"></div>
        <div class="pp-section-title">Pins</div>
        <div class="hwp-slots"></div>
        <div class="hwp-muted">Click a pin above, then a lit pin on the board.</div>
        <div class="hwp-baud" style="display:none"><label class="pp-section-title" for="hwpBaud">Baud</label>
            <select id="hwpBaud" class="hwp-board"></select></div>
        <div class="hwp-preview"></div>
        <div class="hwp-actions">
            <button class="pp-btn pp-btn-primary" data-act="ok">${existing ? "Save" : "Add bus"}</button>
        </div>
    </div>`);

    const nameIn = card.querySelector(".hwp-name");
    const err = card.querySelector(".hwp-err");
    const slotsEl = card.querySelector(".hwp-slots");
    const baudRow = card.querySelector(".hwp-baud");
    const baud = card.querySelector("#hwpBaud");
    const preview = card.querySelector(".hwp-preview");

    const text = () => {
        const parts = sigs().map(x => `${writeAs[x.role] || x.role}: ${slots[x.role] || "?"}`);
        const more = { ...extra };
        if (type === "uart") more.baud = baud.value;
        for (const [k, v] of Object.entries(more)) parts.push(`${k}: ${v}`);
        const t = (existing ? existing.busType : type).toLowerCase();
        return `${t} ${nameIn.value.trim() || "…"}(${parts.join(", ")})`;
    };
    const renderSlots = () => {
        slotsEl.innerHTML = sigs().map(x => {
            const g = slots[x.role], i = g && info(g);
            const isNative = g && g === nativePin(x.role);
            const warn = i && i.safety !== "safe" && !isNative;
            const note = !g ? "pick a pin" : isNative ? "native" : warn ? tagFor(i) : "";
            return `<button class="hwp-slot${active === x.role ? " is-active" : ""}${g ? "" : " is-empty"}" data-role="${x.role}">
                <b>${x.role.toUpperCase()}</b><span>${g ? "GPIO " + g : "—"}</span><em class="${warn ? "is-warn" : ""}">${esc(note)}</em></button>`;
        }).join("");
        slotsEl.querySelectorAll(".hwp-slot").forEach(b => b.onclick = () => activate(b.dataset.role));
        if (!_pick) pinout.setHighlight(Object.values(slots).filter(Boolean));
        preview.innerHTML = (existing ? "Writes " : "Adds ") + codeLine(text());
    };
    const renderType = () => {
        const doc = card.querySelector(".hwp-typedoc");
        if (doc) doc.textContent = BUS_DOC[type];
        baudRow.style.display = type === "uart" ? "" : "none";
        if (type === "uart") {
            const cur = String(extra.baud || baud.value || "9600");
            delete extra.baud;
            baud.innerHTML = [...new Set([...BAUDS, cur])].map(b => `<option${b === cur ? " selected" : ""}>${b}</option>`).join("");
        }
        renderSlots();
    };
    const activate = (role) => {
        active = role;
        const targets = candidates(role);
        const next = sigs()[sigs().findIndex(x => x.role === role) + 1];
        pick(targets, gpio => {
            slots[role] = gpio;
            if (next) activate(next.role);
            else endPick();
        }, Object.values(slots).filter(Boolean), targets.length
            ? `Pick <b>${role.toUpperCase()}</b> for ${esc(nameIn.value.trim() || "the bus")} — click a lit pin`
            : `No free pin can be ${role.toUpperCase()}.`);
        _pick.onEnd = () => { active = null; renderSlots(); };
        renderSlots();
    };

    card.querySelectorAll(".hwp-types .hwp-chip").forEach(c => c.onclick = () => {
        endPick();
        type = c.dataset.type;
        card.querySelectorAll(".hwp-types .hwp-chip").forEach(x => x.classList.toggle("is-active", x === c));
        if (!nameEdited) nameIn.value = nextBusName(type);
        suggest();
        renderType();
    });
    nameIn.oninput = () => { nameEdited = true; err.textContent = ""; nameIn.classList.remove("is-bad"); renderSlots(); };
    baud.onchange = renderSlots;

    const submit = async () => {
        const n = nameIn.value.trim();
        const bad = (!existing || n !== existing.name) && nameProblem(n, existing && existing.name);
        const missing = sigs().find(x => !slots[x.role]);
        if (bad || missing) {
            err.textContent = bad || `Pick a pin for ${missing.role.toUpperCase()}.`;
            if (bad) { nameIn.classList.add("is-bad"); nameIn.focus(); }
            return;
        }
        endPick();
        const t = text();
        if (!existing) {
            const at = insertDecl(t, { flash: false });
            done(h, "Added bus", t, at, () => busCardFor(h, at));
            return;
        }
        const ed = editor();
        const cur = ed.getModel().getLineContent(line);
        const indent = cur.match(/^\s*/)[0], comment = cur.match(/\s+\/\/.*$/);
        const edits = [{ range: { startLine: line, startCol: 1, endLine: line, endCol: cur.length + 1 },
            text: indent + t + (comment ? comment[0] : "") }];
        if (n !== existing.name) {
            for (const r of (await symbolFor(existing)).refs) {
                if (r.line === line) continue;
                edits.push({ range: { startLine: r.line, startCol: r.col, endLine: r.line, endCol: r.col + existing.name.length }, text: n });
            }
        }
        applyEdits(edits, { flash: false });
        done(h, n !== existing.name && edits.length > 1 ? `Saved bus + ${edits.length - 1} use${edits.length > 2 ? "s" : ""}` : "Saved bus",
            t, line, () => busCardFor(h, line));
    };
    card.querySelector("[data-act='ok']").onclick = submit;
    nameIn.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
    renderType();
}

function busCardFor(h, line) {
    if (_hw.buses.some(b => b.line === line)) itemCard(h, "bus", line);
    else emptyCard(h);
}

// ---- move (Board tab) ----

// Pins to light when moving something: free ones that can do `mode`,
// without the "avoid" pins (USB serial, boot straps) unless nothing
// better is free.
function pickable(table, mode, taken, except) {
    const free = rankFreePins(table, mode, taken).filter(i => String(i.gpio) !== String(except));
    const good = free.filter(i => i.safety !== "risky");
    return { targets: (good.length ? good : free).map(i => String(i.gpio)), risky: !good.length && free.length > 0 };
}
const riskyNote = risky => risky ? ` <span class="hwp-warn-inline">· only risky pins are free</span>` : "";

async function startPick(p) {
    const { targets, tags, swaps, risky, describe } = await moveOptions(p.mode || "Output", p.gpio, p.line, undefined);
    if (_view !== "board") showView("board");
    if (_hosts.side) closeCard(_hosts.side);
    const self = { kind: "pin", name: p.name, line: p.line };
    tags[String(p.gpio)] = { moving: true };
    pick(targets, gpio => {
        const swapped = applyMove(self, p.gpio, gpio, swaps);
        if (swapped === false) return;
        done(_hosts.board, `Moved to GPIO ${gpio}${swapped}`, editor().getModel().getLineContent(p.line), p.line, () => editCardFor(_hosts.board, p.line));
    }, [p.gpio], targets.length
        ? `New pin for <b>${esc(p.name)}</b> <span class="hwp-muted">(now GPIO ${esc(p.gpio)})</span>` + riskyNote(risky)
        : `No free pin can do ${esc(p.mode || "Output")}.`, tags, g => describe(g, p.name));
}

// Board pick mode: light `targets`, call onPick(gpio) when one is clicked.
function pick(targets, onPick, highlight, message, tags, describe) {
    _pick = { targets, onPick, describe, from: [].concat(highlight || []).map(String) };
    pinout.setTargets(targets, tags);
    pinout.setHighlight(highlight);
    // The instruction sits at the top of the Board card, not over the board.
    const card = _hosts.board.card;
    card.querySelector(".hwp-move")?.remove();
    card.style.display = "";
    const bar = document.createElement("div");
    bar.className = "hwp-move";
    const swaps = tags && Object.values(tags).some(t => t.swap);
    bar.innerHTML = `<div class="hwp-move-main"><span>${message}</span>
        <button class="hwp-link" data-act="cancel">${targets.length ? "Cancel" : "OK"}</button></div>
        ${targets.length ? `<div class="hwp-move-legend"><span><i class="is-free"></i>free</span>${swaps ? `<span><i class="is-swap"></i>swap</span>` : ""}<span class="hwp-muted">Esc cancels</span></div>` : ""}`;
    card.prepend(bar);
    bar.querySelector("[data-act='cancel']").onclick = endPick;
}

function endPick() {
    if (!_pick) return;
    const p = _pick;
    _pick = null;
    pinout.setTargets(null);
    if (p.onEnd) p.onEnd();
    _hosts.board.card.querySelector(".hwp-move")?.remove();
}

// How well a free pin suits a signal — lower score is better. `short`
// is the board label hint, `long` the reasons for the hover.
function pinFit(i, mode, own, siblings) {
    const caps = new Set(i.caps);
    const long = [], hints = [];
    let score = { safe: 0, caution: 20, risky: 100 }[i.safety] ?? 50;
    if (i.safety !== "safe") { hints.push(i.reason); long.push(`${i.reason}${i.notes[0] ? " — " + i.notes[0] : ""}`); }
    if (own != null && String(own) === String(i.gpio)) { score -= 30; long.unshift("The usual pin for this signal on this chip"); }
    const inputOnly = !caps.has("output");
    if (mode === "Input" && inputOnly) { score -= 4; long.push("input-only — keeps output pins free"); }
    if (mode === "Analog") {
        if (caps.has("adc2")) { score += 15; hints.push("ADC2"); long.push("ADC2 — can't read while WiFi is on"); }
        else long.push("ADC1 — works with WiFi");
    } else {
        // A plain digital signal shouldn't use up a special pin.
        if (caps.has("dac") && mode !== "DAC") { score += 6; hints.push("DAC"); long.push("one of the two DAC pins — keep it for analog out"); }
        if (caps.has("touch") && mode !== "Touch") { score += 2; long.push("touch-capable"); }
        if (caps.has("analog") && !caps.has("adc2") && !inputOnly) { score += 3; long.push("ADC1 pin — keep it for analog sensors"); }
    }
    const here = pinout.boardPinInfo(i.gpio);
    if (here && siblings.length) {
        const near = siblings.map(g => pinout.boardPinInfo(g)).filter(b => b && b.header === here.header)
            .map(b => Math.abs(b.index - here.index)).sort((a, b) => a - b)[0];
        if (near != null && near <= 2) { score -= 3 - near; long.push(near === 1 ? "right next to the part's other pin" : "close to the part's other pin"); }
    }
    return { score, risky: i.safety === "risky", short: hints[0] || "", long };
}

// Where something being moved can go. Free pins that can do `mode` (best
// first, "avoid" pins only when nothing better is free), plus taken pins
// it can trade places with: a pin or another device pin whose own mode
// works on `from`. Returns { targets, tags, swaps: {gpio: owner}, risky }.
async function moveOptions(mode, from, selfLine, selfRole) {
    const [table, native] = await Promise.all([pinTable(), busPins()]);
    const info = g => table.find(i => String(i.gpio) === String(g));
    const taken = takenGpios(_hw);
    // The chip's own pin for this signal (UART tx / rx …), and the other
    // pins of the same part: a good spot is next to them on the header.
    const own = Object.values(native || {}).map(sigs => sigs && sigs[selfRole]).find(g => g != null);
    const siblings = Object.values(_hw.pinByGpio).filter(a => a.line === selfLine && a.gpio !== String(from)).map(a => a.gpio);
    const fits = rankFreePins(table, mode, taken).filter(i => String(i.gpio) !== String(from))
        .map(i => ({ g: String(i.gpio), ...pinFit(i, mode, own, siblings) }))
        .sort((a, b) => a.score - b.score || a.g - b.g);
    const good = fits.filter(f => !f.risky);
    const risky = !good.length && fits.length > 0;
    const shown = good.length ? good : fits;
    const targets = shown.map(f => f.g);
    const best = risky ? null : shown[0];
    const why = Object.fromEntries(shown.map(f => [f.g, f]));
    const tags = {};
    // Board labels stay plain; the reasons are in the hover.
    for (const f of shown) tags[f.g] = { text: f === best ? "★ best" : "free" };
    const swaps = {};
    const fromInfo = info(from);
    for (const [g, a] of Object.entries(_hw.pinByGpio)) {
        if (g === String(from) || a.kind === "bus" || (a.line === selfLine && a.role === selfRole)) continue;
        const mine = info(g);
        if (!mine || mine.safety === "risky" || !supportsMode(mine, mode)) continue;
        let theirs;
        if (a.kind === "device") {
            const e = partForType(a.deviceType);
            theirs = a.role === "rx" || (e && e.inputs && e.inputs.has(a.role)) ? "Input" : "Output";
        } else theirs = (_hw.pins.find(p => p.line === a.line) || {}).mode || "Output";
        if (!a.role && a.kind === "device") continue;    // legacy anchor, nothing to rewrite
        if (!fromInfo || !supportsMode(fromInfo, theirs)) continue;
        swaps[g] = a;
        tags[g] = { swap: true };
    }
    // Hover text while picking: what clicking does, or why a pin is out.
    const describe = (g, who) => {
        const i = info(g);
        if (String(g) === String(from)) return [`${who} is here`, "Click to cancel"];
        if (swaps[g]) {
            const o = swaps[g], them = `${o.name}${o.role ? " " + o.role : ""}`;
            return [`Swap with ${them}`, `${who} → GPIO ${g}, ${them} → GPIO ${from}`];
        }
        if (why[g]) return [`Move ${who} to GPIO ${g}${why[g] === best ? "  ★ best fit" : ""}`, why[g].long.map(r => "• " + r).join("\n") || "Free"];
        const a = _hw.pinByGpio[g];
        if (a) return [`GPIO ${g}`, a.kind === "bus" ? `Used by the ${a.name} bus (${(a.role || "").toUpperCase()}) — can't swap` : `Used by ${a.name}${a.role ? " " + a.role : ""} — can't swap (wrong direction)`];
        if (i && !supportsMode(i, mode)) return [`GPIO ${g}`, mode === "Output" ? "Input-only — can't drive a signal" : `Can't do ${mode}`];
        if (i && i.safety === "risky") return [`GPIO ${g}`, `Avoid — ${i.reason}${i.notes?.[0] ? ": " + i.notes[0] : ""}`];
        return [`GPIO ${g}`, "Not available"];
    };
    return { targets: [...targets, ...Object.keys(swaps)], tags, swaps, risky, describe };
}

// Edit for putting `gpio` into the declaration that owns `a` (a pin, or
// one role of a device).
function gpioEdit(a, gpio) {
    const text = editor().getModel().getLineContent(a.line);
    const m = a.kind === "device"
        ? text.match(new RegExp(`^(.*\\b${a.role}\\s*:\\s*)(\\d+)`)) || (a.role === "cs" ? text.match(/^(.*\bat\s+)(\d+)/) : null)
        : text.match(/^(\s*pin\s+\w+\s*(?::\s*\w+)?\s*=\s*)(\d+)/);
    return m && { range: { startLine: a.line, startCol: m[1].length + 1, endLine: a.line, endCol: m[0].length + 1 }, text: String(gpio) };
}

// Move `self` (a pinByGpio-shaped owner) from `from` to `gpio`, trading
// places when another part is there. One undo step.
function applyMove(self, from, gpio, swaps) {
    endPick();
    const other = swaps[gpio];
    const edits = [gpioEdit(self, gpio), other && gpioEdit(other, from)].filter(Boolean);
    if (!edits.length) return false;
    applyEdits(edits, { flash: _view === "code" });
    return other ? ` ⇄ ${other.name}${other.role ? " " + other.role : ""}` : "";
}

function movePin(p, gpio) {
    endPick();
    const ed = editor();
    if (!ed) return;
    const text = ed.getModel().getLineContent(p.line);
    const m = text.match(/^(\s*pin\s+\w+\s*(?::\s*\w+)?\s*=\s*)(\d+)/);
    if (!m) return;
    applyEdits([{ range: { startLine: p.line, startCol: m[1].length + 1, endLine: p.line, endCol: m[0].length + 1 }, text: gpio }],
        { flash: _view === "code" });
    done(_hosts.board, `Moved to GPIO ${gpio}`, ed.getModel().getLineContent(p.line), p.line, () => editCardFor(_hosts.board, p.line));
}

// ---- after an edit ----

// Toast with the exact line written + Undo / Show in code; then let the
// views catch up with the new source and run `then`.
let _toastTimer = null;
function done(h, what, text, line, then, note) {
    setTimeout(() => { refresh(); then && then(); }, 0);
    const t = h.toast;
    t.innerHTML = `<span class="hwp-toast-what">${esc(what)}</span>${codeLine(text)}${note ? `<span class="hwp-toast-note">⚠ ${esc(note)}</span>` : ""}
        <button class="hwp-link" data-act="undo">Undo</button>
        ${line ? `<button class="hwp-link" data-act="show">Show in code</button>` : ""}`;
    t.style.display = "";
    t.querySelector("[data-act='undo']").onclick = () => {
        editor()?.trigger("hardware", "undo");
        t.style.display = "none";
        setTimeout(() => { refresh(); h.name === "board" ? emptyCard(h) : closeCard(h); }, 0);
    };
    const show = t.querySelector("[data-act='show']");
    if (show) show.onclick = () => { t.style.display = "none"; jumpTo(line); };
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.style.display = "none"; }, 6000);
}

function jumpTo(line) {
    const ed = editor();
    if (!ed || !line) return;
    if (_view !== "code") showView("code");
    setTimeout(() => {
        ed.setPosition({ lineNumber: line, column: 1 });
        flashLine(line);
        ed.focus();
    }, 50);
}

function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
