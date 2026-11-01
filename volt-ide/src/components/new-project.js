// New project — one sheet, no steps. Either describe what the device should do
// (the project is created and the description goes to the Assistant, which
// writes the program) or start from a starter, previewed as you pick it. The
// board, name and folder sit on one line at the bottom; Create is always one
// click away. The first run shows the same sheet with a welcome.

import { createProject, listProjects } from "../services/projects.js";
import * as settings from "../services/settings.js";
import { AGENT_ICON } from "./assistant-panel.js";

const BOARDS = [
    { id: "esp32", label: "ESP32" },
    { id: "rp2040", label: "RP2040", soon: true },
];
const IDEAS = [
    "Turn on a fan when the room is warmer than 28 °C",
    "Water a plant when the soil gets dry",
    "Text me when the door opens at night",
];
const AGENT_NAME = { claude: "Claude Code", codex: "Codex" };
const ICON = {
    blank: `<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5v4h4"/>`,
    blink: `<circle cx="12" cy="10" r="4.5"/><path d="M10 17h4M10.5 20h3M12 2.5v1.5M4.5 10H3M21 10h-1.5M6.7 4.7l1 1M17.3 4.7l-1 1"/>`,
    wifi: `<path d="M3.5 9.5a12 12 0 0 1 17 0M6.5 12.5a7.8 7.8 0 0 1 11 0M9.5 15.5a3.5 3.5 0 0 1 5 0"/><circle cx="12" cy="18.5" r="1"/>`,
    button: `<circle cx="12" cy="12" r="4"/><rect x="4" y="4" width="16" height="16" rx="3"/>`,
    states: `<rect x="3" y="4" width="7" height="5" rx="1.5"/><rect x="14" y="4" width="7" height="5" rx="1.5"/><rect x="8.5" y="15" width="7" height="5" rx="1.5"/><path d="M10 6.5h4M18 9l-3.5 6M6.5 9l3 6"/>`,
    timer: `<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/>`,
    lock: `<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.3"/>`,
};
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const VALID = /^[a-zA-Z0-9_\- ]+$/;
const STOP = new Set("a an the when it its my me to of in on at and or if is are be for with from by that this then so get gets every each".split(" "));

// slug(text) — a short project name from a description: its first three meaningful words.
function slug(text) {
    const words = String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w && !STOP.has(w));
    return words.slice(0, 3).join("-").slice(0, 40) || "my-project";
}

