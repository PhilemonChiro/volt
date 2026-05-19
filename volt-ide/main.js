const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

app.commandLine.appendSwitch("no-sandbox");

const PROJECTS_DIR = path.join(os.homedir(), "Volt");
const RECENTS_FILE = path.join(os.homedir(), ".volt", "recent-projects.json");
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
    // Keep max 20
    const trimmed = filtered.slice(0, 20);
    fs.mkdirSync(path.dirname(RECENTS_FILE), { recursive: true });
    fs.writeFileSync(RECENTS_FILE, JSON.stringify(trimmed, null, 2));
}

app.whenReady().then(() => {
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
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    const dir = path.join(PROJECTS_DIR, name);
    if (!dir.startsWith(PROJECTS_DIR)) throw new Error("Invalid project name");
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

    // 1. Scan ~/Volt/ (default project directory)
    if (fs.existsSync(PROJECTS_DIR)) {
        for (const d of fs.readdirSync(PROJECTS_DIR)) {
            const dir = path.join(PROJECTS_DIR, d);
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

function getVoltSrc() {
    const dev = path.join(__dirname, "..", "src");
    if (fs.existsSync(path.join(dev, "volt", "compiler", "voltc.py"))) return dev;
    return path.join(os.homedir(), ".volt", "sdk", "src");
}

const VOLT_SRC = getVoltSrc();

let worker = null;
let workerStart = null;
const pending = new Map();   // id → { resolve, reject, timer, onProgress? }
let reqCounter = 0;

function startWorker() {
    if (workerStart) return workerStart;

    workerStart = new Promise((resolve, reject) => {
        const script = path.join(__dirname, "scripts", "worker.py");
        worker = spawn("python3", [script, VOLT_SRC], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        const rl = readline.createInterface({ input: worker.stdout });
        rl.on("line", (line) => {
            let msg;
            try { msg = JSON.parse(line); } catch { return; }
            if (msg.id === "_ready") { resolve(); return; }
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
            const s = chunk.toString().trim();
            if (s) console.warn("[worker]", s);
        });

        worker.on("exit", (code) => {
            console.warn(`[worker] exited code=${code}; will respawn on next request`);
            for (const [, p] of pending) {
                clearTimeout(p.timer);
                p.reject(new Error("worker died"));
            }
            pending.clear();
            worker = null;
            workerStart = null;
        });

        worker.on("error", (err) => {
            console.error("[worker] spawn error:", err);
            reject(err);
        });
    });

    return workerStart;
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
    return {
        ...EMPTY_COMPILE_RESULT,
        diagnostics: [{
            line: 1, col: 1,
            message: "Compiler error: " + (message || "").substring(0, 200),
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
        activePort = new SerialPort({ path: port, baudRate: baud || 115200 });
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
    const log = (msg) => {
        logs.push(msg);
        if (win) win.webContents.send("toolchain:log", msg);
    };
    const ok = toolchain.ensureToolchain(chip, log);
    return { ok, logs };
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

