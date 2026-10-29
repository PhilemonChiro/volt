// lib-review.js — the review sheet for device libraries that are new or have
// changed since the user approved them (main: src/main/lib-trust.js).
//
// It opens by itself the moment such a library appears, and it is a real
// gate: clicking outside or pressing Escape does not close it. The user picks
// Reject (the default), Decide later (builds stay blocked) or Approve & sign.

import * as bottomPanel from "./bottom-panel.js";
import * as dialog from "./dialog.js";
import { deviceOverview } from "./device-card.js";

const T = window.volt.libTrust;
const STATE = { unapproved: "New", changed: "Changed", invalid: "Record invalid", unreadable: "Unreadable" };

let sheet = null;       // root element while open
let items = [];         // pending libraries
let cur = null;         // details of the selected one
let fileIdx = 0;
let editor = null;      // Monaco (diff) editor
let focusReq = null;    // { root, name } an agent asked about
let showAll = false;    // list unchanged files too

// Calls worth a second look when they appear in added code. A reading aid
// only — the review is the user's.
const RISKS = [
    [/\b(__)?asm\b|__asm__/, "inline assembly"],
    [/\b(esp_)?(spi_)?flash_(write|erase)|esp_partition_(write|erase)/, "writes flash"],
    [/\bnvs_(set|erase|commit)/, "writes settings storage (NVS)"],
    [/\besp_(wifi|http_client|mqtt)|socket\s*\(|lwip|connect\s*\(/, "network access"],
    [/\besp_restart|abort\s*\(|esp_deep_sleep/, "restarts or sleeps the chip"],
    [/\besp_efuse|efuse_/, "eFuse access (permanent)"],
    [/#\s*include\s*[<"](?!volt\/|driver\/|freertos\/|esp_err|stdint|stdbool|string|stdio|stdlib|math)/, "includes an unusual header"],
    [/\b(system|popen|fopen)\s*\(/, "file or shell access"],
];

// lineDiff counts added/removed lines and lists the added ones (1-based).
function lineDiff(prev, next) {
    const a = (prev || "").split("\n"), b = (next || "").split("\n");
    const left = new Map();
    a.forEach(l => left.set(l, (left.get(l) || 0) + 1));
    const added = [];
    b.forEach((l, i) => { const n = left.get(l) || 0; if (n) left.set(l, n - 1); else added.push({ n: i + 1, text: l }); });
    const removed = [...left.values()].reduce((x, y) => x + y, 0);
    return { added, removed };
}

function summaryHtml() {
    const rows = [], risks = [];
    for (const f of cur.files) {
        if (!fileTag(f)) continue;
        if (f.removed) { rows.push(`<li><code>${esc(f.path)}</code> removed</li>`); continue; }
        const d = cur.hasPrevious && f.prev !== null ? lineDiff(f.prev, f.text) : lineDiff("", f.text);
        rows.push(`<li><code>${esc(f.path)}</code> <span class="lr-plus">+${d.added.length}</span>${d.removed ? ` <span class="lr-minus">−${d.removed}</span>` : ""}${f.prev === null && cur.hasPrevious ? " (new file)" : ""}</li>`);
        for (const l of d.added) for (const [re, what] of RISKS) if (re.test(l.text)) risks.push(`<li><code>${esc(f.path)}:${l.n}</code> ${what}: <code>${esc(l.text.trim().slice(0, 90))}</code></li>`);
    }
    if (!cur.hasPrevious) {
        const n = cur.files.length;
        return `<div class="lr-summary"><b>${n} file${n === 1 ? "" : "s"}</b>, nothing approved to compare with.${risks.length ? `<p class="lr-risk-h">Look closely at:</p><ul class="lr-risks">${risks.slice(0, 12).join("")}</ul>` : ""}</div>`;
    }
    const about = cur.framework ? [...new Set(cur.files.filter(f => fileTag(f)).flatMap(f =>
        lineDiff(f.prev, f.text).added.flatMap(l => [...l.text.matchAll(/\b([a-z][a-z0-9]{1,15})_[a-z_]+\s*\(/g)].map(m => m[1]))))]
        .filter(p => !["volt", "esp", "gpio", "uart", "i2c", "spi"].includes(p)) : [];
    return `<div class="lr-summary"><b>${rows.length} of ${cur.files.length} files changed</b>` +
        (about.length ? ` — adds functions for <b>${about.map(esc).join(", ")}</b>` : "") + `<ul class="lr-changes">${rows.join("")}</ul>` +
        (risks.length ? `<p class="lr-risk-h">Look closely at:</p><ul class="lr-risks">${risks.slice(0, 12).join("")}</ul>` : `<p class="lr-ok">No flash, network, assembly or restart calls in the added lines.</p>`) + `</div>`;
}

// shownFiles is the file list: changed files only when there's a diff base.
function shownFiles() {
    const all = cur.files.map((f, k) => ({ f, k }));
    return cur.hasPrevious && !showAll ? all.filter(({ f }) => fileTag(f)) : all;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const label = (n) => n === "@framework" ? "Volt framework" : n;
const shortRoot = (r) => r.replace(/^\/Users\/[^/]+/, "~");

function langOf(p) {
    if (/\.(c|h)$/.test(p)) return "c";
    if (/\.json$/.test(p)) return "json";
    if (/\.cmake$|CMakeLists/.test(p)) return "cmake";
    return "plaintext";
}

// darkTheme: the IDE's own theme once its editor exists (Monaco has one
// global theme); before a project is open, a dark theme matching the sheet.
function darkTheme() {
    if (monaco.editor.getEditors().some(e => e.getDomNode()?.closest("#editorContainer"))) return "volt-dark";
    monaco.editor.defineTheme("volt-review", { base: "vs-dark", inherit: true, rules: [],
        colors: { "editor.background": "#14171C", "editorGutter.background": "#14171C" } });
    return "volt-review";
}

function disposeEditor() {
    if (!editor) return;
    const m = editor.getModel && editor.getModel();
    editor.dispose();
    if (m && m.original) { m.original.dispose(); m.modified.dispose(); } else if (m && m.dispose) m.dispose();
    editor = null;
}

function showFile() {
    disposeEditor();
    const host = sheet.querySelector(".lr-code");
    host.innerHTML = "";
    if (fileIdx === -1) {
        host.innerHTML = deviceOverview(cur.device || {}, cur.name);
        const ds = host.querySelector(".lr-ds");
        if (ds) ds.onclick = (e) => { e.preventDefault(); window.volt.openExternal(ds.dataset.url); };
        return;
    }
    const f = cur.files[fileIdx];
    if (!f) { host.innerHTML = `<div class="lr-empty">No files.</div>`; return; }
    const common = { readOnly: true, automaticLayout: true, minimap: { enabled: false }, fontSize: 12.5,
        scrollBeyondLastLine: false, renderLineHighlight: "none", theme: darkTheme() };
    if (cur.hasPrevious && f.prev !== null && f.text !== null && f.prev !== f.text) {
        editor = monaco.editor.createDiffEditor(host, { ...common, renderSideBySide: true, originalEditable: false,
            hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4 } });
        editor.setModel({
            original: monaco.editor.createModel(f.prev, langOf(f.path)),
            modified: monaco.editor.createModel(f.text, langOf(f.path)),
        });
    } else {
        editor = monaco.editor.create(host, { ...common, value: f.text ?? f.prev ?? "", language: langOf(f.path) });
    }
}

function fileTag(f) {
    if (f.removed) return `<span class="lr-ftag del">removed</span>`;
    if (f.link) return `<span class="lr-ftag warn">link</span>`;
    if (!cur.hasPrevious) return "";
    if (f.prev === null) return `<span class="lr-ftag add">new</span>`;
    if (f.prev !== f.text) return `<span class="lr-ftag mod">changed</span>`;
    return "";
}

function capsHtml(c) {
    if (!c) return "";
    const chips = [];
    if (c.interface) chips.push(`Interface: ${esc(c.interface)}`);
    if (c.address) chips.push(`Address: ${esc(c.address)}`);
    if (c.pins) chips.push(`Pins: ${esc(Array.isArray(c.pins) ? c.pins.map(p => p.name || p).join(", ") : Object.keys(c.pins).join(", "))}`);
    if (c.category) chips.push(esc(c.category));
    return chips.map(x => `<span class="lr-chip">${x}</span>`).join("");
}

function render() {
    const multi = items.length > 1;
    const i = items.findIndex(x => x.root === cur.root && x.name === cur.name);
    const changedFiles = cur.files.filter(f => fileTag(f)).length;
    const failing = !!(cur.checks && cur.checks.errors && cur.checks.errors.length);
    sheet.querySelector(".lr-dialog").innerHTML = `
      <header class="lr-head">
        <div>
          <h2 id="lrTitle">Review device library</h2>
          <p class="lr-sub">Volt won't build with a library you haven't approved. Read the code, then decide.</p>
        </div>
        ${multi ? `<span class="lr-count">${i + 1} of ${items.length}</span>` : ""}
      </header>
      <div class="lr-body">
        ${multi ? `<nav class="lr-list" aria-label="Libraries to review">${items.map((x, k) => `
            <button type="button" class="lr-item${k === i ? " on" : ""}" data-k="${k}">
              <span>${esc(label(x.name))}</span><span class="lr-state s-${x.state}">${STATE[x.state] || x.state}</span>
            </button>`).join("")}</nav>` : ""}
        <section class="lr-main">
          <div class="lr-title">
            <h3>${esc(label(cur.name))}</h3>
            <span class="lr-state s-${cur.state}">${STATE[cur.state] || cur.state}</span>
            <span class="lr-root" title="${esc(cur.root)}">${esc(shortRoot(cur.root))}</span>
          </div>
          <p class="lr-who">${esc(cur.who)}${cur.hasPrevious ? ` Showing changes against ${esc(cur.prevLabel)}.` : cur.state === "changed" ? " The approved version can't be shown, so read every file." : " Nothing was approved here before — read every file."}</p>
          ${cur.state === "invalid" ? `<p class="lr-alert">Its approval record doesn't verify — it may have been edited by hand.</p>` : ""}
          ${cur.detail && cur.state === "unreadable" ? `<p class="lr-alert">${esc(cur.detail)}</p>` : ""}
          ${failing ? `<div class="lr-alert"><b>Fails the library checks</b> — it can't be approved until these are fixed:<ul>${cur.checks.errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
          <div class="lr-caps">${capsHtml(cur.capabilities)}</div>
          ${summaryHtml()}
          <div class="lr-split">
            <div class="lr-files" role="tablist" aria-label="Files">
              ${cur.hasPrevious ? `<div class="lr-fcount">${changedFiles} of ${cur.files.length} files changed</div>` : `<div class="lr-fcount">${cur.files.length} files</div>`}
              ${cur.device ? `<button type="button" role="tab" class="lr-file lr-ovtab${fileIdx === -1 ? " on" : ""}" data-f="-1" aria-selected="${fileIdx === -1}"><span>Overview</span></button>` : ""}
              ${shownFiles().map(({ f, k }) => `
              <button type="button" role="tab" class="lr-file${k === fileIdx ? " on" : ""}" data-f="${k}" aria-selected="${k === fileIdx}"><span>${esc(f.path)}</span>${fileTag(f)}</button>`).join("")}
              ${cur.hasPrevious && changedFiles < cur.files.length ? `<button type="button" class="lr-showall">${showAll ? "Show changed files only" : `Show all ${cur.files.length} files`}</button>` : ""}
            </div>
            <div class="lr-code"></div>
          </div>
        </section>
      </div>
      <footer class="lr-foot">
        ${focusReq ? `<input class="lr-reason" type="text" placeholder="Note for the AI agent (optional) — e.g. why you rejected it" aria-label="Note for the AI agent">` : ""}
        <span class="lr-spacer"></span>
        <button type="button" class="lr-btn" data-d="reject">${cur.hasPrevious ? "Reject change" : cur.framework ? "Keep blocked" : "Reject"}</button>
        <button type="button" class="lr-btn" data-d="later">Decide later</button>
        <button type="button" class="lr-btn primary" data-d="approve"${failing ? ` disabled title="Fix the library check errors first"` : ""}>Approve &amp; sign</button>
      </footer>`;
    sheet.querySelectorAll(".lr-item").forEach(b => b.onclick = () => select(items[+b.dataset.k]));
    sheet.querySelectorAll(".lr-file").forEach(b => b.onclick = () => {
        fileIdx = +b.dataset.f;
        sheet.querySelectorAll(".lr-file").forEach((x, k) => { x.classList.toggle("on", k === fileIdx); x.setAttribute("aria-selected", k === fileIdx); });
        showFile();
    });
    const all = sheet.querySelector(".lr-showall");
    if (all) all.onclick = () => { showAll = !showAll; render(); };
    sheet.querySelectorAll("[data-d]").forEach(b => b.onclick = () => decide(b.dataset.d));
    showFile();
    sheet.querySelector('[data-d="reject"]').focus(); // the safe choice is the default
}

async function select(it) {
    cur = await T.details(it.root, it.name);
    showAll = false;
    fileIdx = cur.device ? -1 : Math.max(0, cur.files.findIndex(f => fileTag(f)));
    render();
}

async function decide(decision) {
    const btns = sheet.querySelectorAll("[data-d]");
    btns.forEach(b => b.disabled = true);
    const reason = sheet.querySelector(".lr-reason")?.value.trim() || "";
    if (decision === "reject" && cur.framework && !cur.hasPrevious) decision = "later";
    try {
        await T.decide({ root: cur.root, name: cur.name, decision, reason });
        const verb = { approve: "approved", reject: cur.hasPrevious ? "rejected (restored the approved version)" : "rejected", later: "left unapproved for now" }[decision];
        bottomPanel.appendOutput(`Library ${label(cur.name)} ${verb}`, decision === "approve" ? "success" : "info");
        if (decision === "approve" && !cur.framework) sharePrompt(cur.name);
    } catch (e) {
        bottomPanel.appendOutput(`Library review: ${e.message}`, "error");
        btns.forEach(b => b.disabled = b.dataset.d === "approve" && !!cur.checks?.errors?.length);
        return;
    }
    if (focusReq && focusReq.root === cur.root && focusReq.name === cur.name) focusReq = null;
    items = items.filter(x => !(x.root === cur.root && x.name === cur.name));
    if (items.length) return select(items[0]);
    close();
}

// The sheet only closes through a decision.
function trapKeys(e) {
    if (!sheet || document.querySelector(".dialog-overlay")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); nudge(); }
    if (e.key === "Tab") {
        const f = [...sheet.querySelectorAll("button:not([disabled]), input")];
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
}

function nudge() {
    const d = sheet.querySelector(".lr-dialog");
    d.classList.remove("lr-nudge"); void d.offsetWidth; d.classList.add("lr-nudge");
}

function close() {
    disposeEditor();
    document.removeEventListener("keydown", trapKeys, true);
    sheet.remove();
    sheet = null; cur = null;
    T.setOpen(false);
}

export async function open(focus) {
    if (focus) focusReq = focus;
    const all = await T.pending();
    items = all.filter(x => !x.deferred || (focusReq && x.root === focusReq.root && x.name === focusReq.name));
    if (sheet && cur && !focus) {
        // Already open: refresh the list, keep the user's place (a library that
        // was fixed meanwhile simply drops out).
        if (!items.length) return close();
        if (!items.some(x => x.root === cur.root && x.name === cur.name)) return select(items[0]);
        const keep = fileIdx; render(); fileIdx = keep;
        return;
    }
    if (!items.length) return;
    const first = (focusReq && items.find(x => x.root === focusReq.root && x.name === focusReq.name)) || items[0];
    if (!sheet) {
        sheet = document.createElement("div");
        sheet.className = "lr-backdrop";
        sheet.innerHTML = `<div class="lr-dialog" role="alertdialog" aria-modal="true" aria-labelledby="lrTitle"></div>`;
        sheet.addEventListener("mousedown", (e) => { if (e.target === sheet) { e.preventDefault(); nudge(); } });
        document.body.appendChild(sheet);
        document.addEventListener("keydown", trapKeys, true);
        T.setOpen(true);
    }
    await select(first);
}

async function showTampered(detail) {
    if (sheet) return;
    sheet = document.createElement("div");
    sheet.className = "lr-backdrop";
    sheet.innerHTML = `<div class="lr-dialog lr-small" role="alertdialog" aria-modal="true" aria-labelledby="lrTitle">
      <header class="lr-head"><div><h2 id="lrTitle">Library approvals were tampered with</h2>
      <p class="lr-sub">Volt found that ${esc(detail)}. Something outside Volt IDE changed them, so they can't be trusted.</p></div></header>
      <div class="lr-pad"><p>Starting over makes a new approval key. Official libraries that match what Volt shipped are approved again; you review everything else.</p></div>
      <footer class="lr-foot"><span class="lr-spacer"></span>
        <button type="button" class="lr-btn" data-t="later">Decide later</button>
        <button type="button" class="lr-btn primary" data-t="reset">Start over</button></footer></div>`;
    document.body.appendChild(sheet);
    document.addEventListener("keydown", trapKeys, true);
    sheet.addEventListener("mousedown", (e) => { if (e.target === sheet) { e.preventDefault(); nudge(); } });
    sheet.querySelector('[data-t="later"]').onclick = () => { close(); bottomPanel.appendOutput("Library approvals are not trusted — builds of device libraries stay blocked.", "warn"); };
    sheet.querySelector('[data-t="reset"]').onclick = async () => {
        if (!await dialog.confirm("Start library approvals over?", { detail: "Makes a new approval key. Every library that doesn't match what Volt shipped must be reviewed again before it builds.", okLabel: "Start over", danger: true })) return;
        close();
        try { await T.reset(); bottomPanel.appendOutput("Library approvals started over.", "success"); }
        catch (e) { bottomPanel.appendOutput("Library approvals: " + e.message, "error"); }
    };
    sheet.querySelector('[data-t="later"]').focus();
}

export function init() {
    T.onEvent((msg) => {
        if (msg.kind === "review") open(msg.focus);
        else if (msg.kind === "tampered") showTampered(msg.detail);
        else if (msg.kind === "setup") bottomPanel.appendOutput(`Library approvals set up on this computer — ${msg.approved} built-in libraries approved as shipped.`, "info");
    });
}

// sharePrompt follows approving a library you made: offer to publish it.
async function sharePrompt(prefix) {
    const own = await window.volt.publish.list().catch(() => null);
    const it = own && own.libs.find(l => l.prefix === prefix);
    if (!it || it.published || (it.latest && it.latest.status === "pending")) return; // not yours, or already on its way
    document.querySelector(".pb-toast")?.remove();
    const t = document.createElement("div");
    t.className = "pb-toast";
    t.setAttribute("role", "status");
    t.innerHTML = `<span class="pb-toast-ic" aria-hidden="true">✓</span><div><b>${esc(it.name)} is ready to use.</b><br>Share it on the Grid so others can use it too?</div>
        <button type="button" class="lr-btn primary" data-pub>Publish…</button><button type="button" class="lr-btn" data-no>Not now</button>`;
    document.body.appendChild(t);
    const done = () => t.remove();
    t.querySelector("[data-no]").onclick = done;
    t.querySelector("[data-pub]").onclick = () => { done(); import("./publish-dialog.js").then(m => m.open(prefix)); };
    setTimeout(done, 15000);
}
