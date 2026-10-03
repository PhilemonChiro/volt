// Hardware — the Board tab (wide board + pin card + list) and the Hardware
// side panel (list + docked card). The code stays the source of truth:
// every action is a single undoable edit to the hardware block
// (hardware-edit.js), the views redraw from the edited source, and a toast
// shows the exact line written with Undo / Show in code.
//
//   free pin   → "Use GPIO N as…" (name + mode chips limited to what the pin
//                can do; caution / risky pins say why and offer a safer one)
//   used pin   → rename (every use) / change mode / move to another pin /
//                free it / the compiler's quick fixes
//   bus/device → info + show in code (bus wizard / devices come later)

import * as pinout from "./pinout-panel.js";
import * as chipSelector from "./chip-selector.js";
import { MODES, chip, pinTable, supportsMode, takenGpios, rankFreePins, tagFor } from "./pin-facts.js";
import { applyEdits, insertDecl, deleteDecl, fixToEdit, flashLine } from "./hardware-edit.js";

// Two hosts share the list + card code: { name, el, list, card, toast }
const _hosts = {};
let _hw = { pins: [], buses: [], devices: [], pinByGpio: {} };
let _pick = null;          // { pin, targets } while moving a pin (Board tab)
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

// ---- setup ----

// The Board tab. Called once when the editor first opens, so the board is
// loaded for the editor's pin hovers even before the tab is shown.
export function initBoard(el) {
    if (_hosts.board) return;
    el.innerHTML = `
        <div class="bv-bar">
            <select class="hwp-board" title="Which dev board you're wiring"></select>
            <div class="bv-legend">
                <span class="role-out"><i></i>Output</span><span class="role-pwm"><i></i>PWM</span>
                <span class="role-in"><i></i>Input</span><span class="role-adc"><i></i>Analog</span>
                <span class="role-bus"><i></i>Bus</span><span class="role-dev"><i></i>Device</span>
                <span class="bv-legend-free" title="Free pins: amber ring = works with care, dashed red = avoid unless you know why">
                    <i class="ring caution"></i>care <i class="ring risky"></i>avoid</span>
            </div>
            <span class="bv-stats"></span>
        </div>
        <div class="bv-body">
            <div class="bv-canvas"></div>
            <div class="bv-side">
                <div class="hwp-card"></div>
                <div class="hwp-list"></div>
            </div>
            <div class="hwp-banner" style="display:none"></div>
            <div class="hwp-toast" style="display:none"></div>
        </div>`;
    _hosts.board = host("board", el);
    pinout.init(el.querySelector(".bv-canvas"));
    pinout.onPinClick(onBoardClick);
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
    _hw = pinout.extractHardware(src);
    const c = chip();
    if (_hosts.board) {
        pinout.render(c, Object.values(_hw.pinByGpio), _hw);
        renderBoardPicker(c);
        pinTable().then(t => {
            pinout.setSafety(Object.fromEntries(t.map(i => [String(i.gpio), i.safety])));
            renderStats(t);
        });
    }
    for (const h of Object.values(_hosts)) renderList(h);
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
    _hosts.board.el.querySelector(".bv-stats").textContent =
        `${_hw.pins.length} pins used · ${free.length} free (${safe} safe)`;
}

// ---- list ----

function renderList(h) {
    const el = h.list;
    const { pins, buses, devices } = _hw;
    const addBtn = `<button class="hwl-add" title="Add a pin on the safest free GPIO">+ Add pin</button>`;
    let html;
    if (!pins.length && !buses.length && !devices.length) {
        html = `<div class="panel-empty">
            <div class="empty-title">No hardware yet</div>
            <div class="empty-hint">${h.name === "board" ? "Click a free pin on the board" : "Open the Board tab and click a free pin"}, or add one here.</div>
            ${addBtn}
        </div>`;
    } else {
        html = `<div class="hw-section"><div class="hw-section-title hwl-title">Pins ${addBtn}</div>`;
        for (const p of pins)
            html += row(p, "pin", [p.gpio], p.name, pinout.labelFor(p).split(" · ")[1], "GPIO " + p.gpio, pinout.pinDiagnostics(p.gpio));
        html += "</div>";
        if (buses.length) {
            html += `<div class="hw-section"><div class="hw-section-title">Buses</div>`;
            for (const b of buses) html += row(b, "bus", Object.values(b.roles), b.name, b.busType,
                Object.entries(b.roles).map(([r, g]) => r + " " + g).join(" · "), []);
            html += "</div>";
        }
        if (devices.length) {
            html += `<div class="hw-section"><div class="hw-section-title">Devices</div>`;
            for (const d of devices) {
                const own = Object.entries(d.roles || {});
                const where = own.length ? own.map(([r, g]) => r + " " + g).join(" · ")
                    : [d.bus && "on " + d.bus, d.address].filter(Boolean).join(" · ");
                html += row(d, "device", deviceGpios(d), d.name, d.type, where, []);
            }
            html += "</div>";
        }
    }
    el.innerHTML = html;
    if (h.selLine) el.querySelector(`.hwl-row[data-line="${h.selLine}"]`)?.classList.add("is-selected");

    el.querySelector(".hwl-add").onclick = () => addFromList(h);
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
            pinout.setHighlight(gpios);
            document.dispatchEvent(new CustomEvent("pinout:hover", { detail: { line } }));
        };
        r.onpointerleave = () => {
            pinout.setHighlight(h.selGpios);
            document.dispatchEvent(new CustomEvent("pinout:hover", { detail: { line: 0 } }));
        };
    });
}

