// Assistant panel — chat with the user's own Claude Code (src/main/claude-host.js).
// Streams replies, groups tool steps, asks before anything that isn't
// auto-approved (approval cards), and can Stop or start a New chat.

import { open as openPanel } from "./side-panel.js";
import * as editor from "./editor.js";
import * as overlay from "./agent-overlay.js";
import * as settingsService from "../services/settings.js";

const api = () => window.volt.assistant;

let getProject = () => null;
let getFile = () => null;
let saveFile = async () => {};
let getContext = async () => "";   // what the user sees right now (ai-assist.js), sent with every message
let rewindAt = null;    // the user message the chat goes back to before, on the next send
let root = null;        // panel body element
let shownProject = null;
let busy = false;
let cut = false;
let marksHooked = false;      // the last turn ended early (stopped, error, or never finished)
let sendFn = null;
let live = null;        // the streaming text element of the current reply
let group = null;       // the step group tool calls are being added to
let hooked = false;
let sentAt = 0;         // when the last message was sent (guards Send double-clicks)
const steps = new Map(); // tool_use id → step element

// The agent the panel runs (Settings → AI agents), from status().
const AGENTS = {
    claude: { name: "Claude Code", short: "Claude", plan: "Claude", install: ["curl -fsSL https://claude.ai/install.sh | bash", "claude"],
              login: "claude", modelKey: "assistant.model" },
    codex: { name: "Codex", short: "Codex", plan: "ChatGPT", install: ["npm i -g @openai/codex", "codex login"],
             login: "codex login", modelKey: "assistant.codexModel" },
};
let agentId = "claude";
const agent = () => AGENTS[agentId] || AGENTS.claude;
const AG = () => agent().short;

