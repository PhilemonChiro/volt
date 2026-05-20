const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

app.commandLine.appendSwitch("no-sandbox");

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), "Volt");
const RECENTS_FILE = path.join(os.homedir(), ".volt", "recent-projects.json");

// Resolves the current projects directory from settings (or falls back).
function projectsDir() {
    try {
        const fromSettings = require("./src/main/settings.js").get("projects.projectsDir");
        if (fromSettings && fromSettings.trim()) return fromSettings;
    } catch (_) {}
    return DEFAULT_PROJECTS_DIR;
}
let win = null;

// ---- Recent projects (cross-platform, any directory) ----
function loadRecents() {
    try {
        if (fs.existsSync(RECENTS_FILE)) {
            return JSON.parse(fs.readFileSync(RECENTS_FILE, "utf-8"));
        }
    } catch (_) {}
    return [];
}

function saveRecent(projectPath) {
    const recents = loadRecents();
    // Remove if already exists (will re-add at top)
    const filtered = recents.filter(r => r.path !== projectPath);
    // Read chip from volt.toml
    let chip = "esp32";
    const toml = path.join(projectPath, "volt.toml");
    if (fs.existsSync(toml)) {
        const m = fs.readFileSync(toml, "utf-8").match(/chip\s*=\s*"([^"]+)"/);
        if (m) chip = m[1];
    }
    filtered.unshift({
        path: projectPath,
        name: path.basename(projectPath),
        chip,
        opened: Date.now(),
    });
    // Cap by the user's "recent projects to remember" setting
    const max = Math.max(1, Number(settings.get("projects.recentMax")) || 20);
    const trimmed = filtered.slice(0, max);
    fs.mkdirSync(path.dirname(RECENTS_FILE), { recursive: true });
    fs.writeFileSync(RECENTS_FILE, JSON.stringify(trimmed, null, 2));
}

// On macOS, the bundled Python interpreter inherits the quarantine xattr
// from the .dmg download. Even after the user "approves" the .app via
// Gatekeeper, individual binaries inside can still be killed when spawned.
// Self-heal at startup: recursively clear quarantine from our resources.
// Idempotent — does nothing if already cleared.
function clearMacOSQuarantine() {
    if (process.platform !== "darwin" || !process.resourcesPath) return;
    const { execFile } = require("child_process");
    const target = path.join(process.resourcesPath, "sdk");
    if (!fs.existsSync(target)) return;
    execFile("xattr", ["-rd", "com.apple.quarantine", target], (err) => {
        if (err) {
            // Not fatal — first launch this may fail if files weren't tagged.
            console.warn("[startup] xattr clear (non-fatal):", err.message);
        }
    });
}

app.whenReady().then(() => {
    clearMacOSQuarantine();

    win = new BrowserWindow({
        width: 1280,
        height: 800,
        title: "Volt IDE",
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadFile("index.html");

    if (process.argv.includes("--dev")) {
        win.webContents.openDevTools();
    }
});

app.on("window-all-closed", () => app.quit());

// ============================================================
// Window controls
// ============================================================
ipcMain.handle("win_minimize", () => win?.minimize());
ipcMain.handle("win_maximize", () => {
    if (win?.isMaximized()) win.unmaximize();
    else win?.maximize();
});
ipcMain.handle("win_close", () => win?.close());

// ============================================================
// Projects
// ============================================================
ipcMain.handle("create_project", (_, name, chip) => {
    // Validate project name — no path traversal, no shell-breaking chars
    if (!name || !/^[a-zA-Z0-9_\- ]+$/.test(name)) {
        throw new Error("Invalid project name — use letters, numbers, dashes, underscores only");
    }
    const root = projectsDir();
    fs.mkdirSync(root, { recursive: true });
    const dir = path.join(root, name);
    if (!dir.startsWith(root)) throw new Error("Invalid project name");
    if (fs.existsSync(dir)) throw new Error(`Project '${name}' already exists`);

    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "build"), { recursive: true });

    const led = chip === "rp2040" ? "GP25" : chip === "stm32f103" ? "PC13" : "2";
    fs.writeFileSync(path.join(dir, "main.volt"),
        `hardware {\n    pin led = ${led}\n}\n\nevery 500ms {\n    led.toggle()\n}\n`);
    fs.writeFileSync(path.join(dir, "volt.toml"),
        `[project]\nname = "${name}"\nchip = "${chip}"\n`);
    fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n.volt/\n");

    return dir;
});

