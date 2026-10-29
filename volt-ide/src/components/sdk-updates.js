// sdk-updates.js — Volt's update for a library you changed locally waits for
// you: take it (the review sheet then shows exactly what changed) or keep
// yours. Everything else in ~/.volt/sdk updates by itself with a new volt.

import * as bottomPanel from "./bottom-panel.js";
import * as dialog from "./dialog.js";

const U = window.volt.sdkUpdates;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const label = (k) => k === "examples/devices" ? "device examples" : k.replace(/^devices\//, "");

async function show() {
    const kept = await U.pending().catch(() => []);
    if (!kept.length) return;
    document.querySelector(".sdk-toast")?.remove();
    const t = document.createElement("div");
    t.className = "pb-toast sdk-toast";
    t.setAttribute("role", "status");
    const names = kept.map(label).join(", ");
    t.innerHTML = `<span class="pb-toast-ic" aria-hidden="true">↻</span><div><b>Volt has updates for ${esc(names)}.</b><br>
        You changed ${kept.length === 1 ? "it" : "them"} on this computer, so ${kept.length === 1 ? "it wasn't" : "they weren't"} replaced.</div>
        <button type="button" class="lr-btn primary" data-take>Take update</button><button type="button" class="lr-btn" data-keep>Keep mine</button>`;
    document.body.appendChild(t);
    const act = async (fn, verb) => {
        t.remove();
        try {
            const r = await fn(kept);
            bottomPanel.appendOutput(`Device library: ${verb} ${names}${r && r.backup ? ` (previous copies in ${r.backup})` : ""}`, "success");
        } catch (e) { bottomPanel.appendOutput("Device library: " + e.message, "error"); }
    };
    t.querySelector("[data-take]").onclick = async () => {
        if (!await dialog.confirm(`Replace your changes to ${names}?`, { detail: "Volt's update overwrites the files you edited. Your current copies are saved to a backup folder first.", okLabel: "Take update", danger: true })) return;
        act(U.take, "updated");
    };
    t.querySelector("[data-keep]").onclick = () => act(U.keep, "kept your");
}

export function init() {
    setTimeout(show, 2500); // after the window settles and any review sheet opens
}
