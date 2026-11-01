// codex-host.js — runs the user's own, unmodified `codex` binary (OpenAI Codex,
// signed in with their own ChatGPT plan via `codex login`; Volt holds no key and
// never reads ~/.codex/auth.json) as the Assistant panel's agent. One long-lived
// `codex app-server` per project, driven over JSON-RPC on stdin/stdout. Same
// panel interface and chat log as claude-host.js; the thread id lives in
// <project>/.volt/assistant.json as `thread`.

const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const logger = require("./logger");
const claudeHost = require("./claude-host");

const { logFile, readMeta, writeMeta, emit, wasCut, diskCheck, switchedFrom } = claudeHost.store;

const policy = require("./agent-policy");
const { hostToken } = require("./agent-bridge");

const PROMPT = claudeHost.SYSTEM_PROMPT + `
Change .volt files only with the volt ide_edit tool, never with apply_patch or shell commands.`;

// Volt tools that run without asking: read-only, or visible and undoable in the editor.
const AUTO = ["volt_spec", "device_card", "list_devices", "check", "review", "ide_status",
    "ide_read", "ide_diagnostics", "ide_show", "ide_history", "ide_highlight",
    "ide_point", "ide_walkthrough", "ide_select", "ide_build"]; // the rest follow agent-policy.js
// Kept from the model: file-based build/format (the IDE owns the project) and tools the chat doesn't use.
const HIDDEN = ["ide_note_events", "ide_ask", "build", "format", "ide_screenshot"];
// Codex features that pull in tools, apps or hooks from the user's own setup.
const OFF = ["apps", "plugins", "computer_use", "browser_use", "browser_use_external", "in_app_browser", "hooks",
    "image_generation", "multi_agent", "goals", "tool_suggest", "tool_search_always_defer_mcp_tools", "skill_search",
    "remote_plugin", "realtime_conversation", "guardian_approval"];

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

let found = null;
function candidates() {
    const home = os.homedir();
    const exe = process.platform === "win32" ? "codex.cmd" : "codex";
    const dirs = [path.join(home, ".volt", "agents", "codex", "bin"), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin"),
        "/usr/bin", ...(process.env.PATH || "").split(path.delimiter)];
    if (process.platform === "win32") dirs.push(path.join(home, "AppData", "Roaming", "npm"));
    return dirs.filter(Boolean).map(d => path.join(d, exe));
}
function loginShellWhich() {
    if (process.platform === "win32") return Promise.resolve(null);
    return new Promise((resolve) => execFile(process.env.SHELL || "/bin/zsh", ["-lc", "command -v codex"],
        { timeout: 5000 }, (err, out) => resolve(!err && out.trim() ? out.trim().split("\n").pop() : null)));
}
async function locate() {
    const custom = getSetting("assistant.codexPath");
    if (custom && fs.existsSync(custom)) return custom;
    if (found && fs.existsSync(found)) return found;
    found = candidates().find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } })
        || await loginShellWhich();
    return found;
}
// The npm package is a node script: give it a PATH that has node in it.
function env(bin) {
    const extra = [path.dirname(bin), "/opt/homebrew/bin", "/usr/local/bin"];
    return { ...process.env, PATH: [...extra, process.env.PATH || ""].join(path.delimiter) };
}
function run(bin, args) {
    return new Promise((resolve) => execFile(bin, args, { timeout: 15000, env: env(bin) },
        (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || "") + String(stderr || "") })));
}

/** status() → {found, path, version, loggedIn} — the panel's setup state. */
async function status() {
    const bin = await locate();
    if (!bin) return { found: false };
    const [v, a] = await Promise.all([run(bin, ["--version"]), run(bin, ["login", "status"])]);
    return { found: true, path: bin, version: (v.out.trim().split(/\s+/).pop() || ""), loggedIn: a.ok && /logged in/i.test(a.out) };
}

// ---- JSON-RPC over the app-server's stdio ----

