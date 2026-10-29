// history.js — the project's change history (volt history: a private git
// history in <project>/.volt/history). It records every save with who made the
// change — you, Volt Assistant (and its model), an AI app over MCP, or an edit
// outside the IDE — shows the timeline in the History panel, opens any change
// as a diff you can undo or restore, and traces lines back to their change.

import * as editorMod from "./editor.js";
import * as overlay from "./agent-overlay.js";
import * as bottomPanel from "./bottom-panel.js";

const H = window.volt.history;

let project = null;
let pending = { authors: new Set(), notes: [] }; // since the last record
let panelBody = null;
let authorsOn = false;
let authorDecos = [];
const blameMarks = new Map(); // ghost-note mark id → change hash

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const base = (p) => (p || "").split(/[\\/]/).pop();
const rel = (file) => project && file && file.startsWith(project) ? file.slice(project.length).replace(/^[\\/]/, "") : base(file);

// kind groups authors for colour and icon.
function kind(author) {
    if (/^You\b/.test(author)) return "you";
    if (/^Volt Assistant/.test(author)) return "assistant";
    if (/^Outside|Unrecorded|while Volt/.test(author)) return "outside";
    if (author === "Volt") return "you";
    return "agent";
}
const ICON = { you: "Y", assistant: "✦", agent: "⇄", outside: "!" };