const ICON = {
    chevron: `<svg class="as-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l5 5 5-5"/></svg>`,
    codex: `<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path clip-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/></svg>`,
    claude: `<svg viewBox="0 0 24 24" fill="#D97757" aria-hidden="true"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
    history: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 9.5V5.5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v4.5a2 2 0 0 0 2 2h1v2.5l3-2.5"/><path d="M11 12.5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2h-1v2.5L15 18h-2a2 2 0 0 1-2-2z"/></svg>`,
    spark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M10 3.5l1.6 4.9 4.9 1.6-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6z"/><path d="M18 14l.8 2.2 2.2.8-2.2.8L18 20l-.8-2.2-2.2-.8 2.2-.8z"/></svg>`,
    send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
    stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`,
    compose: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
    cross: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>`,
    down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`,
    undo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`,
    redo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>`,
    chev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`,
    shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M12 8v4M12 15.5h.01" stroke-linecap="round"/></svg>`,
    alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>`,
};
export const AGENT_ICON = { claude: ICON.claude, codex: ICON.codex };

const SUGGEST = [
    { label: "Explain how this program works", send: true },
    { label: "Look for bugs and fix them", send: true },
    { label: "Add a feature…", text: "Add " },
];

export function init(ctx) {
    getProject = ctx.getProject;
    if (ctx.getFile) getFile = ctx.getFile;
    if (ctx.onSave) saveFile = ctx.onSave;
    if (ctx.getContext) getContext = ctx.getContext;
    if (hooked) return;
    hooked = true;
    // The agent was switched (here or in Settings → AI agents): draw the panel for it.
    settingsService.onChange((key) => {
        if ((key === "assistant.provider" || key === "*") && root) { shownProject = null; renderInto(root); }
    });
    api().onEvent(({ project, entry }) => {
        if (!root || project !== shownProject) return;
        draw(entry, true);
    });
}

// A request queued by ask() for the next time the panel is drawn for that project.
let queued = null;

/** ask(project, text, opts) — open the Assistant and send text as the next
 *  message (New Project "Describe it", Fix it, Ask on a selection…).
 *  opts.context: extra notes for the agent only (build log, serial lines). */
export function ask(project, text, opts = {}) {
    queued = { project, text, context: opts.context || "" };
    shownProject = null;
    openPanel("assistant");
    if (root && root.offsetParent) renderInto(root);
}

/** renderInto(body) — (re)draw the panel for the open project. */
export async function renderInto(body) {
    root = body;
    const project = getProject();
    if (!project) { body.innerHTML = `<div class="as-empty">Open a project to chat with the assistant.</div>`; shownProject = null; return; }
    if (shownProject === project && body.querySelector(".as-wrap")) return;
    shownProject = project;
    body.innerHTML = `<div class="as-empty"><span class="as-spin"></span>Looking for ${agent().name}…</div>`;
    const st = await api().status();
    agentId = st.provider || "claude";
    if (getProject() !== project) return;
    if (!st.found || !st.loggedIn) return setup(body, st);
    body.innerHTML = `
      <div class="as-wrap">
        <div class="as-bar">
          <label class="as-status" title="Runs ${esc(agent().name)} ${esc(st.version || "")} signed in with your account. Click to switch.">${ICON[agentId]}${esc(agent().name)}${ICON.chevron}
            <select class="as-agent" aria-label="Agent">${Object.entries(AGENTS).map(([k, a]) => `<option value="${k}"${k === agentId ? " selected" : ""}>${a.name}</option>`).join("")}</select></label>
          <button class="as-iconbtn as-hist" title="Chats" aria-label="Chats" aria-haspopup="true" aria-expanded="false">${ICON.history}<span>Chats</span></button>
          <button class="as-iconbtn as-new" title="Start a new chat" aria-label="New chat">${ICON.compose}<span>New</span></button>
          <div class="as-chats" role="menu" hidden></div>
        </div>
        <div class="as-logwrap">
          <div class="as-log" aria-live="polite"></div>
          <button type="button" class="as-jump" title="Jump to latest" aria-label="Jump to latest">${ICON.down}</button>
        </div>
        <form class="as-compose">
          <div class="as-box">
            <textarea rows="1" placeholder="Ask ${AG()} to change this program…"></textarea>
            <div class="as-tools">
              <select class="as-model" title="Model"></select>
              <span class="as-hint">↵ send · ⇧↵ new line</span>
              <button type="submit" class="as-send" aria-label="Send" title="Send">${ICON.send}</button>
            </div>
          </div>
        </form>
      </div>`;
    const sel = body.querySelector(".as-model");
    const all = await window.volt.settingsAll?.().catch(() => null) || {};
    const models = await api().models().catch(() => []);
    sel.innerHTML = models.map(m => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join("");
    sel.hidden = !models.length;
    if (models.some(m => m.value === all[agent().modelKey])) sel.value = all[agent().modelKey];
    sel.onchange = () => window.volt.settingsSet?.(agent().modelKey, sel.value);
    body.querySelector(".as-agent").onchange = (e) => settingsService.set("assistant.provider", e.target.value);
    const hist = body.querySelector(".as-hist"), menu = body.querySelector(".as-chats");
    const closeMenu = () => { menu.hidden = true; hist.setAttribute("aria-expanded", "false"); };
    hist.onclick = async (e) => {
        e.stopPropagation();
        if (!menu.hidden) return closeMenu();
        const list = await api().chats(project).catch(() => []);
        menu.innerHTML = `<div class="as-chats-head">Chats in this project</div>` + (list.length ? list.map(c => `
          <button type="button" role="menuitem" class="as-chat${c.current ? " is-current" : ""}" data-id="${esc(c.id)}">
            <span class="as-chat-title">${esc(c.title || "Untitled chat")}</span>
            <span class="as-chat-meta">${c.current ? "Open now · " : ""}${c.count} message${c.count === 1 ? "" : "s"} · ${ago(c.at)}</span>
          </button>`).join("") : `<div class="as-chats-empty">No chats yet.</div>`);
        menu.hidden = false;
        hist.setAttribute("aria-expanded", "true");
        menu.querySelector(".as-chat")?.focus();
    };
    menu.onclick = async (e) => {
        const b = e.target.closest(".as-chat");
        if (!b) return;
        closeMenu();
        if (b.classList.contains("is-current") || busy) return;
        await api().openChat(project, b.dataset.id);
        shownProject = null;
        renderInto(body);
    };
    menu.onkeydown = (e) => {
        const items = [...menu.querySelectorAll(".as-chat")], i = items.indexOf(document.activeElement);
        if (e.key === "Escape") { closeMenu(); hist.focus(); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus(); }
    };
    document.addEventListener("mousedown", (e) => { if (!menu.hidden && !menu.contains(e.target) && !hist.contains(e.target)) closeMenu(); });
    body.querySelector(".as-new").onclick = async () => {
        await api().newChat(project);
        shownProject = null;
        renderInto(body);
    };
    const form = body.querySelector(".as-compose");
    const ta = form.querySelector("textarea");
    const fit = () => {
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
        form.classList.toggle("has-text", !!ta.value.trim());
    };
    ta.addEventListener("input", fit);
    const pick = (btn) => {
        if (busy) return;
        const title = btn.dataset.title;
        if (btn.classList.contains("is-free")) {
            ta.value = title + ": "; fit(); ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
            return;
        }
        btn.classList.add("is-picked");
        send(title);
    };
    ta.addEventListener("keydown", (e) => {
        if (/^[1-6]$/.test(e.key) && !ta.value && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const btn = liveChoices()?.querySelectorAll(".as-choice")[+e.key - 1];
            if (btn) { e.preventDefault(); pick(btn); return; }
        }
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    // Show the message and the thinking dots at once: on a cold start the
    // host only echoes them after Claude Code has launched (several seconds).
    const send = async (text, opts = {}) => {
        const log = body.querySelector(".as-log");
        log.querySelector(".as-welcome")?.remove();
        endGroup();
        const file = getFile();
        const before = file ? { file, source: editor.getValue() } : undefined;
        log.querySelectorAll(".as-turnbar, .as-retrybar").forEach(b => b.remove());
        cut = false;
        const mine = userBubble(text, before);
        mine.classList.add("is-pending");
        settleChoices(log, text);
        add(log, mine);
        pinned = true;
        setBusy(true);
        scroll(true);
        const rewind = rewindAt && rewindAt._at;
        try {
            const seen = await getContext().catch(() => "");
            const context = [seen, opts.context].filter(Boolean).join("\n\n");
            await api().send(project, text, { before, rewind, context });
            if (rewind) { log.querySelectorAll(".is-rewound").forEach(el => el.remove()); rewindAt = null; }
        }
        catch (err) {
            mine.remove();
            setBusy(false);
            if (!ta.value) { ta.value = text; fit(); }
            draw({ t: "error", text: clean(err.message) }, true);
        }
    };
    sendFn = send;
    form.onsubmit = (e) => {
        e.preventDefault();
        if (busy) { if (Date.now() - sentAt > 1500) api().stop(project); return; }
        const text = ta.value.trim();
        if (!text) return;
        ta.value = "";
        fit();
        sentAt = Date.now();
        send(text);
    };
    const log = body.querySelector(".as-log");
    const jump = body.querySelector(".as-jump");
    log.addEventListener("scroll", () => { if (nearBottom(log)) jump.classList.remove("is-shown"); }, { passive: true });
    jump.onclick = () => { jump.classList.remove("is-shown"); pinned = true; log.scrollTop = log.scrollHeight; };
    log.addEventListener("click", (e) => {
        const copy = e.target.closest(".as-copy");
        if (copy) {
            navigator.clipboard?.writeText(copy.closest(".as-codeblock").querySelector("pre").textContent);
            flash(copy, "Copied");
            return;
        }
        const mcopy = e.target.closest(".as-mcopy");
        if (mcopy) {
            navigator.clipboard?.writeText(mcopy.closest(".as-claude").innerText.trim());
            mcopy.classList.add("is-done");
            setTimeout(() => mcopy.classList.remove("is-done"), 1200);
            return;
        }
        const ub = e.target.closest(".as-undo-btn, .as-redo-btn, .as-restore");
        if (ub) { undoAction(ub); return; }
        if (e.target.closest(".as-again")) { retry(); return; }
        const dt = e.target.closest(".as-diff-toggle");
        if (dt) {
            const dv = dt.closest(".as-turnbar").querySelector(".as-dv");
            dv.hidden = !dv.hidden;
            dt.setAttribute("aria-expanded", String(!dv.hidden));
            dt.title = dv.hidden ? "Show the changes" : "Hide the changes";
            if (!dv.hidden) scroll();
            return;
        }
        const vb = e.target.closest(".as-view-btn");
        if (vb) { openChanges(vb.closest(".as-turnbar")); return; }
        const lr = e.target.closest(".as-lref");
        if (lr) { if (!overlay.focusLine(+lr.dataset.from)) editor.flashLines(+lr.dataset.from, +lr.dataset.to); return; }
        if (e.target.closest(".as-points-clear")) { overlay.clearPoints(); return; }
        const pt = e.target.closest(".as-point");
        if (pt) {
            const current = pt.closest(".as-points").classList.contains("is-current");
            if (current && overlay.focusMark(+pt.dataset.n)) return;
            const ed = monaco.editor.getEditors()[0];
            const hit = pt.dataset.find && ed && ed.getModel().findMatches(pt.dataset.find, false, false, true, null, false)[0];
            const line = hit ? hit.range.startLineNumber : +pt.dataset.line;
            if (line) editor.flashLines(line, hit ? hit.range.endLineNumber : line);
            return;
        }
        const dl = e.target.closest(".as-dl[data-line]");
        if (dl) { editor.gotoLine(+dl.dataset.line); return; }
        const cmp = e.target.closest(".as-devcmp");
        if (cmp) { openDevicePicker(cmp.closest(".as-choices")); return; }
        const ch = e.target.closest(".as-choice");
        if (ch && !ch.disabled) { pick(ch); return; }
        const s = e.target.closest(".as-suggest button");
        if (s) {
            const item = SUGGEST[+s.dataset.i];
            if (item.send) return send(item.label);
            ta.value = item.text; fit(); ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
    });

    steps.clear();
    live = null;
    group = null;
    const h = await api().history(project);
    // Long chats: draw the last few turns now, earlier ones as the user
    // scrolls up (loadOlder).
    const start = turnStart(h.entries, PAGE_TURNS);
    older = h.entries.slice(0, start);
    for (const entry of h.entries.slice(start)) draw(entry, false);
    for (const entry of h.pending) draw(entry, false);
    log.addEventListener("scroll", () => { if (older.length && log.scrollTop < 300) loadOlder(); }, { passive: true });
    cut = !!h.cut;
    if (!log.children.length) welcome(log);
    setBusy(h.busy);
    if (!marksHooked) {
        marksHooked = true;
        let t = null;
        editor.onContentChange(() => { clearTimeout(t); t = setTimeout(() => turnBar(root && root.querySelector(".as-log")), 350); });
    }
    pinned = true;
    scroll(true);
    if (queued && queued.project === project && !h.busy) { const q = queued; queued = null; send(q.text, q); }
}

// ---- undo ----
// Each message keeps the program as it was before Claude's turn. The latest
// turn gets "Undo changes"; any message can "Restore to here". Both go
// through the editor's history, so Cmd+Z brings the changes back.

function userBubble(text, before) {
    const b = html("div", "as-msg as-user", esc(text).replace(/\n/g, "<br>") +
        (before ? `<button type="button" class="as-restore" title="Restore the program to how it was before this message" aria-label="Restore to here">${ICON.undo}</button>` : ""));
    b._text = text;
    b._before = before;
    return b;
}

// Line diff of the program before and after a turn: [{k: " "|"+"|"-", t, o, n}]
// (o/n = line numbers in the old/new text). Common ends are trimmed first, so
// the LCS table only covers the changed middle.
function lineDiff(a, b) {
    const A = a.split("\n"), B = b.split("\n");
    let s = 0;
    while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let ea = A.length, eb = B.length;
    while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
    const ops = [];
    for (let i = 0; i < s; i++) ops.push({ k: " ", t: A[i], o: i + 1, n: i + 1 });
    const m = ea - s, n = eb - s;
    if (m * n > 2_000_000) {
        for (let i = s; i < ea; i++) ops.push({ k: "-", t: A[i], o: i + 1 });
        for (let j = s; j < eb; j++) ops.push({ k: "+", t: B[j], n: j + 1 });
    } else {
        const L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
        for (let i = m - 1; i >= 0; i--)
            for (let j = n - 1; j >= 0; j--)
                L[i][j] = A[s + i] === B[s + j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
        let i = 0, j = 0;
        while (i < m || j < n) {
            if (i < m && j < n && A[s + i] === B[s + j]) { ops.push({ k: " ", t: A[s + i], o: s + i + 1, n: s + j + 1 }); i++; j++; }
            else if (i < m && (j >= n || L[i + 1][j] >= L[i][j + 1])) { ops.push({ k: "-", t: A[s + i], o: s + i + 1 }); i++; }
            else { ops.push({ k: "+", t: B[s + j], n: s + j + 1 }); j++; }
        }
    }
    for (let i = ea, j = eb; i < A.length; i++, j++) ops.push({ k: " ", t: A[i], o: i + 1, n: j + 1 });
    return ops;
}

// Changed lines with 2 lines of context; gaps collapse to "⋯". Each line
// links to its place in the editor (a removed line to where it was).
function diffView(ops) {
    const keep = new Uint8Array(ops.length);
    ops.forEach((o, i) => { if (o.k !== " " && o.k !== "ctx") for (let k = Math.max(0, i - 2); k <= Math.min(ops.length - 1, i + 2); k++) keep[k] = 1; });
    let out = "", gap = false, nextNew = 1;
    const target = new Array(ops.length);
    for (let i = ops.length - 1; i >= 0; i--) { if (ops[i].n) nextNew = ops[i].n; target[i] = ops[i].n || nextNew; }
    ops.forEach((o, i) => {
        if (!keep[i]) { if (!gap) { out += `<div class="as-dgap">⋯</div>`; gap = true; } return; }
        gap = false;
        const add = o.k === "+" || o.k === "cadd" || o.k === "uadd", del = o.k === "-" || o.k === "cdel" || o.k === "udel";
        const who = o.k[0] === "u" ? " is-user" : "";
        const cls = (add ? " is-add" : del ? " is-del" : "") + who;
        const tip = (who ? "Your edit · " : add || del ? `${AG()} · ` : "") + `go to line ${target[i]}`;
        out += `<div class="as-dl${cls}" data-line="${target[i]}" title="${tip}"><span class="as-dn">${del ? "" : o.n}</span><span class="as-dk">${add ? "+" : del ? "−" : ""}</span><code>${esc(o.t) || " "}</code></div>`;
    });
    return out;
}

// Three-way view of a turn: before → as Claude left it → now. Each line is
// ctx, cadd/cdel (Claude's change) or uadd/udel (the user's own edit after).
// o = line in before, n = line now.
function mergeOps(before, claude, now) {
    const one = lineDiff(before, claude);
    const delsBefore = new Map(), fromBefore = new Map(), trail = [];
    let pend = [];
    for (const op of one) {
        if (op.k === "-") { pend.push(op); continue; }
        delsBefore.set(op.n, pend); pend = [];
        if (op.k === " ") fromBefore.set(op.n, op.o);
    }
    trail.push(...pend);
    const out = [];
    const flush = (j) => { for (const d of delsBefore.get(j) || []) out.push({ k: "cdel", t: d.t, o: d.o }); };
    for (const op of lineDiff(claude, now)) {
        if (op.k === "+") { out.push({ k: "uadd", t: op.t, n: op.n }); continue; }
        flush(op.o);
        const o = fromBefore.get(op.o);
        if (op.k === " ") out.push({ k: o ? "ctx" : "cadd", t: op.t, o, n: op.n });
        else out.push({ k: "udel", t: op.t, o, claude: !o });
    }
    for (const d of trail) out.push({ k: "cdel", t: d.t, o: d.o });
    return out;
}

function countsHtml(ops) {
    const n = (k) => ops.filter(o => o.k === k).length;
    const c = `<b class="as-add">+${n("cadd")}</b><b class="as-del">−${n("cdel")}</b>`;
    const u = n("uadd") + n("udel");
    return u ? `<span class="as-who">${AG()}</span>${c}<span class="as-who is-user">You</span><b class="as-uadd">+${n("uadd")}</b><b class="as-udel">−${n("udel")}</b>` : c;
}

// Turns from before Claude's version was kept: rebuild it from History, as
// the last save by Claude between the message and the end of the turn.
async function recoverAfter(u) {
    const H = window.volt.history;
    const file = getFile();
    if (!u || u._after !== undefined || !u._before || u._before.file !== file || !H || !shownProject) return;
    u._after = null;
    try {
        const rel = file.startsWith(shownProject) ? file.slice(shownProject.length).replace(/^[\\/]/, "") : file;
        const start = Date.parse(u._at) - 2000, end = u._endAt ? Date.parse(u._endAt) + 10000 : Date.now();
        const hits = (await H.log(shownProject, rel, 40)).filter(e => !/^(You\b|Volt$|Outside)/.test(e.author)
            && Date.parse(e.when) >= start && Date.parse(e.when) <= end);
        hits.sort((a, b) => Date.parse(b.when) - Date.parse(a.when));
        if (!hits.length) return;
        const ch = await H.show(shownProject, hits[0].hash);
        const c = (ch.changes || []).find(c => rel === c.path || file.endsWith(c.path));
        if (!c || typeof c.after !== "string") return;
        u._after = c.after;
        api().saveAfter(shownProject, u._at, c.after).catch(() => {});
        turnBar(root && root.querySelector(".as-log"));
    } catch (_) {}
}

function diffCount(a, b) {
    const left = new Map();
    for (const l of a.split("\n")) left.set(l, (left.get(l) || 0) + 1);
    let add = 0;
    for (const l of b.split("\n")) { const c = left.get(l); if (c) left.set(l, c - 1); else add++; }
    let del = 0;
    for (const c of left.values()) del += c;
    return { add, del };
}

function turnBar(log) {
    if (!log || busy || log.querySelector(".as-turnbar.is-undone")) return;
    const users = log.querySelectorAll(".as-user");
    const last = users[users.length - 1];
    const before = last && last._before;
    const file = getFile();
    const old = log.querySelector(".as-turnbar.has-diff");
    const now = file ? editor.getValue() : null;
    if (!before || !file || before.file !== file || now === before.source) {
        old?.remove();
        editor.setChangeMarks([]);
        return;
    }
    if (last._after === undefined) recoverAfter(last);
    const ops = mergeOps(before.source, last._after ?? now, now);
    const n = (k) => ops.filter(o => o.k === k).length;
    const mine = n("uadd") + n("udel");
    const open = old && !old.querySelector(".as-dv").hidden;
    const bar = html("div", "as-turnbar has-diff",
        `<div class="as-turnrow">
           <button type="button" class="as-diff as-diff-toggle" aria-expanded="${open}" title="${open ? "Hide" : "Show"} the changes">${ICON.chev}${countsHtml(ops)}<span>${mine ? "" : "lines changed"}</span></button>
           <span class="as-turnacts">
             <button type="button" class="as-view-btn" title="Open the changes in a window where you can edit them">${ICON.eye}View changes</button>
             <button type="button" class="as-undo-btn" title="Put the program back to how it was before this message">${ICON.undo}Undo</button>
           </span>
         </div>
         <div class="as-dv"${open ? "" : " hidden"}>${diffView(ops)}</div>`);
    bar._before = before;
    bar._after = last._after;
    if (old) old.replaceWith(bar);
    else { add(log, bar); scroll(); }
    editor.setChangeMarks(ops.filter(o => o.n && (o.k === "cadd" || o.k === "uadd")).map(o => ({ line: o.n, who: o.k === "uadd" ? "you" : "claude" })));
}

// ---- retry ----
// A turn that ended early (Stop, an error, Claude Code quitting, the IDE
// closing) can be run again: the code goes back to before that message, the
// partial reply leaves the chat and Claude's memory, and the message is resent.

function retryBar(log) {
    if (!log || busy) return;
    log.querySelectorAll(".as-retrybar").forEach(b => b.remove());
    const last = [...log.querySelectorAll(".as-user")].pop();
    if (!cut || !last || !last._text) return;
    add(log, html("div", "as-retrybar",
        `<span>The response was cut off.</span><button type="button" class="as-again">${ICON.redo}Retry</button>`));
    scroll();
}

async function retry() {
    const log = root && root.querySelector(".as-log");
    const msg = log && [...log.querySelectorAll(".as-user")].pop();
    if (!msg || busy || !sendFn) return;
    try {
        const before = msg._before;
        if (before && before.file === getFile() && editor.getValue() !== before.source) {
            const { add: a, del: d } = diffCount(before.source, editor.getValue());
            const { confirm } = await import("./dialog.js");
            if (!await confirm("Retry from the start of this message?", {
                detail: `The program goes back to how it was before it (+${a} −${d} lines are undone, including any edits you made since), then ${AG()} answers again.`,
                okLabel: "Retry", danger: true })) return;
        }
        if (before && before.file === getFile()) await restore(before.source);
    } catch (err) { add(log, errorBox(clean(err.message))); return; }
    log.querySelectorAll(".as-turnbar, .as-retrybar").forEach(b => b.remove());
    if (msg._at) {
        markRewind(log, msg);
        const ta = root.querySelector(".as-box textarea");
        if (ta && ta.value === msg._text) { ta.value = ""; ta.dispatchEvent(new Event("input")); }
    } else msg.remove();
    sentAt = Date.now();
    sendFn(msg._text);
}

// ---- changes dialog ----
// Before on the left (read-only), the program now on the right (editable).
// Apply writes the right side into the editor as one undoable edit.
function openChanges(bar) {
    const before = bar && bar._before;
    if (!before || before.file !== getFile() || document.querySelector(".as-cdlg")) return;
    const now = editor.getValue();
    const name = before.file.split(/[\\/]/).pop();
    const overlay = html("div", "dialog-overlay as-cdlg-overlay", `
      <div class="dialog as-cdlg" role="dialog" aria-modal="true" aria-label="Changes by ${AG()}">
        <div class="as-cdlg-head">
          <div class="as-cdlg-title"><b>Changes</b><span class="as-cdlg-file">${esc(name)}</span><span class="as-cdlg-count"></span></div>
          <div class="as-seg" role="group" aria-label="Layout">
            <button type="button" data-side="1" class="is-on">Side by side</button><button type="button" data-side="0">Inline</button>
          </div>
        </div>
        <div class="as-cdlg-cols"><span>Before ${AG()}'s turn</span><span>Now · you can edit this side</span></div>
        <div class="as-cdlg-ed"></div>
        <div class="as-cdlg-foot">
          <button type="button" class="dialog-btn as-cdlg-undo">${ICON.undo}Undo all changes</button>
          <span class="as-legend"><i class="is-claude"></i>${AG()} <i class="is-user"></i>You</span>
          <span class="as-cdlg-gap"></span>
          <span class="as-cdlg-edited" hidden>Edited</span>
          <button type="button" class="dialog-btn" data-act="cancel">Close</button>
          <button type="button" class="dialog-btn dialog-btn-primary" data-act="apply" disabled>Apply edits</button>
        </div>
      </div>`);
    document.body.appendChild(overlay);
    const host = overlay.querySelector(".as-cdlg-ed");
    const original = monaco.editor.createModel(before.source, "volt");
    const modified = monaco.editor.createModel(now, "volt");
    const diff = monaco.editor.createDiffEditor(host, {
        automaticLayout: true, renderSideBySide: true, originalEditable: false, readOnly: false,
        minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13,
        renderOverviewRuler: false, ignoreTrimWhitespace: false, hideUnchangedRegions: { enabled: true, contextLineCount: 3 },
    });
    diff.setModel({ original, modified });
    const apply = overlay.querySelector('[data-act="apply"]');
    const edited = overlay.querySelector(".as-cdlg-edited");
    const count = overlay.querySelector(".as-cdlg-count");
    const claude = bar._after ?? now;
    let decoM = [], decoO = [];
    const recount = () => {
        const ops = mergeOps(before.source, claude, modified.getValue());
        count.innerHTML = countsHtml(ops);
        const line = (n, cls, gut, msg) => ({ range: new monaco.Range(n, 1, n, 1), options: { isWholeLine: true, className: cls, linesDecorationsClassName: gut, hoverMessage: { value: msg } } });
        decoM = modified.deltaDecorations(decoM, ops.filter(o => o.n && (o.k === "uadd" || o.k === "cadd"))
            .map(o => o.k === "uadd" ? line(o.n, "as-u-line", "as-u-gut", "Your edit") : line(o.n, "as-c-line", "as-c-gut", `${AG()}'s change`)));
        decoO = original.deltaDecorations(decoO, ops.filter(o => o.o && (o.k === "udel" || o.k === "cdel"))
            .map(o => o.k === "udel" ? line(o.o, "as-u-line is-del", "as-u-gut", "You removed this") : line(o.o, "as-c-line is-del", "as-c-gut", `${AG()} removed this`)));
        const dirty = modified.getValue() !== now;
        apply.disabled = !dirty;
        edited.hidden = !dirty;
    };
    recount();
    modified.onDidChangeContent(recount);
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKey, true);
        overlay.classList.add("is-closing");
        setTimeout(() => { diff.dispose(); original.dispose(); modified.dispose(); overlay.remove(); }, 200);
        editor.focus?.();
    };
    const onKey = (e) => {
        if (e.key === "Escape" && !document.querySelector(".dialog-overlay:not(.as-cdlg-overlay)")) {
            e.preventDefault(); e.stopPropagation();
            if (!apply.disabled) { overlay.querySelector('[data-act="cancel"]').click(); return; }
            close();
        } else if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "Enter") && !apply.disabled) {
            e.preventDefault(); e.stopPropagation(); apply.click();
        }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.querySelectorAll(".as-seg button").forEach(b => b.onclick = () => {
        overlay.querySelectorAll(".as-seg button").forEach(x => x.classList.toggle("is-on", x === b));
        diff.updateOptions({ renderSideBySide: b.dataset.side === "1" });
        overlay.querySelector(".as-cdlg-cols").hidden = b.dataset.side !== "1";
    });
    overlay.querySelector('[data-act="cancel"]').onclick = async () => {
        if (!apply.disabled) {
            const { confirm } = await import("./dialog.js");
            if (!await confirm("Discard your edits?", { detail: `The program stays as ${AG()} left it.`, okLabel: "Discard", danger: true })) return;
        }
        close();
    };
    apply.onclick = async () => {
        if (editor.getValue() !== now) {
            const { confirm } = await import("./dialog.js");
            if (!await confirm("The program changed since you opened this.", { detail: "Apply anyway and replace it with the right side?", okLabel: "Apply", danger: true })) return;
        }
        try { await restore(modified.getValue()); } catch (err) { add(root.querySelector(".as-log"), errorBox(clean(err.message))); }
        close();
        turnBar(root && root.querySelector(".as-log"));
    };
    overlay.querySelector(".as-cdlg-undo").onclick = () => {
        close();
        const u = bar.isConnected && bar.querySelector(".as-undo-btn");
        if (u) undoAction(u);
    };
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.querySelector('[data-act="cancel"]').click(); });
    setTimeout(() => diff.getModifiedEditor().focus(), 60);
}

