// library-view.js — the Library, as a large dialog (the Library button and ⌘3
// open it): find libraries, read everything about one, and act on it — add it
// to the program, install or update it from the Grid, or publish your own.

import * as lib from "./library.js";
import { deviceOverview } from "./device-card.js";
import * as bottomPanel from "./bottom-panel.js";
import * as dialog from "./dialog.js";
import * as editorMod from "./editor.js";

const api = window.volt;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let root = null;
let data = null;
let tab = (() => { try { return localStorage.getItem("volt.library.tab") || "installed"; } catch (_) { return "installed"; } })(); // installed | discover | mine
let query = "";
let selected = null;     // { tab, prefix }
let page = "overview";   // overview | code | publishing
let codeEditor = null;

const TABS = [["installed", "Installed"], ["discover", "Discover"], ["mine", "Mine"]];
const STATUS = { pending: "In review", published: "Published", rejected: "Changes requested", yanked: "Withdrawn" };

function items(t) {
    if (!data) return [];
    if (t === "installed") return data.machine;
    if (t === "discover") return data.browsable;
    return data.mine;
}
const keyOf = (it) => it.prefix;
function find(t, prefix) { return items(t).find(it => keyOf(it) === prefix); }
function matches(it) {
    const q = query.trim().toLowerCase();
    return !q || `${it.name || ""} ${it.prefix} ${it.description || ""} ${it.interface || ""} ${it.category || ""}`.toLowerCase().includes(q);
}

function chip(text, cls = "") { return `<span class="lv-chip ${cls}">${esc(text)}</span>`; }

function tagsFor(t, it) {
    const out = [];
    if (t === "installed") {
        if (it.inProject) out.push(chip("In project", "ok"));
        const o = it.origin;
        if (it.inst) out.push(chip(it.inst.tier === "private" ? "Private" : it.inst.tier === "official" ? `Official · v${it.inst.version}` : `From the Grid · v${it.inst.version}`));
        else if (o && o.kind === "official") out.push(o.edited ? `<span class="lv-chip" title="You changed this library on this computer.">Official · edited</span>` : chip("Official"));
        else if (o && o.kind === "grid") out.push(chip("From the Grid"));
        else out.push(`<span class="lv-chip" title="Made on this computer. Volt never replaces or removes it.">Local</span>`);
        if (it.update) out.push(chip(`Update v${it.update}`, "warn"));
    }
    const yanked = (data.machineByPrefix[it.prefix] || it).yanked;
    if (yanked) out.push(`<span class="lv-chip bad" title="${esc(yanked)}">Withdrawn by Volt: ${esc(yanked.length > 60 ? yanked.slice(0, 57) + "…" : yanked)}</span>`);
    const mine = data.mine.find(m => m.prefix === it.prefix);
    if (mine) {
        out.push(chip("Yours", "you"));
        if (mine.aiAssisted) out.push(chip("✦ AI-assisted", "ai"));
        const b = mine.latest;
        if (mine.state !== "approved") out.push(chip("Needs your approval", "warn"));
        else if (b && STATUS[b.status]) out.push(chip(`${STATUS[b.status]} · v${b.version}`, b.status === "published" ? "ok" : b.status === "rejected" ? "bad" : "warn"));
        else if (mine.published) out.push(chip(`Published · v${mine.published}`, "ok"));
        else out.push(chip("Not published"));
    }
    if (t === "discover") {
        if (it.yours) out.push(chip("Yours", "you"));
        if (it.trustTier) out.push(chip(it.trustTier === "verified" ? "Verified" : it.trustTier === "official" ? "Official" : it.trustTier));
        if ((it.capabilities || []).includes("network")) out.push(chip("Uses network", "warn"));
    }
    return out.join("");
}

// ── list ───────────────────────────────────────────────────────────────────

