// AI agent requests from the bridge (src/main/agent-bridge.js): the agent
// works in this window — reads and edits the open program, switches views,
// builds and runs — through the same functions the toolbar uses.

import { userEditsPending } from "./components/history.js";
import * as editor from "./components/editor.js";
import * as diagramsView from "./components/diagrams-view.js";
import * as bottomPanel from "./components/bottom-panel.js";
import * as overlay from "./components/agent-overlay.js";

const DIAGRAMS = { state: "statemachine", sequence: "sequence" };
const TARGETS = {
    editor: "editorArea", diagrams: "diagramsView", board: "boardView",
    output: "bottomPanel", side: "sidePanel", toolbar: "toolbar",
};

let ctx = null;
let currentClient = null; // the app behind the agent call being handled (for history)
let view = "code";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const base = (p) => (p || "").split(/[\\/]/).pop();

function needFile() {
    if (!ctx.getFile()) throw new Error("No project is open in the IDE. Use ide_open first.");
}

function note(text, opts) {
    bottomPanel.appendOutput("Agent: " + text, "info", opts);
    announce("AI agent " + text);
}

// announce speaks text to screen readers (polite live region).
function announce(text) {
    let el = document.getElementById("agentAnnounce");
    if (!el) {
        el = document.createElement("div");
        el.id = "agentAnnounce";
        el.className = "sr-only";
        el.setAttribute("aria-live", "polite");
        document.body.appendChild(el);
    }
    el.textContent = "";
    setTimeout(() => { el.textContent = text; }, 50);
}

