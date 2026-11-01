// GitHub panel — sign in with GitHub, publish the project as a new repo, then
// commit and push, or pull (src/main/github.js does the work). Every git step
// shows its result here; nothing happens without a click.

import { ICONS } from "./icons.js";

const api = () => window.volt.github;
export const GITHUB_MARK = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const STATUS = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", "??": "New", "?": "New", U: "Conflict" };

let root = null, getProject = () => null, signing = null, busy = false, hooked = false;

export function init(ctx) {
    getProject = ctx.getProject;
    if (hooked) return;
    hooked = true;
    api().onEvent((e) => {
        if (e.t === "signed-in") { signing = null; draw(); }
        if (e.t === "error") { signing = null; draw(e.text); }
    });
    // Saving or coming back to the window may change what git sees — but
    // never redraw over a form the user is filling in.
    const refresh = () => { if (root && root.offsetParent && !busy && !editing()) draw(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("volt:file-saved", refresh);
}

/** renderInto(body) — draw the panel for the open project. */
export function renderInto(body) {
    root = body;
    draw();
}

async function draw(error = "") {
    if (!root) return;
    const project = getProject();
    const st = await api().status().catch(() => ({}));
    if (!st.configured) {
        root.innerHTML = `<div class="gh"><div class="gh-hero">${GITHUB_MARK}<h4>GitHub isn't set up in this build</h4>
            <p>Volt needs its GitHub app ID (setting <code>github.clientId</code>) to sign in.</p></div></div>`;
        return;
    }
    if (!st.signedIn) return drawSignIn(error);
    if (!project) { root.innerHTML = `<div class="gh"><p class="gh-dim">Open a project to publish or commit it.</p>${footer(st)}</div>`; return; }
    const r = await api().repo(project).catch(e => ({ error: e.message }));
    if (getProject() !== project) return;
    if (!r.remote) return drawPublish(project, r, st, error);
    drawRepo(project, r, st, error);
}

function footer(st) {
    return `<div class="gh-foot">${st.avatar ? `<img src="${esc(st.avatar)}&s=40" alt="">` : ""}<span>@${esc(st.login)}</span>
        <button type="button" class="gh-link gh-signout">Sign out</button></div>`;
}
function errorBox(text) { return text ? `<div class="gh-err" role="alert">${esc(text)}</div>` : ""; }

// ---- signed out ----

function drawSignIn(error) {
    root.innerHTML = signing
        ? `<div class="gh"><div class="gh-hero">${GITHUB_MARK}<h4>Your sign-in code</h4>
             <p>You'll type this on GitHub to connect Volt to your account.</p>
             <div class="gh-code"><b>${esc(signing.userCode)}</b></div>
             <ol class="gh-steps">
               <li>Copy the code and open GitHub with the button below.</li>
               <li>Paste the code there, then click <b>Authorize</b>.</li>
               <li>Come back here: Volt finishes on its own.</li>
             </ol>
             <button type="button" class="gh-btn gh-primary gh-go">${signing.opened ? "Copy and open GitHub again" : "Copy code and open GitHub"}</button>
             ${signing.opened ? `<p class="gh-wait"><span class="gh-spin" aria-hidden="true"></span>Waiting for you to approve Volt on GitHub…</p>` : ""}
             <button type="button" class="gh-link gh-cancel">Cancel</button>
           </div>${errorBox(error)}</div>`
        : `<div class="gh"><div class="gh-hero">${GITHUB_MARK}<h4>Never lose a project again</h4>
             <p>Put your firmware on GitHub and it's backed up, versioned and ready to share.</p></div>
             <ul class="gh-values">
               <li><b>Backed up online</b><span>If your laptop dies, your project doesn't.</span></li>
               <li><b>Every version kept</b><span>Go back to the code that worked yesterday.</span></li>
               <li><b>Share with one link</b><span>Show it to a friend, a client or the community.</span></li>
             </ul>
             <button type="button" class="gh-btn gh-primary gh-signin">Sign in with GitHub</button>
             <p class="gh-dim gh-center">Free account. Your sign-in stays in your computer's keychain.</p>${errorBox(error)}</div>`;
    on(".gh-signin", async (b) => {
        b.disabled = true;
        try { signing = await api().signIn(); drawSignIn(); } catch (e) { b.disabled = false; drawSignIn(e.message); }
    });
    on(".gh-go", async () => {
        try { await navigator.clipboard.writeText(signing.userCode); } catch (_) {}
        window.volt.openExternal(signing.uri);
        signing.opened = true;
        drawSignIn();
    });
    on(".gh-cancel", () => { api().cancelSignIn(); signing = null; drawSignIn(); });
}

// ---- not on GitHub yet ----

function drawPublish(project, r, st, error) {
    const suggested = project.split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]+/g, "-");
    const files = r.files || [];
    root.innerHTML = `<div class="gh">
        <div class="gh-account">${st.avatar ? `<img src="${esc(st.avatar)}&s=48" alt="">` : GITHUB_MARK}
          <div><b>Publish to GitHub</b><span>on @${esc(st.login)}'s account</span></div></div>
        <form class="gh-form" novalidate>
          <label class="gh-field">
            <span class="gh-lbl">Repository name</span>
            <input name="name" value="${esc(suggested)}" spellcheck="false" autocomplete="off">
            <small class="gh-url"></small>
          </label>
          <div class="gh-field">
            <label class="gh-lbl" for="ghDesc">Description <em>optional</em>
              <button type="button" class="gh-ai" hidden>${ICONS.sparkle}<span>Write it</span></button></label>
            <textarea id="ghDesc" name="description" rows="3" placeholder="e.g. Gas leak alarm with SMS alerts"></textarea>
          </div>
          <div class="gh-field">
            <span class="gh-lbl">Who can see it</span>
            <div class="gh-seg" role="radiogroup" aria-label="Who can see it">
              <label><input type="radio" name="vis" value="private" checked><span>${ICONS.lock} Private</span></label>
              <label><input type="radio" name="vis" value="public"><span>${ICONS.globe} Public</span></label>
            </div>
            <small class="gh-vis-note"></small>
          </div>
          ${files.length ? `<details class="gh-incl">
            <summary><span>What goes up</span><em>${files.length} file${files.length === 1 ? "" : "s"}</em></summary>
            <ul>${files.slice(0, 12).map(f => `<li>${esc(f)}</li>`).join("")}${files.length > 12 ? `<li class="gh-more">+${files.length - 12} more</li>` : ""}</ul>
            <p>Left out: build output and Volt's own files (.volt).</p>
          </details>` : ""}
          ${errorBox(error)}
          <button type="submit" class="gh-btn gh-primary gh-publish">Publish privately</button>
        </form>${footer(st)}</div>`;
    const form = root.querySelector(".gh-form"), btn = form.querySelector(".gh-publish");
    const url = form.querySelector(".gh-url"), note = form.querySelector(".gh-vis-note");
    const update = () => {
        const name = form.name.value.trim();
        const ok = /^[A-Za-z0-9._-]+$/.test(name);
        url.textContent = !name ? "Give it a name." : ok ? `github.com/${st.login}/${name}` : "Letters, numbers, . - and _ only (no spaces).";
        url.classList.toggle("is-err", !ok);
        const pub = form.querySelector("input[name=vis]:checked").value === "public";
        note.textContent = pub ? "Anyone on the internet can see and copy it." : "Only you, and people you invite on GitHub.";
        btn.textContent = pub ? "Publish publicly" : "Publish privately";
        btn.disabled = !ok || busy;
    };
    // Description: start from the program's parts; the agent can write a better one.
    const desc = form.description, aiBtn = form.querySelector(".gh-ai");
    let touched = false;
    desc.addEventListener("input", () => { touched = true; });
    readProgram(project).then(src => { if (!touched && !desc.value) desc.value = partsSentence(src); });
    window.volt.assistant.status().then(a => {
        if (!a || !a.found || !a.loggedIn) return;
        aiBtn.hidden = false;
        aiBtn.querySelector("span").textContent = `Write with ${a.provider === "codex" ? "Codex" : "Claude"}`;
    }).catch(() => {});
    aiBtn.onclick = async () => {
        const label = aiBtn.querySelector("span"), was = label.textContent;
        aiBtn.disabled = true; label.textContent = "Writing…";
        try {
            const text = await window.volt.assistant.describe(await readProgram(project));
            if (text) { desc.value = text; touched = true; }
        } catch (e) { label.textContent = "Couldn't write it"; setTimeout(() => { label.textContent = was; }, 2000); aiBtn.disabled = false; return; }
        aiBtn.disabled = false; label.textContent = was;
    };
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    update();
    form.onsubmit = async (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        const f = new FormData(form);
        btn.disabled = true; btn.textContent = "Publishing…"; busy = true;
        try {
            await api().publish(project, { name: f.get("name").trim(), description: f.get("description"), private: f.get("vis") === "private" });
            busy = false; draw();
        } catch (err) { busy = false; draw(err.message); }
    };
    wireFooter();
}

