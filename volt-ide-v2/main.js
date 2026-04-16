const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

app.commandLine.appendSwitch("no-sandbox");

const PROJECTS_DIR = path.join(os.homedir(), "Volt");
let win = null;

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
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    const dir = path.join(PROJECTS_DIR, name);
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
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    return fs.readdirSync(PROJECTS_DIR)
        .filter(d => fs.existsSync(path.join(PROJECTS_DIR, d, "main.volt")))
        .map(d => {
            const dir = path.join(PROJECTS_DIR, d);
            let chip = "esp32";
            const toml = path.join(dir, "volt.toml");
            if (fs.existsSync(toml)) {
                const m = fs.readFileSync(toml, "utf-8").match(/chip\s*=\s*"([^"]+)"/);
                if (m) chip = m[1];
            }
            return { name: d, path: dir, chip, modified: fs.statSync(dir).mtimeMs / 1000 };
        })
        .sort((a, b) => b.modified - a.modified);
});

ipcMain.handle("read_file", (_, filePath) => fs.readFileSync(filePath, "utf-8"));

ipcMain.handle("save_file", (_, filePath, content) => fs.writeFileSync(filePath, content));

ipcMain.handle("browse_volt_file", async () => {
    const result = await dialog.showOpenDialog(win, {
        filters: [{ name: "Volt Files", extensions: ["volt"] }],
        properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const fp = result.filePaths[0];
    return { path: fp, folder: path.dirname(fp), content: fs.readFileSync(fp, "utf-8") };
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

function runCompiler(source) {
    const tmp = path.join(os.tmpdir(), `_volt_${process.pid}.volt`);
    const script = path.join(os.tmpdir(), `_volt_${process.pid}.py`);
    fs.writeFileSync(tmp, source);

    fs.writeFileSync(script, `
import sys, json
sys.path.insert(0, '${VOLT_SRC.replace(/\\/g, "/")}')
from volt.compiler.errors import CompilerErrors
from volt.compiler.parser import parse
from volt.compiler.resolver import resolve
from volt.compiler.checker import check_types
from volt.compiler.hardware import validate_hardware
from volt.compiler.analyzer import analyze
from volt.compiler.transformer import transform
from volt.compiler.codegen import generate

source = open('${tmp.replace(/\\/g, "/")}').read()
errors = CompilerErrors()
errors.set_source(source)
program = None
c_code = None

try:
    program = parse(source)
    scope = resolve(program, errors)
    if not errors.has_errors:
        check_types(program, scope, errors)
    if not errors.has_errors:
        validate_hardware(program, scope, errors)
    if not errors.has_errors:
        analyze(program, scope, errors)
    if not errors.has_errors:
        program = transform(program)
        c_code = generate(program, 'main.volt')
except Exception as e:
    from volt.compiler.ast_nodes import Region
    errors.error(Region(1,1,1,1), "INTERNAL", str(e).split('\\n')[0])

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

ipcMain.handle("find_symbols", (_, source) => []);

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
// Build (TODO)
// ============================================================
ipcMain.handle("run_project", () => {});
