const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const compiler = require("./compiler");
const serial = require("./serial");
const projects = require("./projects");

// Disable sandbox for Linux compatibility
app.commandLine.appendSwitch("no-sandbox");

let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: "Volt IDE",
        frame: false, // custom title bar
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

    // Open DevTools in dev mode
    if (process.argv.includes("--dev")) {
        mainWindow.webContents.openDevTools();
    }
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

// ============================================================
// IPC handlers — called from renderer via preload bridge
// ============================================================

// Compiler
ipcMain.handle("compile_full", (_, source) => compiler.compileFull(source));
ipcMain.handle("check_code", (_, source) => compiler.checkCode(source));
ipcMain.handle("find_symbols", (_, source) => compiler.findSymbols(source));

// Projects
ipcMain.handle("create_project", (_, name, chip) => projects.createProject(name, chip));
ipcMain.handle("list_projects", () => projects.listProjects());
ipcMain.handle("read_file", (_, filePath) => projects.readFile(filePath));
ipcMain.handle("save_file", (_, filePath, content) => projects.saveFile(filePath, content));
ipcMain.handle("browse_volt_file", () => projects.browseVoltFile());

// Serial
ipcMain.handle("scan_devices", () => serial.scanDevices());
ipcMain.handle("start_monitor", (_, port, baud) => {
    serial.startMonitor(port, baud, (line) => {
        if (mainWindow) mainWindow.webContents.send("serial:data", { line });
    });
});
ipcMain.handle("stop_monitor", () => serial.stopMonitor());
ipcMain.handle("is_monitoring", () => serial.isMonitoring());

// Build pipeline
ipcMain.handle("run_project", (_, projectPath, voltFile, port, chip) => {
    return compiler.runPipeline(projectPath, voltFile, port, chip, (event, msg, progress) => {
        if (mainWindow) mainWindow.webContents.send("build:" + event, { message: msg, progress });
    });
});

// Window controls
ipcMain.handle("win_minimize", () => mainWindow?.minimize());
ipcMain.handle("win_maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
});
ipcMain.handle("win_close", () => mainWindow?.close());
