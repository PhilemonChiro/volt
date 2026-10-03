// "Add part" — a searchable picker over the parts catalogue (parts.js).
// Search-first: type, Enter adds. Arrow keys move, Esc closes. Opened from
// a free pin it only lists parts that fit that pin.

import { catalogue, search, fitsPin, GROUP_ORDER } from "./parts.js";

const IFACE = {
    pin: "1 pin", gpio: null, i2c: "I2C · shares 2 wires", spi: "SPI · shared bus + 1 pin", uart: "Serial · 2 pins",
};

let _open = null;

// open({ title, info, kind: "pin" | "device", onPick(entry) })
export async function open(opts) {
    close();
    const cat = (await catalogue()).filter(e => fitsPin(e, opts.info) && (!opts.kind || e.kind === opts.kind));
    const prev = document.activeElement;
    const ov = document.createElement("div");
    ov.className = "pk-overlay";
    ov.innerHTML = `
        <div class="pk" role="dialog" aria-modal="true" aria-label="${esc(opts.title || "Add a part")}">
            <div class="pk-head">
                <span class="pk-title">${esc(opts.title || "Add a part")}</span>
                <input class="pk-search" type="search" placeholder="${opts.kind === "pin" ? "Search — LED, button, servo, knob…" : opts.kind === "device" ? "Search — BME280, OLED, GPS, RFID…" : "Search — LED, button, BME280, OLED, GPS…"}"
                    aria-label="Search parts" aria-controls="pkList" autocomplete="off" spellcheck="false">
            </div>
            <div class="pk-list" id="pkList" role="listbox"></div>
            <div class="pk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> add</span><span><kbd>Esc</kbd> close</span>
                <span class="pk-foot-r">Volt picks the pins and writes the code — change anything after.</span></div>
        </div>`;
    document.body.appendChild(ov);
    const input = ov.querySelector(".pk-search");
    const list = ov.querySelector(".pk-list");
    let rows = [], active = 0;

    const render = () => {
        const q = input.value;
        const found = search(cat, q);
        let html = "";
        rows = [];
        const groups = q.trim() ? [null] : GROUP_ORDER;
        for (const grp of groups) {
            const items = grp ? found.filter(e => e.group === grp) : found;
            if (!items.length) continue;
            if (grp) html += `<div class="pk-group" role="presentation">${esc(grp)}</div>`;
            for (const e of items) {
                const i = rows.length;
                rows.push(e);
                const iface = e.iface === "gpio" ? `${e.roles.length} pin${e.roles.length > 1 ? "s" : ""}` : IFACE[e.iface] || e.iface;
                html += `<div class="pk-row" role="option" id="pk-${i}" data-i="${i}" aria-selected="false">
                    <b>${esc(e.label)}</b><span class="pk-sub">${esc(e.sub)}</span>
                    <span class="pk-meta">${q.trim() ? esc(e.group) + " · " : ""}${esc(iface)}</span></div>`;
            }
        }
        list.innerHTML = html || `<div class="pk-empty">No parts match “${esc(q)}”.</div>`;
        list.querySelectorAll(".pk-row").forEach(r => {
            r.onclick = () => pick(Number(r.dataset.i));
            r.onpointermove = () => setActive(Number(r.dataset.i), false);
        });
        setActive(0, true);
    };
    const setActive = (i, scroll) => {
        if (!rows.length) return;
        active = Math.max(0, Math.min(rows.length - 1, i));
        list.querySelectorAll(".pk-row").forEach(r => {
            const on = Number(r.dataset.i) === active;
            r.classList.toggle("is-active", on);
            r.setAttribute("aria-selected", String(on));
            if (on && scroll) r.scrollIntoView({ block: "nearest" });
        });
        input.setAttribute("aria-activedescendant", "pk-" + active);
    };
    const pick = (i) => {
        const e = rows[i];
        if (!e) return;
        close();
        opts.onPick(e);
    };

    input.oninput = render;
    input.onkeydown = (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1, true); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1, true); }
        else if (e.key === "Enter") { e.preventDefault(); pick(active); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    };
    ov.addEventListener("pointerdown", (e) => { if (e.target === ov) close(); });
    _open = { ov, prev };
    render();
    input.focus();
}

