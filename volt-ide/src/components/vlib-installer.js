// Secure .vlib import — renderer side. Flow: native file picker → main verifies
// + validates (vlib-verify + vlib-import) → consent modal (source + capabilities
// + trust) → main re-verifies + installs. The renderer never holds the signing
// trust; it only renders what main reports and passes back the opaque token.

import * as dialog from "./dialog.js";
import * as lib from "./library.js";

const api = window.volt;
const CAP_WARN = new Set(["network", "storage"]);

function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function show(onInstalled) {
    let res;
    try { res = await api.vlibInspectFile(); }
    catch (e) { return dialog.alert("Import failed", { detail: String((e && e.message) || e) }); }
    if (!res || res.canceled) return;

    // Rejected before consent (parse or signature failure) — never offer install.
    if (!res.token) {
        return dialog.alert("Library rejected", {
            detail: res.stage === "verify"
                ? `Signature verification failed: ${res.reason}. Only libraries signed by the Volt registry can be imported.`
                : (res.reason || "The file could not be read."),
        });
    }
    showResult(res, { onClose: onInstalled });
}

// Pretty labels for the heterogeneous spec keys across device.json files.
const SPEC_LABELS = {
    voltage: "Supply voltage", current: "Current draw", temp: "Temperature", temperature: "Temperature",
    pressure: "Pressure", humidity: "Humidity", range: "Range", resolution: "Resolution",
    sample_rate: "Sample rate", interface_speed: "Interface speed", beam_angle: "Beam angle",
    channels: "Channels", accuracy: "Accuracy", field_range: "Field range", gain: "Gain", fifo: "FIFO",
};
const prettyKey = (k) => SPEC_LABELS[k] || (k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " "));

// Dock the (non-modal) detail sheet flush-left of the library side panel so the
// list stays fully visible + scrollable and the user can click through libraries
// without the sheet ever covering them.
function positionDock(el) {
    const gap = 10, top = 54, bottom = 14;
    el.style.top = top + "px";
    el.style.bottom = bottom + "px";
    const side = document.getElementById("sidePanel");
    let rightEdgeX;
    if (side && side.offsetParent !== null && side.getBoundingClientRect().width > 40) {
        rightEdgeX = side.getBoundingClientRect().left - gap;   // just left of the list
    } else {
        rightEdgeX = window.innerWidth - gap;                   // list hidden → dock to the right edge
    }
    const width = Math.max(300, Math.min(470, rightEdgeX - gap));
    el.style.width = width + "px";
    el.style.right = (window.innerWidth - rightEdgeX) + "px";
    el.style.left = "auto";
}