function row(item, kind, gpios, name, tag, detail, warn) {
    const role = kind === "bus" ? "bus" : kind === "device" ? "dev" : pinout.roleOf(item);
    return `<div class="hw-item hwl-row role-${role}" data-kind="${kind}" data-line="${item.line}" data-gpios="${esc(gpios.join(","))}">
        <i class="hwl-dot"></i>
        <span class="hw-name">${esc(name)}</span>
        <span class="hwl-tag">${esc(tag || "")}</span>
        <span class="hw-detail">${esc(detail)}</span>
        ${warn.length ? `<span class="hwl-warn" title="${esc(warn.join("\n"))}">⚠</span>` : ""}
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

async function addFromList(h) {
    const best = rankFreePins(await pinTable(), "Output", takenGpios(_hw))[0];
    if (best) addCard(h, String(best.gpio));
}

// ---- board clicks ----

function onBoardClick(gpio, boardPin, assigned) {
    const h = _hosts.board;
    if (_pick) {
        if (_pick.targets.includes(gpio)) movePin(_pick.pin, gpio);
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
    select(h, [], 0);
    h.card.classList.add("is-empty");
    h.card.innerHTML = `<div class="hwp-hint">
        <b>Click a free pin</b> to use it, or a used pin to change it.
        <span>Every change is one edit to your hardware block — Ctrl+Z undoes it.</span>
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

// Free pin → "Use GPIO N as…"
async function addCard(h, gpio, opts = {}) {
    const table = await pinTable();
    const info = table.find(i => String(i.gpio) === String(gpio));
    const where = pinout.boardPinInfo(gpio);
    if (!info) return infoCard(h, where || { label: "GPIO " + gpio, gpio, alt: [] });
    select(h, [gpio], 0);
    const sub = whereText(gpio);

    if (info.safety === "unavailable") {
        showCard(h, head("GPIO " + gpio, sub) + `<div class="pp-body">
            <div class="pp-note pp-warn">Not usable: ${esc(info.reason)}</div>
            ${info.notes.map(n => `<div class="pp-note">${esc(n)}</div>`).join("")}
        </div>`);
        return;
    }

    const modes = MODES.filter(m => supportsMode(info, m.mode)).map(m => m.mode);
    let mode = modes.includes(opts.mode) ? opts.mode : modes[0];
    const defName = uniqueName("gpio" + gpio);
    const caution = info.safety !== "safe";
    const card = showCard(h, head("GPIO " + gpio, sub) + `<div class="pp-body">
        ${caution ? `<div class="pp-note pp-warn">⚠ ${esc(info.reason)}${info.notes.length ? " — " + esc(info.notes.join(" ")) : ""}
            <button class="hwp-link" data-act="safer">Pick a safer pin</button></div>` : `<div class="hwp-ok">✓ Free and safe to wire</div>`}
        <label class="pp-section-title" for="hwpName-${h.name}">Name</label>
        <input class="hwp-name" id="hwpName-${h.name}" value="${esc(opts.name || defName)}" spellcheck="false">
        <div class="hwp-err"></div>
        <div class="pp-section-title">Use as</div>
        ${modeChips(modes, mode)}
        <div class="hwp-preview"></div>
        <div class="hwp-actions">
            <button class="pp-btn pp-btn-primary" data-act="add">Add pin</button>
            ${h.name === "side" ? `<button class="hwp-link" data-act="board">Choose on the board</button>` : ""}
        </div>
        ${altLine(gpio)}
    </div>`);

    const input = card.querySelector(".hwp-name");
    const err = card.querySelector(".hwp-err");
    const preview = card.querySelector(".hwp-preview");
    const text = () => `pin ${input.value.trim() || "…"}: ${mode} = ${gpio}`;
    const update = () => { preview.innerHTML = "Adds " + codeLine(text()); };
    update();
    input.focus();
    input.select();
    input.oninput = () => { err.textContent = ""; input.classList.remove("is-bad"); update(); };
    card.querySelectorAll(".hwp-chip").forEach(c => c.onclick = () => {
        mode = c.dataset.mode;
        card.querySelectorAll(".hwp-chip").forEach(x => x.classList.toggle("is-active", x === c));
        update();
    });
    const add = () => {
        const n = input.value.trim();
        const bad = nameProblem(n);
        if (bad) { err.textContent = bad; input.classList.add("is-bad"); input.focus(); return; }
        const t = `pin ${n}: ${mode} = ${gpio}`;
        const line = insertDecl(t, { flash: _view === "code" });
        done(h, "Added", t, line, () => editCardFor(h, line));
    };
    card.querySelector("[data-act='add']").onclick = add;
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } };

    const safer = card.querySelector("[data-act='safer']");
    if (safer) {
        // The best free pin rated above this one (safe over caution over risky).
        const rank = { safe: 0, caution: 1, risky: 2 };
        const saferPin = () => rankFreePins(table, mode, takenGpios(_hw)).find(i => rank[i.safety] < rank[info.safety]);
        if (!saferPin()) safer.remove();
        else safer.onclick = () => {
            const best = saferPin();
            if (!best) return;
            const typed = input.value.trim();
            addCard(h, String(best.gpio), { name: typed && typed !== defName ? typed : undefined, mode });
        };
    }
    const toBoard = card.querySelector("[data-act='board']");
    if (toBoard) toBoard.onclick = () => { closeCard(h); showView("board"); };
}