// "Add pin": a compact form — Pin, Type, Name, preview, Add.
// opts: { pins: [{ gpio, label, note }] (number order, no suggestion),
//         modesFor(gpio) → [{ mode, doc }], nameFor(mode, gpio) → unique name,
//         nameProblem(name) → "" | message, onPick(gpio, entry, name) }
export function openPin(opts) {
    close();
    const prev = document.activeElement;
    const ov = document.createElement("div");
    ov.className = "pk-overlay";
    ov.innerHTML = `
        <form class="pk pkf" role="dialog" aria-modal="true" aria-labelledby="pkfTitle">
            <div class="pkf-head" id="pkfTitle">Add pin</div>
            <div class="pkf-body">
                <label for="pkfPin">Pin</label>
                <div class="pkf-field">
                    <select id="pkfPin" required>
                        <option value="" disabled selected>Choose a pin…</option>
                        ${opts.pins.map(p => `<option value="${p.gpio}"${p.level === "blocked" ? " disabled" : ""}>GPIO ${p.gpio}${p.label !== String(p.gpio) ? ` (${esc(p.label)})` : ""}${
                            p.level === "blocked" ? " — can't be used" : p.level === "issue" ? "  ⚠ unsafe" : p.level === "warning" ? "  ⚠" : ""}</option>`).join("")}
                    </select>
                    <div class="pkf-note"></div>
                </div>
                <label for="pkfType">Mode</label>
                <div class="pkf-field"><select id="pkfType" required disabled><option value="">Choose a pin first</option></select></div>
                <label for="pkfName">Name</label>
                <div class="pkf-field">
                    <input id="pkfName" spellcheck="false" autocomplete="off" disabled>
                    <div class="pkf-err" role="alert"></div>
                </div>
            </div>
            <div class="pkf-preview"><code></code></div>
            <div class="pkf-foot">
                <button type="button" class="pp-btn pp-btn-ghost" data-act="cancel">Cancel</button>
                <button type="submit" class="pp-btn pp-btn-primary" disabled>Add pin</button>
            </div>
        </form>`;
    document.body.appendChild(ov);
    const form = ov.querySelector("form");
    const pinSel = ov.querySelector("#pkfPin"), typeSel = ov.querySelector("#pkfType"), nameIn = ov.querySelector("#pkfName");
    const note = ov.querySelector(".pkf-note"), err = ov.querySelector(".pkf-err");
    const code = ov.querySelector(".pkf-preview code"), addBtn = ov.querySelector("[type=submit]");
    let modes = [], nameEdited = false;
    const update = () => {
        const g = pinSel.value, m = typeSel.value;
        if (g && m && !nameEdited) nameIn.value = opts.nameFor(m, g);
        const n = nameIn.value.trim();
        code.textContent = g && m ? `pin ${n || "…"}: ${m} = ${g}` : "";
        addBtn.disabled = !(g && m && n);
    };
    pinSel.onchange = () => {
        const p = opts.pins.find(x => x.gpio === pinSel.value);
        note.textContent = p && p.note ? p.note : "";
        note.className = "pkf-note" + (p && p.level ? " is-" + p.level : "");
        const keep = typeSel.value;
        modes = opts.modesFor(pinSel.value);
        typeSel.disabled = !modes.length;
        nameIn.disabled = false;
        typeSel.innerHTML = modes.map(m => `<option value="${m.mode}">${m.mode} — ${esc(m.doc)}</option>`).join("")
            || `<option value="">No modes on this pin</option>`;
        if (modes.some(m => m.mode === keep)) typeSel.value = keep;
        update();
    };
    typeSel.onchange = update;
    nameIn.oninput = () => { nameEdited = true; err.textContent = ""; update(); };
    form.onsubmit = (e) => {
        e.preventDefault();
        const g = pinSel.value, m = typeSel.value, n = nameIn.value.trim();
        if (!g || !m || !n) return;
        const bad = opts.nameProblem(n);
        if (bad) { err.textContent = bad; nameIn.focus(); return; }
        close();
        opts.onPick(g, m, n);
    };
    ov.querySelector("[data-act='cancel']").onclick = close;
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } });
    ov.addEventListener("pointerdown", (e) => { if (e.target === ov) close(); });
    _open = { ov, prev };
    pinSel.focus();
}

export function close() {
    if (!_open) return;
    _open.ov.remove();
    if (_open.prev && _open.prev.focus) _open.prev.focus();
    _open = null;
}

function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
