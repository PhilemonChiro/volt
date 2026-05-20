// Toolchain setup dialog — modal with stage list, progress, log drawer,
// background mode, and soft-cancel.
//
// API:
//   show({ chip, onComplete, onCancel })
//     → renders modal, calls setupToolchain, updates UI from toolchain:event
//        events emitted by main.js. Resolves onComplete on success.

const api = window.volt;

// Per-chip stage definitions. Each stage has a stable id (used by toolchain.js
// to mark transitions), a human label, and an expected weight for the overall
// progress calculation (sum of all weights = 100%).
const STAGES = {
    esp32: [
        { id: "check",       label: "Check system requirements",         weight: 2  },
        { id: "deps",        label: "Install system dependencies",        weight: 8  },
        { id: "clone-idf",   label: "Clone ESP-IDF from GitHub",          weight: 35 },
        { id: "install-idf", label: "Install ESP-IDF toolchain",          weight: 50 },
        { id: "env",         label: "Configure environment",              weight: 5  },
    ],
    esp8266: [
        { id: "check",       label: "Check system requirements",         weight: 2  },
        { id: "deps",        label: "Install system dependencies",        weight: 8  },
        { id: "clone-idf",   label: "Clone ESP8266 RTOS SDK",             weight: 40 },
        { id: "install-idf", label: "Install toolchain",                  weight: 45 },
        { id: "env",         label: "Configure environment",              weight: 5  },
    ],
    rp2040: [
        { id: "check",       label: "Check system requirements",         weight: 2  },
        { id: "arm-gcc",     label: "Install ARM GCC compiler",           weight: 30 },
        { id: "cmake",       label: "Install CMake",                      weight: 5  },
        { id: "clone-sdk",   label: "Clone Pico SDK",                     weight: 25 },
        { id: "picotool",    label: "Install picotool",                   weight: 30 },
        { id: "udev",        label: "Configure USB permissions",          weight: 8  },
    ],
    stm32f103: [
        { id: "check",       label: "Check system requirements",         weight: 2  },
        { id: "arm-gcc",     label: "Install ARM GCC compiler",           weight: 50 },
        { id: "openocd",     label: "Install OpenOCD",                    weight: 30 },
        { id: "env",         label: "Configure environment",              weight: 18 },
    ],
};

// Friendly chip names for the title
const CHIP_LABELS = {
    esp32:     "ESP32",
    esp8266:   "ESP8266",
    rp2040:    "RP2040 / Pico",
    stm32f103: "STM32 Blue Pill",
};

let activeDialog = null;

export function show({ chip, onComplete, onCancel }) {
    if (activeDialog) {
        // Already running — bring it back from background or just no-op
        if (activeDialog.minimized) toggleMinimize();
        return;
    }

    const stages = STAGES[chip] || STAGES.esp32;
    const state = {
        chip,
        stages: stages.map(s => ({ ...s, status: "pending", detail: "", subPct: 0, durationMs: 0 })),
        currentId: null,
        startedAt: Date.now(),
        log: [],
        showLog: false,
        cancelling: false,
        finished: false,
        success: false,
    };

    const overlay = document.createElement("div");
    overlay.id = "setupOverlay";
    overlay.className = "overlay";
    document.body.appendChild(overlay);

    const cleanup = api.onToolchainEvent?.((event) => handleEvent(state, event, overlay));

    activeDialog = {
        overlay, state, cleanup,
        onComplete, onCancel,
        minimized: false,
        finished: false,
    };

    render(overlay, state);
    startInstall(state);
}

function startInstall(state) {
    api.setupToolchain(state.chip).then((result) => {
        // setupToolchain returns { ok, logs } when done. Use ok as a fallback
        // signal in case stage events were lost.
        if (!state.finished) {
            if (result && result.ok) {
                completeInstall(state, true);
            } else {
                completeInstall(state, false, "Setup script returned non-OK status.");
            }
        }
    }).catch((e) => {
        if (!state.finished) {
            completeInstall(state, false, e.message || "Setup failed");
        }
    });
}