async function restore(source) {
    const file = getFile();
    if (!file) throw new Error("No program is open.");
    const now = editor.getValue();
    if (now === source) return now;
    editor.restoreText(source);
    await saveFile({ quiet: true });
    return now;
}

// Undo takes the code back now and the chat back on the next message:
// the dropped turns are dimmed until then, so Redo can still bring them back.
function markRewind(log, msg) {
    clearRewind(log);
    rewindAt = msg;
    let on = false;
    for (const el of log.children) {
        if (el === msg) on = true;
        if (on && !el.classList.contains("as-turnbar") && !el.classList.contains("as-typing")) el.classList.add("is-rewound");
    }
    const ta = root.querySelector(".as-box textarea");
    if (ta && !ta.value.trim()) {
        ta.value = msg._text;
        ta.dispatchEvent(new Event("input"));
    }
}

function clearRewind(log) {
    rewindAt = null;
    log.querySelectorAll(".is-rewound").forEach(el => el.classList.remove("is-rewound"));
}

async function undoAction(btn) {
    const log = root.querySelector(".as-log");
    try {
        if (btn.classList.contains("as-redo-btn")) {
            const bar = btn.closest(".as-turnbar");
            const ta = root.querySelector(".as-box textarea");
            if (ta && rewindAt && ta.value === rewindAt._text) { ta.value = ""; ta.dispatchEvent(new Event("input")); }
            clearRewind(log);
            await restore(bar._after);
            bar.remove();
            turnBar(log);
            return;
        }
        const msg = btn.classList.contains("as-undo-btn")
            ? [...log.querySelectorAll(".as-user")].pop()
            : btn.closest(".as-user");
        const before = msg && msg._before;
        if (!before) return;
        if (before.file !== getFile()) throw new Error("That message was about another file.");
        const after = await restore(before.source);
        log.querySelectorAll(".as-turnbar").forEach(b => b.remove());
        editor.setChangeMarks([]);
        markRewind(log, msg);
        const bar = html("div", "as-turnbar is-undone",
            `<span class="as-diff">${ICON.check}<span>Undone. The dimmed messages leave the chat when you send.</span></span><button type="button" class="as-redo-btn">${ICON.redo}Redo</button>`);
        bar._after = after;
        add(log, bar);
        scroll(true);
        root.querySelector(".as-box textarea")?.focus();
    } catch (err) {
        add(log, errorBox(clean(err.message)));
    }
}

