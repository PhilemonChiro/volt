// Volt Registry Signer — the maintainer's offline .vlib signing app.
//
// SECURITY MODEL: the Ed25519 private key and the Grid admin secret live ONLY in
// this main process. The renderer (UI) never sees them — it drives everything
// through IPC. Signing happens here, over canonical bytes fetched from the Grid;
// the key never leaves this machine. Mirrors scripts/sign-vlib.mjs as a GUI.

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

// Reuse the IDE's canonicalizer + verifier so signed bytes match server + IDE.
const vlib = require(path.join(__dirname, "..", "volt-ide", "src", "main", "vlib-verify.js"));

const CONFIG_PATH = path.join(os.homedir(), ".volt", "signer-config.json");
const DEFAULT_CONFIG = {
    gridUrl: "https://grid.sigma.co.zw",
    adminSecret: "",
    keyFile: path.join(os.homedir(), ".volt", "secrets", "vlib-signing.pem"),
};

function loadConfig() {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) }; }
    catch (_) { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(cfg) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// Minimal JSON HTTP client (no deps). Returns { status, json }.
function request(method, url, headers, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === "https:" ? https : http;
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const opts = {
            method,
            headers: { ...headers, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) },
        };
        const req = lib.request(u, opts, (res) => {
            let b = ""; res.setEncoding("utf8");
            res.on("data", (c) => b += c);
            res.on("end", () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) {} resolve({ status: res.statusCode, json: j, text: b }); });
        });
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });
}

function authHeaders() { return { "X-Admin-Secret": loadConfig().adminSecret }; }
function gridUrl(p) { return loadConfig().gridUrl.replace(/\/$/, "") + p; }

// --- Signing (main process only) ---------------------------------------------
function signContent(content) {
    const cfg = loadConfig();
    const priv = crypto.createPrivateKey(fs.readFileSync(cfg.keyFile));
    if (priv.asymmetricKeyType !== "ed25519") throw new Error("signing key is not Ed25519");
    const msg = Buffer.from(vlib.canonical({
        manifest: content.manifest, device: content.device, driver: content.driver, header: content.header,
    }), "utf8");
    const hash = "sha256:" + crypto.createHash("sha256").update(msg).digest("hex");
    const signature = "ed25519:" + crypto.sign(null, msg, priv).toString("base64");
    return { hash, signature };
}

// --- IPC ---------------------------------------------------------------------
ipcMain.handle("config:get", () => {
    const c = loadConfig();
    return { gridUrl: c.gridUrl, keyFile: c.keyFile, hasSecret: !!c.adminSecret, keyExists: fs.existsSync(c.keyFile) };
});
ipcMain.handle("config:set", (_e, patch) => { saveConfig({ ...loadConfig(), ...patch }); return true; });

ipcMain.handle("pending:list", async () => {
    const r = await request("GET", gridUrl("/api/internal/admin/review"), authHeaders());
    if (r.status !== 200) throw new Error(`list ${r.status}: ${r.text.slice(0, 120)}`);
    return r.json.data || r.json || [];
});

ipcMain.handle("content:get", async (_e, prefix, version) => {
    const r = await request("GET", gridUrl(`/api/internal/admin/review/${prefix}/${version}/content`), authHeaders());
    if (r.status !== 200) throw new Error(`content ${r.status}`);
    const c = r.json;
    // Compute (but don't sign) the hash so the maintainer sees what they'll sign.
    const msg = vlib.canonical({ manifest: c.manifest, device: c.device, driver: c.driver, header: c.header });
    const hash = "sha256:" + crypto.createHash("sha256").update(Buffer.from(msg, "utf8")).digest("hex");
    return { ...c, hash };
});

ipcMain.handle("sign", async (_e, prefix, version) => {
    const cr = await request("GET", gridUrl(`/api/internal/admin/review/${prefix}/${version}/content`), authHeaders());
    if (cr.status !== 200) throw new Error(`content ${cr.status}`);
    const { hash, signature } = signContent(cr.json);
    const pr = await request("POST", gridUrl(`/api/internal/admin/review/${prefix}/${version}/publish`), authHeaders(), { hash, signature });
    if (pr.status !== 200) throw new Error(`publish ${pr.status}: ${pr.text.slice(0, 140)}`);
    // Independent verification: download the published .vlib and check it against
    // the pinned public key — proves the round-trip end to end.
    const dl = await request("GET", gridUrl(`/api/v1/libraries/${prefix}/${version}/download`), {});
    let verified = false, keyId = null;
    if (dl.status === 200 && dl.json) { const v = vlib.verify(dl.json); verified = v.ok; keyId = v.keyId; }
    return { ok: true, hash, verified, keyId };
});

ipcMain.handle("reject", async (_e, prefix, version, reason) => {
    const r = await request("POST", gridUrl(`/api/internal/admin/review/${prefix}/${version}/reject`), authHeaders(), { reason });
    if (r.status !== 200) throw new Error(`reject ${r.status}`);
    return { ok: true };
});

// --- Window ------------------------------------------------------------------
function createWindow() {
    const win = new BrowserWindow({
        width: 1100, height: 720, title: "Volt Registry Signer",
        backgroundColor: "#0b0d10",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,   // renderer can't reach node / the key
            nodeIntegration: false,
            sandbox: true,
        },
    });
    win.loadFile("index.html");
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
