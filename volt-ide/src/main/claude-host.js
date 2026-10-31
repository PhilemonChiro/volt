// claude-host.js — runs the user's own, unmodified `claude` binary (Claude Code,
// signed in with their own plan; Volt holds no key and never reads tokens) as
// the Assistant panel's agent. One long-lived process per project, driven over
// stream-json on stdin/stdout. Permission prompts come back to the panel as
// approval cards; the chat log and session id live in <project>/.volt/.

const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const logger = require("./logger");

const SYSTEM_PROMPT = `You are the assistant inside Volt IDE. You write Volt firmware for the project open in the IDE.
Volt is a new language: never write it from memory or by analogy with C, Arduino or Python.
Loop: volt_spec once -> device_card for each device -> ide_read -> change the program only with ide_edit -> check -> fix until ok -> review and compare with the request.
Build or flash only when the user asks (ide_build, ide_run), then confirm with ide_serial.
Answer briefly in plain language; the user sees your edits in the editor.`;

// Auto-approved: read-only, or visible and undoable in the editor.
const ALLOWED = ["volt_spec", "device_card", "list_devices", "check", "review", "ide_status",
    "ide_read", "ide_edit", "ide_diagnostics", "ide_show", "ide_screenshot", "ide_serial", "ide_history", "ide_highlight"]
    .map(t => "mcp__volt__" + t).concat(["Read"]);
// Removed from the model's tool list: file-based build/format
// (the IDE owns the project), and the biggest definitions the chat doesn't need.
const DISALLOWED = ["ide_note_events", "ide_ask", "ide_point",
    "ide_walkthrough", "ide_select", "build", "format"].map(t => "mcp__volt__" + t);

const MODELS = ["sonnet", "opus"];

let sendToRenderer = () => {};
let voltBin = () => "volt";
let getSetting = () => undefined;
const procs = new Map(); // project → proc

function init({ send, bin, setting }) {
    sendToRenderer = send;
    voltBin = bin;
    getSetting = setting;
}

// ---- finding the binary and the user's sign-in ----

let found = null; // cached path
function candidates() {
    const home = os.homedir();
    const exe = process.platform === "win32" ? "claude.exe" : "claude";
    const dirs = [path.join(home, ".local", "bin"), path.join(home, ".claude", "local"),
        "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
        ...(process.env.PATH || "").split(path.delimiter)];
    if (process.platform === "win32") dirs.push(path.join(home, "AppData", "Roaming", "npm"));
    return dirs.filter(Boolean).map(d => path.join(d, exe));
}
function loginShellWhich() {
    if (process.platform === "win32") return Promise.resolve(null);
    return new Promise((resolve) => execFile(process.env.SHELL || "/bin/zsh", ["-lc", "command -v claude"],
        { timeout: 5000 }, (err, out) => resolve(!err && out.trim() ? out.trim().split("\n").pop() : null)));
}
async function locate() {
    const custom = getSetting("assistant.claudePath");
    if (custom && fs.existsSync(custom)) return custom;
    if (found && fs.existsSync(found)) return found;
    found = candidates().find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } })
        || await loginShellWhich();
    return found;
}
function run(bin, args) {
    return new Promise((resolve) => execFile(bin, args, { timeout: 15000 },
        (err, stdout) => resolve({ ok: !err, out: String(stdout || "") })));
}

/** status() → {found, path, version, loggedIn, authMethod} — the panel's setup state. */
async function status() {
    const bin = await locate();
    if (!bin) return { found: false };
    const [v, a] = await Promise.all([run(bin, ["--version"]), run(bin, ["auth", "status"])]);
    let auth = {};
    try { auth = JSON.parse(a.out); } catch (_) {}
    return { found: true, path: bin, version: v.out.trim().split(" ")[0], loggedIn: !!auth.loggedIn,
        authMethod: auth.authMethod || null };
}

// ---- per-project chat log and session ----

function dir(project) { return path.join(project, ".volt"); }
function logFile(project) { return path.join(dir(project), "assistant.jsonl"); }
function metaFile(project) { return path.join(dir(project), "assistant.json"); }
function readMeta(project) { try { return JSON.parse(fs.readFileSync(metaFile(project), "utf8")); } catch { return {}; } }
function writeMeta(project, meta) {
    fs.mkdirSync(dir(project), { recursive: true });
    fs.writeFileSync(metaFile(project), JSON.stringify(meta, null, 2));
}