function welcome(log) {
    log.innerHTML = `
      <div class="as-welcome">
        <div class="as-welcome-icon">${ICON.spark}</div>
        <h3>What should this program do?</h3>
        <p>${AG()} reads your program, changes it in the editor (you can undo every edit) and checks that it compiles.</p>
        <div class="as-suggest">${SUGGEST.map((s, i) => `<button type="button" data-i="${i}">${esc(s.label)}</button>`).join("")}</div>
      </div>`;
}

function setup(body, st) {
    const a = agent();
    const other = Object.entries(AGENTS).filter(([k]) => k !== agentId)
        .map(([k, o]) => `<button class="as-switch" data-agent="${k}">Use ${o.name} instead</button>`).join("");
    body.innerHTML = !st.found
        ? `<div class="as-setup"><div class="as-welcome-icon">${ICON.spark}</div><h4>Use ${a.name} in Volt</h4>
             <p>Volt runs ${a.name} on your own ${a.plan} plan. Install it, then sign in once:</p>
             ${a.install.map(c => `<pre>${esc(c)}</pre>`).join("")}
             <p class="as-dim">Already installed somewhere else? Set its path in Settings → AI agents.</p>
             <button class="as-retry">Check again</button>${other}</div>`
        : `<div class="as-setup"><div class="as-welcome-icon">${ICON.spark}</div><h4>Sign in to ${a.name}</h4>
             <p>${a.name} is installed but not signed in. In a terminal, run:</p>
             <pre>${esc(a.login)}</pre><p>and sign in with your ${a.plan} account. Volt never sees your password or keys.</p>
             <button class="as-retry">Check again</button>${other}</div>`;
    body.querySelectorAll(".as-switch").forEach(b => b.onclick = () => settingsService.set("assistant.provider", b.dataset.agent));
    body.querySelector(".as-retry").onclick = () => { shownProject = null; renderInto(body); };
}

