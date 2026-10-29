// What an AI agent shows the user: marks on code with visible notes
// (ide_point), pointers at parts of the IDE, a step-by-step walkthrough
// (ide_walkthrough) and question cards (ide_ask). Everything is labelled AI
// and can be dismissed; one walkthrough/question is open at a time.

import * as sidePanel from "./side-panel.js";
import * as diagramsView from "./diagrams-view.js";
import * as editorMod from "./editor.js";

const KINDS = ["info", "change", "warning", "question"];
// How long a note stays: until the user closes it (×), until the agent
// clears it, or for a few seconds.
const LIFETIMES = ["dismissable", "fixed", "timeout"];
// IDE commands a note's action button may run (same handlers as the menu).
export const RUNNABLE = ["check", "run", "monitor", "save", "format", "settings",
    "panel:hardware", "panel:outline", "panel:library", "board", "addPart"];

// Clicks on note actions, for the agent to read back (ide_note_events).
const events = [];
let eventSeq = 0;
export function noteEvents(since = 0) {
    return { events: events.filter(e => e.seq > since), next: eventSeq };
}

function validActions(list) {
    return (Array.isArray(list) ? list : []).slice(0, 3).map(a => {
        if (!a || !a.label) throw new Error("each action needs a label");
        if (a.run && !RUNNABLE.includes(a.run)) throw new Error(`action run must be one of: ${RUNNABLE.join(", ")}`);
        return { label: String(a.label).slice(0, 24), run: a.run || "", edits: Array.isArray(a.edits) ? a.edits : null };
    });
}

// doAction records the click and performs the action's effect, if any.
function doAction(markId, a) {
    events.push({ seq: ++eventSeq, mark: markId, action: a.label, at: new Date().toISOString() });
    if (events.length > 200) events.shift();
    document.dispatchEvent(new CustomEvent("volt:note-action", { detail: { mark: markId, action: a.label } }));
    if (a.edits) editorMod.applyAgentEdit({ edits: a.edits });
    if (a.run) document.dispatchEvent(new CustomEvent("volt:run-action", { detail: a.run }));
}

// UI targets an agent can point at: element id, plus how to reveal it.
const UI = {
    check: "checkBtn", run: "runBtn", monitor: "monitorBtn", save: "saveBtn",
    export: "exportBtn", format: "formatBtn", settings: "settingsBtn", ai: "aiButton",
    new: "newProjectBtn", open: "openProjectBtn",
    editor: "editorArea", diagrams: "diagramsView", board: "boardView",
    output: "bottomPanel", side: "sidePanel", toolbar: "toolbar",
    hardware: "sidePanel", outline: "sidePanel", library: "toggleLibrary",
};
export const UI_TARGETS = Object.keys(UI);

const MAX_WAIT_S = 30 * 60;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ed() {
    const e = typeof monaco !== "undefined" && monaco.editor.getEditors()[0];
    if (!e || !e.getModel()) throw new Error("No program is open in the editor. Use ide_open first.");
    return e;
}

