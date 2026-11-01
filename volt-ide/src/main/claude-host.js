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
const voltCli = require("./volt-cli");

const SYSTEM_PROMPT = `You are the assistant inside Volt IDE. You write Volt firmware for the project open in the IDE.
Volt is a new language: never write it from memory or by analogy with C, Arduino or Python.
Loop: volt_spec once -> device_card for each device -> ide_read -> change the program only with ide_edit -> check -> fix until ok -> review and compare with the request.
Layout: put the setup block right after the hardware block (the formatter keeps it there).
Choosing parts: the user decides. When more than one device can do exactly what was asked, equally well for every stated requirement (list_devices results and each device_card's alternatives show these), don't pick one yourself: recommend one, end your reply with a devices block (always first a "for:" line saying what the part does in this project, so the user knows why you ask, then one device name per line, recommended first, a short reason each), and wait for the answer before writing code. Skip it when only one device fits or the user already named one.
\`\`\`devices
for: reading the room's temperature and humidity
AHT20 (recommended) :: I2C, accurate, shares the bus with a display
DHT22 :: one data pin, slower to read
\`\`\`
Put nothing after the block.
Never make a change that causes an error or hardware violation: before editing, confirm it is valid (pins the chip has, methods the device lists, free pins). If a request can't work as asked, don't apply it; say why and offer valid choices.
End every turn with check ok: if the program has errors (yours or ones already there), fix them before you answer.
Build or flash only when the user asks (ide_build, ide_run), then confirm with ide_serial.
Answer briefly in plain language; the user sees your edits in the editor.
Show, don't paste: when the user asks where something is, how code works, or what you changed, point at it in the editor with ide_point: anchor each mark with find (an exact, distinctive piece of the code, e.g. "every 300ms {" or "rfid.read_uid()"), never a line number you counted yourself; when a note is about several lines (a check and its branches, a whole block), add end_find (distinctive code on its last line) so the mark covers all of them, and put each note on the code it actually describes; a short note each, kind info, persist dismissable. ide_point answers with the real line of every mark: use those numbers (and only those) when you mention lines. Notes are shown beside the code, never written into the file. Then keep the chat reply to a sentence or two and refer to lines as "line N" or "lines N-M" (the user can click them). Don't paste the program's code into the chat. For a tour of several parts in order, use ide_walkthrough. Never add comments to the source just to explain it.
Whenever your reply offers alternatives or ends with a question for the user (pins, approaches, a different chip, whether to apply something), always end it with the options in a choices block, 2-4 options, the recommended one first marked (recommended); an option whose title ends with ... lets the user type their own answer:
\`\`\`choices
Use GPIO 4 (recommended) :: back to the original pin, free and safe for output
Another pin... :: tell me which; safe outputs are 18, 19, 21-23, 25-27, 32, 33
\`\`\`
Put nothing after the block. Don't repeat the options as a list above it.`;

// Auto-approved: read-only, or visible and undoable in the editor.
const ALLOWED = ["volt_spec", "device_card", "list_devices", "check", "review", "ide_status",
    "ide_read", "ide_edit", "ide_diagnostics", "ide_show", "ide_screenshot", "ide_serial", "ide_history", "ide_highlight",
    "ide_point", "ide_walkthrough", "ide_select"]
    .map(t => "mcp__volt__" + t).concat(["Read"]);
// Removed from the model's tool list: file-based build/format
// (the IDE owns the project), and the biggest definitions the chat doesn't need.
const DISALLOWED = ["ide_note_events", "ide_ask", "build", "format"].map(t => "mcp__volt__" + t);

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

/** wasCut(entries) — did the latest message's turn end early? Claude Code
 *  ends every finished turn with a result event; a turn is cut off when that
 *  result is an error or a Stop, when an error ended it, or when it has no
 *  result at all (Claude Code or the IDE quit while it was running). */
function wasCut(entries) {
    let u = -1;
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].t === "user") { u = i; break; }
    if (u < 0) return false;
    for (let i = u + 1; i < entries.length; i++) {
        const e = entries[i];
        if (e.t === "result") return !e.ok;
        if (e.t === "error") return true;
    }
    return true;
}

/** history(project) → {entries, busy, model}: the stored chat, for the panel to draw. */
function history(project) {
    let text = "";
    try { text = fs.readFileSync(logFile(project), "utf8"); } catch (_) {}
    const entries = [];
    for (const line of text.split("\n")) { if (line.trim()) try { entries.push(JSON.parse(line)); } catch (_) {} }
    const p = procs.get(project);
    const busy = !!(p && p.busy);
    return { entries, busy, cut: busy ? false : wasCut(entries), pending: p ? [...p.approvals.values()].map(a => a.entry) : [] };
}