// ---- drawing entries ----

function draw(entry, fresh) {
    const log = root && root.querySelector(".as-log");
    if (!log) return;
    if (entry.t !== "busy" && entry.t !== "decision" && entry.t !== "tool_result") log.querySelector(".as-welcome")?.remove();
    switch (entry.t) {
    case "busy": setBusy(entry.on); return;
    case "delta":
        if (!live) { endGroup(); live = el("div", "as-msg as-claude is-live"); add(log, live); live._text = ""; }
        live._text += entry.text;
        live.innerHTML = md(live._text);
        break;
    case "text":
        if (live) { live.remove(); live = null; }
        endGroup();
        add(log, html("div", "as-msg as-claude", md(entry.text) +
            `<button type="button" class="as-mcopy" title="Copy reply" aria-label="Copy reply">${ICON.copy}${ICON.check}</button>`));
        if (fresh) { const set = [...log.querySelectorAll(".as-choices.is-devices")].pop(); if (set && set.closest(".as-msg") === log.lastElementChild) openDevicePicker(set); }
        break;
    case "user": {
        endGroup();
        settleChoices(log, entry.text);
        log.querySelectorAll(".as-turnbar").forEach(b => b.remove());
        const mine = [...log.querySelectorAll(".as-user.is-pending")].find(m => m._text === entry.text);
        if (mine) { mine.classList.remove("is-pending"); mine._at = entry.at; break; }
        const b = userBubble(entry.text, entry.before);
        b._at = entry.at;
        add(log, b);
        pinned = true;
        break;
    }
    case "tool": {
        if (live) { live.classList.remove("is-live"); live = null; }
        if (!group) {
            group = html("details", "as-steps",
                `<summary><span class="as-ico"></span><span class="as-steps-label"></span><span class="as-chev">${ICON.chev}</span></summary><div class="as-steps-list"></div>`);
            add(log, group);
        }
        const s = html("details", "as-step is-running",
            `<summary><span class="as-ico"></span><span class="as-step-label">${esc(stepLabel(entry))}</span></summary><pre></pre>`);
        steps.set(entry.id, s);
        group.querySelector(".as-steps-list").append(s);
        updateGroup(group);
        const notes = /ide_point$/.test(entry.name || "") && Array.isArray((entry.input || {}).marks)
            ? entry.input.marks.filter(m => m && m.note && (m.find || m.line)) : [];
        if (notes.length) {
            log.querySelectorAll(".as-points.is-current").forEach(c => c.classList.remove("is-current"));
            add(log, html("div", "as-points is-current", `<div class="as-points-head">${ICON.spark}<span>In the editor</span><button type="button" class="as-points-clear" title="Remove these notes from the code">Clear</button></div>` +
                notes.map((m, i) => `<button type="button" class="as-point" data-n="${i + 1}" data-find="${esc(m.find || "")}" data-line="${+m.line || 0}">
                    <span class="as-point-num">${i + 1}</span><span class="as-point-note">${inline(String(m.note))}</span></button>`).join("")));
        }
        break;
    }
    case "tool_result": {
        const s = steps.get(entry.id);
        if (!s) return;
        s.classList.remove("is-running");
        s.classList.add(entry.ok ? "is-ok" : "is-fail");
        const out = entry.summary || "";
        s.querySelector("pre").textContent = out;
        s.classList.toggle("has-out", !!out);
        updateGroup(s.closest(".as-steps"));
        break;
    }
    case "approval":
        endGroup();
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
        {
            const u = [...log.querySelectorAll(".as-user")].pop();
            if (u) u._endAt = entry.at;
            if (fresh && u && u._before && u._before.file === getFile()) {
                u._after = editor.getValue();
                api().saveAfter(shownProject, u._at, u._after).catch(() => {});
                // Save Claude's edits now so History credits them to Claude, not to whoever saves next.
                if (editor.isUnsaved()) saveFile({ quiet: true }).catch(() => {});
            }
        }
        if (live) { live.classList.remove("is-live"); live = null; }
        endGroup();
        if (!entry.ok && entry.error) add(log, entry.error === "Stopped." ? note("Stopped") : errorBox(clean(entry.error)));
        cut = !entry.ok;
        break;
    case "after": {
        const u = [...log.querySelectorAll(".as-user")].reverse().find(m => m._at === entry.of);
        if (u) u._after = entry.source;
        return;
    }
    case "note":
        endGroup();
        add(log, html("div", "as-note is-info", `${ICON.alert}<span>${esc(entry.text)}</span>`));
        break;
    case "error":
        endGroup();
        add(log, entry.text === "Stopped." ? note("Stopped") : errorBox(entry.text));
        cut = true;
        break;
    default: return;
    }
    syncTyping();
    if (fresh) scroll();
    badge();
    const ta = root.querySelector(".as-box textarea");
    if (ta) ta.placeholder = liveChoices() && !busy ? "Pick an option (1–4) or type your own answer…" : `Ask ${AG()} to change this program…`;
}