// Tiny, safe formatting for notes: escaped text, `code`, **bold**, newlines.
function fmt(text) {
    const esc = String(text || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    return esc.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
}

// ── anchors ────────────────────────────────────────────────────────────────

// resolveRange turns { line, end_line, col, end_col, find, occurrence } into
// a Monaco range. find picks the occurrence-th match (from line, if given).
export function resolveRange(a) {
    const model = ed().getModel();
    const last = model.getLineCount();
    if (a.find) {
        const from = a.line ? new monaco.Range(a.line, 1, last, model.getLineMaxColumn(last)) : model.getFullModelRange();
        const hits = model.findMatches(String(a.find), from, false, true, null, false);
        const n = Math.max(1, a.occurrence || 1);
        if (hits.length < n) throw new Error(`"${a.find}" not found${a.line ? ` from line ${a.line}` : ""}${n > 1 ? ` (${n} times)` : ""}.`);
        return hits[n - 1].range;
    }
    const line = Number(a.line);
    if (!(line >= 1 && line <= last)) throw new Error(`line must be 1–${last}`);
    const end = Math.min(last, Math.max(line, Number(a.end_line) || line));
    const sc = a.col ? Math.max(1, a.col) : 1;
    const ec = a.end_col ? a.end_col : model.getLineMaxColumn(end);
    return new monaco.Range(line, sc, end, ec);
}

function hasCode(a) { return a && (a.line || a.find); }

async function showCode() {
    diagramsView.showView("code");
    await sleep(60);
}

async function uiElement(target) {
    const id = UI[target];
    if (!id) throw new Error(`target must be one of: ${UI_TARGETS.join(", ")}`);
    if (["hardware", "outline"].includes(target)) { sidePanel.open(target); await sleep(250); }
    if (["diagrams", "board"].includes(target)) { diagramsView.showView(target); await sleep(300); }
    if (["editor", "side", "hardware", "outline", "library"].includes(target)) await showCode();
    const el = document.getElementById(id);
    const r = el && el.getBoundingClientRect();
    if (!r || r.width < 2 || r.height < 2) throw new Error(`The ${target} isn't visible right now (open a project first?).`);
    return el;
}

// ── ide_point: persistent marks with visible notes ─────────────────────────

let marks = [];            // { id, deco, zone, el, kind }
let uiMarks = [];          // { el, card }
let markSeq = 0;
let watching = false;

function removeMark(m) {
    const e = monaco.editor.getEditors()[0];
    if (e) e.removeDecorations(m.decos);
    marks = marks.filter(x => x !== m);
}

export function clearPoints() {
    [...marks].forEach(removeMark);
    uiMarks.forEach(u => { u.el.classList.remove("agent-ring"); u.card.remove(); });
    uiMarks = [];
}

function watchEdits(editor) {
    if (watching) return;
    watching = true;
    editor.onDidChangeModelContent(e => {
        // The user (or an edit) touched a marked span: the note no longer applies.
        for (const m of [...marks]) {
            const r = editor.getModel().getDecorationRange(m.decos[0]);
            if (!r || e.changes.some(c => monaco.Range.areIntersectingOrTouching(c.range, r))) removeMark(m);
        }
    });
    editor.onDidChangeModel(() => { marks = []; });
    // A note's × (its own injected span) dismisses it.
    editor.onMouseDown(ev => {
        const t = ev.event.browserEvent.target;
        const span = t.closest && t.closest(".agent-ghost-x, .agent-act");
        if (!span) return;
        const [, id, k] = span.className.match(/agent-(?:x|act)-(\d+)(?:-(\d+))?/) || [];
        const m = marks.find(x => x.id === Number(id));
        if (!m) return;
        ev.event.preventDefault();
        if (k === undefined) return removeMark(m);
        if (m.life !== "fixed") removeMark(m);
        doAction(m.id, m.actions[Number(k)]);
    });
}

// ghost is the one-line form of a note shown after the code.
function ghost(note) {
    const flat = String(note).replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
    return flat.length > 90 ? flat.slice(0, 89) + "…" : flat;
}

function floatCard(el, html, cls) {
    const card = document.createElement("div");
    card.className = "agent-float " + (cls || "");
    card.innerHTML = html;
    document.body.appendChild(card);
    place(card, el.getBoundingClientRect());
    return card;
}

// place puts a fixed card beside the anchor (side rects that fit), else
// below it, or above if there's no room below.
function place(card, r) {
    if (card.dataset.moved) return; // the user dragged it: leave it there
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (r.side && r.left + cw <= r.maxRight) {
        card.style.left = r.left + "px";
        card.style.top = Math.min(Math.max(8, r.top - 6), vh - ch - 8) + "px";
        return;
    }
    let top = r.bottom + 10;
    if (top + ch > vh - 8) top = Math.max(8, r.top - ch - 10);
    const left = Math.min(Math.max(8, r.left), vw - cw - 8);
    card.style.top = top + "px";
    card.style.left = left + "px";
}

const RULER = { info: "#5B9FD0", change: "#3FB98A", warning: "#D9A440", question: "#A98BD8" };

// point replaces (or, with keep, adds to) the agent's marks. Code marks are
// a soft underline, a ✦ in the gutter and the note as dim text after the line.
export async function point({ marks: list, keep }) {
    if (!keep) clearPoints();
    list = Array.isArray(list) ? list : [];
    const placed = [];
    let first = null;
    for (const m of list) {
        const kind = KINDS.includes(m.kind) ? m.kind : "info";
        if (m.target) {
            const el = await uiElement(m.target);
            el.classList.add("agent-ring");
            const life = LIFETIMES.includes(m.persist) ? m.persist : "dismissable";
            const card = floatCard(el, `<span class="agent-spark" aria-hidden="true">✦</span><span class="agent-float-text">${fmt(m.note || "")}</span>` +
                (life === "dismissable" ? `<button type="button" class="agent-note-x" aria-label="Dismiss AI note">×</button>` : ""), `agent-${kind}`);
            const acts = validActions(m.actions);
            if (acts.length) {
                const row = document.createElement("span");
                row.className = "agent-float-acts";
                card.querySelector(".agent-float-text").appendChild(row);
                acts.forEach(act => {
                    const b = document.createElement("button");
                    b.type = "button"; b.className = "agent-btn agent-act-btn"; b.textContent = act.label;
                    b.onclick = () => { if (life !== "fixed") drop(); doAction(null, act); };
                    row.appendChild(b);
                });
            }
            const u = { el, card };
            const drop = () => { el.classList.remove("agent-ring"); card.remove(); uiMarks = uiMarks.filter(x => x !== u); };
            if (life === "dismissable") card.querySelector(".agent-note-x").onclick = drop;
            if (life === "timeout") setTimeout(() => { if (uiMarks.includes(u)) drop(); }, Math.min(600, Math.max(2, Number(m.seconds) || 8)) * 1000);
            uiMarks.push(u);
            placed.push({ target: m.target });
            continue;
        }
        if (!hasCode(m)) throw new Error("each mark needs line, find or target");
        await showCode();
        const editor = ed();
        watchEdits(editor);
        const range = resolveRange(m);
        const id = ++markSeq;
        const endCol = editor.getModel().getLineMaxColumn(range.endLineNumber);
        const decos = [{
            range,
            options: {
                inlineClassName: `agent-range agent-${kind}`,
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                hoverMessage: m.note ? { value: `✦ **AI** · ${m.note}\n\n*Click the note to dismiss it.*` } : undefined,
                overviewRuler: { color: RULER[kind], position: monaco.editor.OverviewRulerLane.Center },
            },
        }];
        const life = LIFETIMES.includes(m.persist) ? m.persist : "dismissable";
        const at = new monaco.Range(range.endLineNumber, endCol, range.endLineNumber, endCol);
        if (m.note) decos.push({
            range: at,
            options: {
                showIfCollapsed: true,
                after: { content: "✦ " + ghost(m.note), inlineClassName: `agent-ghost agent-${kind}${life === "timeout" ? " agent-fading" : ""}`,
                    cursorStops: monaco.editor.InjectedTextCursorStops.None },
                hoverMessage: { value: `✦ **AI** · ${m.note}` },
            },
        });
        const actions = validActions(m.actions);
        actions.forEach((act, k) => decos.push({
            range: at,
            options: {
                showIfCollapsed: true,
                after: { content: act.label, inlineClassName: `agent-ghost agent-act agent-${kind} agent-act-${id}-${k}`,
                    cursorStops: monaco.editor.InjectedTextCursorStops.None },
            },
        }));
        if (m.note && life === "dismissable") decos.push({
            range: at,
            options: {
                showIfCollapsed: true,
                after: { content: "×", inlineClassName: `agent-ghost agent-ghost-x agent-${kind} agent-x-${id}`,
                    cursorStops: monaco.editor.InjectedTextCursorStops.None },
                hoverMessage: { value: "Dismiss this AI note" },
            },
        });
        const mark = { id, decos: editor.deltaDecorations([], decos), kind, life, actions };
        marks.push(mark);
        if (life === "timeout") {
            const secs = Math.min(600, Math.max(2, Number(m.seconds) || 8));
            setTimeout(() => { if (marks.includes(mark)) removeMark(mark); }, secs * 1000);
        }
        first = first || range;
        placed.push({ id, line: range.startLineNumber, end_line: range.endLineNumber,
            col: range.startColumn, end_col: range.endColumn });
    }
    if (first) ed().revealRangeInCenterIfOutsideViewport(first);
    return { marks: placed };
}

window.addEventListener("resize", () => uiMarks.forEach(u => place(u.card, u.el.getBoundingClientRect())));

// ── interactive cards: walkthrough + ask ───────────────────────────────────

let active = null; // { finish(result) }

function finishActive(result) {
    if (active) active.finish(result);
}

// cancelInteractive ends an open walkthrough/question (e.g. project closed).
export function cancelInteractive(status = "closed") { finishActive({ status }); }

// anchorCard shows card next to a code range or UI target (or centred over
// the editor). Returns a cleanup function.
async function anchorCard(card, anchor) {
    let cleanup = () => {};
    let rectFn, ptFn = () => null;
    const link = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    link.setAttribute("class", "agent-link");
    link.setAttribute("aria-hidden", "true");
    document.body.appendChild(link);
    // layout places the card, then draws the connector from the anchor to it.
    const layout = () => {
        place(card, rectFn());
        const p = ptFn();
        const c = card.getBoundingClientRect();
        if (!p) { link.innerHTML = ""; return; }
        const beside = c.left > p.x;
        const ex = beside ? c.left : Math.min(Math.max(p.x, c.left + 16), c.right - 16);
        const ey = beside ? Math.min(Math.max(p.y, c.top + 18), c.bottom - 18) : (c.top > p.y ? c.top : c.bottom);
        const d = beside
            ? `M${p.x},${p.y} C${(p.x + ex) / 2},${p.y} ${(p.x + ex) / 2},${ey} ${ex},${ey}`
            : `M${p.x},${p.y} C${p.x},${(p.y + ey) / 2} ${ex},${(p.y + ey) / 2} ${ex},${ey}`;
        link.innerHTML = `<path d="${d}"/><circle cx="${p.x}" cy="${p.y}" r="3.5"/>`;
    };
    if (anchor && anchor.target) {
        const el = await uiElement(anchor.target);
        el.classList.add("agent-ring");
        rectFn = () => el.getBoundingClientRect();
        ptFn = () => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom + 6 }; };
        // Spotlight: darken + blur everything but the target.
        const spot = document.createElement("div");
        spot.className = "agent-spotlight";
        const shades = [0, 1, 2, 3].map(() => Object.assign(document.createElement("div"), { className: "agent-shade" }));
        document.body.append(spot, ...shades);
        const px = (v) => Math.max(0, v) + "px";
        const fit = () => {
            const r = el.getBoundingClientRect();
            const L = r.left - 6, T = r.top - 6, R = r.right + 6, B = r.bottom + 6;
            Object.assign(spot.style, { left: px(L), top: px(T), width: px(R - L), height: px(B - T) });
            const [top, bottom, left, right] = shades;
            Object.assign(top.style, { left: 0, top: 0, width: "100vw", height: px(T) });
            Object.assign(bottom.style, { left: 0, top: px(B), width: "100vw", bottom: 0 });
            Object.assign(left.style, { left: 0, top: px(T), width: px(L), height: px(B - T) });
            Object.assign(right.style, { left: px(R), top: px(T), right: 0, height: px(B - T) });
        };
        fit();
        window.addEventListener("resize", fit);
        cleanup = () => { el.classList.remove("agent-ring"); spot.remove(); shades.forEach(x => x.remove()); window.removeEventListener("resize", fit); };
    } else if (hasCode(anchor)) {
        await showCode();
        const editor = ed();
        const range = resolveRange(anchor);
        // Focus: dim + blur every other line, and the IDE around the editor.
        const last = editor.getModel().getLineCount();
        const dim = [];
        if (range.startLineNumber > 1) dim.push(new monaco.Range(1, 1, range.startLineNumber - 1, 1e9));
        if (range.endLineNumber < last) dim.push(new monaco.Range(range.endLineNumber + 1, 1, last, 1e9));
        const ids = editor.deltaDecorations([], [
            ...dim.map(r => ({ range: r, options: { inlineClassName: "agent-dim", isWholeLine: true } })),
            { range, options: { className: "agent-focus-line", isWholeLine: true } },
        ]);
        document.body.classList.add("agent-focus-code");
        editor.revealRangeInCenter(range);
        await sleep(30);
        const model = editor.getModel();
        const lineH = editor.getOption(monaco.editor.EditorOption.lineHeight);
        const lineEnd = (l) => {
            const p = l <= last && editor.getScrolledVisiblePosition({ lineNumber: l, column: model.getLineMaxColumn(l) });
            return p ? p.left : 0;
        };
        // Beside the code, clear of every line the card spans (so it never
        // covers code), level with the first line; a connector joins them.
        rectFn = () => {
            const box = editor.getDomNode().getBoundingClientRect();
            const top = editor.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: 1 });
            const bot = editor.getScrolledVisiblePosition({ lineNumber: range.endLineNumber, column: 1 });
            if (!top || !bot) return box;
            const span = Math.ceil(card.offsetHeight / lineH) + 1;
            let right = 0;
            for (let l = range.startLineNumber; l <= Math.max(range.endLineNumber, range.startLineNumber + span); l++) right = Math.max(right, lineEnd(l));
            const x = box.left + right + 64;
            return { side: true, left: x, right: x, top: box.top + top.top, bottom: box.top + bot.top + bot.height, maxRight: box.right - 24 };
        };
        ptFn = () => {
            const box = editor.getDomNode().getBoundingClientRect();
            const p = editor.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: model.getLineMaxColumn(range.startLineNumber) });
            return p && { x: box.left + p.left + 8, y: box.top + p.top + p.height / 2 };
        };
        const sub = editor.onDidScrollChange(() => layout());
        cleanup = () => { sub.dispose(); editor.removeDecorations(ids); document.body.classList.remove("agent-focus-code"); };
    } else {
        const host = document.getElementById("editorArea");
        rectFn = () => {
            const r = host && host.offsetWidth ? host.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth };
            const left = r.left + (r.width - card.offsetWidth) / 2;
            return { left, right: left, top: r.top + 40, bottom: r.top + 40 };
        };
    }
    window.addEventListener("resize", layout);
    card._layout = layout;
    layout();
    return () => { cleanup(); link.remove(); window.removeEventListener("resize", layout); };
}