function rpc(child, onMessage) {
    let buf = "", next = 1;
    const waiting = new Map();
    child.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            let m;
            try { m = JSON.parse(line); } catch { continue; }
            if (m.id != null && !m.method) {
                const w = waiting.get(m.id);
                waiting.delete(m.id);
                if (w) m.error ? w.reject(new Error(m.error.message || "Codex error")) : w.resolve(m.result);
                continue;
            }
            try { onMessage(m); } catch (e) { logger.log("warn", "assistant", `codex event: ${e.message}`); }
        }
    });
    child.on("exit", () => { for (const w of waiting.values()) w.reject(new Error("Codex quit")); waiting.clear(); });
    const write = (o) => { try { child.stdin.write(JSON.stringify(o) + "\n"); } catch (_) {} };
    return {
        request: (method, params) => new Promise((resolve, reject) => { const id = next++; waiting.set(id, { resolve, reject }); write({ id, method, params }); }),
        notify: (method, params) => write(params ? { method, params } : { method }),
        reply: (id, result) => write({ id, result }),
        fail: (id, message) => write({ id, error: { code: -32601, message } }),
    };
}

function serverArgs() {
    const toml = (s) => JSON.stringify(s); // TOML basic strings share JSON's escaping
    const tools = AUTO.map(t => `${t}={approval_mode="approve"}`).join(",");
    const volt = `{command=${toml(voltBin())},args=["mcp"],env={VOLT_AGENT_HOST=${toml(hostToken)}},default_tools_approval_mode="prompt",` +
        `disabled_tools=[${HIDDEN.map(toml).join(",")}],tools={${tools}}}`;
    return ["app-server", ...OFF.flatMap(f => ["--disable", f]), "-c", "notify=[]", "-c", `mcp_servers={volt=${volt}}`];
}

async function handshake(c) {
    await c.request("initialize", { clientInfo: { name: "volt_ide", title: "Volt IDE", version: "1" },
        capabilities: { experimentalApi: true, requestAttestation: false } });
    c.notify("initialized");
}

// ---- models ----

let modelCache = null;
/** models() → [{value, label}] the signed-in plan can use, default first. */
async function models() {
    if (modelCache) return modelCache;
    const bin = await locate();
    if (!bin) return [];
    const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env: env(bin) });
    const c = rpc(child, () => {});
    try {
        await handshake(c);
        const r = await c.request("model/list", {});
        const list = (r.data || []).filter(m => !m.hidden).sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
        modelCache = list.map(m => ({ value: m.model || m.id, label: m.displayName || m.model || m.id, isDefault: !!m.isDefault }));
    } catch (e) { logger.log("warn", "assistant", `codex models: ${e.message}`); }
    finally { try { child.kill(); } catch (_) {} }
    return modelCache || [];
}
async function model() {
    const list = await models();
    const m = getSetting("assistant.codexModel");
    return list.some(x => x.value === m) ? m : (list[0] && list[0].value) || null;
}

// ---- the process ----

async function start(project) {
    const bin = await locate();
    if (!bin) throw new Error("Codex is not installed. Install it, sign in with `codex login`, then try again.");
    const child = spawn(bin, serverArgs(), { cwd: project, stdio: ["pipe", "pipe", "pipe"], env: env(bin) });
    const p = { child, project, busy: false, approvals: new Map(), tools: new Map(), files: new Map(), diags: null, fixes: 0,
        stderr: [], text: "", model: await model() };
    procs.set(project, p);
    p.rpc = rpc(child, (m) => { if (!p.quiet) onMessage(p, m); });
    child.stderr.on("data", (d) => {
        p.stderr.push(...String(d).split("\n").filter(Boolean));
        if (p.stderr.length > 30) p.stderr.splice(0, p.stderr.length - 30);
    });
    child.on("error", (e) => emit(project, { t: "error", text: e.message }));
    child.on("exit", (code, signal) => {
        if (procs.get(project) === p) procs.delete(project);
        if (p.busy && !p.quiet) {
            const why = p.stderr.slice(-3).join(" ") || `exited (${signal || code})`;
            emit(project, { t: "error", text: p.killed ? "Stopped." : `Codex stopped: ${why}` });
            sendToRenderer("assistant:event", { project, entry: { t: "busy", on: false } });
        }
    });
    logger.log("info", "assistant", `started codex (${p.model || "default"}) for ${project}`);

    await handshake(p.rpc);
    const opts = { cwd: project, model: p.model, approvalPolicy: "untrusted", approvalsReviewer: "user",
        sandbox: "workspace-write", developerInstructions: PROMPT };
    const meta = readMeta(project);
    let r = null;
    try {
        if (meta.thread && meta.forkAt) r = await p.rpc.request("thread/fork", { threadId: meta.thread, lastTurnId: meta.forkAt, ...opts, excludeTurns: true });
        else if (meta.thread) r = await p.rpc.request("thread/resume", { threadId: meta.thread, ...opts, excludeTurns: true });
    } catch (e) { logger.log("warn", "assistant", `codex resume failed, starting fresh: ${e.message}`); }
    if (!r) r = await p.rpc.request("thread/start", opts);
    p.thread = r.thread.id;
    const m = readMeta(project);
    delete m.forkAt;
    writeMeta(project, { ...m, provider: "codex", thread: p.thread });
    return p;
}

