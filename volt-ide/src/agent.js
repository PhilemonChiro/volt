// AI agent requests from the bridge (src/main/agent-bridge.js): the agent
// works in this window — reads and edits the open program, switches views,
// builds and runs — through the same functions the toolbar uses.

import * as editor from "./components/editor.js";
import * as diagramsView from "./components/diagrams-view.js";
import * as bottomPanel from "./components/bottom-panel.js";
import * as overlay from "./components/agent-overlay.js";

const DIAGRAMS = { state: "statemachine", sequence: "sequence" };
const TARGETS = {
    editor: "editorArea", diagrams: "diagramsView", board: "boardView",
    output: "bottomPanel", side: "sidePanel", toolbar: "toolbar",
};
const IDLE_MS = 10 * 60_000;

let ctx = null;
let currentClient = null; // the app behind the agent call being handled (for history)
let view = "code";
let idleTimer = null;

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

// AI button next to the board badge. Its panel walks the user through
// connecting an AI app (pick app → Connect → wait for it → try a prompt);
// once an agent is working it offers Disconnect / Reconnect.
// state: "none" | "on" | "off"
let aiState = "none";
let aiClient = null;     // app name reported by `volt mcp` ("Cursor")
let picked = null;       // app id chosen in the panel
let setupResult = null;  // last `volt ai setup` answer for `picked`
let clients = null;      // `volt ai list` answer

const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const CLI = { "claude-code": "claude", codex: "codex", gemini: "gemini" };

// aiConnected names the external AI app working in this IDE right now, or null.
export function aiConnected() { return aiState === "on" ? (aiClient || "AI") : null; }
let lastAiState = null;
function renderAiButton() {
    if (aiState !== lastAiState) {
        lastAiState = aiState;
        document.dispatchEvent(new CustomEvent("volt:ai-state"));
    }
    const btn = document.getElementById("aiButton");
    if (!btn) return;
    btn.dataset.state = aiState;
    const who = aiClient || "AI";
    document.getElementById("aiLabel").textContent =
        { none: "Connect AI", on: `${who} connected`, off: "AI disconnected" }[aiState];
    btn.title = { none: "Connect an AI assistant to this IDE", on: `${who} is working in this IDE`, off: "The AI agent is disconnected" }[aiState];
    if (!document.getElementById("aiPop").hidden) renderAiPop();
}

function copyBox(text, multiline, prose) {
    const body = prose ? `<span>${esc(text)}</span>` : multiline ? `<pre>${esc(text)}</pre>` : `<code>${esc(text)}</code>`;
    return `<div class="ai-code${prose ? " ai-prompt" : ""}">${body}<button type="button" class="ai-copy" data-copy="${esc(text)}" aria-label="Copy">Copy</button></div>`;
}

function tryPrompts() {
    const file = base(ctx.getFile()) || "my program";
    return [
        `Open ${file} in the Volt IDE and explain what it does.`,
        `Check ${file} in the Volt IDE and fix any problems.`,
        `Add a status LED to ${file} that blinks while it runs, then check and build it in the Volt IDE.`,
    ];
}

function appStatus(c) {
    if (c.stale) return "Needs update";
    if (c.configured) return "Set up";
    return c.installed ? "Installed" : "Not found";
}

async function pickerHTML() {
    if (!clients) clients = await window.volt.agentAI("list");
    if (!clients || !clients.clients) return `<p class="ai-err">Couldn't look for AI apps: ${esc(clients && clients.message || "unknown error")}</p>`;
    const list = [...clients.clients].sort((a, b) => (b.installed - a.installed) || (b.configured - a.configured));
    const tiles = list.map(c => `
        <button type="button" class="ai-app${c.id === picked ? " is-picked" : ""}${c.installed ? "" : " is-missing"}"
                data-app="${c.id}" aria-pressed="${c.id === picked}">
            <span class="ai-app-name">${esc(c.name)}</span>
            <span class="ai-app-state">${appStatus(c)}</span>
        </button>`).join("");
    return `<p class="ai-section">Which app do you use?</p>
        <div class="ai-apps" role="group" aria-label="AI apps">${tiles}</div>
        <div class="ai-detail" aria-live="polite">${detailHTML(list.find(c => c.id === picked))}</div>`;
}

