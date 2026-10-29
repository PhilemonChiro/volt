// Bottom panel — Output (with build progress), Serial Monitor (with ESP-IDF log parsing), Problems

import * as settings from "../services/settings.js";
import * as editor from "./editor.js";
import { attachPanZoom } from "./panzoom.js";

let activeTab = "output";
let showTimestamps = settings.get("serial.showTimestamps", true);
let autoScroll = settings.get("serial.autoScroll", true);
let monitorPaused = false;
let buildProgressEl = null;
let cEditor = null;   // lazily-created read-only Monaco editor for the Generated C view

// Keep our locals in sync when the user changes them in Settings.
settings.onChange((key, value) => {
    if (key === "*" || key === "serial.showTimestamps") {
        showTimestamps = settings.get("serial.showTimestamps", true);
        document.querySelectorAll(".serial-ts").forEach(el => {
            el.style.display = showTimestamps ? "" : "none";
        });
        const btn = document.getElementById("bpTimestamp");
        if (btn) btn.classList.toggle("active", showTimestamps);
    }
    if (key === "*" || key === "serial.autoScroll") {
        autoScroll = settings.get("serial.autoScroll", true);
    }
    if (key === "*" || key === "advanced.showGeneratedC") {
        applyGeneratedCVisibility();
    }
});

// Show/hide the Generated C tab per the Advanced setting. Falls back to Output
// if the tab is hidden while it's the active one.
function applyGeneratedCVisibility() {
    const show = settings.get("advanced.showGeneratedC", false);
    const tab = document.querySelector('.bp-tab[data-tab="generatedc"]');
    if (tab) tab.style.display = show ? "" : "none";
    if (!show && activeTab === "generatedc") {
        const container = document.getElementById("bottomPanel");
        if (container) switchTab(container, "output");
    }
}

let rootEl = null;   // the panel container, for switching tabs from outside