function onMessage(p, m) {
    const project = p.project;
    const it = m.params && m.params.item;
    switch (m.method) {
    case "mcpServer/startupStatus/updated":
        if (m.params.name === "volt" && m.params.status === "failed") p.voltFailed = m.params.error || "failed";
        return;
    case "turn/started":
        p.turnId = m.params.turn.id;
        return;
    case "item/agentMessage/delta":
        p.text += m.params.delta;
        emit(project, { t: "delta", text: m.params.delta }, false);
        return;
    case "item/started":
        if (it.type === "mcpToolCall") {
            p.tools.set(it.id, it.tool);
            emit(project, { t: "tool", id: it.id, name: it.tool, input: it.arguments || {} });
        } else if (it.type === "commandExecution") {
            emit(project, { t: "tool", id: it.id, name: "shell", input: { command: it.command } });
        } else if (it.type === "fileChange") {
            p.files.set(it.id, (it.changes || []).map(c => c.path));
            emit(project, { t: "tool", id: it.id, name: "Edit", input: { file_path: p.files.get(it.id).join(", ") } });
        }
        return;
    case "item/completed":
        if (it.type === "agentMessage") {
            if (it.text && it.text.trim()) emit(project, { t: "text", text: it.text });
            p.text = "";
        } else if (it.type === "mcpToolCall") {
            const body = it.error ? it.error.message || "failed"
                : ((it.result && it.result.content) || []).filter(x => x.type === "text").map(x => x.text).join("\n");
            const ok = it.status === "completed" && !(it.result && it.result.isError);
            emit(project, { t: "tool_result", id: it.id, ok, summary: String(body).slice(0, 400) });
            const tool = p.tools.get(it.id);
            if (tool === "ide_edit" || tool === "check" || tool === "ide_diagnostics") {
                try { const d = JSON.parse(body).diagnostics; if (Array.isArray(d)) p.diags = d; } catch {}
            }
        } else if (it.type === "commandExecution") {
            const out = String(it.aggregatedOutput || "");
            emit(project, { t: "tool_result", id: it.id, ok: it.status === "completed" && !it.exitCode, summary: out.slice(0, 400) });
        } else if (it.type === "fileChange") {
            emit(project, { t: "tool_result", id: it.id, ok: it.status === "completed", summary: "" });
        }
        return;
    case "error":
        if (!m.params.willRetry) p.lastError = m.params.error && m.params.error.message;
        return;
    case "turn/completed":
        finishTurn(p, m.params.turn);
        return;
    }
    if (m.id != null) askApproval(p, m);
}

// A request from Codex that needs the user (or a rule) to answer.
function askApproval(p, m) {
    const q = m.params || {};
    let tool, input, kind, reason = q.reason || undefined;
    if (m.method === "item/fileChange/requestApproval") {
        const paths = p.files.get(q.itemId) || [];
        // Program edits go through ide_edit so the user sees them and can undo.
        if (paths.some(f => /\.volt$/i.test(f))) return p.rpc.reply(m.id, { decision: "decline" });
        tool = "Edit"; kind = "decision"; input = { file_path: paths.join(", ") };
    } else if (m.method === "item/commandExecution/requestApproval") {
        tool = "shell"; kind = "decision"; input = { command: q.command || "", cwd: q.cwd || undefined };
    } else if (m.method === "mcpServer/elicitation/request" && q._meta && q._meta.codex_approval_kind === "mcp_tool_call") {
        const name = /tool "([^"]+)"/.exec(q.message || "");
        tool = name ? name[1] : "a tool"; kind = "elicitation"; input = q._meta.tool_params || {};
    } else if (m.method === "mcpServer/elicitation/request") {
        return p.rpc.reply(m.id, { action: "decline", content: null, _meta: null });
    } else if (m.method === "execCommandApproval" || m.method === "applyPatchApproval") { // legacy forms, never requested by v2 clients
        return p.rpc.reply(m.id, { decision: "denied" });
    } else {
        return p.rpc.fail(m.id, "Not supported in Volt IDE");
    }
    // The strictest rule over every file a change touches (or the one tool call).
    const files = tool === "Edit" ? String(input.file_path || "").split(", ").filter(Boolean) : [null];
    const rules = files.map(f => policy.forCall(tool, f ? { file_path: f } : input, p.project, getSetting));
    const rank = (r) => r.level ? policy.LEVELS.indexOf(r.level) : 1; // not covered: ask
    const rule = rules.reduce((a, b) => rank(b) > rank(a) ? b : a);
    const settle = (allow) => answer(p, { rpcId: m.id, kind }, allow);
    if (rule.level === "allow") return settle(true);
    if (rule.level === "never") return settle(false);
    if (rule.key && !reason) reason = policy.label(rule.key);
    const id = "cx-" + m.id;
    const entry = { t: "approval", id, tool, input, reason };
    p.approvals.set(id, { entry, rpcId: m.id, kind });
    emit(p.project, entry);
}