// The library detail sheet — a decision aid AND the install/manage hub. Reused by
// file import, Grid rows (→ Install), and Installed rows (→ Add / Update / Uninstall).
// `opts.onClose` always fires on close (un-sticks the caller's button); `opts.onUse`
// / `opts.onUninstall` power the installed-library actions.
export function showResult(res, opts) {
    if (typeof opts === "function") opts = { onClose: opts };
    opts = opts || {};
    document.getElementById("vlibOverlay")?.remove();

    const m = res.manifest || {};
    const d = res.device || {};
    const tier = m.trustTier || "community";
    const iface = (m.interface || d.interface || "?").toLowerCase();
    const addr = d.default_address ? ` @ ${d.default_address}` : "";
    const subParts = [d.manufacturer, d.category, iface !== "?" ? iface.toUpperCase() + addr : ""].filter(Boolean);

    const specsHtml = Object.entries(d.specs || {}).map(([k, v]) =>
        `<div class="vs-spec"><span>${esc(prettyKey(k))}</span><b>${esc(v)}</b></div>`).join("");

    // A short instance name for the example code (illustrative — the real insert
    // uses a de-duplicated name against the current file).
    const inst = (m.name || d.name || "dev").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "dev";
    // Per-method usage the developer can copy individually, with the description
    // carried along as a leading // comment.
    const methods = Object.entries(d.methods || {}).map(([name, mv]) => {
        const ret = (mv && mv.returns) || "int";
        const ps = (mv && mv.params) || [];
        const sig = `${name}(${ps.map(p => `${p.type || "int"} ${p.name}`).join(", ")})`;
        const call = `${inst}.${name}(${ps.map(p => p.name).join(", ")})`;
        const line = ret && ret !== "void" ? `let v: ${ret} = ${call}` : call;
        const copy = (mv && mv.description ? `// ${mv.description}\n` : "") + line;
        return { name, ret, sig, desc: (mv && mv.description) || "", copy };
    });
    // Context: a Grid library (deciding whether to install) vs an installed one
    // (using / managing it). These are different jobs, so the sheet opens differently.
    const u = res.update;
    const installed = res.alreadyInstalled || !!u;
    const canInstall = res.ok && !(res.errors || []).length && res.token;

    // Methods carry a per-method Copy only once installed (you can only use a lib
    // you have); on the Grid they're a read-only "what you can read" list.
    const methodsHtml = methods.map((mm, i) => `
        <div class="vs-method vs-codewrap">
            ${installed ? `<button class="vs-copy vs-copy-blk" data-mi="${i}" title="Copy">Copy</button>` : ""}
            <pre class="vs-code" data-colorize="volt">${esc(mm.copy)}</pre>
        </div>`).join("");

    // "In your hardware block" — the declaration parts the developer actually writes.
    const busName = { i2c: "i2c0", spi: "spi0", uart: "uart0" }[iface];
    let decl;
    if (iface === "i2c" && busName) decl = `device ${inst}: ${m.name || d.name} on ${busName} at ${d.default_address || "0x00"}`;
    else if (iface === "spi" && busName) decl = `device ${inst}: ${m.name || d.name} on ${busName} at 5  // CS pin`;
    else if (iface === "uart" && busName) decl = `device ${inst}: ${m.name || d.name} on ${busName} at 0`;
    else decl = `device ${inst}: ${m.name || d.name} on gpio_pin at 4  // change pin`;
    const busLine = busName ? ({ i2c: `    bus ${busName}: I2C(sda: 21, scl: 22)\n`, spi: `    bus ${busName}: SPI(sck: 18, mosi: 23, miso: 19)\n`, uart: `    bus ${busName}: UART(tx: 17, rx: 16)\n` }[iface]) : "";
    const hwCode = `hardware {\n${busLine}    ${decl}\n}`;

    const altsHtml = (d.alternatives || []).map(a =>
        `<div class="vs-alt"><b>${esc(a.name)}</b><span>${esc(a.note || "")}</span></div>`).join("");
    const tipsHtml = (d.tips || []).map(t => `<li>${esc(t)}</li>`).join("");
    const pinsHtml = ((d.wiring && d.wiring.pins) || []).map(p =>
        `<tr><td class="vs-pin-l">${esc(p.label)}</td><td class="vs-pin-t">${esc(p.type || "")}</td><td class="vs-pin-n">${esc(p.note || "")}</td></tr>`).join("");
    const capsHtml = (res.capabilities || []).length
        ? (res.capabilities || []).map(c => `<span class="vlib-cap ${CAP_WARN.has(c) ? "vlib-cap-warn" : ""}">${esc(c)}</span>`).join("")
        : `<span class="vlib2-cap-none">none</span>`;

    const section = (title, body, extraClass = "") => body ? `<div class="vs-sec ${extraClass}"><div class="vs-sec-h">${title}</div>${body}</div>` : "";

    // reusable section fragments
    const errs = (res.errors || []).length
        ? `<div class="vlib-note vlib-err"><b>Rejected</b>${res.errors.map(e => `<div>${esc(e)}</div>`).join("")}</div>` : "";
    const banner = u
        ? `<div class="vlib-note vlib-update"><b>Update available: ${/^\d/.test(u.fromVersion) ? "v" + esc(u.fromVersion) : "shipped copy"} → v${esc(u.toVersion)}</b>`
          + (u.capsAdded && u.capsAdded.length ? `<div>New capabilities requested: ${u.capsAdded.map(esc).join(", ")}</div>` : "")
          + (u.fromTier !== u.toTier ? `<div>Trust tier: ${esc(u.fromTier)} → ${esc(u.toTier)}</div>` : "")
          + `</div>` : "";
    const specsSec = section("Key specs", specsHtml ? `<div class="vs-specs">${specsHtml}</div>` : "");
    const methodsSec = section(installed ? "Methods — copy any into your loop" : "What you can read", methodsHtml ? `<div class="vs-methods">${methodsHtml}</div>` : "");
    const altsSec = section("Alternatives", altsHtml ? `<div class="vs-alts">${altsHtml}</div>` : "");
    const tipsSec = section("Tips", tipsHtml ? `<ul class="vs-tips">${tipsHtml}</ul>` : "");
    const hwSec = section("In your hardware block", `<div class="vs-codewrap"><button class="vs-copy vs-copy-blk" data-copy="hw" title="Copy">Copy</button><pre class="vs-code" data-colorize="volt">${esc(hwCode)}</pre></div>`);
    const pinsSec = pinsHtml ? `<details class="vlib2-src vs-details"><summary>Wiring · pinout</summary><table class="vs-pins">${pinsHtml}</table></details>` : "";
    // Private (collection) libs are trusted by your login, not a registry
    // signature — say so honestly rather than claiming "Signature verified".
    const trustSec = res.local
        ? `<div class="vs-trust vs-trust-private">
                    <span class="vs-trust-check">◇</span>
                    <span>Device library on this machine · not from the Grid, <b>unsigned</b>${d.c_source ? ` · <b>${esc(d.c_source)}</b>` : ""}</span>
                </div>`
        : res.private
        ? `<div class="vs-trust vs-trust-private">
                    <span class="vs-trust-check">◇</span>
                    <span>Private library · <b>unsigned</b> — your own, not registry-verified · <b class="vlib-tier vlib-tier-community">private</b></span>
                    <span class="vs-trust-caps">${capsHtml}</span>
                </div>`
        : `<div class="vs-trust">
                    <span class="vs-trust-check">&#10003;</span>
                    <span>Signature verified · signed by <b>${esc(res.keyId || "—")}</b> · author <b>${esc(m.author || "—")}</b> · <b class="vlib-tier vlib-tier-${esc(tier)}">${esc(tier)}</b></span>
                    <span class="vs-trust-caps">${capsHtml}</span>
                </div>`;
    const driverSec = `<details class="vlib2-src vs-details"><summary>Driver C — the code that runs on your device</summary><pre class="vs-code" data-colorize="c">${esc(res.driver || "")}</pre></details>`;
    const useBox = `<div class="vs-sec vs-usebox"><button class="wiz-btn wiz-btn-primary vs-use-main" id="vlibUse">Add to project — device + bus + sample</button></div>`;

    // installed → lead with USING it; grid → lead with DECIDING (specs first)
    const body = installed
        ? `${banner}${errs}${useBox}${hwSec}${methodsSec}${specsSec}${altsSec}${tipsSec}${pinsSec}${trustSec}${driverSec}`
        : `${errs}${specsSec}${methodsSec}${altsSec}${tipsSec}${pinsSec}${trustSec}${driverSec}`;

    // context-aware footer
    const footer = installed
        ? (opts.onUninstall === null ? "" : `<button class="wiz-btn wiz-btn-danger" id="vlibUninstall">Uninstall</button>`) + `<div class="vs-foot-gap"></div>`
          + (u && canInstall ? `<button class="wiz-btn wiz-btn-primary" id="vlibInstall">Update to v${esc(u.toVersion)}</button>` : "")
          + `<button class="wiz-btn" id="vlibDone">Done</button>`
        : `<button class="wiz-btn" id="vlibCancel">Cancel</button>`
          + `<button class="wiz-btn wiz-btn-primary" id="vlibInstall" ${canInstall ? "" : "disabled"}>Install</button>`;

    const headBadge = res.local
        ? `<span class="vs-installed-badge">On this machine</span>`
        : installed
        ? `<span class="vs-installed-badge">Installed</span>`
        : `<span class="vs-tier-badge vs-tier-${esc(tier)}">${esc(tier)}</span>`;

    const panel = document.createElement("div");
    panel.id = "vlibOverlay";
    panel.className = "vlib2 vlib2-sheet vlib2-dock " + (installed ? "vlib2-installed" : "vlib2-grid");
    panel.innerHTML = `
            <div class="vlib2-head">
                <span class="lib-ic lib-ic-${esc(iface)}">${esc(iface === "?" ? "•" : iface.toUpperCase())}</span>
                <div class="vlib2-head-txt">
                    <div class="vlib2-title">${esc(m.name || d.name || "Library")} ${m.version || !res.local ? `<span class="vlib2-ver">v${esc(m.version || "?")}</span>` : ""}${headBadge}</div>
                    <div class="vlib2-sub">${esc(subParts.join(" · ") || m.description || "Signed Volt library")}</div>
                </div>
                ${d.datasheet ? `<button class="vs-link" id="vlibDatasheet" title="Open datasheet">Datasheet ↗</button>` : ""}
                <button class="vlib2-x" id="vlibClose" aria-label="Close">&times;</button>
            </div>
            <div class="vlib2-body">
                ${d.description ? `<div class="vs-lead">${esc(d.description)}</div>` : ""}
                ${body}
            </div>
            <div class="vlib2-foot">${footer}</div>`;
    document.body.appendChild(panel);
    positionDock(panel);
    const onResize = () => positionDock(panel);
    window.addEventListener("resize", onResize);

    // Monaco syntax-highlight the code blocks (lightweight colorize, no editors).
    // Driver C is lazily colorized when its <details> is first opened.
    const colorize = (el) => {
        if (!el || el.dataset.lit || typeof monaco === "undefined" || !monaco.editor || !monaco.editor.colorize) return;
        el.dataset.lit = "1";
        monaco.editor.colorize(el.textContent, el.dataset.colorize, {}).then(html => { el.innerHTML = html; }).catch(() => {});
    };
    panel.querySelectorAll('.vs-code[data-colorize="volt"]').forEach(colorize);
    panel.querySelectorAll('details.vs-details').forEach(det => det.addEventListener("toggle", () => { if (det.open) det.querySelectorAll('.vs-code[data-colorize]').forEach(colorize); }, { once: false }));

    const onKey = (e) => { if (e.key === "Escape") close(); };
    const close = () => { panel.remove(); document.removeEventListener("keydown", onKey); window.removeEventListener("resize", onResize); if (opts.onClose) opts.onClose(); };
    document.addEventListener("keydown", onKey);
    const flash = (el, txt) => { if (!el) return; const o = el.textContent; el.textContent = txt; el.disabled = true; setTimeout(() => { el.textContent = o; el.disabled = false; }, 1100); };
    const copyText = (t, el) => { navigator.clipboard.writeText(t).catch(() => {}); flash(el, "Copied ✓"); };

    panel.querySelector("#vlibClose").onclick = close;
    panel.querySelector("#vlibDone")?.addEventListener("click", close);
    panel.querySelector("#vlibCancel")?.addEventListener("click", close);
    panel.querySelector("#vlibDatasheet")?.addEventListener("click", () => api.openExternal(d.datasheet));
    // Add to project → do it, then close the sheet
    panel.querySelector("#vlibUse")?.addEventListener("click", () => { close(); if (opts.onUse) opts.onUse(); });
    panel.querySelector("#vlibUninstall")?.addEventListener("click", () => { close(); if (opts.onUninstall) opts.onUninstall(); });
    // copy the hardware block
    panel.querySelector('[data-copy="hw"]')?.addEventListener("click", (e) => copyText(hwCode, e.currentTarget));
    // copy an individual method (with its description comment)
    panel.querySelectorAll(".vs-copy[data-mi]").forEach(b => b.addEventListener("click", (e) => copyText(methods[Number(b.dataset.mi)].copy, e.currentTarget)));

    const btn = panel.querySelector("#vlibInstall");
    if (btn && canInstall) btn.onclick = async () => {
        const updating = installed;
        if (u) {
            const older = lib.verCmp(u.toVersion, u.fromVersion) < 0;
            const ok = await dialog.confirm(`${older ? "Switch" : "Update"} ${res.name || res.prefix || "library"} to v${u.toVersion}?`, {
                detail: `Replaces the installed ${/^\d/.test(u.fromVersion) ? "v" + u.fromVersion : "copy Volt shipped"}${older ? " with an older version" : ""}. Any changes you made to its files on this computer are overwritten.`,
                okLabel: older ? `Switch to v${u.toVersion}` : `Update to v${u.toVersion}`, danger: older });
            if (!ok) return;
        }
        btn.disabled = true; btn.textContent = updating ? "Updating…" : "Installing…";
        try {
            const r = await api.vlibInstall(res.token);
            close();   // fires onClose → panel refreshes to the installed state
            await dialog.alert(updating ? "Library updated" : "Library installed", { detail: `${r.installed} v${r.version} — ready to use in your hardware block.` });
        } catch (e) {
            btn.disabled = false; btn.textContent = updating ? "Update to v" + esc((u && u.toVersion) || "") : "Install";
            await dialog.alert("Install failed", { detail: String((e && e.message) || e) });
        }
    };
}