export function init(container) {
    rootEl = container;
    container.innerHTML = `
        <div class="bp-resize" id="bpResize" title="Drag to resize"></div>
        <div class="bp-header">
            <div class="bp-tabs">
                <button class="bp-tab active" data-tab="output">Output</button>
                <button class="bp-tab" data-tab="monitor">
                    <span class="bp-dot" id="monitorDot"></span>
                    Serial Monitor
                </button>
                <button class="bp-tab" data-tab="problems">
                    <span id="problemTabLabel">Problems</span>
                    <span class="bp-badge bp-badge-err"  id="problemBadgeErr"  style="display:none">0</span>
                    <span class="bp-badge bp-badge-warn" id="problemBadgeWarn" style="display:none">0</span>
                </button>
                <button class="bp-tab" data-tab="generatedc">Generated C</button>
            </div>
            <div class="bp-actions">
                <button class="bp-action" id="bpTimestamp" title="Toggle timestamps" data-for="monitor" style="display:none">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    <span class="bp-action-label">Timestamps</span>
                </button>
                <button class="bp-action" id="bpPause" title="Pause" data-for="monitor" style="display:none">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                    <span class="bp-action-label">Pause</span>
                </button>
                <button class="bp-action" id="bpCopy" title="Copy">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    <span class="bp-action-label">Copy</span>
                </button>
                <button class="bp-action" id="bpClear" title="Clear">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                    <span class="bp-action-label">Clear</span>
                </button>
            </div>
        </div>
        <!-- Build progress moved to footer status bar -->
        <div class="bp-content active" id="bpOutput"></div>
        <div class="bp-content" id="bpMonitor"></div>
        <div class="bp-content" id="bpProblems"></div>
        <div class="bp-content bp-content-c" id="bpGeneratedC"></div>
    `;

    // ---- Draggable top edge — resize the panel height up/down ----
    // Mirrors the side-panel resize. Height grows as the pointer moves up
    // (smaller clientY). maxH() reserves room for the toolbar/editor/status bar.
    const MIN_H = 100;
    // Cap at 2/3 of the window so the editor always keeps at least a third.
    const maxH = () => Math.max(MIN_H, Math.round(window.innerHeight * 2 / 3));

    // Restore the height the user last dragged to
    try {
        const saved = parseInt(localStorage.getItem("volt.bottomPanelHeight"), 10);
        if (saved) container.style.height = Math.min(saved, maxH()) + "px";
    } catch (_) {}

    const bpHandle = container.querySelector("#bpResize");
    if (bpHandle) {
        bpHandle.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            bpHandle.setPointerCapture(e.pointerId);
            container.classList.add("is-resizing");
            const startY = e.clientY;
            const startH = container.getBoundingClientRect().height;
            const onMove = (mv) => {
                const newH = Math.max(MIN_H, Math.min(maxH(), startH + (startY - mv.clientY)));
                container.style.height = newH + "px";
                // Reflow all Monaco editors (main editor + Generated C) as they resize
                if (typeof monaco !== "undefined") {
                    monaco.editor.getEditors().forEach(ed => ed.layout());
                }
            };
            const onUp = () => {
                container.classList.remove("is-resizing");
                try { bpHandle.releasePointerCapture(e.pointerId); } catch (_) {}
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
                window.removeEventListener("pointercancel", onUp);
                try { localStorage.setItem("volt.bottomPanelHeight", String(parseInt(container.style.height, 10))); } catch (_) {}
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
            window.addEventListener("pointercancel", onUp);
        });
    }

    // Tab switching
    container.querySelectorAll(".bp-tab").forEach(tab => {
        tab.onclick = () => switchTab(container, tab.dataset.tab);
    });

    // Copy — shows "Copied" feedback. The Generated C tab is a Monaco editor,
    // so read its model value rather than the rendered DOM text.
    container.querySelector("#bpCopy").onclick = () => {
        const text = (activeTab === "generatedc" && cEditor)
            ? cEditor.getValue()
            : (container.querySelector(".bp-content.active")?.innerText || "");
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            const btn = container.querySelector("#bpCopy");
            btn.style.color = "var(--ok)";
            setTimeout(() => btn.style.color = "", 1500);
        }).catch(() => {});
    };

    // Clear
    container.querySelector("#bpClear").onclick = () => {
        if (activeTab === "generatedc") return;   // read-only generated output
        const el = container.querySelector(".bp-content.active");
        if (el) el.innerHTML = "";
        if (activeTab === "output") clearProgress();
    };

    // Timestamp toggle (serial monitor) — persists via settings; the
    // onChange handler keeps the local + DOM in sync.
    container.querySelector("#bpTimestamp").onclick = function() {
        settings.set("serial.showTimestamps", !showTimestamps);
    };
    // Reflect persisted state on the button when the panel first appears
    const tsBtn = container.querySelector("#bpTimestamp");
    if (tsBtn) tsBtn.classList.toggle("active", showTimestamps);

    // Pause toggle (serial monitor)
    container.querySelector("#bpPause").onclick = function() {
        monitorPaused = !monitorPaused;
        this.classList.toggle("active", monitorPaused);
    };

    // Apply the "Show Generated C" advanced setting to the tab's visibility.
    applyGeneratedCVisibility();
}

