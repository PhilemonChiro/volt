// updater.js — Volt IDE updates itself (and so its bundled volt, the device
// library and the terminal's volt command) from dl.voltembedded.com/ide,
// where scripts/release-ide.sh publishes. Downloads in the background, then
// asks to restart. Packaged builds only.

const { app } = require("electron");

let autoUpdater = null;
let getWin = () => null;
let logger = null;
let ready = null; // version downloaded and waiting for a restart

function send(msg) {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send("update:event", msg);
}

function start(opts) {
    getWin = opts.getWin;
    logger = opts.logger;
    if (!app.isPackaged) return;
    ({ autoUpdater } = require("electron-updater"));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-downloaded", (info) => {
        ready = info.version;
        logger.log("info", "update", `Volt IDE ${info.version} downloaded`);
        send({ kind: "ready", version: info.version });
    });
    autoUpdater.on("error", (e) => logger.log("warn", "update", e.message));
    check(false);
    setInterval(() => check(false), 6 * 60 * 60 * 1000);
}

// check looks for an update; from the menu it reports the outcome.
async function check(fromMenu) {
    if (!app.isPackaged) {
        if (fromMenu) send({ kind: "info", text: "Updates apply to installed Volt IDE builds, not development runs." });
        return;
    }
    if (ready) { send({ kind: "ready", version: ready }); return; }
    try {
        const r = await autoUpdater.checkForUpdates();
        const v = r && r.updateInfo && r.updateInfo.version;
        if (fromMenu) {
            send(v && v !== app.getVersion()
                ? { kind: "info", text: `Downloading Volt IDE ${v}…` }
                : { kind: "info", text: `Volt IDE ${app.getVersion()} is the latest.` });
        }
    } catch (e) {
        if (fromMenu) send({ kind: "info", text: `Couldn't check for updates: ${e.message}` });
    }
}

function install() {
    if (ready && autoUpdater) autoUpdater.quitAndInstall();
}

module.exports = { start, check, install };
