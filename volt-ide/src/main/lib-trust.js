// lib-trust.js — the IDE side of library approvals (Go: cli/internal/libtrust).
//
// The IDE is the only approver. It keeps this computer's Ed25519 approval key
// encrypted with the OS keychain (safeStorage) and passes it to
// `volt trust approve` on stdin, so hashing and signing live in Go only.
// It watches the device libraries a build can use; the moment one appears or
// changes without an approval, it opens the review sheet in the window.
//
// Tamper evidence: the key's fingerprint is also kept keychain-encrypted, so a
// swapped local.pub or a deleted store shows up as a warning, not a pass.

const { app, safeStorage } = require("electron");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { bin } = require("./volt-cli");

const TRUST = path.join(os.homedir(), ".volt", "trust");
const KEY_FILE = path.join(TRUST, "local.key.enc");
const SNAPSHOTS = path.join(TRUST, "snapshots");
const QUARANTINE = path.join(TRUST, "quarantine");
const FRAMEWORK = "@framework";
const MAX_FILE = 256 * 1024;

let opts = null;        // { getWin, roots, logger, lastAgent }
let state = "starting"; // ready | unavailable | tampered
let stateDetail = "";
const deferred = new Map();   // root|name → hash the user said "decide later" to
const waiters = new Map();    // root|name → [resolve] (agents awaiting a decision)
let suppressUntil = 0;
let scanTimer = null;
let reviewOpen = false;

const pinFile = () => path.join(app.getPath("userData"), "trust-pin.bin");
const key = (root, name) => root + "|" + name;
const log = (lvl, msg) => opts && opts.logger && opts.logger.log(lvl, "trust", msg);

function volt(args, input) {
    return new Promise((resolve, reject) => {
        const child = execFile(bin(), ["trust", ...args], { maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
            if (err) {
                let msg = stderr.trim() || err.message;
                try { msg = JSON.parse(stdout).error || msg; } catch (_) {}
                return reject(new Error(msg));
            }
            resolve(stdout);
        });
        if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    });
}

// A project's own libraries live in <project>/devices; its approvals are
// keyed by the project (`volt trust --project`), not shared with others.
function isProjectRoot(root) {
    return path.basename(root) === "devices" && fs.existsSync(path.join(path.dirname(root), "volt.toml"));
}
const where = (root) => isProjectRoot(root) ? ["--project", path.dirname(root)] : ["--devices", root];

async function status(root) {
    return JSON.parse(await volt(["status", "--json", ...where(root)]));
}

// locked — a library nobody changes on this computer: Volt's own (as shipped)
// or one installed from the Grid. Changes to it are never approved; methods a
// project needs go in that project's own library instead.
function locked(l) {
    const src = (l && l.source) || "";
    if (!l || l.name === FRAMEWORK) return null;
    if (src.startsWith("registry:")) return "grid";
    if (src === "sdk-baseline" || l.bundled) return "official";
    return null;
}
const LOCKED_WHY = {
    official: "an official Volt library",
    grid: "installed from the Grid",
};
function lockedMessage(name, kind) {
    return `${name} is ${LOCKED_WHY[kind]}, so changes to it can't be approved. Put what this project needs in the project's own library (its devices/ folder), or suggest the change to the library's author.`;
}

function frameworkOf(root) { return path.join(path.dirname(root), "framework"); }
function libDir(root, name) { return name === FRAMEWORK ? frameworkOf(root) : path.join(root, name); }
function rootId(root) { return crypto.createHash("sha1").update(root).digest("hex").slice(0, 10); }
function snapDir(root, name) { return path.join(SNAPSHOTS, rootId(root), name === FRAMEWORK ? "_framework" : name); }

function readKey() {
    return safeStorage.decryptString(fs.readFileSync(KEY_FILE));
}

function pin(fp) { fs.writeFileSync(pinFile(), safeStorage.encryptString(fp)); }
function pinned() {
    try { return safeStorage.decryptString(fs.readFileSync(pinFile())); } catch (_) { return null; }
}