// Re-open the edit card for whatever pin now sits on `line` (after an edit).
function editCardFor(h, line) {
    const p = _hw.pins.find(x => x.line === line);
    if (p) editCard(h, p);
    else if (h.name === "board") emptyCard(h);
    else closeCard(h);
}

// Used pin → rename / change mode / move / free / quick fixes.
async function editCard(h, p) {
    const table = await pinTable();
    const info = table.find(i => String(i.gpio) === String(p.gpio));
    const current = p.mode || "Output";
    const modes = MODES.map(m => m.mode).filter(m => m === current || !info || supportsMode(info, m));
    let mode = current;
    select(h, [p.gpio], p.line);

    const warns = pinout.pinDiagnostics(p.gpio);
    const seen = new Set();
    const fixes = pinout.pinFixes(p.gpio).filter(f => f.title && !seen.has(f.title) && seen.add(f.title)).slice(0, 3);
    const lineText = editor()?.getModel().getLineContent(p.line) || "";
    const card = showCard(h, head(p.name, `GPIO ${p.gpio} · ${whereText(p.gpio)}`) + `<div class="pp-body">
        <button class="hwp-codebtn" data-act="jump" title="Show in code">${codeLine(lineText)}<span>line ${p.line} ↗</span></button>
        ${warns.length ? `<div class="pp-note pp-warn">${warns.map(w => "⚠ " + esc(w)).join("<br>")}
            ${fixes.length ? `<div class="hwp-actions">${fixes.map((f, i) =>
                `<button class="pp-btn pp-btn-ghost" data-fix="${i}">${esc(f.title)}</button>`).join("")}</div>` : ""}</div>`
            : info && info.safety !== "safe" ? `<div class="hwp-muted">⚠ ${esc(tagFor(info))}</div>` : ""}
        <label class="pp-section-title" for="hwpName-${h.name}">Name</label>
        <input class="hwp-name" id="hwpName-${h.name}" value="${esc(p.name)}" spellcheck="false">
        <div class="hwp-err"></div>
        <div class="pp-section-title">Use as</div>
        ${modeChips(modes, mode)}
        <div class="hwp-actions">
            <button class="pp-btn pp-btn-primary" data-act="save" disabled>Save</button>
            <button class="pp-btn pp-btn-ghost" data-act="move">Move to another pin</button>
            <button class="pp-btn pp-btn-ghost pp-btn-danger" data-act="free">Free pin</button>
        </div>
    </div>`);

    const input = card.querySelector(".hwp-name");
    const err = card.querySelector(".hwp-err");
    const save = card.querySelector("[data-act='save']");
    const dirty = () => { save.disabled = input.value.trim() === p.name && mode === current; };
    input.oninput = () => { err.textContent = ""; input.classList.remove("is-bad"); dirty(); };
    card.querySelectorAll(".hwp-chip").forEach(c => c.onclick = () => {
        mode = c.dataset.mode;
        card.querySelectorAll(".hwp-chip").forEach(x => x.classList.toggle("is-active", x === c));
        dirty();
    });
    const doSave = async () => {
        if (save.disabled) return;
        const n = input.value.trim();
        const bad = n !== p.name && nameProblem(n, p.name);
        if (bad) { err.textContent = bad; input.classList.add("is-bad"); input.focus(); return; }
        const uses = await savePin(p, n, mode);
        done(h, n !== p.name ? `Renamed${uses ? ` + ${uses} use${uses > 1 ? "s" : ""}` : ""}` : "Changed",
            editor().getModel().getLineContent(p.line), p.line, () => editCardFor(h, p.line));
    };
    save.onclick = doSave;
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } };
    card.querySelectorAll("[data-fix]").forEach(b => b.onclick = () => {
        const f = fixes[Number(b.dataset.fix)];
        applyEdits([fixToEdit(f)], { flash: _view === "code" });
        done(h, f.title, editor().getModel().getLineContent(f.line), f.line, () => editCardFor(h, p.line));
    });
    card.querySelector("[data-act='move']").onclick = () => startPick(p);
    card.querySelector("[data-act='jump']").onclick = () => jumpTo(p.line);

    const free = card.querySelector("[data-act='free']");
    const doFree = () => {
        deleteDecl(p.line);
        done(h, "Freed GPIO " + p.gpio, lineText, 0, () => h.name === "board" ? emptyCard(h) : closeCard(h));
    };
    free.onclick = async () => {
        if (free.dataset.confirm) return doFree();
        const uses = (await symbolFor(p)).refs.filter(r => r.line !== p.line).length;
        if (!uses) return doFree();
        free.dataset.confirm = "1";
        free.textContent = `Used in ${uses} place${uses > 1 ? "s" : ""} — free anyway`;
    };
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

