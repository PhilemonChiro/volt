// Settings → AI agents: one card per coding agent the Assistant panel can run
// (src/main/claude-host.js, src/main/codex-host.js). Each card shows whether
// the agent is installed and signed in, and its model and path; the selected
// card is the one the panel uses.

import * as settings from "../services/settings.js";
import { AGENT_ICON } from "./assistant-panel.js";

const AGENTS = [
    { id: "claude", name: "Claude Code", plan: "Claude", install: "curl -fsSL https://claude.ai/install.sh | bash", login: "claude",
      modelKey: "assistant.model", pathKey: "assistant.claudePath" },
    { id: "codex", name: "Codex", plan: "ChatGPT", install: "npm i -g @openai/codex", login: "codex login",
      modelKey: "assistant.codexModel", pathKey: "assistant.codexPath", planDefault: true },
];

const esc = (t) => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function copyRow(cmd) {
    return `<div class="aiset-cmd"><code>${esc(cmd)}</code><button type="button" class="aiset-copy" data-copy="${esc(cmd)}">Copy</button></div>`;
}

function stateHTML(a, st) {
    if (!st) return `<span class="aiset-state"><span class="aiset-spin" aria-hidden="true"></span>Checking…</span>`;
    if (!st.found) return `<span class="aiset-state is-off">Not installed</span>`;
    if (!st.loggedIn) return `<span class="aiset-state is-warn">Not signed in</span>`;
    return `<span class="aiset-state is-ok">Signed in${st.version ? ` · ${esc(st.version)}` : ""}</span>`;
}

function bodyHTML(a, st, models) {
    if (!st) return "";
    if (!st.found) return `<p>Install it, then sign in once with your ${a.plan} account:</p>${copyRow(a.install)}${copyRow(a.login)}${pathRow(a, st)}`;
    if (!st.loggedIn) return `<p>In a terminal, run this and sign in with your ${a.plan} account:</p>${copyRow(a.login)}`;
    const cur = settings.get(a.modelKey, "");
    const opts = (a.planDefault ? [`<option value="">Plan default${models[0] ? ` (${esc(models[0].label)})` : ""}</option>`] : [])
        .concat(models.map(m => `<option value="${esc(m.value)}"${m.value === cur ? " selected" : ""}>${esc(m.label)}</option>`)).join("");
    return `<label class="aiset-field"><span>Model</span><select class="settings-select" data-key="${a.modelKey}">${opts}</select></label>${pathRow(a, st)}`;
}

function pathRow(a, st) {
    const custom = settings.get(a.pathKey, "");
    return `<label class="aiset-field"><span>Path</span><input type="text" class="settings-input" data-key="${a.pathKey}"
        value="${esc(custom)}" placeholder="${esc(st.path || `Found automatically`)}" spellcheck="false"></label>`;
}

/** render(host) — draw the page into the settings pane. */
export async function render(host) {
    host.className = "aiset";
    const state = {};
    const models = {};
    const draw = () => {
        const provider = settings.get("assistant.provider", "claude");
        host.innerHTML = `
            <p class="aiset-intro">The Assistant panel runs a coding agent you already use, signed in with your own plan.
               Volt never sees your password or keys.</p>
            <div class="aiset-list" role="radiogroup" aria-label="Agent for the Assistant panel">
            ${AGENTS.map(a => {
                const on = a.id === provider;
                return `<section class="aiset-card${on ? " is-on" : ""}" data-agent="${a.id}">
                    <label class="aiset-head">
                        <input type="radio" name="aiset-agent" value="${a.id}"${on ? " checked" : ""}>
                        <span class="aiset-logo">${AGENT_ICON[a.id]}</span>
                        <span class="aiset-name">${a.name}</span>
                        ${on ? `<span class="aiset-badge">In use</span>` : ""}
                        ${stateHTML(a, state[a.id])}
                    </label>
                    <div class="aiset-body">${bodyHTML(a, state[a.id], models[a.id] || [])}</div>
                </section>`;
            }).join("")}
            </div>
            <button type="button" class="aiset-recheck">Check again</button>`;
    };
    const load = async () => {
        for (const a of AGENTS) state[a.id] = null;
        draw();
        const all = await window.volt.assistant.agents().catch(() => ({}));
        for (const a of AGENTS) {
            state[a.id] = all[a.id] || { found: false };
            if (state[a.id].loggedIn) models[a.id] = await window.volt.assistant.models(a.id).catch(() => []);
        }
        if (host.isConnected) draw();
    };

    host.addEventListener("change", async (e) => {
        const t = e.target;
        if (t.name === "aiset-agent") { await settings.set("assistant.provider", t.value); draw(); return; }
        if (t.dataset.key) await settings.set(t.dataset.key, t.value.trim());
        if (t.dataset.key && t.dataset.key.endsWith("Path")) load(); // a new path: look again
    });
    host.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.classList.contains("aiset-recheck")) load();
        if (b.dataset.copy) {
            navigator.clipboard?.writeText(b.dataset.copy);
            b.textContent = "Copied";
            setTimeout(() => { b.textContent = "Copy"; }, 1200);
        }
    });
    await load();
}
