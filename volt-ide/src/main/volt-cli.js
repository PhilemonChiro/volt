// volt-cli.js — runs the `volt` CLI that ships next to the IDE
// (bin/<platform>-<arch>/volt, built by scripts/build-volt.js) and streams
// its --json output line by line.

const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const logger = require("./logger");

// When packaged, __dirname is inside app.asar but bin/ is extracted to
// app.asar.unpacked (asarUnpack in package.json). In dev mode the replace is
// a no-op.
function bin() {
    return path.join(__dirname, "..", "..", "bin", `${process.platform}-${process.arch}`,
        process.platform === "win32" ? "volt.exe" : "volt")
        .replace(/app\.asar(?![\/\\]?unpacked)/, "app.asar.unpacked");
}

// run spawns `volt ...args`. Each stdout line that parses as JSON goes to
// onJSON; any other stdout/stderr line goes to onText. Returns
// { child, done } where done resolves to { code, stderr } once volt has
// exited (code is null when it was killed by a signal).
function run(args, { cwd, onJSON, onText } = {}) {
    const stderr = [];
    let child;
    try {
        child = spawn(bin(), args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
        return { child: null, done: Promise.resolve({ code: -1, stderr: [e.message] }) };
    }
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
        let obj;
        try { obj = JSON.parse(line); } catch { if (onText) onText(line); return; }
        if (onJSON) onJSON(obj);
    });
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
        stderr.push(line);
        if (stderr.length > 50) stderr.shift();
        if (onText) onText(line);
    });
    const done = new Promise((resolve) => {
        child.on("error", (e) => {
            const msg = e.code === "ENOENT"
                ? `volt not found at ${bin()}. Run 'npm run build:volt' in volt-ide.`
                : e.message;
            logger.log("error", "volt", msg);
            resolve({ code: -1, stderr: [msg] });
        });
        child.on("close", (code) => resolve({ code, stderr }));
    });
    return { child, done };
}

// stop asks a running volt to cancel (it stops its own children first) and
// waits for it to exit.
async function stop(proc) {
    if (!proc || !proc.child) return;
    try { proc.child.kill("SIGTERM"); } catch (_) {}
    await proc.done;
}

module.exports = { bin, run, stop };
