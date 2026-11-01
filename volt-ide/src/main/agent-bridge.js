// Agent bridge — lets AI agents connected through `volt mcp` work in the
// running IDE. JSON-RPC over HTTP on 127.0.0.1, guarded by a random token
// that only this user can read (~/.volt/ide.json). Screenshots, serial and
// build/run results are handled here; editor and view actions run in the
// renderer (agent:call → agent:reply).

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { ipcMain, dialog } = require("electron");
const policy = require("./agent-policy");

const INFO_FILE = path.join(os.homedir(), ".volt", "ide.json");
const SERIAL_MAX = 2000;
const MINUTE = 60_000;

// Given (in VOLT_AGENT_HOST) to the `volt mcp` of the IDE's own chat agents, which
// ask the user with approval cards; any other caller is asked here with a dialog.
const hostToken = crypto.randomBytes(16).toString("hex");

// Renderer methods and how long each may take.
const RENDERER_TIMEOUTS = { build: 20 * MINUTE, run: 20 * MINUTE, open: MINUTE, walkthrough: 31 * MINUTE, ask: 31 * MINUTE };

/**
 * start({ getWin, getProject, settings, onSend, isMonitoring, version, logger, onActivity, extraMethods })
 *   onActivity(client) is told about every agent call; extraMethods are
 *   main-process methods added to the bridge (e.g. library approvals).
 *   onSend(fn) subscribes fn(channel, data) to everything main sends the
 *   renderer and returns an unsubscribe function.
 */