function detailHTML(c) {
    if (!c) return "";
    const r = setupResult && setupResult.client === c.id ? setupResult : null;
    const project = ctx.getProject();
    const terminal = CLI[c.id] && project ? `<p class="ai-pop-step">Then in a terminal:</p>${copyBox(`cd ${project.includes(" ") ? `"${project}"` : project} && ${CLI[c.id]}`)}` : "";
    const waiting = `<p class="ai-wait"><span class="ai-spin" aria-hidden="true"></span>Waiting for ${esc(c.name)} to connect…</p>`;
    if (r && r.ok) {
        const done = `<p class="ai-ok">✓ ${esc(r.message.replace(/ \(.*\)$/, ""))}</p>`;
        const backup = r.backup ? `<p class="ai-pop-hint">Your old settings were saved as ${esc(r.backup.split(/[\\/]/).pop())}.</p>` : "";
        if (r.restart && !r.restarted) {
            // The app only reads its settings at startup: restarting is the next step, not optional.
            const failed = r.restartError
                ? `<p class="ai-err" role="alert">${esc(r.restartError)}</p>
                   <button type="button" class="ai-link" data-do="restarted">I've reopened ${esc(c.name)}</button>` : "";
            return `${done}<p><b>Next:</b> restart ${esc(c.name)} — it only loads Volt when it starts.</p>
                ${failed || `<button type="button" class="ai-action ai-primary" data-do="restart">Restart ${esc(c.name)}</button>`}${backup}`;
        }
        return `${done}<p>${esc(r.restart ? c.name + " restarted." : r.next || "")}</p>${terminal}${waiting}
            <p class="ai-pop-hint ai-slow" hidden>Still waiting? Make sure ${esc(c.name)} is open${CLI[c.id] ? " and you started a new session in your project" : ""}. If it still doesn't connect, try Manual setup below.</p>${backup}`;
    }
    const err = r ? `<p class="ai-err" role="alert">${esc(r.message)}</p>` : "";
    const how = {
        link: `${c.name} will open and ask to install Volt. Click <b>Install</b> there.`,
        command: `Volt adds itself to ${c.name} for you.`,
        file: `Volt adds itself to ${c.name}'s settings (your old settings are backed up). Then restart ${c.name}.`,
    }[c.method];
    if (c.configured && !c.stale) {
        if (c.method === "file" && !(r && r.restarted)) {
            return `<p>Volt is set up in ${esc(c.name)}. If ${esc(c.name)} was open when it was set up, restart it so it loads Volt.</p>
                <button type="button" class="ai-action ai-primary" data-do="restart">Restart ${esc(c.name)}</button>
                <button type="button" class="ai-link" data-do="setup">Set it up again</button>`;
        }
        return `<p>Volt is already set up in ${esc(c.name)}.</p>${terminal}${waiting}
            <button type="button" class="ai-link" data-do="setup">Set it up again</button>`;
    }
    const missing = c.installed ? "" : `<p class="ai-pop-hint">${esc(c.name)} wasn't found on this computer.</p>`;
    const label = c.stale ? `Update ${esc(c.name)}` : `Connect ${esc(c.name)}`;
    const why = c.stale ? `<p>${esc(c.name)} is set up with another copy of Volt.</p>` : "";
    return `${why}${missing}<p>${how}</p>${err}
        <button type="button" class="ai-action ai-primary" data-do="setup">${label}</button>`;
}

async function manualHTML() {
    const volt = await window.volt.agentVoltPath();
    const q = volt.includes(" ") ? `"${volt}"` : volt;
    const json = JSON.stringify({ mcpServers: { volt: { command: volt, args: ["mcp"] } } }, null, 2);
    return `<details class="ai-manual"><summary>Manual setup (advanced)</summary>
        <p class="ai-pop-step">Any MCP app — the server to add:</p>${copyBox(json, true)}
        <p class="ai-pop-step">Claude Code command:</p>${copyBox(`claude mcp add --scope user volt -- ${q} mcp`)}
    </details>`;
}

let popView = "home";      // home | apps

