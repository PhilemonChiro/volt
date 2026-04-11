/**
 * Volt IDE — Main Application
 * Phase 1: Editor with Volt syntax highlighting
 */

import { EditorView, keymap, lineNumbers, highlightActiveLine,
         highlightActiveLineGutter, drawSelection, rectangularSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { voltLanguage, voltHighlight, syntaxHighlighting } from "./volt-syntax.js";

// ---- Dark theme for the editor chrome ----
const voltTheme = EditorView.theme({
    "&": {
        backgroundColor: "hsl(220, 16%, 9%)",
        color: "hsl(220, 20%, 90%)",
    },
    ".cm-content": {
        caretColor: "#5BA4D9",
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
        fontSize: "14px",
        lineHeight: "1.65",
        padding: "8px 0",
    },
    ".cm-cursor": {
        borderLeftColor: "#5BA4D9",
        borderLeftWidth: "2px",
    },
    ".cm-activeLine": { backgroundColor: "hsla(220, 14%, 15%, 0.6)" },
    ".cm-activeLineGutter": { backgroundColor: "hsla(220, 14%, 15%, 0.6)" },
    ".cm-gutters": {
        backgroundColor: "hsl(220, 16%, 9%)",
        color: "hsl(220, 8%, 32%)",
        border: "none",
        paddingRight: "12px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "3em",
        textAlign: "right",
        padding: "0 4px",
    },
    ".cm-foldGutter": { width: "14px" },
    ".cm-selectionBackground": { backgroundColor: "rgba(43, 124, 179, 0.2) !important" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(43, 124, 179, 0.25) !important" },
    ".cm-matchingBracket": {
        backgroundColor: "rgba(43, 124, 179, 0.15)",
        outline: "1px solid rgba(43, 124, 179, 0.35)",
    },
    ".cm-searchMatch": { backgroundColor: "rgba(43, 124, 179, 0.2)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(43, 124, 179, 0.35)" },
    ".cm-selectionMatch": { backgroundColor: "hsla(152, 60%, 40%, 0.12)" },
}, { dark: true });

// ---- Default Volt code ----
const DEFAULT_CODE = `chip esp32

hardware {
    pin led: Output = 2
}

task blink() {
    every 500ms {
        led.toggle()
    }
}

main {
    run(blink)
}
`;

// ---- Create editor ----
const container = document.getElementById("editorContainer");

const state = EditorState.create({
    doc: DEFAULT_CODE,
    extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        foldGutter(),
        drawSelection(),
        rectangularSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...closeBracketsKeymap,
            ...searchKeymap,
            indentWithTab,
        ]),
        voltLanguage,
        syntaxHighlighting(voltHighlight),
        voltTheme,
        // Update cursor position in status bar
        EditorView.updateListener.of(update => {
            if (update.selectionSet) {
                const pos = update.state.selection.main.head;
                const line = update.state.doc.lineAt(pos);
                const col = pos - line.from + 1;
                document.getElementById("statusLine").textContent =
                    `Ln ${line.number}, Col ${col}`;
            }
        }),
    ],
});

const editor = new EditorView({
    state,
    parent: container,
});

// ---- Run button — real build + flash + monitor ----
document.getElementById("runBtn").addEventListener("click", async () => {
    if (currentDevices.length === 0) {
        appendMonitor("No device connected — plug in a board", "error");
        return;
    }

    const device = currentDevices[selectedDeviceIndex];
    const statusBuild = document.getElementById("statusBuild");

    try {
        const { invoke } = await import("@tauri-apps/api/core");

        // Use current working directory or ~/Volt as project path
        // For now, this is a placeholder — will use actual project path
        statusBuild.textContent = "Running...";

        if (!currentProjectPath) {
            appendMonitor("No project open — click Open or New first", "warn");
            statusBuild.textContent = "";
            return;
        }

        // Save current editor content before building
        const savePath = currentVoltFile || (currentProjectPath + "/main.volt");
        try {
            const content = editor.state.doc.toString();
            await invoke("save_file", { path: savePath, content });
        } catch (e) {
            appendMonitor("Cannot save: " + e, "error");
        }

        await invoke("run_project", {
            projectPath: currentProjectPath,
            port: device.port,
            chip: device.chip,
        });
    } catch (e) {
        appendMonitor("Run failed: " + e, "error");
        statusBuild.textContent = "✗ Failed";
    }
});

// ---- Monitor button — toggle serial monitor ----
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
            // Auto-detect baud: ESP8266=74880, others=115200
            const baud = device.chip.includes("8266") ? 74880 : 115200;
            await invoke("start_monitor", { port: device.port, baud });
            document.querySelector(".panel-dot")?.classList.add("live");
        }
    } catch (e) {
        appendMonitor("Monitor error: " + e, "error");
    }
});