ipcMain.handle("list_projects", () => {
    const seen = new Set();
    const results = [];

    // 1. Scan the configured projects directory (default ~/Volt)
    const root = projectsDir();
    if (fs.existsSync(root)) {
        for (const d of fs.readdirSync(root)) {
            const dir = path.join(root, d);
            if (!fs.existsSync(path.join(dir, "main.volt"))) continue;
            let chip = "esp32";
            const toml = path.join(dir, "volt.toml");
            if (fs.existsSync(toml)) {
                const m = fs.readFileSync(toml, "utf-8").match(/chip\s*=\s*"([^"]+)"/);
                if (m) chip = m[1];
            }
            seen.add(dir);
            results.push({ name: d, path: dir, chip, modified: fs.statSync(dir).mtimeMs / 1000 });
        }
    }

    // 2. Merge recent projects from any directory
    for (const r of loadRecents()) {
        if (seen.has(r.path)) continue;
        // Verify project still exists
        if (!fs.existsSync(path.join(r.path, "main.volt"))) continue;
        seen.add(r.path);
        let modified = r.opened / 1000;
        try { modified = fs.statSync(r.path).mtimeMs / 1000; } catch (_) {}
        results.push({ name: r.name, path: r.path, chip: r.chip, modified });
    }

    return results.sort((a, b) => b.modified - a.modified);
});

ipcMain.handle("save_recent", (_, projectPath) => {
    saveRecent(projectPath);
});

// Allowed file extensions for read/write — prevents arbitrary file access
// while allowing projects stored anywhere on disk (cross-platform)
const SAFE_EXTENSIONS = new Set([".volt", ".toml", ".gitignore", ".json", ".txt", ".c", ".h"]);

ipcMain.handle("file_exists", (_, filePath) => fs.existsSync(filePath));

ipcMain.handle("create_toml", (_, projectPath, chip) => {
    const toml = path.join(projectPath, "volt.toml");
    const name = path.basename(projectPath);
    fs.writeFileSync(toml, `[project]\nname = "${name}"\nchip = "${chip}"\n`);
    return toml;
});

ipcMain.handle("read_file", (_, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!SAFE_EXTENSIONS.has(ext)) throw new Error("Access denied: " + filePath);
    return fs.readFileSync(filePath, "utf-8");
});

ipcMain.handle("save_file", (_, filePath, content) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!SAFE_EXTENSIONS.has(ext)) throw new Error("Access denied: " + filePath);
    fs.writeFileSync(filePath, content);
});