// Steps between two messages form one group: open while it runs, then folded
// to a one-line summary the user can expand.
function endGroup() {
    if (!group) return;
    updateGroup(group);
    if (!group.querySelector(".as-step.is-fail")) group.open = false;
    group = null;
}

function updateGroup(g) {
    if (!g) return;
    const all = g.querySelectorAll(".as-step");
    const running = g.querySelector(".as-step.is-running");
    const failed = g.querySelectorAll(".as-step.is-fail").length;
    g.classList.toggle("is-running", !!running);
    g.classList.toggle("is-fail", !running && failed > 0);
    const n = all.length;
    g.querySelector(".as-steps-label").innerHTML = running
        ? `${esc(running.querySelector(".as-step-label").textContent)}…`
        : `${esc(all[n - 1].querySelector(".as-step-label").textContent)}<span class="as-count">${n > 1 ? `${n} steps` : "1 step"}${failed ? ` · ${failed} failed` : ""}</span>`;
}

function note(text) {
    return html("div", "as-note", `${ICON.stop}<span>${esc(text)}</span>`);
}

function errorBox(text) {
    return html("div", "as-msg as-error", `<span class="as-ico">${ICON.alert}</span><span>${esc(text)}</span>`);
}

function card(log, entry) {
    const content = entry.tool === "Write" && typeof (entry.input || {}).content === "string"
        ? `<pre class="as-content">${esc(entry.input.content) || "(empty file)"}</pre>` : "";
    const d = detail(entry);
    const c = html("div", "as-approve",
        `<div class="as-approve-head"><span class="as-ico">${ICON.shield}</span><span>${AG()} wants to <b>${esc(actionText(entry))}</b></span></div>
         ${d ? `<div class="as-target" title="${esc(d)}"><bdi>${esc(d)}</bdi></div>` : ""}
         ${entry.reason ? `<div class="as-reason">${esc(entry.reason)}</div>` : ""}
         ${content}
         <div class="as-actions"><button class="as-deny">Deny</button><button class="as-allow">Allow once</button></div>`);
    c.dataset.id = entry.id;
    c.querySelector(".as-allow").onclick = () => api().decide(shownProject, entry.id, true);
    c.querySelector(".as-deny").onclick = () => api().decide(shownProject, entry.id, false);
    add(log, c);
}

function settle(c, allow) {
    const a = c.querySelector(".as-actions");
    if (a) a.outerHTML = `<div class="as-verdict">${allow ? ICON.check : ICON.cross}${allow ? "Allowed" : "Denied"}</div>`;
    c.classList.add(allow ? "is-allowed" : "is-denied");
}

const ACTIONS = { ide_build: "build the program", ide_run: "build and flash the board", ide_save: "save the file",
    ide_open: "open another project", ide_new_project: "create a new project", library_write: "write a device library",
    library_request_approval: "ask you to approve a device library", Edit: "edit a file", Write: "write a file",
    shell: "run a command" };
function actionText(e) { return ACTIONS[e.tool] || `use ${e.tool}`; }
function detail(e) {
    const i = e.input || {};
    if (i.file_path) return i.file_path;
    if (e.tool === "shell") return i.command || "";
    if (e.tool === "ide_new_project") return `${i.name || ""} (${i.chip || ""})`;
    if (e.tool === "library_write" || e.tool === "library_request_approval") return i.prefix || "";
    const s = JSON.stringify(i);
    return s && s !== "{}" ? s.slice(0, 300) : "";
}

const STEP = { volt_spec: "Read the Volt reference", device_card: "Looked up", list_devices: "Searched devices",
    check: "Checked the program", review: "Reviewed against your request", ide_read: "Read the program",
    ide_edit: "Edited the program", ide_status: "Looked at the IDE", ide_diagnostics: "Read the problems",
    ide_build: "Built", ide_run: "Flashed the board", ide_serial: "Read serial output", ide_screenshot: "Took a screenshot",
    ide_show: "Opened a view", ide_point: "Pointed at the code", ide_walkthrough: "Walked you through it",
    ide_highlight: "Highlighted lines", ide_select: "Selected code", library_write: "Wrote device library", library_request_approval: "Asked you to approve",
    Read: "Read", shell: "Ran", Edit: "Edited" };
function stepLabel(e) {
    const i = e.input || {};
    const name = String(e.name || "").replace(/^mcp__volt__/, "");
    const base = STEP[name] || name;
    if (name === "device_card") return `${base} ${i.name || i.device || ""}`.trim();
    if (name === "library_write") return `${base} ${i.prefix || ""}`.trim();
    if (name === "Read") return `${base} ${String(i.file_path || "").split(/[\\/]/).pop()}`;
    if (name === "Edit") return `${base} ${String(i.file_path || "").split(", ").map(f => f.split(/[\\/]/).pop()).join(", ")}`;
    if (name === "shell") return `${base} ${String(i.command || "").slice(0, 60)}`;
    return base;
}

function setBusy(on) {
    if (busy !== !!on) document.dispatchEvent(new CustomEvent("volt:assistant-busy", { detail: { on: !!on } }));
    busy = !!on;
    if (busy) editor.setChangeMarks([]);
    const b = root && root.querySelector(".as-send");
    if (b) {
        b.innerHTML = busy ? ICON.stop : ICON.send;
        b.title = busy ? "Stop" : "Send";
        b.setAttribute("aria-label", b.title);
        b.classList.toggle("is-stop", busy);
    }
    if (!busy && live) { live.classList.remove("is-live"); live = null; }
    // A Fix it / Ask sent while the agent was busy goes out when it's done.
    if (!busy && queued && queued.project === shownProject && sendFn) { const q = queued; queued = null; setTimeout(() => sendFn(q.text, q), 0); }
    if (!busy) { endGroup(); turnBar(root && root.querySelector(".as-log")); retryBar(root && root.querySelector(".as-log")); }
    syncTyping();
    badge();
}

