// Fuse — Grid browser. Lists published Cells from the registry and installs a
// chosen one over HTTP. The download is fed through the exact same verify +
// hardened-import consent flow as a local .vcell file (installer.showResult).

import * as installer from "./vlib-installer.js";
import * as dialog from "./dialog.js";

const api = window.volt;

function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function show(onInstalled) {
    let cells;
    try {
        cells = (await api.gridList()) || [];
    } catch (e) {
        return dialog.alert("Grid unreachable", {
            detail: `${String((e && e.message) || e)}. Check the Grid URL in Settings → Registry.`,
        });
    }

    document.getElementById("gridOverlay")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.id = "gridOverlay";
    overlay.innerHTML = `
        <div class="wizard-dialog grid-dialog">
            <div class="wizard-header">
                <span>Browse Grid — ${cells.length} published cell${cells.length === 1 ? "" : "s"}</span>
                <button class="wizard-close" id="gClose" aria-label="Close">&times;</button>
            </div>
            <div class="wizard-body grid-body">
                ${cells.length === 0
                    ? `<div class="grid-empty">No published cells on the Grid yet.</div>`
                    : cells.map(c => `
                        <div class="grid-row">
                            <span class="grid-name">${esc(c.name)} <span class="grid-ver">v${esc(c.version)}</span></span>
                            <code class="grid-hash">${esc((c.hash || "").replace(/^sha256:/, "").slice(0, 12))}…</code>
                            <button class="wiz-btn grid-install" data-prefix="${esc(c.prefix)}" data-version="${esc(c.version)}">Install</button>
                        </div>`).join("")}
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector("#gClose").onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    overlay.querySelectorAll(".grid-install").forEach(btn => btn.onclick = async () => {
        btn.disabled = true; btn.textContent = "…";
        let res;
        try { res = await api.gridFetch(btn.dataset.prefix, btn.dataset.version); }
        catch (e) { res = { ok: false, reason: String((e && e.message) || e) }; }
        btn.disabled = false; btn.textContent = "Install";
        if (!res || !res.token) {
            return dialog.alert("Cannot install", {
                detail: res && res.stage === "verify"
                    ? `Signature verification failed: ${res.reason}`
                    : (res && res.reason) || "download failed",
            });
        }
        close();
        installer.showResult(res, onInstalled);   // same consent + install as file import
    });
}