ipcMain.handle("browse_volt_file", async () => {
    const result = await dialog.showOpenDialog(win, {
        title: "Open Volt File",
        filters: [
            { name: "Volt Source (*.volt)", extensions: ["volt"] },
            { name: "All Files", extensions: ["*"] },
        ],
        properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const fp = result.filePaths[0];
    return { path: fp, folder: path.dirname(fp), content: fs.readFileSync(fp, "utf-8") };
});

ipcMain.handle("browse_folder", async () => {
    const result = await dialog.showOpenDialog(win, {
        title: "Open Volt Project",
        filters: [
            { name: "Volt Source (*.volt)", extensions: ["volt"] },
            { name: "All Files", extensions: ["*"] },
        ],
        properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return path.dirname(result.filePaths[0]);
});

// ============================================================
// Compiler — long-lived Python worker process (JSON-line IPC over stdin/stdout)
// ============================================================
const { execSync, spawn } = require("child_process");
const readline = require("readline");
const settings = require("./src/main/settings.js");

// ============================================================
// Settings IPC
// ============================================================
ipcMain.handle("settings_schema", () => settings.SCHEMA);
ipcMain.handle("settings_all",    () => settings.all());
ipcMain.handle("settings_set", (_, key, value) => {
    const updated = settings.set(key, value);
    if (win) win.webContents.send("settings:changed", { key, value: updated });
    return updated;
});
ipcMain.handle("settings_reset", () => {
    const fresh = settings.reset();
    if (win) win.webContents.send("settings:changed", { key: "*", value: fresh });
    return fresh;
});
ipcMain.handle("settings_open_file", () => {
    const { shell } = require("electron");
    const file = settings.file();
    // Make sure the file exists before opening it
    if (!fs.existsSync(file)) settings.save();
    shell.openPath(file);
    return file;
});

// ============================================================
// Device library — reads the JSON catalog in <repo>/devices/*/*.json
// (devicesDir() defined above, near getVoltSrc())
// ============================================================
ipcMain.handle("devices_list", () => {
    const root = devicesDir();
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const entry of fs.readdirSync(root)) {
        const dir = path.join(root, entry);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith(".json")) continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
                out.push(data);
            } catch (_) {}
        }
    }
    return out;
});

// Read a device driver's C source (read-only viewer). chip is the target
// platform ("esp32" / "rp2040" / etc.), sourceFile is the c_source field
// from the device JSON (e.g. "sensor_bme280.c").
ipcMain.handle("device_source", (_, chip, sourceFile) => {
    if (!sourceFile || !/^[a-zA-Z0-9_.-]+\.c$/.test(sourceFile)) {
        throw new Error("Invalid device source filename");
    }
    const c = (chip || "esp32").toLowerCase();
    const platform = c.includes("rp2040") || c.includes("pico") ? "rp2040" : "esp32";
    const candidates = [
        // dev mode
        path.join(__dirname, "..", "framework", platform, "src", sourceFile),
        // packaged app
        ...(process.resourcesPath
            ? [path.join(process.resourcesPath, "sdk", "framework", platform, "src", sourceFile)]
            : []),
        // installed SDK
        path.join(os.homedir(), ".volt", "sdk", "framework", platform, "src", sourceFile),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return { path: candidate, content: fs.readFileSync(candidate, "utf-8") };
        }
    }
    throw new Error(`Source not found: ${sourceFile} (looked in framework/${platform}/src)`);
});

function getVoltSrc() {
    // 1. Dev mode — repo layout (volt-ide/../src/volt/...)
    const dev = path.join(__dirname, "..", "src");
    if (fs.existsSync(path.join(dev, "volt", "compiler", "voltc.py"))) return dev;
    // 2. Packaged app — bundled SDK lives under process.resourcesPath
    if (process.resourcesPath) {
        const bundled = path.join(process.resourcesPath, "sdk", "src");
        if (fs.existsSync(path.join(bundled, "volt", "compiler", "voltc.py"))) return bundled;
    }
    // 3. User-installed SDK
    return path.join(os.homedir(), ".volt", "sdk", "src");
}

function devicesDir() {
    // dev → repo/devices, packaged → resources/sdk/devices, installed → ~/.volt/sdk/devices
    const dev = path.join(__dirname, "..", "devices");
    if (fs.existsSync(dev)) return dev;
    if (process.resourcesPath) {
        const bundled = path.join(process.resourcesPath, "sdk", "devices");
        if (fs.existsSync(bundled)) return bundled;
    }
    return path.join(os.homedir(), ".volt", "sdk", "devices");
}

const VOLT_SRC = getVoltSrc();