// "Thinking" dots while Claude works but nothing is streaming or running.
function syncTyping() {
    const log = root && root.querySelector(".as-log");
    if (!log) return;
    let t = log.querySelector(".as-typing");
    const show = busy && !live && !log.querySelector(".as-step.is-running") && !log.querySelector(".as-approve:not(.is-allowed):not(.is-denied)");
    if (!show) { t?.remove(); return; }
    if (!t) t = html("div", "as-typing", "<i></i><i></i><i></i>");
    log.append(t);
}

// ---- helpers ----

// ---- lazy history ----
const PAGE_TURNS = 8;   // turns (a user message and everything after it) drawn at a time
let older = [];         // history entries not drawn yet, oldest first
let loadingOlder = false;

// Index where the last `turns` turns begin (always on a user message, so a
// turn's tool steps and replies are drawn together).
function turnStart(entries, turns) {
    let seen = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].t === "user" && ++seen === turns) return i;
    }
    return 0;
}

// Draw the previous page of turns above what's shown, keeping the reader's place.
function loadOlder() {
    const log = root && root.querySelector(".as-log");
    if (!log || loadingOlder || !older.length) return;
    loadingOlder = true;
    const start = turnStart(older, PAGE_TURNS);
    const page = older.slice(start).filter(e => e.t !== "busy");
    older = older.slice(0, start);
    const fromBottom = log.scrollHeight - log.scrollTop;
    // draw() appends to the log: set the newer messages aside, draw the page,
    // then put them back after it.
    const newer = document.createDocumentFragment();
    while (log.firstChild) newer.appendChild(log.firstChild);
    const keep = { live, group };
    live = null; group = null;
    for (const entry of page) draw(entry, false);
    endGroup();
    ({ live, group } = keep);
    log.appendChild(newer);
    jumpTo(log, log.scrollHeight - fromBottom);
    loadingOlder = false;
}

// Move the scroll position at once (the log scrolls smoothly otherwise, which
// would animate through the whole chat).
function jumpTo(log, top) {
    log.style.scrollBehavior = "auto";
    log.scrollTop = top;
    requestAnimationFrame(() => { log.style.scrollBehavior = ""; });
}

function add(log, node) { const t = log.querySelector(".as-typing"); log.insertBefore(node, t); }
// Follow new output only while the user is at the bottom; otherwise offer a
// "jump to latest" button instead of pulling them away from what they read.
let pinned = true;
function nearBottom(log) { return log.scrollHeight - log.scrollTop - log.clientHeight < 48; }
function scroll(force) {
    const log = root && root.querySelector(".as-log");
    if (!log) return;
    if (force) { jumpTo(log, log.scrollHeight); return; }
    if (pinned) { log.scrollTop = log.scrollHeight; return; }
    root.querySelector(".as-jump")?.classList.add("is-shown");
}
document.addEventListener("scroll", (e) => {
    if (e.target?.classList?.contains("as-log")) pinned = nearBottom(e.target);
}, { capture: true, passive: true });

// Activity-bar badge: working (pulse) or waiting for an approval (amber).
function badge() {
    const b = document.getElementById("toggleAssistant");
    if (!b) return;
    const waiting = !!(root && root.querySelector(".as-approve:not(.is-allowed):not(.is-denied)"));
    b.classList.toggle("as-busy", busy && !waiting);
    b.classList.toggle("as-waiting", waiting);
}