function switchTab(container, tab) {
    activeTab = tab;
    container.querySelectorAll(".bp-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.tab === tab));
    container.querySelector("#bpOutput").classList.toggle("active", tab === "output");
    container.querySelector("#bpMonitor").classList.toggle("active", tab === "monitor");
    container.querySelector("#bpProblems").classList.toggle("active", tab === "problems");
    container.querySelector("#bpGeneratedC").classList.toggle("active", tab === "generatedc");

    // Show/hide monitor-specific buttons
    const tsBtn = container.querySelector("#bpTimestamp");
    const pauseBtn = container.querySelector("#bpPause");
    if (tsBtn) tsBtn.style.display = tab === "monitor" ? "" : "none";
    if (pauseBtn) pauseBtn.style.display = tab === "monitor" ? "" : "none";

    // Monaco can't measure while its tab is hidden — lay it out on reveal.
    if (tab === "generatedc" && cEditor) cEditor.layout();
}

// ============================================================
// Generated C view — read-only Monaco editor showing the transpiler output.
// Populated live from each successful compile (diagnostics.onResult).
// ============================================================

export function setGeneratedC(code) {
    if (!code) return;   // keep the last good C on compile errors
    const el = document.getElementById("bpGeneratedC");
    if (!el) return;

    // Monaco unavailable (shouldn't happen in the renderer) — plain-text fallback.
    if (typeof monaco === "undefined") {
        el.textContent = code;
        return;
    }

    if (!cEditor) {
        cEditor = monaco.editor.create(el, {
            value: code,
            language: "c",
            readOnly: true,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            lineNumbers: "on",
            renderLineHighlight: "none",
            folding: false,
            wordWrap: "off",
        });
    } else {
        const model = cEditor.getModel();
        if (model && model.getValue() !== code) {
            // Preserve scroll position across live updates while typing.
            const top = cEditor.getScrollTop();
            model.setValue(code);
            cEditor.setScrollTop(top);
        }
    }
}

// ============================================================
// Output panel — structured IDE messages + build progress bar
// ============================================================

// A run (Compile / Upload) groups its lines under one timestamped header; the
// lines inside it leave the time column blank so the header reads as a block.
let runOpen = false;

export function beginRun(title) {
    runOpen = false;
    appendOutput(title, "run");
    runOpen = true;
}

export function endRun() { runOpen = false; }

export function showProblems() {
    if (rootEl) switchTab(rootEl, "problems");
}

// opts.onClick makes the line a link (e.g. "5 warnings → Warnings").
export function appendOutput(text, level, opts = {}) {
    const output = document.getElementById("bpOutput");
    if (!output) return;

    const clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!clean) return;

    const entry = document.createElement("div");
    entry.className = "bp-line bp-" + (level || "info") + (runOpen ? " bp-in-run" : "");

    const now = new Date();
    const ts = runOpen ? "" : [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(n => String(n).padStart(2, "0")).join(":");

    entry.innerHTML =
        `<span class="bp-time">${ts}</span>` +
        `<span class="bp-out-dot bp-out-${level || "info"}"></span>` +
        `<span>${esc(clean)}</span>`;
    if (opts.onClick) {
        entry.classList.add("bp-link");
        entry.onclick = opts.onClick;
    }

    output.appendChild(entry);
    if (autoScroll) output.scrollTop = output.scrollHeight;
    while (output.children.length > 2000) output.removeChild(output.firstChild);
}

// Build progress bar
// ============================================================
// Fixed build progress bar (pinned above scrolling output)
// ============================================================

// ============================================================
// Footer progress bar — one bar, shows current task + %
// ============================================================

const STAGE_LABELS = { compile: "Compiling", build: "Building", flash: "Flashing", connect: "Connecting" };

export function showPipeline() {
    const el = document.getElementById("statusProgress");
    if (el) el.style.display = "flex";
    updatePipelineStage("compile", "Starting...", 0);
}

export function updatePipelineStage(stage, message, percent) {
    const el = document.getElementById("statusProgress");
    const label = document.getElementById("statusProgressLabel");
    const fill = document.getElementById("statusProgressFill");
    const pct = document.getElementById("statusProgressPct");
    if (!el) return;

    el.style.display = "flex";

    if (stage === "done") {
        if (label) label.textContent = "Done";
        if (fill) { fill.style.width = "100%"; fill.className = "status-progress-fill done"; }
        if (pct) pct.textContent = "✓";
        return;
    }
    if (stage === "error") {
        if (label) label.textContent = message.substring(0, 40);
        if (fill) { fill.className = "status-progress-fill error"; }
        if (pct) pct.textContent = "";
        return;
    }

    // percent is the GLOBAL build progress (0-100) — main.js already mapped
    // each sub-stage (compile 0-25, build 30-60, flash 65-95, connect 95-100).
    // Don't re-map; show it as the bar width directly.
    const p = Math.min(100, Math.max(0, Math.round(percent || 0)));
    const stageLabel = STAGE_LABELS[stage] || stage;
    const shortMsg = message.length > 30 ? stageLabel + "..." : message;
    if (label) label.textContent = shortMsg;
    if (fill) { fill.style.width = p + "%"; fill.className = "status-progress-fill"; }
    if (pct) pct.textContent = p > 0 ? p + "%" : "";
}

export function updateProgress(stage, message, percent) {
    updatePipelineStage(stage, message, percent);
}

export function clearProgress() {
    const el = document.getElementById("statusProgress");
    if (el) el.style.display = "none";
}

// ============================================================
// Serial Monitor — ESP-IDF log parsing, ANSI stripping, timestamps
// ============================================================

export function appendMonitor(text) {
    if (monitorPaused) return;
    const output = document.getElementById("bpMonitor");
    if (!output) return;

    // Strip ANSI escape codes
    const clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!clean) return;

    // Parse ESP-IDF log format: "00:10:41.050 [INFO ] tag: message"
    // or compact: "I (12345) tag: message"
    let msg = clean;
    let lvl = "";

    const espMatch = clean.match(/^[\d:.]+\s*\[(\w+)\s*\]\s*\w+:\s*(.+)$/);
    const idfMatch = clean.match(/^([IWEDV])\s*\(\d+\)\s*\w+:\s*(.+)$/);

    if (espMatch) {
        lvl = espMatch[1].toLowerCase();
        msg = espMatch[2];
    } else if (idfMatch) {
        const lvlMap = { I: "info", W: "warn", E: "error", D: "debug", V: "debug" };
        lvl = lvlMap[idfMatch[1]] || "info";
        msg = idfMatch[2];
    }

    const line = document.createElement("div");
    line.className = "serial-line" + (lvl ? " serial-" + lvl : "");

    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(n => String(n).padStart(2, "0")).join(":")
        + "." + String(now.getMilliseconds()).padStart(3, "0");

    line.innerHTML =
        `<span class="serial-ts" style="${showTimestamps ? "" : "display:none"}">${ts} </span>` +
        esc(msg);

    output.appendChild(line);
    if (autoScroll) output.scrollTop = output.scrollHeight;
    // Cap at 5000 lines
    while (output.children.length > 5000) output.removeChild(output.firstChild);
}