function renderList() {
    const list = root.querySelector(".lv-list");
    const its = items(tab).filter(matches).slice().sort((a, b) => (a.name || a.prefix).localeCompare(b.name || b.prefix));
    list.innerHTML = its.length ? its.map(it => `
        <button type="button" class="lv-row${selected && selected.tab === tab && selected.prefix === it.prefix ? " on" : ""}" data-p="${esc(it.prefix)}">
          <span class="lib-ic lib-ic-${esc((it.interface || "?").toLowerCase())}">${esc((it.interface || "•").toUpperCase())}</span>
          <span class="lv-row-body"><b>${esc(it.name || it.prefix)}</b><span>${esc(it.description || it.interface || "")}</span></span>
        </button>`).join("")
        : `<p class="lv-empty">${query ? `Nothing matches “${esc(query)}”.` : tab === "mine" ? "You haven't made a library yet." : tab === "discover" ? (data.gridOffline ? "The Grid can't be reached right now." : "Nothing new on the Grid.") : "No libraries installed."}</p>`;
    list.querySelectorAll("[data-p]").forEach(b => b.onclick = () => select(tab, b.dataset.p));
    root.querySelectorAll(".lv-tab").forEach(b => {
        b.classList.toggle("on", b.dataset.t === tab);
        b.querySelector("em").textContent = items(b.dataset.t).length;
    });
}

// ── detail page ──────────────────────────────────────────────────────────

let exEditors = null; // the Examples page's read-only viewers
function disposeCode() {
    if (codeEditor) { codeEditor.getModel()?.dispose(); codeEditor.dispose(); codeEditor = null; }
    (exEditors || []).forEach(e => { e.getModel()?.dispose(); e.dispose(); }); exEditors = null;
}

async function deviceFor(t, it) {
    if (t === "discover") {
        if (!it.fromGrid) return { device: { name: it.name, description: it.description, interface: it.interface }, driver: "" };
        const res = await api.gridFetch(it.prefix, it.version).catch(() => null);
        return { device: (res && res.device) || {}, driver: (res && res.driver) || "", res };
    }
    const m = data.machineByPrefix[it.prefix];
    const device = (m && m.d) || {};
    const files = await api.libraryFiles(it.prefix).catch(() => []);
    return { device, files, driver: (files.find(f => f.name === "driver.c") || {}).text || "" };
}

// openFileName is the program "Add to …" writes into (e.g. main.volt).
function openFileName() {
    const ed = document.getElementById("editorArea");
    if (!ed || ed.style.display === "none" && !editorMod.getCurrentFile()) return "";
    return (editorMod.getCurrentFile() || "").split(/[\\/]/).pop();
}

function actionsFor(t, it, extra) {
    const mine = data.mine.find(m => m.prefix === it.prefix);
    const m = data.machineByPrefix[it.prefix];
    const btns = [];
    if (t === "discover") {
        btns.push(`<button type="button" class="lr-btn primary" data-act="get">${it.state === "update" ? "Update" : "Install"}</button>`);
    } else if (m) {
        const file = openFileName();
        btns.push(m.inProject ? `<span class="lv-done">✓ Used in ${esc(file || "your program")}</span>`
            : file ? `<button type="button" class="lr-btn primary" data-act="add" title="Adds the device, its bus and example code to ${esc(file)}">Add library to code</button>`
            : `<button type="button" class="lr-btn primary" disabled title="Open a project to add this library to its code">Add library to code</button>`);
        if (m.update) btns.push(`<button type="button" class="lr-btn" data-act="update">Update to v${esc(m.update)}</button>`);
    }
    if (mine) {
        if (mine.state !== "approved") btns.push(`<button type="button" class="lr-btn" data-act="review">Review &amp; approve</button>`);
        else if (mine.latest && mine.latest.status === "pending") btns.push(`<button type="button" class="lr-btn" data-act="publish" title="Waiting for a Volt maintainer's review — open to see its status">In review · v${esc(mine.latest.version)}</button>`);
        else btns.push(`<button type="button" class="lr-btn" data-act="publish">${mine.latest && mine.latest.status === "rejected" ? "Resubmit to Grid" : mine.published ? "Publish update to Grid" : "Publish to Grid"}</button>`);
    }
    // Any published version can be installed — newer or older than what's here.
    const vers = (data.gridVersions || {})[it.prefix] || [];
    const have = m && m.localVersion;
    if (vers.length > 1 || (vers.length && have && !vers.includes(have))) {
        btns.push(`<span class="lv-ver"><select data-ver aria-label="Version">${vers.map((v, i) =>
            `<option value="${esc(v)}"${v === (have || vers[0]) ? " selected" : ""}>v${esc(v)}${v === have ? " (installed)" : i === 0 ? " (latest)" : ""}</option>`).join("")}</select>` +
            `<button type="button" class="lr-btn" data-act="pick" hidden>Install</button></span>`);
    }
    if (m && m.inst) btns.push(`<button type="button" class="lr-btn lv-quiet" data-act="uninstall">Uninstall</button>`);
    return btns.join("");
}

