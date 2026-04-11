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

// ---- Toolbar buttons (Phase 1: visual feedback) ----
document.getElementById("runBtn").addEventListener("click", () => {
    const status = document.getElementById("statusBuild");
    const btn = document.getElementById("runBtn");
    btn.textContent = ""; // will add spinner later
    btn.innerHTML = '<svg class="toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Running...';
    status.textContent = "Building...";
    // Phase 3: will call volt build → flash → monitor
    setTimeout(() => {
        status.textContent = "Flashing...";
    }, 800);
    setTimeout(() => {
        status.textContent = "✓ Running";
        btn.innerHTML = '<svg class="toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run';
    }, 1500);
});

document.getElementById("monitorBtn").addEventListener("click", () => {
    const dot = document.querySelector("#monitorDot") || document.querySelector(".panel-dot");
    if (dot) {
        dot.classList.toggle("live");
    }
});

document.getElementById("monitorClearBtn").addEventListener("click", () => {
    document.getElementById("monitorOutput").textContent = "";
});

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
