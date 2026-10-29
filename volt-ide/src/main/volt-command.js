// volt-command.js — one volt per computer. Volt IDE ships volt; this makes
// that copy the terminal's `volt` (~/.volt/bin/volt, where the standalone
// installer puts it) and points AI apps at it, so the terminal, agents and
// the IDE always run the same version, updated with the IDE.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const run = (cmd, args, opts) => new Promise((resolve, reject) =>
    execFile(cmd, args, { encoding: "utf8", ...opts }, (err, out) => err ? reject(err) : resolve(out)));
const voltCli = require("./volt-cli");

const BIN_DIR = path.join(os.homedir(), ".volt", "bin");
const LINK = path.join(BIN_DIR, "volt");
const MARK = "# Added by Volt IDE: the volt command";

function real(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }
async function version(p) {
    try { return (await run(p, ["version"], { timeout: 10_000 })).trim().replace(/^volt\s+/, ""); }
    catch (_) { return null; }
}

// loginShell asks the user's login shell (not this GUI process, whose PATH
// is minimal on macOS) where `volt` resolves and what PATH is.
async function loginShell() {
    const sh = process.env.SHELL || "/bin/zsh";
    try {
        const out = await run(sh, ["-ilc", 'echo "@@VOLT=$(command -v volt)"; echo "@@PATH=$PATH"'], { timeout: 8000 });
        const get = (k) => ((out.match(new RegExp(`^@@${k}=(.*)$`, "m")) || [])[1] || "").trim();
        return { shell: path.basename(sh), volt: get("VOLT"), path: get("PATH").split(":") };
    } catch (_) {
        return { shell: path.basename(sh), volt: "", path: [] };
    }
}

// state: "ok" (the terminal runs this IDE's volt), "missing", "other" (a
// different volt — usually a standalone install), or "unsupported".
async function state() {
    if (process.platform === "win32") return { state: "unsupported" };
    const bundled = voltCli.bin();
    const sh = await loginShell();
    const onPath = sh.path.includes(BIN_DIR);
    const resolves = sh.volt ? real(sh.volt) : null;
    const linked = real(LINK);
    const out = { bundled, link: LINK, onPath, shellVolt: sh.volt || null, version: await version(bundled) };
    if (resolves && resolves === real(bundled)) return { ...out, state: "ok" };
    if (!resolves) return { ...out, state: linked === real(bundled) ? "not_on_path" : "missing" };
    return { ...out, state: "other", other: sh.volt, otherVersion: await version(sh.volt) };
}

function rcFile(shell) {
    if (shell === "zsh") return path.join(os.homedir(), ".zshrc");
    if (shell === "bash") return path.join(os.homedir(), process.platform === "darwin" ? ".bash_profile" : ".bashrc");
    if (shell === "fish") return path.join(os.homedir(), ".config", "fish", "config.fish");
    return path.join(os.homedir(), ".profile");
}

// install links ~/.volt/bin/volt to this IDE's volt (a standalone volt there
// is kept as volt.standalone), adds ~/.volt/bin to PATH if asked, repoints
// any other `volt` link into a Volt IDE, and re-registers AI apps.
async function install({ addToPath = true } = {}) {
    if (process.platform === "win32") throw new Error("Not available on Windows yet.");
    const bundled = voltCli.bin();
    const done = [];
    fs.mkdirSync(BIN_DIR, { recursive: true });
    let st = null;
    try { st = fs.lstatSync(LINK); } catch (_) {}
    if (st && !st.isSymbolicLink()) {
        fs.renameSync(LINK, LINK + ".standalone");
        done.push(`kept your standalone volt as ${LINK}.standalone`);
    } else if (st) fs.unlinkSync(LINK);
    fs.symlinkSync(bundled, LINK);
    done.push(`${LINK} → Volt IDE's volt`);

    // Another `volt` link that points into a Volt IDE (e.g. ~/.local/bin/volt).
    const sh = await loginShell();
    if (sh.volt && sh.volt !== LINK) {
        try {
            const target = fs.readlinkSync(sh.volt);
            if (/\.app\/Contents\/|volt-ide|Volt IDE/.test(target) && target !== bundled) {
                fs.unlinkSync(sh.volt);
                fs.symlinkSync(bundled, sh.volt);
                done.push(`${sh.volt} → Volt IDE's volt`);
            }
        } catch (_) { /* a real file or not ours: PATH order decides */ }
    }

    if (addToPath && !sh.path.includes(BIN_DIR)) {
        const rc = rcFile(sh.shell);
        const line = sh.shell === "fish" ? `fish_add_path ${BIN_DIR}` : `export PATH="${BIN_DIR}:$PATH"`;
        const cur = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : "";
        if (!cur.includes(MARK)) {
            fs.mkdirSync(path.dirname(rc), { recursive: true });
            fs.appendFileSync(rc, `\n${MARK}\n${line}\n`);
            done.push(`added ${BIN_DIR} to PATH in ${rc} (open a new terminal)`);
        }
    }

    // AI apps registered with another volt binary: point them at this one.
    try {
        const apps = JSON.parse(await run(bundled, ["ai", "list", "--json"], { timeout: 20_000 }));
        for (const a of (apps.clients || []).filter(a => a.configured && a.stale)) {
            try { await run(bundled, ["ai", "setup", a.id], { timeout: 30_000 }); done.push(`${a.name} now uses this volt`); }
            catch (e) { done.push(`${a.name}: couldn't update (${e.message.split("\n")[0]})`); }
        }
    } catch (_) {}
    return { done, state: await state() };
}

module.exports = { state, install };
