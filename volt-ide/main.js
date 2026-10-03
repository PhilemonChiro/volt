const { app, BrowserWindow, ipcMain, dialog, screen, session } = require("electron");
const logger = require("./src/main/logger");
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

// ---- Deep links: volt://install/<prefix>/<version> --------------------------
// The Spark studio's "Install to Volt IDE" button opens this URL. We register
// "volt" as our protocol, then route the URL into the SAME grid fetch → verify
// → consent → install flow the renderer already uses for the registry browser.
// Nothing is installed without the user confirming the signed-import sheet.
if (process.defaultApp) {
    // Dev mode (electron main.js …): the protocol has to carry the script path
    // so the relaunched instance knows what to run.
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient("volt", process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient("volt");
}

// A URL that arrives before the window is ready is parked here and replayed
// once the renderer has loaded.
let _pendingDeepLink = null;

function extractDeepLink(argv) {
    return (argv || []).find((a) => typeof a === "string" && a.startsWith("volt://")) || null;
}

// Parse volt://install/<prefix>/<version> and hand it to the renderer.
function handleDeepLink(url) {
    if (!url) return;
    let prefix, version;
    try {
        const u = new URL(url);
        if (u.protocol !== "volt:" || u.host !== "install") return;
        const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        [prefix, version] = parts;
    } catch (_) { return; }
    if (!prefix) return;

    const deliver = () => {
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.focus();
        win.webContents.send("deep_link_install", { prefix, version: version || "" });
    };
    if (win && win.webContents && !win.webContents.isLoading()) deliver();
    else _pendingDeepLink = { prefix, version: version || "" };
}

// ---- Open a .volt file / project folder straight from the OS ----
// Accepts a path to a .volt file or to a folder holding main.volt (Finder
// double-click, `open -a`, drag onto the dock icon, or a CLI argument).
let _pendingOpenPath = null;
let _rendererReadyForOpen = false;   // set once app.js has wired onOpenPath

function extractOpenPath(argv) {
    for (const a of (argv || []).slice(1)) {
        if (typeof a !== "string" || a.startsWith("-") || a.startsWith("volt://")) continue;
        const abs = path.resolve(a);
        // In dev (`electron .`) argv[1] is the app directory itself — skip it.
        if (abs === path.resolve(app.getAppPath())) continue;
        if (!fs.existsSync(abs)) continue;
        if (abs.endsWith(".volt") || fs.statSync(abs).isDirectory()) return abs;
    }
    return null;
}

function handleOpenPath(p) {
    if (!p) return;
    let folder, file;
    try {
        if (fs.statSync(p).isDirectory()) {
            folder = p;
            file = path.join(p, "main.volt");
            if (!fs.existsSync(file)) {
                const first = fs.readdirSync(p).find((f) => f.endsWith(".volt"));
                if (!first) return;
                file = path.join(p, first);
            }
        } else {
            file = p;
            folder = path.dirname(p);
        }
    } catch (_) { return; }
    logger.log("info", "open", `open path ${file}`);

    const payload = { folder, file };
    const deliver = () => {
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.focus();
        win.webContents.send("open_path", payload);
    };
    // The renderer wires its listener after the page has loaded (app.js is an
    // async module), so push only once it has asked for the pending path.
    if (_rendererReadyForOpen) deliver();
    else _pendingOpenPath = payload;
}

// Renderer pulls whatever arrived before it was listening (cold start with a
// file argument, or a macOS open-file event before the window existed).
ipcMain.handle("open_path:take", () => {
    _rendererReadyForOpen = true;
    const p = _pendingOpenPath;
    _pendingOpenPath = null;
    return p;
});

// Single-instance lock so a second launch (Windows/Linux protocol activation)
// forwards its URL to the running window instead of opening a second IDE.
const _gotLock = app.requestSingleInstanceLock();
if (!_gotLock) {
    app.quit();
} else {
    app.on("second-instance", (_e, argv) => {
        if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
        handleDeepLink(extractDeepLink(argv));
        handleOpenPath(extractOpenPath(argv));
    });
    // macOS delivers protocol activations here (not via argv).
    app.on("open-url", (event, url) => {
        event.preventDefault();
        handleDeepLink(url);
    });
    // macOS delivers file activations (Finder / dock drop) here, possibly
    // before the window exists — handleOpenPath parks it until then.
    app.on("open-file", (event, filePath) => {
        event.preventDefault();
        handleOpenPath(filePath);
    });
}

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
    logger.init();
    clearMacOSQuarantine();

    // Open at ~85% of the primary display's work area (excludes dock /
    // taskbar), capped at 1800x1200 so 4K+ monitors don't open giants.
    // Floor at 1100x720 so tiny laptop screens still get a usable layout.
    const work = screen.getPrimaryDisplay().workAreaSize;
    const initWidth  = Math.max(1100, Math.min(1800, Math.floor(work.width  * 0.85)));
    const initHeight = Math.max(720,  Math.min(1200, Math.floor(work.height * 0.85)));

    win = new BrowserWindow({
        width:  initWidth,
        height: initHeight,
        minWidth:  1024,
        minHeight: 640,
        title: "Volt IDE",
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadFile("index.html");

    // Once the renderer is live, replay a deep link that arrived early — either
    // parked by open-url before the window existed, or passed in argv on a cold
    // start (Windows/Linux protocol activation).
    win.webContents.once("did-finish-load", () => {
        const url = _pendingDeepLink ? null : extractDeepLink(process.argv);
        if (_pendingDeepLink) {
            win.webContents.send("deep_link_install", _pendingDeepLink);
            _pendingDeepLink = null;
        } else if (url) {
            handleDeepLink(url);
        }
        // A file/folder on the command line (cold start) is parked and
        // handed over when the renderer calls open_path:take.
        if (!_pendingOpenPath) handleOpenPath(extractOpenPath(process.argv));
    });

    // Surface renderer crashes/hangs. Without these, a dead or non-painting
    // renderer (e.g. the GPU/sandbox launch failures) fails silently with a
    // blank window and nothing in the log.
    win.webContents.on("render-process-gone", (_e, details) => {
        logger.log("error", "renderer",
            `render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
    });
    win.webContents.on("did-fail-load", (_e, code, desc, url) => {
        logger.log("error", "renderer", `did-fail-load ${code} ${desc} ${url}`);
    });
    win.webContents.on("unresponsive", () =>
        logger.log("warn", "window", "renderer became unresponsive"));
    win.webContents.on("responsive", () =>
        logger.log("info", "window", "renderer responsive again"));

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

ipcMain.handle("app_version", () => app.getVersion());

// ============================================================
// Projects
// ============================================================
ipcMain.handle("create_project", (_, name, chip, template) => {
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
    const mainVolt = template === "empty" ? `// ${name}\n\nhardware {\n    pin led = ${led}\n}\n`
        : template === "iot-sensor" ? `hardware {\n    pin led = 2\n    pin sensor: Analog = 36\n}\n\nsetup {\n    wifi.connect("MyNetwork", "password") or retry(10)\n    mqtt.connect("mqtt://broker.local") or retry(5)\n}\n\nevery 500ms { led.toggle() }\n\nevery 5s when wifi.is_connected() {\n    mqtt.send_int("data/sensor", sensor.read())\n}\n`
        : template === "door-lock" ? `hardware {\n    pin led = 2\n    pin relay = 4\n    pin button: PullUpInput = 15\n    pin buzzer: PWM = 18\n}\n\nenum DoorState { locked, unlocked, alert }\nvar door: DoorState = DoorState.locked\n\nmachine door_lock {\n    state locked {\n        enter { relay.off(); led.off() }\n        after 1s -> locked\n    }\n    state unlocked {\n        enter { relay.on(); led.on() }\n        after 30s -> locked\n    }\n    state alert {\n        enter { buzzer.beep_alarm() }\n        after 60s -> locked\n    }\n}\n\nevery 100ms {\n    if button.read() == 0 {\n        door_lock.send(button_press)\n    }\n}\n`
        : `hardware {\n    pin led = ${led}\n}\n\nevery 500ms {\n    led.toggle()\n}\n`;  // blink (default)

    fs.writeFileSync(path.join(dir, "main.volt"), mainVolt);
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

// Resolve a bundled example to its absolute project directory so the renderer
// can hand it straight to loadProject(). `name` is a bare folder (e.g.
// "02-iot-sensor"); path.basename() strips any traversal.
ipcMain.handle("resolve_example", (_, name) => {
    const folder = path.basename(String(name || ""));
    if (!folder) throw new Error("Invalid example name");
    const dir = path.join(examplesDir(), folder);
    if (!fs.existsSync(path.join(dir, "main.volt"))) {
        throw new Error("Example not found: " + folder);
    }
    return dir;
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
// Compiler — long-lived Go worker process (JSON-line IPC over stdin/stdout)
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

// Logging — let the renderer write into the rotating main.log AND
// reveal/copy the log path.
ipcMain.handle("log_path", () => logger.getPath());
ipcMain.handle("log_reveal", () => {
    const { shell } = require("electron");
    shell.showItemInFolder(logger.getPath());
    return true;
});

// Open arbitrary URL in the user's external default browser. Used by the
// device-library detail dialog for datasheet links.
ipcMain.handle("open_external", (_, url) => {
    const { shell } = require("electron");
    if (typeof url !== "string") return false;
    // Allow only http(s) — never file:// or arbitrary schemes
    if (!/^https?:\/\//i.test(url)) return false;
    shell.openExternal(url);
    return true;
});

// ============================================================
// Device library — reads the JSON catalog in <repo>/devices/*/*.json
// (devicesDir() defined above, near getVoltSrc())
// ============================================================
ipcMain.handle("devices_list", () => {
    // Read from ALL device roots, not just the first that exists: built-ins ship
    // in resources/sdk/devices, but user-installed libraries (incl. private ones)
    // land in ~/.volt/sdk/devices. Reading only one root hid installed devices
    // from the catalog + detail view. Later roots win on a name collision so an
    // installed override shadows a built-in of the same name.
    const byPrefix = new Map();
    for (const root of deviceReadRoots()) {
        for (const entry of fs.readdirSync(root)) {
            const dir = path.join(root, entry);
            try { if (!fs.statSync(dir).isDirectory()) continue; } catch (_) { continue; }
            for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith(".json")) continue;
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
                    // Keyed by device name: several devices share a driver
                    // (LCD16x2 / LCD20x4 / HD44780 all use c_prefix hd44780).
                    const key = (data.name || entry).toLowerCase();
                    byPrefix.set(key, data);
                } catch (_) {}
            }
        }
    }
    return [...byPrefix.values()];
});

// Scaffold a new device library from the creator wizard's spec — writes
// device.json + driver.c + a struct/prototypes block into every catalog copy.
ipcMain.handle("create_device", (_, spec) => {
    const { createDevice } = require("./src/main/device-creator");
    return createDevice(spec, path.join(__dirname, ".."));
});

// ---- Secure library import (.vlib) ----------------------------------------
// Two-step so the main process re-verifies the EXACT inspected envelope on
// install (the renderer only ever sees display data + a token, never the ability
// to swap the payload after consent).
const _pendingVlib = new Map();

ipcMain.handle("vlib_inspect_file", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: "Import Volt Cell",
        filters: [{ name: "Volt Cell", extensions: ["vcell", "vlib", "json"] }],
        properties: ["openFile"],
    });
    if (canceled || !filePaths || !filePaths[0]) return { canceled: true };
    let envelope;
    try { envelope = JSON.parse(fs.readFileSync(filePaths[0], "utf-8")); }
    catch (_) { return { ok: false, reason: "file is not valid JSON" }; }

    const { inspect } = require("./src/main/vlib-import");
    const r = inspect(envelope);
    if (r.stage === "verify" && !r.ok) return { ok: false, stage: "verify", reason: r.reason };

    const token = require("crypto").randomBytes(8).toString("hex");
    _pendingVlib.set(token, envelope);
    setTimeout(() => _pendingVlib.delete(token), 5 * 60 * 1000);
    return {
        ok: r.ok, token, manifest: r.manifest, device: r.device, capabilities: r.capabilities,
        warnings: r.warnings, errors: r.errors, driver: r.driver, keyId: r.keyId, hash: r.hash,
    };
});

ipcMain.handle("vlib_install", (_, token) => {
    const envelope = _pendingVlib.get(token);
    if (!envelope) throw new Error("import expired — re-open the .vlib file");
    const { install } = require("./src/main/vlib-import");
    const res = install(envelope, path.join(__dirname, ".."));  // re-verifies internally
    _pendingVlib.delete(token);
    return res;
});

ipcMain.handle("vlib_installed_list", () => require("./src/main/vlib-import").list());

ipcMain.handle("vlib_uninstall", (_, prefix) =>
    require("./src/main/vlib-import").uninstall(prefix, path.join(__dirname, "..")));

// ---- Grid (registry) browse + install ----
// Fuse browses the Grid catalog over HTTP and installs signed Cells directly —
// the SAME verify + hardened import as file import; only the transport differs.
function gridUrl() {
    try { return require("./src/main/settings").get("registry.gridUrl") || "http://127.0.0.1:8080"; }
    catch (_) { return "http://127.0.0.1:8080"; }
}

ipcMain.handle("grid_list", async () => {
    const r = await fetch(`${gridUrl()}/api/v1/libraries`);
    if (!r.ok) throw new Error(`Grid unreachable (${r.status})`);
    const { data } = await r.json();
    return data || [];
});

ipcMain.handle("grid_fetch", async (_, prefix, version) => {
    const r = await fetch(`${gridUrl()}/api/v1/libraries/${encodeURIComponent(prefix)}/${encodeURIComponent(version)}/download`);
    if (!r.ok) return { ok: false, reason: `download failed (${r.status})` };
    let envelope;
    try { envelope = await r.json(); } catch (_) { return { ok: false, reason: "invalid response" }; }
    const { inspect } = require("./src/main/vlib-import");
    const res = inspect(envelope);
    if (res.stage === "verify" && !res.ok) return { ok: false, stage: "verify", reason: res.reason };
    const token = require("crypto").randomBytes(8).toString("hex");
    _pendingVlib.set(token, envelope);
    setTimeout(() => _pendingVlib.delete(token), 5 * 60 * 1000);
    return {
        ok: res.ok, token, manifest: res.manifest, device: res.device, capabilities: res.capabilities,
        warnings: res.warnings, errors: res.errors, driver: res.driver, keyId: res.keyId,
        hash: res.hash, update: res.update, alreadyInstalled: res.alreadyInstalled,
    };
});

// ---- GitHub sign-in + private collection ----
// The user signs in with GitHub (same Grid OAuth as the studio). We reuse the
// resulting volt_session cookie as a bearer token for the /me/* endpoints, so
// the IDE can list + install the user's OWN private libraries. These are NOT
// signature-verified — the trust is the authenticated session over TLS — but
// they still pass the hardened static validation and are marked "private".
let sessionToken = null;

async function getSessionToken() {
    if (sessionToken) return sessionToken;
    try {
        const cs = await session.defaultSession.cookies.get({ name: "volt_session" });
        if (cs && cs[0] && cs[0].value) sessionToken = cs[0].value;
    } catch (_) {}
    return sessionToken;
}

// Open a modal window to the Grid's GitHub OAuth; when it lands back on the web
// app the session cookie is set — grab it and close.
ipcMain.handle("auth_login", async () => {
    return await new Promise((resolve) => {
        const authWin = new BrowserWindow({
            // Not modal: on macOS a modal child is a sheet with no title bar, so the
            // user couldn't back out of signing in. A normal window has a close button.
            width: 520, height: 720, parent: win, modal: false, show: true, title: "Sign in to VoltGrid",
            webPreferences: { nodeIntegration: false, contextIsolation: true },
        });
        authWin.webContents.on("before-input-event", (e, input) => {
            if (input.type === "keyDown" && input.key === "Escape") { e.preventDefault(); authWin.close(); }
        });
        let done = false;
        const grab = async () => {
            try {
                const cs = await authWin.webContents.session.cookies.get({ name: "volt_session" });
                if (cs && cs[0] && cs[0].value) { sessionToken = cs[0].value; return true; }
            } catch (_) {}
            return false;
        };
        authWin.webContents.on("did-navigate", async () => {
            if (await grab()) { done = true; authWin.close(); }
        });
        authWin.on("closed", async () => { if (!done) await grab(); resolve({ ok: !!sessionToken }); });
        authWin.loadURL(`${gridUrl()}/auth/github/login`);
    });
});

ipcMain.handle("auth_status", async () => {
    const tok = await getSessionToken();
    if (!tok) return { signedIn: false };
    try {
        const r = await fetch(`${gridUrl()}/api/v1/me`, { headers: { Authorization: `Bearer ${tok}` } });
        if (!r.ok) { sessionToken = null; return { signedIn: false }; }
        const { data } = await r.json();
        return { signedIn: true, user: data && data.user };
    } catch (_) { return { signedIn: false }; }
});

ipcMain.handle("auth_logout", async () => {
    sessionToken = null;
    try { await session.defaultSession.cookies.remove(`${gridUrl()}`, "volt_session"); } catch (_) {}
    return { ok: true };
});

ipcMain.handle("collection_list", async () => {
    const tok = await getSessionToken();
    if (!tok) return { ok: false, reason: "not signed in" };
    try {
        const r = await fetch(`${gridUrl()}/api/v1/me/collection`, { headers: { Authorization: `Bearer ${tok}` } });
        if (r.status === 401) { sessionToken = null; return { ok: false, reason: "not signed in" }; }
        if (!r.ok) return { ok: false, reason: `list failed (${r.status})` };
        const { data } = await r.json();
        return { ok: true, libraries: data || [] };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
});

// Install a private library from the user's own collection (unsigned, local).
ipcMain.handle("collection_install", async (_, prefix, version) => {
    const tok = await getSessionToken();
    if (!tok) return { ok: false, reason: "not signed in" };
    try {
        const url = `${gridUrl()}/api/v1/me/collection/${encodeURIComponent(prefix)}/${encodeURIComponent(version)}/download`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
        if (!r.ok) return { ok: false, reason: `download failed (${r.status})` };
        const envelope = await r.json();
        const { install } = require("./src/main/vlib-import");
        const res = install(envelope, path.join(__dirname, ".."), { local: true });
        return { ok: true, ...res };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
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

// Every device root that may hold catalog entries — the built-ins AND the
// user-installed tree. devices_list reads all of them so installed libraries
// (public or private) show up in the catalog and detail view.
function deviceReadRoots() {
    const roots = [
        path.join(__dirname, "..", "devices"),
        process.resourcesPath ? path.join(process.resourcesPath, "sdk", "devices") : null,
        path.join(os.homedir(), ".volt", "sdk", "devices"),
    ].filter(Boolean);
    return roots.filter((r, i, a) => a.indexOf(r) === i && fs.existsSync(r));
}

function examplesDir() {
    // dev → repo/examples, packaged → resources/sdk/examples.
    // The renderer references examples by a relative "examples/<name>/main.volt"
    // path, which would otherwise resolve against the process cwd (= the volt-ide
    // dir) where no examples/ folder exists — hence the ENOENT on open.
    const dev = path.join(__dirname, "..", "examples");
    if (fs.existsSync(dev)) return dev;
    if (process.resourcesPath) {
        const bundled = path.join(process.resourcesPath, "sdk", "examples");
        if (fs.existsSync(bundled)) return bundled;
    }
    return dev;
}

let worker = null;
let workerStart = null;
const pending = new Map();   // id → { resolve, reject, timer, onProgress? }
let reqCounter = 0;

function startWorker() {
    if (workerStart) return workerStart;

    workerStart = new Promise((resolve, reject) => {
        // The compiler worker is `volt worker` (see src/main/volt-cli.js).
        const workerBin = require("./src/main/volt-cli").bin();

        let started = false;
        let stderrBuf = "";

        try {
            worker = spawn(workerBin, ["worker", "--devices", devicesDir()], {
                stdio: ["pipe", "pipe", "pipe"],
            });
            logger.log("info", "worker", `spawned ${workerBin} pid=${worker.pid}`);
            console.log("info", "worker", `spawned ${workerBin} pid=${worker.pid}`)
            // Stderr only — stdout is the JSON-RPC channel we own.
            if (worker.stderr) worker.stderr.on("data", b => logger.log("error", "worker", b.toString().trimEnd()));
        } catch (e) {
            reject(new Error(`Failed to spawn ${workerBin}: ${e.message}`));
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
            // promise with the captured stderr so the user sees the real cause.
            if (!started) {
                const reason = stderrBuf.trim().slice(0, 600) || `exit code ${code}, signal ${signal}`;
                reject(new Error(`Compiler worker failed to start:\n${reason}`));
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
                ? `Volt compiler not found at ${workerBin}. Run 'npm run build:volt' in volt-ide.`
                : err.message;
            reject(new Error(hint));
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
            console.log(req)
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
    // Preserve the full message (including multi-line worker stderr) rather
    // than truncating it to 200 chars.
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

// The compiler's GPIO table for a chip (capabilities + safety) — feeds
// pin completion, hover and the board view.
ipcMain.handle("pin_table", async (_, chip) => {
    try {
        return await workerCall("pin_table", { chip: chip || "" }, 5000);
    } catch (_) {
        return [];
    }
});

// Suggested pins for a new bus: { i2c: {sda, scl}, spi: {...}, uart: {...} }.
ipcMain.handle("bus_pins", async (_, chip) => {
    try {
        return await workerCall("bus_pins", { chip: chip || "" }, 5000);
    } catch (_) {
        return {};
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

ipcMain.handle("state_diagram", async (_, source) => {
    try {
        return await workerCall("state_diagram", { source }, 5000);
    } catch (_) {
        return { machines: [] };
    }
});

ipcMain.handle("system_graph", async (_, source, expanded) => {
    try {
        return await workerCall("system_graph", { source, expanded: expanded || [] }, 5000);
    } catch (_) {
        return { mermaid: "", units: [], loops: [] };
    }
});

// ============================================================
// Serial, toolchain and build — all through the `volt` CLI. ESP32 only
// (the pre-volt RP2040 / STM32 / ESP8266 code is in git history).
// ============================================================
const volt = require("./src/main/volt-cli");

function send(channel, data) {
    if (win) win.webContents.send(channel, data);
}

// The serial port is held by at most one volt child: `volt monitor`, or the
// monitor phase of `volt run`.
let monitorProc = null;   // { child, done, port }
let monitoring = false;

// serialEvent relays one `volt monitor --json` object; false if it isn't one.
function serialEvent(o) {
    if (typeof o.line === "string") { send("serial:data", { line: o.line }); return true; }
    switch (o.event) {
        case "connected":    monitoring = true;  send("serial:connected", o.port); return true;
        case "error":        send("serial:error", o.message); return true;
        case "disconnected": monitoring = false; send("serial:disconnected", o.port); return true;
    }
    return false;
}

function trackMonitor(proc, port) {
    proc.port = port;
    monitorProc = proc;
    proc.done.then(() => {
        if (monitorProc === proc) { monitorProc = null; monitoring = false; }
    });
}

async function stopMonitor() {
    const m = monitorProc;
    monitorProc = null;
    monitoring = false;
    await volt.stop(m);   // the port is free once volt has exited
}

// ESP boards are probed (`volt ports --probe`: does esptool get an answer?)
// in the background, at most every PROBE_TTL_MS per port, never while volt
// holds a port. Results: "verified" | "silent", or "running" when the
// monitor has the port.
const probeCache = new Map();   // port → { result, expiresAt }
const PROBE_TTL_MS = 30_000;
let probing = false;

function refreshProbes(ports) {
    if (probing || monitorProc || buildProc) return;
    const now = Date.now();
    const stale = ports.filter(p => p.state === "running" && p.chip.startsWith("ESP")
        && !(probeCache.get(p.port)?.expiresAt > now));
    if (!stale.length) return;
    probing = true;
    volt.run(["ports", "--json", "--probe"], {
        onJSON: (list) => {
            if (!Array.isArray(list)) return;
            for (const p of list) {
                if (!p.probe) continue;
                probeCache.set(p.port, { result: p.probe, expiresAt: Date.now() + PROBE_TTL_MS });
                send("devices:probe_updated", { port: p.port, state: p.probe });
            }
        },
    }).done.then(() => {
        // Ports that got no answer (e.g. toolchain not installed yet) wait a
        // full TTL before the next attempt.
        for (const p of stale) {
            if (!(probeCache.get(p.port)?.expiresAt > now)) {
                probeCache.set(p.port, { result: null, expiresAt: Date.now() + PROBE_TTL_MS });
            }
        }
        probing = false;
    });
}

ipcMain.handle("scan_devices", async () => {
    let ports = [];
    await volt.run(["ports", "--json"], {
        onJSON: (o) => { if (Array.isArray(o)) ports = o; },
    }).done;
    const now = Date.now();
    for (const p of ports) {
        if (monitorProc && monitorProc.port === p.port) {
            p.probe = "running";
            continue;
        }
        const c = probeCache.get(p.port);
        if (c && c.result && c.expiresAt > now) p.probe = c.result;
    }
    refreshProbes(ports);
    return ports;
});

ipcMain.handle("start_monitor", async (_, port, baud) => {
    await stopMonitor();
    const args = ["monitor", "--json", "-p", port];
    if (baud) args.push("-b", String(baud));
    trackMonitor(volt.run(args, { onJSON: serialEvent }), port);
});

ipcMain.handle("stop_monitor", () => stopMonitor());

ipcMain.handle("is_monitoring", () => monitoring);

// ---- Toolchain ----

// toolchainStatus is `volt toolchain status <chip> --json`:
// { chip, platform, ready, components: [{id,name,ok,detail,path}], notes },
// or { error } when volt can't report (e.g. a chip it has no toolchain for).
async function toolchainStatus(chip) {
    let status = null;
    const { stderr } = await volt.run(["toolchain", "status", chip, "--json"], {
        onJSON: (o) => { status = o; },
    }).done;
    return status || { error: stderr.join("\n").trim() || "volt toolchain status failed" };
}

ipcMain.handle("check_toolchain", async (_, chip) => !!(await toolchainStatus(chip)).ready);

ipcMain.handle("toolchain_components", async (_, chip) => (await toolchainStatus(chip)).components || []);

ipcMain.handle("diagnose_toolchain", async (_, chip) => {
    const s = await toolchainStatus(chip);
    if (s.error) return { ready: false, reason: s.error, missing: [s.error] };
    const bad = s.components.filter(c => !c.ok);
    return {
        ready: s.ready,
        reason: bad.length ? bad[0].detail : "",
        missing: bad.map(c => `${c.name}: ${c.detail}`),
    };
});

ipcMain.handle("repair_toolchain", async (_, chip) => {
    let r = null;
    const { stderr } = await volt.run(["toolchain", "repair", chip, "--json"], {
        onJSON: (o) => { r = o; },
    }).done;
    if (!r || !r.ok) throw new Error((r && r.error) || stderr.join("\n") || "repair failed");
    return { ok: true, removed: r.removed };
});

let toolchainProc = null;

// Streams `volt toolchain install --json` events (stage_start{id,name},
// stage_progress, stage_done, stage_error, log, complete) as toolchain:event.
ipcMain.handle("setup_toolchain", async (_, chip) => {
    let completed = false;
    const proc = volt.run(["toolchain", "install", chip, "--json"], {
        onJSON: (e) => {
            if (e.type === "complete") completed = true;
            send("toolchain:event", e);
        },
        onText: (line) => send("toolchain:event", { type: "log", message: line }),
    });
    toolchainProc = proc;
    const { code } = await proc.done;
    if (toolchainProc === proc) toolchainProc = null;
    // Killed (cancel) or crashed before its own complete event.
    if (!completed) send("toolchain:event", { type: "complete", success: code === 0 });
    return { ok: code === 0 };
});

ipcMain.handle("cancel_toolchain", () => volt.stop(toolchainProc));

// ---- Build / flash ----

// One build at a time: starting another cancels the one in flight.
let buildProc = null;

// voltBuild runs `volt build|run <voltFile> --json …`, relays its progress
// events as build:progress and its monitor events as serial:*. Resolves to
// the done event's artifact (firmware path for build, port for run), or
// null on failure.
async function voltBuild(cmd, voltFile, chip, extra = []) {
    await volt.stop(buildProc);
    const args = [cmd, voltFile, "--json", "--chip", chip.toLowerCase(), "--devices", devicesDir(), ...extra];
    if (settings.get("build.verboseBuild")) args.push("-v");

    let result = null, failed = false, reachedDone;
    const doneEvent = new Promise((resolve) => { reachedDone = resolve; });
    const proc = volt.run(args, {
        cwd: path.dirname(voltFile),
        onJSON: (o) => {
            if (o.stage) {
                if (o.stage === "error") failed = true;
                send("build:progress", o);
                if (o.stage === "done") {
                    result = o.artifact || "";
                    // `volt run` goes on to monitor the board it flashed.
                    if (cmd === "run" && result) trackMonitor(proc, result);
                    reachedDone();
                }
                return;
            }
            serialEvent(o);
        },
    });
    buildProc = proc;
    await Promise.race([proc.done, doneEvent]);
    if (buildProc === proc) buildProc = null;
    if (result !== null) return result;
    const { code, stderr } = await proc.done;
    if (!failed) {
        const why = stderr.join("\n").trim() || `volt ${cmd} exited with code ${code}`;
        send("build:progress", { stage: "error", message: why, percent: 0 });
    }
    return null;
}

ipcMain.handle("build_only", async (_, projectPath, voltFile, chip) => {
    const art = await voltBuild("build", voltFile, chip);
    return { ok: art !== null };
});

ipcMain.handle("export_binary", async (_, projectPath, voltFile, chip) => {
    // Build first so the exported image matches the current source.
    const art = await voltBuild("build", voltFile, chip);
    if (!art) return { ok: false, error: "Build failed." };

    const ext = path.extname(art).slice(1);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: "Export firmware binary",
        defaultPath: `${path.basename(projectPath)}.${ext}`,
        filters: [{ name: `Firmware (*.${ext})`, extensions: [ext] }],
    });
    if (canceled || !filePath) {
        send("build:progress", { stage: "done", message: "Export cancelled", percent: 100 });
        return { ok: false, cancelled: true };
    }
    try {
        fs.copyFileSync(art, filePath);
    } catch (e) {
        return { ok: false, error: e.message };
    }
    send("build:progress", { stage: "done", message: `Exported firmware → ${filePath}`, percent: 100 });
    return { ok: true, path: filePath, ext };
});

ipcMain.handle("run_project", async (_, projectPath, voltFile, port, chip) => {
    // esptool needs the port to itself.
    await stopMonitor();
    const newPort = await voltBuild("run", voltFile, chip, ["-p", port]);
    return newPort === null ? { ok: false } : { ok: true, port: newPort };
});

app.on("before-quit", () => {
    for (const p of [buildProc, monitorProc, toolchainProc]) {
        if (p && p.child) try { p.child.kill("SIGTERM"); } catch (_) {}
    }
});
