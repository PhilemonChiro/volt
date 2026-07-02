// postinstall hook — ensure Electron's chrome-sandbox helper is owned by root
// and setuid (mode 4755). Without this, launching `electron .` directly (e.g. a
// desktop icon or `npx electron .`) aborts with:
//   "The SUID sandbox helper binary was found, but is not configured correctly."
// npm reinstalls reset these perms to the invoking user, so this re-applies them
// on every install. Requires root: uses passwordless sudo when available, and
// otherwise prints the manual command without failing the install.
//
// Only relevant on Linux. No-op on macOS/Windows. Never fails `npm install`.

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function main() {
    if (os.platform() !== "linux") return;

    const sandbox = path.join(
        __dirname, "..", "node_modules", "electron", "dist", "chrome-sandbox"
    );
    if (!fs.existsSync(sandbox)) return;

    // Already root-owned and setuid? Nothing to do.
    try {
        const st = fs.statSync(sandbox);
        if (st.uid === 0 && (st.mode & 0o4000) !== 0) return;
    } catch (_) { /* fall through and try to fix */ }

    const manual = `sudo chown root:root "${sandbox}" && sudo chmod 4755 "${sandbox}"`;

    try {
        const uid = typeof process.getuid === "function" ? process.getuid() : -1;
        if (uid === 0) {
            execFileSync("chown", ["root:root", sandbox], { stdio: "ignore" });
            execFileSync("chmod", ["4755", sandbox], { stdio: "ignore" });
        } else {
            // Only attempt sudo if it needs no password, so npm install never hangs.
            execFileSync("sudo", ["-n", "true"], { stdio: "ignore" });
            execFileSync("sudo", ["-n", "chown", "root:root", sandbox], { stdio: "ignore" });
            execFileSync("sudo", ["-n", "chmod", "4755", sandbox], { stdio: "ignore" });
        }
        console.log("[volt-ide] chrome-sandbox set root:root 4755 (Electron SUID sandbox ready).");
    } catch (_) {
        console.warn("[volt-ide] Could not set chrome-sandbox perms automatically.");
        console.warn("[volt-ide] To launch `electron .` directly, run once:");
        console.warn("  " + manual);
        console.warn("[volt-ide] (Not needed for `npm start` / ./start.sh, which disable the sandbox.)");
    }
}

main();