function answer(p, a, allow) {
    p.rpc.reply(a.rpcId, a.kind === "elicitation"
        ? { action: allow ? "accept" : "decline", content: allow ? {} : null, _meta: null }
        : { decision: allow ? "accept" : "decline" });
}

// Don't end a turn with errors in the program: send Codex back to fix them
// (twice at most), as claude-host does.
async function finishTurn(p, turn) {
    const project = p.project;
    const failed = turn.status === "failed";
    const stopped = turn.status === "interrupted" || p.stopping;
    let diags = p.diags;
    p.diags = null;
    if (!diags && !stopped && !failed && p.fixes < 2) diags = await diskCheck(project);
    const errors = (diags || []).filter(d => d.severity === "error");
    if (!stopped && !failed && errors.length && p.fixes < 2) {
        p.fixes++;
        if (p.text.trim()) emit(project, { t: "text", text: p.text });
        p.text = "";
        const list = errors.slice(0, 5).map(d => `line ${d.line}: ${d.message}${d.hint ? ` (${d.hint})` : ""}`).join("\n");
        emit(project, { t: "note", text: `${errors.length} error${errors.length > 1 ? "s" : ""} left in the program, so Codex is fixing ${errors.length > 1 ? "them" : "it"}` });
        startTurn(p, `The program still fails check:\n${list}\nFix every error now with ide_edit, keeping what I asked for where it is valid. If my request itself can't work, revert that part to a valid choice and tell me why. Then run check.`)
            .catch(e => endTurn(p, { ok: false, error: e.message }));
        return;
    }
    if (p.text.trim()) emit(project, { t: "text", text: p.text }); // the part streamed before Stop
    p.text = "";
    const error = stopped ? "Stopped." : failed ? ((turn.error && turn.error.message) || p.lastError || "Codex failed") : undefined;
    endTurn(p, { ok: !stopped && !failed, turn: turn.id, ms: turn.durationMs || undefined, error });
}

function endTurn(p, result) {
    p.busy = false;
    p.stopping = false;
    p.lastError = null;
    emit(p.project, { t: "result", ...result });
    sendToRenderer("assistant:event", { project: p.project, entry: { t: "busy", on: false } });
}

function startTurn(p, text) {
    return p.rpc.request("turn/start", { threadId: p.thread, input: [{ type: "text", text, text_elements: [] }] })
        .then(r => { p.turnId = r.turn.id; });
}

/** ask(prompt) → the reply text (one quick, read-only, unsaved request). */
async function ask(prompt) {
    const bin = await locate();
    if (!bin) throw new Error("Codex is not installed.");
    const out = path.join(os.tmpdir(), `volt-describe-${process.pid}-${Date.now()}.txt`);
    const m = await model();
    const args = ["exec", ...OFF.flatMap(f => ["--disable", f]), "-c", "notify=[]", "-c", "mcp_servers={}",
        "--ephemeral", "--skip-git-repo-check", "--ignore-rules", "-s", "read-only", ...(m ? ["-m", m] : []),
        "-o", out, prompt];
    // stdin closed at once: `codex exec` otherwise waits to read more of the prompt from it.
    await new Promise((resolve, reject) => execFile(bin, args, { timeout: 90000, cwd: os.tmpdir(), env: env(bin), maxBuffer: 4 << 20 },
        (err, _o, se) => { if (err) { logger.log("warn", "assistant", `codex describe: ${String(se || err.message).trim().split("\n").slice(-3).join(" | ")}`); reject(new Error("Codex couldn't write it.")); } else resolve(); }).stdin.end());
    try { return fs.readFileSync(out, "utf8"); } finally { try { fs.unlinkSync(out); } catch (_) {} }
}
async function describe(source) { return claudeHost.cleanDescription(await ask(claudeHost.DESCRIBE_PROMPT(source))); }
async function commitMessage(diff) { return claudeHost.cleanCommitMessage(await ask(claudeHost.COMMIT_PROMPT(diff))); }

