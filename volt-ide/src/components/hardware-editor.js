// Hardware in the editor: role-coloured gutter dots on pin / bus / device
// lines, board highlighting from the selection or a hovered dot, and the
// pin-aware completion and hover that language-features.js delegates to.
// Pin facts come from the compiler (pin_table op); usage comes from the
// live hardware extract, so it follows keystrokes even on broken syntax.

import { extractHardware, roleOf, setHighlight, boardPinInfo, pinDiagnostics } from "./pinout-panel.js";
import { MODES, pinTable, supportsMode, takenGpios, rankFreePins, tagFor, BUS_SIGNALS } from "./pin-facts.js";

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

    // Argument lists: `device x: T(|`, `i2c name(|`. Keys first (pins the
    // device needs, then its settings); after `key:` a free GPIO, or the
    // setting's default.
    const DEV = "^\\s*device\\s+\\w+\\s*:\\s*(\\w+)";
    m = textBefore.match(new RegExp(DEV + "\\s*\\(([^)]*)$")) || textBefore.match(/^\s*(i2c|spi|uart)\s+\w+\s*\(([^)]*)$/);
    if (m) {
        const isBus = /^\s*(i2c|spi|uart)\s/.test(textBefore);
        const kind = isBus ? m[1] : "";
        const dev = isBus ? null : (await deviceCatalog()).find(d => (d.name || "").toLowerCase() === m[1].toLowerCase());
        const iface = dev ? (dev.interface || "").toLowerCase() : kind;
        const pins = isBus ? Object.fromEntries((BUS_SIGNALS[kind] || []).map(x => [x.role, { dir: x.out ? "out" : "in" }]))
            : { ...(dev && dev.pins || {}), ...(iface === "uart" ? { tx: { dir: "out" }, rx: { dir: "in" } } : {}) };
        const params = isBus ? (kind === "uart" ? { baud: { type: "int", default: 9600 } } : { speed: { type: "freq", default: kind === "i2c" ? "100k" : "1M" } })
            : (dev && dev.params || {});
        const seg = m[2].split(",").pop();
        const kv = seg.match(/^\s*(\w+)\s*:\s*(\w*)$/);
        if (kv) {
            const key = kv[1].toLowerCase();
            if (pins[key]) {
                const table = await pinTable();
                const hw = extractHardware(model.getValue());
                const ranked = rankFreePins(table, pins[key].dir === "in" ? "Input" : "Output", takenGpios(hw, position.lineNumber));
                return ranked.map((info, i) => ({
                    label: { label: String(info.gpio), description: tagFor(info) },
                    kind: info.safety === "safe" ? Kind.Value : Kind.Constant,
                    filterText: String(info.gpio), sortText: String(i).padStart(3, "0"),
                    insertText: String(info.gpio), documentation: { value: pinDoc(info) }, range,
                }));
            }
            const p = params[key];
            if (p && p.default != null) return [{ label: { label: String(p.default), description: "default" },
                kind: Kind.Value, insertText: String(p.default), range }];
            return null;
        }
        if (!/^\s*\w*$/.test(seg)) return null;
        const used = new Set(m[2].split(",").map(x => (x.match(/^\s*(\w+)\s*:/) || [])[1]).filter(Boolean).map(x => x.toLowerCase()));
        const items = [
            ...Object.entries(pins).map(([k, p]) => [k, `GPIO ${p.dir === "in" ? "input" : "output"}`]),
            ...Object.entries(params).map(([k, p]) => [k, `${p.type || "value"}${p.default != null ? ", default " + p.default : ""}`]),
        ].filter(([k]) => !used.has(k));
        return items.map(([k, detail], i) => ({
            label: { label: k, description: detail },
            kind: i < Object.keys(pins).length ? Kind.Field : Kind.Property,
            sortText: String(i).padStart(2, "0"),
            insertText: k + ": ", command: { id: "editor.action.triggerSuggest" }, range,
        }));
    }

    // device x: T[(…)] on |
    m = textBefore.match(new RegExp(DEV + "\\s*(?:\\([^)]*\\))?\\s+on\\s+\\w*$"));
    if (m) {
        const hw = extractHardware(model.getValue());
        const [catalog, devType] = [await deviceCatalog(), m[1].toLowerCase()];
        const dev = catalog.find(d => (d.name || "").toLowerCase() === devType);
        const iface = dev && (dev.interface || "").toUpperCase();
        return hw.buses
            .filter(b => !b.implicit && (!iface || b.busType === iface))
            .map(b => ({
                label: { label: b.name, description: b.busType + " · " +
                    Object.entries(b.roles).map(([r, g]) => r + " " + g).join(", ") },
                kind: Kind.Variable,
                insertText: b.name,
                range,
            }));
    }

    // device x: T[(…)] [on bus] at |   (the device's addresses, default
    // first; ones already taken on the same bus are flagged)
    m = textBefore.match(new RegExp(DEV + "\\s*(?:\\([^)]*\\))?\\s*(?:\\bon\\s+\\w+\\s*)?\\bat\\s+(0x[0-9a-fA-F]*|\\d*)$"));
    if (m) {
        const catalog = await deviceCatalog();
        const dev = catalog.find(d => (d.name || "").toLowerCase() === m[1].toLowerCase());
        if (!dev || (dev.interface || "i2c").toLowerCase() !== "i2c") return null;
        const addrs = [...new Set([dev.default_address, ...(dev.addresses || [])].filter(Boolean))];
        if (!addrs.length) return null;
        const hw = extractHardware(model.getValue());
        const self = hw.devices.find(d => d.line === position.lineNumber);
        const bus = self ? self.bus : "";
        return addrs.map((a, i) => {
            const clash = hw.devices.find(d => d.bus === bus && d.line !== position.lineNumber && parseInt(d.address) === parseInt(a));
            return { label: { label: a, description: clash ? `used by ${clash.name} ⚠` : i === 0 ? "default" : "alternate" },
                kind: Kind.Value, sortText: String(i), insertText: a, range };
        });
    }
    return null;
}