export function setMonitorConnected(connected) {
    const dot = document.getElementById("monitorDot");
    if (dot) dot.classList.toggle("connected", connected);
}

// ============================================================
// Problems panel — clickable errors with hints
// ============================================================

export function setProblems(diags) {
    const el        = document.getElementById("bpProblems");
    const labelEl   = document.getElementById("problemTabLabel");
    const errBadge  = document.getElementById("problemBadgeErr");
    const warnBadge = document.getElementById("problemBadgeWarn");
    if (!el) return;

    // Split by severity so the tab can show separate error / warning counts
    // and the label reflects what's actually in the file:
    //   - errors present (with or without warnings) → "Problems"
    //   - warnings only                              → "Warnings"
    //   - nothing                                    → "Problems" (no badges)
    const nErr  = diags.filter(d => d.severity === "error").length;
    const nWarn = diags.filter(d => d.severity === "warning" || d.severity === "warn").length;

    if (labelEl) {
        labelEl.textContent = (nErr === 0 && nWarn > 0) ? "Warnings" : "Problems";
    }
    if (errBadge) {
        errBadge.textContent = nErr;
        errBadge.style.display = nErr > 0 ? "" : "none";
    }
    if (warnBadge) {
        warnBadge.textContent = nWarn;
        warnBadge.style.display = nWarn > 0 ? "" : "none";
    }

    if (diags.length === 0) {
        el.innerHTML = `<div class="bp-empty">
            <svg class="empty-illustration" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--ok);opacity:0.7"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            <div class="empty-title">All clear</div>
            <div class="empty-hint">No problems detected in this file.</div>
        </div>`;
        return;
    }

    el.innerHTML = diags.map(d => {
        const icon = d.severity === "error" ? "E" : "W";
        const cls = d.severity === "error" ? "bp-err" : "bp-warn";
        const hint = d.hint
            ? `<div class="bp-problem-hint">Hint: ${esc(d.hint)}</div>`
            : "";
        return `
            <div class="bp-problem" data-line="${d.line || 1}">
                <span class="bp-problem-icon ${cls}">${icon}</span>
                <div class="bp-problem-body">
                    <span class="bp-problem-msg">${esc(d.message)}</span>
                    ${hint}
                </div>
                <span class="bp-problem-loc">Ln ${d.line || 1}</span>
            </div>
        `;
    }).join("");

    // Click → jump to line
    el.querySelectorAll(".bp-problem").forEach(item => {
        item.onclick = () => {
            const ln = parseInt(item.dataset.line);
            const editors = monaco.editor.getEditors();
            if (editors.length > 0 && ln > 0) {
                editors[0].revealLineInCenter(ln);
                editors[0].setPosition({ lineNumber: ln, column: 1 });
                editors[0].focus();
            }
        };
    });
}

