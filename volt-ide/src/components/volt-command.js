// volt-command.js — offer to make this IDE's volt the terminal's `volt`, so
// the terminal, AI apps and the IDE run one version, updated with the IDE.
// Asked once per situation at startup; always available from the app menu.

import * as bottomPanel from "./bottom-panel.js";

const C = window.volt.voltCommand;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const KEY = "voltCommand.dismissed";

function dismissed(sig) { try { return localStorage.getItem(KEY) === sig; } catch (_) { return false; } }
function dismiss(sig) { try { localStorage.setItem(KEY, sig); } catch (_) {} }

export async function offer(fromMenu = false) {
    const st = await C.state().catch(e => ({ state: "error", error: e.message }));
    if (st.state === "unsupported" || st.state === "error") {
        if (fromMenu) bottomPanel.appendOutput(`volt command: ${st.error || "not available on this system yet"}`, "warn");
        return;
    }
    if (st.state === "ok") {
        if (fromMenu) bottomPanel.appendOutput(`The terminal already runs Volt IDE's volt (${st.version}).`, "success");
        return;
    }
    const sig = `${st.state}:${st.other || ""}:${st.otherVersion || ""}`;
    if (!fromMenu && dismissed(sig)) return;
    const msg = st.state === "other"
        ? `<b>Your terminal runs a different volt</b> (${esc(st.otherVersion || "unknown version")} at <code>${esc(st.other)}</code>).<br>Use Volt IDE's volt (${esc(st.version)}) so the terminal, AI apps and the IDE match?`
        : st.state === "not_on_path"
        ? `<b>The volt command isn't on your PATH.</b><br>Add <code>~/.volt/bin</code> so terminals find it?`
        : `<b>Use volt in the terminal?</b><br>Install the <code>volt</code> command — Volt IDE's own, updated with the IDE.`;
    document.querySelector(".vc-toast")?.remove();
    const t = document.createElement("div");
    t.className = "pb-toast vc-toast";
    t.setAttribute("role", "status");
    t.innerHTML = `<span class="pb-toast-ic" aria-hidden="true">›_</span><div>${msg}</div>
        <button type="button" class="lr-btn primary" data-yes>${st.state === "other" ? "Use Volt IDE's volt" : st.state === "not_on_path" ? "Add to PATH" : "Install"}</button>
        <button type="button" class="lr-btn" data-no>Not now</button>`;
    document.body.appendChild(t);
    t.querySelector("[data-no]").onclick = () => { dismiss(sig); t.remove(); };
    t.querySelector("[data-yes]").onclick = async () => {
        t.remove();
        try {
            const r = await C.install({ addToPath: true });
            bottomPanel.appendOutput("volt command: " + r.done.join("; "), "success");
        } catch (e) { bottomPanel.appendOutput("volt command: " + e.message, "error"); }
    };
}

export function init() {
    setTimeout(() => offer(false), 6000); // after the library notices
}
