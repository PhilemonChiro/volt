// Volt IDE v2 — entry point

import * as toolbar from "./components/toolbar.js";
import * as welcome from "./components/welcome.js";
import * as wizard from "./components/wizard.js";
import * as editor from "./components/editor.js";
import * as statusBar from "./components/status-bar.js";
import * as diagnostics from "./components/diagnostics.js";
import * as projectPicker from "./components/project-picker.js";
import * as deviceSelector from "./components/device-selector.js";
import * as bottomPanel from "./components/bottom-panel.js";
import { readFile, saveFile } from "./services/projects.js";

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
                diagnostics.scheduleCheck(source);
            },
            onCursorChange: (line, col) => {
                statusBar.setLine(line, col);
            },
        });
        editorReady = true;
    }
    editor.focus();
}

// ---- Actions ----
async function loadProject(projectPath) {
    currentProject = projectPath;
    const voltFile = projectPath + "/main.volt";
    currentFile = voltFile;

    try {
        const content = await readFile(voltFile);
        showEditor();
        editor.openFile(voltFile, content);
        toolbar.setProjectOpen(true);
        statusBar.setBuild(projectPath.split("/").pop());
        diagnostics.scheduleCheck(content);
        bottomPanel.appendOutput("Opened: " + voltFile, "success");
        console.log("[volt] Opened:", voltFile);
    } catch (e) {
        console.error("[volt] Failed to open:", voltFile, e);
    }
}

async function onSave() {
    if (!currentFile) return;
    try {
        await saveFile(currentFile, editor.getValue());
        editor.markSaved();
        toolbar.setSaveUnsaved(false);
        bottomPanel.appendOutput("Saved: " + currentFile, "success");
        console.log("[volt] Saved:", currentFile);
    } catch (e) {
        console.error("[volt] Save failed:", e);
    }
}

// ---- Wire toolbar ----
toolbar.init({
    onNew:     () => wizard.show((path) => loadProject(path)),
    onOpen:    () => openProject(),
    onClose:   () => closeProject(),
    onRun:     () => onRun(),
    onMonitor: () => onMonitor(),
    onCheck:   () => onCheck(),
    onFormat:  () => {
        const editors = monaco.editor.getEditors();
        if (editors.length > 0) editors[0].getAction("editor.action.formatDocument")?.run();
    },
    onSave:    () => onSave(),
});

// ---- Wire welcome ----
welcome.init(document.getElementById("welcome"), {
    onNew:        () => wizard.show((path) => loadProject(path)),
    onOpen:       () => openProject(),
    onOpenRecent: (path) => loadProject(path),
});

function closeProject() {
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
    statusBar.setBuild("Ready");
    console.log("[volt] Project closed");
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

    // Show pipeline
    bottomPanel.showPipeline();
    bottomPanel.updatePipelineStage("compile", "Compiling...", 10);
    bottomPanel.appendOutput(`Starting build for ${device.chip} on ${device.port}...`, "info");
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

        // Stage 2: Build (TODO — call idf.py build or cmake)
        bottomPanel.updatePipelineStage("build", `Building for ${device.chip}...`, 30);
        statusBar.setBuild("Building...");
        bottomPanel.appendOutput(`Build for ${device.chip} — not yet implemented in Electron IDE`, "warn");
        bottomPanel.appendOutput("The compiler works. Build/flash pipeline needs to be wired to the toolchain.", "info");
        statusBar.setBuild("Ready");

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

function onCheck() {
    if (!editorReady) return;
    const source = editor.getValue();
    diagnostics.scheduleCheck(source);
    statusBar.setBuild("Checking...");
    console.log("[volt] Check triggered");
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
});

// Init bottom panel
bottomPanel.init(document.getElementById("bottomPanel"));

// Update status bar + problems panel when diagnostics complete
diagnostics.onResult((diags, result) => {
    bottomPanel.setProblems(diags);
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

// Init device detection (scans USB every 3 seconds)
deviceSelector.init((device) => {
    console.log("[volt] Device:", device.chip, device.port);
});

// Wire serial events from main process
window.volt.onSerial((data) => bottomPanel.appendMonitor(data.line));

console.log("[volt] app.js ready");