// copyTree copies regular files only (approved libraries hold no links).
function copyTree(src, dst) {
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name), d = path.join(dst, e.name);
        if (e.isDirectory()) copyTree(s, d);
        else if (e.isFile()) fs.copyFileSync(s, d);
    }
}

function listFiles(dir, base = dir, out = []) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name === ".DS_Store") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) listFiles(p, base, out);
        else out.push({ rel: path.relative(base, p).split(path.sep).join("/"), abs: p, link: e.isSymbolicLink() });
    }
    return out;
}

function readText(p) {
    try {
        const st = fs.statSync(p);
        if (st.size > MAX_FILE) return `(${st.size} bytes — too large to show)`;
        return fs.readFileSync(p, "utf8");
    } catch (_) { return null; }
}

// ── approving ──────────────────────────────────────────────────────────────

// approve signs names in root, then keeps a snapshot of what was approved (so a
// later change can be shown as a diff, or rejected back to it).
async function approve(root, names, source = "local", version = "") {
    if (state !== "ready") throw new Error(`Library approvals unavailable: ${stateDetail || state}`);
    const args = ["approve", ...names, ...where(root), "--source", source];
    if (version) args.push("--version", version);
    await volt(args, readKey());
    for (const n of names) {
        try { copyTree(libDir(root, n), snapDir(root, n)); } catch (e) { log("warn", `snapshot ${n}: ${e.message}`); }
        deferred.delete(key(root, n));
    }
    log("info", `approved ${names.join(", ")} (${source}) in ${root}`);
}

// approveOwnWrite is for the IDE's own flows (signed .vlib install, the
// library creator, uninstall): approve what was just written, plus the
// framework headers those flows splice prototypes into.
async function approveOwnWrite(names, source, version) {
    suppressUntil = Date.now() + 4000;
    for (const root of opts.roots()) {
        const st = await status(root).catch(() => null);
        if (!st || !st.setUp) continue;
        const present = new Set(st.libraries.map(l => l.name));
        const todo = [...names.filter(n => present.has(n)), ...(isProjectRoot(root) ? [] : [FRAMEWORK])];
        await approve(root, todo, source, version).catch(e => log("warn", e.message));
    }
    scanSoon();
}

// ── first run, pin check ───────────────────────────────────────────────────

async function setUp() {
    if (!safeStorage.isEncryptionAvailable()) {
        state = "unavailable"; stateDetail = "the OS keychain is not available";
        return;
    }
    const fp = pinned();
    const roots = opts.roots();
    const first = await status(roots[0]);
    if (!first.setUp && !fp) {
        // First run on this computer: make the key, approve the built-in
        // libraries that are byte-identical to the ones shipped inside volt.
        const priv = await volt(["init"]);
        fs.mkdirSync(TRUST, { recursive: true, mode: 0o700 });
        fs.writeFileSync(KEY_FILE, safeStorage.encryptString(priv), { mode: 0o600 });
        const st = await status(roots[0]);
        pin(st.key);
        state = "ready";
        let n = 0;
        for (const root of roots) {
            const s = await status(root);
            const same = s.libraries.filter(l => l.matchesBundled && l.state !== "approved").map(l => l.name);
            if (same.length) { await approve(root, same, "sdk-baseline"); n += same.length; }
        }
        log("info", `approvals set up; ${n} built-in libraries approved as shipped`);
        notify({ kind: "setup", approved: n });
        return;
    }
    if (!fp) { state = "tampered"; stateDetail = "approvals exist that this Volt IDE did not create"; return; }
    if (!first.setUp) { state = "tampered"; stateDetail = "the approval records were deleted"; return; }
    if (first.key !== fp) { state = "tampered"; stateDetail = "the approval key was replaced"; return; }
    if (!fs.existsSync(KEY_FILE)) { state = "tampered"; stateDetail = "this computer's approval key is missing"; return; }
    state = "ready";
}

