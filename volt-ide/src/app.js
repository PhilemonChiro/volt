// Volt IDE v2 — entry point

import * as toolbar from "./components/toolbar.js";
import * as welcome from "./components/welcome.js";
import * as wizard from "./components/wizard.js";
import * as editor from "./components/editor.js";
import * as statusBar from "./components/status-bar.js";
import * as diagnostics from "./components/diagnostics.js";
import * as projectPicker from "./components/project-picker.js";
import * as deviceSelector from "./components/device-selector.js";
import * as chipSelector from "./components/chip-selector.js";
import * as bottomPanel from "./components/bottom-panel.js";
import * as sidePanel from "./components/side-panel.js";
import * as settingsDialog from "./components/settings.js";
import * as settings from "./services/settings.js";
import { readFile, saveFile } from "./services/projects.js";

// Hydrate the settings cache as early as possible so other components can
// read get() synchronously by the time they need it.
settings.init().then(() => {
    applyBodyClassSettings();
});

// Show app version in the status bar (status-bar right side).
window.volt.getVersion().then((v) => statusBar.setVersion(v)).catch(() => {});

// Settings that map to body-level classes (motion, density, etc.)
function applyBodyClassSettings() {
    document.body.classList.toggle(
        "reduce-motion",
        !!settings.get("appearance.reduceMotion", false),
    );
}
settings.onChange((key) => {
    if (key === "*" || key.startsWith("appearance.")) applyBodyClassSettings();
});

console.log("[volt] app.js loading...");

const api = window.volt;
let currentProject = null;
let currentFile = null;
let editorReady = false;

// ---- Views ----
function showWelcome() {
    document.getElementById("welcome").style.display = "flex";
    document.getElementById("editorArea").style.display = "none";
}

function showEditor() {
    document.getElementById("welcome").style.display = "none";
    document.getElementById("editorArea").style.display = "flex";
    if (!editorReady) {
        const container = document.getElementById("editorContainer");
        editor.init(container, {
            onContentChange: (source) => {
                toolbar.setSaveUnsaved(true);
                setFileModified(true);
                diagnostics.scheduleCheck(source);
                // Live pin refresh — regex extraction runs even on broken
                // syntax, so the pinout reflects keystrokes immediately.
                import("./components/pinout-panel.js").then(m => {
                    const chip = (chipSelector.getChip() || "esp32").toLowerCase();
                    const pins = m.extractPinsFromSource(source);
                    m.render(chip, pins);
                }).catch(() => {});
            },
            onCursorChange: (line, col) => {
                statusBar.setLine(line, col);
                // Cursor on a pin line → highlight that pin on the board
                import("./components/pinout-panel.js").then(m => {
                    const source = editor.getValue();
                    const pins = m.extractPinsFromSource(source);
                    const hit = pins.find(p => p.line === line);
                    m.setHighlight(hit ? hit.gpio : null);
                }).catch(() => {});
            },
        });
        editorReady = true;
    }
    editor.focus();
}

// ---- File state tracking ----
function basename(p) {
    if (!p) return "";
    // Handle both / and \ separators cross-platform
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] || parts[parts.length - 2] || "";
}

function joinPath(dir, file) {
    if (!dir) return file;
    // Use the separator already present in dir; default to "/"
    const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
    return dir.replace(/[/\\]$/, "") + sep + file;
}

let _fileModified = false;
function setFileModified(modified) {
    _fileModified = !!modified;
    const el = document.getElementById("infoFileName");
    if (el) el.classList.toggle("modified", modified);
    // Update window title
    if (currentFile) {
        const fileName = basename(currentFile);
        const projName = basename(currentProject);
        document.title = modified
            ? `${fileName} \u25CF — ${projName} — Volt IDE`
            : `${fileName} — ${projName} — Volt IDE`;
    }
}