async function renderDetail() {
    const main = root.querySelector(".lv-main");
    disposeCode();
    if (!selected) return renderWelcome(main);
    const it = find(selected.tab, selected.prefix);
    if (!it) { selected = null; return renderWelcome(main); }
    main.innerHTML = `<p class="lv-muted lv-pad">Loading ${esc(it.name || it.prefix)}…</p>`;
    const info = await deviceFor(selected.tab, it);
    const d = info.device || {};
    const mine = data.mine.find(m => m.prefix === it.prefix);
    const examples = await api.libraryExamples(it.prefix, d.name || it.name).catch(() => []);
    const pages = [["overview", "Overview"], ...(examples.length ? [["examples", `Examples${examples.length > 1 ? " (" + examples.length + ")" : ""}`]] : []),
        ["code", "Driver"], ...(mine ? [["publishing", "Publishing"]] : [])];
    if (!pages.some(p => p[0] === page)) page = "overview";
    main.innerHTML = `
      <button type="button" class="lv-back" data-home>‹ Search libraries</button>
      <header class="lv-head">
        <span class="lib-ic lv-ic lib-ic-${esc((d.interface || it.interface || "?").toLowerCase())}">${esc((d.interface || it.interface || "•").toUpperCase())}</span>
        <div class="lv-title"><h2>${esc(d.name || it.name || it.prefix)}</h2>
          <p>${esc([d.manufacturer, it.version ? "v" + it.version : (it.inst && it.inst.version ? "v" + it.inst.version : ""), it.author ? "by " + it.author : ""].filter(Boolean).join(" · "))}</p>
          <div class="lv-tags">${tagsFor(selected.tab, it)}</div></div>
        <div class="lv-acts">${actionsFor(selected.tab, it)}</div>
      </header>
      <nav class="lv-pages">${pages.map(([k, l]) => `<button type="button" class="lv-page${k === page ? " on" : ""}" data-page="${k}">${l}</button>`).join("")}</nav>
      <div class="lv-body"></div>`;
    main.querySelectorAll("[data-page]").forEach(b => b.onclick = () => { page = b.dataset.page; renderDetail(); });
    main.querySelector("[data-home]").onclick = () => { selected = null; renderList(); renderDetail(); };
    main.querySelectorAll("[data-act]").forEach(b => b.onclick = () => act(b.dataset.act, it, info, b));
    const ver = main.querySelector("[data-ver]");
    if (ver) ver.onchange = () => {
        const pick = main.querySelector('[data-act="pick"]');
        const have = data.machineByPrefix[it.prefix]?.localVersion;
        pick.hidden = ver.value === have;
        pick.textContent = !have ? `Install v${ver.value}` : lib.verCmp(ver.value, have) > 0 ? `Update to v${ver.value}` : `Switch to v${ver.value}`;
    };
    const body = main.querySelector(".lv-body");
    if (page === "overview") {
        body.innerHTML = Object.keys(d).length ? deviceOverview(d, it.name, examples[0] || null) : `<p class="lv-muted lv-pad">No details for this library.</p>`;
        body.querySelector('[data-ex="goto"]')?.addEventListener("click", () => { page = "examples"; renderDetail(); });
        body.querySelector(".lr-ds")?.addEventListener("click", (e) => { e.preventDefault(); api.openExternal(e.currentTarget.dataset.url); });
    } else if (page === "examples") {
        body.innerHTML = `<div class="lv-pad lv-examples">${examples.map((ex, k) => `
            <section class="lv-ex">
              <div class="lv-ex-head"><div><h3>${esc(ex.title === "Example" && examples.length === 1 ? `${d.name || it.name} example` : ex.title)}</h3>
                ${ex.description ? `<p class="lv-muted">${esc(ex.description)}</p>` : ""}<span class="lr-ok-tag">✓ passes check and builds</span></div>
                <div class="lv-ex-acts"><button type="button" class="lr-btn" data-copy="${k}">Copy</button></div></div>
              <div class="lv-ex-code" data-k="${k}"></div>
            </section>`).join("")}</div>`;
        disposeCode();
        examples.forEach((ex, k) => {
            const host = body.querySelector(`.lv-ex-code[data-k="${k}"]`);
            const lines = ex.code.trim().split("\n").length;
            host.style.height = Math.min(640, lines * 19 + 16) + "px";
            const e = monaco.editor.create(host, { value: ex.code.trim(), language: "volt", readOnly: true, automaticLayout: true,
                minimap: { enabled: false }, fontSize: 13, lineNumbers: "on", scrollBeyondLastLine: false, theme: "volt-dark",
                renderLineHighlight: "none", scrollbar: { alwaysConsumeMouseWheel: false } });
            (exEditors ||= []).push(e);
        });
        body.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => {
            await navigator.clipboard.writeText(examples[+b.dataset.copy].code); b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1400);
        });
    } else if (page === "code") {
        const files = info.files && info.files.length ? info.files : [{ name: "driver.c", text: info.driver || "" }];
        body.innerHTML = `<div class="lv-files">${files.map((f, i) => `<button type="button" class="lv-file${i ? "" : " on"}" data-f="${i}">${esc(f.name)}</button>`).join("")}</div><div class="lv-code"></div>`;
        const showFile = (i) => {
            disposeCode();
            body.querySelectorAll(".lv-file").forEach((b, k) => b.classList.toggle("on", k === i));
            const f = files[i];
            codeEditor = monaco.editor.create(body.querySelector(".lv-code"), {
                value: f.text || "// No source available for this library.", language: /\.json$/.test(f.name) ? "json" : "c", readOnly: true,
                automaticLayout: true, minimap: { enabled: false }, fontSize: 12.5, scrollBeyondLastLine: false, theme: "volt-dark",
            });
        };
        body.querySelectorAll(".lv-file").forEach(b => b.onclick = () => showFile(+b.dataset.f));
        showFile(0);
    } else {
        const subs = ((await api.publish.mine().catch(() => [])) || []).filter(x => x.prefix === it.prefix);
        body.innerHTML = `<div class="lv-pad"><p class="lv-muted">Public libraries are reviewed and signed by a Volt maintainer before anyone can install them.</p>
          ${subs.length ? `<ul class="pb-list">${subs.map(x => `<li><code>v${esc(x.version)}</code><span class="pb-st st-${esc(x.status)}">${esc(STATUS[x.status] || x.status)}</span>${x.findings ? `<span class="pb-find">${esc(x.findings)}</span>` : ""}</li>`).join("")}</ul>`
            : `<p>Not published yet.</p>`}
          <p><button type="button" class="lr-btn primary" data-act2="publish">${mine && mine.published ? "Publish an update" : "Publish to the Grid"}</button></p></div>`;
        body.querySelector("[data-act2]").onclick = () => act("publish", it, info);
    }
}