// reset starts approvals over (after tampering): new key, everything re-reviewed.
async function reset() {
    const priv = await volt(["init", "--force"]);
    fs.writeFileSync(KEY_FILE, safeStorage.encryptString(priv), { mode: 0o600 });
    pin((await status(opts.roots()[0])).key);
    fs.rmSync(SNAPSHOTS, { recursive: true, force: true });
    state = "ready"; stateDetail = "";
    for (const root of opts.roots()) {
        const s = await status(root);
        const same = s.libraries.filter(l => l.matchesBundled).map(l => l.name);
        if (same.length) await approve(root, same, "sdk-baseline");
    }
    scanSoon(0);
}

// ── pending reviews ────────────────────────────────────────────────────────

async function pending() {
    const out = [];
    for (const root of opts.roots()) {
        let st;
        try { st = await status(root); } catch (e) { log("warn", e.message); continue; }
        // A library that was approved and is now byte-identical to the copy this
        // volt ships (a Volt update) is approved the way first setup approves it.
        const shipped = (st.libraries || []).filter(l => l.state === "changed" && l.matchesBundled).map(l => l.name);
        if (shipped.length) {
            try { await approve(root, shipped, "sdk-baseline"); log("info", `approved ${shipped.length} updated libraries as shipped`); }
            catch (e) { log("warn", e.message); }
        }
        for (const l of st.libraries || []) {
            if (l.state === "approved" || shipped.includes(l.name)) continue;
            out.push({ root, name: l.name, state: l.state, hash: l.hash, detail: l.detail || "",
                source: l.source || "", bundled: !!l.bundled, approvedAt: l.approvedAt || "", approvedHashes: l.approvedHashes || [],
                deferred: deferred.get(key(root, l.name)) === l.hash });
        }
    }
    return out;
}

// details is what the review sheet shows for one library.
async function details(root, name) {
    const dir = libDir(root, name);
    const items = await pending();
    let it = items.find(i => i.root === root && i.name === name);
    if (!it) {
        const l = ((await status(root).catch(() => null)) || {}).libraries?.find(x => x.name === name) || {};
        it = { root, name, state: "approved", approvedHashes: [], source: l.source || "", bundled: !!l.bundled };
    }
    // The snapshot is only a diff base if it really is an approved version.
    // Diff base: the snapshot of an approved version — this location's own,
    // else another location's (e.g. the copy Volt ships) — verified by digest.
    let prev = null, prevLabel = "";
    for (const r of [root, ...opts.roots().filter(x => x !== root)]) {
        const snap = snapDir(r, name);
        if (!fs.existsSync(snap)) continue;
        const h = (await volt(["digest", snap]).catch(() => "")).trim();
        if (h && it.approvedHashes.includes(h)) {
            prev = snap;
            prevLabel = r === root ? "the version you approved here" : `the approved copy in ${r.replace(os.homedir(), "~")}`;
            break;
        }
    }
    const files = listFiles(dir).map(f => ({
        path: f.rel, link: f.link, text: f.link ? `(symbolic link → ${safeLink(f.abs)})` : readText(f.abs),
        prev: prev ? readText(path.join(prev, f.rel)) : null,
    }));
    if (prev) for (const f of listFiles(prev)) {
        if (!files.some(x => x.path === f.rel)) files.push({ path: f.rel, text: null, prev: readText(f.abs), removed: true });
    }
    let device = null;
    try { device = JSON.parse(fs.readFileSync(path.join(dir, "device.json"), "utf8")); } catch (_) {}
    const agent = opts.lastAgent();
    const found = !fs.existsSync(snapDir(root, name)) && it.source === "sdk-baseline";
    const who = agent && Date.now() - agent.at < 15 * 60_000
        ? `An AI agent${agent.client ? ` (${agent.client})` : ""} was working in Volt when this changed.`
        : found ? "Found when library approvals were set up: it differs from the copy Volt ships."
        : "Changed outside Volt IDE (not by an install or the library creator).";
    const checks = name === FRAMEWORK ? { errors: [], warnings: [] } : require("./lib-publish").localCheck(dir);
    const lock = locked(it);
    return { ...it, files, hasPrevious: !!prev, prevLabel, who, framework: name === FRAMEWORK, device, checks,
        project: isProjectRoot(root), locked: lock, lockedMessage: lock ? lockedMessage(device && device.name || name, lock) : "",
        capabilities: device && { interface: device.interface, address: device.default_address, pins: device.pins, category: device.category } };
}