// ---- Actions ----
async function loadProject(projectPath) {
    currentProject = projectPath;
    const voltFile = joinPath(projectPath, "main.volt");
    currentFile = voltFile;

    try {
        // Track in recents (persists across sessions, any directory)
        window.volt.saveRecent(projectPath);

        // Ensure volt.toml exists — ask for target chip if missing
        const tomlPath = joinPath(projectPath, "volt.toml");
        const hasToml = await window.volt.fileExists(tomlPath);
        if (!hasToml) {
            const chip = await showChipPicker(projectPath);
            if (!chip) return; // user cancelled
            await window.volt.createToml(projectPath, chip);
            bottomPanel.appendOutput(`Created volt.toml (chip: ${chip})`, "success");
        }

        const content = await readFile(voltFile);
        showEditor();
        editor.openFile(voltFile, content);
        toolbar.setProjectOpen(true);
        toolbar.setSaveUnsaved(false);
        setFileModified(false);
        await chipSelector.loadFromProject(projectPath);
        // Info bar
        const projName = basename(projectPath);
        const el1 = document.getElementById("infoProjectName");
        const el2 = document.getElementById("infoFileName");
        if (el1) el1.textContent = projName;
        if (el2) el2.textContent = basename(voltFile);
        statusBar.setBuild(projName);
        diagnostics.scheduleCheck(content);
        bottomPanel.appendOutput("Opened: " + voltFile, "success");
        console.log("[volt] Opened:", voltFile);
    } catch (e) {
        console.error("[volt] Failed to open:", voltFile, e);
    }
}

// Chip picker dialog — shown when project has no volt.toml
function showChipPicker(projectPath) {
    return new Promise((resolve) => {
        const projName = basename(projectPath);
        const overlay = document.createElement("div");
        overlay.className = "dialog-overlay";
        overlay.innerHTML = `
            <div class="dialog">
                <h2 class="dialog-title">Select Target Board</h2>
                <p class="dialog-subtitle">${projName} has no volt.toml — choose a target chip:</p>
                <div class="chip-grid">
                    <button class="chip-option" data-chip="esp32">
                        <span class="chip-option-name">ESP32</span>
                        <span class="chip-option-desc">WiFi + BLE, 520KB RAM</span>
                    </button>
                    <button class="chip-option" data-chip="esp8266">
                        <span class="chip-option-name">ESP8266</span>
                        <span class="chip-option-desc">WiFi, 80KB RAM</span>
                    </button>
                    <button class="chip-option" data-chip="rp2040">
                        <span class="chip-option-name">RP2040</span>
                        <span class="chip-option-desc">Dual-core ARM, 264KB RAM</span>
                    </button>
                    <button class="chip-option" data-chip="stm32f103">
                        <span class="chip-option-name">STM32 Blue Pill</span>
                        <span class="chip-option-desc">ARM Cortex-M3, 20KB RAM</span>
                    </button>
                </div>
                <div class="dialog-actions">
                    <button class="dialog-btn" id="chipPickerCancel">Cancel</button>
                </div>
            </div>
        `;

        overlay.querySelectorAll(".chip-option").forEach(btn => {
            btn.onclick = () => {
                overlay.remove();
                resolve(btn.dataset.chip);
            };
        });

        overlay.querySelector("#chipPickerCancel").onclick = () => {
            overlay.remove();
            resolve(null);
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) { overlay.remove(); resolve(null); }
        };

        document.body.appendChild(overlay);
    });
}

async function onSave() {
    if (!currentFile) return;
    try {
        // Format on save (Settings → Editor → "Format on save")
        if (settings.get("editor.formatOnSave") === true) {
            try {
                const original = editor.getValue();
                const formatted = await window.volt.formatCode(original);
                if (formatted && formatted !== original) {
                    const editors = monaco.editor.getEditors();
                    if (editors.length > 0) {
                        editors[0].executeEdits("format-on-save", [{
                            range: editors[0].getModel().getFullModelRange(),
                            text: formatted,
                            forceMoveMarkers: true,
                        }]);
                    }
                }
            } catch (e) {
                console.warn("[volt] format-on-save failed:", e);
            }
        }
        await saveFile(currentFile, editor.getValue());
        editor.markSaved();
        toolbar.setSaveUnsaved(false);
        setFileModified(false);
        bottomPanel.appendOutput("Saved: " + currentFile, "success");
        console.log("[volt] Saved:", currentFile);
    } catch (e) {
        console.error("[volt] Save failed:", e);
        bottomPanel.appendOutput("Save failed: " + e.message, "error");
    }
}