const handlers = {
    // paint resolves after the next frame has rendered (or 300 ms if hidden).
    async paint() {
        await Promise.race([
            new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
            sleep(300),
        ]);
        return {};
    },

    async status() {
        const device = ctx.deviceSelector.getSelected();
        return {
            project: ctx.getProject() || null,
            file: ctx.getFile() || null,
            unsaved: ctx.getFile() ? editor.isUnsaved() : false,
            chip: ctx.getFile() ? ctx.chipSelector.getChip() : null,
            board: device ? { port: device.port, chip: device.chip } : null,
            boards: ctx.deviceSelector.getDevices().map(d => ({ port: d.port, chip: d.chip, desc: d.desc })),
            monitoring: await window.volt.isMonitoring(),
            view,
        };
    },

    async open({ path }) {
        if (!path) throw new Error("path is required");
        if (ctx.getFile() && editor.isUnsaved()) {
            throw new Error(`${base(ctx.getFile())} has unsaved changes. Save them (ide_save) or ask the user first.`);
        }
        const isFile = path.endsWith(".volt");
        const dir = isFile ? path.replace(/[\\/][^\\/]+$/, "") : path;
        await ctx.loadProject(dir, isFile ? path : undefined);
        note(`opened ${base(ctx.getFile())}`);
        return handlers.status();
    },

    async read() {
        needFile();
        return { path: ctx.getFile(), source: editor.getValue(), unsaved: editor.isUnsaved(), ...editor.getCursor() };
    },

    async edit({ source, edits, save }) {
        needFile();
        if (typeof source !== "string" && !(Array.isArray(edits) && edits.length)) {
            throw new Error("Give source (the whole program) or edits.");
        }
        // Unsaved edits are the user's: record them as theirs before the agent's change lands.
        if (editor.isUnsaved() && userEditsPending()) await ctx.onSave({ quiet: true });
        document.dispatchEvent(new CustomEvent("volt:agent-edit", { detail: { client: currentClient } }));
        const line = editor.applyAgentEdit({ text: source, edits });
        note(`edited ${base(ctx.getFile())} (line ${line}) · Undo`, { onClick: () => editor.undo() });
        if (save) await ctx.onSave({ quiet: true });
        return { path: ctx.getFile(), saved: !!save, diagnostics: await diagnostics() };
    },

    async save() {
        needFile();
        await ctx.onSave({ quiet: true });
        return { path: ctx.getFile() };
    },

    async highlight({ lines, note: text }) {
        needFile();
        const ls = (lines || []).map(Number).filter(n => n > 0);
        editor.highlightLines(ls, text);
        if (ls.length) announce(`AI agent highlighted line${ls.length > 1 ? "s" : ""} ${ls.join(", ")}${text ? ": " + text : ""}`);
        return {};
    },

    async point({ marks, keep }) {
        const res = await overlay.point({ marks, keep });
        const n = res.marks.length;
        if (n) announce(`AI agent pointed at ${n} place${n > 1 ? "s" : ""}: ${(marks || []).map(m => m.note).filter(Boolean).join("; ")}`);
        return res;
    },

    async note_events({ since }) {
        return overlay.noteEvents(Number(since) || 0);
    },

    async select(params) {
        needFile();
        return overlay.select(params);
    },

    async walkthrough(params) {
        announce(`AI agent started a walkthrough${params.title ? ": " + params.title : ""}. Use Next and Back, or Escape to close.`);
        const res = await overlay.walkthrough(params);
        note(`walkthrough ${res.status}${res.step ? ` at step ${res.step}/${res.total}` : ""}`);
        return res;
    },

    async ask(params) {
        announce("AI agent asks: " + params.question);
        return overlay.ask(params);
    },

    async show({ view: v, diagram }) {
        if (!["code", "diagrams", "board"].includes(v)) throw new Error("view must be code, diagrams or board");
        if (v !== "code") needFile();
        diagramsView.showView(v);
        if (v === "diagrams") {
            if (diagram && !DIAGRAMS[diagram]) throw new Error("diagram must be state or sequence");
            if (diagram) diagramsView.showDiagram(DIAGRAMS[diagram]);
        }
        await sleep(v === "code" ? 100 : 900);   // let Mermaid / the board view paint
        return { view: v, diagram: v === "diagrams" ? diagram || null : null };
    },

    async rect({ target }) {
        const id = TARGETS[target];
        if (!id) throw new Error(`target must be window or one of: ${Object.keys(TARGETS).join(", ")}`);
        const el = document.getElementById(id);
        const r = el && el.getBoundingClientRect();
        if (!r || r.width < 2 || r.height < 2) throw new Error(`The ${target} area is not visible; switch to it with ide_show first.`);
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    },

    async diagnostics() {
        needFile();
        return { diagnostics: await diagnostics() };
    },

    async build() {
        needFile();
        note("building");
        await ctx.onCheck();
        return { problems: (await diagnostics()).filter(d => d.severity === "error") };
    },

    async run({ port } = {}) {
        needFile();
        await ctx.deviceSelector.scan();
        if (port && !ctx.deviceSelector.selectPort(port)) throw new Error(`No board on ${port}. ${boardList()}`);
        if (!ctx.deviceSelector.getSelected()) throw new Error(`No board is selected in the IDE. ${boardList()}`);
        note("building and flashing");
        await ctx.onRun();
        return { problems: (await diagnostics()).filter(d => d.severity === "error") };
    },

    async monitor_start() {
        const device = ctx.deviceSelector.getSelected();
        if (!device) throw new Error("No board is connected or selected in the IDE.");
        if (await window.volt.isMonitoring()) return {};
        await window.volt.startMonitor(device.port);
        bottomPanel.setMonitorConnected(true);
        note(`serial monitor on ${device.port}`);
        return {};
    },
};

// boardList names the connected boards for an error an agent can act on.
function boardList() {
    const ds = ctx.deviceSelector.getDevices();
    if (!ds.length) return "No boards are connected — ask the user to plug one in over USB.";
    return "Connected: " + ds.map(d => `${d.port} (${d.chip})`).join(", ") + ". Pass one as port.";
}

async function diagnostics() {
    const res = await window.volt.checkCode(editor.getValue());
    return (Array.isArray(res) ? res : []).map(d => ({
        line: d.line, col: d.col, severity: d.severity, message: d.message, hint: d.hint || undefined,
    }));
}

/**
 * init({ getProject, getFile, loadProject, onSave, onCheck, onRun,
 *        deviceSelector, chipSelector })
 */
export function init(context) {
    ctx = context;
    document.addEventListener("volt:view", (e) => { view = e.detail.view; });
    window.volt.onAgentCall(async ({ id, method, params, client }) => {
        const h = handlers[method];
        if (!h) return window.volt.agentReply(id, null, `Unknown IDE method: ${method}`);
        try {
            currentClient = client || null;
            window.volt.agentReply(id, await h(params || {}), null);
        } catch (e) {
            window.volt.agentReply(id, null, e.message || String(e));
        }
    });
}