// ---- panel actions ----

/** history(project) → {entries, busy, cut, pending}: the stored chat, for the panel to draw. */
function history(project) {
    const h = claudeHost.history(project);
    const p = procs.get(project);
    const busy = !!(p && p.busy);
    return { ...h, busy: h.busy || busy, cut: busy ? false : wasCut(h.entries), pending: h.pending.concat(p ? [...p.approvals.values()].map(a => a.entry) : []) };
}

/** send(project, text, extra) — same contract as claude-host.send. */
async function send(project, text, extra = {}) {
    if (!project) throw new Error("Open a project first.");
    text = String(text || "").trim();
    if (!text) return;
    claudeHost.close(project); // one provider per project at a time
    if (extra.rewind) rewind(project, extra.rewind);
    if (!procs.get(project)) switchedFrom(project, "codex", ["thread", "forkAt"], "Codex");
    let p = procs.get(project);
    if (p && p.model !== await model()) { close(project); p = null; } // model changed: resume with the new one
    if (p && p.busy) throw new Error("Codex is still working. Stop it or wait for the reply.");
    const before = extra.before && typeof extra.before.source === "string" ? { file: String(extra.before.file || ""), source: extra.before.source } : undefined;
    emit(project, { t: "user", text, before });
    sendToRenderer("assistant:event", { project, entry: { t: "busy", on: true } });
    try {
        if (!p) p = await start(project);
        p.busy = true;
        p.fixes = 0;
        if (p.voltFailed) throw new Error(`Volt's tools didn't start (${p.voltFailed}), so Codex can't see your program. Press Retry. If it keeps happening, restart Volt IDE.`);
        const context = typeof extra.context === "string" && extra.context ? extra.context + "\n\n" : "";
        await startTurn(p, context + text);
    } catch (e) {
        const q = procs.get(project);
        if (q) { q.quiet = true; close(project); }
        endTurn(p || { project }, { ok: false, error: e.message });
    }
}

/** decide(project, requestId, allow) — the user's answer to an approval card. */
function decide(project, requestId, allow) {
    const p = procs.get(project);
    const a = p && p.approvals.get(requestId);
    if (!a) return claudeHost.decide(project, requestId, allow);
    p.approvals.delete(requestId);
    answer(p, a, allow);
    emit(project, { t: "decision", id: requestId, allow: !!allow });
    return true;
}

/** stop(project) — interrupt the current turn; kill if it doesn't stop. */
function stop(project) {
    const p = procs.get(project);
    if (!p || !p.busy) return claudeHost.stop(project);
    p.stopping = true;
    for (const id of p.approvals.keys()) decide(project, id, false);
    if (p.turnId) p.rpc.request("turn/interrupt", { threadId: p.thread, turnId: p.turnId }).catch(() => {});
    setTimeout(() => { if (p.busy && procs.get(project) === p) { p.killed = true; p.child.kill(); } }, 5000);
}

/** rewind(project, userAt) — drop the message sent at userAt and everything
 *  after it; the next message forks the thread after the turn before it. */
function rewind(project, userAt) {
    const f = logFile(project);
    let lines = [];
    try { lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return false; }
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return {}; } });
    const i = entries.findIndex(e => e.t === "user" && e.at === userAt);
    if (i < 0) return false;
    const prev = entries.slice(0, i).reverse().find(e => e.t === "result" && e.turn);
    close(project);
    try { fs.copyFileSync(f, path.join(path.dirname(f), `assistant-${Date.now()}.bak.jsonl`)); } catch (_) {}
    fs.writeFileSync(f, lines.slice(0, i).map(l => l + "\n").join(""));
    const meta = readMeta(project);
    if (prev && meta.thread) meta.forkAt = prev.turn;
    else { delete meta.thread; delete meta.forkAt; }
    writeMeta(project, meta);
    return true;
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

// Storage-only actions are shared with claude-host; close our process first.
function newChat(project) { close(project); return claudeHost.newChat(project); }
function openChat(project, id) { close(project); return claudeHost.openChat(project, id); }
const { chats, saveAfter } = claudeHost;

module.exports = { init, locate, describe, commitMessage, status, models, history, send, decide, stop, newChat, chats, openChat, saveAfter, close, closeAll };