// ---- Wire toolbar ----
toolbar.init({
    onNew:      () => wizard.show((path) => loadProject(path)),
    onOpen:     () => openProject(),
    onClose:    () => closeProject(),
    onRun:      () => onRun(),
    onMonitor:  () => onMonitor(),
    onCheck:    () => onCheck(),
    onFormat:   () => {
        const editors = monaco.editor.getEditors();
        if (editors.length > 0) editors[0].getAction("editor.action.formatDocument")?.run();
    },
    onSave:     () => onSave(),
    onSettings: () => settingsDialog.show(),
});

// ---- Wire welcome ----
welcome.init(document.getElementById("welcome"), {
    onNew:        () => wizard.show((path) => loadProject(path)),
    onOpen:       () => openProject(),
    onOpenRecent: (path) => loadProject(path),
});

function closeProject() {
    if (!currentProject) return;
    const projName = basename(currentProject);
    const msg = _fileModified
        ? `Unsaved changes in ${projName} will be lost. Close project anyway?`
        : `Close project ${projName}?`;
    if (!confirm(msg)) return;
    currentProject = null;
    currentFile = null;
    showWelcome();
    toolbar.setProjectOpen(false);
    // Refresh recent projects list
    welcome.init(document.getElementById("welcome"), {
        onNew:        () => wizard.show((path) => loadProject(path)),
        onOpen:       () => openProject(),
        onOpenRecent: (path) => loadProject(path),
    });
    toolbar.setSaveUnsaved(false);
    setFileModified(false);
    document.title = "Volt IDE";
    chipSelector.reset();
    sidePanel.close();
    statusBar.setBuild("Ready");
    console.log("[volt] Project closed");
}

// Ensure the chip toolchain is installed before build. If missing, open the
// modal install dialog (stages, progress, log, background, soft-cancel).
// Returns true if ready / install succeeded, false on cancel or failure.
async function ensureToolchainWithDialog(chip) {
    const ready = await window.volt.checkToolchain(chip);
    if (ready) {
        bottomPanel.appendOutput(`${chip} toolchain: ready`, "success");
        return true;
    }
    bottomPanel.appendOutput(`${chip} toolchain not found — opening installer…`, "warn");
    bottomPanel.updatePipelineStage("build", `Installing ${chip} toolchain…`, 30);
    statusBar.setBuild("Installing toolchain…");
    const setupDialog = await import("./components/setup-dialog.js");
    const ok = await new Promise((resolve) => {
        setupDialog.show({
            chip,
            onComplete: () => resolve(true),
            onCancel:   () => resolve(false),
        });
    });
    if (ok) bottomPanel.appendOutput("Toolchain ready", "success");
    return ok;
}

