// Persistent rotating log for Volt IDE.
//
// Writes timestamped lines to:
//   macOS:  ~/Library/Logs/Volt IDE/main.log
//   Linux:  ~/.config/volt-ide/logs/main.log
//   Windows: %APPDATA%/volt-ide/logs/main.log
// (resolved via app.getPath('logs'))
//
// Rotation: when the active file exceeds MAX_BYTES it rotates to .1,
// older .1 → .2, etc., dropping anything past MAX_FILES. Total disk
// ceiling is MAX_BYTES × (MAX_FILES + 1).
//
// Sources that flow into it:
//   1. Main process console.{log,info,warn,error} — wrapped on init().
//   2. Renderer logs via ipc 'log_write'.
//   3. Python worker stderr — piped in main.js where the worker is spawned.

const fs   = require("fs");
const path = require("path");
const { app, ipcMain } = require("electron");

const MAX_BYTES = 2 * 1024 * 1024;   // 2 MB per file
const MAX_FILES = 3;                 // keep .log + .log.1 + .log.2 + .log.3

let logFile = null;
let stream  = null;
let bytesWritten = 0;

function ensureStream() {
    if (stream) return stream;
    const dir = app.getPath("logs");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    logFile = path.join(dir, "main.log");
    try {
        const st = fs.statSync(logFile);
        bytesWritten = st.size;
    } catch (_) { bytesWritten = 0; }
    stream = fs.createWriteStream(logFile, { flags: "a" });
    return stream;
}

function rotate() {
    if (!logFile) return;
    try { stream.end(); } catch (_) {}
    stream = null;
    // Roll: main.log.<n-1> → main.log.<n>, oldest dropped
    for (let i = MAX_FILES; i > 0; i--) {
        const src = i === 1 ? logFile : `${logFile}.${i - 1}`;
        const dst = `${logFile}.${i}`;
        try { fs.renameSync(src, dst); } catch (_) {}
    }
    bytesWritten = 0;
}

function log(level, source, message) {
    if (!stream) ensureStream();
    const line = `${new Date().toISOString()} [${level}] [${source}] ${message}\n`;
    const bytes = Buffer.byteLength(line, "utf-8");
    if (bytesWritten + bytes > MAX_BYTES) rotate();
    if (!stream) ensureStream();
    stream.write(line);
    bytesWritten += bytes;
}

function logMulti(level, source, parts) {
    log(level, source, parts.map(p => typeof p === "string" ? p : safeStringify(p)).join(" "));
}

function safeStringify(v) {
    try {
        if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? "\n" + v.stack : ""}`;
        return JSON.stringify(v);
    } catch (_) { return String(v); }
}

let _consolePatched = false;
function patchConsole() {
    if (_consolePatched) return;
    _consolePatched = true;
    for (const level of ["log", "info", "warn", "error"]) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
            try { logMulti(level === "log" ? "info" : level, "main", args); } catch (_) {}
            orig(...args);
        };
    }
}

function init() {
    ensureStream();
    patchConsole();
    log("info", "main", `Volt IDE ${app.getVersion()} starting (${process.platform}/${process.arch})`);
    // Renderer → main IPC channel for log lines
    ipcMain.on("log_write", (_e, level, source, message) => {
        try { log(level || "info", source || "renderer", String(message)); } catch (_) {}
    });
    // Surface uncaught errors in the log too
    process.on("uncaughtException", (e) => log("error", "main", `uncaughtException: ${e?.stack || e}`));
    process.on("unhandledRejection", (e) => log("error", "main", `unhandledRejection: ${e?.stack || e}`));
}

function pipeChild(name, child) {
    if (!child) return;
    if (child.stdout) child.stdout.on("data", b => log("info",  name, b.toString().trimEnd()));
    if (child.stderr) child.stderr.on("data", b => log("error", name, b.toString().trimEnd()));
    child.on("exit", (code) => log("info", name, `exited with code ${code}`));
}

function getPath() { ensureStream(); return logFile; }

module.exports = { init, log, logMulti, pipeChild, getPath };