function ago(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── tracking ───────────────────────────────────────────────────────────────

document.addEventListener("volt:agent-edit", (e) => {
    const client = e.detail && e.detail.client;
    pending.authors.add(client || "AI agent");
});

export function init() {
    editorMod.onContentChange((source) => { if (!source) pending.authors.add("You"); });
}

async function record(author, message) {
    if (!project) return;
    try {
        const r = await H.record(project, author, message);
        if (r && r.recorded) { refresh(); document.dispatchEvent(new CustomEvent("volt:history-recorded")); }
    } catch (e) { console.warn("[history]", e.message); }
}

// opened records anything that changed while the IDE was closed, so later
// changes aren't blamed on whoever saves next.
export async function opened(dir) {
    project = dir;
    pending = { authors: new Set(), notes: [] };
    clearAuthors();
    const log = await H.log(dir, "", 1).catch(() => []);
    if (log.length) await record("Outside Volt IDE", "Changed while Volt IDE was closed");
    else await record("Volt", "History started — the project as it was");
    refresh();
}

export function closed() { project = null; clearAuthors(); refresh(); }

// afterSave records the save, credited to everyone who edited since the last one.
export async function afterSave(file) {
    const authors = [...pending.authors];
    const ai = authors.filter(a => a !== "You");
    const author = authors.length ? authors.join(" + ") : "You";
    const note = pending.notes.length ? `“${pending.notes[pending.notes.length - 1]}”` : "";
    const message = ai.length ? `${ai.join(" + ")} edited ${base(file)}${note ? ": " + note : ""}` : "";
    pending = { authors: new Set(), notes: [] };
    await record(author, message);
}

export async function outsideEdit(file) {
    const a = await H.lastAgent().catch(() => null);
    const who = a && Date.now() - a.at < 5 * 60_000 && a.client ? ` (${a.client} was active)` : "";
    await record(`Outside Volt IDE${who}`, `${base(file)} was changed outside Volt IDE${who}`);
}

// ── panel ──────────────────────────────────────────────────────────────────

export async function renderInto(body) {
    panelBody = body;
    await refresh();
}

async function refresh() {
    if (!panelBody || !panelBody.isConnected) return;
    if (!project) { panelBody.innerHTML = `<p class="hs-empty">Open a project to see its history.</p>`; return; }
    let log = [];
    try { log = await H.log(project, "", 200); }
    catch (e) { panelBody.innerHTML = `<p class="hs-empty">History isn't available: ${esc(e.message)}</p>`; return; }
    const days = new Map();
    for (const e of log) {
        const d = new Date(e.when).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        if (!days.has(d)) days.set(d, []);
        days.get(d).push(e);
    }
    panelBody.innerHTML = `<div class="hs-root">
        <div class="hs-bar"><label class="hs-toggle"><input type="checkbox" data-authors${authorsOn ? " checked" : ""}> Show who wrote each line</label></div>
        ${log.length ? [...days].map(([d, es]) => `<div class="hs-day">${esc(d)}</div>` + es.map(e => `
          <button type="button" class="hs-entry k-${kind(e.author)}" data-h="${e.hash}">
            <span class="hs-av" aria-hidden="true">${ICON[kind(e.author)]}</span>
            <span class="hs-main"><span class="hs-msg">${esc(e.message)}</span>
              <span class="hs-meta">${esc(e.author)} · ${ago(e.when)}</span></span>
            <span class="hs-stat"><span class="hs-plus">+${e.added}</span> <span class="hs-minus">−${e.removed}</span></span>
          </button>`).join("")).join("") : `<p class="hs-empty">No changes recorded yet. Every save is recorded here with who made it.</p>`}
      </div>`;
    panelBody.querySelectorAll("[data-h]").forEach(b => b.onclick = () => openChange(b.dataset.h));
    panelBody.querySelector("[data-authors]").onchange = (e) => { authorsOn = e.target.checked; authorsOn ? showAuthors() : clearAuthors(); };
}

// ── a change: diff sheet with Undo / Restore ─────────────────────────────

let sheet = null, diffEd = null;

function closeSheet() {
    if (diffEd) { const m = diffEd.getModel(); diffEd.dispose(); m?.original?.dispose(); m?.modified?.dispose(); diffEd = null; }
    sheet?.remove(); sheet = null;
    document.removeEventListener("keydown", sheetKeys, true);
}
function sheetKeys(e) { if (e.key === "Escape") { e.preventDefault(); closeSheet(); } }

function lang(p) { return /\.volt$/.test(p) ? "volt" : /\.(c|h)$/.test(p) ? "c" : /\.json$/.test(p) ? "json" : "plaintext"; }

export async function openChange(hash) {
    if (!project) return;
    let ch;
    try { ch = await H.show(project, hash); } catch (e) { bottomPanel.appendOutput("History: " + e.message, "error"); return; }
    closeSheet();
    sheet = document.createElement("div");
    sheet.className = "hs-backdrop";
    sheet.innerHTML = `<div class="hs-sheet" role="dialog" aria-modal="true" aria-labelledby="hsTitle">
        <header class="hs-head"><span class="hs-av k-${kind(ch.author)}" aria-hidden="true">${ICON[kind(ch.author)]}</span>
          <div><h2 id="hsTitle">${esc(ch.message)}</h2><p>${esc(ch.author)} · ${new Date(ch.when).toLocaleString()} · <span class="hs-plus">+${ch.added}</span> <span class="hs-minus">−${ch.removed}</span></p></div>
          <button type="button" class="hs-x" aria-label="Close">×</button></header>
        <div class="hs-body"><nav class="hs-files">${ch.changes.map((c, i) => `<button type="button" class="hs-file${i ? "" : " on"}" data-i="${i}"><span>${esc(c.path)}</span><em class="s-${c.status}">${c.status}</em></button>`).join("")}</nav>
          <div class="hs-diff"></div></div>
        <footer class="hs-foot"><span class="hs-hint">Undo reverses only this change. Restore puts the project back to how it was right after it.</span>
          <button type="button" class="lr-btn" data-act="undo">Undo this change</button>
          <button type="button" class="lr-btn primary" data-act="restore">Restore this version</button></footer></div>`;
    document.body.appendChild(sheet);
    document.addEventListener("keydown", sheetKeys, true);
    sheet.addEventListener("mousedown", (e) => { if (e.target === sheet) closeSheet(); });
    sheet.querySelector(".hs-x").onclick = closeSheet;
    const show = (i) => {
        const c = ch.changes[i];
        sheet.querySelectorAll(".hs-file").forEach((b, k) => b.classList.toggle("on", k === i));
        if (diffEd) { const m = diffEd.getModel(); diffEd.dispose(); m?.original?.dispose(); m?.modified?.dispose(); }
        const host = sheet.querySelector(".hs-diff");
        host.innerHTML = "";
        diffEd = monaco.editor.createDiffEditor(host, { readOnly: true, automaticLayout: true, renderSideBySide: true, minimap: { enabled: false },
            fontSize: 12.5, scrollBeyondLastLine: false, hideUnchangedRegions: { enabled: true, contextLineCount: 3 } });
        diffEd.setModel({ original: monaco.editor.createModel(c.before, lang(c.path)), modified: monaco.editor.createModel(c.after, lang(c.path)) });
    };
    sheet.querySelectorAll(".hs-file").forEach(b => b.onclick = () => show(+b.dataset.i));
    if (ch.changes.length) show(0);
    sheet.querySelectorAll("[data-act]").forEach(b => b.onclick = () => act(b.dataset.act, hash));
    sheet.querySelector('[data-act="undo"]').focus();
}

async function act(what, hash) {
    if (editorMod.isUnsaved()) {
        bottomPanel.appendOutput("Save or undo your current edits first — history works on saved files.", "warn");
        return;
    }
    try {
        what === "undo" ? await H.undo(project, hash) : await H.restore(project, hash);
        closeSheet();
        bottomPanel.appendOutput(what === "undo" ? "Undid that change (recorded in History)" : "Restored that version (recorded in History)", "success");
        refresh(); // the open file reloads through the outside-edit watcher
    } catch (e) { bottomPanel.appendOutput("History: " + e.message, "error"); }
}

// ── tracing lines ──────────────────────────────────────────────────────────

async function blameFor(file) {
    if (!project || !file) return [];
    return H.blame(project, rel(file)).catch(() => []);
}

// whoChanged shows who last changed the line at the cursor, as a note.
export async function whoChanged() {
    const ed = monaco.editor.getEditors()[0];
    if (!ed || !project) return;
    const line = ed.getPosition().lineNumber;
    const b = (await blameFor(editorMod.getCurrentFile())).find(x => x.line === line);
    if (!b) { bottomPanel.appendOutput("This line isn't in the recorded history yet (save to record it).", "info"); return; }
    const res = await overlay.point({ keep: true, marks: [{ line, persist: "dismissable", kind: kind(b.author) === "you" ? "info" : "change",
        note: `${b.author} · ${ago(b.when)} — ${b.message}`, actions: [{ label: "Show change" }] }] });
    const id = res.marks[0] && res.marks[0].id;
    if (id) blameMarks.set(id, b.hash);
}

document.addEventListener("volt:note-action", (e) => {
    const { mark, action } = e.detail || {};
    if (action === "Show change" && blameMarks.has(mark)) openChange(blameMarks.get(mark));
});

// showAuthors colours the gutter by who wrote each line (hover for details).
async function showAuthors() {
    const ed = monaco.editor.getEditors()[0];
    if (!ed) return;
    const lines = await blameFor(editorMod.getCurrentFile());
    const max = ed.getModel().getLineCount();
    authorDecos = ed.deltaDecorations(authorDecos, lines.filter(b => b.line <= max).map(b => ({
        range: new monaco.Range(b.line, 1, b.line, 1),
        options: { isWholeLine: true, linesDecorationsClassName: `hs-gut k-${kind(b.author)}`,
            hoverMessage: { value: `**${b.author}** · ${ago(b.when)}\n\n${b.message}` } },
    })));
}

function clearAuthors() {
    const ed = monaco.editor && monaco.editor.getEditors()[0];
    if (ed) authorDecos = ed.deltaDecorations(authorDecos, []);
}

// After each recorded save the line authors move with the code.
document.addEventListener("volt:history-recorded", () => { if (authorsOn) showAuthors(); });