function flash(btn, text) {
    const was = btn.textContent;
    btn.textContent = text;
    btn.classList.add("is-done");
    setTimeout(() => { btn.textContent = was; btn.classList.remove("is-done"); }, 1200);
}
function el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }
function html(tag, cls, inner) { const e = el(tag, cls); e.innerHTML = inner; return e; }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function clean(m) { return String(m || "").replace(/^Error invoking remote method '[^']+': (Error: )?/, ""); }

// Small markdown: fenced code (with Copy), headings, bullet and numbered
// lists, paragraphs, inline code, bold, italics. Escapes first.
function md(text) {
    const lines = String(text).split("\n");
    const out = [];
    const isBlock = (l) => /^\s*```/.test(l) || /^#{1,4}\s/.test(l) || /^\s*[-*•]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l) || /^\s*\|/.test(l);
    let i = 0;
    while (i < lines.length) {
        const l = lines[i];
        const fence = l.match(/^\s*```\s*([\w+-]*)/);
        if (fence) {
            const buf = [];
            i++;
            while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
            i++;
            if (fence[1] === "choices") { out.push(choices(buf)); continue; }
            if (fence[1] === "devices") { out.push(choices(buf, true)); continue; }
            out.push(`<div class="as-codeblock"><div class="as-codehead"><span>${esc(fence[1] || "code")}</span><button type="button" class="as-copy">Copy</button></div><pre>${esc(buf.join("\n"))}</pre></div>`);
            continue;
        }
        if (!l.trim()) { i++; continue; }
        // A table: a | row, then a |---| row. A row whose first cell is empty
        // continues the one above (more pins of the same part).
        if (/^\s*\|/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
            const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
            const head = cells(l);
            i += 2;
            const rows = [];
            while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
            out.push(`<div class="as-tablewrap"><table class="as-table"><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
                rows.map(r => `<tr${r[0] ? "" : ` class="is-cont"`}>${head.map((_, k) => `<td>${inline(r[k] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
            continue;
        }
        const h = l.match(/^(#{1,4})\s+(.*)/);
        if (h) { out.push(`<div class="as-h">${inline(h[2])}</div>`); i++; continue; }
        const list = (re, tag) => {
            const items = [];
            while (i < lines.length && re.test(lines[i])) {
                let item = lines[i++].replace(re, "");
                while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !isBlock(lines[i])) item += " " + lines[i++].trim();
                items.push(`<li>${inline(item)}</li>`);
            }
            out.push(`<${tag}>${items.join("")}</${tag}>`);
        };
        if (/^\s*[-*•]\s+/.test(l)) { list(/^\s*[-*•]\s+/, "ul"); continue; }
        if (/^\s*\d+[.)]\s+/.test(l)) { list(/^\s*\d+[.)]\s+/, "ol"); continue; }
        // Always take at least this line: a block-looking line no rule above
        // handled (a lone "| …" row) would otherwise never be consumed.
        const para = [inline(lines[i++])];
        while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) para.push(inline(lines[i++]));
        out.push(`<p>${para.join("<br>")}</p>`);
    }
    return out.join("");
}

// ```choices block: one option per line, "Title :: detail". A title ending
// in "..." asks the user to type their own answer.
// A ```devices block is the same, one part per line: several parts that do
// the job equally well. It also opens the part picker (openDevicePicker).
function choices(lines, devices = false) {
    let purpose = "";
    if (devices) lines = lines.filter(l => { const m = l.match(/^\s*for\s*:\s*(.+)$/i); if (m) purpose = m[1].trim(); return !m; });
    const opts = lines.map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean).slice(0, 6);
    const head = devices ? `<div class="as-devhead"><span>${purpose ? `Choose the part for ${inline(purpose)}` : "Choose a part"}</span><button type="button" class="as-devcmp">Compare</button></div>` : "";
    return `<div class="as-choices${devices ? " is-devices" : ""}" role="group" aria-label="Choose one"${purpose ? ` data-purpose="${esc(purpose)}"` : ""}>${head}${opts.map((o, i) => {
        let [title, ...rest] = o.split("::");
        title = title.trim(); const detail = rest.join("::").trim();
        const rec = /\(recommended\)\s*$/i.test(title);
        title = title.replace(/\s*\(recommended\)\s*$/i, "");
        const free = /(\.\.\.|…)$/.test(title);
        const answer = devices && !free ? `Use the ${title}.` : title.replace(/(\.\.\.|…)$/, "");
        return `<button type="button" class="as-choice${rec ? " is-rec" : ""}${free ? " is-free" : ""}" data-title="${esc(answer)}" data-name="${esc(title)}" data-detail="${esc(detail)}">
            <span class="as-key">${i + 1}</span>
            <span class="as-choice-body"><span class="as-choice-title">${inline(title)}${rec ? `<span class="as-rec">Recommended</span>` : ""}</span>${detail ? `<span class="as-choice-detail">${inline(detail)}</span>` : ""}</span>
            <span class="as-choice-go">${free ? ICON.compose : ICON.chev}</span>
        </button>`;
    }).join("")}</div>`;
}

// The part picker: the agent found several parts that do the same job, and
// the user decides which one they'll wire up. It says what the part is for
// (the block's "for:" line), lists the parts as rows with the agent's reason,
// how each connects and its datasheet, and starts on the recommended one.
let deviceInfo = null;
const CONNECTS = { i2c: "I²C", spi: "SPI", uart: "UART", gpio: "1 data pin", onewire: "1-Wire", analog: "Analog pin", pwm: "PWM pin" };
async function openDevicePicker(set) {
    if (!set || document.getElementById("asDevPick")) return;
    const live = !set.classList.contains("is-done");
    const opts = [...set.querySelectorAll(".as-choice:not(.is-free)")];
    if (!opts.length) return;
    if (!deviceInfo) {
        const d = await window.volt.devicesList().catch(() => []);
        deviceInfo = Array.isArray(d) ? d : (d && d.devices) || Object.values(d || {});
    }
    const info = (name) => deviceInfo.find(x => String(x.name).toLowerCase() === String(name).toLowerCase()) || {};
    const kinds = new Set(opts.map(b => info(b.dataset.name).category).filter(Boolean));
    const kind = kinds.size === 1 ? { sensor: "sensor", display: "display", actuator: "part", communication: "module" }[[...kinds][0]] || "part" : "part";
    const purpose = set.dataset.purpose || "";
    // No "for:" line from the agent: quote the request it is answering instead.
    let asked = "";
    if (!purpose) {
        const users = [...document.querySelectorAll(".as-log .as-user")].filter(u => u.compareDocumentPosition(set) & Node.DOCUMENT_POSITION_FOLLOWING);
        const u = users.pop();
        asked = u ? String(u._text || u.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160) : "";
    }
    const recI = Math.max(0, opts.findIndex(b => b.classList.contains("is-rec")));
    const pickedI = opts.findIndex(b => b.classList.contains("is-picked"));
    let chosen = live ? recI : pickedI;
    const ov = document.createElement("div");
    ov.id = "asDevPick";
    ov.className = "overlay";
    ov.innerHTML = `<div class="as-dp" role="dialog" aria-modal="true" aria-labelledby="asDpTitle" aria-describedby="asDpWhy">
        <header>
          <h2 id="asDpTitle">Which ${kind} do you want to use?</h2>
          <p id="asDpWhy">${purpose ? `For <b>${esc(purpose)}</b>, any` : asked ? `You asked: <b>“${esc(asked)}”</b><br>Any` : "Any"} of these ${opts.length} will work the same way, so it's your choice: pick the one you have, or the one you'd rather buy.</p>
        </header>
        <div class="as-dp-list" role="radiogroup" aria-labelledby="asDpTitle">${opts.map((b, i) => {
            const d = info(b.dataset.name);
            const rec = b.classList.contains("is-rec");
            return `<div class="as-dp-row${i === chosen ? " is-on" : ""}" role="radio" tabindex="${i === chosen ? 0 : -1}" aria-checked="${i === chosen}" data-i="${i}"${live ? "" : ` aria-disabled="true"`} title="${esc(d.description || "")}">
              <span class="as-dp-dot" aria-hidden="true"></span>
              <span class="as-dp-main">
                <span class="as-dp-name">${esc(b.dataset.name)}${rec ? `<span class="as-dp-rec">${esc(AG())}'s pick</span>` : ""}</span>
                <span class="as-dp-why">${esc(b.dataset.detail || d.description || "")}</span>
              </span>
              <span class="as-dp-meta">${d.interface ? `<span class="as-dp-tag">${esc(CONNECTS[d.interface] || d.interface.toUpperCase())}</span>` : ""}${d.datasheet ? `<a class="as-dp-ds" href="${esc(d.datasheet)}" title="Open the datasheet">Datasheet</a>` : ""}</span>
            </div>`; }).join("")}</div>
        <footer>
          <span class="as-dp-note">${live ? `${esc(AG())} writes the code once you choose.` : "Already answered."}</span>
          <button type="button" class="as-dp-btn as-dp-later">${live ? "Decide later" : "Close"}</button>
          ${live ? `<button type="button" class="as-dp-btn as-dp-use"></button>` : ""}
        </footer>
      </div>`;
    document.body.appendChild(ov);
    const rows = [...ov.querySelectorAll(".as-dp-row")];
    const select = (i) => {
        if (!live) return;
        chosen = i;
        rows.forEach((r, k) => { r.classList.toggle("is-on", k === i); r.setAttribute("aria-checked", k === i); r.tabIndex = k === i ? 0 : -1; });
        const btn = ov.querySelector(".as-dp-use");
        if (btn) btn.textContent = `Use ${opts[i].dataset.name}`;
    };
    const close = () => { document.removeEventListener("keydown", onKey, true); ov.remove(); };
    const use = () => { if (live && chosen >= 0) { close(); opts[chosen].click(); } };
    const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === "Enter") { e.preventDefault(); use(); }
        else if (/^Arrow(Down|Up)$/.test(e.key) && live) {
            e.preventDefault();
            const i = (chosen + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
            select(i); rows[i].focus();
        }
    };
    document.addEventListener("keydown", onKey, true);
    ov.addEventListener("click", (e) => {
        if (e.target === ov || e.target.closest(".as-dp-later")) return close();
        if (e.target.closest(".as-dp-use")) return use();
        const link = e.target.closest("a[href]");
        if (link) { e.preventDefault(); window.volt.openExternal(link.href); return; }
        const r = e.target.closest(".as-dp-row");
        if (r) { select(+r.dataset.i); if (e.detail === 2) use(); }
    });
    if (live) select(chosen);
    (rows[chosen] || rows[0]).focus();
}

// Choices are live only on the latest reply; once the user answers, the
// picked one stays highlighted and the rest fade.
function settleChoices(log, answer) {
    for (const set of log.querySelectorAll(".as-choices:not(.is-done)")) {
        set.classList.add("is-done");
        for (const b of set.querySelectorAll(".as-choice")) {
            b.disabled = true;
            const t = b.dataset.title;
            if (answer && (answer === t || answer.startsWith(t + ":") || answer.startsWith(t))) b.classList.add("is-picked");
        }
    }
}

function liveChoices() {
    const log = root && root.querySelector(".as-log");
    const sets = log ? log.querySelectorAll(".as-choices:not(.is-done)") : [];
    return sets.length ? sets[sets.length - 1] : null;
}

// "line 7", "lines 38-52", "lines 38–52": a link that shows them in the editor.
function lineRefs(html) {
    return html.split(/(<code>[\s\S]*?<\/code>)/).map(part => part.startsWith("<code>") ? part
        : part.replace(/\b(lines?|Ln)\s+(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/gi, (m, w, a, b) =>
            `<button type="button" class="as-lref" data-from="${a}" data-to="${b || a}" title="Show in the editor">${m}</button>`)).join("");
}

function inline(s) {
    return lineRefs(esc(s)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>"));
}

// Notes gone from the editor: the latest list becomes a plain record (its items still jump to the code).
document.addEventListener("volt:points-cleared", () => {
    root?.querySelectorAll(".as-points.is-current").forEach(c => c.classList.remove("is-current"));
});

function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return d < 7 ? `${d} d ago` : new Date(ms).toLocaleDateString();
}
