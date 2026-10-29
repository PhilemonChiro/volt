// Inbox — the chat between the Assistant panel and an attached agent
// (docs/ide-agent-design.md, "Messaging"). One append-only JSONL file per
// project (<project>/.volt/messages.jsonl): a line is either a message or a
// status change ({op:"status", id, status, note, at}), folded on load.

const fs = require("fs");
const path = require("path");

const WAIT_MAX_S = 50;
const STATUSES = ["sent", "delivered", "read", "working", "done"];

const stores = new Map();   // project dir → store
const listeners = new Set(); // fn(project, message) on every new message or status change

function file(project) { return path.join(project, ".volt", "messages.jsonl"); }

function load(project) {
    const s = { messages: [], byId: new Map(), next: 1, thread: "t1", waiters: new Set() };
    let text = "";
    try { text = fs.readFileSync(file(project), "utf8"); } catch (_) {}
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch (_) { continue; }
        if (r.op === "status") {
            const m = s.byId.get(r.id);
            if (m) { m.status = r.status; if (r.note) m.note = r.note; }
            continue;
        }
        s.messages.push(r);
        s.byId.set(r.id, r);
        s.next = Math.max(s.next, r.id + 1);
        s.thread = r.thread;
    }
    return s;
}

function store(project) {
    if (!project) throw new Error("No project is open in the Volt IDE.");
    let s = stores.get(project);
    if (!s) { s = load(project); stores.set(project, s); }
    return s;
}

function append(project, record) {
    const f = file(project);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(record) + "\n");
}

function emit(project, s, m) {
    for (const fn of listeners) { try { fn(project, m); } catch (_) {} }
    if (m.from !== "agent" && m.status === "sent") {
        for (const w of s.waiters) w();
    }
}

// family groups app names so a question meant for one app (to) never wakes
// another: "Claude Desktop" and a Desktop Code-tab session match, a terminal
// Claude Code session doesn't.
function family(name) {
    const n = String(name || "");
    return /desktop|claude-ai/i.test(n) ? "desktop" : /cursor/i.test(n) ? "cursor" : /codex/i.test(n) ? "codex" : /claude/i.test(n) ? "claude-code" : n.toLowerCase();
}
/** post(project, {from, kind, text, reply_to, attachments, to, session}) → message; to names the app
 *  it is for, session the Claude Code session (when known). */
function post(project, { from, kind = "chat", text, reply_to, attachments, to, session }) {
    if (!["user", "agent", "ide"].includes(from)) throw new Error(`bad sender: ${from}`);
    if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
    const s = store(project);
    const m = { id: s.next++, thread: s.thread, from, kind, text, at: new Date().toISOString(),
                status: from === "agent" ? "done" : "sent" };
    if (reply_to != null) m.reply_to = Number(reply_to);
    if (attachments && attachments.length) m.attachments = attachments;
    if (to) m.to = to;
    if (session) m.session = session;
    append(project, m);
    s.messages.push(m);
    s.byId.set(m.id, m);
    emit(project, s, m);
    return m;
}

/** setStatus(project, id, status, note) — id may be a message id or "thread" for the latest user message. */
function setStatus(project, id, status, note) {
    if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
    const s = store(project);
    const m = id === "thread"
        ? [...s.messages].reverse().find(x => x.thread === s.thread && x.from !== "agent")
        : s.byId.get(Number(id));
    if (!m) throw new Error(`no message ${id}`);
    m.status = status;
    if (note) m.note = note; else delete m.note;
    append(project, { op: "status", id: m.id, status, note, at: new Date().toISOString() });
    emit(project, s, m);
    return m;
}

// Messages for the agent (from the user or the IDE) newer than `since`; marks them read.
// fresh: only ones nobody has read yet (the Claude Code wake hook keeps no position).
// accept(m): whether this reader may take m; messages for someone else are left for them.
function unread(project, since, fresh, accept) {
    const s = store(project);
    const out = s.messages.filter(m => m.id > since && m.from !== "agent" && m.thread === s.thread
        && (!fresh || m.status === "sent" || m.status === "delivered")
        && (!accept || accept(m)));
    for (const m of out) if (m.status === "sent" || m.status === "delivered") setStatus(project, m.id, "read");
    return out;
}

/** list(project, since) → {messages, next, thread}; everything in the current thread newer than since. */
function list(project, since = 0) {
    const s = store(project);
    return { messages: s.messages.filter(m => m.id > since && m.thread === s.thread), next: s.next - 1, thread: s.thread };
}

/** read(project, since, fresh, accept) → {messages, next}: messages for the agent, marked read. */
function read(project, since = 0, fresh = false, accept = null) {
    return { messages: unread(project, since, fresh, accept), next: store(project).next - 1 };
}

/** wait(project, since, timeout_s, fresh) — like read, but blocks until a message arrives or the timeout. */
async function wait(project, since = 0, timeout_s = 45, fresh = false, accept = null) {
    const s = store(project);
    const end = Date.now() + Math.max(0, Math.min(Number(timeout_s) || 0, WAIT_MAX_S)) * 1000;
    for (;;) {
        const got = read(project, since, fresh, accept);
        if (got.messages.length || Date.now() >= end) return got;
        await new Promise((resolve) => { // a message for another app wakes us too; loop and look again
            const done = () => { clearTimeout(timer); s.waiters.delete(done); resolve(); };
            const timer = setTimeout(done, end - Date.now());
            s.waiters.add(done);
        });
    }
}

/** newThread(project) → thread id; later messages start a fresh chat. */
function newThread(project) {
    const s = store(project);
    s.thread = "t" + (Number(s.thread.slice(1)) + 1);
    return s.thread;
}

function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

module.exports = { family, post, setStatus, list, read, wait, newThread, onChange, WAIT_MAX_S };
