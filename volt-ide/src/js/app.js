/**
 * Volt IDE — Minimal working Monaco setup
 * Get the editor working first, add features after.
 */

// Monaco worker — must be before import
self.MonacoEnvironment = {
    getWorker: function () {
        return new Worker(
            URL.createObjectURL(
                new Blob(["self.onmessage = function() {}"], { type: "text/javascript" })
            )
        );
    },
};

import * as monaco from "monaco-editor";
import { registerVoltLanguage, defineVoltTheme, VOLT_LANGUAGE_ID } from "./volt-monaco.js";

registerVoltLanguage(monaco);
defineVoltTheme(monaco);

// ---- Editor ----
const container = document.getElementById("editorContainer");
let editor = null;

function createEditor(content) {
    if (editor) {
        editor.getModel().setValue(content);
        return;
    }
    editor = monaco.editor.create(container, {
        value: content,
        language: VOLT_LANGUAGE_ID,
        theme: "volt-dark",
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
        lineHeight: 24,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: "all",
        cursorBlinking: "smooth",
        cursorWidth: 2,
        automaticLayout: true,
        padding: { top: 8 },
        glyphMargin: true,
        overviewRulerBorder: false,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    });

    editor.onDidChangeCursorPosition((e) => {
        const el = document.getElementById("statusLine");
        if (el) el.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });

    // Diagnostics: check 1.5s after typing stops
    let diagTimer = null;
    editor.onDidChangeModelContent(() => {
        clearTimeout(diagTimer);
        diagTimer = setTimeout(runDiagnostics, 1500);
    });
}

// ---- Diagnostics ----
async function runDiagnostics() {
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    const code = model.getValue();
    if (code.trim().length < 10) {
        monaco.editor.setModelMarkers(model, "volt", []);
        return;
    }

    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke("check_code", { source: code });
        if (!Array.isArray(result)) return;

        const markers = [];
        for (const err of result) {
            let line = Math.max(err.line || 1, 1);
            let col = Math.max(err.col || 1, 1);

            // Parse line from error message if parser reported line 1
            const lm = err.message.match(/at line (\d+)/);
            if (lm && line <= 1) line = parseInt(lm[1]);
            const cm = err.message.match(/column (\d+)/);
            if (cm && col <= 1) col = parseInt(cm[1]);

            line = Math.min(line, model.getLineCount());
            const lineLen = model.getLineContent(line).length;
            col = Math.min(col, lineLen + 1);

            markers.push({
                startLineNumber: line,
                startColumn: col,
                endLineNumber: line,
                endColumn: Math.min(col + 15, lineLen + 1),
                message: err.message,
                severity: err.severity === "error"
                    ? monaco.MarkerSeverity.Error
                    : monaco.MarkerSeverity.Warning,
            });
        }

        monaco.editor.setModelMarkers(model, "volt", markers);

        const badge = document.getElementById("problemCount");
        if (badge) {
            badge.textContent = markers.length;
            badge.style.display = markers.length > 0 ? "inline" : "none";
        }
    } catch (e) {
        // silently fail
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

        document.getElementById("toolbar")?.addEventListener("mousedown", (e) => {
            const t = e.target;
            if (t.id === "toolbar" || t.classList?.contains("brand-name") || t.classList?.contains("toolbar-divider")) {
                win.startDragging();
            }
        });
    } catch (e) {}
})();

// ---- Monitor output ----
function appendMonitor(text, level) {
    const output = document.getElementById("monitorOutput");
    if (!output) return;
    const div = document.createElement("div");
    div.className = "log-" + (level || "info");
    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
    div.textContent = `[${ts}] ${text.replace(/\x1b\[[0-9;]*m/g, "")}`;
    output.appendChild(div);
    output.scrollTop = output.scrollHeight;
    while (output.children.length > 3000) output.removeChild(output.firstChild);
}

document.getElementById("monitorClearBtn")?.addEventListener("click", () => {
    const o = document.getElementById("monitorOutput");
    if (o) o.innerHTML = "";
});

// ---- Device detection ----
let currentDevices = [];
let selectedDeviceIndex = 0;

async function scanDevices() {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        currentDevices = await invoke("scan_devices");
    } catch (e) { currentDevices = []; }

    const label = document.getElementById("deviceLabel");
    const dot = document.getElementById("deviceDot");
    const sc = document.getElementById("statusChip");
    const sp = document.getElementById("statusPort");

    if (currentDevices.length > 0) {
        const d = currentDevices[0];
        if (label) label.textContent = d.chip;
        if (dot) dot.className = "device-dot connected";
        if (sc) sc.innerHTML = `<span class="status-dot on"></span> ${d.chip}`;
        if (sp) sp.textContent = d.port;
    } else {
        if (label) label.textContent = "No device";
        if (dot) dot.className = "device-dot";
        if (sc) sc.innerHTML = '<span class="status-dot"></span> No device';
        if (sp) sp.textContent = "";
    }
}
scanDevices();
setInterval(scanDevices, 3000);