function safeLink(p) { try { return fs.readlinkSync(p); } catch (_) { return "?"; } }

// reject undoes the change: back to the last approved version when there is
// one, otherwise the library is moved to quarantine (the framework is kept).
async function reject(root, name) {
    const d = await details(root, name);
    const dir = libDir(root, name);
    if (d.hasPrevious) {
        copyTree(snapDir(root, name), dir);
        log("info", `rejected change to ${name}: restored approved version`);
        return { restored: true };
    }
    if (name === FRAMEWORK) throw new Error("There is no approved framework to go back to — reinstall Volt to repair it.");
    // An official library: put back the copy Volt ships.
    if (d.locked === "official" && !isProjectRoot(root)) {
        await new Promise((resolve, reject) => execFile(bin(), ["sdk", "sync", "--take", name], (err, _o, stderr) =>
            err ? reject(new Error(stderr.trim() || err.message)) : resolve()));
        await approve(root, [name], "sdk-baseline");
        log("info", `rejected change to ${name}: restored the shipped copy`);
        return { restored: true };
    }
    fs.mkdirSync(QUARANTINE, { recursive: true });
    const dest = path.join(QUARANTINE, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`);
    fs.renameSync(dir, dest);
    log("info", `rejected new library ${name}: moved to ${dest}`);
    return { quarantined: dest };
}

// decide records the user's decision from the review sheet and wakes agents
// waiting on it (library_request_approval).
async function decide({ root, name, decision, reason }) {
    const k = key(root, name);
    const agent = opts.lastAgent();
    const byAgent = waiters.has(k) || (agent && Date.now() - agent.at < 15 * 60_000);
    if (decision === "approve") {
        const st = await status(root).catch(() => null);
        const lock = locked(st && (st.libraries || []).find(l => l.name === name));
        if (lock) throw new Error(lockedMessage(name, lock));
        if (name !== FRAMEWORK) {
            const { errors } = require("./lib-publish").localCheck(libDir(root, name));
            if (errors.length) throw new Error(`${name} fails the library checks: ${errors[0]}`);
        }
        await approve(root, [name], byAgent ? "ai" : "local");
    }
    else if (decision === "reject") await reject(root, name);
    else if (decision === "later") {
        const it = (await pending()).find(i => i.root === root && i.name === name);
        if (it) deferred.set(key(root, name), it.hash);
    } else throw new Error("decision must be approve, reject or later");
    const ws = waiters.get(k) || [];
    waiters.delete(k);
    const out = { status: { approve: "approved", reject: "rejected", later: "later" }[decision], reason: reason || "" };
    ws.forEach(r => r(out));
    return out;
}

// requestApproval opens the review for an agent's library and waits.
async function requestApproval(name, timeoutMs = 15 * 60_000) {
    if (state !== "ready") throw new Error(`Library approvals unavailable: ${stateDetail || state}`);
    const items = (await pending()).filter(i => i.name === name);
    if (!items.length) {
        const known = (await Promise.all(opts.roots().map(r => status(r).catch(() => null))))
            .some(s => s && (s.libraries || []).some(l => l.name === name));
        if (!known) throw new Error(`No device library "${name}" in ${opts.roots().join(" or ")}.`);
        return { status: "approved", already: true };
    }
    const it = items[0];
    const lock = locked(it);
    if (lock) {
        return { status: "locked", error: lockedMessage(it.name, lock),
            next: "Undo your change to this library. Write the methods this project needs as a project library (library_write with scope: \"project\" and a new prefix), then call library_request_approval for it." };
    }
    // A library that fails the publish checks never reaches the user's review.
    const { errors } = require("./lib-publish").localCheck(libDir(it.root, it.name));
    if (errors.length) {
        return { status: "failed_checks", errors,
            next: "Fix every error in the library files (library_write again), then call library_request_approval. The user was not asked." };
    }
    const p = new Promise((resolve) => {
        const k = key(it.root, it.name);
        waiters.set(k, [...(waiters.get(k) || []), resolve]);
        setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
    });
    deferred.delete(key(it.root, it.name));
    notify({ kind: "review", focus: { root: it.root, name: it.name }, requestedBy: "agent" });
    return p;
}

// ── watching ───────────────────────────────────────────────────────────────

function notify(msg) {
    const win = opts.getWin();
    if (win && !win.isDestroyed()) win.webContents.send("libtrust:event", msg);
}

function scanSoon(delay = 700) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
}

async function scan() {
    if (Date.now() < suppressUntil) return scanSoon(suppressUntil - Date.now() + 100);
    if (state === "tampered") return notify({ kind: "tampered", detail: stateDetail });
    if (state !== "ready") return;
    const items = (await pending()).filter(i => !i.deferred);
    if (items.length || reviewOpen) notify({ kind: "review" }); // an open sheet refreshes its list
}

function watch() {
    for (const root of opts.roots()) {
        for (const dir of [root, frameworkOf(root)]) {
            try { fs.watch(dir, { recursive: true }, () => scanSoon()); }
            catch (e) { log("warn", `cannot watch ${dir}: ${e.message}`); }
        }
    }
}

async function start(o) {
    opts = o;
    try { await setUp(); } catch (e) { state = "unavailable"; stateDetail = e.message; log("error", e.message); }
    log("info", `approvals ${state}${stateDetail ? ": " + stateDetail : ""}`);
    watch();
    scanSoon(1500);
}

// ownLibraries lists the libraries made on this computer (by the user, the
// library creator or an AI) — not Volt's built-ins, not ones from the Grid.
async function ownLibraries() {
    const out = new Map();
    for (const root of opts.roots()) {
        const st = await status(root).catch(() => null);
        for (const l of (st && st.libraries) || []) {
            if (l.name === FRAMEWORK || out.has(l.name)) continue;
            const src = l.source || "";
            if (src === "sdk-baseline" || src.startsWith("registry:") || l.matchesBundled || l.bundled) continue;
            out.set(l.name, { name: l.name, root, dir: libDir(root, l.name), state: l.state, source: src });
        }
    }
    return [...out.values()];
}

// whereIs finds a library across the device roots, with how it was approved.
async function whereIs(name) {
    for (const root of opts.roots()) {
        const st = await status(root).catch(() => null);
        const l = st && (st.libraries || []).find(x => x.name === name);
        if (l) return { root, dir: libDir(root, name), state: l.state, source: l.source || "", matchesBundled: l.matchesBundled, bundled: l.bundled };
    }
    return null;
}

// Where each device library came from, for the Library's chips: "official"
// (approved as shipped by Volt; edited = differs from the copy this volt
// ships, when it still ships one), "grid",
// or "local" (made on this computer — yours, never replaced).
async function origins() {
    const out = {};
    for (const root of opts.roots()) {
        const st = await status(root).catch(() => null);
        for (const l of (st && st.libraries) || []) {
            if (out[l.name] || l.name === FRAMEWORK) continue;
            const src = l.source || "";
            // Bundled counts too (as in locked()): a Volt library re-approved
            // after an SDK update is recorded with source "local", yet it is
            // still the copy Volt ships.
            out[l.name] = src.startsWith("registry:") ? { kind: "grid" }
                : src === "sdk-baseline" || l.bundled ? { kind: "official", edited: !!l.bundled && !l.matchesBundled }
                : { kind: "local" };
        }
    }
    return out;
}

function info() { return { state, detail: stateDetail, roots: opts ? opts.roots() : [] }; }
function setReviewOpen(open) { reviewOpen = !!open; if (!open) scanSoon(); }

module.exports = { start, rescan: () => scanSoon(300), info, origins, whereIs, ownLibraries, pending, details, decide, requestApproval, approveOwnWrite, reset, setReviewOpen, FRAMEWORK };