/** history(project) → {entries, busy, model}: the stored chat, for the panel to draw. */
function history(project) {
    let text = "";
    try { text = fs.readFileSync(logFile(project), "utf8"); } catch (_) {}
    const entries = [];
    for (const line of text.split("\n")) { if (line.trim()) try { entries.push(JSON.parse(line)); } catch (_) {} }
    const p = procs.get(project);
    return { entries, busy: !!(p && p.busy), pending: p ? [...p.approvals.values()].map(a => a.entry) : [] };
}

// emit sends an entry to the panel; keep=true also appends it to the chat log.
function emit(project, entry, keep = true) {
    entry.at = entry.at || new Date().toISOString();
    if (keep) {
        try {
            fs.mkdirSync(dir(project), { recursive: true });
            fs.appendFileSync(logFile(project), JSON.stringify(entry) + "\n");
        } catch (e) { logger.log("warn", "assistant", `chat log: ${e.message}`); }
    }
    sendToRenderer("assistant:event", { project, entry });
}

// ---- the process ----

function model() {
    const m = getSetting("assistant.model");
    return MODELS.includes(m) ? m : "sonnet";
}

async function start(project) {
    const bin = await locate();
    if (!bin) throw new Error("Claude Code is not installed. Install it, sign in with `claude`, then try again.");
    const meta = readMeta(project);
    const mcp = { mcpServers: { volt: { type: "stdio", command: voltBin(), args: ["mcp"] } } };
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--include-partial-messages",
        "--mcp-config", JSON.stringify(mcp), "--strict-mcp-config",
        "--permission-prompt-tool", "stdio",
        "--setting-sources", "project", "--disable-slash-commands",
        "--tools", "Read,Edit,Write",
        "--model", model(), "--system-prompt", SYSTEM_PROMPT,
        "--allowedTools", ALLOWED.join(" "), "--disallowedTools", DISALLOWED.join(" ")];
    let resumed = false;
    if (meta.session && meta.started) { args.push("--resume", meta.session); resumed = true; }
    else {
        meta.session = meta.session || crypto.randomUUID();
        args.push("--session-id", meta.session);
    }

    const child = spawn(bin, args, { cwd: project, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const p = { child, project, busy: false, approvals: new Map(), model: model(), session: meta.session,
        stderr: [], text: "", nextReq: 1 };
    procs.set(project, p);
    logger.log("info", "assistant", `started claude (${p.model}) for ${project}${resumed ? ", resuming" : ""}`);

    const write = (o) => { try { child.stdin.write(JSON.stringify(o) + "\n"); } catch (_) {} };
    p.write = write;

    let buf = "";
    child.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }
            try { onEvent(p, ev); } catch (e) { logger.log("warn", "assistant", `event: ${e.message}`); }
        }
    });
    child.stderr.on("data", (d) => {
        p.stderr.push(...String(d).split("\n").filter(Boolean));
        if (p.stderr.length > 30) p.stderr.splice(0, p.stderr.length - 30);
    });
    child.on("error", (e) => { emit(project, { t: "error", text: e.message }); });
    child.on("exit", (code, signal) => {
        if (procs.get(project) === p) procs.delete(project);
        if (p.busy) {
            const why = p.stderr.slice(-3).join(" ") || `exited (${signal || code})`;
            emit(project, { t: "error", text: p.killed ? "Stopped." : `Claude Code stopped: ${why}` });
            sendToRenderer("assistant:event", { project, entry: { t: "busy", on: false } });
        }
        // A resume that fails (session gone) starts fresh next time.
        if (resumed && !p.sawInit) { const m = readMeta(project); delete m.started; delete m.session; writeMeta(project, m); }
    });

    write({ type: "control_request", request_id: "init", request: { subtype: "initialize" } });
    return p;
}