const CATS = [["Temperature", "temperature"], ["Displays", "display"], ["Motion", "motion"], ["Light", "light"], ["Gas & air", "gas"], ["Comms", "uart"]];

// searchAll looks through every tab at once; each library is listed once.
function searchAll(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const seen = new Set(), out = [];
    for (const [t, label] of [["mine", "Yours"], ["installed", "Installed"], ["discover", "On the Grid"]]) {
        for (const it of items(t)) {
            if (seen.has(it.prefix)) continue;
            const hay = `${it.name || ""} ${it.prefix} ${it.description || ""} ${it.interface || ""} ${it.category || ""} ${(it.d && it.d.manufacturer) || ""}`.toLowerCase();
            if (q.split(/\s+/).every(w => hay.includes(w))) { seen.add(it.prefix); out.push({ t, label, it }); }
        }
    }
    return out.slice(0, 40);
}

function renderWelcome(main) {
    main.innerHTML = `<div class="lv-home">
        <div class="lv-hero">
          <h2>Find a device library</h2>
          <p class="lv-muted">${items("installed").length} installed · ${data.gridOffline ? "Grid offline" : `${items("discover").length} new on the Grid`} · ${items("mine").length} yours</p>
          <div class="lv-big-search">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input type="text" role="searchbox" placeholder="Search sensors, displays, chips…" aria-label="Search all libraries" autocomplete="off" spellcheck="false">
            <kbd>Enter</kbd></div>
          <div class="lv-cats">${CATS.map(([l, q]) => `<button type="button" class="lv-cat" data-q="${q}">${l}</button>`).join("")}</div>
          <div class="lv-results" role="listbox" aria-label="Search results"></div>
        </div>
        <div class="lv-home-foot">
          <button type="button" class="lr-btn" data-w="import">Import a .vcell file</button>
          <button type="button" class="lr-btn primary" data-w="new">+ New library</button>
        </div>
      </div>`;
    const input = main.querySelector(".lv-big-search input");
    const results = main.querySelector(".lv-results");
    let hits = [], active = 0;
    const paint = () => {
        hits = searchAll(input.value);
        active = Math.min(active, Math.max(0, hits.length - 1));
        results.innerHTML = !input.value.trim() ? ""
            : hits.length ? hits.map((h, k) => `
                <button type="button" class="lv-hit${k === active ? " on" : ""}" role="option" aria-selected="${k === active}" data-k="${k}">
                  <span class="lib-ic lib-ic-${esc((h.it.interface || "?").toLowerCase())}">${esc((h.it.interface || "•").toUpperCase())}</span>
                  <span class="lv-row-body"><b>${esc(h.it.name || h.it.prefix)}</b><span>${esc(h.it.description || "")}</span></span>
                  <em class="lv-hit-tag t-${h.t}">${h.label}</em></button>`).join("")
            : `<p class="lv-muted lv-noresult">Nothing matches “${esc(input.value)}”. <button type="button" class="lv-link" data-w="new">Create a library for it →</button></p>`;
        results.querySelectorAll("[data-k]").forEach(b => b.onclick = () => { const h = hits[+b.dataset.k]; tab = h.t; select(h.t, h.it.prefix); });
        results.querySelector('[data-w="new"]')?.addEventListener("click", newLibrary);
    };
    input.addEventListener("input", () => { active = 0; paint(); });
    input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(hits.length - 1, active + 1); paint(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
        else if (e.key === "Enter" && hits[active]) { e.preventDefault(); const h = hits[active]; tab = h.t; select(h.t, h.it.prefix); }
    });
    main.querySelectorAll(".lv-cat").forEach(b => b.onclick = () => { input.value = b.dataset.q; active = 0; paint(); input.focus(); });
    main.querySelector('[data-w="new"]').onclick = newLibrary;
    main.querySelector('[data-w="import"]').onclick = () => import("./vlib-installer.js").then(m => m.show(() => reload()));
    if (query) { input.value = query; paint(); }
    setTimeout(() => input.focus(), 0);
}