// interact opens one card and resolves with the user's outcome.
function interact(timeoutS, build) {
    finishActive({ status: "replaced" });
    return new Promise(resolve => {
        const card = document.createElement("div");
        card.className = "agent-card";
        card.setAttribute("role", "dialog");
        document.body.appendChild(card);
        const prevFocus = document.activeElement;
        let undo = () => {};
        const timer = setTimeout(() => done({ status: "timeout" }), Math.min(MAX_WAIT_S, Math.max(10, timeoutS || 600)) * 1000);
        function done(result) {
            if (active !== me) return;
            active = null;
            clearTimeout(timer);
            undo();
            card.remove();
            document.removeEventListener("keydown", onKey, true);
            if (prevFocus && prevFocus.focus) prevFocus.focus();
            resolve(result);
        }
        const me = { finish: done };
        active = me;
        // Drag by the header; the connector follows (layout redraws it).
        card.addEventListener("pointerdown", (e) => {
            const head = e.target.closest(".agent-card-head");
            if (!head || e.target.closest("button") || e.button !== 0) return;
            e.preventDefault();
            const r = card.getBoundingClientRect();
            const dx = e.clientX - r.left, dy = e.clientY - r.top;
            head.setPointerCapture(e.pointerId);
            card.classList.add("dragging");
            const move = (ev) => {
                card.dataset.moved = "1";
                card.style.left = Math.min(Math.max(0, ev.clientX - dx), innerWidth - r.width) + "px";
                card.style.top = Math.min(Math.max(0, ev.clientY - dy), innerHeight - 40) + "px";
                card._layout?.(); // redraw the connector
            };
            const up = () => { card.classList.remove("dragging"); head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); };
            head.addEventListener("pointermove", move);
            head.addEventListener("pointerup", up);
        });
        const onKey = (e) => {
            if (!card.isConnected) return;
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(me.closeResult ? me.closeResult() : { status: "closed" }); }
        };
        document.addEventListener("keydown", onKey, true);
        build(card, me, done, async (anchor) => {
            undo();
            try { undo = await anchorCard(card, anchor); }
            catch (e) { done({ status: "error", error: e.message }); throw e; }
            (card.querySelector("[data-primary]") || card).focus();
        });
    });
}