function backHead(title) {
    return `<div class="ai-head"><button type="button" class="ai-back" data-view="home" aria-label="Back">‹</button><h3 id="aiPopTitle">${esc(title)}</h3></div>`;
}

function statusHTML() {
    const who = esc(aiClient || "An AI app");
    if (aiState === "on") return `<div class="ai-status is-on"><span class="ai-sdot" aria-hidden="true"></span><span><b>${who}</b> is connected</span>
        <button type="button" class="ai-mini" data-do="off" title="Stop it from reading or changing anything here">Disconnect</button></div>`;
    if (aiState === "off") return `<div class="ai-status is-off"><span class="ai-sdot" aria-hidden="true"></span><span>AI disconnected — it can't read or change anything here</span>
        <button type="button" class="ai-mini ai-mini-primary" data-do="on">Reconnect</button></div>`;
    return `<div class="ai-status"><span class="ai-sdot" aria-hidden="true"></span><span>No AI connected yet</span></div>`;
}

function homeHTML() {
    const prompts = aiState === "on" ? `<p class="ai-section">Try asking ${esc(aiClient || "it")}</p><div class="ai-tries">${tryPrompts().map(t =>
        `<button type="button" class="ai-try" data-copy="${esc(t)}" title="Copy"><span>${esc(t)}</span><span class="ai-try-copy" aria-hidden="true">Copy</span></button>`).join("")}</div>` : "";
    return `<h3 id="aiPopTitle" class="ai-title">AI in Volt</h3>${statusHTML()}
        <div class="ai-cards">
          <div class="ai-card">
            <div class="ai-card-icon" aria-hidden="true">⇄</div>
            <div class="ai-card-body"><b>Your AI app</b><span>Claude, Codex, Cursor, VS Code and more</span>
              <span class="ai-card-state${aiState === "on" ? " is-ok" : ""}">${aiState === "on" ? `${esc(aiClient || "An app")} connected` : "Not connected"}</span></div>
            <button type="button" class="ai-action${aiState === "on" ? "" : " ai-primary"}" data-view="apps">${aiState === "on" ? "Change" : "Connect an app"}</button>
          </div>
        </div>${prompts}`;
}

async function setupPrompt() {
    const volt = await window.volt.agentVoltPath();
    return `Add an MCP server to your own settings so you can work in my Volt IDE: name "volt", command "${volt}", arguments ["mcp"] (stdio). Use your built-in command for adding MCP servers if you have one, otherwise edit your MCP config file. Then tell me if you need to be restarted to load it.`;
}

async function appsHTML() {
    return `${backHead("Connect an AI app")}
        <p class="ai-pop-hint">Your app reads, edits, checks and builds your program here while you watch.</p>
        ${await pickerHTML()}
        <p class="ai-section">Any other AI app</p>
        <p class="ai-pop-hint">Coding agents that can run commands or edit files (Claude Code, Codex, Cursor's agent, Gemini CLI…) can set themselves up. Paste this into the app:</p>
        ${copyBox(await setupPrompt(), false, true)}
        ${await manualHTML()}`;
}

async function renderAiPop() {
    const pop = document.getElementById("aiPop");
    const focusedApp = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.app;
    const html = popView === "apps" ? await appsHTML() : homeHTML();
    const openDetails = [...pop.querySelectorAll("details")].map(d => d.open);
    pop.innerHTML = html;
    pop.querySelectorAll("details").forEach((d, k) => { if (openDetails[k]) d.open = true; });
    const slow = pop.querySelector(".ai-slow");
    if (slow) setTimeout(() => { if (slow.isConnected) slow.hidden = false; }, 30_000);
    if (focusedApp) { const b = pop.querySelector(`[data-app="${focusedApp}"]`); if (b) b.focus(); }
}