// ---- Listen for serial data + run progress ----
async function setupListeners() {
    try {
        const { listen } = await import("@tauri-apps/api/event");

        await listen("serial:data", (event) => {
            appendMonitor(event.payload.line, "info");
        });

        await listen("serial:connected", (event) => {
            appendMonitor("Connected to " + event.payload, "info");
            document.querySelector(".panel-dot")?.classList.add("live");
        });

        await listen("serial:disconnected", (event) => {
            appendMonitor("Disconnected from " + event.payload, "warn");
            document.querySelector(".panel-dot")?.classList.remove("live");
        });

        await listen("serial:error", (event) => {
            appendMonitor(event.payload, "error");
        });

        await listen("run:progress", (event) => {
            const { stage, message, percent } = event.payload;
            const statusBuild = document.getElementById("statusBuild");

            if (stage === "error") {
                statusBuild.textContent = "✗ " + message.substring(0, 50);
                appendMonitor(message, "error");
            } else if (stage === "done") {
                statusBuild.textContent = "✓ " + message;
                appendMonitor(message, "info");
            } else {
                statusBuild.textContent = message;
                appendMonitor(message, "debug");
            }
        });

        await listen("run:output", (event) => {
            appendMonitor(event.payload, "debug");
        });
    } catch (e) {
        // Not in Tauri
    }
}
setupListeners();

// ---- Monitor output helpers ----
function appendMonitor(text, level) {
    const output = document.getElementById("monitorOutput");
    const line = document.createElement("div");
    line.className = "log-" + (level || "info");

    // Timestamp
    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(n => String(n).padStart(2, '0')).join(':');

    // Strip ANSI codes
    const clean = text.replace(/\x1b\[[0-9;]*m/g, '');

    line.textContent = `[${ts}] ${clean}`;
    output.appendChild(line);

    // Auto-scroll
    output.scrollTop = output.scrollHeight;

    // Limit lines
    while (output.children.length > 5000) {
        output.removeChild(output.firstChild);
    }
}

document.getElementById("monitorClearBtn").addEventListener("click", () => {
    document.getElementById("monitorOutput").innerHTML = "";
});

// ---- Open Project (project picker) ----
const pickerOverlay = document.getElementById("projectPickerOverlay");
const projectListEl = document.getElementById("projectList");

document.getElementById("openProjectBtn").addEventListener("click", async () => {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const projects = await invoke("list_projects");

        if (projects.length === 0) {
            projectListEl.innerHTML = '<div class="picker-empty">No projects in ~/Volt/. Click New to create one.</div>';
        } else {
            projectListEl.innerHTML = projects.map(p => {
                const ago = timeAgo(p.modified);
                return `<div class="picker-item" data-path="${p.path}">
                    <div class="picker-item-icon">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    </div>
                    <div class="picker-item-info">
                        <div class="picker-item-name">${p.name}</div>
                        <div class="picker-item-meta">
                            <span class="picker-item-chip">${p.chip.toUpperCase()}</span>
                            <span>${ago}</span>
                        </div>
                    </div>
                </div>`;
            }).join("");

            projectListEl.querySelectorAll(".picker-item").forEach(item => {
                item.addEventListener("click", async () => {
                    pickerOverlay.classList.remove("open");
                    await loadProject(item.dataset.path);
                });
            });
        }

        pickerOverlay.classList.add("open");
    } catch (e) {
        appendMonitor("Cannot list projects: " + e, "error");
    }
});

document.getElementById("pickerCloseBtn").addEventListener("click", () => {
    pickerOverlay.classList.remove("open");
});

// Browse for .volt file (native file dialog, filtered to .volt only)
document.getElementById("pickerBrowseBtn").addEventListener("click", async () => {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke("browse_volt_file");
        if (result) {
            pickerOverlay.classList.remove("open");
            await loadProjectFile(result.folder, result.file, result.name);
        }
    } catch (e) {
        appendMonitor("Browse failed: " + e, "error");
    }
});
pickerOverlay.addEventListener("click", (e) => {
    if (e.target === pickerOverlay) pickerOverlay.classList.remove("open");
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") pickerOverlay.classList.remove("open");
});

function timeAgo(timestamp) {
    if (!timestamp) return "";
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    if (diff < 604800) return Math.floor(diff / 86400) + "d ago";
    return new Date(timestamp * 1000).toLocaleDateString();
}

// ---- New Project ----
document.getElementById("newProjectBtn").addEventListener("click", async () => {
    const name = prompt("Project name:");
    if (!name) return;

    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const chip = currentDevices.length > 0 ? currentDevices[selectedDeviceIndex].chip : "esp32";
        const path = await invoke("create_project", { name, chip: chip.toLowerCase() });
        if (path) {
            await loadProject(path);
            appendMonitor("Created project: " + path, "info");
        }
    } catch (e) {
        appendMonitor("New project failed: " + e, "error");
    }
});

// ---- Project loading ----
let currentProjectPath = null;

