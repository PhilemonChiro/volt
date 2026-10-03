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
let elkRegistered = false;  // whether the ELK layout engine loaded (else dagre)
let diagramSeq = 0;        // guards against out-of-order state-diagram renders
let systemSeq = 0;         // ditto for the system map
let lastDiagramKey = null; // last-rendered state-diagram source (skip no-op re-renders → preserve pan/zoom)
let lastSystemKey = null;  // last-rendered system-map source
let expandedLoops = new Set();   // System-Map loop ids currently expanded
let allLoops = [];               // loop ids in the current map
let expandInited = false;        // has the default expand/collapse been applied for this program?
let systemNodes = {};            // node id -> {kind,label,line,detail} (for the click menu)
let systemEdges = [];            // [{src,dst,drive,…}] aligned with rendered edge paths
let hlNode = null;               // node id whose connections are highlighted (null = none)
let activeMenu = null;           // open context-menu element, if any
let edgeAnimations = [];         // live WAAPI edge-pulse animations (for freeze/resume)
let animFrozen = false;          // is the diagram animation currently frozen?

// Freeze / resume the System-Map edge animations (bound to the toolbar button).
export function setAnimationsFrozen(frozen) {
    animFrozen = !!frozen;
    edgeAnimations.forEach(a => { try { animFrozen ? a.pause() : a.play(); } catch (_) {} });
}
export function areAnimationsFrozen() {
    return animFrozen;
}

// Toggle a single loop's expanded state (bound to Mermaid node clicks).
window.__voltToggleLoop = (id) => {
    if (expandedLoops.has(id)) expandedLoops.delete(id);
    else expandedLoops.add(id);
    renderSystemMap(true);
};

