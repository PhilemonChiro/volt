// Renderer — pure UI. No node, no key, no secret: everything goes through
// window.signer (see preload.js), handled in the main process.

const $ = (id) => document.getElementById(id);
let pending = [];
let selected = null;

function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

async function refreshConfig() {
    const c = await window.signer.getConfig();
    $("grid-url").textContent = new URL(c.gridUrl).host;
    return c;
}

async function loadPending() {
    try {
        pending = await window.signer.listPending();
    } catch (e) {
        pending = [];
        $("queue-empty").textContent = "Error: " + e.message + " — check Settings.";
        $("queue-empty").hidden = false;
    }
    renderQueue();
}

function renderQueue() {
    const ul = $("pending-list");
    ul.innerHTML = "";
    $("pending-count").textContent = pending.length;
    $("queue-empty").hidden = pending.length > 0;
    for (const p of pending) {
        const li = document.createElement("li");
        li.innerHTML = `<span class="dot"></span><b>${esc(p.prefix)}</b>` +
            `<span class="sub">${esc(p.name || "")} · ${esc(p.category || "")} · ${esc(p.interface || "")}</span>`;
        li.onclick = () => select(p);
        if (selected && selected.prefix === p.prefix && selected.version === p.version) li.classList.add("active");
        ul.appendChild(li);
    }
}

async function select(p) {
    selected = p;
    renderQueue();
    $("detail-empty").hidden = true;
    $("detail-body").hidden = false;
    $("result").hidden = true;
    $("d-title").textContent = `${p.prefix} @ ${p.version}`;
    $("d-driver").textContent = "loading…";
    try {
        const c = await window.signer.getContent(p.prefix, p.version);
        const m = c.manifest || {}, d = c.device || {};
        $("d-meta").innerHTML = [
            ["name", m.name || d.name], ["author", m.author], ["interface", m.interface],
            ["trustTier", m.trustTier], ["category", d.category],
            ["capabilities", Array.isArray(m.capabilities) ? m.capabilities.join(", ") : ""],
            ["description", d.description],
        ].filter(([, v]) => v).map(([k, v]) => `<span class="kv"><em>${k}</em> ${esc(v)}</span>`).join("");
        const drv = c.driver || {};
        $("d-driver").textContent = drv.common || drv.esp32 || drv.rp2040 || "(no driver source)";
        $("d-hash").textContent = c.hash;
    } catch (e) {
        $("d-driver").textContent = "Error loading content: " + e.message;
    }
}

async function doSign() {
    if (!selected) return;
    const btn = $("sign-btn");
    btn.disabled = true; btn.textContent = "Signing…";
    const res = $("result");
    try {
        const r = await window.signer.sign(selected.prefix, selected.version);
        res.hidden = false;
        res.className = "result ok";
        res.innerHTML = `✓ Published <b>${esc(selected.prefix)}@${esc(selected.version)}</b><br>` +
            `${esc(r.hash)}<br>` +
            (r.verified ? `verified against pinned key <b>${esc(r.keyId)}</b>` : `⚠ published but pinned-key verify returned false`);
        await loadPending();
        selected = null;
        $("detail-body").hidden = true;
        $("detail-empty").hidden = false;
    } catch (e) {
        res.hidden = false; res.className = "result err";
        res.textContent = "Sign failed: " + e.message;
    } finally {
        btn.disabled = false; btn.textContent = "Sign & Publish";
    }
}

async function doReject() {
    if (!selected) return;
    const reason = prompt("Reject reason (shown in the queue):", "");
    if (reason === null) return;
    try {
        await window.signer.reject(selected.prefix, selected.version, reason);
        await loadPending();
        selected = null;
        $("detail-body").hidden = true;
        $("detail-empty").hidden = false;
    } catch (e) {
        alert("Reject failed: " + e.message);
    }
}

// --- Settings ---
async function openSettings() {
    const c = await window.signer.getConfig();
    $("s-grid").value = c.gridUrl;
    $("s-secret").value = "";
    $("s-key").value = c.keyFile;
    $("s-keystate").textContent = c.keyExists
        ? (c.hasSecret ? "✓ key file found · admin secret set" : "✓ key file found · ⚠ admin secret not set")
        : "⚠ signing key file not found";
    $("settings").hidden = false;
}
async function saveSettings() {
    const patch = { gridUrl: $("s-grid").value.trim(), keyFile: $("s-key").value.trim() };
    const secret = $("s-secret").value;
    if (secret) patch.adminSecret = secret;
    await window.signer.setConfig(patch);
    $("settings").hidden = true;
    await refreshConfig();
    await loadPending();
}

$("refresh").onclick = loadPending;
$("settings-btn").onclick = openSettings;
$("s-cancel").onclick = () => { $("settings").hidden = true; };
$("s-save").onclick = saveSettings;
$("sign-btn").onclick = doSign;
$("reject-btn").onclick = doReject;

(async () => {
    const c = await refreshConfig();
    if (!c.hasSecret || !c.keyExists) openSettings();
    await loadPending();
})();
