// publish-dialog.js — publish one of your device libraries to the Grid.
// Every public library is reviewed and signed by a Volt maintainer before
// anyone can install it; this dialog prepares the submission, shows the
// Grid's checks, and submits it (main: src/main/lib-publish.js).

import * as bottomPanel from "./bottom-panel.js";
import * as dialog from "./dialog.js";

const P = window.volt.publish;
let sheet = null;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const STATUS = { pending: "Waiting for review", published: "Published", rejected: "Changes requested", private: "Private", yanked: "Withdrawn" };

function close() {
    if (sheet && onDone) onDone(); // the Library shows the latest status
    sheet?.remove(); sheet = null;
    document.removeEventListener("keydown", keys, true);
}
function keys(e) { if (e.key === "Escape" && !document.querySelector(".dialog-overlay")) { e.preventDefault(); close(); } }

function frame(title, body, foot) {
    if (!sheet) {
        sheet = document.createElement("div");
        sheet.className = "hs-backdrop";
        sheet.addEventListener("mousedown", (e) => { if (e.target === sheet) close(); });
        document.body.appendChild(sheet);
        document.addEventListener("keydown", keys, true);
    }
    sheet.innerHTML = `<div class="pb-sheet" role="dialog" aria-modal="true" aria-labelledby="pbTitle">
        <header class="pb-head"><h2 id="pbTitle">${title}</h2><button type="button" class="hs-x" aria-label="Close">×</button></header>
        <div class="pb-body">${body}</div><footer class="pb-foot">${foot}</footer></div>`;
    sheet.querySelector(".hs-x").onclick = close;
}

let onDone = null; // refreshes whoever opened the dialog (the Library panel)

export async function open(prefix, done) {
    if (done) onDone = done;
    frame(`Publish ${esc(prefix)}`, `<p class="pb-muted">Checking the library…</p>`, "");
    let d;
    try { d = await P.prepare(prefix); }
    catch (e) { return frame(`Publish ${esc(prefix)}`, `<p class="pb-err">${esc(cleanErr(e))}</p>`, `<button type="button" class="lr-btn" data-close>Close</button>`), wireClose(); }
    if (d.builtin || d.fromGrid) {
        frame(`Publish ${esc(prefix)}`, `<p>${d.builtin ? "This is an official Volt library — it's already available to everyone." : "This library was installed from the Grid. Only its author can publish new versions."}</p>`,
            `<button type="button" class="lr-btn" data-close>Close</button>`);
        return wireClose();
    }
    render(d);
}

function wireClose() { sheet.querySelector("[data-close]")?.addEventListener("click", close); }

function cleanErr(e) { return String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""); }