function start({ getWin, getProject, settings, onSend, isMonitoring, version, logger, onActivity, extraMethods }) {
    const token = crypto.randomBytes(32).toString("hex");

    // ---- renderer round trips ----
    const pending = new Map();
    let nextId = 1;
    ipcMain.on("agent:reply", (_e, { id, result, error }) => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(p.timer);
        if (error) p.reject(new Error(error)); else p.resolve(result);
    });
    function callRenderer(method, params, client) {
        const win = getWin();
        if (!win) return Promise.reject(new Error("The IDE window is not open."));
        const id = nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`The IDE did not finish ${method} in time.`));
            }, RENDERER_TIMEOUTS[method] || 30_000);
            pending.set(id, { resolve, reject, timer });
            win.webContents.send("agent:call", { id, method, params: params || {}, client: client || null });
        });
    }

    // ---- serial ring buffer (everything the monitor prints) ----
    const serial = [];
    let serialSeq = 0;
    onSend((channel, data) => {
        if (channel !== "serial:data" || !data || typeof data.line !== "string") return;
        serial.push({ seq: ++serialSeq, line: data.line });
        if (serial.length > SERIAL_MAX) serial.shift();
    });

    // build:progress events sent while fn runs.
    async function collectBuild(fn) {
        const events = [];
        const off = onSend((channel, data) => { if (channel === "build:progress") events.push(data); });
        try {
            const result = await fn();
            return { result, events };
        } finally {
            off();
        }
    }

    function buildSummary(result, events) {
        const done = events.find(e => e.stage === "done");
        const errors = events.filter(e => e.stage === "error").map(e => e.message);
        const problems = (result && result.problems) || [];
        return {
            ok: !!done && errors.length === 0 && problems.length === 0,
            artifact: done ? done.artifact : undefined,
            size: done ? done.size : undefined,
            errors: errors.length ? errors : undefined,
            problems: problems.length ? problems : undefined,
        };
    }

    // ---- permissions (agent-policy.js) ----
    const allowedUntilClose = new Set(); // action keys the user allowed for this IDE session
    async function describe(key, params) {
        if (key !== "flash") return `An AI agent wants to ${policy.label(key).toLowerCase()}.`;
        const st = await callRenderer("status");
        const project = path.basename(st.project || st.file || "") || "the open program";
        const port = params.port;
        const b = port ? (st.boards || []).find(x => x.port === port) || { port } : st.board;
        const board = b ? `the ${b.chip || "board"} on ${b.port}` : "the connected board";
        return `An AI agent wants to build ${project} and flash it to ${board}.`;
    }
    async function gate(method, params, builtin, client) {
        const project = getProject ? getProject() : null;
        const key = policy.action(method, params, project || "");
        if (!key) return;
        const level = policy.level(key, project, settings);
        if (level === "never") throw new Error(policy.refusal(key));
        if (level === "allow" || builtin || allowedUntilClose.has(key)) return; // built-in chat asked with a card
        const { response } = await dialog.showMessageBox(getWin(), {
            type: "question",
            buttons: ["Allow once", "Allow until Volt IDE closes", "Don't allow"],
            defaultId: 2, cancelId: 2,
            title: "Allow AI agent?",
            message: await describe(key, params),
            detail: `${client ? client + " is asking. " : ""}Change what agents may do in Settings → AI agent permissions.`,
        });
        if (response === 2) throw new Error("The user did not allow this.");
        if (response === 1) allowedUntilClose.add(key);
    }
    ipcMain.handle("agent:voltPath", () => require("./volt-cli").bin());

    const methods = {
        ...(extraMethods || {}),
        hello: async () => ({ version }),
        agent_hello: async () => ({ version }), // `volt mcp` connected; the activity event names the app
        // `volt mcp` asks before work it does itself (library_write writes files, then asks for approval).
        agent_gate: async () => ({ ok: true }), // the gate runs before every method, below

        screenshot: async ({ target = "window", max_width = 1600 } = {}) => {
            const win = getWin();
            if (!win) throw new Error("The IDE window is not open.");
            if (win.isMinimized()) win.restore();
            await callRenderer("paint"); // capture what the last call changed, not the frame before
            let rect;
            if (target !== "window") {
                rect = await callRenderer("rect", { target });
                const zf = win.webContents.getZoomFactor();
                rect = { x: Math.round(rect.x * zf), y: Math.round(rect.y * zf),
                         width: Math.round(rect.width * zf), height: Math.round(rect.height * zf) };
            }
            let img = await win.webContents.capturePage(rect);
            if (img.getSize().width > max_width) img = img.resize({ width: max_width });
            const { width, height } = img.getSize();
            return { png: img.toPNG().toString("base64"), width, height };
        },

        serial: async ({ seconds = 5, since = 0, start = true } = {}) => {
            let note;
            if (!isMonitoring() && start) {
                try { await callRenderer("monitor_start"); } catch (e) { note = e.message; }
            }
            const wait = Math.max(0, Math.min(Number(seconds) || 0, 60));
            await new Promise(r => setTimeout(r, wait * 1000));
            const lines = serial.filter(l => l.seq > since).slice(-500);
            return { lines: lines.map(l => l.line), next: serialSeq, monitoring: isMonitoring(), note };
        },

        build: async () => {
            const { result, events } = await collectBuild(() => callRenderer("build"));
            return buildSummary(result, events);
        },

        run: async ({ port } = {}) => {
            const { result, events } = await collectBuild(() => callRenderer("run", { port }));
            const s = buildSummary(result, events);
            if (s.ok) { s.port = s.artifact; delete s.artifact; }
            return s;
        },
    };

    // ---- HTTP server ----
    const server = http.createServer((req, res) => {
        const reply = (status, body) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(body));
        };
        if (req.method !== "POST" || req.url !== "/rpc") return reply(404, { error: "not found" });
        if (req.headers.origin) return reply(403, { error: "browser requests are not accepted" });
        // DNS rebinding: a page on evil.example resolved to 127.0.0.1 still sends its own Host.
        const { port } = server.address();
        if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
            return reply(403, { error: "bad host" });
        }
        const auth = Buffer.from(req.headers.authorization || "");
        const want = Buffer.from("Bearer " + token);
        if (auth.length !== want.length || !crypto.timingSafeEqual(auth, want)) return reply(401, { error: "bad token" });

        let size = 0;
        const chunks = [];
        req.on("data", (c) => {
            size += c.length;
            if (size > 20 * 1024 * 1024) { req.destroy(); return; }
            chunks.push(c);
        });
        req.on("end", async () => {
            let call;
            try { call = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
            catch (_) { return reply(400, { error: "bad JSON" }); }
            const { method, params } = call;
            const client = req.headers["x-volt-client"] || null;
            if (onActivity) onActivity(client);
            try {
                const builtin = req.headers["x-volt-host"] === hostToken;
                await gate(method === "agent_gate" ? String((params || {}).tool || "") : method, params || {}, builtin, client);
                const result = methods[method]
                    ? await methods[method](params || {}, req.headers["x-volt-session"] || null)
                    : await callRenderer(method, params, req.headers["x-volt-client"] || null);
                reply(200, { result: result === undefined ? null : result });
            } catch (e) {
                logger.log("warn", "agent", `${method}: ${e.message}`);
                reply(200, { error: e.message });
            }
        });
    });

    server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        try {
            fs.mkdirSync(path.dirname(INFO_FILE), { recursive: true });
            fs.writeFileSync(INFO_FILE, JSON.stringify({ port, token, pid: process.pid, version }) + "\n", { mode: 0o600 });
            fs.chmodSync(INFO_FILE, 0o600);
            logger.log("info", "agent", `bridge listening on 127.0.0.1:${port}`);
        } catch (e) {
            logger.log("error", "agent", `cannot write ${INFO_FILE}: ${e.message}`);
        }
    });

    return function stop() {
        server.close();
        try {
            const info = JSON.parse(fs.readFileSync(INFO_FILE, "utf8"));
            if (info.pid === process.pid) fs.unlinkSync(INFO_FILE);
        } catch (_) {}
    };
}

module.exports = { start, hostToken };