// ---- Device dropdown ----
const dropdown = document.getElementById("deviceDropdown");
document.getElementById("deviceSelector")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dropdown) dropdown.classList.toggle("open");
});
document.addEventListener("click", () => dropdown?.classList.remove("open"));

// ---- Events (serial + build) ----
(async () => {
    try {
        const { listen } = await import("@tauri-apps/api/event");
        await listen("serial:data", (e) => appendMonitor(e.payload.line, "info"));
        await listen("serial:connected", (e) => appendMonitor("Connected: " + e.payload, "info"));
        await listen("serial:disconnected", (e) => appendMonitor("Disconnected: " + e.payload, "warn"));
        await listen("serial:error", (e) => appendMonitor(e.payload, "error"));
        await listen("run:progress", (e) => {
            const s = document.getElementById("statusBuild");
            if (e.payload.stage === "error") { if (s) s.textContent = "✗ Error"; appendMonitor(e.payload.message, "error"); }
            else if (e.payload.stage === "done") { if (s) s.textContent = "✓ Done"; appendMonitor(e.payload.message, "info"); }
            else { if (s) s.textContent = e.payload.message; appendMonitor(e.payload.message, "debug"); }
        });
        await listen("run:output", (e) => appendMonitor(e.payload, "debug"));
    } catch (e) {}
})();

// ---- Project management ----
let currentProjectPath = null;
let currentVoltFile = null;

async function loadProject(folder) {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const content = await invoke("read_file", { path: folder + "/main.volt" });
        currentProjectPath = folder;
        currentVoltFile = folder + "/main.volt";

        document.getElementById("welcomeScreen").style.display = "none";
        container.style.display = "block";
        createEditor(content);

        document.title = folder.split("/").pop() + " — Volt IDE";
        appendMonitor("Opened: " + currentVoltFile, "info");
        setTimeout(runDiagnostics, 500);
    } catch (e) {
        appendMonitor("Cannot open: " + e, "error");
    }
}

// ---- Toolbar buttons ----
document.getElementById("runBtn")?.addEventListener("click", async () => {
    if (!currentVoltFile) { appendMonitor("No file open", "warn"); return; }
    if (currentDevices.length === 0) { appendMonitor("No device", "warn"); return; }
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("save_file", { path: currentVoltFile, content: editor.getValue() });
        await invoke("run_project", {
            projectPath: currentProjectPath,
            voltFile: currentVoltFile,
            port: currentDevices[selectedDeviceIndex].port,
            chip: currentDevices[selectedDeviceIndex].chip,
        });
    } catch (e) { appendMonitor("Run failed: " + e, "error"); }
});

document.getElementById("monitorBtn")?.addEventListener("click", async () => {
    if (currentDevices.length === 0) return;
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const m = await invoke("is_monitoring");
        if (m) { await invoke("stop_monitor"); }
        else {
            const d = currentDevices[selectedDeviceIndex];
            await invoke("start_monitor", { port: d.port, baud: d.chip.includes("8266") ? 74880 : 115200 });
        }
    } catch (e) {}
});

document.getElementById("newProjectBtn")?.addEventListener("click", async () => {
    const name = prompt("Project name:");
    if (!name) return;
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const chip = currentDevices.length > 0 ? currentDevices[0].chip.toLowerCase() : "esp32";
        const path = await invoke("create_project", { name, chip: chip === "esp" ? "esp32" : chip });
        if (path) loadProject(path);
    } catch (e) { appendMonitor("Failed: " + e, "error"); }
});

document.getElementById("openProjectBtn")?.addEventListener("click", async () => {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke("browse_volt_file");
        if (result) loadProject(result.folder);
    } catch (e) { appendMonitor("Failed: " + e, "error"); }
});

// ---- Welcome screen ----
document.getElementById("welcomeNewBtn")?.addEventListener("click", () => document.getElementById("newProjectBtn")?.click());
document.getElementById("welcomeOpenBtn")?.addEventListener("click", () => document.getElementById("openProjectBtn")?.click());

(async () => {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const projects = await invoke("list_projects");
        const el = document.getElementById("welcomeRecent");
        if (el && projects.length > 0) {
            el.innerHTML = '<div class="welcome-recent-title">Recent Projects</div>' +
                projects.slice(0, 5).map(p =>
                    `<div class="welcome-recent-item" data-path="${p.path}">${p.name}<span class="welcome-recent-chip">${p.chip.toUpperCase()}</span></div>`
                ).join("");
            el.querySelectorAll(".welcome-recent-item").forEach(item => {
                item.addEventListener("click", () => loadProject(item.dataset.path));
            });
        }
    } catch (e) {}
})();