function newLibrary() { import("./library-creator.js").then(m => m.show(() => reload())); }

async function act(what, it, info, btn) {
    const m = data.machineByPrefix[it.prefix];
    try {
        if (what === "add") { await lib.addDevice(m.d, { withSample: true }); bottomPanel.appendOutput(`Added ${it.name} to ${openFileName() || "your program"}`, "success"); }
        else if (what === "review") { (await import("./lib-review.js")).open(); return; }
        else if (what === "publish") { (await import("./publish-dialog.js")).open(it.prefix, reload); return; }
        else if (what === "uninstall") {
            if (!await dialog.confirm(`Uninstall ${it.name || it.prefix}?`, { detail: "Deletes the library's files and header from this computer. Programs that use it won't build until you install it again.", okLabel: "Uninstall", danger: true })) return;
            const r = await api.vlibUninstall(it.prefix);
            bottomPanel.appendOutput(`Uninstalled ${it.name}${r && r.removed ? "" : ""}`, "info");
            selected = null;
        } else if (what === "pick") {
            const v = btn.closest(".lv-ver").querySelector("[data-ver]").value;
            const res = await api.gridFetch(it.prefix, v);
            if (!res || !res.token) throw new Error((res && res.reason) || `v${v} isn't available on the Grid.`);
            (await import("./vlib-installer.js")).showResult(res, { onClose: reload });
            return;
        } else if (what === "get" || what === "update") {
            const src = what === "update" ? data.browseByPrefix[it.prefix] || it : it;
            if (src.fromGrid !== false) {
                const res = info && info.res && info.res.token ? info.res : await api.gridFetch(src.prefix, src.version || it.update);
                if (!res || !res.token) throw new Error((res && res.reason) || "This library isn't available on the Grid.");
                // The installer's consent card shows its capabilities and code, then installs.
                (await import("./vlib-installer.js")).showResult(res, { onClose: reload });
                return;
            }
            if (btn) { btn.disabled = true; btn.textContent = "Installing…"; }
            await api.collectionInstall(src.prefix, src.version);
            bottomPanel.appendOutput(`Installed ${it.name} from your collection`, "success");
        }
    } catch (e) {
        bottomPanel.appendOutput(`Library: ${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`, "error");
    }
    reload();
}