function onEvent(p, ev) {
    const project = p.project;
    switch (ev.type) {
    case "system":
        if (ev.subtype === "init") {
            p.sawInit = true;
            const volt = (ev.mcp_servers || []).find(s => s.name === "volt");
            if (volt && volt.status !== "connected") emit(project, { t: "error", text: `Volt tools did not start (${volt.status}).` });
            const meta = readMeta(project);
            if (!meta.started || meta.session !== ev.session_id) writeMeta(project, { ...meta, session: ev.session_id, started: true });
        }
        break;
    case "stream_event": {
        const e = ev.event || {};
        if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta") {
            p.text += e.delta.text;
            emit(project, { t: "delta", text: e.delta.text }, false);
        }
        break;
    }
    case "assistant":
        for (const c of (ev.message && ev.message.content) || []) {
            if (c.type === "text" && c.text.trim()) emit(project, { t: "text", text: c.text });
            if (c.type === "tool_use") emit(project, { t: "tool", id: c.id, name: shortName(c.name), input: c.input });
        }
        p.text = "";
        break;
    case "user":
        for (const c of (ev.message && ev.message.content) || []) {
            if (c.type !== "tool_result") continue;
            const body = typeof c.content === "string" ? c.content
                : (c.content || []).filter(x => x.type === "text").map(x => x.text).join("\n");
            emit(project, { t: "tool_result", id: c.tool_use_id, ok: !c.is_error, summary: body.slice(0, 400) });
        }
        break;
    case "control_request": {
        const r = ev.request || {};
        if (r.subtype === "can_use_tool") return askApproval(p, ev.request_id, r);
        break;
    }
    case "result":
        p.busy = false;
        if (p.text.trim()) emit(project, { t: "text", text: p.text }); // the part streamed before Stop
        p.text = "";
        emit(project, { t: "result", ok: !ev.is_error, turns: ev.num_turns, ms: ev.duration_ms,
            error: p.stopping ? "Stopped." : ev.is_error ? (ev.result || ev.subtype) : undefined });
        p.stopping = false;
        sendToRenderer("assistant:event", { project, entry: { t: "busy", on: false } });
        break;
    }
}

function shortName(name) { return String(name || "").replace(/^mcp__volt__/, ""); }

function askApproval(p, requestId, r) {
    const tool = shortName(r.tool_name);
    const input = r.input || {};
    // Program edits go through ide_edit so the user sees them and can undo.
    if ((tool === "Edit" || tool === "Write") && /\.volt$/i.test(input.file_path || "")) {
        return answer(p, requestId, { behavior: "deny", message: "In Volt IDE, change .volt files only with ide_edit (the user sees it and can undo)." });
    }
    const entry = { t: "approval", id: requestId, tool, input, reason: r.decision_reason || r.blocked_path || undefined };
    p.approvals.set(requestId, { entry, input });
    emit(p.project, entry);
}

function answer(p, requestId, response) {
    p.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
}

// ---- panel actions ----

/** send(project, text) — a user turn; starts (or resumes) the project's process. */
async function send(project, text) {
    if (!project) throw new Error("Open a project first.");
    text = String(text || "").trim();
    if (!text) return;
    let p = procs.get(project);
    if (p && p.model !== model()) { close(project); p = null; } // model changed: resume with the new one
    if (!p) p = await start(project);
    if (p.busy) throw new Error("Claude is still working. Stop it or wait for the reply.");
    p.busy = true;
    emit(project, { t: "user", text });
    sendToRenderer("assistant:event", { project, entry: { t: "busy", on: true } });
    p.write({ type: "user", message: { role: "user", content: text } });
}

/** decide(project, requestId, allow) — the user's answer to an approval card. */
function decide(project, requestId, allow) {
    const p = procs.get(project);
    const a = p && p.approvals.get(requestId);
    if (!a) return false;
    p.approvals.delete(requestId);
    answer(p, requestId, allow ? { behavior: "allow", updatedInput: a.input }
        : { behavior: "deny", message: "The user declined this." });
    emit(project, { t: "decision", id: requestId, allow: !!allow });
    return true;
}

/** stop(project) — interrupt the current turn; kill if it doesn't stop. */
function stop(project) {
    const p = procs.get(project);
    if (!p || !p.busy) return;
    p.stopping = true;
    for (const id of p.approvals.keys()) decide(project, id, false);
    p.write({ type: "control_request", request_id: "int-" + p.nextReq++, request: { subtype: "interrupt" } });
    setTimeout(() => { if (p.busy && procs.get(project) === p) { p.killed = true; p.child.kill(); } }, 5000);
}

/** newChat(project) — end the process and start the next message in a fresh session. */
function newChat(project) {
    close(project);
    try {
        const f = logFile(project);
        if (fs.existsSync(f)) fs.renameSync(f, path.join(dir(project), `assistant-${Date.now()}.jsonl`));
    } catch (_) {}
    const meta = readMeta(project);
    delete meta.session; delete meta.started;
    writeMeta(project, meta);
}

function close(project) {
    const p = procs.get(project);
    if (!p) return;
    procs.delete(project);
    p.killed = true;
    try { p.child.stdin.end(); } catch (_) {}
    try { p.child.kill(); } catch (_) {}
}

function closeAll() { for (const project of [...procs.keys()]) close(project); }

module.exports = { init, status, history, send, decide, stop, newChat, close, closeAll, MODELS };