let worker = null;
let workerStart = null;
const pending = new Map();   // id → { resolve, reject, timer, onProgress? }
let reqCounter = 0;

function startWorker() {
    if (workerStart) return workerStart;

    workerStart = new Promise((resolve, reject) => {
        // When packaged, __dirname is inside app.asar but worker.py is
        // extracted to app.asar.unpacked (asarUnpack in package.json). In
        // dev mode this replace is a no-op since __dirname has no "app.asar".
        const script = path.join(__dirname, "scripts", "worker.py")
            .replace(/app\.asar(?![\/\\]?unpacked)/, "app.asar.unpacked");
        // On macOS the IDE may be launched from Finder without a shell PATH,
        // so /usr/local/bin (Homebrew) and similar aren't visible. Search a
        // few common Python locations directly, falling back to "python3".
        const pythonBin = findPython();

        let started = false;
        let stderrBuf = "";

        try {
            worker = spawn(pythonBin, [script, VOLT_SRC], {
                stdio: ["pipe", "pipe", "pipe"],
            });
        } catch (e) {
            reject(new Error(`Failed to spawn ${pythonBin}: ${e.message}`));
            return;
        }

        const rl = readline.createInterface({ input: worker.stdout });
        rl.on("line", (line) => {
            let msg;
            try { msg = JSON.parse(line); } catch { return; }
            if (msg.id === "_ready") { started = true; resolve(); return; }
            const p = pending.get(msg.id);
            if (!p) return;
            // Intermediate progress event — relay to caller, keep waiting.
            if (msg.progress) {
                if (p.onProgress) p.onProgress(msg.progress);
                return;
            }
            pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) p.resolve(msg.result);
            else p.reject(new Error(msg.error || "worker error"));
        });

        worker.stderr.on("data", (chunk) => {
            const s = chunk.toString();
            stderrBuf += s;
            // Cap so we don't grow forever during a long session
            if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
            const trimmed = s.trim();
            if (trimmed) console.warn("[worker]", trimmed);
        });

        worker.on("exit", (code, signal) => {
            // If the worker died BEFORE signalling _ready, reject the start
            // promise with the captured stderr so the user sees the real
            // cause (Python missing, lark missing, import error, etc.).
            if (!started) {
                const reason = stderrBuf.trim().slice(0, 600) || `exit code ${code}, signal ${signal}`;
                const hint = diagnoseWorkerFailure(pythonBin, reason);
                reject(new Error(hint));
            }
            console.warn(`[worker] exited code=${code} signal=${signal}; will respawn on next request`);
            for (const [, p] of pending) {
                clearTimeout(p.timer);
                p.reject(new Error("worker died: " + (stderrBuf.trim().slice(-300) || "unknown")));
            }
            pending.clear();
            worker = null;
            workerStart = null;
        });

        worker.on("error", (err) => {
            console.error("[worker] spawn error:", err);
            const hint = err.code === "ENOENT"
                ? `Python 3 not found. Install from python.org or 'brew install python@3.12', then 'pip3 install lark'.`
                : err.message;
            reject(new Error(hint));
        });
    });

    return workerStart;
}