function handleEvent(state, event, overlay) {
    if (!event) return;
    switch (event.type) {
        case "stage_start": {
            const s = state.stages.find(x => x.id === event.id);
            if (s) { s.status = "running"; s.detail = ""; s.subPct = 0; s.startedAt = Date.now(); }
            state.currentId = event.id;
            break;
        }
        case "stage_progress": {
            const s = state.stages.find(x => x.id === event.id);
            if (s) { s.subPct = Math.max(0, Math.min(100, Number(event.percent) || 0)); s.detail = event.detail || s.detail; }
            break;
        }
        case "stage_done": {
            const s = state.stages.find(x => x.id === event.id);
            if (s) { s.status = "done"; s.subPct = 100; s.durationMs = Date.now() - (s.startedAt || Date.now()); }
            if (state.currentId === event.id) state.currentId = null;
            break;
        }
        case "stage_error": {
            const s = state.stages.find(x => x.id === event.id);
            if (s) { s.status = "failed"; s.detail = event.message || "failed"; }
            break;
        }
        case "log": {
            state.log.push(event.message || "");
            if (state.log.length > 1000) state.log.splice(0, state.log.length - 1000);
            break;
        }
        case "complete": {
            completeInstall(state, event.success !== false);
            break;
        }
    }
    if (!state.finished) scheduleRender(state, overlay);
}

// Coalesce DOM updates to once per animation frame. install.sh can emit
// hundreds of log lines per second; rebuilding the stage list innerHTML on
// every one of them locks up the renderer. Batch into rAF so we paint
// at most 60 fps regardless of event volume.
let _rafQueued = false;
function scheduleRender(state, overlay) {
    if (_rafQueued) return;
    _rafQueued = true;
    requestAnimationFrame(() => {
        _rafQueued = false;
        if (state && overlay) renderUpdate(overlay, state);
    });
}

function completeInstall(state, success, errorMessage) {
    state.finished = true;
    state.success = success;
    if (!success && errorMessage) state.errorMessage = errorMessage;

    // Mark any remaining stages — running ones become failed, pending ones stay
    for (const s of state.stages) {
        if (success) {
            if (s.status === "pending") s.status = "done";
            if (s.status === "running") { s.status = "done"; s.subPct = 100; }
        } else {
            if (s.status === "running") s.status = "failed";
        }
    }

    if (activeDialog) renderUpdate(activeDialog.overlay, state);
}

// ============================================================
// Rendering
// ============================================================
function render(overlay, state) {
    overlay.innerHTML = `
        <div class="setup-dialog">
            <div class="setup-header">
                <div class="setup-title-wrap">
                    <div class="setup-title">Installing ${esc(CHIP_LABELS[state.chip] || state.chip)} toolchain</div>
                    <div class="setup-subtitle">First-time setup for your chip. This won't happen again on this device.</div>
                </div>
                <div class="setup-header-actions">
                    <button class="setup-icon-btn" id="setupMinimize" title="Hide dialog (install keeps running)" aria-label="Minimize">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="19" x2="19" y2="19"/></svg>
                    </button>
                    <button class="setup-icon-btn" id="setupClose" title="Close (will ask before cancelling install)" aria-label="Close">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
                    </button>
                </div>
            </div>

            <div class="setup-body">
                <div class="setup-stats" id="setupStats"></div>
                <div class="setup-progress-track"><div class="setup-progress-fill" id="setupOverallFill"></div></div>
                <div class="setup-stages" id="setupStages"></div>
                <button class="setup-log-toggle" id="setupLogToggle">▸ Show install log</button>
                <pre class="setup-log" id="setupLog" style="display:none"></pre>
            </div>

            <div class="setup-footer">
                <button class="setup-btn setup-btn-danger" id="setupCancel">Cancel install</button>
                <div class="setup-footer-spacer"></div>
                <button class="setup-btn setup-btn-ghost" id="setupBackground">Run in background</button>
                <button class="setup-btn setup-btn-primary" id="setupContinue" style="display:none">Continue</button>
            </div>
        </div>
    `;

    overlay.querySelector("#setupMinimize").onclick = () => toggleMinimize();
    overlay.querySelector("#setupClose").onclick = () => {
        // X button — if install still running, ask first; if done, just close
        if (state.finished) closeDialog(state);
        else confirmCancel(state);
    };
    overlay.querySelector("#setupBackground").onclick = () => toggleMinimize();
    overlay.querySelector("#setupLogToggle").onclick = () => toggleLog(state);
    overlay.querySelector("#setupCancel").onclick = () => confirmCancel(state);
    overlay.querySelector("#setupContinue").onclick = () => closeDialog(state);

    renderUpdate(overlay, state);
}