// ---- on GitHub ----

function drawRepo(project, r, st, error) {
    const changes = r.changes || [];
    const sync = [r.ahead ? `↑ ${r.ahead} to push` : "", r.behind ? `↓ ${r.behind} to pull` : ""].filter(Boolean).join(" · ");
    root.innerHTML = `<div class="gh">
        <div class="gh-repo">
          <button type="button" class="gh-repolink" title="Open on GitHub">${GITHUB_MARK}<span>${esc(r.remote.owner)}/<b>${esc(r.remote.name)}</b></span></button>
          <span class="gh-branch" title="Branch">${esc(r.branch)}</span>
          <button type="button" class="gh-icon gh-refresh" title="Refresh" aria-label="Refresh">↻</button>
        </div>
        ${sync ? `<div class="gh-sync">${esc(sync)}</div>` : ""}
        <div class="gh-section">Changes <span>${changes.length}</span></div>
        ${changes.length ? `<ul class="gh-files">${changes.map(c => `<li><span class="gh-st gh-st-${c.status.startsWith("?") ? "N" : esc(c.status[0])}" title="${esc(STATUS[c.status] || c.status)}">${esc(c.status === "??" ? "N" : c.status)}</span><span class="gh-path" title="${esc(c.path)}">${esc(c.path)}</span></li>`).join("")}</ul>`
            : `<p class="gh-dim">No changes since the last commit.</p>`}
        <form class="gh-commit">
          ${changes.length ? `<div class="gh-lbl"><span>Message</span><button type="button" class="gh-ai" hidden>${ICONS.sparkle}<span>Write it</span></button></div>` : ""}
          <textarea name="message" rows="3" placeholder="What changed? e.g. Read the gas sensor every 2 s"${changes.length ? "" : " disabled"}></textarea>
          ${errorBox(error)}
          <div class="gh-row">
            <button type="submit" class="gh-btn gh-primary" disabled>${changes.length ? "Commit & push" : "Push"}</button>
            <button type="button" class="gh-btn gh-pull">Pull</button>
          </div>
          <p class="gh-dim gh-note">Saves a version of every changed file, then sends it to GitHub.</p>
        </form>${footer(st)}</div>`;
    const form = root.querySelector(".gh-commit"), msg = form.message, go = form.querySelector("button[type=submit]");
    const ready = () => { go.disabled = busy || (changes.length ? !msg.value.trim() : !r.ahead); };
    msg.addEventListener("input", ready);
    // ✨ The agent reads the changes since the last commit and writes the message.
    const aiBtn = form.querySelector(".gh-ai");
    if (aiBtn) window.volt.assistant.status().then(a => {
        if (!a || !a.found || !a.loggedIn) return;
        aiBtn.hidden = false;
        aiBtn.querySelector("span").textContent = `Write with ${a.provider === "codex" ? "Codex" : "Claude"}`;
    }).catch(() => {});
    if (aiBtn) aiBtn.onclick = async () => {
        const label = aiBtn.querySelector("span"), was = label.textContent;
        aiBtn.disabled = true; label.textContent = "Reading your changes…";
        try {
            const text = await window.volt.assistant.commitMessage(project);
            if (text) { msg.value = text; ready(); msg.focus(); }
            label.textContent = was;
        } catch (e) { label.textContent = "Couldn't write it"; setTimeout(() => { label.textContent = was; }, 2000); }
        aiBtn.disabled = false;
    };
    msg.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); } });
    ready();
    const run = async (label, btn, fn) => {
        btn.disabled = true; btn.textContent = label; busy = true;
        try { await fn(); busy = false; draw(); } catch (err) { busy = false; draw(err.message); }
    };
    form.onsubmit = (e) => { e.preventDefault(); if (!go.disabled) run(changes.length ? "Committing…" : "Pushing…", go, () => api().commit(project, msg.value || "Update", true)); };
    on(".gh-pull", (b) => run("Pulling…", b, () => api().pull(project)));
    on(".gh-repolink", () => window.volt.openExternal(r.remote.url));
    on(".gh-refresh", () => draw());
    wireFooter();
}

async function readProgram(project) {
    try { return await window.volt.readFile(project.replace(/[\\/]$/, "") + "/main.volt"); } catch { return ""; }
}

// "ESP32 project using DHT22, LCD16x2, MQ and SIM800L." from the hardware block.
function partsSentence(src) {
    const types = [...new Set([...String(src).matchAll(/^\s*device\s+\w+\s*:\s*([A-Za-z0-9_]+)/gm)].map(m => m[1]))];
    if (!types.length) return "";
    const list = types.length > 1 ? types.slice(0, -1).join(", ") + " and " + types[types.length - 1] : types[0];
    return `ESP32 project using ${list}, written in Volt.`;
}

// The user is in the middle of something here: the publish form, a
// commit message, or a sign-in code on screen.
function editing() {
    return !!(root && (root.querySelector(".gh-form") || signing ||
        [...root.querySelectorAll(".gh-commit textarea")].some(t => t.value.trim())));
}

function wireFooter() {
    on(".gh-signout", async () => { await api().signOut(); draw(); });
}
function on(sel, fn) { const el = root.querySelector(sel); if (el) el.onclick = () => fn(el); }
