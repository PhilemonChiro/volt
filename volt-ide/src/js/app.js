/**
 * Volt IDE — uses globally loaded Monaco (AMD, not bundled)
 * Monaco is loaded via require() in index.html before this script runs.
 */

// Monaco is global via AMD loader
const monaco = window.monaco;

// ---- Register Volt language ----
monaco.languages.register({ id: "volt", extensions: [".volt"] });

monaco.languages.setMonarchTokensProvider("volt", {
    keywords: ["chip","hardware","task","func","machine","struct","main","state","initial","enter","exit","on","after","if","else","while","for","match","return","every","strict","let","var","pin","sensor","bus","run"],
    typeKeywords: ["int","float","bool","string","void","Output","Input","Analog","PWM","Touch"],
    builtins: ["wifi","mqtt","http","storage","system","ota","log","true","false"],
    tokenizer: {
        root: [
            [/\d+(?:ms|seconds|s)\b/, "number.duration"],
            [/0x[0-9a-fA-F]+/, "number.hex"],
            [/\d+\.\d+/, "number.float"],
            [/\d+/, "number"],
            [/"/, "string", "@string"],
            [/\/\/.*$/, "comment"],
            [/->/, "operator.arrow"],
            [/[a-zA-Z_]\w*/, { cases: { "@keywords": "keyword", "@typeKeywords": "type", "@builtins": "variable.predefined", "@default": "identifier" } }],
            [/[{}()\[\]]/, "@brackets"],
            [/[=!<>+\-*/%&|]+/, "operator"],
            [/[;,.:]+/, "delimiter"],
        ],
        string: [[/[^"\\]+/, "string"], [/"/, "string", "@pop"]],
    },
});

monaco.languages.setLanguageConfiguration("volt", {
    comments: { lineComment: "//" },
    brackets: [["{","}"],["[","]"],["(",")"]],
    autoClosingPairs: [{ open: "{", close: "}" },{ open: "[", close: "]" },{ open: "(", close: ")" },{ open: '"', close: '"' }],
});

// ---- Theme ----
monaco.editor.defineTheme("volt-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
        { token: "keyword", foreground: "c586c0" },
        { token: "type", foreground: "4ec9b0" },
        { token: "variable.predefined", foreground: "dcdcaa" },
        { token: "string", foreground: "ce9178" },
        { token: "number", foreground: "b5cea8" },
        { token: "number.duration", foreground: "ce9178", fontStyle: "bold" },
        { token: "comment", foreground: "6a9955" },
        { token: "operator.arrow", foreground: "569cd6", fontStyle: "bold" },
        { token: "identifier", foreground: "9cdcfe" },
    ],
    colors: {
        "editor.background": "#111318",
        "editor.foreground": "#d4d4d4",
        "editorCursor.foreground": "#ffffff",
        "editor.lineHighlightBackground": "#1a1d24",
        "editor.selectionBackground": "#264f7844",
        "editorLineNumber.foreground": "#454a55",
        "editorLineNumber.activeForeground": "#8a8f9a",
        "editorGutter.background": "#111318",
    },
});

// ---- Editor ----
const container = document.getElementById("editorContainer");
let editor = null;