function itemCard(h, kind, line, boardPin) {
    const item = kind === "bus" ? _hw.buses.find(b => b.line === line) : _hw.devices.find(d => d.line === line);
    if (!item) return;
    const gpios = kind === "bus" ? Object.values(item.roles).map(String) : deviceGpios(item);
    select(h, gpios, line);
    let body = `<button class="hwp-codebtn" data-act="jump" title="Show in code">${codeLine(editor()?.getModel().getLineContent(line) || "")}<span>line ${line} ↗</span></button>`;
    const roles = item.roles || {};
    if (Object.keys(roles).length) body += `<div class="hwp-roles">${Object.entries(roles).map(([r, g]) =>
        `<span><b>${esc(r.toUpperCase())}</b> GPIO ${g}<em>${esc(whereText(g))}</em></span>`).join("")}</div>`;
    if (kind === "bus") {
        const riders = _hw.devices.filter(d => d.bus === item.name);
        body += riders.length
            ? `<div class="pp-section"><div class="pp-section-title">Devices on ${esc(item.name)}</div>
                <ul class="pp-alts">${riders.map(d => `<li>${esc(d.name)} <span style="color:var(--t3)">${esc(d.type)} @ ${esc(d.address)}</span></li>`).join("")}</ul></div>`
            : `<div class="hwp-muted">No devices on this bus yet.</div>`;
    }
    for (const g of gpios) for (const w of pinout.pinDiagnostics(g)) body += `<div class="pp-note pp-warn">⚠ ${esc(w)}</div>`;
    if (boardPin && boardPin.alt && boardPin.alt.length) body += `<div class="hwp-muted">Also: ${esc(boardPin.alt.join(", "))}</div>`;
    const title = kind === "bus" ? `${item.busType} bus` : item.type;
    const card = showCard(h, head(item.name, title) + `<div class="pp-body">${body}</div>`);
    card.querySelector("[data-act='jump']").onclick = () => jumpTo(line);
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

// ---- move (Board tab) ----

async function startPick(p) {
    const table = await pinTable();
    const targets = rankFreePins(table, p.mode || "Output", takenGpios(_hw, p.line))
        .map(i => String(i.gpio)).filter(g => g !== String(p.gpio));
    if (_view !== "board") showView("board");
    if (_hosts.side) closeCard(_hosts.side);
    _pick = { pin: p, targets };
    pinout.setTargets(targets);
    pinout.setHighlight([p.gpio]);
    const banner = _hosts.board.el.querySelector(".hwp-banner");
    banner.innerHTML = targets.length
        ? `<span>Move <b>${esc(p.name)}</b> from GPIO ${esc(p.gpio)} — click a lit pin</span><button class="hwp-link" data-act="cancel">Cancel (Esc)</button>`
        : `<span>No free pin can do ${esc(p.mode || "Output")}.</span><button class="hwp-link" data-act="cancel">OK</button>`;
    banner.style.display = "";
    banner.querySelector("[data-act='cancel']").onclick = endPick;
}

function endPick() {
    if (!_pick) return;
    _pick = null;
    pinout.setTargets(null);
    const banner = _hosts.board.el.querySelector(".hwp-banner");
    banner.style.display = "none";
    banner.innerHTML = "";
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
function done(h, what, text, line, then) {
    setTimeout(() => { refresh(); then && then(); }, 0);
    const t = h.toast;
    t.innerHTML = `<span class="hwp-toast-what">${esc(what)}</span>${codeLine(text)}
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
