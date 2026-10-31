// Assistant panel — chat with the user's own Claude Code (src/main/claude-host.js).
// Streams replies, shows each tool step, asks before anything that isn't
// auto-approved (approval cards), and can Stop or start a New chat.

import { open as openPanel } from "./side-panel.js";

const api = () => window.volt.assistant;

let getProject = () => null;
let root = null;        // panel body element
let shownProject = null;
let busy = false;
let live = null;        // the streaming text element of the current reply
let hooked = false;
const steps = new Map(); // tool_use id → step element

export function init(ctx) {
    getProject = ctx.getProject;
    if (hooked) return;
    hooked = true;
    api().onEvent(({ project, entry }) => {
        if (!root || project !== shownProject) return;
        draw(entry, true);
    });
}

/** renderInto(body) — (re)draw the panel for the open project. */
export async function renderInto(body) {
    root = body;
    const project = getProject();
    if (!project) { body.innerHTML = `<div class="as-empty">Open a project to chat with Claude.</div>`; shownProject = null; return; }
    if (shownProject === project && body.querySelector(".as-wrap")) return;
    shownProject = project;
    body.innerHTML = `<div class="as-empty">Looking for Claude Code…</div>`;
    const st = await api().status();
    if (getProject() !== project) return;
    if (!st.found || !st.loggedIn) return setup(body, st);
    body.innerHTML = `
      <div class="as-wrap">
        <div class="as-bar">
          <select class="as-model" title="Model">
            <option value="sonnet">Sonnet</option><option value="opus">Opus</option>
          </select>
          <span class="as-plan" title="Runs Claude Code ${esc(st.version || "")} signed in with your account">Using your Claude plan</span>
          <button class="as-new" title="Start a new chat">New chat</button>
        </div>
        <div class="as-log" aria-live="polite"></div>
        <form class="as-compose">
          <textarea rows="2" placeholder="Ask Claude to change this program…"></textarea>
          <button type="submit" class="as-send">Send</button>
        </form>
      </div>`;
    const sel = body.querySelector(".as-model");
    const all = await window.volt.settingsAll?.().catch(() => null) || {};
    sel.value = all["assistant.model"] || "sonnet";
    sel.onchange = () => window.volt.settingsSet?.("assistant.model", sel.value);
    body.querySelector(".as-new").onclick = async () => {
        await api().newChat(project);
        shownProject = null;
        renderInto(body);
    };
    const form = body.querySelector(".as-compose");
    const ta = form.querySelector("textarea");
    ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    form.onsubmit = async (e) => {
        e.preventDefault();
        if (busy) { api().stop(project); return; }
        const text = ta.value.trim();
        if (!text) return;
        ta.value = "";
        try { await api().send(project, text); }
        catch (err) { draw({ t: "error", text: clean(err.message) }, true); }
    };

    steps.clear();
    live = null;
    const h = await api().history(project);
    for (const entry of h.entries) draw(entry, false);
    for (const entry of h.pending) draw(entry, false);
    setBusy(h.busy);
    scroll();
}

function setup(body, st) {
    const install = "curl -fsSL https://claude.ai/install.sh | bash";
    body.innerHTML = !st.found
        ? `<div class="as-setup"><h4>Use Claude in Volt</h4>
             <p>Volt runs Claude Code on your own Claude plan. Install it, then sign in once:</p>
             <pre>${esc(install)}</pre><pre>claude</pre>
             <p class="as-dim">Already installed somewhere else? Set its path in Settings → Assistant.</p>
             <button class="as-retry">Check again</button></div>`
        : `<div class="as-setup"><h4>Sign in to Claude Code</h4>
             <p>Claude Code is installed but not signed in. In a terminal, run:</p>
             <pre>claude</pre><p>and sign in with your Claude account. Volt never sees your password or keys.</p>
             <button class="as-retry">Check again</button></div>`;
    body.querySelector(".as-retry").onclick = () => { shownProject = null; renderInto(body); };
}

// ---- drawing entries ----