// Locate a usable python3 binary. Priority order:
//
//   1. Bundled python-build-standalone shipped inside the packaged app
//      (sdk/python/<platform>/) — preferred so the IDE works without any
//      system Python install. Also used in dev mode if you ran
//      `npm run bundle:python` locally.
//   2. Common system install locations (Homebrew x86/arm, python.org,
//      /usr/bin, etc.). On macOS apps launched from Finder, $PATH doesn't
//      include /usr/local/bin or /opt/homebrew/bin so we check them
//      directly.
//   3. Bare "python3" — let spawn's ENOENT fire if not on PATH.
function findPython() {
    const platKey = `${process.platform}-${process.arch}`;
    const bundledBin = process.platform === "win32" ? "python.exe" : "bin/python3";

    // (1) Bundled Python — check packaged-resources, then the dev sdk/ dir.
    const bundledRoots = [
        ...(process.resourcesPath
            ? [path.join(process.resourcesPath, "sdk", "python", platKey)]
            : []),
        path.join(__dirname, "sdk", "python", platKey),
    ];
    for (const root of bundledRoots) {
        const candidate = path.join(root, bundledBin);
        if (fs.existsSync(candidate)) return candidate;
    }

    // (2) System Python
    const candidates = process.platform === "win32"
        ? [
            "python",
            "python3",
            "C:\\Python312\\python.exe",
            "C:\\Python311\\python.exe",
            path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "python.exe"),
        ]
        : [
            "python3",
            "/usr/local/bin/python3",
            "/opt/homebrew/bin/python3",
            "/usr/bin/python3",
            "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
        ];
    for (const p of candidates) {
        if (p.startsWith("/") || /^[A-Z]:\\/.test(p)) {
            if (fs.existsSync(p)) return p;
        }
    }

    // (3) Fall back to bare name — spawn will surface ENOENT if missing.
    return process.platform === "win32" ? "python" : "python3";
}