function render(d, msg) {
    const blocking = d.errors.length > 0 || !d.approved;
    // One submission at a time: while a version waits for review (or was just
    // sent), there's nothing to submit — only a way out.
    const waiting = (msg && msg.ok) || d.submitted.some(x => x.status === "pending");
    const prior = d.submitted.length ? `<div class="pb-sec"><h3>Your earlier submissions</h3><ul class="pb-list">${d.submitted.map(x =>
        `<li><code>${esc(x.version)}</code><span class="pb-st st-${esc(x.status)}">${esc(STATUS[x.status] || x.status)}</span>${x.findings ? `<span class="pb-find">${esc(x.findings)}</span>` : ""}</li>`).join("")}</ul></div>` : "";
    const body = `
      <p class="pb-muted">Public libraries are reviewed and signed by a Volt maintainer before anyone can install them. You'll see the result here and in the Library panel.</p>
      <div class="pb-grid">
        <label>Name<input class="ai-input" value="${esc(d.name)}" disabled></label>
        <label>Version<input class="ai-input" data-version value="${esc(d.version)}" spellcheck="false"${waiting ? " disabled" : ""}></label>
      </div>
      <label class="pb-desc">Description<textarea class="ai-input" data-desc rows="2"${waiting ? " disabled" : ""}>${esc(d.description)}</textarea></label>
      <div class="pb-chips"><span class="lr-chip">${esc(String(d.interface || "").toUpperCase())}</span>${d.capabilities.map(c => `<span class="lr-chip">uses ${esc(c)}</span>`).join("")}
        ${d.aiAssisted ? `<span class="lr-chip pb-ai" title="Approved after an AI agent wrote or changed it — reviewers will see this">✦ AI-assisted</span>` : ""}</div>
      <div class="pb-sec"><h3>Checks</h3>
        ${!d.approved ? `<p class="pb-err">Approve this library first (its review sheet) — only code you've reviewed can be published.</p>` : ""}
        ${d.errors.length ? `<ul class="pb-errs">${d.errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : `<p class="pb-ok">✓ Passes the Grid's checks${d.warnings.length ? ` — ${d.warnings.length} note${d.warnings.length > 1 ? "s" : ""} for the reviewer` : ""}.</p>`}
        ${d.warnings.length ? `<details class="pb-warn"><summary>Reviewer notes</summary><ul>${d.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}
      </div>${prior}${msg ? `<p class="${msg.ok ? "pb-ok" : "pb-err"}" role="${msg.ok ? "status" : "alert"}">${esc(msg.text)}</p>` : ""}`;
    const foot = d.signedIn && waiting
        ? `<span class="pb-who">Signed in as <b>${esc(d.login || "you")}</b></span><button type="button" class="lr-btn primary" data-close>Close</button>`
        : d.signedIn
        ? `<span class="pb-who">Signed in as <b>${esc(d.login || "you")}</b></span><button type="button" class="lr-btn" data-close>Cancel</button>
           <button type="button" class="lr-btn primary" data-submit ${blocking ? "disabled" : ""}>Submit for review</button>`
        : `<span class="pb-who">Publishing needs a Grid account.</span><button type="button" class="lr-btn" data-close>Cancel</button>
           <button type="button" class="lr-btn primary" data-signin>Sign in with GitHub</button>`;
    frame(`Publish ${esc(d.name)}`, body, foot);
    wireClose();
    sheet.querySelector("[data-signin]")?.addEventListener("click", async () => {
        const btn = sheet.querySelector("[data-signin]");
        btn.disabled = true; btn.textContent = "Waiting for your browser…";
        const r = await window.volt.authLogin().catch((e) => ({ error: e.message }));
        if (r && r.ok) return open(d.prefix);
        btn.disabled = false; btn.textContent = "Sign in with GitHub";
        let note = sheet.querySelector(".pb-signin-err");
        if (!note) { note = document.createElement("p"); note.className = "lr-alert pb-signin-err"; btn.closest("footer, .lr-foot, div").prepend(note); }
        note.textContent = (r && r.error) || "Sign-in wasn't completed.";
    });
    sheet.querySelector("[data-submit]")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const version = sheet.querySelector("[data-version]").value.trim();
        const description = sheet.querySelector("[data-desc]").value.trim();
        if (!await dialog.confirm(`Submit ${d.name} ${version} for review?`, { detail: "Its code is sent to the Grid. A Volt maintainer reviews it, and once approved anyone can install it.", okLabel: "Submit" })) return;
        btn.disabled = true; btn.textContent = "Submitting…";
        try {
            await P.submit(d.prefix, { version, description });
            bottomPanel.appendOutput(`Submitted ${d.name} ${version} to the Grid — waiting for a maintainer's review`, "success");
            if (onDone) onDone();
            const fresh = await P.prepare(d.prefix, { version, description }).catch(() => d);
            render({ ...fresh, version, description }, { ok: true, text: `✓ Submitted ${version}. A Volt maintainer will review and sign it; until then only you can see it.` });
        } catch (err) {
            render({ ...d, version, description }, { ok: false, text: cleanErr(err) });
        }
    });
    sheet.querySelector("[data-submit], [data-signin], [data-close]")?.focus();
}

// watchStatuses tells you when a maintainer publishes your library or asks
// for changes (checked at start and every 10 minutes while signed in).
const SEEN = "volt.publish.seen";
async function checkStatuses() {
    const list = await P.mine().catch(() => []);
    if (!list.length) return;
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem(SEEN) || "{}"); } catch (_) {}
    const first = !Object.keys(seen).length;
    for (const x of list) {
        const k = `${x.prefix}@${x.version}`;
        if (!first && seen[k] && seen[k] !== x.status) {
            if (x.status === "published") bottomPanel.appendOutput(`✓ ${x.name || x.prefix} ${x.version} is published on the Grid — anyone can install it now`, "success");
            if (x.status === "rejected") bottomPanel.appendOutput(`${x.name || x.prefix} ${x.version}: the reviewer asked for changes — ${x.findings || "see Library → Mine"}`, "warn",
                { onClick: () => open(x.prefix) });
        }
        seen[k] = x.status;
    }
    try { localStorage.setItem(SEEN, JSON.stringify(seen)); } catch (_) {}
}
setTimeout(checkStatuses, 8000);
setInterval(checkStatuses, 10 * 60_000);