// emit sends an entry to the panel; keep=true also appends it to the chat log.
function emit(project, entry, keep = true, show = true) {
    entry.at = entry.at || new Date().toISOString();
    if (keep) {
        try {
            fs.mkdirSync(dir(project), { recursive: true });
            fs.appendFileSync(logFile(project), JSON.stringify(entry) + "\n");
        } catch (e) { logger.log("warn", "assistant", `chat log: ${e.message}`); }
    }
    if (show) sendToRenderer("assistant:event", { project, entry });
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
    if (meta.session && meta.started && meta.resumeAt) {
        // Rewound: continue from the end of an earlier turn, as a new session (the old one is kept).
        args.push("--resume", meta.session, "--resume-session-at", meta.resumeAt, "--fork-session");
        resumed = true;
    } else if (meta.session && meta.started) { args.push("--resume", meta.session); resumed = true; }
    else {
        meta.session = meta.session || crypto.randomUUID();
        args.push("--session-id", meta.session);
    }

    const child = spawn(bin, args, { cwd: project, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const p = { child, project, busy: false, approvals: new Map(), tools: new Map(), diags: null, fixes: 0, model: model(), session: meta.session,
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
        if (p.busy && !p.quiet) {
            const why = p.stderr.slice(-3).join(" ") || `exited (${signal || code})`;
            emit(project, { t: "error", text: p.killed ? "Stopped." : `Claude Code stopped: ${why}` });
            sendToRenderer("assistant:event", { project, entry: { t: "busy", on: false } });
        }
        // A resume that fails (session gone) starts fresh next time.
        if (resumed && !p.sawInit) { const m = readMeta(project); delete m.started; delete m.session; delete m.resumeAt; writeMeta(project, m); }
    });

    write({ type: "control_request", request_id: "init", request: { subtype: "initialize" } });
    return p;
}

function onEvent(p, ev) {
    if (p.quiet) return; // a session being replaced: nothing it says reaches the chat
    const project = p.project;
    switch (ev.type) {
    case "system":
        if (ev.subtype === "init") {
            p.sawInit = true;
            const volt = (ev.mcp_servers || []).find(s => s.name === "volt");
            if (volt && volt.status !== "connected") { toolsFailed(p, volt.status); return; }
            const meta = readMeta(project);
            if (!meta.started || meta.session !== ev.session_id || meta.resumeAt) {
                delete meta.resumeAt;
                writeMeta(project, { ...meta, session: ev.session_id, started: true });
            }
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
        if (ev.uuid) p.lastUuid = ev.uuid; // where a later rewind can resume from
        for (const c of (ev.message && ev.message.content) || []) {
            if (c.type === "text" && c.text.trim()) emit(project, { t: "text", text: c.text });
            if (c.type === "tool_use") {
                p.tools.set(c.id, shortName(c.name));
                emit(project, { t: "tool", id: c.id, name: shortName(c.name), input: c.input });
            }
        }
        p.text = "";
        break;
    case "user":
        for (const c of (ev.message && ev.message.content) || []) {
            if (c.type !== "tool_result") continue;
            const body = typeof c.content === "string" ? c.content
                : (c.content || []).filter(x => x.type === "text").map(x => x.text).join("\n");
            emit(project, { t: "tool_result", id: c.tool_use_id, ok: !c.is_error, summary: body.slice(0, 400) });
            // The editor's diagnostics after the latest ide_edit/check: the program as it now stands.
            const tool = p.tools.get(c.tool_use_id);
            if (tool === "ide_edit" || tool === "check" || tool === "ide_diagnostics") {
                try { const d = JSON.parse(body).diagnostics; if (Array.isArray(d)) p.diags = d; } catch {}
            }
        }
        break;
    case "control_request": {
        const r = ev.request || {};
        if (r.subtype === "can_use_tool") return askApproval(p, ev.request_id, r);
        break;
    }
    case "result":
        finishTurn(p, ev);
        break;
    }
}

// Don't end a turn with errors in the program: send Claude back to fix them
// (twice at most). The program's state is the diagnostics of Claude's last
// edit or check this turn, or else a check of the project on disk.
async function finishTurn(p, ev) {
    const project = p.project;
    let diags = p.diags;
    p.diags = null;
    if (!diags && !p.stopping && !ev.is_error && p.fixes < 2) diags = await diskCheck(project);
    {
        const errors = (diags || []).filter(d => d.severity === "error");
        if (!p.stopping && !ev.is_error && errors.length && p.fixes < 2) {
            p.fixes++;
            if (p.text.trim()) emit(project, { t: "text", text: p.text });
            p.text = "";
            const list = errors.slice(0, 5).map(d => `line ${d.line}: ${d.message}${d.hint ? ` (${d.hint})` : ""}`).join("\n");
            emit(project, { t: "note", text: `${errors.length} error${errors.length > 1 ? "s" : ""} left in the program, so Claude is fixing ${errors.length > 1 ? "them" : "it"}` });
            p.write({ type: "user", message: { role: "user", content:
                `The program still fails check:\n${list}\nFix every error now with ide_edit, keeping what I asked for where it is valid. If my request itself can't work, revert that part to a valid choice and tell me why. Then run check.` } });
            return;
        }
        p.busy = false;
        if (p.text.trim()) emit(project, { t: "text", text: p.text }); // the part streamed before Stop
        p.text = "";
        emit(project, { t: "result", ok: !ev.is_error, turns: ev.num_turns, ms: ev.duration_ms, uuid: p.lastUuid,
            error: p.stopping ? "Stopped." : ev.is_error ? (ev.result || ev.subtype) : undefined });
        p.stopping = false;
        sendToRenderer("assistant:event", { project, entry: { t: "busy", on: false } });
    }
}

function diskCheck(project) {
    return new Promise((resolve) => {
        let out = null;
        const { done } = voltCli.run(["check", "--json", "."], { cwd: project, onJSON: (o) => { out = o; } });
        done.then(() => resolve(out && Array.isArray(out.diagnostics) ? out.diagnostics : null));
    });
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
/** send(project, text, extra) — extra: { before: {file, source} } the program
 *  before this turn (for undo), { context } a note for Claude only. */
async function send(project, text, extra = {}) {
    if (!project) throw new Error("Open a project first.");
    text = String(text || "").trim();
    if (!text) return;
    if (extra.rewind) rewind(project, extra.rewind);
    if (!procs.get(project)) switchedFrom(project, "claude", ["session", "started", "resumeAt"], "Claude Code");
    let p = procs.get(project);
    if (p && p.model !== model()) { close(project); p = null; } // model changed: resume with the new one
    if (!p) p = await start(project);
    if (p.busy) throw new Error("Claude is still working. Stop it or wait for the reply.");
    p.busy = true;
    p.fixes = 0;
    const before = extra.before && typeof extra.before.source === "string" ? { file: String(extra.before.file || ""), source: extra.before.source } : undefined;
    emit(project, { t: "user", text, before });
    sendToRenderer("assistant:event", { project, entry: { t: "busy", on: true } });
    const context = typeof extra.context === "string" && extra.context ? extra.context + "\n\n" : "";
    p.pending = context + text;
    p.prevUuid = lastResultUuid(project);
    p.write({ type: "user", message: { role: "user", content: p.pending } });
}

function lastResultUuid(project) {
    let lines = [];
    try { lines = fs.readFileSync(logFile(project), "utf8").split("\n").filter(Boolean); } catch (_) {}
    for (let i = lines.length - 1; i >= 0; i--) {
        try { const e = JSON.parse(lines[i]); if (e.t === "result" && e.uuid) return e.uuid; } catch (_) {}
    }
    return null;
}

// Volt's tools didn't start in this session, so Claude can't see the program.
// Stop it before it answers, rewind past the message, start again and resend
// once; if that fails too, end the turn with a clear error (and Retry).
async function toolsFailed(p, status) {
    const project = p.project;
    p.quiet = true;
    try { p.child.kill(); } catch (_) {}
    if (procs.get(project) === p) procs.delete(project);
    const meta = readMeta(project);
    if (p.prevUuid && meta.session) meta.resumeAt = p.prevUuid;
    else if (!p.prevUuid) { delete meta.session; delete meta.started; delete meta.resumeAt; }
    writeMeta(project, meta);
    if (p.busy && !p.retried && p.pending) {
        logger.log("warn", "assistant", `volt tools ${status}; restarting the session once`);
        try {
            const q = await start(project);
            q.retried = true;
            q.busy = true;
            q.fixes = 0;
            q.pending = p.pending;
            q.prevUuid = p.prevUuid;
            q.write({ type: "user", message: { role: "user", content: q.pending } });
            return;
        } catch (e) { logger.log("warn", "assistant", `restart failed: ${e.message}`); }
    }
    emit(project, { t: "result", ok: false, error: "Volt's tools didn't start, so Claude couldn't see your program and didn't answer. Press Retry. If it keeps happening, restart Volt IDE." });
    sendToRenderer("assistant:event", { project, entry: { t: "busy", on: false } });
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

/** rewind(project, userAt) — drop the user message sent at userAt and
 *  everything after it, from the chat log and from Claude's memory: the next
 *  message resumes the session at the end of the turn before it. The full log
 *  is archived first. */
function rewind(project, userAt) {
    const f = logFile(project);
    let lines = [];
    try { lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return false; }
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return {}; } });
    const i = entries.findIndex(e => e.t === "user" && e.at === userAt);
    if (i < 0) return false;
    const prev = entries.slice(0, i).reverse().find(e => e.t === "result" && e.uuid);
    close(project);
    try { fs.copyFileSync(f, path.join(dir(project), `assistant-${Date.now()}.bak.jsonl`)); } catch (_) {}
    fs.writeFileSync(f, lines.slice(0, i).map(l => l + "\n").join(""));
    const meta = readMeta(project);
    if (prev && meta.session && meta.started) meta.resumeAt = prev.uuid;
    else { delete meta.session; delete meta.started; delete meta.resumeAt; }
    writeMeta(project, meta);
    return true;
}

/** switchedFrom(project, me) — the chat's last messages went to another
 *  provider: drop this provider's stale session (it never saw them) and say so. */
function switchedFrom(project, me, keys, name) {
    const meta = readMeta(project);
    // Chats from before providers were recorded belong to Claude Code.
    const prev = meta.provider || (meta.session ? "claude" : meta.thread ? "codex" : null);
    if (prev === me) { if (!meta.provider) writeMeta(project, { ...meta, provider: me }); return; }
    const had = !!prev && fs.existsSync(logFile(project));
    for (const k of keys) delete meta[k];
    writeMeta(project, { ...meta, provider: me });
    if (had) emit(project, { t: "note", text: `${name} starts fresh here: it doesn't see the earlier messages in this chat` });
}

/** Saved chats live next to the current one as assistant-<id>.jsonl, each
 *  with its session in assistant-<id>.json, so switching back resumes it. */
function archiveCurrent(project) {
    const f = logFile(project);
    const meta = readMeta(project);
    delete meta.resumeAt;
    let size = 0;
    try { size = fs.statSync(f).size; } catch (_) {}
    if (!size) { try { fs.unlinkSync(f); } catch (_) {} return; }
    const id = String(Date.now());
    fs.renameSync(f, path.join(dir(project), `assistant-${id}.jsonl`));
    delete meta.forkAt;
    fs.writeFileSync(path.join(dir(project), `assistant-${id}.json`), JSON.stringify(meta, null, 2));
}

function chatSummary(file) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch (_) { return null; }
    let title = "", count = 0;
    for (const line of text.split("\n")) {
        if (!line.includes('"t":"user"')) continue;
        try { const e = JSON.parse(line); if (e.t !== "user") continue; count++; if (!title) title = String(e.text || "").trim().split("\n")[0]; } catch (_) {}
    }
    if (!count) return null;
    let at = 0;
    try { at = fs.statSync(file).mtimeMs; } catch (_) {}
    return { title: title.slice(0, 120), count, at };
}