// Turn the raw stderr of a failed worker into a one-paragraph user-facing
// hint that points at the actual fix.
function diagnoseWorkerFailure(pythonBin, stderr) {
    if (!stderr) return `Python worker exited before sending ready signal (using ${pythonBin}).`;
    if (/No module named ['"]?lark/.test(stderr)) {
        return `Python is installed but the 'lark' library is missing. Run:\n    pip3 install lark\nthen restart Volt IDE.`;
    }
    if (/No module named ['"]?volt/.test(stderr)) {
        return `Volt SDK not bundled correctly — the IDE can't find its compiler.\nstderr: ${stderr}`;
    }
    if (/ModuleNotFoundError/.test(stderr)) {
        const mod = (stderr.match(/No module named ['"]?(\w+)/) || [])[1] || "?";
        return `Missing Python module: ${mod}. Run:\n    pip3 install ${mod}\nthen restart Volt IDE.`;
    }
    return `Python worker failed to start:\n${stderr}`;
}

function workerCall(op, payload, timeoutMs = 10000, onProgress = null) {
    if (!worker || !workerStart) {
        return startWorker().then(() => workerCall(op, payload, timeoutMs, onProgress));
    }
    return workerStart.then(() => new Promise((resolve, reject) => {
        const id = String(++reqCounter);
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("worker timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, onProgress });
        // Ask the worker to stream phase progress if we have a listener
        const req = onProgress ? { id, op, emit_progress: true, ...payload }
                               : { id, op, ...payload };
        try {
            worker.stdin.write(JSON.stringify(req) + "\n");
        } catch (e) {
            pending.delete(id);
            clearTimeout(timer);
            reject(e);
        }
    }));
}

const EMPTY_COMPILE_RESULT = {
    diagnostics: [], c_code: "", pins: [], devices: [], buses: [],
    tasks: [], machines: [], channels: [], enums: [], chip: "",
};

function compileErrorResult(message) {
    // Preserve the full message (including multi-line install instructions
    // from diagnoseWorkerFailure) rather than truncating it to 200 chars.
    return {
        ...EMPTY_COMPILE_RESULT,
        diagnostics: [{
            line: 1, col: 1,
            message: "Compiler error: " + (message || "").slice(0, 1000),
            severity: "error", hint: "",
        }],
    };
}

// Eagerly start the worker — first compile then doesn't pay the import cost
app.whenReady().then(() => {
    startWorker().catch((e) => console.error("[worker] startup failed:", e));
});

app.on("before-quit", () => {
    if (worker) try { worker.kill(); } catch (_) {}
});

ipcMain.handle("compile_full", async (_, source) => {
    try {
        return await workerCall("compile_full", { source, filename: "main.volt" });
    } catch (e) {
        return compileErrorResult(e.message);
    }
});

ipcMain.handle("check_code", async (_, source) => {
    try {
        const result = await workerCall("compile_full", { source, filename: "main.volt" });
        return result.diagnostics;
    } catch (e) {
        return [{
            line: 1, col: 1,
            message: "Compiler error: " + (e.message || "").substring(0, 200),
            severity: "error", hint: "",
        }];
    }
});

ipcMain.handle("format_code", async (_, source) => {
    try {
        return await workerCall("format_code", { source }, 5000);
    } catch (_) {
        return null;  // format failed — IDE keeps original
    }
});

ipcMain.handle("find_symbols", async (_, source) => {
    try {
        return await workerCall("find_symbols", { source }, 5000);
    } catch (_) {
        return [];
    }
});

// ============================================================
// Serial — device detection + monitor
// ============================================================
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

let activePort = null;
let monitoring = false;

function detectChip(portInfo) {
    const vid = (portInfo.vendorId || "").toLowerCase();
    const pid = (portInfo.productId || "").toLowerCase();
    const mfr = (portInfo.manufacturer || "").toLowerCase();
    const pnp = (portInfo.pnpId || "").toLowerCase();

    // ESP32 — Silicon Labs CP2102/CP2104, QinHeng CH340, Espressif native USB
    if (vid === "303a") return "ESP32-S3";
    if (vid === "10c4" && pid === "ea60") return "ESP32";
    if (vid === "1a86" && pid === "7523") return "ESP32";
    if (vid === "1a86" && pid === "55d4") return "ESP32-S2";

    // RP2040 — Raspberry Pi
    if (vid === "2e8a") return "RP2040";

    // STM32 — ST-Link
    if (vid === "0483") return "STM32";

    // ESP8266 — CH340/CP2102 (same as ESP32, differentiate by manufacturer)
    if (mfr.includes("espressif")) return "ESP32";
    if (mfr.includes("raspberry")) return "RP2040";
    if (mfr.includes("stm") || mfr.includes("st-link")) return "STM32";

    // Fallback: check pnpId patterns
    if (pnp.includes("cp210x") || pnp.includes("ch341")) return "ESP32";
    if (pnp.includes("pico")) return "RP2040";

    return "Unknown";
}

ipcMain.handle("scan_devices", async () => {
    try {
        const ports = await SerialPort.list();
        return ports
            .filter(p => {
                if (!p.vendorId) return false;
                // Skip Intel motherboard serial (8086)
                if (p.vendorId.toLowerCase() === "8086") return false;
                // Skip /dev/ttyS* without a real manufacturer
                if (/\/dev\/ttyS\d+$/.test(p.path) && !p.manufacturer) return false;
                return true;
            })
            .map(p => ({
                port: p.path,
                chip: detectChip(p),
                desc: p.manufacturer || p.serialNumber || p.path,
                vendorId: p.vendorId || "",
                productId: p.productId || "",
            }));
    } catch (e) {
        return [];
    }
});

ipcMain.handle("start_monitor", (_, port, baud) => {
    // Stop existing
    if (activePort && activePort.isOpen) {
        try { activePort.close(); } catch (_) {}
    }
    try {
        const fallbackBaud = settings.get("serial.defaultBaud") || 115200;
        activePort = new SerialPort({ path: port, baudRate: baud || fallbackBaud });
        const parser = activePort.pipe(new ReadlineParser());
        parser.on("data", (line) => {
            if (win) win.webContents.send("serial:data", { line });
        });
        activePort.on("error", () => {
            monitoring = false;
            if (win) win.webContents.send("serial:error", "Connection lost");
        });
        activePort.on("close", () => {
            monitoring = false;
            if (win) win.webContents.send("serial:disconnected", port);
        });
        monitoring = true;
        if (win) win.webContents.send("serial:connected", port);
    } catch (e) {
        monitoring = false;
    }
});

ipcMain.handle("stop_monitor", () => {
    if (activePort && activePort.isOpen) {
        try { activePort.close(); } catch (_) {}
    }
    activePort = null;
    monitoring = false;
});

ipcMain.handle("is_monitoring", () => monitoring);

// ============================================================
// Toolchain + Build
// ============================================================
const toolchain = require("./src/main/toolchain");

ipcMain.handle("check_toolchain", (_, chip) => toolchain.isToolchainReady(chip));

ipcMain.handle("setup_toolchain", async (_, chip) => {
    const logs = [];
    // toolchain.ensureToolchain accepts either a log(msg) fn or an emit-shaped
    // object. We pass log; the toolchain module wraps it into an emit
    // internally and threads __STAGE__: markers through it. Here we parse
    // those markers back out into structured "toolchain:event" IPC events.
    const log = (msg) => {
        const s = String(msg ?? "");
        // Stage marker — forward as structured event, do NOT include in logs
        const marker = s.match(/^__STAGE__:([^:]+):([a-z]+)(?::(.*))?$/);
        if (marker) {
            const [, id, action, rest] = marker;
            if (action === "start") {
                if (win) win.webContents.send("toolchain:event", { type: "stage_start", id });
            } else if (action === "done") {
                if (win) win.webContents.send("toolchain:event", { type: "stage_done", id });
            } else if (action === "error") {
                if (win) win.webContents.send("toolchain:event", { type: "stage_error", id, message: rest || "" });
            } else if (action === "progress") {
                // rest is "percent:detail"
                const idx = (rest || "").indexOf(":");
                const percent = Number(idx < 0 ? rest : rest.slice(0, idx));
                const detail = idx < 0 ? "" : rest.slice(idx + 1);
                if (win) win.webContents.send("toolchain:event", { type: "stage_progress", id, percent, detail });
            }
            return;
        }
        // Plain log line — keep + forward to both channels (legacy log + new event)
        logs.push(s);
        if (win) {
            win.webContents.send("toolchain:log", s);
            win.webContents.send("toolchain:event", { type: "log", message: s });
        }
    };

    let ok = false;
    try {
        ok = toolchain.ensureToolchain(chip, log);
    } catch (e) {
        if (win) win.webContents.send("toolchain:event", {
            type: "stage_error",
            id: "exception",
            message: e.message || String(e),
        });
    }

    // Final structured signal so the dialog flips to its done/failed state
    if (win) win.webContents.send("toolchain:event", { type: "complete", success: !!ok });

    return { ok, logs };
});

// Renderer-driven "cancel the in-flight install" — soft cancel for now.
// Sets a flag the long-running operations check at safe boundaries.
ipcMain.handle("cancel_toolchain", () => {
    toolchain.cancel?.();
});

const builder = require("./src/main/builder");

// Shared emit function for build progress
function buildEmit(stage, message, pct) {
    if (win) win.webContents.send("build:progress", { stage, message, percent: pct || 0 });
}

// Shared compile step (async — goes through the warm worker)
// The compile stage owns 0-25% of the total build progress, so we map
// the worker's per-phase 5-100% range into that slice via mapPct().
const COMPILE_PCT_END = 25;
const PHASE_LABELS = {
    include:   "Resolving includes",
    parse:     "Parsing",
    resolve:   "Resolving names",
    check:     "Type checking",
    hardware:  "Validating hardware",
    analyze:   "Analyzing tasks",
    transform: "Transforming",
    codegen:   "Generating C",
};

async function compileStep(projectPath, voltFile) {
    const buildDir = path.join(projectPath, "build");
    fs.mkdirSync(buildDir, { recursive: true });

    buildEmit("compile", "Compiling...", 1);
    const source = fs.readFileSync(voltFile, "utf-8");

    const onProgress = ({ phase, pct }) => {
        const label = PHASE_LABELS[phase] || phase;
        const mapped = Math.round((pct / 100) * COMPILE_PCT_END);
        buildEmit("compile", label, mapped);
    };

    // Pass the real voltFile path so #line directives reference the user's
    // source and compile_volt's volt.toml lookup picks up the project's chip.
    let result;
    try {
        result = await workerCall(
            "compile_full",
            { source, filename: voltFile },
            15000,
            onProgress,
        );
    } catch (e) {
        buildEmit("error", "Compile failed: " + (e.message || "worker error"));
        return null;
    }

    if (!result.c_code) {
        const errMsg = (result.diagnostics || [])
            .filter(d => d.severity === "error")
            .map(d => d.message)
            .join("; ");
        buildEmit("error", "Compile failed: " + (errMsg || "unknown error"));
        return null;
    }

    fs.writeFileSync(path.join(buildDir, "main.c"), result.c_code);
    buildEmit("compile", "Compiled successfully", 25);
    return result;
}

ipcMain.handle("build_only", async (_, projectPath, voltFile, chip) => {
    const result = await compileStep(projectPath, voltFile);
    if (!result) return { ok: false };

    const c = chip.toLowerCase();
    let ok = false;
    if (c.includes("rp2040") || c.includes("pico")) {
        ok = await builder.buildRP2040(projectPath, buildEmit);
    } else {
        ok = await builder.buildESP32(projectPath, c, buildEmit);
    }
    if (!ok) return { ok: false };

    buildEmit("done", "Build successful", 100);
    return { ok: true };
});

ipcMain.handle("run_project", async (_, projectPath, voltFile, port, chip) => {
    const result = await compileStep(projectPath, voltFile);
    if (!result) return { ok: false };

    const c = chip.toLowerCase();

    // Build
    let ok = false;
    if (c.includes("rp2040") || c.includes("pico")) {
        ok = await builder.buildRP2040(projectPath, buildEmit);
    } else {
        ok = await builder.buildESP32(projectPath, c, buildEmit);
    }
    if (!ok) return { ok: false };

    // Honor "auto-flash" setting — if off, stop after build (no flash, no monitor)
    if (settings.get("build.autoFlash") === false) {
        buildEmit("done", "Build successful — auto-flash disabled", 100);
        return { ok: true, port: null };
    }

    // Release serial port before flashing — esptool needs exclusive access
    const wasMonitoring = monitoring;
    if (activePort && activePort.isOpen) {
        try { activePort.close(); } catch (_) {}
        activePort = null;
        monitoring = false;
        if (win) win.webContents.send("serial:disconnected", port);
        // Wait for OS to fully release the serial device fd
        await new Promise(r => setTimeout(r, 500));
    }

    // Flash
    if (c.includes("rp2040") || c.includes("pico")) {
        ok = await builder.flashRP2040(projectPath, port, buildEmit);
    } else {
        ok = await builder.flashESP32(projectPath, port, c, buildEmit);
    }
    if (!ok) return { ok: false };

    // Wait for device
    buildEmit("connect", "Waiting for device...", 96);
    const prefix = port.includes("ttyACM") ? "ttyACM" : "ttyUSB";
    const newPort = builder.waitForPort(prefix, 8000);
    buildEmit("connect", newPort ? "Device on " + newPort : "Reconnect manually", 98);

    // Auto-start serial monitor
    if (newPort) {
        const baud = c.includes("8266") ? 74880 : 115200;
        // Stop existing monitor, start new one
        if (activePort && activePort.isOpen) try { activePort.close(); } catch (_) {}
        try {
            activePort = new SerialPort({ path: newPort, baudRate: baud });
            const parser = activePort.pipe(new ReadlineParser());
            parser.on("data", (line) => { if (win) win.webContents.send("serial:data", { line }); });
            monitoring = true;
        } catch (_) {}
    }

    buildEmit("done", "Running on device", 100);
    return { ok: true, port: newPort || port };
});

