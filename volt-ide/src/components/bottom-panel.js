// Bottom panel — Output (with build progress), Serial Monitor (with ESP-IDF log parsing), Problems

import * as settings from "../services/settings.js";

let activeTab = "output";
let showTimestamps = settings.get("serial.showTimestamps", true);
let autoScroll = settings.get("serial.autoScroll", true);
let monitorPaused = false;
let buildProgressEl = null;

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
});

export function init(container) {
    container.innerHTML = `
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
            </div>
            <div class="bp-actions">
                <button class="bp-action" id="bpTimestamp" title="Toggle timestamps" data-for="monitor" style="display:none">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </button>
                <button class="bp-action" id="bpPause" title="Pause" data-for="monitor" style="display:none">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                </button>
                <button class="bp-action" id="bpCopy" title="Copy">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button class="bp-action" id="bpClear" title="Clear">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                </button>
            </div>
        </div>
        <!-- Build progress moved to footer status bar -->
        <div class="bp-content active" id="bpOutput"></div>
        <div class="bp-content" id="bpMonitor"></div>
        <div class="bp-content" id="bpProblems"></div>
    `;

    // Tab switching
    container.querySelectorAll(".bp-tab").forEach(tab => {
        tab.onclick = () => switchTab(container, tab.dataset.tab);
    });

    // Copy — shows "Copied" feedback
    container.querySelector("#bpCopy").onclick = () => {
        const el = container.querySelector(".bp-content.active");
        if (el) {
            navigator.clipboard.writeText(el.innerText).then(() => {
                const btn = container.querySelector("#bpCopy");
                btn.style.color = "var(--ok)";
                setTimeout(() => btn.style.color = "", 1500);
            }).catch(() => {});
        }
    };

    // Clear
    container.querySelector("#bpClear").onclick = () => {
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
}

function switchTab(container, tab) {
    activeTab = tab;
    container.querySelectorAll(".bp-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.tab === tab));
    container.querySelector("#bpOutput").classList.toggle("active", tab === "output");
    container.querySelector("#bpMonitor").classList.toggle("active", tab === "monitor");
    container.querySelector("#bpProblems").classList.toggle("active", tab === "problems");

    // Show/hide monitor-specific buttons
    const tsBtn = container.querySelector("#bpTimestamp");
    const pauseBtn = container.querySelector("#bpPause");
    if (tsBtn) tsBtn.style.display = tab === "monitor" ? "" : "none";
    if (pauseBtn) pauseBtn.style.display = tab === "monitor" ? "" : "none";
}

// ============================================================
// Output panel — structured IDE messages + build progress bar
// ============================================================

export function appendOutput(text, level) {
    const output = document.getElementById("bpOutput");
    if (!output) return;

    const clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!clean) return;

    const entry = document.createElement("div");
    entry.className = "bp-line bp-" + (level || "info");

    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(n => String(n).padStart(2, "0")).join(":");

    entry.innerHTML =
        `<span class="bp-time">${ts}</span>` +
        `<span class="bp-out-dot bp-out-${level || "info"}"></span>` +
        `<span>${esc(clean)}</span>`;

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

function esc(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