function renderUpdate(overlay, state) {
    // Stats
    const elapsedMs = Date.now() - state.startedAt;
    const totalWeight = state.stages.reduce((a, s) => a + s.weight, 0) || 100;
    const overallPct = state.stages.reduce((a, s) => {
        if (s.status === "done") return a + s.weight;
        if (s.status === "running") return a + (s.weight * (s.subPct || 0) / 100);
        return a;
    }, 0) / totalWeight * 100;

    const etaMs = overallPct > 5 ? (elapsedMs * (100 - overallPct) / overallPct) : null;
    const statsEl = overlay.querySelector("#setupStats");
    if (statsEl) {
        statsEl.innerHTML = state.finished
            ? `<span class="setup-stat">${state.success ? "Done in " : "Stopped after "}${humanDuration(elapsedMs)}</span>`
            : `<span class="setup-stat">${humanDuration(elapsedMs)} elapsed</span>` +
              (etaMs ? ` <span class="setup-stat-sep">·</span> <span class="setup-stat">~${humanDuration(etaMs)} remaining</span>` : "");
    }

    // Overall bar
    const fill = overlay.querySelector("#setupOverallFill");
    if (fill) {
        fill.style.width = Math.min(100, Math.round(overallPct)) + "%";
        fill.className = "setup-progress-fill" +
            (state.finished
                ? (state.success ? " is-done" : " is-error")
                : "");
    }

    // Stages list
    const stagesEl = overlay.querySelector("#setupStages");
    if (stagesEl) {
        stagesEl.innerHTML = state.stages.map(s => renderStage(s)).join("");
    }

    // Log content
    const logEl = overlay.querySelector("#setupLog");
    if (logEl && state.showLog) {
        logEl.textContent = state.log.slice(-300).join("\n");
        logEl.scrollTop = logEl.scrollHeight;
    }

    // Footer button states
    const cancelBtn = overlay.querySelector("#setupCancel");
    const backgroundBtn = overlay.querySelector("#setupBackground");
    const continueBtn = overlay.querySelector("#setupContinue");
    if (state.finished) {
        if (cancelBtn) cancelBtn.style.display = "none";
        if (backgroundBtn) backgroundBtn.style.display = "none";
        if (continueBtn) {
            continueBtn.style.display = "";
            continueBtn.textContent = state.success ? "Continue" : "Close";
        }
    } else if (state.cancelling) {
        if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.textContent = "Cancelling…"; }
    }

    // Error banner
    if (state.finished && !state.success && state.errorMessage) {
        const existing = overlay.querySelector(".setup-error-banner");
        if (!existing) {
            const banner = document.createElement("div");
            banner.className = "setup-error-banner";
            banner.textContent = state.errorMessage;
            overlay.querySelector(".setup-body").prepend(banner);
        }
    }
}

