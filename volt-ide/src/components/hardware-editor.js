// Hardware in the editor: role-coloured gutter dots on pin / bus / device
// lines, board highlighting from the selection or a hovered dot, and the
// pin-aware completion and hover that language-features.js delegates to.
// Pin facts come from the compiler (pin_table op); usage comes from the
// live hardware extract, so it follows keystrokes even on broken syntax.

import { extractHardware, roleOf, setHighlight, boardPinInfo, pinDiagnostics } from "./pinout-panel.js";
import { MODES, pinTable, supportsMode, takenGpios, rankFreePins, tagFor } from "./pin-facts.js";

let _devices = null;
function deviceCatalog() {
    if (!_devices) _devices = window.volt.devicesList().then(d => d || []).catch(() => []);
    return _devices;
}

// ---- completion ----

// Returns a completion list for hardware positions, or null to let the
// general provider run.
export async function complete(model, position, textBefore, range) {
    const Kind = monaco.languages.CompletionItemKind;
    const line = model.getLineContent(position.lineNumber);
    const textAfter = line.substring(position.column - 1);

    // pin x = |   /   pin x: Mode = |
    let m = textBefore.match(/^\s*pin\s+\w+\s*(?::\s*(\w+))?\s*=\s*\d*$/);
    if (m) {
        const mode = m[1] || "";
        const table = await pinTable();
        const hw = extractHardware(model.getValue());
        const ranked = rankFreePins(table, mode, takenGpios(hw, position.lineNumber));
        return ranked.map((info, i) => ({
            label: { label: String(info.gpio), description: tagFor(info) },
            kind: info.safety === "safe" ? Kind.Value : Kind.Constant,
            filterText: String(info.gpio),
            sortText: String(i).padStart(3, "0"),
            insertText: String(info.gpio),
            documentation: { value: pinDoc(info) },
            range,
        }));
    }

    // pin x: |   (modes, limited to the pin's capabilities when it's known)
    m = textBefore.match(/^\s*pin\s+\w+\s*:\s*\w*$/);
    if (m) {
        const g = textAfter.match(/=\s*(\d+)/);
        const table = await pinTable();
        const info = g && table.find(i => i.gpio === Number(g[1]));
        return MODES.filter(md => !info || supportsMode(info, md.mode)).map((md, i) => ({
            label: md.mode,
            kind: Kind.EnumMember,
            detail: md.doc,
            sortText: String(i).padStart(2, "0"),
            insertText: md.mode,
            range,
        }));
    }

    // device x: T on |
    m = textBefore.match(/^\s*device\s+\w+\s*:\s*(\w+)\s+on\s+\w*$/);
    if (m) {
        const hw = extractHardware(model.getValue());
        const [catalog, devType] = [await deviceCatalog(), m[1].toLowerCase()];
        const dev = catalog.find(d => (d.name || "").toLowerCase() === devType);
        const iface = dev && (dev.interface || "").toUpperCase();
        return hw.buses
            .filter(b => !iface || b.busType === iface)
            .map(b => ({
                label: { label: b.name, description: b.busType + " · " +
                    Object.entries(b.roles).map(([r, g]) => r + " " + g).join(", ") },
                kind: Kind.Variable,
                insertText: b.name,
                range,
            }));
    }

    // device x: T on bus at |   (default address first, then the
    // other addresses already on the bus are flagged)
    m = textBefore.match(/^\s*device\s+\w+\s*:\s*(\w+)\s+on\s+(\w+)\s+at\s+(0x[0-9a-fA-F]*|\d*)$/);
    if (m) {
        const catalog = await deviceCatalog();
        const dev = catalog.find(d => (d.name || "").toLowerCase() === m[1].toLowerCase());
        const def = dev && dev.default_address;
        if (!def) return null;
        const hw = extractHardware(model.getValue());
        const clash = hw.devices.find(d => d.bus === m[2] && d.line !== position.lineNumber
            && parseInt(d.address) === parseInt(def));
        return [{
            label: { label: def, description: clash ? `used by ${clash.name} ⚠` : `${dev.name} default` },
            kind: Kind.Value,
            insertText: def,
            range,
        }];
    }
    return null;
}

function pinDoc(info) {
    const parts = ["**GPIO " + info.gpio + "** — " + (info.caps.length ? info.caps.join(", ") : "no I/O")];
    for (const n of info.notes) parts.push(n);
    return parts.join("\n\n");
}

