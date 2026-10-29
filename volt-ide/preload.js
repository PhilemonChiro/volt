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
    pinTable: (chip) => ipcRenderer.invoke("pin_table", chip),
    busPins: (chip) => ipcRenderer.invoke("bus_pins", chip),
    findSymbols: (source) => ipcRenderer.invoke("find_symbols", source),
    stateDiagram: (source) => ipcRenderer.invoke("state_diagram", source),
    sequenceDiagram: (source) => ipcRenderer.invoke("sequence_diagram", source),

    // Serial
    scanDevices: () => ipcRenderer.invoke("scan_devices"),
    startMonitor: (port, baud) => ipcRenderer.invoke("start_monitor", port, baud),
    stopMonitor: () => ipcRenderer.invoke("stop_monitor"),
    isMonitoring: () => ipcRenderer.invoke("is_monitoring"),

    // Toolchain
    checkToolchain:   (chip) => ipcRenderer.invoke("check_toolchain", chip),
    diagnoseToolchain:(chip) => ipcRenderer.invoke("diagnose_toolchain", chip),
    repairToolchain:  (chip) => ipcRenderer.invoke("repair_toolchain", chip),
    toolchainComponents:(chip) => ipcRenderer.invoke("toolchain_components", chip),
    setupToolchain:   (chip) => ipcRenderer.invoke("setup_toolchain", chip),
    cancelToolchain:  () => ipcRenderer.invoke("cancel_toolchain"),
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
    gridYanked:    () => ipcRenderer.invoke("grid_yanked"),
    gridFetch:     (prefix, version) => ipcRenderer.invoke("grid_fetch", prefix, version),
    // GitHub sign-in + private collection (personal, unsigned, auth-scoped)
    authLogin:     () => ipcRenderer.invoke("auth_login"),
    publish: {
        prepare: (prefix, opts) => ipcRenderer.invoke("publish:prepare", prefix, opts),
        submit:  (prefix, opts) => ipcRenderer.invoke("publish:submit", prefix, opts),
        mine:    () => ipcRenderer.invoke("publish:mine"),
        list:    () => ipcRenderer.invoke("publish:list"),
    },
    authStatus:    () => ipcRenderer.invoke("auth_status"),
    authLogout:    () => ipcRenderer.invoke("auth_logout"),
    collectionList:    () => ipcRenderer.invoke("collection_list"),
    collectionInstall: (prefix, version) => ipcRenderer.invoke("collection_install", prefix, version),
    // Deep link from the Spark studio: volt://install/<prefix>/<version>.
    onDeepLinkInstall: (callback) =>
        ipcRenderer.on("deep_link_install", (_, data) => callback(data)),
    onOpenPath: (callback) =>
        ipcRenderer.on("open_path", (_, data) => callback(data)),
    takePendingOpenPath: () => ipcRenderer.invoke("open_path:take"),
    openExternal:  (url) => ipcRenderer.invoke("open_external", url),
    watchOpenFile: (path) => ipcRenderer.send("watch_open_file", path),
    onOpenFileChanged: (callback) => ipcRenderer.on("open_file:changed", (_, d) => callback(d)),
    // Project history (volt history): who changed what, with diffs.
    history: {
        record:  (project, author, message) => ipcRenderer.invoke("history:record", project, author, message),
        log:     (project, file, limit) => ipcRenderer.invoke("history:log", project, file, limit),
        show:    (project, hash) => ipcRenderer.invoke("history:show", project, hash),
        blame:   (project, file) => ipcRenderer.invoke("history:blame", project, file),
        restore: (project, hash, file) => ipcRenderer.invoke("history:restore", project, hash, file),
        undo:    (project, hash) => ipcRenderer.invoke("history:undo", project, hash),
        lastAgent: () => ipcRenderer.invoke("history:last-agent"),
    },
    // Library approvals (src/main/lib-trust.js) — the review sheet.
    libTrust: {
        info:     () => ipcRenderer.invoke("libtrust:info"),
        origins:  () => ipcRenderer.invoke("libtrust:origins"),
        pending:  () => ipcRenderer.invoke("libtrust:pending"),
        details:  (root, name) => ipcRenderer.invoke("libtrust:details", root, name),
        decide:   (d) => ipcRenderer.invoke("libtrust:decide", d),
        reset:    () => ipcRenderer.invoke("libtrust:reset"),
        setOpen:  (open) => ipcRenderer.send("libtrust:review-open", open),
        onEvent:  (callback) => ipcRenderer.on("libtrust:event", (_, msg) => callback(msg)),
    },
    // Volt IDE updates (src/main/updater.js).
    updates: {
        check:   () => ipcRenderer.invoke("update:check"),
        install: () => ipcRenderer.invoke("update:install"),
        onEvent: (callback) => ipcRenderer.on("update:event", (_, msg) => callback(msg)),
    },
    // The terminal's `volt` (src/main/volt-command.js).
    voltCommand: {
        state:   () => ipcRenderer.invoke("voltcmd:state"),
        install: (opts) => ipcRenderer.invoke("voltcmd:install", opts),
    },
    // Shipped library updates waiting on local changes (components/sdk-updates.js).
    sdkUpdates: {
        pending: () => ipcRenderer.invoke("sdk:pending"),
        take:    (names) => ipcRenderer.invoke("sdk:take", names),
        keep:    (names) => ipcRenderer.invoke("sdk:keep", names),
    },
    // macOS menu bar: actions in, project state out (greys items out).
    onMenuAction: (callback) => ipcRenderer.on("menu:action", (_, data) => callback(data)),
    setMenuState: (state) => ipcRenderer.send("menu:state", state),
    // Logging — fire-and-forget from the renderer; main writes to the
    // rotating log file. The reveal helper opens Finder/Explorer on it.
    log:           (level, message) => ipcRenderer.send("log_write", level, "renderer", message),
    logPath:       () => ipcRenderer.invoke("log_path"),
    logReveal:     () => ipcRenderer.invoke("log_reveal"),
    deviceSource:  (chip, sourceFile, prefix) => ipcRenderer.invoke("device_source", chip, sourceFile, prefix),
    libraryFiles:  (prefix) => ipcRenderer.invoke("library_files", prefix),
    libraryExamples: (prefix, name) => ipcRenderer.invoke("library_examples", prefix, name),

    // Events from main process
    onSerial: (callback) => ipcRenderer.on("serial:data", (_, data) => callback(data)),
    onSerialDisconnected: (callback) => ipcRenderer.on("serial:disconnected", (_, port) => callback(port)),
    onSerialConnected: (callback) => ipcRenderer.on("serial:connected", (_, port) => callback(port)),
    onSerialError: (callback) => ipcRenderer.on("serial:error", (_, message) => callback(message)),
    onBuild: (event, callback) => ipcRenderer.on("build:" + event, (_, data) => callback(data)),

    // AI agent bridge (src/main/agent-bridge.js)
    onAgentCall: (callback) => ipcRenderer.on("agent:call", (_, call) => callback(call)),
    agentReply: (id, result, error) => ipcRenderer.send("agent:reply", { id, result, error }),
    onAgentActivity: (callback) => ipcRenderer.on("agent:activity", (_, data) => callback(data)),
    agentSetConnected: (on) => ipcRenderer.invoke("agent:setConnected", on),
    agentVoltPath: () => ipcRenderer.invoke("agent:voltPath"),
    agentAI: (...args) => ipcRenderer.invoke("agent:ai", args),
    // Ask the connected AI app about selected code (src/main/inbox.js)
});
