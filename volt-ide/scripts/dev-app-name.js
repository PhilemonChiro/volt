// postinstall hook (macOS) — `electron .` runs inside node_modules' Electron.app,
// so the menu bar and Dock say "Electron" with its icon. Rename that dev bundle
// to Volt IDE, give it our icon, and re-sign it ad hoc (editing Info.plist
// breaks its signature). Packaged builds don't need this. Never fails install.
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function main() {
    if (os.platform() !== "darwin") return;
    const appDir = path.join(__dirname, "..", "node_modules", "electron", "dist", "Electron.app");
    const plist = path.join(appDir, "Contents", "Info.plist");
    if (!fs.existsSync(plist)) return;
    for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
        execFileSync("plutil", ["-replace", key, "-string", "Volt IDE", plist]);
    }
    const icon = path.join(__dirname, "..", "build", "icon.icns");
    if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(appDir, "Contents", "Resources", "electron.icns"));
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appDir], { stdio: "ignore" });
    console.log("[dev-app-name] dev Electron.app now shows as Volt IDE");
}

try { main(); } catch (e) { console.warn("[dev-app-name] skipped:", e.message); }