function renderStage(s) {
    const icon = s.status === "done"    ? `<svg class="setup-stage-icon setup-stage-done" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 8 7 12 13 4"/></svg>`
              : s.status === "running" ? `<svg class="setup-stage-icon setup-stage-running" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6"/></svg>`
              : s.status === "failed"  ? `<svg class="setup-stage-icon setup-stage-failed" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`
              :                          `<svg class="setup-stage-icon setup-stage-pending" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6"/></svg>`;

    const meta = s.status === "done"     ? `<span class="setup-stage-meta">${humanDuration(s.durationMs)}</span>`
              : s.status === "running"  ? `<span class="setup-stage-meta">${Math.round(s.subPct)}%</span>`
              : s.status === "failed"   ? `<span class="setup-stage-meta setup-stage-meta-err">failed</span>`
              : "";

    const detail = s.status === "running" && s.detail
        ? `<div class="setup-stage-detail">${esc(s.detail)}</div>`
        : "";

    const subBar = s.status === "running"
        ? `<div class="setup-stage-subbar"><div class="setup-stage-subfill" style="width:${Math.round(s.subPct)}%"></div></div>`
        : "";

    return `
        <div class="setup-stage is-${s.status}">
            <div class="setup-stage-row">
                ${icon}
                <span class="setup-stage-label">${esc(s.label)}</span>
                ${meta}
            </div>
            ${subBar}
            ${detail}
        </div>
    `;
}

// ============================================================
// User interactions
// ============================================================
function toggleLog(state) {
    state.showLog = !state.showLog;
    const overlay = activeDialog.overlay;
    const logEl = overlay.querySelector("#setupLog");
    const toggle = overlay.querySelector("#setupLogToggle");
    if (logEl) logEl.style.display = state.showLog ? "" : "none";
    if (toggle) toggle.textContent = (state.showLog ? "▾" : "▸") + " " + (state.showLog ? "Hide" : "Show") + " install log";
    if (state.showLog) {
        logEl.textContent = state.log.slice(-300).join("\n");
        logEl.scrollTop = logEl.scrollHeight;
    }
}

function toggleMinimize() {
    if (!activeDialog) return;
    activeDialog.minimized = !activeDialog.minimized;
    activeDialog.overlay.classList.toggle("is-minimized", activeDialog.minimized);
    if (activeDialog.minimized) {
        // Make sure the minimized chip is clickable to restore
        const chip = document.createElement("button");
        chip.className = "setup-mini-chip";
        chip.id = "setupMiniChip";
        chip.innerHTML = `
            <span class="setup-mini-spinner"></span>
            <span class="setup-mini-label">Installing ${esc(CHIP_LABELS[activeDialog.state.chip] || activeDialog.state.chip)}…</span>
        `;
        chip.onclick = () => toggleMinimize();
        document.body.appendChild(chip);
    } else {
        const chip = document.getElementById("setupMiniChip");
        if (chip) chip.remove();
    }
}

function confirmCancel(state) {
    if (state.cancelling || state.finished) return;
    if (!confirm("Cancel the install? Any partial download will need to start over.")) return;
    state.cancelling = true;
    renderUpdate(activeDialog.overlay, state);
    // We don't have process-level kill yet — set the flag, let toolchain.js
    // honor it at the next stage boundary, and visually treat it as cancelled.
    api.cancelToolchain?.();
    setTimeout(() => {
        if (!state.finished) completeInstall(state, false, "Cancelled by user.");
    }, 1000);
}

function closeDialog(state) {
    if (!activeDialog) return;
    const { overlay, cleanup, onComplete, onCancel, state: s } = activeDialog;
    overlay.classList.add("is-closing");
    setTimeout(() => {
        if (cleanup) try { cleanup(); } catch (_) {}
        overlay.remove();
        const mini = document.getElementById("setupMiniChip");
        if (mini) mini.remove();
        activeDialog = null;
        if (s.success && onComplete) onComplete();
        else if (!s.success && onCancel) onCancel();
    }, 200);
}

// ============================================================
// Utilities
// ============================================================
function humanDuration(ms) {
    if (ms == null || !isFinite(ms)) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    const sec = s % 60;
    if (m < 60) return sec ? `${m} min ${sec}s` : `${m} min`;
    const h = Math.floor(m / 60);
    return `${h} h ${m % 60} min`;
}

function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
