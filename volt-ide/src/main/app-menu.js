// macOS menu bar. Each item sends a "menu:action" to the renderer, which runs
// the same handler as the toolbar/shortcut. Items that need an open project
// are greyed out until the renderer reports one (setState).
const { app, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");

let _win = null;
let _state = { projectOpen: false };
let _recents = () => [];

function send(action, arg) {
    if (_win && !_win.isDestroyed()) _win.webContents.send("menu:action", { action, arg });
}

function item(label, action, accelerator, needsProject) {
    return { label, accelerator, enabled: !needsProject || _state.projectOpen, click: () => send(action) };
}

function recentMenu() {
    const list = _recents().filter(r => fs.existsSync(path.join(r.path, "main.volt"))).slice(0, 10);
    if (!list.length) return [{ label: "No Recent Projects", enabled: false }];
    return list.map(r => ({ label: r.name || path.basename(r.path), click: () => send("openRecent", r.path) }));
}

function build() {
    const dev = !app.isPackaged;
    return Menu.buildFromTemplate([
        {
            label: app.name,
            submenu: [
                { role: "about", label: "About Volt IDE" },
                item("Check for Updates…", "checkUpdates"),
                { type: "separator" },
                item("Settings…", "settings", "Cmd+,"),
                item("Install ‘volt’ Command…", "installVolt"),
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide", label: "Hide Volt IDE" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit", label: "Quit Volt IDE" },
            ],
        },
        {
            label: "File",
            submenu: [
                item("New Project…", "new", "Cmd+N"),
                item("Open…", "open", "Cmd+O"),
                { label: "Open Recent", submenu: recentMenu() },
                { type: "separator" },
                item("Save", "save", "Cmd+S", true),
                item("Export Firmware…", "export", "Cmd+E", true),
                { type: "separator" },
                item("Close Project", "close", "Cmd+W", true),
            ],
        },
        {
            label: "Edit",
            submenu: [
                { role: "undo" },
                { role: "redo" },
                { type: "separator" },
                { role: "cut" },
                { role: "copy" },
                { role: "paste" },
                { role: "selectAll" },
                { type: "separator" },
                item("Format Document", "format", "Shift+Alt+F", true),
            ],
        },
        {
            label: "Build",
            submenu: [
                item("Check", "check", "Cmd+B", true),
                item("Build and Flash", "run", "Cmd+R", true),
                item("Serial Monitor", "monitor", "Cmd+Shift+M", true),
            ],
        },
        {
            label: "View",
            submenu: [
                item("Hardware", "panel:hardware", "Cmd+1", true),
                item("Outline", "panel:outline", "Cmd+2", true),
                item("Library…", "panel:library", "Cmd+3", true),
                item("History", "panel:history", "Cmd+Shift+H", true),
                item("Wiring", "board", "Cmd+5", true),
                { type: "separator" },
                item("Add Part…", "addPart", "Cmd+Shift+A", true),
                { type: "separator" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" },
                ...(dev ? [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] : []),
            ],
        },
        { role: "windowMenu" },
        {
            role: "help",
            submenu: [
                item("Getting Started", "help"),
                item("Guided Tour", "tour"),
                { type: "separator" },
                { label: "Show Logs in Finder", click: () => shell.openPath(app.getPath("logs")) },
            ],
        },
    ]);
}

function refresh() {
    if (process.platform === "darwin") Menu.setApplicationMenu(build());
}

// install sets the menu for win. recents returns [{ name, path }], newest first.
function install(win, recents) {
    _win = win;
    _recents = recents;
    app.setAboutPanelOptions({ applicationName: "Volt IDE", applicationVersion: app.getVersion() });
    refresh();
}

function setState(state) {
    _state = { ..._state, ...state };
    refresh();
}

module.exports = { install, setState, refresh };