/** chats(project) → [{id, title, count, at, current}], newest first; the open chat first. */
function chats(project) {
    const out = [];
    const cur = chatSummary(logFile(project));
    if (cur) out.push({ id: "current", current: true, ...cur });
    let names = [];
    try { names = fs.readdirSync(dir(project)); } catch (_) {}
    const saved = [];
    for (const n of names) {
        const m = /^assistant-(\d+)\.jsonl$/.exec(n);
        if (!m) continue;
        const s = chatSummary(path.join(dir(project), n));
        if (s) saved.push({ id: m[1], ...s });
    }
    saved.sort((a, b) => b.at - a.at);
    return out.concat(saved);
}

/** openChat(project, id) — save the open chat and switch to a saved one. */
function openChat(project, id) {
    if (!/^\d+$/.test(String(id))) return false;
    const log = path.join(dir(project), `assistant-${id}.jsonl`);
    const side = path.join(dir(project), `assistant-${id}.json`);
    if (!fs.existsSync(log)) return false;
    close(project);
    archiveCurrent(project);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(side, "utf8")); } catch (_) {}
    fs.renameSync(log, logFile(project));
    try { fs.unlinkSync(side); } catch (_) {}
    writeMeta(project, meta);
    return true;
}

/** saveAfter(project, at, source) — remember the program as Claude left it at
 *  the end of the turn started at `at`, so later edits can be told apart. */
function saveAfter(project, at, source) {
    if (!at || typeof source !== "string") return false;
    emit(project, { t: "after", of: at, source }, true, false);
    return true;
}

/** newChat(project) — save the open chat and start the next message in a fresh session. */
function newChat(project) {
    close(project);
    try { archiveCurrent(project); } catch (_) {}
    writeMeta(project, {});
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

module.exports = { init, locate, status, history, send, decide, stop, newChat, chats, openChat, saveAfter, close, closeAll, MODELS,
    // shared with codex-host.js: same chat log, chats and prompt
    SYSTEM_PROMPT, store: { dir, logFile, readMeta, writeMeta, emit, wasCut, diskCheck, switchedFrom } };