async function onRun() {
    if (!currentFile) {
        bottomPanel.appendOutput("No file open. Click Open or New first.", "warn");
        return;
    }

    const device = deviceSelector.getSelected();
    if (!device) {
        bottomPanel.appendOutput("No device connected. Plug in a board to run.", "error");
        return;
    }

    // Save first
    await onSave();

    // Project chip from volt.toml is source of truth
    const targetChip = chipSelector.getChip();

    // Warn if connected device doesn't match project target
    const detectedChip = device.chip.toLowerCase();
    const targetLower = targetChip.toLowerCase();
    const isMatch = detectedChip.includes(targetLower) || targetLower.includes(detectedChip)
        || (targetLower === "rp2040" && detectedChip.includes("rp2040"))
        || (targetLower === "esp32" && detectedChip.includes("esp32"));

    if (!isMatch && detectedChip !== "unknown") {
        bottomPanel.appendOutput(
            `Warning: Project targets ${targetChip.toUpperCase()} but ${device.chip} is connected on ${device.port}`,
            "warn"
        );
    }

    // Show pipeline
    bottomPanel.showPipeline();
    bottomPanel.updatePipelineStage("compile", "Compiling...", 10);
    bottomPanel.appendOutput(`Starting build for ${targetChip.toUpperCase()} on ${device.port}...`, "info");
    statusBar.setBuild("Compiling...");

    // Stage 1: Compile
    try {
        const result = await window.volt.compileFull(editor.getValue());
        const errors = (result.diagnostics || []).filter(d => d.severity === "error");

        if (errors.length > 0) {
            bottomPanel.updatePipelineStage("error", `${errors.length} error(s) — fix before building`, 10);
            bottomPanel.appendOutput(`Compile failed: ${errors.length} error(s)`, "error");
            statusBar.setBuild("Compile failed");
            return;
        }

        const cLen = (result.c_code || "").length;
        bottomPanel.updatePipelineStage("compile", "Compiled successfully", 20);
        bottomPanel.appendOutput(`Compiled: ${cLen} chars of C (${result.pins.length} pins, ${result.tasks.length} tasks)`, "success");

        // Stage 2: Check/install toolchain
        bottomPanel.updatePipelineStage("build", `Checking ${targetChip} toolchain...`, 25);
        statusBar.setBuild("Checking toolchain...");

        const installed = await ensureToolchainWithDialog(targetChip);
        if (!installed) {
            bottomPanel.updatePipelineStage("error", "Toolchain install cancelled or failed", 30);
            statusBar.setBuild("Setup failed");
            return;
        }

        // Stage 2-5: Build → Flash → Connect → Verify (via main process)
        bottomPanel.updatePipelineStage("build", `Building for ${targetChip}...`, 35);
        statusBar.setBuild("Building...");

        const buildResult = await window.volt.runProject(
            currentProject, currentFile, device.port, targetChip
        );

        if (!buildResult || !buildResult.ok) {
            if (!buildResult) {
                bottomPanel.updatePipelineStage("error", "Build process failed", 0);
                statusBar.setBuild("Failed");
            }
        }

    } catch (e) {
        bottomPanel.updatePipelineStage("error", "Compiler error", 10);
        bottomPanel.appendOutput("Run failed: " + e, "error");
        statusBar.setBuild("Failed");
    }
}

async function onMonitor() {
    const device = deviceSelector.getSelected();
    if (!device) {
        bottomPanel.appendOutput("No device connected.", "error");
        return;
    }

    const isOn = await window.volt.isMonitoring();
    if (isOn) {
        await window.volt.stopMonitor();
        bottomPanel.setMonitorConnected(false);
        bottomPanel.appendOutput("Serial monitor stopped", "info");
    } else {
        const baud = device.chip.includes("8266") ? 74880 : 115200;
        await window.volt.startMonitor(device.port, baud);
        bottomPanel.setMonitorConnected(true);
        bottomPanel.appendOutput(`Serial monitor: ${device.port} @ ${baud} baud`, "success");
    }
}