let currentVoltFile = null;

async function loadProject(folder) {
    // Try main.volt first, then first .volt file found
    await loadProjectFile(folder, folder + "/main.volt", "main.volt");
}

async function loadProjectFile(folder, filePath, fileName) {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const content = await invoke("read_file", { path: filePath });

        currentProjectPath = folder;
        currentVoltFile = filePath;

        editor.dispatch({
            changes: { from: 0, to: editor.state.doc.length, insert: content }
        });

        const projectName = folder.split("/").pop();
        document.title = fileName + " — " + projectName + " — Volt IDE";
        appendMonitor("Opened: " + filePath, "info");
    } catch (e) {
        appendMonitor("Cannot read " + filePath + ": " + e, "error");
    }
}

async function getVoltProjectsDir() {
    try {
        const { homeDir } = await import("@tauri-apps/api/path");
        return (await homeDir()) + "Volt";
    } catch {
        return "";
    }
}

// ---- Window controls + drag ----
try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();

    document.getElementById("winMinimize")?.addEventListener("click", () => win.minimize());
    document.getElementById("winMaximize")?.addEventListener("click", () => win.toggleMaximize());
    document.getElementById("winClose")?.addEventListener("click", () => win.close());

    // Drag window from toolbar
    const toolbar = document.getElementById("toolbar");
    toolbar.addEventListener("mousedown", (e) => {
        // Only drag from empty toolbar area (not buttons)
        if (e.target === toolbar || e.target.classList.contains("toolbar-brand") ||
            e.target.classList.contains("brand-name") || e.target.classList.contains("brand-logo") ||
            e.target.classList.contains("toolbar-divider")) {
            win.startDragging();
        }
    });

    // Double-click toolbar to maximize
    toolbar.addEventListener("dblclick", (e) => {
        if (e.target === toolbar || e.target.classList.contains("brand-name")) {
            win.toggleMaximize();
        }
    });
} catch (e) {
    // Not running in Tauri
}

// ---- Device detection ----
let currentDevices = [];

async function scanDevices() {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const devices = await invoke("scan_devices");
        currentDevices = devices;
        updateDeviceUI(devices);
    } catch (e) {
        // Not in Tauri or scan failed
        updateDeviceUI([]);
    }
}

let selectedDeviceIndex = 0;

function updateDeviceUI(devices) {
    const label = document.getElementById("deviceLabel");
    const dot = document.getElementById("deviceDot");
    const statusChip = document.getElementById("statusChip");
    const statusPort = document.getElementById("statusPort");
    const dropdownList = document.getElementById("dropdownList");
    const dropdownEmpty = document.getElementById("dropdownEmpty");

    if (devices.length === 0) {
        label.textContent = "No device";
        dot.className = "device-dot";
        statusChip.innerHTML = '<span class="status-dot"></span> No device';
        statusPort.textContent = "";
        dropdownEmpty.style.display = "block";
        dropdownList.innerHTML = "";
    } else {
        if (selectedDeviceIndex >= devices.length) selectedDeviceIndex = 0;
        const d = devices[selectedDeviceIndex];
        label.textContent = d.chip;
        dot.className = "device-dot connected";
        statusChip.innerHTML = `<span class="status-dot on"></span> ${d.chip}`;
        statusPort.textContent = d.port;
        dropdownEmpty.style.display = "none";

        dropdownList.innerHTML = devices.map((dev, i) => `
            <div class="dropdown-item ${i === selectedDeviceIndex ? 'selected' : ''}" data-index="${i}">
                <span class="device-dot ${dev.chip !== 'unknown' ? 'connected' : ''}"></span>
                <div>
                    <div class="dropdown-chip">${dev.chip}</div>
                    <div class="dropdown-desc">${dev.desc}</div>
                </div>
                <span class="dropdown-port">${dev.port}</span>
            </div>
        `).join("");

        // Click to select device
        dropdownList.querySelectorAll(".dropdown-item").forEach(item => {
            item.addEventListener("click", (e) => {
                selectedDeviceIndex = parseInt(item.dataset.index);
                updateDeviceUI(currentDevices);
                closeDropdown();
            });
        });
    }
}

// Dropdown open/close
const dropdown = document.getElementById("deviceDropdown");

function toggleDropdown() {
    dropdown.classList.toggle("open");
    if (dropdown.classList.contains("open")) {
        scanDevices(); // refresh on open
    }
}

function closeDropdown() {
    dropdown.classList.remove("open");
}

document.getElementById("deviceSelector")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDropdown();
});

// Close dropdown when clicking anywhere else
document.addEventListener("click", (e) => {
    if (!e.target.closest(".device-selector-wrap")) {
        closeDropdown();
    }
});

// Close on Escape
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDropdown();
});

// Scan on launch, then every 3 seconds
scanDevices();
setInterval(scanDevices, 3000);

// ---- Focus editor on load ----
editor.focus();
