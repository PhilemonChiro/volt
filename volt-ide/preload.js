const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("volt", {
    ready: true,

    // App metadata
    getVersion: () => ipcRenderer.invoke("app_version"),
    platform: process.platform,   // "darwin" | "linux" | "win32"
    arch:     process.arch,

    // Window controls
    minimize: () => ipcRenderer.invoke("win_minimize"),
    maximize: () => ipcRenderer.invoke("win_maximize"),
    close: () => ipcRenderer.invoke("win_close"),

    // Projects
    createProject: (name, chip, template) => ipcRenderer.invoke("create_project", name, chip, template || ""),
    listProjects: () => ipcRenderer.invoke("list_projects"),
    resolveExample: (name) => ipcRenderer.invoke("resolve_example", name),
    readFile: (path) => ipcRenderer.invoke("read_file", path),
    saveFile: (path, content) => ipcRenderer.invoke("save_file", path, content),
    fileExists: (path) => ipcRenderer.invoke("file_exists", path),
    createToml: (projectPath, chip) => ipcRenderer.invoke("create_toml", projectPath, chip),
    saveRecent: (path) => ipcRenderer.invoke("save_recent", path),
    browseVoltFile: () => ipcRenderer.invoke("browse_volt_file"),
    browseFolder: () => ipcRenderer.invoke("browse_folder"),

    // Compiler
    compileFull: (source) => ipcRenderer.invoke("compile_full", source),
    checkCode: (source) => ipcRenderer.invoke("check_code", source),
    formatCode: (source) => ipcRenderer.invoke("format_code", source),
    findSymbols: (source) => ipcRenderer.invoke("find_symbols", source),
    stateDiagram: (source) => ipcRenderer.invoke("state_diagram", source),
    systemGraph: (source, expanded) => ipcRenderer.invoke("system_graph", source, expanded),

    // Serial
    scanDevices: () => ipcRenderer.invoke("scan_devices"),
    startMonitor: (port, baud) => ipcRenderer.invoke("start_monitor", port, baud),
    stopMonitor: () => ipcRenderer.invoke("stop_monitor"),
    isMonitoring: () => ipcRenderer.invoke("is_monitoring"),

    // Toolchain
    checkToolchain:   (chip) => ipcRenderer.invoke("check_toolchain", chip),
    diagnoseToolchain:(chip) => ipcRenderer.invoke("diagnose_toolchain", chip),
    repairToolchain:  (chip) => ipcRenderer.invoke("repair_toolchain", chip),
    toolchainFreeDisk:(chip) => ipcRenderer.invoke("toolchain_free_disk", chip),
    setupToolchain:   (chip) => ipcRenderer.invoke("setup_toolchain", chip),
    cancelToolchain:  () => ipcRenderer.invoke("cancel_toolchain"),
    onToolchainLog:   (callback) => ipcRenderer.on("toolchain:log",   (_, msg) => callback(msg)),
    onToolchainEvent: (callback) => {
        const handler = (_, evt) => callback(evt);
        ipcRenderer.on("toolchain:event", handler);
        return () => ipcRenderer.removeListener("toolchain:event", handler);
    },

    // Build
    buildOnly: (projectPath, voltFile, chip) =>
        ipcRenderer.invoke("build_only", projectPath, voltFile, chip),
    runProject: (projectPath, voltFile, port, chip) =>
        ipcRenderer.invoke("run_project", projectPath, voltFile, port, chip),
    exportBinary: (projectPath, voltFile, chip) =>
        ipcRenderer.invoke("export_binary", projectPath, voltFile, chip),

    // Settings
    settingsSchema:    () => ipcRenderer.invoke("settings_schema"),
    settingsAll:       () => ipcRenderer.invoke("settings_all"),
    settingsSet:       (key, value) => ipcRenderer.invoke("settings_set", key, value),
    settingsReset:     () => ipcRenderer.invoke("settings_reset"),
    settingsOpenFile:  () => ipcRenderer.invoke("settings_open_file"),
    onSettingsChanged: (callback) =>
        ipcRenderer.on("settings:changed", (_, data) => callback(data)),

    // Device library
    devicesList:   () => ipcRenderer.invoke("devices_list"),
    createDevice:  (spec) => ipcRenderer.invoke("create_device", spec),
    vlibInspectFile: () => ipcRenderer.invoke("vlib_inspect_file"),
    vlibInstall:   (token) => ipcRenderer.invoke("vlib_install", token),
    vlibInstalledList: () => ipcRenderer.invoke("vlib_installed_list"),
    vlibUninstall: (prefix) => ipcRenderer.invoke("vlib_uninstall", prefix),
    gridList:      () => ipcRenderer.invoke("grid_list"),
    gridFetch:     (prefix, version) => ipcRenderer.invoke("grid_fetch", prefix, version),
    openExternal:  (url) => ipcRenderer.invoke("open_external", url),
    // Logging — fire-and-forget from the renderer; main writes to the
    // rotating log file. The reveal helper opens Finder/Explorer on it.
    log:           (level, message) => ipcRenderer.send("log_write", level, "renderer", message),
    logPath:       () => ipcRenderer.invoke("log_path"),
    logReveal:     () => ipcRenderer.invoke("log_reveal"),
    deviceSource:  (chip, sourceFile) => ipcRenderer.invoke("device_source", chip, sourceFile),

    // Events from main process
    onSerial: (callback) => ipcRenderer.on("serial:data", (_, data) => callback(data)),
    onSerialDisconnected: (callback) => ipcRenderer.on("serial:disconnected", (_, port) => callback(port)),
    onSerialConnected: (callback) => ipcRenderer.on("serial:connected", (_, port) => callback(port)),
    onBuild: (event, callback) => ipcRenderer.on("build:" + event, (_, data) => callback(data)),
});