function select(t, prefix) {
    selected = { tab: t, prefix };
    page = "overview";
    renderList();
    renderDetail();
}

async function reload() {
    data = await lib.loadLibraryData();
    if (root) { renderList(); renderDetail(); }
}

let backdrop = null;

function close() {
    disposeCode();
    backdrop?.remove(); backdrop = null; root = null;
    document.body.classList.remove("lvd-open");
    document.removeEventListener("keydown", keys, true);
}

function keys(e) {
    if (e.key !== "Escape") return;
    // a dialog opened from here (publish, review, installer) closes first
    if (document.querySelector(".hs-backdrop, .lr-backdrop, .vlib2-dock, .overlay, .dialog-overlay")) return;
    e.preventDefault(); close();
}

async function show(open) {
    if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.className = "lvd-backdrop";
        backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
        root = document.createElement("div");
        root.className = "lv-root lvd-dialog";
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-modal", "true");
        root.setAttribute("aria-label", "Library");
        root.innerHTML = `
          <aside class="lv-side">
            <div class="lvd-top"><h2>Library</h2></div>
            <div class="lv-search"><input type="search" class="ai-input" placeholder="Search libraries…" aria-label="Search libraries"></div>
            <nav class="lv-tabs">${TABS.map(([k, l]) => `<button type="button" class="lv-tab" data-t="${k}">${l} <em>0</em></button>`).join("")}</nav>
            <div class="lv-list" role="list"></div>
          </aside>
          <section class="lv-main"></section>
          <button type="button" class="hs-x lvd-x" aria-label="Close Library">×</button>`;
        backdrop.appendChild(root);
        document.body.appendChild(backdrop);
        document.body.classList.add("lvd-open");
        document.addEventListener("keydown", keys, true);
        root.querySelector(".lvd-x").onclick = close;
        root.querySelector('input[type="search"]').addEventListener("input", (e) => { query = e.target.value; renderList(); });
        root.querySelectorAll(".lv-tab").forEach(b => b.onclick = () => {
            tab = b.dataset.t; renderList();
            try { localStorage.setItem("volt.library.tab", tab); } catch (_) {}
        });

    }
    if (open && open.tab) tab = open.tab;
    if (open && open.prefix) selected = { tab, prefix: open.prefix };
    data = await lib.loadLibraryData();
    renderList();
    renderDetail();
}

// openLibrary opens the Library dialog, optionally on a tab or one library.
export async function openLibrary(open) { await show(open); }