function cardHead(label, counter) {
    return `<div class="agent-card-head"><span class="agent-spark" aria-hidden="true">✦</span><span class="agent-card-title">${fmt(label)}</span>` +
        (counter ? `<span class="agent-card-count">${counter}</span>` : "") +
        `<button type="button" class="agent-card-x" aria-label="Close">×</button></div>`;
}

// walkthrough shows steps one at a time; the user moves with Back/Next.
export function walkthrough({ title, steps, timeout_s }) {
    if (!Array.isArray(steps) || !steps.length) throw new Error("steps is required");
    if (steps.length > 30) throw new Error("at most 30 steps");
    let i = 0, furthest = 0;
    return interact(timeout_s, (card, me, done, anchor) => {
        me.closeResult = () => ({ status: "closed", step: i + 1, furthest: furthest + 1, total: steps.length });
        const render = async () => {
            const s = steps[i];
            furthest = Math.max(furthest, i);
            card.setAttribute("aria-label", `AI walkthrough, step ${i + 1} of ${steps.length}`);
            card.innerHTML = cardHead(s.title || title || "Walkthrough", `${i + 1} / ${steps.length}`) +
                `<div class="agent-card-body">${fmt(s.text)}</div>` +
                `<form class="agent-card-ask"><input type="text" placeholder="Ask about this step…" aria-label="Ask the AI about this step"><button type="submit" class="agent-btn">Ask</button></form>` +
                `<div class="agent-card-foot"><button type="button" class="agent-btn" data-back ${i ? "" : "disabled"}>Back</button>` +
                `<button type="button" class="agent-btn primary" data-primary>${i === steps.length - 1 ? "Done" : "Next"}</button></div>`;
            card.querySelector(".agent-card-x").onclick = () => done(me.closeResult());
            card.querySelector("[data-back]").onclick = () => { if (i) { i--; render(); } };
            card.querySelector("[data-primary]").onclick = () => {
                if (i === steps.length - 1) done({ status: "done", step: i + 1, furthest: steps.length, total: steps.length });
                else { i++; render(); }
            };
            card.querySelector("form").onsubmit = (e) => {
                e.preventDefault();
                const q = e.target.querySelector("input").value.trim();
                if (q) done({ status: "question", step: i + 1, furthest: furthest + 1, total: steps.length, question: q });
            };
            card.onkeydown = (e) => {
                if (e.target.tagName === "INPUT") return;
                if (e.key === "ArrowRight") card.querySelector("[data-primary]").click();
                if (e.key === "ArrowLeft") card.querySelector("[data-back]").click();
            };
            await anchor(s).catch(() => {});
        };
        render();
    });
}

