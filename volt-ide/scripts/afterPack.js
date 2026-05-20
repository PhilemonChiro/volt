// electron-builder afterPack hook — applies ad-hoc code signatures to the
// bundled Python interpreter on macOS so Gatekeeper allows the .app to
// spawn it. Without this, the .app's own ad-hoc sig (from electron-builder
// with identity: null) doesn't extend to extraResources binaries, and
// macOS may refuse to execute them.
//
// On Linux/Windows this is a no-op.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

exports.default = async function afterPack(context) {
    const { electronPlatformName, appOutDir, packager } = context;
    if (electronPlatformName !== "darwin") return;

    // The packaged .app's Resources dir.
    const appName = packager.appInfo.productFilename;
    const resourcesDir = path.join(appOutDir, `${appName}.app`, "Contents", "Resources");
    const sdkPython = path.join(resourcesDir, "sdk", "python");
    if (!fs.existsSync(sdkPython)) {
        console.warn("[afterPack] no bundled Python at", sdkPython);
        return;
    }

    // Find every Mach-O binary that needs an ad-hoc signature.
    const targets = [];
    function walk(dir) {
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            const st = fs.lstatSync(p);
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) walk(p);
            else if (isMachO(p)) targets.push(p);
        }
    }
    function isMachO(file) {
        try {
            const fd = fs.openSync(file, "r");
            const buf = Buffer.alloc(4);
            fs.readSync(fd, buf, 0, 4, 0);
            fs.closeSync(fd);
            const magic = buf.readUInt32BE(0);
            // Mach-O magic numbers: 32-bit, 64-bit, fat, plus their byte-swapped variants
            return [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe, 0xbebafeca].includes(magic);
        } catch { return false; }
    }

    walk(sdkPython);
    console.log(`[afterPack] ad-hoc signing ${targets.length} bundled Mach-O binaries`);
    for (const file of targets) {
        try {
            execFileSync("codesign", ["--force", "--sign", "-", file], { stdio: "pipe" });
        } catch (e) {
            // codesign sometimes complains about already-signed files; not fatal
            const msg = String(e.stderr || e.message);
            if (!/is already signed/.test(msg)) {
                console.warn(`[afterPack] codesign ${file} failed:`, msg.split("\n")[0]);
            }
        }
    }
    console.log("[afterPack] done");
};
