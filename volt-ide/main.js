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
// Compiler — calls Python subprocess
// ============================================================
const { execSync } = require("child_process");

function getVoltSrc() {
    // Dev: relative to this project
    const dev = path.join(__dirname, "..", "src");
    if (fs.existsSync(path.join(dev, "volt", "compiler", "voltc.py"))) return dev;
    return path.join(os.homedir(), ".volt", "sdk", "src");
}

const VOLT_SRC = getVoltSrc();

function runCompiler(source, projectDir, realFilename) {
    // Write source to project dir so compiler finds volt.toml for chip detection
    const tmp = projectDir
        ? path.join(projectDir, "_volt_tmp.volt")
        : path.join(os.tmpdir(), `_volt_${process.pid}.volt`);
    fs.writeFileSync(tmp, source);
    const script = path.join(os.tmpdir(), `_volt_${process.pid}.py`);

    const tmpEsc = tmp.replace(/\\/g, "/");
    // Use real filename for #line directives if provided, else use temp path
    const filenameForCompiler = (realFilename || tmp).replace(/\\/g, "/");
    fs.writeFileSync(script, `
import sys, json
sys.path.insert(0, '${VOLT_SRC.replace(/\\/g, "/")}')
from volt.compiler.voltc import compile_volt
from volt.compiler.parser import parse
from volt.compiler.resolver import resolve
from volt.compiler.checker import check_types
from volt.compiler.errors import CompilerErrors

source = open('${tmpEsc}').read()
c_code, errors = compile_volt(source, '${filenameForCompiler}')

# Re-parse to extract AST (compile_volt doesn't return program)
program = None
try:
    errs2 = CompilerErrors()
    errs2.set_source(source)
    program = parse(source)
    scope = resolve(program, errs2)
    check_types(program, scope, errs2)
except Exception:
    pass

result = {
    'diagnostics': [{
        'line': e.region.start_line if e.region else 1,
        'col': e.region.start_col if e.region else 1,
        'message': e.message,
        'severity': e.severity,
        'hint': e.hint or ''
    } for e in errors.errors],
    'c_code': c_code or '',
    'pins': [],
    'devices': [],
    'buses': [],
    'tasks': [],
    'machines': [],
    'channels': [],
    'enums': [],
    'chip': '',
}

if program:
    if program.chip:
        result['chip'] = program.chip.target
    if program.hardware:
        result['pins'] = [{'name': p.name, 'mode': p.mode, 'gpio': p.gpio} for p in program.hardware.pins]
        result['devices'] = [{'name': s.name, 'type': s.sensor_type, 'bus': s.bus_name, 'address': s.address} for s in program.hardware.sensors]
        result['buses'] = [{'name': b.name, 'type': b.bus_type} for b in program.hardware.buses]
    result['tasks'] = [{'name': t.name, 'tier': getattr(t, 'tier', 'background'), 'line': t.region.start_line} for t in program.tasks]
    result['machines'] = [{'name': m.name, 'states': [s.name for s in m.states], 'line': m.region.start_line} for m in program.machines]
    result['channels'] = [{'name': c.name, 'elem_type': c.elem_type, 'capacity': c.capacity} for c in program.channels]
    result['enums'] = [{'name': e.name, 'variants': e.variants} for e in program.enums]

print(json.dumps(result))
`);

    try {
        const out = execSync(`python3 "${script}"`, { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
        return JSON.parse(out.toString().trim());
    } catch (e) {
        return { diagnostics: [{ line: 1, col: 1, message: "Compiler error: " + (e.message || "").substring(0, 200), severity: "error", hint: "" }],
            c_code: "", pins: [], devices: [], buses: [], tasks: [], machines: [], channels: [], enums: [], chip: "" };
    }
}

ipcMain.handle("compile_full", (_, source) => runCompiler(source));

ipcMain.handle("check_code", (_, source) => {
    const result = runCompiler(source);
    return result.diagnostics;
});

ipcMain.handle("format_code", (_, source) => {
    const script = path.join(os.tmpdir(), `_volt_fmt_${process.pid}.py`);
    fs.writeFileSync(script, `
import sys, json
sys.path.insert(0, '${VOLT_SRC.replace(/\\/g, "/")}')
from volt.compiler.formatter import format_source

source = sys.stdin.read()
print(format_source(source))
`);
    try {
        const out = execSync(`python3 "${script}"`, {
            input: source,
            timeout: 5000,
            maxBuffer: 1024 * 1024,
        });
        return out.toString();
    } catch (e) {
        return null;  // format failed — IDE keeps original
    }
});

ipcMain.handle("find_symbols", (_, source) => {
    const script = path.join(__dirname, "scripts", "find-symbols.py");
    try {
        const out = execSync(`python3 "${script}" "${VOLT_SRC.replace(/"/g, '\\"')}"`, {
            input: source,
            timeout: 5000,
            maxBuffer: 2 * 1024 * 1024,
        });
        return JSON.parse(out.toString().trim() || "[]");
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

// Shared compile step
function compileStep(projectPath, voltFile) {
    const buildDir = path.join(projectPath, "build");
    fs.mkdirSync(buildDir, { recursive: true });

    buildEmit("compile", "Compiling...", 10);
    const source = fs.readFileSync(voltFile, "utf-8");
    // Pass real voltFile path so #line directives point to the user's source, not the temp
    const result = runCompiler(source, projectPath, voltFile);
    try { fs.unlinkSync(path.join(projectPath, "_volt_tmp.volt")); } catch (_) {}

    if (!result.c_code) {
        const errMsg = (result.diagnostics || []).filter(d => d.severity === "error").map(d => d.message).join("; ");
        buildEmit("error", "Compile failed: " + (errMsg || "unknown error"));
        return null;
    }

    fs.writeFileSync(path.join(buildDir, "main.c"), result.c_code);
    buildEmit("compile", "Compiled successfully", 25);
    return result;
}

ipcMain.handle("build_only", async (_, projectPath, voltFile, chip) => {
    const result = compileStep(projectPath, voltFile);
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
    const result = compileStep(projectPath, voltFile);
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