async function onCheck() {
    if (!editorReady || !currentFile) return;

    await onSave();

    const targetChip = chipSelector.getChip();

    bottomPanel.showPipeline();
    bottomPanel.updatePipelineStage("compile", "Compiling...", 10);
    statusBar.setBuild("Checking...");

    try {
        // Stage 1: Compile
        const result = await window.volt.compileFull(editor.getValue());
        const errors = (result.diagnostics || []).filter(d => d.severity === "error");
        bottomPanel.setProblems(result.diagnostics || []);

        if (errors.length > 0) {
            bottomPanel.updatePipelineStage("error", `${errors.length} error(s)`, 10);
            bottomPanel.appendOutput(`Check failed: ${errors.length} error(s)`, "error");
            statusBar.setBuild("Check failed");
            return;
        }

        bottomPanel.updatePipelineStage("compile", "Compiled", 20);
        bottomPanel.appendOutput(`Compiled: ${(result.c_code || "").length} chars of C`, "success");

        // Stage 2: Toolchain
        bottomPanel.updatePipelineStage("build", `Checking ${targetChip} toolchain...`, 25);
        const installed = await ensureToolchainWithDialog(targetChip);
        if (!installed) {
            bottomPanel.updatePipelineStage("error", "Toolchain install cancelled or failed", 30);
            statusBar.setBuild("Setup failed");
            return;
        }

        // Stage 3: Build (no flash)
        bottomPanel.updatePipelineStage("build", `Building for ${targetChip}...`, 40);
        statusBar.setBuild("Building...");

        const buildResult = await window.volt.buildOnly(
            currentProject, currentFile, targetChip
        );

        if (buildResult && buildResult.ok) {
            bottomPanel.updatePipelineStage("build", "Build successful", 100);
            bottomPanel.appendOutput("Check complete — build OK", "success");
            statusBar.setBuild("Build OK");
            setTimeout(() => bottomPanel.clearProgress(), 3000);
        }
    } catch (e) {
        bottomPanel.updatePipelineStage("error", "Check failed", 0);
        bottomPanel.appendOutput("Check failed: " + e, "error");
        statusBar.setBuild("Failed");
    }
}

function openProject() {
    projectPicker.show((path) => loadProject(path));
}

// ---- Keyboard shortcuts ----
document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "n") { e.preventDefault(); wizard.show((path) => loadProject(path)); }
    if (e.ctrlKey && e.key === "o") { e.preventDefault(); openProject(); }
    if (e.ctrlKey && e.key === "b") { e.preventDefault(); onCheck(); }
    if (e.ctrlKey && e.key === "s") { e.preventDefault(); onSave(); }
    if (e.ctrlKey && e.key === "w") { e.preventDefault(); closeProject(); }
    if (e.ctrlKey && e.key === "1") { e.preventDefault(); sidePanel.toggle("hardware"); }
    if (e.ctrlKey && e.key === "2") { e.preventDefault(); sidePanel.toggle("tasks"); }
    if (e.ctrlKey && e.key === "3") { e.preventDefault(); sidePanel.toggle("outline"); }
    if (e.ctrlKey && e.key === "4") { e.preventDefault(); sidePanel.toggle("library"); }
    if (e.ctrlKey && e.key === "5") { e.preventDefault(); sidePanel.toggle("pinout"); }
});

// Init panels
bottomPanel.init(document.getElementById("bottomPanel"));
sidePanel.init();

// Drive the build progress bar from the real events main.js emits during
// compile / cmake configure / ninja / esptool. Per-file build steps and
// flash percentages are now the source of truth instead of hardcoded
// stage markers from the renderer.
window.volt.onBuild("progress", ({ stage, message, percent }) => {
    bottomPanel.updatePipelineStage(stage, message, percent);
    if (stage === "build" || stage === "flash" || stage === "compile") {
        statusBar.setBuild(message);
    }
});

// ── Pinout ↔ editor bidirectional sync ──────────────────────────
// hover a pin on the board → flash its declaration line in the editor
let _pinoutHoverDecos = null;
document.addEventListener("pinout:hover", (e) => {
    if (typeof monaco === "undefined") return;
    const eds = monaco.editor.getEditors();
    if (!eds.length) return;
    const ed = eds[0];
    const line = (e.detail && e.detail.line) || 0;
    if (!_pinoutHoverDecos) _pinoutHoverDecos = ed.createDecorationsCollection([]);
    if (line > 0) {
        _pinoutHoverDecos.set([{
            range: new monaco.Range(line, 1, line, 1),
            options: { isWholeLine: true, className: "pinout-hover-line", linesDecorationsClassName: "pinout-hover-gutter" }
        }]);
    } else {
        _pinoutHoverDecos.set([]);
    }
});