// Expand or collapse every loop at once (the toolbar button).
export function setLoopsExpanded(expand) {
    expandedLoops = expand ? new Set(allLoops) : new Set();
    expandInited = true;
    renderSystemMap(true);
}
export function loopsAllExpanded() {
    return allLoops.length > 0 && expandedLoops.size >= allLoops.length;
}

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
                // Register the ELK layout engine (orthogonal, port-based routing —
                // far cleaner than the default dagre for dataflow graphs). Applied
                // per-diagram to the flowchart (see renderSystemMap); state diagrams
                // keep their own layout. Fails soft to dagre if the module is absent.
                try {
                    const elk = await import("../../lib/mermaid/layout-elk/mermaid-layout-elk.esm.min.mjs");
                    window.mermaid.registerLayoutLoaders(elk.default);
                    elkRegistered = true;
                } catch (_) {
                    elkRegistered = false;
                }
                window.mermaid.initialize({
                    startOnLoad: false,
                    securityLevel: "loose",   // needed for click bindings (Phase 2)
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
    if (!el) return;
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

// System / causal map — a single Mermaid flowchart of the whole program:
// concurrent units (tasks, machines, setup, functions) and the resources they
// touch (channels, shared vars, pins, services).
export async function renderSystemMap(force = false) {
    const el = document.getElementById("dgSystemMap");
    if (!el) return;
    const seq = ++systemSeq;

    let data;
    try {
        data = await window.volt.systemGraph(editor.getValue(), Array.from(expandedLoops));
    } catch (_) {
        data = { mermaid: "", units: [], loops: [] };
    }
    if (seq !== systemSeq) return;

    // Track the loop set; default small programs to fully-expanded (detail),
    // larger ones to collapsed (scannable overview). Applied once per program.
    allLoops = (data && data.loops) || [];
    if (!expandInited && allLoops.length) {
        expandedLoops = allLoops.length <= 3 ? new Set(allLoops) : new Set();
        expandInited = true;
        // Re-fetch with the chosen default so the first paint matches.
        try {
            data = await window.volt.systemGraph(editor.getValue(), Array.from(expandedLoops));
        } catch (_) { /* keep the collapsed data we already have */ }
        if (seq !== systemSeq) return;
    }

    const key = (data && data.mermaid) || "";
    // Skip a no-op re-render so periodic auto-refresh preserves pan/zoom.
    if (!force && key === lastSystemKey && el.querySelector("svg")) return;
    lastSystemKey = key;

    if (!key) {
        el.innerHTML = `<div class="bp-empty">Nothing to map — this file has no tasks, machines, or setup yet.</div>`;
        return;
    }

    let mermaid;
    try {
        mermaid = await ensureMermaid();
    } catch (_) {
        el.innerHTML = `<div class="bp-empty">Couldn't load the diagram renderer.</div>`;
        return;
    }
    if (seq !== systemSeq) return;

    try {
        // Lay the dataflow graph out with ELK (orthogonal routing, no
        // edge-to-cluster ambiguity) when available; dagre otherwise.
        const src = elkRegistered
            ? '%%{init: {"layout": "elk"}}%%\n' + data.mermaid
            : data.mermaid;
        const { svg, bindFunctions } = await mermaid.render(`voltsys-${seq}`, src);
        if (seq !== systemSeq) return;
        el.innerHTML = svg;
        // Activate Mermaid click bindings (loop expand/collapse), then pan/zoom.
        if (bindFunctions) { try { bindFunctions(el); } catch (_) {} }
        systemNodes = data.nodes || {};
        systemEdges = data.edges || [];
        hlNode = null;
        el.querySelectorAll(".node").forEach(n => { n.style.cursor = "pointer"; });
        animateEdges(el, data.edges);
        wireNodeMenu(el);
        attachPanZoom(el);
    } catch (e) {
        el.innerHTML = `<div class="bp-empty">Diagram error: ${esc(String((e && e.message) || e))}</div>`;
    }
}

// Animate each edge's shaft to match the NATURE of the interaction. We never
// touch Mermaid's own edge path (it keeps its solid stroke + arrowhead, flush at
// the node); instead we overlay a marker-less clone that carries the motion. So
// arrowheads always stay put on the ends of their arrows.
//
//   timer   → PERIODIC: one pulse fires along the wire, timed to the actual
//             `every Nms` interval (a 100ms timer pulses faster than a 400ms one)
//   task    → continuous  ┐
//   machine → event-driven ├→ the generic flowing marching-dash animation
//   func    → called       ┘
//   setup   → runs once at boot → NOT animated (stays a solid static arrow)
//
// Flow travels src→dst, i.e. toward the arrowhead, so it always respects the
// real data-flow direction (a read flows resource→unit, a write unit→resource).
// `bidi` (only a shared var / pin the same unit both writes AND reads) plays the
// motion back-and-forth; one-way comms (channels, calls) never reverse.
const EDGE_DRIVE = {
    timer:   { color: "#e0b84e", march: false, width: 3 },     // periodic — rate-timed pulse
    task:    { color: "#3fa2e3", march: true,  width: 2.5 },   // continuous — generic flow
    machine: { color: "#a05fd6", march: true,  width: 2.5 },   // event-driven — generic flow
    func:    { color: "#6fb0c4", march: true,  width: 2.5 },   // called — generic flow
    // setup: intentionally absent — one-shot at boot, so its arrow isn't animated.
};

// Clamp a raw interval (ms) into a watchable pulse period while preserving the
// relative ordering of timer rates.
function pulsePeriod(rateMs) {
    const r = (typeof rateMs === "number" && rateMs > 0) ? rateMs : 900;
    return Math.max(300, Math.min(2500, r));
}

function animateEdges(host, edgeMeta) {
    edgeAnimations = [];   // previous run's animations die with the replaced SVG
    if (!Array.isArray(edgeMeta) || !edgeMeta.length) return;
    // Respect the user's reduced-motion preference — leave arrows solid & static.
    try {
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    } catch (_) {}

    // One <path> per edge, in source order === the order worker.py emitted edges.
    const paths = host.querySelectorAll(".edgePaths path.flowchart-link, .edgePaths > path");
    paths.forEach((p, i) => {
        const meta = edgeMeta[i];
        if (!meta) return;
        const cfg = EDGE_DRIVE[meta.drive];
        if (!cfg) return;                        // setup / unknown → no animation
        let len = 0;
        try { len = p.getTotalLength(); } catch (_) {}
        if (!len) return;

        const o = p.cloneNode(false);            // marker-less overlay — base path keeps the arrowhead
        o.removeAttribute("marker-end");
        o.removeAttribute("marker-start");
        o.removeAttribute("id");
        o.setAttribute("class", "volt-edge-flow");
        o.style.fill = "none";
        o.style.stroke = cfg.color;
        o.style.strokeWidth = cfg.width + "px";
        o.style.strokeLinecap = "round";
        o.style.pointerEvents = "none";
        o.style.opacity = "0.9";

        let frames, dur, ease;
        if (cfg.march) {
            // continuous / event-driven: short repeating dashes flowing toward the end
            o.style.strokeDasharray = "7 9";
            frames = [{ strokeDashoffset: 0 }, { strokeDashoffset: -16 }];
            dur = 820; ease = "linear";
        } else {
            // periodic: one comet (tiny dash, path-long gap) sweeps end-to-end, and
            // re-launches every interval — so the pulse cadence IS the timer rate.
            const gap = 7;
            o.style.strokeDasharray = `${gap} ${len}`;
            frames = [{ strokeDashoffset: 0 }, { strokeDashoffset: -(len + gap) }];
            dur = pulsePeriod(meta.rate_ms); ease = "cubic-bezier(.4,0,.2,1)";
        }
        try {
            // Always one-directional — flow toward the arrowhead. read and write
            // are separate one-way edges, so neither should oscillate.
            const anim = o.animate(frames, {
                duration: dur,
                iterations: Infinity,
                easing: ease,
            });
            if (animFrozen) anim.pause();   // stay frozen across re-renders
            edgeAnimations.push(anim);
        } catch (_) {}
        p.parentNode.insertBefore(o, p.nextSibling);
    });
}

// ---- Node click-menu: Go to source / Highlight connections / loop toggle ----
const KIND_COLOR = {
    task: "#2B7CB3", setup: "#2B7CB3", timer: "#d0a83a", machine: "#7a3ac0",
    func: "#5a8fa0", channel: "#c08a3a", var: "#8a8f98", pin: "#3aa06a", service: "#a03a6a",
};
const MENU_ICON = {
    goto: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>',
    hl:   '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/></svg>',
    loop: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
};

// Mermaid node element id → our node id, e.g. "voltsys-3-flowchart-u__rule2-5" → "u__rule2".
function nodeIdFromEl(el) {
    const m = ((el && el.id) || "").match(/flowchart-(.+)-\d+$/);
    return m ? m[1] : null;
}

function wireNodeMenu(host) {
    host.querySelectorAll(".node").forEach(nodeEl => {
        const id = nodeIdFromEl(nodeEl);
        if (!id || !systemNodes[id]) return;
        nodeEl.addEventListener("pointerdown", (e) => e.stopPropagation()); // don't start a pan
        nodeEl.addEventListener("click", (e) => {
            e.stopPropagation();
            openNodeMenu(host, id, e.clientX, e.clientY);
        });
    });
    // Click on empty canvas clears any active highlight (wire once — host persists).
    if (!host._voltBgWired) {
        host._voltBgWired = true;
        host.addEventListener("click", (e) => { if (!e.target.closest(".node")) clearHighlight(host); });
    }
}

function closeMenu() {
    if (activeMenu) { activeMenu.remove(); activeMenu = null; }
    document.removeEventListener("pointerdown", onMenuDismiss, true);
    document.removeEventListener("keydown", onMenuKey, true);
}
function onMenuDismiss(e) { if (activeMenu && !activeMenu.contains(e.target)) closeMenu(); }
function onMenuKey(e) { if (e.key === "Escape") closeMenu(); }

function openNodeMenu(host, id, x, y) {
    closeMenu();
    const info = systemNodes[id];
    if (!info) return;
    const color = KIND_COLOR[info.kind] || "#8a8f98";
    const label = String(info.label || id).replace(/<br\s*\/?>/gi, " ").replace(/↻\s*/g, "").trim();
    const isLoop = allLoops.includes(id);
    const expanded = expandedLoops.has(id);
    const menu = document.createElement("div");
    menu.className = "volt-node-menu";
    menu.innerHTML = `
        <div class="vnm-head">
            <span class="vnm-dot" style="background:${color}"></span>
            <div class="vnm-headtext">
                <div class="vnm-title">${esc(label)}</div>
                <div class="vnm-sub">${esc(info.detail || info.kind)}</div>
            </div>
        </div>
        <div class="vnm-items">
            ${info.line ? `<button class="vnm-item" data-act="goto">${MENU_ICON.goto}<span>Go to source</span></button>` : ""}
            <button class="vnm-item" data-act="hl">${MENU_ICON.hl}<span>${hlNode === id ? "Clear highlight" : "Highlight connections"}</span></button>
            ${isLoop ? `<button class="vnm-item" data-act="loop">${MENU_ICON.loop}<span>${expanded ? "Collapse body" : "Expand body"}</span></button>` : ""}
        </div>`;
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
    menu.addEventListener("click", (e) => {
        const btn = e.target.closest(".vnm-item");
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === "goto") document.dispatchEvent(new CustomEvent("volt:goto-source", { detail: { line: info.line } }));
        else if (act === "hl") { if (hlNode === id) clearHighlight(host); else applyHighlight(host, id); }
        else if (act === "loop") window.__voltToggleLoop(id);
        closeMenu();
    });
    activeMenu = menu;
    setTimeout(() => {
        document.addEventListener("pointerdown", onMenuDismiss, true);
        document.addEventListener("keydown", onMenuKey, true);
    }, 0);
}

// Spotlight a node and everything it touches; dim the rest.
function applyHighlight(host, id) {
    clearHighlight(host);
    hlNode = id;
    const keepNodes = new Set([id]);
    const keepEdge = new Set();
    systemEdges.forEach((e, i) => {
        if (e.src === id || e.dst === id) {
            keepEdge.add(i);
            keepNodes.add(e.src === id ? e.dst : e.src);
        }
    });
    host.querySelectorAll(".node").forEach(n => {
        if (!keepNodes.has(nodeIdFromEl(n))) n.classList.add("volt-dim");
    });
    // originals align 1:1 with systemEdges; their animation clones ride alongside
    host.querySelectorAll(".edgePaths path:not(.volt-edge-flow)").forEach((p, i) => {
        if (!keepEdge.has(i)) {
            p.classList.add("volt-dim");
            const clone = p.nextElementSibling;
            if (clone && clone.classList.contains("volt-edge-flow")) clone.classList.add("volt-dim");
        }
    });
    host.querySelectorAll(".edgeLabels > g").forEach((l, i) => {
        if (!keepEdge.has(i)) l.classList.add("volt-dim");
    });
    host.classList.add("volt-has-hl");
}

function clearHighlight(host) {
    hlNode = null;
    host.querySelectorAll(".volt-dim").forEach(n => n.classList.remove("volt-dim"));
    host.classList.remove("volt-has-hl");
}

// Clear both diagram surfaces and their caches — called on project switch so the
// previous project's diagram never lingers.
export function resetDiagrams() {
    closeMenu();
    lastDiagramKey = null;
    lastSystemKey = null;
    expandedLoops = new Set();
    allLoops = [];
    expandInited = false;
    for (const id of ["dgSystemMap", "dgStateMachine"]) {
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
