// Volt Registry Signer — Electron main process.
//
// The maintainer's offline .vlib notary. It talks to the Grid's admin review
// API, lets you read each pending library's driver C + metadata, then signs the
// canonical bytes LOCALLY with the Ed25519 private key and posts back a detached
// {hash,signature}. The private key is read only here (main process) and never
// crosses into the renderer or onto the network.
//
// Security: contextIsolation on, nodeIntegration off. The renderer can only call
// the vetted IPC handlers below (see preload.js).

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const CONFIG_PATH = path.join(os.homedir(), ".volt", "registry-signer.json");

function defaultConfig() {
    return {
        gridUrl: "https://grid.sigma.co.zw",
        adminSecret: "",
        keyPath: path.join(os.homedir(), ".volt", "secrets", "vlib-signing.pem"),
    };
}
function loadConfig() {
    try { return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) }; }
    catch (_) { return defaultConfig(); }
}
function saveConfig(cfg) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// Canonical JSON — sorted keys, byte-identical to grid's canonical.Marshal (Go)
// and the IDE's vlib-verify.js. This is the message that gets signed/verified.
function canonical(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
function signedBytes(c) {
    return Buffer.from(canonical({ manifest: c.manifest, device: c.device, driver: c.driver, header: c.header }), "utf8");
}
function sha256(buf) { return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex"); }

function base(cfg) { return String(cfg.gridUrl || "").replace(/\/+$/, ""); }
function adminHeaders(cfg, extra) { return { "X-Admin-Secret": cfg.adminSecret, ...(extra || {}) }; }

// ---- IPC ----

ipcMain.handle("config:get", () => loadConfig());
ipcMain.handle("config:set", (_e, cfg) => { saveConfig(cfg); return true; });

ipcMain.handle("pending:list", async () => {
    const cfg = loadConfig();
    const res = await fetch(base(cfg) + "/api/internal/admin/review", { headers: adminHeaders(cfg) });
    if (!res.ok) throw new Error(`pending list failed (HTTP ${res.status}) — check Grid URL / admin secret`);
    const j = await res.json();
    return j.data || j;
});

ipcMain.handle("content:get", async (_e, prefix, version) => {
    const cfg = loadConfig();
    const res = await fetch(`${base(cfg)}/api/internal/admin/review/${prefix}/${version}/content`, { headers: adminHeaders(cfg) });
    if (!res.ok) throw new Error(`content failed (HTTP ${res.status})`);
    const c = await res.json();
    return { ...c, hash: sha256(signedBytes(c)) };
});

// Sign + publish. Fetches the content fresh (single source of truth), signs it
// with the local key, posts the detached signature, then re-downloads and
// verifies the published envelope against the public key derived from that key.
ipcMain.handle("sign:publish", async (_e, prefix, version) => {
    const cfg = loadConfig();
    if (!fs.existsSync(cfg.keyPath)) throw new Error(`signing key not found: ${cfg.keyPath}`);
    const priv = crypto.createPrivateKey(fs.readFileSync(cfg.keyPath));
    if (priv.asymmetricKeyType !== "ed25519") throw new Error("signing key is not Ed25519");

    const cr = await fetch(`${base(cfg)}/api/internal/admin/review/${prefix}/${version}/content`, { headers: adminHeaders(cfg) });
    if (!cr.ok) throw new Error(`content failed (HTTP ${cr.status})`);
    const c = await cr.json();
    const bytes = signedBytes(c);
    const hash = sha256(bytes);
    const signature = "ed25519:" + crypto.sign(null, bytes, priv).toString("base64");

    const pr = await fetch(`${base(cfg)}/api/internal/admin/review/${prefix}/${version}/publish`, {
        method: "POST",
        headers: adminHeaders(cfg, { "content-type": "application/json" }),
        body: JSON.stringify({ hash, signature }),
    });
    if (!pr.ok) throw new Error(`publish failed (HTTP ${pr.status}): ${(await pr.text()).slice(0, 160)}`);

    // Confirm the published .vlib verifies against our public key.
    let verified = false;
    try {
        const dr = await fetch(`${base(cfg)}/api/v1/libraries/${prefix}/${version}/download`);
        if (dr.ok) {
            const env = await dr.json();
            const sig = Buffer.from(String(env.signature).slice("ed25519:".length), "base64");
            verified = crypto.verify(null, signedBytes(env), crypto.createPublicKey(priv), sig);
        }
    } catch (_) { /* verification is a confirmation, not a gate */ }
    return { hash, verified };
});

ipcMain.handle("library:reject", async (_e, prefix, version, reason) => {
    const cfg = loadConfig();
    const res = await fetch(`${base(cfg)}/api/internal/admin/review/${prefix}/${version}/reject`, {
        method: "POST",
        headers: adminHeaders(cfg, { "content-type": "application/json" }),
        body: JSON.stringify({ reason: reason || "rejected by maintainer" }),
    });
    if (!res.ok) throw new Error(`reject failed (HTTP ${res.status})`);
    return true;
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1040, height: 700, minWidth: 820, minHeight: 520,
        title: "Volt Registry Signer",
        backgroundColor: "#0d1117",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.loadFile("index.html");
}

app.whenReady().then(createWindow);
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("window-all-closed", () => app.quit());