// ============================================================
// Diagram view — renders each Volt state machine as a Mermaid
// stateDiagram-v2, laid out and themed to the Volt palette. The 3.4MB
// Mermaid lib is loaded lazily the first time the tab is opened.
// ============================================================

let mermaidReady = null;   // Promise<mermaid>, created on first use
let diagramSeq = 0;        // guards against out-of-order state-diagram renders
let lastDiagramKey = null; // last-rendered state-diagram source (skip no-op re-renders → preserve pan/zoom)
function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

function diagramTheme() {
    // Map Volt's design tokens onto Mermaid's theme variables so the graph
    // matches the IDE's dark palette rather than Mermaid's default look.
    return {
        primaryColor: cssVar("--bg-3", "#2a2d33"),
        primaryTextColor: cssVar("--t1", "#e8e8e8"),
        primaryBorderColor: cssVar("--volt", "#2B7CB3"),
        lineColor: cssVar("--t3", "#8a8f98"),
        fontSize: "13px",
    };
}

function ensureMermaid() {
    if (mermaidReady) return mermaidReady;
    mermaidReady = new Promise((resolve, reject) => {
        if (window.mermaid) return resolve(window.mermaid);
        const s = document.createElement("script");
        s.src = "lib/mermaid/mermaid.min.js";
        s.onload = async () => {
            try {
                window.mermaid.initialize({
                    startOnLoad: false,
                    // Defaults (50k chars / 500 edges) are too small for a
                    // big project — it showed "Maximum text size in diagram
                    // exceeded" instead of the diagram.
                    maxTextSize: 2000000,
                    maxEdges: 5000,
                    securityLevel: "strict",
                    theme: "base",
                    themeVariables: diagramTheme(),
                    fontFamily: cssVar("--sans", "system-ui, -apple-system, sans-serif"),
                    // curve:"linear" (not basis) — basis B-splines bow away from
                    // their endpoints, so the arrowhead marker (placed at the path's
                    // true end, the node border) visually detaches from the line.
                    // Linear honors ELK's orthogonal bend-points and terminates flush
                    // at the node, keeping every arrowhead on the end of its arrow.
                    flowchart: { curve: "linear", nodeSpacing: 40, rankSpacing: 64, padding: 12, useMaxWidth: false },
                    state: { useMaxWidth: false },
                    // Natural size (not stretched to the panel), participants
                    // drawn once at the top — no mirrored row at the bottom.
                    sequence: { useMaxWidth: false, mirrorActors: false, actorMargin: 48, messageMargin: 32 },
                });
                resolve(window.mermaid);
            } catch (e) { reject(e); }
        };
        s.onerror = () => reject(new Error("failed to load mermaid"));
        document.head.appendChild(s);
    });
    return mermaidReady;
}

