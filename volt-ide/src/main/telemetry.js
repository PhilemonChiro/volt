// Anonymous usage stats, crash reports, feedback and remote config.
//
// - Usage events go to pulse (pulse.voltembedded.com/v1/events) in batches.
//   Offline or failed batches stay queued on disk and retry later.
// - Crashes and uncaught errors go to GlitchTip through the Sentry SDK.
// - Both are on by default and can be turned off separately in
//   Settings > Privacy. Turning one off stops sending at once.
//
// What is sent: a random install ID (not tied to the person or the machine),
// IDE version, OS, CPU architecture, chip names, which features were used,
// build/flash/check outcomes and the first line of an error with paths and
// user names removed. Never source code, file contents or project names.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");
const settings = require("./settings");

const PULSE_URL = "https://pulse.voltembedded.com";
// GlitchTip project DSN (public by design: it only allows sending events).
// Remote config can supply one too, so a release made before GlitchTip was set
// up still reports once it is.
const SENTRY_DSN = "";

const DIR = path.join(os.homedir(), ".volt");
const ID_FILE = path.join(DIR, "install-id");
const QUEUE_FILE = path.join(DIR, "telemetry-queue.json");
const CONFIG_FILE = path.join(DIR, "remote-config.json");

const FLUSH_MS = 60 * 1000;
const MAX_BATCH = 200;
const MAX_QUEUE = 2000;
const FEATURE_THROTTLE_MS = 10 * 60 * 1000;

let queue = [];
let flushing = false;
let timer = null;
let installId = null;
let sentry = null;
const featureLast = new Map();

// ---- identity & scrubbing --------------------------------------------------

function getInstallId() {
    if (installId) return installId;
    try {
        installId = fs.readFileSync(ID_FILE, "utf-8").trim();
    } catch (_) {}
    if (!/^[A-Za-z0-9-]{8,64}$/.test(installId || "")) {
        installId = crypto.randomUUID();
        try {
            fs.mkdirSync(DIR, { recursive: true });
            fs.writeFileSync(ID_FILE, installId);
        } catch (_) {}
    }
    return installId;
}

const HOME = os.homedir();
const USER = (() => { try { return os.userInfo().username; } catch (_) { return ""; } })();

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
const HOME_RE = HOME ? new RegExp(escapeRe(HOME) + "|" + escapeRe(HOME.replace(/\\/g, "/")), "gi") : null;
const USER_RE = USER && USER.length > 2 ? new RegExp("\\b" + escapeRe(USER) + "\\b", "gi") : null;

// scrub removes the home folder and user name from free text.
function scrub(s) {
    if (typeof s !== "string") return s;
    if (HOME_RE) s = s.replace(HOME_RE, "~");
    if (USER_RE) s = s.replace(USER_RE, "<user>");
    return s;
}

// errorKey turns an error message into a groupable key: first line, paths cut
// to their file name, numbers folded, so the same failure counts together.
function errorKey(msg) {
    if (!msg) return "";
    let s = scrub(String(msg)).split("\n").map(l => l.trim()).find(Boolean) || "";
    s = s.replace(/(?:[A-Za-z]:)?[~\/\\][^\s:'"]*[\/\\]([^\/\\\s:'"]+)/g, "$1");
    s = s.replace(/\b0x[0-9a-f]+\b/gi, "0x…").replace(/\d+/g, "N");
    return s.slice(0, 200);
}

// ---- consent ----------------------------------------------------------------

function usageOn() { return settings.get("privacy.usageStats") !== false; }
function crashesOn() { return settings.get("privacy.crashReports") !== false; }
// Development runs never report.
function disabled() { return !app.isPackaged || process.env.VOLT_TELEMETRY === "0"; }

// ---- usage events -----------------------------------------------------------

function track(name, props = {}) {
    if (disabled() || !usageOn()) return;
    const clean = {};
    for (const [k, v] of Object.entries(props || {})) {
        if (typeof v === "string") clean[k] = scrub(v).slice(0, 300);
        else if (typeof v === "number" || typeof v === "boolean") clean[k] = v;
    }
    queue.push({ name, at: Date.now(), props: clean });
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    if (queue.length >= MAX_BATCH) flush();
}

// feature records use of a feature at most once per 10 minutes, so chatty
// actions (diagrams redraw on every edit) count as uses, not calls.
function feature(name) {
    const now = Date.now();
    if (now - (featureLast.get(name) || 0) < FEATURE_THROTTLE_MS) return;
    featureLast.set(name, now);
    track("feature", { feature: name });
}

function client() {
    return {
        installId: getInstallId(),
        appVersion: app.getVersion(),
        os: process.platform,
        osVersion: typeof process.getSystemVersion === "function" ? process.getSystemVersion() : os.release(),
        arch: process.arch,
        channel: app.getVersion().includes("-") ? "beta" : "stable",
    };
}

async function post(route, body, timeoutMs = 15000) {
    const res = await fetch(PULSE_URL + route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
}

async function flush() {
    if (flushing || !queue.length || disabled()) return;
    if (!usageOn()) { queue = []; return; }
    flushing = true;
    const batch = queue.splice(0, MAX_BATCH);
    try {
        await post("/v1/events", { ...client(), events: batch });
    } catch (_) {
        // Offline or server down: keep the events for the next attempt.
        queue.unshift(...batch);
    } finally {
        flushing = false;
    }
}

function loadQueue() {
    try {
        const q = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
        if (Array.isArray(q)) queue = q.slice(-MAX_QUEUE).concat(queue);
        fs.unlinkSync(QUEUE_FILE);
    } catch (_) {}
}

function saveQueue() {
    if (!queue.length || !usageOn()) return;
    try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue.slice(-MAX_QUEUE))); } catch (_) {}
}