// Hovering a device's type (what it is, its pins and settings) or one of
// its setting names in the argument list.
async function deviceHover(line, word, position) {
    const dm = line.match(/^\s*device\s+\w+\s*:\s*(\w+)/);
    if (!dm) return null;
    const dev = (await deviceCatalog()).find(d => (d.name || "").toLowerCase() === dm[1].toLowerCase());
    if (!dev) return null;
    const params = dev.params || {};
    const iface = (dev.interface || "i2c").toLowerCase();
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    const setting = (k, p) => `\`${k}\` ${p.type || ""}${p.default != null ? ", default " + p.default : ""}`;
    if (word.word === dm[1]) {
        const pins = [...Object.keys(dev.pins || {}), ...(iface === "uart" ? ["tx", "rx"] : [])];
        const out = [{ value: `**${dev.name}** · ${iface.toUpperCase()}${dev.description ? " — " + dev.description : ""}` }];
        if (pins.length) out.push({ value: "Pins: " + pins.map(p => "`" + p + "`").join(", ") });
        if (Object.keys(params).length) out.push({ value: "Settings: " + Object.entries(params).map(([k, p]) => setting(k, p)).join(" · ") });
        if (iface === "i2c" && dev.default_address) out.push({ value: `Address ${dev.default_address} unless \`at\` says otherwise; on the default I2C bus unless \`on\` names one.` });
        return { range, contents: out };
    }
    if (params[word.word] && /^\s*:/.test(line.substring(word.endColumn - 1)))
        return { range, contents: [{ value: setting(word.word, params[word.word]) }] };
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
    if (!/^\s*(pin|bus|device|i2c|spi|uart)\b/.test(line)) return null;
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
    if (gpio == null) return deviceHover(line, word, position);

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
    for (const b of hw.buses) if (b.line > 0) for (const g of Object.values(b.roles)) add(b.line, g, "bus");
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

// The Hardware side panel, opened, then `fn(hardwarePanelModule)`.
function openPanel(fn) {
    import("./side-panel.js").then(sp => {
        sp.open("hardware");
        import("./hardware-panel.js").then(m => setTimeout(() => fn(m), 150));
    });
}

export function attach(ed) {
    import("./hardware-panel.js").then(m => m.prefetch());
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

    // Click a gutter dot → that line's card in the Hardware panel.
    ed.onMouseDown(e => {
        const t = e.target;
        if (!t || t.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !t.position) return;
        const line = t.position.lineNumber;
        if (!map.has(line)) return;
        openPanel(m => m.showLine(line));
    });

    // Buttons at the end of the `hardware {` line: + Add pin / + Add device.
    const node = document.createElement("div");
    node.className = "hw-inline-actions";
    node.innerHTML = `<button data-kind="pin" title="Add an LED, button, servo… (Ctrl+Shift+A)">
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5" r="2.6"/><path d="M8 7.6V14"/></svg>Add pin</button>
        <button data-kind="device" title="Add a sensor, display or module">
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.2"/><path d="M6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2"/></svg>Add device</button>`;
    node.style.height = ed.getOption(monaco.editor.EditorOption.lineHeight) + "px";
    node.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); });
    node.querySelectorAll("button").forEach(b =>
        b.onclick = (e) => { e.stopPropagation(); import("./hardware-panel.js").then(m => m.openPicker(null, null, b.dataset.kind)); });
    let hwLine = 0;
    const widget = {
        getId: () => "volt.hardware.actions",
        getDomNode: () => node,
        getPosition: () => hwLine ? {
            position: { lineNumber: hwLine, column: ed.getModel().getLineMaxColumn(hwLine) },
            preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
        } : null,
    };
    ed.addContentWidget(widget);
    const placeWidget = () => {
        const model = ed.getModel();
        const i = model ? model.getLinesContent().findIndex(l => /^\s*hardware\s*\{\s*$/.test(l)) : -1;
        hwLine = i + 1;
        node.style.display = hwLine ? "" : "none";
        ed.layoutContentWidget(widget);
    };
    placeWidget();
    ed.onDidChangeModelContent(placeWidget);
    ed.onDidChangeModel(placeWidget);

    // Quick adds, floating bottom-right: a new block at the end of the
    // file, cursor in its first field (Tab walks the rest). The new block
    // flashes; the row fades while you type and comes back on mouse move.
    const ICON = {
        setup: '<path d="M8 2.5v5"/><path d="M4.6 4.6a5 5 0 1 0 6.8 0"/>',
        task:  '<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5v3h-3"/>',
        every: '<circle cx="8" cy="9" r="5"/><path d="M8 6.5V9l1.8 1.2M6.5 2h3"/>',
        on:    '<path d="M9 1.8 4 9h4l-1 5.2L12 7H8z"/>',
        func:  '<path d="M10.5 2.5c-1.6 0-2.2.8-2.5 2.5L6.6 11.5c-.3 1.4-.9 2-2.1 2M5.5 6.5h5"/>',
    };
    const QUICK = [
        ["setup", "Setup", "Runs once at boot", "setup {\n    $0\n}"],
        ["task", "Task", "Its own loop, runs alongside the rest", "task ${1:name} {\n    every ${2:1s} {\n        $0\n    }\n}"],
        ["every", "Every", "Repeats on a timer", "every ${1:1s} {\n    $0\n}"],
        ["on", "On event", "Runs when a condition becomes true", "on ${1:condition} {\n    $0\n}"],
        ["func", "Func", "Reusable code you can call", "func ${1:name}() {\n    $0\n}"],
    ];
    const quick = document.createElement("div");
    quick.className = "code-quick-adds";
    quick.innerHTML = QUICK.map(([k, label, tip]) => `<button data-k="${k}" data-tip="${tip}" aria-label="Add ${label} — ${tip}">
        <svg viewBox="0 0 16 16" aria-hidden="true">${ICON[k]}</svg>${label}</button>`).join("");
    quick.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); });
    const flash = ed.createDecorationsCollection([]);
    let inserting = false, flashTimer = 0, typingTimer = 0;
    quick.querySelectorAll("button").forEach(b => b.onclick = () => {
        const model = ed.getModel();
        if (!model) return;
        const snippet = QUICK.find(q => q[0] === b.dataset.k)[3];
        const last = model.getLineCount();
        const tail = model.getLineContent(last);
        // One blank line between the last block and the new one.
        const gap = tail.trim() === "" ? (last > 1 && model.getLineContent(last - 1).trim() === "" ? "" : "\n") : "\n\n";
        ed.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
        ed.focus();
        inserting = true;
        ed.getContribution("snippetController2").insert(gap + snippet + "\n");
        inserting = false;
        const first = last + gap.split("\n").length - 1, end = first + snippet.split("\n").length - 1;
        ed.revealLinesInCenterIfOutsideViewport(first, end, monaco.editor.ScrollType.Smooth);
        flash.set([{ range: new monaco.Range(first, 1, end, 1), options: { isWholeLine: true, className: "hw-edit-flash" } }]);
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => flash.set([]), 900);
        b.classList.add("is-done");
        setTimeout(() => b.classList.remove("is-done"), 600);
    });
    ed.addOverlayWidget({
        getId: () => "volt.code.quickAdds",
        getDomNode: () => quick,
        getPosition: () => ({ preference: monaco.editor.OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER }),
    });
    const placeQuick = () => {
        const model = ed.getModel();
        const src = model ? model.getValue() : "";
        quick.style.display = model && model.getLanguageId() === "volt" ? "" : "none";
        quick.querySelector('[data-k="setup"]').style.display = /^\s*setup\s*\{/m.test(src) ? "none" : "";
    };
    placeQuick();
    ed.onDidChangeModelContent(() => {
        placeQuick();
        if (inserting || !ed.hasTextFocus()) return;
        quick.classList.add("is-typing");
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => quick.classList.remove("is-typing"), 2500);
    });
    ed.onDidChangeModel(placeQuick);
    ed.getDomNode()?.addEventListener("mousemove", () => {
        if (!quick.classList.contains("is-typing")) return;
        clearTimeout(typingTimer);
        quick.classList.remove("is-typing");
    });

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
