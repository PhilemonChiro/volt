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
import { voltAutocompletion } from "./volt-completions.js";
// ---- Custom hover tooltip (no CodeMirror API, no focus issues) ----
const hoverTip = document.getElementById("hoverTip");
let hoverTimer = null;

// Docs for hover
const HOVER_DOCS = {
    chip: "Declare the target microcontroller.\nSupported: esp32, esp8266, rp2040, stm32f103",
    hardware: "Define pin assignments and hardware peripherals.\nPins are validated against the chip's datasheet.",
    task: "Declare a concurrent task.\nAuto-classified: background (12 bytes),\npriority (FreeRTOS 4KB), or critical (ISR).",
    func: "Declare a function with parameters and return type.",
    machine: "Declare a state machine.\nCompiler verifies: reachability, dead states,\ndeterministic transitions.",
    struct: "Declare a custom data type with named fields.",
    main: "Program entry point.\nWiFi/MQTT setup and run() go here.",
    every: "Execute a block periodically.\nDuration: 100ms, 500ms, 1seconds, etc.",
    strict: "Hardware timer ISR — exact timing.\nCannot call WiFi, MQTT, log, or blocking functions.",
    state: "Declare a state with enter/exit actions and transitions.",
    initial: "Mark as the starting state of the machine.",
    enter: "Code executed when entering this state.",
    exit: "Code executed when leaving this state.",
    var: "Mutable variable — can be reassigned.",
    let: "Immutable variable — cannot be reassigned.",
    Output: "Digital output pin.\nMethods: on(), off(), toggle(), write()",
    Input: "Digital input pin.\nMethods: read() → 0 or 1",
    Analog: "Analog input (ADC).\nMethods: read() → 0-4095",
    PWM: "Pulse-width modulation output.\nMethods: set_pwm(0-255)",
    Touch: "Capacitive touch sensor. ESP32 only.",
    wifi: "WiFi module.\nconnect(ssid, pass), disconnect(), is_connected()",
    mqtt: "MQTT module.\nconnect(url), send_int(topic, val), is_connected()",
    storage: "Persistent storage (survives reboots).\nsave(), load(), push(), drain()",
    system: "System functions.\nrestart(), free_heap(), uptime()",
    run: "Start all declared tasks.",
    log: "Print a log message.\nUsage: log(tag, message)",
    esp32: "ESP32 WROOM-32 — Xtensa LX6 dual-core\n520KB RAM, 4MB flash, WiFi + BT",
    esp8266: "ESP8266 — Xtensa LX106 single-core\n80KB RAM, WiFi, no BT",
    rp2040: "RP2040 — ARM Cortex-M0+ dual-core\n264KB RAM, 2MB flash, no WiFi",
    stm32f103: "STM32F103 Blue Pill — ARM Cortex-M3\n20KB RAM, 64KB flash, no WiFi",
};

function editorMouseMove(e) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showHover(e), 400);
}

function editorMouseLeave() {
    clearTimeout(hoverTimer);
    hoverTip.classList.remove("visible");
}

function showHover(e) {
    const pos = editor.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos === null) { hoverTip.classList.remove("visible"); return; }

    const line = editor.state.doc.lineAt(pos);
    const lineText = line.text;
    let start = pos - line.from;
    let end = pos - line.from;

    while (start > 0 && /\w/.test(lineText[start - 1])) start--;
    while (end < lineText.length && /\w/.test(lineText[end])) end++;

    const word = lineText.slice(start, end);
    if (!word || word.length < 2) { hoverTip.classList.remove("visible"); return; }

    const doc = HOVER_DOCS[word];
    if (!doc) { hoverTip.classList.remove("visible"); return; }

    hoverTip.textContent = doc;

    // Position tooltip near cursor, always inside viewport
    const pad = 8;
    const toolbarBottom = 52;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Measure first
    hoverTip.style.left = "0px";
    hoverTip.style.top = "0px";
    hoverTip.classList.add("visible");
    const tw = hoverTip.offsetWidth;
    const th = hoverTip.offsetHeight;

    // X: to the right of cursor, clamp to edges
    let x = e.clientX + 12;
    if (x + tw > vw - pad) x = vw - tw - pad;
    if (x < pad) x = pad;

    // Y: always below cursor. If that goes off-screen, still below but clamped.
    let y = e.clientY + 20;
    if (y + th > vh - pad) y = vh - th - pad;
    if (y < toolbarBottom) y = toolbarBottom;

    hoverTip.style.left = x + "px";
    hoverTip.style.top = y + "px";
}

// Attach to editor container (after editor is created)
setTimeout(() => {
    const editorEl = document.querySelector(".cm-editor");
    if (editorEl) {
        editorEl.addEventListener("mousemove", editorMouseMove);
        editorEl.addEventListener("mouseleave", editorMouseLeave);
    }
}, 500);
import { voltLinter } from "./volt-diagnostics.js";

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

// ---- No default code — welcome screen shows instead ----
const DEFAULT_CODE = ``;

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
        voltAutocompletion,
        voltLinter,
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

        if (!currentProjectPath || !currentVoltFile) {
            appendMonitor("No file open — click Open or New first", "warn");
            statusBuild.textContent = "";
            return;
        }

        // Save current editor content before building
        try {
            const content = editor.state.doc.toString();
            await invoke("save_file", { path: currentVoltFile, content });
        } catch (e) {
            appendMonitor("Cannot save: " + e, "error");
        }

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
        // Read chip from connected device, or default to esp32
        let chip = "esp32";
        if (currentDevices.length > 0) {
            chip = currentDevices[selectedDeviceIndex].chip.toLowerCase();
            if (chip === "esp" || chip === "espressif") chip = "esp32";
        }
        const path = await invoke("create_project", { name, chip });
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

        // Switch to editor view
        showEditor();

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

// ---- Welcome screen ----
function showWelcome() {
    document.getElementById("welcomeScreen").style.display = "flex";
    document.getElementById("editorContainer").style.display = "none";
}

function showEditor() {
    document.getElementById("welcomeScreen").style.display = "none";
    document.getElementById("editorContainer").style.display = "block";
    editor.focus();
}

// Wire welcome buttons to same actions as toolbar
document.getElementById("welcomeNewBtn")?.addEventListener("click", () => {
    document.getElementById("newProjectBtn")?.click();
});
document.getElementById("welcomeOpenBtn")?.addEventListener("click", () => {
    document.getElementById("openProjectBtn")?.click();
});

// Load recent projects into welcome screen
async function loadWelcomeRecent() {
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const projects = await invoke("list_projects");
        const container = document.getElementById("welcomeRecent");
        if (projects.length === 0) {
            container.innerHTML = "";
            return;
        }
        container.innerHTML = '<div class="welcome-recent-title">Recent Projects</div>' +
            projects.slice(0, 5).map(p =>
                `<div class="welcome-recent-item" data-path="${p.path}">
                    ${p.name}
                    <span class="welcome-recent-chip">${p.chip.toUpperCase()}</span>
                </div>`
            ).join("");

        container.querySelectorAll(".welcome-recent-item").forEach(item => {
            item.addEventListener("click", () => loadProject(item.dataset.path));
        });
    } catch (e) {}
}
loadWelcomeRecent();

// Show welcome on launch
showWelcome();