function draw(entry, fresh) {
    const log = root && root.querySelector(".as-log");
    if (!log) return;
    switch (entry.t) {
    case "busy": setBusy(entry.on); return;
    case "delta":
        if (!live) { live = el("div", "as-msg as-claude is-live"); log.append(live); live._text = ""; }
        live._text += entry.text;
        live.innerHTML = md(live._text);
        break;
    case "text":
        if (live) { live.remove(); live = null; }
        log.append(html("div", "as-msg as-claude", md(entry.text)));
        break;
    case "user":
        log.append(html("div", "as-msg as-user", esc(entry.text).replace(/\n/g, "<br>")));
        break;
    case "tool": {
        if (live) { live.remove(); live = null; }
        const s = html("details", "as-step is-running",
            `<summary><span class="as-dot"></span>${esc(stepLabel(entry))}</summary><pre></pre>`);
        steps.set(entry.id, s);
        log.append(s);
        break;
    }
    case "tool_result": {
        const s = steps.get(entry.id);
        if (!s) return;
        s.classList.remove("is-running");
        s.classList.add(entry.ok ? "is-ok" : "is-fail");
        s.querySelector("pre").textContent = entry.summary || "";
        break;
    }
    case "approval":
        card(log, entry);
        // Claude waits on the answer: bring the card into view if the panel is closed.
        if (fresh && !root.offsetParent) openPanel("assistant");
        break;
    case "decision": {
        const c = log.querySelector(`.as-approve[data-id="${CSS.escape(entry.id)}"]`);
        if (c) settle(c, entry.allow);
        break;
    }
    case "result":
        if (live) { live.classList.remove("is-live"); live = null; }
        if (!entry.ok && entry.error) log.append(html("div", "as-msg as-error", esc(clean(entry.error))));
        break;
    case "error":
        log.append(html("div", "as-msg as-error", esc(entry.text)));
        break;
    default: return;
    }
    if (fresh) scroll();
}

function card(log, entry) {
    const c = html("div", "as-approve",
        `<div class="as-q">Claude wants to <b>${esc(actionText(entry))}</b></div>
         ${detail(entry) ? `<pre>${esc(detail(entry))}</pre>` : ""}
         ${entry.tool === "Write" && typeof (entry.input || {}).content === "string"
            ? `<pre class="as-content">${esc(entry.input.content) || "(empty file)"}</pre>` : ""}
         <div class="as-actions"><button class="as-allow">Allow once</button><button class="as-deny">Deny</button></div>`);
    c.dataset.id = entry.id;
    c.querySelector(".as-allow").onclick = () => api().decide(shownProject, entry.id, true);
    c.querySelector(".as-deny").onclick = () => api().decide(shownProject, entry.id, false);
    log.append(c);
}

function settle(c, allow) {
    const a = c.querySelector(".as-actions");
    if (a) a.outerHTML = `<div class="as-dim">${allow ? "Allowed" : "Denied"}</div>`;
    c.classList.add(allow ? "is-allowed" : "is-denied");
}

const ACTIONS = { ide_build: "build the program", ide_run: "build and flash the board", ide_save: "save the file",
    ide_open: "open another project", ide_new_project: "create a new project", library_write: "write a device library",
    library_request_approval: "ask you to approve a device library", Edit: "edit a file", Write: "write a file" };
function actionText(e) { return ACTIONS[e.tool] || `use ${e.tool}`; }
function detail(e) {
    const i = e.input || {};
    if (i.file_path) return i.file_path;
    if (e.tool === "ide_new_project") return `${i.name || ""} (${i.chip || ""})`;
    const s = JSON.stringify(i);
    return s && s !== "{}" ? s.slice(0, 300) : "";
}

const STEP = { volt_spec: "Read the Volt reference", device_card: "Looked up", list_devices: "Searched devices",
    check: "Checked the program", review: "Reviewed against your request", ide_read: "Read the program",
    ide_edit: "Edited the program", ide_status: "Looked at the IDE", ide_diagnostics: "Read the problems",
    ide_build: "Built", ide_run: "Flashed the board", ide_serial: "Read serial output", ide_screenshot: "Took a screenshot",
    ide_show: "Opened a view", Read: "Read" };
function stepLabel(e) {
    const i = e.input || {};
    const base = STEP[e.name] || e.name;
    if (e.name === "device_card") return `${base} ${i.name || i.device || ""}`.trim();
    if (e.name === "Read") return `${base} ${String(i.file_path || "").split(/[\\/]/).pop()}`;
    return base;
}

function setBusy(on) {
    busy = !!on;
    const b = root && root.querySelector(".as-send");
    if (b) { b.textContent = busy ? "Stop" : "Send"; b.classList.toggle("is-stop", busy); }
    if (!busy && live) { live.classList.remove("is-live"); live = null; }
}

// ---- helpers ----

function scroll() { const log = root && root.querySelector(".as-log"); if (log) log.scrollTop = log.scrollHeight; }
function el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }
function html(tag, cls, inner) { const e = el(tag, cls); e.innerHTML = inner; return e; }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function clean(m) { return String(m || "").replace(/^Error invoking remote method '[^']+': (Error: )?/, ""); }

// Minimal markdown: fenced code, inline code, bold, line breaks. Escapes first.
function md(text) {
    const parts = String(text).split(/```[\w-]*\n?/);
    return parts.map((p, i) => i % 2
        ? `<pre class="as-code">${esc(p.replace(/\n$/, ""))}</pre>`
        : esc(p).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>"))
        .join("");
}