export async function renderDiagram(force = false) {
    const el = document.getElementById("dgStateMachine");
    if (!el || tooBig(el)) return;
    const seq = ++diagramSeq;

    let data;
    try {
        data = await window.volt.stateDiagram(editor.getValue());
    } catch (_) {
        data = { machines: [] };
    }
    if (seq !== diagramSeq) return;   // superseded by a newer render

    const machines = (data && data.machines) || [];
    // Skip a no-op re-render so periodic auto-refresh doesn't reset the user's
    // pan/zoom when nothing changed.
    const key = machines.map(m => m.mermaid).join(" ");
    if (!force && key === lastDiagramKey && el.querySelector("svg")) return;
    lastDiagramKey = key;

    if (!machines.length) {
        el.innerHTML = `<div class="bp-empty">No state machines in this file.<br>
            Define a <code>machine … { state … }</code> to see its diagram.</div>`;
        return;
    }

    let mermaid;
    try {
        mermaid = await ensureMermaid();
    } catch (_) {
        el.innerHTML = `<div class="bp-empty">Couldn't load the diagram renderer.</div>`;
        return;
    }
    if (seq !== diagramSeq) return;

    el.innerHTML = "";
    for (let i = 0; i < machines.length; i++) {
        const m = machines[i];
        const wrap = document.createElement("div");
        wrap.className = "bp-diagram-machine";
        const title = document.createElement("div");
        title.className = "bp-diagram-title";
        title.textContent = m.name;
        const graph = document.createElement("div");
        graph.className = "bp-diagram-graph";
        try {
            const { svg } = await mermaid.render(`voltdiag-${seq}-${i}`, m.mermaid);
            if (seq !== diagramSeq) return;
            graph.innerHTML = svg;
        } catch (e) {
            graph.innerHTML = `<div class="bp-empty">Diagram error: ${esc(String((e && e.message) || e))}</div>`;
        }
        wrap.appendChild(title);
        wrap.appendChild(graph);
        el.appendChild(wrap);
        attachPanZoom(graph);
    }
}

// Past this many source lines no diagram is drawn: the result is too dense
// to read and slow to lay out.
const DIAGRAM_MAX_LINES = 1000;

// True (and the panel says why) when the program is too big to draw.
function tooBig(el) {
    const n = editor.getValue().split("\n").length;
    if (n <= DIAGRAM_MAX_LINES) return false;
    if (!el.querySelector(".bp-toobig")) {
        el.innerHTML = `<div class="bp-empty bp-toobig">This program is too big to draw (${n.toLocaleString()} lines).<br>
            Diagrams work best under ${DIAGRAM_MAX_LINES.toLocaleString()} lines.</div>`;
    }
    return true;
}

// Sequence diagram — the whole program in order (ide.SequenceDiagram).
let seqSeq = 0, lastSeqKey = null;

export async function renderSequence(force = false) {
    const el = document.getElementById("dgSequence");
    if (!el || tooBig(el)) return;
    const seq = ++seqSeq;
    let data;
    try {
        data = await window.volt.sequenceDiagram(editor.getValue());
    } catch (_) {
        data = { mermaid: "" };
    }
    if (seq !== seqSeq) return;
    const key = (data && data.mermaid) || "";
    if (!force && key === lastSeqKey && el.querySelector("svg")) return;
    lastSeqKey = key;
    if (!key) {
        el.innerHTML = `<div class="bp-empty">Nothing to show — add <code>setup</code>, a <code>task</code> or a <code>machine</code>.</div>`;
        return;
    }
    let mermaid;
    try {
        mermaid = await ensureMermaid();
    } catch (_) {
        el.innerHTML = `<div class="bp-empty">Couldn't load the diagram renderer.</div>`;
        return;
    }
    if (seq !== seqSeq) return;
    try {
        const { svg } = await mermaid.render(`voltseq-${seq}`, key);
        if (seq !== seqSeq) return;
        // Pan / zoom on the full-size panel (a wrapper sized to the diagram
        // would clip it as soon as it is dragged or zoomed).
        el.classList.add("bp-seq-graph");
        el.innerHTML = svg;
        attachPanZoom(el);
    } catch (e) {
        el.innerHTML = `<div class="bp-empty">Diagram error: ${esc(String((e && e.message) || e))}</div>`;
    } finally {
        document.getElementById(`dvoltseq-${seq}`)?.remove();
    }
}

// Clear both diagram surfaces and their caches — called on project switch so the
// previous project's diagram never lingers.
export function resetDiagrams() {
    lastDiagramKey = null;
    lastSeqKey = null;
    for (const id of ["dgStateMachine", "dgSequence"]) {
        const el = document.getElementById(id);
        if (el) {
            if (el._panzoom) el._panzoom.destroy();
            el.innerHTML = "";
        }
    }
}

function esc(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