function createEditor(content) {
    if (editor) { editor.setValue(content); return; }
    editor = monaco.editor.create(container, {
        value: content,
        language: "volt",
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

    editor.onDidChangeCursorPosition(function(e) {
        var el = document.getElementById("statusLine");
        if (el) el.textContent = "Ln " + e.position.lineNumber + ", Col " + e.position.column;
    });

    // Diagnostics after typing
    var diagTimer = null;
    editor.onDidChangeModelContent(function() {
        clearTimeout(diagTimer);
        diagTimer = setTimeout(runDiagnostics, 1500);
    });
}

// ---- Diagnostics ----
function runDiagnostics() {
    if (!editor) return;
    var model = editor.getModel();
    if (!model) return;
    var code = model.getValue();
    if (code.trim().length < 10) { monaco.editor.setModelMarkers(model, "volt", []); return; }

    // Call Tauri backend
    window.__TAURI__?.core?.invoke("check_code", { source: code }).then(function(result) {
        if (!Array.isArray(result)) return;
        var m = editor.getModel();
        if (!m) return;

        var markers = [];
        result.forEach(function(err) {
            var line = Math.max(err.line || 1, 1);
            var col = Math.max(err.col || 1, 1);
            var lm = err.message.match(/at line (\d+)/);
            if (lm && line <= 1) line = parseInt(lm[1]);
            var cm = err.message.match(/column (\d+)/);
            if (cm && col <= 1) col = parseInt(cm[1]);
            line = Math.min(line, m.getLineCount());
            var lineLen = m.getLineContent(line).length;

            markers.push({
                startLineNumber: line, startColumn: col,
                endLineNumber: line, endColumn: Math.min(col + 15, lineLen + 1),
                message: err.message,
                severity: err.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
            });
        });
        monaco.editor.setModelMarkers(m, "volt", markers);
        var badge = document.getElementById("problemCount");
        if (badge) { badge.textContent = markers.length; badge.style.display = markers.length > 0 ? "inline" : "none"; }
    }).catch(function() {});
}

// ---- Window controls ----
(function() {
    if (!window.__TAURI__) return;
    window.__TAURI__.window?.getCurrentWindow().then(function(win) {
        document.getElementById("winMinimize")?.addEventListener("click", function() { win.minimize(); });
        document.getElementById("winMaximize")?.addEventListener("click", function() { win.toggleMaximize(); });
        document.getElementById("winClose")?.addEventListener("click", function() { win.close(); });
        document.getElementById("toolbar")?.addEventListener("mousedown", function(e) {
            if (e.target.id === "toolbar" || e.target.classList.contains("brand-name") || e.target.classList.contains("toolbar-divider")) {
                win.startDragging();
            }
        });
    });
})();

// ---- Monitor ----
function appendMonitor(text, level) {
    var o = document.getElementById("monitorOutput");
    if (!o) return;
    var d = document.createElement("div");
    d.className = "log-" + (level || "info");
    var now = new Date();
    d.textContent = "[" + [now.getHours(),now.getMinutes(),now.getSeconds()].map(function(n){return String(n).padStart(2,"0")}).join(":") + "] " + text.replace(/\x1b\[[0-9;]*m/g, "");
    o.appendChild(d);
    o.scrollTop = o.scrollHeight;
}
document.getElementById("monitorClearBtn")?.addEventListener("click", function() { document.getElementById("monitorOutput").innerHTML = ""; });

// ---- Device detection ----
var currentDevices = [];
function scanDevices() {
    if (!window.__TAURI__) return;
    window.__TAURI__.core.invoke("scan_devices").then(function(devs) {
        currentDevices = devs;
        var label = document.getElementById("deviceLabel");
        var dot = document.getElementById("deviceDot");
        if (devs.length > 0) {
            if (label) label.textContent = devs[0].chip;
            if (dot) dot.className = "device-dot connected";
        } else {
            if (label) label.textContent = "No device";
            if (dot) dot.className = "device-dot";
        }
    }).catch(function() {});
}
scanDevices();
setInterval(scanDevices, 3000);

// ---- Tauri events ----
(function() {
    if (!window.__TAURI__) return;
    var listen = window.__TAURI__.event.listen;
    listen("serial:data", function(e) { appendMonitor(e.payload.line, "info"); });
    listen("serial:connected", function(e) { appendMonitor("Connected: " + e.payload, "info"); });
    listen("serial:disconnected", function(e) { appendMonitor("Disconnected", "warn"); });
    listen("serial:error", function(e) { appendMonitor(e.payload, "error"); });
    listen("run:progress", function(e) {
        var s = document.getElementById("statusBuild");
        if (e.payload.stage === "error") { if (s) s.textContent = "✗"; appendMonitor(e.payload.message, "error"); }
        else if (e.payload.stage === "done") { if (s) s.textContent = "✓ Done"; appendMonitor(e.payload.message, "info"); }
        else { if (s) s.textContent = e.payload.message; }
    });
    listen("run:output", function(e) { appendMonitor(e.payload, "debug"); });
})();

// ---- Project ----
var currentProjectPath = null;
var currentVoltFile = null;

function loadProject(folder) {
    if (!window.__TAURI__) return;
    window.__TAURI__.core.invoke("read_file", { path: folder + "/main.volt" }).then(function(content) {
        currentProjectPath = folder;
        currentVoltFile = folder + "/main.volt";
        document.getElementById("welcomeScreen").style.display = "none";
        container.style.display = "block";
        createEditor(content);
        document.title = folder.split("/").pop() + " — Volt IDE";
        appendMonitor("Opened: " + currentVoltFile, "info");
        setTimeout(runDiagnostics, 500);
    }).catch(function(e) { appendMonitor("Cannot open: " + e, "error"); });
}

// ---- Buttons ----
document.getElementById("runBtn")?.addEventListener("click", function() {
    if (!currentVoltFile || !window.__TAURI__ || currentDevices.length === 0) { appendMonitor("No file or device", "warn"); return; }
    window.__TAURI__.core.invoke("save_file", { path: currentVoltFile, content: editor.getValue() });
    window.__TAURI__.core.invoke("run_project", { projectPath: currentProjectPath, voltFile: currentVoltFile, port: currentDevices[0].port, chip: currentDevices[0].chip });
});

document.getElementById("monitorBtn")?.addEventListener("click", function() {
    if (!window.__TAURI__ || currentDevices.length === 0) return;
    window.__TAURI__.core.invoke("is_monitoring").then(function(m) {
        if (m) window.__TAURI__.core.invoke("stop_monitor");
        else window.__TAURI__.core.invoke("start_monitor", { port: currentDevices[0].port, baud: currentDevices[0].chip.includes("8266") ? 74880 : 115200 });
    });
});

document.getElementById("newProjectBtn")?.addEventListener("click", function() {
    var name = prompt("Project name:");
    if (!name || !window.__TAURI__) return;
    var chip = currentDevices.length > 0 ? currentDevices[0].chip.toLowerCase() : "esp32";
    if (chip === "esp" || chip === "espressif") chip = "esp32";
    window.__TAURI__.core.invoke("create_project", { name: name, chip: chip }).then(function(path) { if (path) loadProject(path); });
});

document.getElementById("openProjectBtn")?.addEventListener("click", function() {
    if (!window.__TAURI__) return;
    window.__TAURI__.core.invoke("browse_volt_file").then(function(result) { if (result) loadProject(result.folder); });
});

document.getElementById("welcomeNewBtn")?.addEventListener("click", function() { document.getElementById("newProjectBtn")?.click(); });
document.getElementById("welcomeOpenBtn")?.addEventListener("click", function() { document.getElementById("openProjectBtn")?.click(); });

// Load recent projects
(function() {
    if (!window.__TAURI__) return;
    window.__TAURI__.core.invoke("list_projects").then(function(projects) {
        var el = document.getElementById("welcomeRecent");
        if (!el || projects.length === 0) return;
        el.innerHTML = '<div class="welcome-recent-title">Recent Projects</div>' +
            projects.slice(0, 5).map(function(p) {
                return '<div class="welcome-recent-item" data-path="' + p.path + '">' + p.name + '<span class="welcome-recent-chip">' + p.chip.toUpperCase() + '</span></div>';
            }).join("");
        el.querySelectorAll(".welcome-recent-item").forEach(function(item) {
            item.addEventListener("click", function() { loadProject(item.dataset.path); });
        });
    });
})();