/** show({ onCreated(path, chip, ask), welcome, onClose }) — open the sheet. */
export async function show({ onCreated, welcome = false, onClose } = {}) {
    document.getElementById("npOverlay")?.remove();
    const starters = await window.volt.projectTemplates().catch(() => []);
    const taken = new Set((await listProjects().catch(() => [])).map(p => String(p.name).toLowerCase()));
    const folder = await window.volt.projectsDir().catch(() => "~/Volt");
    const home = folder.replace(/^\/(Users|home)\/[^/]+/, "~");

    const state = { ask: "", starter: "blink", chip: "esp32", name: "", nameTouched: false, agent: null };
    const overlay = document.createElement("div");
    overlay.id = "npOverlay";
    overlay.className = "overlay np-overlay";
    overlay.innerHTML = `
      <div class="np-sheet" role="dialog" aria-modal="true" aria-labelledby="npTitle">
        <header class="np-head">
          <div>
            <h2 id="npTitle">${welcome ? "Welcome to Volt" : "New project"}</h2>
            <p>${welcome ? "Make your first project. Say what it should do, or start from a template." : "Say what it should do, or start from a template."}</p>
          </div>
          <button type="button" class="np-x" aria-label="Close">×</button>
        </header>
        <div class="np-body">
          <div class="np-left">
            <label class="np-label" for="npAsk">Describe it</label>
            <div class="np-askbox">
              <textarea id="npAsk" rows="3" placeholder="${esc(IDEAS[0])}…"></textarea>
              <div class="np-agent" aria-live="polite"></div>
            </div>
            <div class="np-ideas">${IDEAS.map(i => `<button type="button" class="np-idea">${esc(i)}</button>`).join("")}</div>
            <div class="np-or"><span>or start from a template</span></div>
            <div class="np-starters" role="radiogroup" aria-label="Starter">
              ${starters.map(s => `
                <button type="button" class="np-starter" role="radio" data-id="${esc(s.id)}">
                  <span class="np-starter-ico">${svg(ICON[s.icon] || ICON.blank)}</span>
                  <span class="np-starter-text"><b>${esc(s.label)}</b><small>${esc(s.desc)}</small></span>
                </button>`).join("")}
            </div>
          </div>
          <div class="np-right" aria-live="polite"></div>
        </div>
        <footer class="np-foot">
          <div class="np-field">
            <span class="np-label">Board</span>
            <div class="np-boards" role="radiogroup" aria-label="Board">
              ${BOARDS.map(b => `<button type="button" role="radio" class="np-board" data-id="${b.id}"${b.soon ? ` disabled title="Coming soon"` : ""}>${b.label}${b.soon ? `<em>soon</em>` : ""}</button>`).join("")}
            </div>
          </div>
          <div class="np-field np-namefield">
            <label class="np-label" for="npName">Name</label>
            <input id="npName" type="text" spellcheck="false" autocomplete="off">
            <small class="np-where"></small>
          </div>
          <div class="np-actions">
            <button type="button" class="np-btn np-cancel">${welcome ? "Skip" : "Cancel"}</button>
            <button type="button" class="np-btn np-create">Create project</button>
          </div>
        </footer>
      </div>`;
    document.body.appendChild(overlay);

    const $ = (s) => overlay.querySelector(s);
    const ask = $("#npAsk"), nameEl = $("#npName");
    const mode = () => (state.ask.trim() ? "ask" : "starter");

    const unique = (base) => {
        let n = base, i = 2;
        while (taken.has(n.toLowerCase())) n = `${base}-${i++}`;
        return n;
    };
    const autoName = () => {
        if (state.nameTouched) return;
        state.name = unique(mode() === "ask" ? slug(state.ask) : state.starter === "empty" ? "my-project" : state.starter);
        nameEl.value = state.name;
    };
    const nameError = () => {
        const n = state.name.trim();
        if (!n) return "Give it a name.";
        if (!VALID.test(n)) return "Use letters, numbers, spaces, - and _ only.";
        if (taken.has(n.toLowerCase())) return `A project called “${n}” already exists.`;
        return "";
    };
    const agentReady = () => state.agent && state.agent.found && state.agent.loggedIn;

    function draw() {
        const m = mode();
        overlay.querySelectorAll(".np-starter").forEach(b => {
            const on = m === "starter" && b.dataset.id === state.starter;
            b.classList.toggle("is-on", on);
            b.setAttribute("aria-checked", on);
        });
        overlay.querySelectorAll(".np-board").forEach(b => {
            const on = b.dataset.id === state.chip;
            b.classList.toggle("is-on", on);
            b.setAttribute("aria-checked", on);
        });
        overlay.querySelector(".np-askbox").classList.toggle("is-on", m === "ask");

        const a = state.agent;
        const who = a ? AGENT_NAME[a.provider] || "The assistant" : "";
        $(".np-agent").innerHTML = !a ? `<span class="np-dim">Checking your AI agent…</span>`
            : (agentReady() ? `${AGENT_ICON[a.provider] || ""}<span>${esc(who)} writes it with you</span>`
            : `<span class="np-warn">${esc(who)} isn't ${a.found ? "signed in" : "installed"}.</span> <button type="button" class="np-link np-setup">Set it up</button>`)
              + `<label class="np-change">Change<select aria-label="AI agent">${Object.entries(AGENT_NAME).map(([k, n]) =>
                  `<option value="${k}"${k === a.provider ? " selected" : ""}>${n}</option>`).join("")}</select></label>`;

        const s = starters.find(x => x.id === state.starter);
        $(".np-right").innerHTML = m === "ask"
            ? `<div class="np-next">
                 <h3>What happens next</h3>
                 <ol>
                   <li><b>Volt creates</b> <code>${esc(state.name || "the project")}</code> for the ${state.chip.toUpperCase()} and opens it.</li>
                   <li><b>${esc(who || "The assistant")}</b> reads your request, picks the parts and pins, and writes <code>main.volt</code> in the editor.</li>
                   <li><b>It checks</b> that the program compiles, and asks you when something needs a choice.</li>
                   <li><b>You review</b> every edit, undo any of them, then upload to the board.</li>
                 </ol>
               </div>`
            : `<div class="np-preview"><div class="np-preview-head"><span>main.volt</span><small>${esc(s ? s.label : "")}</small></div><pre><code>${esc(s ? s.source : "")}</code></pre></div>`;

        const err = nameError();
        const where = $(".np-where");
        where.textContent = err || `${home}/${state.name.trim()}`;
        where.classList.toggle("is-err", !!err && state.name !== "");
        nameEl.setAttribute("aria-invalid", !!err);
        const blocked = !!err || (m === "ask" && !agentReady());
        $(".np-create").disabled = blocked;
        $(".np-create").textContent = m === "ask" ? "Create and write it" : "Create project";
    }

    let closed = false, cleanup = () => {};
    function close() {
        if (closed) return;
        closed = true;
        cleanup();
        document.removeEventListener("keydown", onKey, true);
        overlay.classList.add("is-closing");
        setTimeout(() => overlay.remove(), 160);
        if (onClose) onClose();
    }
    async function create() {
        if ($(".np-create").disabled) return;
        const btn = $(".np-create");
        btn.disabled = true;
        btn.textContent = "Creating…";
        const m = mode();
        try {
            const path = await createProject(state.name.trim(), state.chip, m === "ask" ? "empty" : state.starter);
            closed = true;
            cleanup();
            document.removeEventListener("keydown", onKey, true);
            overlay.remove();
            if (onClose) onClose();
            if (path && onCreated) onCreated(path, state.chip, m === "ask" ? state.ask.trim() : null);
        } catch (e) {
            const where = $(".np-where");
            where.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
            where.classList.add("is-err");
            btn.textContent = m === "ask" ? "Create and write it" : "Create project";
            btn.disabled = false;
        }
    }
    function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); create(); }
        else if (e.key === "Enter" && e.target === nameEl) { e.preventDefault(); create(); }
    }
    document.addEventListener("keydown", onKey, true);

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) return close();
        const t = e.target.closest("button");
        if (!t) return;
        if (t.classList.contains("np-x") || t.classList.contains("np-cancel")) close();
        else if (t.classList.contains("np-create")) create();
        else if (t.classList.contains("np-starter")) { state.starter = t.dataset.id; state.ask = ""; ask.value = ""; autoName(); draw(); }
        else if (t.classList.contains("np-board") && !t.disabled) { state.chip = t.dataset.id; draw(); }
        else if (t.classList.contains("np-idea")) { state.ask = t.textContent; ask.value = state.ask; autoName(); draw(); ask.focus(); }
        else if (t.classList.contains("np-setup")) { import("./settings.js").then(m => m.show("assistant")); }
    });
    overlay.addEventListener("change", (e) => {
        if (!e.target.closest(".np-change")) return;
        state.agent = null;
        draw();
        settings.set("assistant.provider", e.target.value).then(() => window.volt.assistant.status())
            .then(st => { state.agent = st; if (!closed) draw(); });
    });
    ask.addEventListener("input", () => { state.ask = ask.value; autoName(); draw(); });
    nameEl.addEventListener("input", () => { state.name = nameEl.value; state.nameTouched = !!nameEl.value.trim(); draw(); });

    autoName();
    draw();
    requestAnimationFrame(() => ask.focus());
    window.volt.assistant.status().then(st => { state.agent = st; if (!closed) draw(); }).catch(() => { state.agent = { found: false }; draw(); });
    // The agent may be set up meanwhile (the link above, or a terminal): look again.
    const recheck = () => { if (!closed && !agentReady()) window.volt.assistant.status().then(st => { state.agent = st; if (!closed) draw(); }); };
    const unsubscribe = settings.onChange((key) => { if (key !== "assistant.provider" && String(key).startsWith("assistant")) recheck(); });
    ask.addEventListener("focus", recheck);
    window.addEventListener("focus", recheck);
    cleanup = () => { unsubscribe(); window.removeEventListener("focus", recheck); };
}