// ask shows a question with choices and/or a text answer.
export function ask({ question, choices, allow_text, anchor: at, timeout_s }) {
    if (!question) throw new Error("question is required");
    choices = (Array.isArray(choices) ? choices : []).map(String).slice(0, 8);
    const text = allow_text === undefined ? !choices.length : !!allow_text;
    return interact(timeout_s, (card, me, done, anchor) => {
        card.setAttribute("aria-label", "AI question");
        card.innerHTML = cardHead("Question") + `<div class="agent-card-body">${fmt(question)}</div>` +
            (choices.length ? `<div class="agent-card-choices">${choices.map((c, k) =>
                `<button type="button" class="agent-btn${k ? "" : " primary"}" data-k="${k}"${k ? "" : " data-primary"}>${fmt(c)}</button>`).join("")}</div>` : "") +
            (text ? `<form class="agent-card-ask"><input type="text" placeholder="Type an answer…" aria-label="Your answer"${choices.length ? "" : " data-primary"}><button type="submit" class="agent-btn primary">Send</button></form>` : "");
        card.querySelector(".agent-card-x").onclick = () => done({ status: "closed" });
        card.querySelectorAll("[data-k]").forEach(b => { b.onclick = () => done({ status: "answered", choice: choices[+b.dataset.k] }); });
        const f = card.querySelector("form");
        if (f) f.onsubmit = (e) => {
            e.preventDefault();
            const v = f.querySelector("input").value.trim();
            if (v) done({ status: "answered", text: v });
        };
        anchor(at || null).catch(() => {});
    });
}

// select puts the user's cursor/selection on a range and scrolls to it.
export async function select(a) {
    await showCode();
    const editor = ed();
    const r = resolveRange(a);
    editor.setSelection(r);
    editor.revealRangeInCenter(r);
    editor.focus();
    return { line: r.startLineNumber, col: r.startColumn, end_line: r.endLineNumber, end_col: r.endColumn };
}