// ---- remote config ------------------------------------------------------------

function cachedConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) || {}; } catch (_) { return {}; }
}

async function refreshConfig() {
    try {
        const res = await fetch(PULSE_URL + "/v1/config", { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return;
        const cfg = await res.json();
        if (cfg && typeof cfg === "object") {
            fs.mkdirSync(DIR, { recursive: true });
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg));
        }
    } catch (_) {}
}

const DEFAULT_DISCORD = "https://discord.gg/voltembedded";

function config() {
    const c = cachedConfig();
    const https = (v) => typeof v === "string" && v.startsWith("https://") ? v : "";
    return { discordUrl: https(c.discordUrl) || DEFAULT_DISCORD };
}

// ---- crash reports (GlitchTip via Sentry SDK) ----------------------------------

// initCrashReports must run before app "ready" (the SDK hooks the crash
// reporter). It only starts when crash reports are on at launch; turning them
// off later is honoured in beforeSend.
function initCrashReports() {
    const dsn = SENTRY_DSN || (typeof cachedConfig().sentryDsn === "string" ? cachedConfig().sentryDsn : "");
    if (disabled() || !crashesOn() || !dsn.startsWith("https://")) return;
    try {
        sentry = require("@sentry/electron/main");
        sentry.init({
            dsn,
            release: `volt-ide@${app.getVersion()}`,
            environment: app.getVersion().includes("-") ? "beta" : "production",
            sendDefaultPii: false,
            tracesSampleRate: 0,
            beforeSend(event) {
                if (!crashesOn()) return null;
                delete event.server_name;
                event.user = { id: getInstallId() };
                try { return JSON.parse(scrub(JSON.stringify(event))); } catch (_) { return event; }
            },
            beforeBreadcrumb(b) {
                // Console breadcrumbs can carry project paths and output.
                return b.category === "console" ? null : b;
            },
        });
    } catch (e) {
        sentry = null;
        console.warn("[telemetry] crash reports unavailable:", e.message);
    }
}

// rendererError forwards an uncaught renderer error (the renderer has no SDK).
function rendererError(err) {
    if (!sentry || !crashesOn() || !err) return;
    const e = new Error(scrub(String(err.message || "Renderer error")).slice(0, 1000));
    e.name = String(err.name || "Error").slice(0, 100);
    if (err.stack) e.stack = scrub(String(err.stack)).slice(0, 8000);
    sentry.captureException(e, { tags: { process: "renderer", kind: err.kind || "error" } });
}

// ---- feedback ---------------------------------------------------------------------

async function sendFeedback({ kind, message, email, includeLogs }, readLogs) {
    const body = {
        ...client(),
        kind: ["bug", "idea", "praise", "other"].includes(kind) ? kind : "other",
        message: String(message || "").slice(0, 10000),
        email: String(email || "").trim().slice(0, 200),
        logs: "",
    };
    if (!body.message.trim()) return { ok: false, error: "Write a message first." };
    if (includeLogs) {
        try { body.logs = scrub(readLogs()).slice(-300 * 1024); } catch (_) {}
    }
    try {
        await post("/v1/feedback", body, 30000);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: "Couldn't send feedback — check your connection and try again." };
    }
}

// ---- lifecycle -----------------------------------------------------------------------

function start() {
    if (disabled()) return;
    loadQueue();
    track("app_start", { electron: process.versions.electron, locale: app.getLocale() });
    refreshConfig();
    // First flush shortly after launch, then once a minute.
    setTimeout(flush, 10 * 1000);
    timer = setInterval(flush, FLUSH_MS);
    if (timer.unref) timer.unref();
    app.on("before-quit", () => {
        track("app_quit", { minutes: Math.round(process.uptime() / 60) });
        saveQueue();
    });
}

module.exports = {
    start, track, feature, errorKey, flush, config, refreshConfig,
    initCrashReports, rendererError, sendFeedback, getInstallId,
};
