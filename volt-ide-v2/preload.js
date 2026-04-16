const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("volt", {
    ready: true,

    // Window controls
    minimize: () => ipcRenderer.invoke("win_minimize"),
    maximize: () => ipcRenderer.invoke("win_maximize"),
    close: () => ipcRenderer.invoke("win_close"),

    // Projects
    createProject: (name, chip) => ipcRenderer.invoke("create_project", name, chip),
    listProjects: () => ipcRenderer.invoke("list_projects"),
    readFile: (path) => ipcRenderer.invoke("read_file", path),
    saveFile: (path, content) => ipcRenderer.invoke("save_file", path, content),
    browseVoltFile: () => ipcRenderer.invoke("browse_volt_file"),

    // Compiler
    compileFull: (source) => ipcRenderer.invoke("compile_full", source),
    checkCode: (source) => ipcRenderer.invoke("check_code", source),
    findSymbols: (source) => ipcRenderer.invoke("find_symbols", source),

    // Serial
    scanDevices: () => ipcRenderer.invoke("scan_devices"),
    startMonitor: (port, baud) => ipcRenderer.invoke("start_monitor", port, baud),
    stopMonitor: () => ipcRenderer.invoke("stop_monitor"),
    isMonitoring: () => ipcRenderer.invoke("is_monitoring"),

    // Toolchain
    checkToolchain: (chip) => ipcRenderer.invoke("check_toolchain", chip),
    setupToolchain: (chip) => ipcRenderer.invoke("setup_toolchain", chip),
    onToolchainLog: (callback) => ipcRenderer.on("toolchain:log", (_, msg) => callback(msg)),

    // Build
    buildOnly: (projectPath, voltFile, chip) =>
        ipcRenderer.invoke("build_only", projectPath, voltFile, chip),
    runProject: (projectPath, voltFile, port, chip) =>
        ipcRenderer.invoke("run_project", projectPath, voltFile, port, chip),

    // Events from main process
    onSerial: (callback) => ipcRenderer.on("serial:data", (_, data) => callback(data)),
    onBuild: (event, callback) => ipcRenderer.on("build:" + event, (_, data) => callback(data)),
});
