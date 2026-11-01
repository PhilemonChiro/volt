// agent-setup.js — installs Claude Code or Codex, and starts their own sign-in,
// from Settings → AI agents. Only the vendors' official installers and login
// commands are run, each after the user clicks; Volt never sees keys or
// tokens. Output streams to the renderer as "assistant:setup" events.

const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const logger = require("./logger");

const WIN = process.platform === "win32";
// Codex downloaded straight from OpenAI's GitHub releases lands here
// (codex-host.js looks in this folder too).
const CODEX_DIR = path.join(os.homedir(), ".volt", "agents", "codex");

let sendToRenderer = () => {};
let locateAgent = {};          // { claude: () => path, codex: () => path }
const running = new Map();      // agent → { child, cancelled }

function init({ send, locate }) {
    sendToRenderer = send;
    locateAgent = locate;
}

function out(agent, text) { sendToRenderer("assistant:setup", { agent, text: String(text) }); }
function finish(agent, ok, message) {
    running.delete(agent);
    logger.log(ok ? "info" : "warn", "assistant", `setup ${agent}: ${message || (ok ? "done" : "failed")}`);
    sendToRenderer("assistant:setup", { agent, done: true, ok, message });
}

// PATH with the usual install folders, so freshly installed tools are found.
function envPath() {
    const home = os.homedir();
    const extra = WIN ? [path.join(home, "AppData", "Roaming", "npm"), path.join(home, ".local", "bin")]
        : [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    return { ...process.env, PATH: [...extra, process.env.PATH || ""].join(path.delimiter) };
}

function which(cmd) {
    if (WIN) return new Promise(r => execFile("where", [cmd], { env: envPath() }, (e, o) => r(!e && o.trim() ? o.trim().split(/\r?\n/)[0] : null)));
    return new Promise(r => execFile(process.env.SHELL || "/bin/zsh", ["-lc", `command -v ${cmd}`], { timeout: 8000, env: envPath() },
        (e, o) => r(!e && o.trim() ? o.trim().split("\n").pop() : null)));
}

// Run a command, streaming its output; resolves to the exit code.
function stream(agent, bin, args, opts = {}) {
    return new Promise((resolve) => {
        out(agent, `$ ${opts.show || [bin, ...args].join(" ")}\n`);
        const child = spawn(bin, args, { env: envPath(), stdio: ["pipe", "pipe", "pipe"], ...opts.spawn });
        const job = running.get(agent);
        if (job) job.child = child;
        child.stdout.on("data", d => out(agent, d));
        child.stderr.on("data", d => out(agent, d));
        child.on("error", (e) => { out(agent, e.message + "\n"); resolve(-1); });
        child.on("exit", (code) => resolve(code == null ? -1 : code));
    });
}

// ---- install ----

/** What install(agent) will run, shown on the card before the user clicks. */
async function plan(agent) {
    if (agent === "claude") {
        return WIN ? { how: "script", show: "irm https://claude.ai/install.ps1 | iex" }
            : { how: "script", show: "curl -fsSL https://claude.ai/install.sh | bash" };
    }
    if (await which("npm")) return { how: "npm", show: "npm install -g @openai/codex" };
    if (!WIN && await which("brew")) return { how: "brew", show: "brew install codex" };
    return { how: "download", show: "Download Codex from github.com/openai/codex/releases" };
}

async function install(agent) {
    if (running.has(agent)) return false;
    running.set(agent, {});
    const p = await plan(agent);
    try {
        let code;
        if (agent === "claude") {
            code = WIN
                ? await stream(agent, "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"], { show: p.show })
                : await stream(agent, "/bin/bash", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"], { show: p.show });
        } else if (p.how === "npm") {
            code = await stream(agent, await which("npm"), ["install", "-g", "@openai/codex"], { show: p.show });
        } else if (p.how === "brew") {
            code = await stream(agent, await which("brew"), ["install", "codex"], { show: p.show });
        } else {
            code = await downloadCodex(agent) ? 0 : 1;
        }
        if (running.get(agent)?.cancelled) return finish(agent, false, "Cancelled.");
        const found = code === 0 && await locateAgent[agent]();
        finish(agent, !!found, found ? `Installed: ${found}` : code === 0 ? "Installed, but Volt can't find it yet. Set its path below." : `The installer stopped (exit ${code}).`);
    } catch (e) { finish(agent, false, e.message); }
    return true;
}

// ---- Codex from GitHub releases (no Node or Homebrew needed) ----

function codexTarget() {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    if (process.platform === "darwin") return `${arch}-apple-darwin`;
    if (process.platform === "linux") return `${arch}-unknown-linux-musl`;
    if (WIN) return `${arch}-pc-windows-msvc.exe`;
    throw new Error(`Codex has no download for ${process.platform}`);
}

function get(agent, url, file, onProgress, redirects = 5) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { "User-Agent": "volt-ide" } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                res.resume();
                return resolve(get(agent, res.headers.location, file, onProgress, redirects - 1));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed (HTTP ${res.statusCode})`)); }
            const total = Number(res.headers["content-length"]) || 0;
            let got = 0;
            const sink = fs.createWriteStream(file);
            res.on("data", (d) => { got += d.length; onProgress(got, total); });
            res.pipe(sink);
            sink.on("finish", () => resolve());
            sink.on("error", reject);
            res.on("error", reject);
        });
        req.on("error", reject);
        const job = running.get(agent);
        if (job) job.req = req;
    });
}

async function downloadCodex(agent) {
    const target = codexTarget();
    const asset = `codex-${target}.${WIN ? "zip" : "tar.gz"}`;
    const url = `https://github.com/openai/codex/releases/latest/download/${asset}`;
    const bin = path.join(CODEX_DIR, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const archive = path.join(CODEX_DIR, asset);
    out(agent, `Downloading ${url}\n`);
    let shown = -1;
    await get(agent, url, archive, (got, total) => {
        const pct = total ? Math.floor(got * 100 / total) : -1;
        if (pct >= 0 && pct >= shown + 10) { shown = pct; out(agent, `${pct}% of ${Math.round(total / 1e6)} MB\n`); }
    });
    if (running.get(agent)?.cancelled) return false;
    const code = await stream(agent, "tar", ["-xf", archive, "-C", bin], { show: `tar -xf ${asset}` });
    try { fs.unlinkSync(archive); } catch (_) {}
    if (code !== 0) return false;
    const exe = path.join(bin, WIN ? "codex.exe" : "codex");
    fs.renameSync(path.join(bin, `codex-${target}`), exe);
    if (!WIN) fs.chmodSync(exe, 0o755);
    out(agent, `Installed ${exe}\n`);
    return true;
}

// ---- sign in ----

/** login(agent) — run the agent's own sign-in. It opens the user's browser;
 *  the agent stores its own credentials. */
async function login(agent) {
    if (running.has(agent)) return false;
    const bin = await locateAgent[agent]();
    if (!bin) { finish(agent, false, "Install it first."); return false; }
    running.set(agent, {});
    const args = agent === "claude" ? ["auth", "login", "--claudeai"] : ["login"];
    const code = await stream(agent, bin, args, { show: `${path.basename(bin)} ${args.join(" ")}` });
    if (running.get(agent)?.cancelled) { finish(agent, false, "Cancelled."); return true; }
    finish(agent, code === 0, code === 0 ? "Signed in." : `Sign-in didn't finish (exit ${code}).`);
    return true;
}

/** write(agent, text) — type into the running step (a sign-in that asks for a pasted code). */
function write(agent, text) {
    const job = running.get(agent);
    try { job && job.child && job.child.stdin.write(String(text).trim() + "\n"); return true; } catch (_) { return false; }
}

function cancel(agent) {
    const job = running.get(agent);
    if (!job) return;
    job.cancelled = true;
    try { job.child && job.child.kill(); } catch (_) {}
    try { job.req && job.req.destroy(); } catch (_) {}
}

function busy() { return [...running.keys()]; }

module.exports = { init, plan, install, login, write, cancel, busy, CODEX_DIR };
