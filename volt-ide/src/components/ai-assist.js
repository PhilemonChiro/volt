// AI touches around the IDE — each one hands a small, well-described job to
// the Assistant panel (assistant-panel.js), which runs the user's agent:
//   - Fix it on errors (Problems rows, editor lightbulb, failed build output)
//   - a one-line bar when the serial output shows a crash, brownout, watchdog
//     reset or a sensor that stopped answering
//   - Ask on a code selection (⌘I / Ctrl+I): Explain / Change… / Find bugs
//   - context(): what the user is looking at, sent with every message
//   - askPart(): "Ask for a part" in the Wiring view, then light up its new pins

import * as assistant from "./assistant-panel.js";
import * as editor from "./editor.js";
import * as bottomPanel from "./bottom-panel.js";
import * as deviceSelector from "./device-selector.js";
import * as chipSelector from "./chip-selector.js";
import * as settings from "../services/settings.js";
import { activeDiagramName } from "./diagrams-view.js";
import { extractPinsFromSource } from "./pinout-panel.js";
import { ICONS } from "./icons.js";

let getProject = () => null;
let getFile = () => null;
let view = "code";

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fence = (s) => "```\n" + s.replace(/```/g, "'''") + "\n```";
const fileName = () => (getFile() || "").split(/[\\/]/).pop() || "the program";

function send(text, context) {
    const project = getProject();
    if (!project) return;
    assistant.ask(project, text, { context });
}

export function init(ctx) {
    getProject = ctx.getProject;
    getFile = ctx.getFile;
    document.addEventListener("volt:view", (e) => { view = e.detail.view; });
    bottomPanel.onFix(fixIt);
    bottomPanel.onSerialLine(watchSerial);
}

// ---- build log (every progress line, verbose or not) ----

let buildLog = [];
/** noteBuild(message) — keep a build line for Fix it; null starts a new run. */
export function noteBuild(message) {
    if (message == null) { buildLog = []; return; }
    buildLog.push(String(message).replace(/\x1b\[[0-9;]*m/g, ""));
    if (buildLog.length > 80) buildLog.shift();
}

// ---- Fix it ----

/** fixIt({ message, line, hint, log }) — ask the agent to fix one error, or a
 *  failed build (log: true sends the build output). */
export function fixIt({ message, line, hint, log }) {
    const notes = ["Fix this with ide_edit (the user can undo it), check the program again, then say in one line what was wrong."];
    if (line) {
        const src = editor.getValue().split("\n")[line - 1];
        notes.push(`Error at line ${line} of ${fileName()}: ${message}`);
        if (src != null) notes.push(`Line ${line}: ${src.trim()}`);
    } else notes.push(`Build failed: ${message}`);
    if (hint) notes.push(`Hint from the checker: ${hint}`);
    if (log) {
        const out = (buildLog.length ? buildLog.slice(-40).join("\n") : bottomPanel.recentOutput(40)).trim();
        if (out) notes.push("Build output (last lines):\n" + fence(out));
    }
    send(line ? `Fix the error on line ${line}: ${message}` : `Fix the failed build: ${message}`, notes.join("\n"));
}

// ---- serial crash bar ----
// Each rule: what to look for, the plain one-line explanation, and what the
// agent should do when asked to fix it.

const SERIAL_RULES = [
    { kind: "crash", re: /Guru Meditation Error|abort\(\) was called|Backtrace:\s*0x|LoadProhibited|StoreProhibited|InstrFetchProhibited|IllegalInstruction/,
      text: "The board crashed and restarted. Usually reading past the end of a list, an empty value, or a task running out of stack." },
    { kind: "stack", re: /Stack canary watchpoint triggered|stack overflow/i,
      text: "A task ran out of stack memory and the board restarted. A big local buffer or deep recursion is the usual cause." },
    { kind: "brownout", re: /Brownout detector was triggered|BROWNOUT_RST/,
      text: "The power dipped too low and the board reset. Try a better USB cable or port, or power motors and LED strips separately." },
    { kind: "watchdog", re: /Task watchdog got triggered|Interrupt wdt timeout|TG[01]WDT_SYS_RST|RTCWDT_RTC_RST|INT_WDT/,
      text: "The watchdog reset the board: something kept the chip busy too long without pausing (a tight loop or a long blocking wait)." },
    { kind: "sensor", re: /(sensor|i2c|dht|bme|bmp|sht|aht|mpu|ds18b20|vl53|ina219)\S*.{0,40}?(fail|error|timeout|timed out|not found|no response|nack|not responding)|(failed to read|read failed|no ack|not detected).{0,40}?(sensor|i2c|device)/i,
      text: "A sensor isn't answering. Check its wiring, its power (3.3 V or 5 V) and, for I2C parts, its address." },
];

const seenAt = {};           // kind → when its bar last appeared
let barKind = null;

function watchSerial(line) {
    const rule = SERIAL_RULES.find(r => r.re.test(line));
    if (!rule) return;
    // The same thing repeating (a boot loop, a sensor read every second) shows once.
    if (barKind === rule.kind || Date.now() - (seenAt[rule.kind] || 0) < 20000) return;
    seenAt[rule.kind] = Date.now();
    barKind = rule.kind;
    bottomPanel.showSerialBar({
        text: rule.text,
        onDismiss: () => { barKind = null; },
        actions: [
            { label: "Explain", run: () => serialAsk(rule, false) },
            { label: "Fix", run: () => serialAsk(rule, true) },
        ],
    });
}

function serialAsk(rule, fix) {
    const lines = bottomPanel.recentSerial(40);
    const notes = [`Serial output from the board (last lines):\n${fence(lines)}`];
    if (rule.kind === "crash" || rule.kind === "stack")
        notes.push("Backtrace addresses can't be decoded here; reason from the program and the lines printed before the crash.");
    if (fix) {
        notes.push("Find the cause in the program and fix it with ide_edit (the user can undo it), check it, then say in one line what was wrong. If the cause is hardware (power, wiring), say so plainly instead of changing code.");
        send(`The board shows a problem on the serial monitor: ${rule.text} Fix it.`, notes.join("\n"));
    } else {
        notes.push("Explain in plain words what happened and the likely cause in this program. Don't change any code.");
        send(`What does this serial output mean? ${rule.text}`, notes.join("\n"));
    }
    bottomPanel.showSerialBar(null);
    barKind = null;
}

// ---- what the user sees ----

/** context() — a short note for the agent on what's on screen right now. */
export async function context() {
    const out = ["[Volt IDE, what the user sees right now. Use it to understand the request; don't repeat it back.]"];
    const diag = activeDiagramName() === "sequence" ? "Sequence diagram" : "State machine diagram";
    out.push("View: " + ({ code: "Code editor", board: "Wiring (board and connections)", diagrams: diag })[view]);
    const file = getFile();
    const cur = file ? editor.getCursor() : null;
    if (file) out.push(`File: ${fileName()}` + (cur && cur.cursor ? `, cursor on line ${cur.cursor.line}` : ""));
    const sel = cur && cur.selection;
    if (sel && sel.text.trim()) {
        // A selection ending at column 1 doesn't include that line.
        const end = sel.end_col === 1 && sel.end_line > sel.start_line ? sel.end_line - 1 : sel.end_line;
        const n = end - sel.start_line + 1;
        out.push(`Selected: ${n === 1 ? "line " + end : `lines ${sel.start_line}–${end}`}` + (n <= 60 ? "\n" + fence(sel.text) : " (long; read it with ide_read)"));
    }
    const dev = deviceSelector.getSelected();
    const target = (chipSelector.getChip() || "").toUpperCase();
    if (dev) {
        const mon = await window.volt.isMonitoring?.().catch(() => false);
        out.push(`Board: ${dev.chip} on ${dev.port} (project targets ${target}), serial monitor ${mon ? "on" : "off"}`);
    } else out.push(`Board: none connected (project targets ${target})`);
    const model = typeof monaco !== "undefined" && monaco.editor.getEditors()[0]?.getModel();
    const marks = model ? monaco.editor.getModelMarkers({ owner: "volt", resource: model.uri }) : [];
    const errs = marks.filter(m => m.severity >= monaco.MarkerSeverity.Warning).slice(0, 10);
    if (errs.length) out.push("Problems:\n" + errs.map(m => `- line ${m.startLineNumber} ${m.severity === monaco.MarkerSeverity.Error ? "error" : "warning"}: ${m.message}`).join("\n"));
    const serial = bottomPanel.recentSerial(20);
    if (serial) out.push("Serial monitor (last lines):\n" + fence(serial));
    return out.join("\n");
}

// ---- Ask for a part (Wiring view) ----

/** askPart(text) — ask the agent to add a part; the pins it adds light up. */
export function askPart(text) {
    const before = new Set(extractPinsFromSource(editor.getValue()).map(p => String(p.gpio)));
    send(`Add a part: ${text}`, [
        "The user asked for this part from the Wiring view.",
        "If more than one part fits, offer them with a ```devices block and wait for the choice. Then call device_card, add it with ide_edit on free pins that don't clash, check it, and show the wiring with ide_show board.",
    ].join("\n"));
    let started = false;   // this request's turn, not one already running
    const done = (e) => {
        if (e.detail.on) { started = true; return; }
        if (!started) return;
        document.removeEventListener("volt:assistant-busy", done);
        const added = extractPinsFromSource(editor.getValue()).map(p => String(p.gpio)).filter(g => g && !before.has(g));
        if (added.length) import("./hardware-panel.js").then(m => m.highlightNew(added));
    };
    document.addEventListener("volt:assistant-busy", done);
}

// ---- editor: lightbulb Fix it, Ask on selection ----

/** attachEditor(ed) — once, when the Monaco editor exists. */
export function attachEditor(ed) {
    const fixCmd = ed.addCommand(0, (_, m) => fixIt({ message: m.message, line: m.startLineNumber }));
    monaco.languages.registerCodeActionProvider("volt", {
        provideCodeActions: (model, range, ctx) => ({
            actions: (ctx.markers || []).filter(m => m.severity === monaco.MarkerSeverity.Error).slice(0, 1).map(m => ({
                title: "Fix it with the assistant",
                kind: "quickfix",
                diagnostics: [m],
                command: { id: fixCmd, title: "Fix it with the assistant", arguments: [m] },
            })),
            dispose() {},
        }),
    });
    askWidget(ed);
}

function askWidget(ed) {
    const node = document.createElement("div");
    node.className = "ai-ask";
    let pos = null;
    let open = false;
    const widget = {
        getId: () => "volt.ai-ask",
        getDomNode: () => node,
        getPosition: () => pos && { position: pos, preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE, monaco.editor.ContentWidgetPositionPreference.BELOW] },
    };
    ed.addContentWidget(widget);
    const mac = /Mac/.test(navigator.platform);
    const place = (p) => { pos = p; ed.layoutContentWidget(widget); };
    const hide = () => { open = false; node.innerHTML = ""; place(null); };
    const range = () => {
        const s = ed.getSelection();
        if (!s) return null;
        // Nothing selected (⌘I on a line): the current line.
        if (s.isEmpty()) return { from: s.startLineNumber, to: s.startLineNumber };
        // A selection ending at column 1 doesn't include that line.
        const to = s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber;
        return { from: s.startLineNumber, to };
    };
    const linesText = (r) => r.from === r.to ? `line ${r.from}` : `lines ${r.from}–${r.to}`;
    const go = (kind, extra) => {
        const r = range();
        if (!r) return;
        if (ed.getSelection().isEmpty()) ed.setSelection(new monaco.Selection(r.from, 1, r.to, ed.getModel().getLineMaxColumn(r.to)));
        const what = linesText(r);
        hide();
        if (kind === "explain") send(`Explain ${what}`, "Explain the selected code in plain words for someone new to firmware. Don't change any code.");
        if (kind === "bugs") send(`Find bugs in ${what}`, "Look for bugs in the selected code (logic, timing, pins, values that can overflow or be empty). List what you find; fix them with ide_edit only if the user asks.");
        if (kind === "ask") send(`${extra} (${what})`, "The request is about the selected code. If it asks for a change, change only that code (and what it needs elsewhere) with ide_edit, check it, then say in one line what changed. Otherwise answer without changing code.");
    };
    const KEY = mac ? "⌘I" : "Ctrl I";
    // The pill: a small filled capsule beside the selection.
    const button = () => {
        open = false;
        node.className = "ai-ask";
        node.innerHTML = `<button type="button" class="ai-ask-pill" title="Ask about this code (${KEY})">${ICONS.sparkle}<span>Ask</span><kbd>${KEY}</kbd></button>`;
        node.querySelector("button").onclick = menu;
    };
    // The popover: type anything, or pick a quick action.
    const menu = () => {
        open = true;
        const what = linesText(range() || { from: 1, to: 1 });
        node.className = "ai-ask is-open";
        node.innerHTML = `<form class="ai-pop" role="dialog" aria-label="Ask about ${esc(what)}">
            <div class="ai-pop-row">
                <span class="ai-pop-ic">${ICONS.sparkle}</span>
                <input type="text" placeholder="Ask or describe a change…" aria-label="Ask about ${esc(what)}" autocomplete="off" spellcheck="false">
                <button type="submit" class="ai-pop-send" aria-label="Send" title="Send" disabled>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg></button>
            </div>
            <div class="ai-pop-foot">
                <button type="button" class="ai-chip" data-k="explain">Explain</button>
                <button type="button" class="ai-chip" data-k="bugs">Find bugs</button>
                <span class="ai-pop-what">${esc(what)}</span>
            </div></form>`;
        const input = node.querySelector("input");
        const sendBtn = node.querySelector(".ai-pop-send");
        input.oninput = () => { sendBtn.disabled = !input.value.trim(); };
        node.querySelector("form").onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) go("ask", input.value.trim()); };
        node.querySelectorAll(".ai-chip").forEach(b => b.onclick = () => go(b.dataset.k));
        ed.layoutContentWidget(widget);
        // Monaco settles its own focus after the click; take it once that's done.
        for (const ms of [30, 160]) setTimeout(() => { if (open && document.activeElement !== input) input.focus(); }, ms);
    };
    // Keep the editor's selection when the widget is clicked.
    node.addEventListener("mousedown", (e) => { if (!e.target.closest("input")) e.preventDefault(); });
    document.addEventListener("mousedown", (e) => { if (open && !node.contains(e.target)) hide(); }, true);
    node.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); hide(); ed.focus(); } });

    let t = null;
    ed.onDidChangeCursorSelection(() => {
        clearTimeout(t);
        if (open) return;
        t = setTimeout(() => {
            const s = ed.getSelection();
            const text = s && !s.isEmpty() ? ed.getModel().getValueInRange(s) : "";
            if (!text.trim() || !settings.get("editor.askOnSelect", true) || editor.getEditSource?.() === "agent") return hide();
            button();
            place({ lineNumber: s.startLineNumber, column: ed.getModel().getLineFirstNonWhitespaceColumn(s.startLineNumber) || 1 });
        }, 250);
    });
    ed.onDidBlurEditorWidget(() => { if (!open) setTimeout(() => { if (!node.contains(document.activeElement)) hide(); }, 150); });
    ed.addAction({
        id: "volt.ai-ask",
        label: "Ask About This Code",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 2,
        run: () => {
            const r = range();
            if (!r) return;
            place({ lineNumber: r.from, column: ed.getModel().getLineFirstNonWhitespaceColumn(r.from) || 1 });
            menu();
        },
    });
}