// ---- hover ----

// Hovering a GPIO number in the hardware block, or a pin's name on its
// declaration line: the board popover as text.
export async function hover(model, position) {
    const line = model.getLineContent(position.lineNumber);
    if (!/^\s*(pin|bus|device)\b/.test(line)) return null;
    const word = model.getWordAtPosition(position);
    if (!word) return null;
    let gpio = null;
    if (/^\d+$/.test(word.word)) {
        const before = line.substring(0, word.startColumn - 1);
        if (/(=|:)\s*$/.test(before) && !/\bat\s*$/.test(before)) gpio = Number(word.word);
    } else {
        const pm = line.match(/^\s*pin\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(\d+)/);
        if (pm && pm[1] === word.word) gpio = Number(pm[2]);
    }
    if (gpio == null) return null;

    const info = (await pinTable()).find(i => i.gpio === gpio);
    const where = boardPinInfo(gpio);
    const out = [];
    let head = "**GPIO " + gpio + "**";
    if (where) head += ` · ${where.header} header, pin ${where.index}` + (where.label !== String(gpio) ? ` (“${where.label}”)` : "");
    out.push({ value: head });
    if (info) out.push({ value: (info.caps.length ? info.caps.join(" · ") : "no I/O") +
        (info.safety !== "safe" ? "  —  " + info.reason : "") });
    if (where && where.alt.length) out.push({ value: "Alternate functions: " + where.alt.join(", ") });
    const warns = pinDiagnostics(gpio);
    if (warns.length) out.push({ value: warns.map(w => "⚠ " + w).join("\n\n") });
    else if (info && info.notes.length) out.push({ value: info.notes.join("\n\n") });
    return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: out,
    };
}

// ---- gutter dots + board highlighting ----

// GPIOs and role for each hardware line (devices on a bus light the bus).
function lineMap(hw) {
    const byLine = new Map();
    const add = (line, gpio, role) => {
        if (!byLine.has(line)) byLine.set(line, { gpios: [], role });
        if (gpio != null) byLine.get(line).gpios.push(String(gpio));
    };
    for (const p of hw.pins) add(p.line, p.gpio, roleOf(p));
    for (const b of hw.buses) for (const g of Object.values(b.roles)) add(b.line, g, "bus");
    for (const d of hw.devices) {
        const own = Object.values(d.roles || {});
        if (own.length) { for (const g of own) add(d.line, g, "dev"); continue; }
        const bus = hw.buses.find(b => b.name === d.bus);
        const anchor = hw.pinByGpio[String(parseInt(d.address))];
        if (bus) for (const g of Object.values(bus.roles)) add(d.line, g, "dev");
        else if (anchor && anchor.line === d.line) add(d.line, anchor.gpio, "dev");
        else add(d.line, null, "dev");
    }
    return byLine;
}

export function attach(ed) {
    const dots = ed.createDecorationsCollection([]);
    let map = new Map();
    let timer = null;

    const refresh = () => {
        map = lineMap(extractHardware(ed.getValue()));
        dots.set([...map.entries()].map(([line, v]) => ({
            range: new monaco.Range(line, 1, line, 1),
            options: { linesDecorationsClassName: "hw-dot role-" + v.role },
        })));
    };
    const highlightSelection = () => {
        const sel = ed.getSelection();
        if (!sel) return;
        const gpios = [];
        for (let l = sel.startLineNumber; l <= sel.endLineNumber; l++) {
            const v = map.get(l);
            if (v) gpios.push(...v.gpios);
        }
        setHighlight(gpios);
    };

    refresh();
    ed.onDidChangeModelContent(() => {
        clearTimeout(timer);
        timer = setTimeout(() => { refresh(); highlightSelection(); }, 120);
    });
    ed.onDidChangeModel(refresh);
    ed.onDidChangeCursorSelection(highlightSelection);

    let hovered = 0;
    ed.onMouseMove(e => {
        const t = e.target;
        const line = t && t.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS && t.position
            ? t.position.lineNumber : 0;
        if (line === hovered) return;
        hovered = line;
        if (line && map.has(line)) setHighlight(map.get(line).gpios);
        else highlightSelection();
    });
    ed.onMouseLeave(() => { if (hovered) { hovered = 0; highlightSelection(); } });
}