async function onPopClick(e) {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.classList.contains("ai-try")) {
        await navigator.clipboard.writeText(b.dataset.copy);
        const c = b.querySelector(".ai-try-copy"); c.textContent = "Copied";
        announce("Copied");
        setTimeout(() => { c.textContent = "Copy"; }, 1500);
        return;
    }
    if (b.dataset.view) {
        popView = b.dataset.view;
        await renderAiPop();
        (document.querySelector("#aiPop .ai-back, #aiPop .ai-primary, #aiPop button") || {}).focus?.();
        return;
    }
    if (b.classList.contains("ai-copy")) {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = "Copied";
        announce("Copied");
        setTimeout(() => { b.textContent = "Copy"; }, 1500);
        return;
    }
    if (b.dataset.app) {
        picked = b.dataset.app;
        setupResult = null;
        await renderAiPop();
        const first = document.querySelector("#aiPop .ai-detail button");
        if (first) first.focus();
        return;
    }
    const act = b.dataset.do;
    if (act === "on" || act === "off") return setConnected(act === "on");
    if (act === "restarted" && setupResult) {
        setupResult.restarted = true;
        return renderAiPop();
    }
    if (act === "setup" || act === "restart") {
        b.disabled = true;
        b.textContent = act === "setup" ? "Connecting…" : "Restarting…";
        const r = await window.volt.agentAI(act, picked);
        if (act === "setup") {
            setupResult = r;
            clients = null; // configured state changed
        } else {
            // Restart from the "already set up" view has no setup answer yet.
            setupResult = setupResult && setupResult.client === picked ? setupResult
                : { ok: true, client: picked, restart: true, message: "Volt is set up in " + ((clients && clients.clients || []).find(x => x.id === picked) || { name: "the app" }).name };
            setupResult.restarted = r.ok;
            setupResult.restartError = r.ok ? null : r.message;
        }
        announce(r.ok ? (r.message.replace(/ \(.*\)$/, "") + ". " + (r.next || "")) : r.message);
        await renderAiPop();
        const next = document.querySelector("#aiPop .ai-detail .ai-action, #aiPop .ai-detail .ai-copy");
        if (next) next.focus();
    }
}

async function toggleAiPop(open) {
    const btn = document.getElementById("aiButton");
    const pop = document.getElementById("aiPop");
    open = open ?? pop.hidden;
    if (open) {
        clients = null; // re-detect each time the panel opens
        popView = "home";
        await renderAiPop();
        pop.hidden = false;
        (pop.querySelector(".ai-primary, .ai-app, button") || pop).focus();
    } else if (!pop.hidden) {
        pop.hidden = true;
        if (pop.contains(document.activeElement)) btn.focus();
    }
    btn.setAttribute("aria-expanded", String(open));
}

function initAiButton() {
    const btn = document.getElementById("aiButton");
    if (!btn) return;
    btn.addEventListener("click", () => toggleAiPop());
    document.getElementById("aiPop").addEventListener("click", onPopClick);
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || document.getElementById("aiPop").hidden) return;
        if (popView !== "home") { popView = "home"; renderAiPop(); } else toggleAiPop(false);
    });
    document.addEventListener("mousedown", (e) => {
        if (!e.target.closest(".ai-wrap")) toggleAiPop(false);
    });
    renderAiButton();
}

async function setConnected(on) {
    await window.volt.agentSetConnected(on);
    aiState = on ? "on" : "off";
    clearTimeout(idleTimer);
    renderAiButton();
    const pop = document.getElementById("aiPop");
    if (!pop.hidden) (pop.querySelector(".ai-action") || pop).focus();
    bottomPanel.appendOutput(on ? "AI agent reconnected" : "AI agent disconnected — it can no longer read or change anything here", "info");
    announce(on ? "AI agent reconnected" : "AI agent disconnected");
}

function showActive({ client } = {}) {
    if (aiState === "off") return;
    if (client) aiClient = client;
    if (aiState === "none") {
        announce(`${aiClient || "AI agent"} connected`);
        bottomPanel.appendOutput(`${aiClient || "AI agent"} connected`, "info");
    }
    aiState = "on";
    setupResult = null;
    renderAiButton();
    // After a long quiet spell, offer setup again rather than claim a live agent.
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { aiState = "none"; renderAiButton(); }, IDLE_MS);
}

/**
 * init({ getProject, getFile, loadProject, onSave, onCheck, onRun,
 *        deviceSelector, chipSelector })
 */
export function init(context) {
    ctx = context;
    document.addEventListener("volt:view", (e) => { view = e.detail.view; });
    initAiButton();
    window.volt.onAgentActivity(showActive);
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
