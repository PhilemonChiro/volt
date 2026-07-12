const $ = (id) => document.getElementById(id);
let pending = [];
let selected = null;

function toast(msg, kind) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast " + (kind || "");
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, kind === "err" ? 6000 : 3000);
}

function driverOf(driver) {
    if (!driver || typeof driver !== "object") return "";
    for (const k of ["common", "esp32", "rp2040"]) if (driver[k]) return driver[k];
    return "";
}

async function refresh() {
    try {
        pending = await window.signer.listPending();
    } catch (e) { toast(e.message, "err"); return; }
    $("pendingCount").textContent = pending.length;
    const ul = $("pendingList");
    ul.innerHTML = "";
    $("listEmpty").hidden = pending.length > 0;
    for (const p of pending) {
        const li = document.createElement("li");
        li.dataset.key = p.prefix + "@" + p.version;
        li.innerHTML = `<div class="li-name"></div><div class="li-sub"></div>`;
        li.querySelector(".li-name").textContent = p.name || p.prefix;
        li.querySelector(".li-sub").textContent = `${p.prefix} · ${p.category || "—"} · ${p.interface || "—"}`;
        li.onclick = () => select(p, li);
        ul.appendChild(li);
    }
    // keep selection if still present
    if (selected && !pending.find(p => p.prefix === selected.prefix && p.version === selected.version)) {
        selected = null; $("detail").hidden = true; $("detailEmpty").hidden = false;
    }
}

async function select(p, li) {
    document.querySelectorAll("#pendingList li").forEach(el => el.classList.remove("active"));
    if (li) li.classList.add("active");
    selected = p;
    $("detailEmpty").hidden = true;
    $("detail").hidden = false;
    $("dStatus").textContent = "loading…";
    $("dName").textContent = p.name || p.prefix;
    $("dMeta").textContent = "";
    $("dDriver").textContent = "";
    $("dHash").textContent = "";
    $("dCaps").innerHTML = "";
    try {
        const c = await window.signer.getContent(p.prefix, p.version);
        const m = c.manifest || {}, d = c.device || {};
        $("dName").textContent = (m.name || p.prefix);
        $("dMeta").textContent = `${m.prefix}@${m.version}  ·  author: ${m.author || "—"}  ·  ${d.category || "—"}  ·  ${d.description || ""}`;
        $("dStatus").textContent = "trustTier: " + (m.trustTier || "—");
        const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
        $("dCaps").innerHTML = "";
        for (const cap of caps) {
            const s = document.createElement("span"); s.className = "chip"; s.textContent = cap; $("dCaps").appendChild(s);
        }
        $("dDriver").textContent = driverOf(c.driver) || "(no driver source)";
        $("dHash").textContent = c.hash || "";
    } catch (e) {
        $("dStatus").textContent = "";
        toast(e.message, "err");
    }
}

async function doSign() {
    if (!selected) return;
    const p = selected;
    $("signBtn").disabled = true; $("rejectBtn").disabled = true;
    $("signBtn").textContent = "Signing…";
    try {
        const r = await window.signer.signPublish(p.prefix, p.version);
        toast(`Published ${p.prefix}@${p.version}${r.verified ? " ✓ verified" : ""}`, "ok");
        await refresh();
    } catch (e) {
        toast(e.message, "err");
    } finally {
        $("signBtn").disabled = false; $("rejectBtn").disabled = false;
        $("signBtn").textContent = "Sign & Publish";
    }
}

async function doReject() {
    if (!selected) return;
    const p = selected;
    try {
        await window.signer.reject(p.prefix, p.version, "rejected by maintainer");
        toast(`Rejected ${p.prefix}@${p.version}`, "ok");
        await refresh();
    } catch (e) { toast(e.message, "err"); }
}

// ---- settings ----
async function openSettings() {
    const cfg = await window.signer.getConfig();
    $("cfgUrl").value = cfg.gridUrl || "";
    $("cfgSecret").value = cfg.adminSecret || "";
    $("cfgKey").value = cfg.keyPath || "";
    $("settingsModal").hidden = false;
}
async function saveSettings() {
    const cfg = { gridUrl: $("cfgUrl").value.trim(), adminSecret: $("cfgSecret").value, keyPath: $("cfgKey").value.trim() };
    await window.signer.setConfig(cfg);
    $("settingsModal").hidden = true;
    $("gridBadge").textContent = cfg.gridUrl || "not configured";
    toast("Settings saved", "ok");
    refresh();
}

$("settingsBtn").onclick = openSettings;
$("cfgCancel").onclick = () => { $("settingsModal").hidden = true; };
$("cfgSave").onclick = saveSettings;
$("refreshBtn").onclick = refresh;
$("signBtn").onclick = doSign;
$("rejectBtn").onclick = doReject;

(async function init() {
    const cfg = await window.signer.getConfig();
    $("gridBadge").textContent = cfg.gridUrl || "not configured";
    if (!cfg.adminSecret) { openSettings(); }
    else { refresh(); }
})();
