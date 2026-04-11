/**
 * Volt IDE — Main Application (Monaco Editor)
 */

import * as monaco from "monaco-editor";
import { registerVoltLanguage, defineVoltTheme, VOLT_LANGUAGE_ID } from "./volt-monaco.js";

// ---- Setup Monaco ----
// Configure workers (inline for Tauri — no separate worker files)
self.MonacoEnvironment = {
    getWorker: function () {
        return new Worker(
            URL.createObjectURL(new Blob([`self.onmessage = function() {}`], { type: "text/javascript" }))
        );
    },
};

registerVoltLanguage(monaco);
defineVoltTheme(monaco);

// ---- Create editor ----
const container = document.getElementById("editorContainer");
let editor = null;
let currentModel = null;

function createEditor(content = "") {
    if (editor) {
        editor.setValue(content);
        return;
    }

    editor = monaco.editor.create(container, {
        value: content,
        language: VOLT_LANGUAGE_ID,
        theme: "volt-dark",
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
        lineHeight: 24,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: "all",
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        smoothScrolling: true,
        bracketPairColorization: { enabled: true },
        automaticLayout: true,
        padding: { top: 8 },
        folding: true,
        glyphMargin: true,
        overviewRulerBorder: false,
        scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
        },
    });

    currentModel = editor.getModel();

    // Update cursor position in status bar
    editor.onDidChangeCursorPosition((e) => {
        document.getElementById("statusLine").textContent =
            `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });

    // Run diagnostics on content change (debounced)
    let diagTimer = null;
    editor.onDidChangeModelContent(() => {
        clearTimeout(diagTimer);
        diagTimer = setTimeout(() => runDiagnostics(), 1200);
    });
}

// ---- Diagnostics ----
async function runDiagnostics() {
    if (!editor || !currentModel) return;
    const code = editor.getValue();
    if (code.trim().length < 10) {
        monaco.editor.setModelMarkers(currentModel, "volt", []);
        updateProblemBadge(0);
        return;
    }

    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke("check_code", { source: code });

        if (!result || !Array.isArray(result)) {
            monaco.editor.setModelMarkers(currentModel, "volt", []);
            updateProblemBadge(0);
            return;
        }

        const markers = result.map(err => {
            let line = err.line;
            let col = err.col || 1;

            // Extract real line from parser error messages
            const lineMatch = err.message.match(/at line (\d+)/);
            if (lineMatch && line <= 1) line = parseInt(lineMatch[1]);
            const colMatch = err.message.match(/column (\d+)/);
            if (colMatch && col <= 1) col = parseInt(colMatch[1]);

            // Clamp to valid range
            const totalLines = currentModel.getLineCount();
            line = Math.min(Math.max(line, 1), totalLines);
            const lineContent = currentModel.getLineContent(line);
            const endCol = Math.min(col + 20, lineContent.length + 1);

            return {
                startLineNumber: line,
                startColumn: Math.max(col, 1),
                endLineNumber: line,
                endColumn: endCol,
                message: err.message + (err.hint ? "\n→ " + err.hint : ""),
                severity: err.severity === "error"
                    ? monaco.MarkerSeverity.Error
                    : monaco.MarkerSeverity.Warning,
            };
        });

        monaco.editor.setModelMarkers(currentModel, "volt", markers);
        updateProblemBadge(markers.length);
    } catch (e) {
        monaco.editor.setModelMarkers(currentModel, "volt", []);
        updateProblemBadge(0);
    }
}

function updateProblemBadge(count) {
    const badge = document.getElementById("problemCount");
    if (badge) {
        if (count > 0) {
            badge.textContent = count;
            badge.style.display = "inline";
        } else {
            badge.style.display = "none";
        }
    }
}

// ---- Window controls ----
(async () => {
    try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();

        document.getElementById("winMinimize")?.addEventListener("click", () => win.minimize());
        document.getElementById("winMaximize")?.addEventListener("click", () => win.toggleMaximize());
        document.getElementById("winClose")?.addEventListener("click", () => win.close());

        const toolbar = document.getElementById("toolbar");
        toolbar.addEventListener("mousedown", (e) => {
            if (e.target === toolbar || e.target.classList.contains("toolbar-brand") ||
                e.target.classList.contains("brand-name") || e.target.classList.contains("brand-logo") ||
                e.target.classList.contains("toolbar-divider")) {
                win.startDragging();
            }
        });
        toolbar.addEventListener("dblclick", (e) => {
            if (e.target === toolbar || e.target.classList.contains("brand-name")) {
                win.toggleMaximize();
            }
        });
    } catch (e) {}
})();

// ---- Run button ----
document.getElementById("runBtn").addEventListener("click", async () => {
    if (currentDevices.length === 0) {
        appendMonitor("No device connected — plug in a board", "error");
        return;
    }
    if (!currentProjectPath || !currentVoltFile) {
        appendMonitor("No file open — click Open or New first", "warn");
        return;
    }

    const device = currentDevices[selectedDeviceIndex];
    const statusBuild = document.getElementById("statusBuild");
    statusBuild.textContent = "Running...";

    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const content = editor.getValue();
        await invoke("save_file", { path: currentVoltFile, content });
        await invoke("run_project", {
            projectPath: currentProjectPath,
            voltFile: currentVoltFile,
            port: device.port,
            chip: device.chip,
        });
    } catch (e) {
        appendMonitor("Run failed: " + e, "error");
        statusBuild.textContent = "✗ Failed";
    }
});

// ---- Monitor button ----
document.getElementById("monitorBtn").addEventListener("click", async () => {
    if (currentDevices.length === 0) {
        appendMonitor("No device connected", "error");
        return;
    }
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const monitoring = await invoke("is_monitoring");
        if (monitoring) {
            await invoke("stop_monitor");
            document.querySelector(".panel-dot")?.classList.remove("live");
        } else {
            const device = currentDevices[selectedDeviceIndex];
            const baud = device.chip.includes("8266") ? 74880 : 115200;
            await invoke("start_monitor", { port: device.port, baud });
            document.querySelector(".panel-dot")?.classList.add("live");
        }
    } catch (e) {
        appendMonitor("Monitor error: " + e, "error");
    }
});

// ---- Event listeners for serial + build progress ----
(async () => {
    try {
        const { listen } = await import("@tauri-apps/api/event");
        await listen("serial:data", (e) => appendMonitor(e.payload.line, "info"));
        await listen("serial:connected", (e) => {
            appendMonitor("Connected to " + e.payload, "info");
            document.querySelector(".panel-dot")?.classList.add("live");
        });
        await listen("serial:disconnected", (e) => {
            appendMonitor("Disconnected from " + e.payload, "warn");
            document.querySelector(".panel-dot")?.classList.remove("live");
        });
        await listen("serial:error", (e) => appendMonitor(e.payload, "error"));
        await listen("run:progress", (e) => {
            const { stage, message } = e.payload;
            const s = document.getElementById("statusBuild");
            if (stage === "error") { s.textContent = "✗ " + message.substring(0, 50); appendMonitor(message, "error"); }
            else if (stage === "done") { s.textContent = "✓ " + message; appendMonitor(message, "info"); }
            else { s.textContent = message; appendMonitor(message, "debug"); }
        });
        await listen("run:output", (e) => appendMonitor(e.payload, "debug"));
    } catch (e) {}
})();

// ---- Monitor output ----
document.getElementById("monitorClearBtn").addEventListener("click", () => {
    document.getElementById("monitorOutput").innerHTML = "";
});

function appendMonitor(text, level) {
    const output = document.getElementById("monitorOutput");
    const line = document.createElement("div");
    line.className = "log-" + (level || "info");
    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(n => String(n).padStart(2, "0")).join(":");
    const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
    line.textContent = `[${ts}] ${clean}`;
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
    while (output.children.length > 5000) output.removeChild(output.firstChild);
}

// ---- Device detection ----
let currentDevices = [];
let selectedDeviceIndex = 0;

async function scanDevices() {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        currentDevices = await invoke("scan_devices");
        updateDeviceUI();
    } catch (e) { updateDeviceUI(); }
}

function updateDeviceUI() {
    const label = document.getElementById("deviceLabel");
    const dot = document.getElementById("deviceDot");
    const statusChip = document.getElementById("statusChip");
    const statusPort = document.getElementById("statusPort");

    if (currentDevices.length === 0) {
        label.textContent = "No device";
        dot.className = "device-dot";
        statusChip.innerHTML = '<span class="status-dot"></span> No device';
        statusPort.textContent = "";
    } else {
        if (selectedDeviceIndex >= currentDevices.length) selectedDeviceIndex = 0;
        const d = currentDevices[selectedDeviceIndex];
        label.textContent = d.chip;
        dot.className = "device-dot connected";
        statusChip.innerHTML = `<span class="status-dot on"></span> ${d.chip}`;
        statusPort.textContent = d.port;
    }
}

scanDevices();
setInterval(scanDevices, 3000);

// ---- Device dropdown ----
const dropdown = document.getElementById("deviceDropdown");
document.getElementById("deviceSelector")?.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("open");
    if (dropdown.classList.contains("open")) {
        scanDevices();
        const list = document.getElementById("dropdownList");
        const empty = document.getElementById("dropdownEmpty");
        if (currentDevices.length === 0) {
            empty.style.display = "block";
            list.innerHTML = "";
        } else {
            empty.style.display = "none";
            list.innerHTML = currentDevices.map((d, i) => `
                <div class="dropdown-item ${i === selectedDeviceIndex ? "selected" : ""}" data-index="${i}">
                    <span class="device-dot ${d.chip !== "unknown" ? "connected" : ""}"></span>
                    <div><div class="dropdown-chip">${d.chip}</div><div class="dropdown-desc">${d.desc}</div></div>
                    <span class="dropdown-port">${d.port}</span>
                </div>`).join("");
            list.querySelectorAll(".dropdown-item").forEach(item => {
                item.addEventListener("click", () => {
                    selectedDeviceIndex = parseInt(item.dataset.index);
                    updateDeviceUI();
                    dropdown.classList.remove("open");
                });
            });
        }
    }
});
document.addEventListener("click", (e) => { if (!e.target.closest(".device-selector-wrap")) dropdown.classList.remove("open"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") dropdown.classList.remove("open"); });

// ---- Project management ----
let currentProjectPath = null;
let currentVoltFile = null;

// New project
document.getElementById("newProjectBtn")?.addEventListener("click", async () => {
    const name = prompt("Project name:");
    if (!name) return;
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        let chip = "esp32";
        if (currentDevices.length > 0) {
            chip = currentDevices[selectedDeviceIndex].chip.toLowerCase();
            if (chip === "esp" || chip === "espressif") chip = "esp32";
        }
        const path = await invoke("create_project", { name, chip });
        if (path) { await loadProject(path); appendMonitor("Created: " + path, "info"); }
    } catch (e) { appendMonitor("New project failed: " + e, "error"); }
});

// Open project picker
const pickerOverlay = document.getElementById("projectPickerOverlay");
document.getElementById("openProjectBtn")?.addEventListener("click", async () => {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const projects = await invoke("list_projects");
        const list = document.getElementById("projectList");
        const empty = document.getElementById("dropdownEmpty");

        if (projects.length === 0) {
            list.innerHTML = '<div class="picker-empty">No projects in ~/Volt/. Click New to create one.</div>';
        } else {
            list.innerHTML = projects.map(p => `
                <div class="picker-item" data-path="${p.path}">
                    <div class="picker-item-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div>
                    <div class="picker-item-info"><div class="picker-item-name">${p.name}</div><div class="picker-item-meta"><span class="picker-item-chip">${p.chip.toUpperCase()}</span><span>${timeAgo(p.modified)}</span></div></div>
                </div>`).join("");
            list.querySelectorAll(".picker-item").forEach(item => {
                item.addEventListener("click", async () => {
                    pickerOverlay.classList.remove("open");
                    await loadProject(item.dataset.path);
                });
            });
        }
        pickerOverlay.classList.add("open");
    } catch (e) { appendMonitor("Cannot list projects: " + e, "error"); }
});

document.getElementById("pickerCloseBtn")?.addEventListener("click", () => pickerOverlay.classList.remove("open"));
pickerOverlay?.addEventListener("click", (e) => { if (e.target === pickerOverlay) pickerOverlay.classList.remove("open"); });

// Browse .volt file
document.getElementById("pickerBrowseBtn")?.addEventListener("click", async () => {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke("browse_volt_file");
        if (result) { pickerOverlay.classList.remove("open"); await loadProjectFile(result.folder, result.file, result.name); }
    } catch (e) { appendMonitor("Browse failed: " + e, "error"); }
});

async function loadProject(folder) {
    await loadProjectFile(folder, folder + "/main.volt", "main.volt");
}

async function loadProjectFile(folder, filePath, fileName) {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const content = await invoke("read_file", { path: filePath });

        currentProjectPath = folder;
        currentVoltFile = filePath;

        // Show editor, hide welcome
        document.getElementById("welcomeScreen").style.display = "none";
        container.style.display = "block";

        createEditor(content);

        const projectName = folder.split("/").pop();
        document.title = fileName + " — " + projectName + " — Volt IDE";
        appendMonitor("Opened: " + filePath, "info");

        // Run initial diagnostics
        setTimeout(runDiagnostics, 500);
    } catch (e) { appendMonitor("Cannot read " + filePath + ": " + e, "error"); }
}

function timeAgo(ts) {
    if (!ts) return "";
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
}

// ---- Welcome screen ----
function showWelcome() {
    document.getElementById("welcomeScreen").style.display = "flex";
    container.style.display = "none";
}

document.getElementById("welcomeNewBtn")?.addEventListener("click", () => document.getElementById("newProjectBtn")?.click());
document.getElementById("welcomeOpenBtn")?.addEventListener("click", () => document.getElementById("openProjectBtn")?.click());

async function loadWelcomeRecent() {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const projects = await invoke("list_projects");
        const el = document.getElementById("welcomeRecent");
        if (projects.length === 0) { el.innerHTML = ""; return; }
        el.innerHTML = '<div class="welcome-recent-title">Recent Projects</div>' +
            projects.slice(0, 5).map(p =>
                `<div class="welcome-recent-item" data-path="${p.path}">${p.name}<span class="welcome-recent-chip">${p.chip.toUpperCase()}</span></div>`
            ).join("");
        el.querySelectorAll(".welcome-recent-item").forEach(item => {
            item.addEventListener("click", () => loadProject(item.dataset.path));
        });
    } catch (e) {}
}
loadWelcomeRecent();
showWelcome();