// click a pin → scroll/focus its declaration line
document.addEventListener("pinout:jump", (e) => {
    if (typeof monaco === "undefined") return;
    const eds = monaco.editor.getEditors();
    if (!eds.length) return;
    const ed = eds[0];
    const name = e.detail && e.detail.name;
    if (!name) return;
    const model = ed.getModel();
    if (!model) return;
    // Find the line where `pin <name>` is declared
    const re = new RegExp(`^\\s*pin\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`);
    const lines = model.getLinesContent();
    for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
            const ln = i + 1;
            ed.revealLineInCenter(ln);
            ed.setPosition({ lineNumber: ln, column: 1 });
            ed.focus();
            return;
        }
    }
});

// Update status bar + problems panel + side panel when diagnostics complete
diagnostics.onResult((diags, result) => {
    bottomPanel.setProblems(diags);
    // Feed AST data to side panel (live update as user types)
    if (result) sidePanel.update(result);
    const errors = diags.filter(d => d.severity === "error").length;
    const warnings = diags.filter(d => d.severity === "warning").length;
    if (errors > 0) {
        statusBar.setBuild(`${errors} error${errors > 1 ? "s" : ""}${warnings ? ", " + warnings + " warning" + (warnings > 1 ? "s" : "") : ""}`);
    } else if (warnings > 0) {
        statusBar.setBuild(`${warnings} warning${warnings > 1 ? "s" : ""}`);
    } else {
        statusBar.setBuild("No errors");
    }
});

// Init chip selector (reads from volt.toml, allows manual change)
chipSelector.init((chip) => {
    console.log("[volt] Target chip changed to:", chip);
    bottomPanel.appendOutput("Target chip: " + chip.toUpperCase(), "info");
    if (editorReady) diagnostics.scheduleCheck(editor.getValue());
});

// Init device detection — check for chip mismatch
deviceSelector.init((device) => {
    console.log("[volt] Device:", device.chip, device.port);
    checkChipMismatch();
});

function checkChipMismatch() {
    const el = document.getElementById("chipMismatch");
    if (!el || !currentProject) { if (el) el.style.display = "none"; return; }
    const device = deviceSelector.getSelected();
    if (!device) { el.style.display = "none"; return; }
    const target = chipSelector.getChip().toLowerCase();
    const detected = device.chip.toLowerCase();
    const match = detected === "unknown" || detected.includes(target) || target.includes(detected);
    if (!match) {
        el.style.display = "";
        el.textContent = `⚠ ${device.chip} connected — project targets ${chipSelector.getChip().toUpperCase()}`;
    } else {
        el.style.display = "none";
    }
}

// Wire serial events from main process
window.volt.onSerial((data) => bottomPanel.appendMonitor(data.line));
window.volt.onSerialDisconnected(() => bottomPanel.setMonitorConnected(false));
window.volt.onSerialConnected(() => bottomPanel.setMonitorConnected(true));

// Wire build progress events (registered once, not per-run)
window.volt.onBuild("progress", (data) => {
    const { stage, message } = data;
    if (stage === "error") {
        bottomPanel.updatePipelineStage("error", message, 0);
        bottomPanel.appendOutput(message, "error");
        statusBar.setBuild("Failed");
    } else if (stage === "done") {
        bottomPanel.updatePipelineStage("verify", message, 100);
        bottomPanel.appendOutput(message, "success");
        statusBar.setBuild("Ready");
        setTimeout(() => bottomPanel.clearProgress(), 3000);
    } else {
        const pctMap = { compile: 20, build: 45, flash: 70, connect: 90, verify: 95 };
        bottomPanel.updatePipelineStage(stage, message, pctMap[stage] || 50);
        bottomPanel.appendOutput(message, "info");
        statusBar.setBuild(message);
    }
});

console.log("[volt] app.js ready");
