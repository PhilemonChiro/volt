// Device library — sidebar list, context menu, detail dialog, insert logic.
//
// Click a device row to get a context menu with: Add to project / Add with
// sample read / View details / Open C source / Copy declaration / Copy snippet.
// The detail dialog is read-only; all actions live in the context menu.

import * as dialog from "./dialog.js";
import * as installer from "./vlib-installer.js";

const api = window.volt;

let cachedDevices = null;

// Display order — keeps the list scannable instead of alphabetical chaos.
const CATEGORY_ORDER = [
    "sensor", "light", "motion", "distance", "temperature",
    "power", "health", "display", "control", "analog",
    "storage", "communication", "time",
];
const CATEGORY_LABELS = {
    sensor: "Sensors", light: "Light", motion: "Motion", distance: "Distance",
    temperature: "Temperature", power: "Power", health: "Health",
    display: "Displays", control: "Control / Expanders", analog: "Analog (ADC / DAC)",
    storage: "Storage", communication: "Communication", time: "Real-time Clocks",
};

// Marketplace groups — consolidate the raw device categories into a handful of
// meaningful, ordered buckets so the Grid reads as an organized catalog rather
// than an alphabetical dump. "other" catches anything uncategorized.
const LIB_GROUPS = [
    { key: "env",     label: "Environment & Temperature", cats: ["sensor", "temperature"] },
    { key: "analog",  label: "Analog & Power",            cats: ["analog", "power"] },
    { key: "light",   label: "Light & Color",             cats: ["light"] },
    { key: "motion",  label: "Motion & Distance",         cats: ["motion", "distance"] },
    { key: "health",  label: "Health",                    cats: ["health"] },
    { key: "display", label: "Displays & LEDs",           cats: ["display"] },
    { key: "control", label: "Control & Timing",          cats: ["control", "time"] },
    { key: "comms",   label: "Comms, RFID & Storage",     cats: ["communication", "storage"] },
    { key: "other",   label: "Other",                     cats: [] },
];
const LIB_CAT_TO_GRP = {};
for (const g of LIB_GROUPS) for (const c of g.cats) LIB_CAT_TO_GRP[c] = g.key;
const LIB_EXPANDED_KEY = "volt.lib.expanded";   // which groups the user opened
const LIB_TAB_KEY = "volt.lib.tab";             // active tab: installed | grid

async function loadDevices() {
    if (cachedDevices) return cachedDevices;
    try {
        cachedDevices = (await api.devicesList()) || [];
    } catch (e) {
        console.warn("[library] devicesList failed:", e);
        cachedDevices = [];
    }
    return cachedDevices;
}

export async function renderInto(container) {
    if (!container) return;

    // Load in parallel: installed libraries (lockfile), the Grid marketplace, and
    // device descriptors (to map an installed prefix → its device.json for "Use").
    const [installed, gridRes, descriptors, collRes] = await Promise.all([
        api.vlibInstalledList().then(x => x || []).catch(() => []),
        api.gridList().then(cells => ({ ok: true, cells: cells || [] })).catch(err => ({ ok: false, err })),
        loadDevices().catch(() => []),
        (api.collectionList ? api.collectionList() : Promise.resolve({ ok: false })).then(x => x || { ok: false }).catch(() => ({ ok: false })),
    ]);
    const grid = gridRes.ok ? gridRes.cells : [];
    // Private collection — the user's own libraries (only present when signed in).
    const collection = collRes && collRes.ok ? (collRes.libraries || []) : [];
    const signedIn = !!(collRes && collRes.ok);
    const gridOffline = !gridRes.ok;
    const descByPrefix = {};
    for (const d of descriptors) descByPrefix[(d.c_prefix || "").toLowerCase()] = d;
    const installedByPrefix = {};
    for (const l of installed) installedByPrefix[l.prefix] = l;
    const gridByPrefix = {};
    for (const c of grid) gridByPrefix[c.prefix] = c;

    container.classList.add("lib-panel");   // flex column: fixed header, scrolling list
    container.innerHTML = `
        <div class="lib-search-wrap">
            <div class="lib-search-box">
                <input type="text" class="lib-search" id="libSearch" placeholder="Search libraries…" autocomplete="off" spellcheck="false">
                <button class="lib-search-clear" id="libSearchClear" tabindex="-1" aria-label="Clear search">&times;</button>
            </div>
            <button class="lib-new" id="libImport" title="Import a signed .vcell file">Import</button>
        </div>
        <div class="lib-tabs" id="libTabs">
            <button class="lib-tab" data-tab="installed">Installed <span class="lib-tab-n">${installed.length}</span></button>
            <button class="lib-tab" data-tab="grid">Grid <span class="lib-tab-n">${grid.length}</span></button>
            <button class="lib-tab" data-tab="mine">Mine <span class="lib-tab-n">${collection.length}</span></button>
        </div>
        <div class="lib-scroll" id="libScroll"></div>
    `;
    const scroll = container.querySelector("#libScroll");
    const input = container.querySelector("#libSearch");
    const searchBox = container.querySelector(".lib-search-box");
    const clearBtn = container.querySelector("#libSearchClear");
    const refresh = () => renderInto(container);
    container.querySelector("#libImport").onclick = () => installer.show(refresh);

    const icon = (iface) => {
        const i = (iface || "?").toLowerCase();
        return `<span class="lib-ic lib-ic-${esc(i)}">${esc(i === "?" ? "•" : i.toUpperCase())}</span>`;
    };
    // distinct interfaces in a group → colored dots, summarizing a collapsed group
    const ifaceDots = (items) => {
        const seen = [];
        for (const c of items) { const i = (c.interface || "").toLowerCase(); if (i && !seen.includes(i)) seen.push(i); }
        return seen.map(i => `<span class="lib-dot lib-dot-${esc(i)}" title="${esc(i)}"></span>`).join("");
    };
    const stateOf = (cell) => {
        const inst = installedByPrefix[cell.prefix];
        if (!inst) return "install";
        return inst.version === cell.version ? "installed" : "update";
    };

    // persisted UI state: which category groups are expanded (default = ALL
    // collapsed), and the active tab (default = Grid when nothing is installed).
    let expanded = new Set();
    try { expanded = new Set(JSON.parse(localStorage.getItem(LIB_EXPANDED_KEY) || "[]")); } catch (_) {}
    const saveExpanded = () => { try { localStorage.setItem(LIB_EXPANDED_KEY, JSON.stringify([...expanded])); } catch (_) {} };
    let tab = localStorage.getItem(LIB_TAB_KEY) || (installed.length ? "installed" : "grid");
    if (tab === "installed" && !installed.length && grid.length) tab = "grid";
    const saveTab = () => { try { localStorage.setItem(LIB_TAB_KEY, tab); } catch (_) {} };

    // ---- row markup ----
    // Rows are the entry to the detail sheet: the whole row is clickable. The
    // right-side control is a state cue (Install / Installed / Update / ›), the
    // real actions live in the sheet.
    const gridRow = (c) => {
        const st = stateOf(c);
        const tag = c.trustTier && c.trustTier !== "verified" ? `<span class="lib-tag lib-tag-community">${esc(c.trustTier)}</span>` : "";
        const net = (c.capabilities || []).includes("network") ? `<span class="lib-cap-net">network</span> · ` : "";
        const action = st === "installed"
            ? `<span class="lib-btn lib-btn-installed">&#10003; Installed</span>`
            : `<span class="lib-btn lib-btn-${st === "update" ? "update" : "install"}">${st === "update" ? "Update" : "Install"}</span>`;
        return `<div class="lib-row lib-row-click" data-act="open" data-prefix="${esc(c.prefix)}" data-version="${esc(c.version)}">
            ${icon(c.interface)}
            <div class="lib-row-body">
                <div class="lib-row-name"><span class="lib-row-nm">${esc(c.name)}</span>${tag}</div>
                <div class="lib-row-desc">${net}${esc(c.description || c.interface || "")}</div>
            </div>
            <div class="lib-row-act">${action}</div>
        </div>`;
    };
    const instRow = (l) => {
        const g = gridByPrefix[l.prefix];
        const hasUpdate = g && g.version !== l.version;
        const ver = (g && g.version) || l.version;
        const right = hasUpdate ? `<span class="lib-tag lib-tag-update">Update</span>` : `<span class="lib-row-chev">›</span>`;
        return `<div class="lib-row lib-row-click" data-act="open" data-prefix="${esc(l.prefix)}" data-version="${esc(ver)}">
            ${icon(l.interface)}
            <div class="lib-row-body">
                <div class="lib-row-name"><span class="lib-row-nm">${esc(l.name || l.prefix)}</span><span class="lib-row-ver">v${esc(l.version || "?")}</span></div>
                <div class="lib-row-desc">${esc(l.interface || "")}${(l.capabilities || []).includes("network") ? " · network" : ""}</div>
            </div>
            <div class="lib-row-act">${right}</div>
        </div>`;
    };
    // Private-collection rows carry a clear provenance cue: these are the user's
    // own unsigned, unreviewed libraries (trusted by their login, not a registry
    // signature). The row action installs straight from their collection.
    const collRow = (c) => {
        const inst = installedByPrefix[c.prefix];
        const sameVer = inst && inst.version === c.version;
        // Installed (this or another version) → let them remove it; a stale/broken
        // installed driver breaks every firmware build, so uninstall must be handy.
        const primary = !inst
            ? `<button class="lib-btn lib-btn-install lib-coll-install" data-prefix="${esc(c.prefix)}" data-version="${esc(c.version)}">Install</button>`
            : sameVer
                ? `<span class="lib-btn lib-btn-installed">&#10003; Installed</span>`
                : `<button class="lib-btn lib-btn-update lib-coll-install" data-prefix="${esc(c.prefix)}" data-version="${esc(c.version)}">Update</button>`;
        const uninstall = inst
            ? `<button class="lib-btn lib-btn-install lib-coll-uninstall" data-prefix="${esc(c.prefix)}" title="Remove the installed driver from this project">Uninstall</button>`
            : "";
        return `<div class="lib-row">
            ${icon(c.interface)}
            <div class="lib-row-body">
                <div class="lib-row-name"><span class="lib-row-nm">${esc(c.name || c.prefix)}</span><span class="lib-tag lib-tag-private">private</span><span class="lib-row-ver">v${esc(c.version || "?")}</span></div>
                <div class="lib-row-desc">${esc(c.description || c.interface || "")} · unreviewed, yours only</div>
            </div>
            <div class="lib-row-act">${primary}${uninstall}</div>
        </div>`;
    };

    // Open the detail sheet for a library (Grid or Installed). Downloads + verifies
    // via the Grid, then hands the verified result to the sheet, which decides the
    // actions (Install / Update / Add to project / Uninstall).
    async function openDetail(prefix, version) {
        let res;
        try { res = await api.gridFetch(prefix, version); }
        catch (e) { res = { ok: false, reason: String((e && e.message) || e) }; }
        if (!res || !res.token) {
            return dialog.alert("Cannot open library", {
                detail: res && res.stage === "verify"
                    ? `Signature verification failed: ${res.reason}`
                    : (res && res.reason) || "This library isn’t available on the Grid.",
            });
        }
        installer.showResult(res, {
            onClose: refresh,
            onUse: () => {
                const desc = descByPrefix[prefix];
                if (desc) addDevice(desc, { withSample: true });
                else dialog.alert("Descriptor unavailable", { detail: "Reinstall the library to use it in code." });
            },
            onUninstall: () => doUninstall(prefix),
        });
    }

    async function doUninstall(prefix) {
        const ok = await dialog.confirm(`Remove "${prefix}"?`, { detail: "Deletes the installed library files and header.", okLabel: "Remove", danger: true });
        if (!ok) return;
        try { await api.vlibUninstall(prefix); }
        catch (e) { return dialog.alert("Remove failed", { detail: String((e && e.message) || e) }); }
        refresh();
    }

    function paint(filter) {
        const f = (filter || "").toLowerCase().trim();
        const searching = !!f;
        const match = (o) => !f || `${o.name || ""} ${o.prefix || ""} ${o.description || ""} ${o.interface || ""} ${o.category || ""} ${o.author || ""}`.toLowerCase().includes(f);
        container.querySelectorAll(".lib-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));

        if (tab === "installed") {
            const inst = installed.filter(match);
            scroll.innerHTML = installed.length
                ? (inst.map(instRow).join("") || `<div class="lib-empty">No installed libraries match “${esc(f)}”.</div>`)
                : `<div class="lib-empty lib-empty-cta"><div class="lib-empty-icon">◇</div><div>No libraries installed yet.</div><button class="lib-link" id="libGoGrid">Browse the Grid →</button></div>`;
            const go = scroll.querySelector("#libGoGrid");
            if (go) go.onclick = () => { tab = "grid"; saveTab(); paint(input.value); };
        } else if (tab === "mine") {
            if (!signedIn) {
                scroll.innerHTML = `<div class="lib-empty lib-empty-cta"><div class="lib-empty-icon">◇</div><div>Your private library.</div><div class="lib-note">Sign in with GitHub to install the libraries you saved in the studio.</div><button class="lib-link" id="libSignIn">Sign in with GitHub →</button></div>`;
                const s = scroll.querySelector("#libSignIn");
                if (s) s.onclick = async () => { const r = await api.authLogin(); if (r && r.ok) refresh(); };
            } else {
                const mine = collection.filter(match);
                scroll.innerHTML = collection.length
                    ? (mine.map(collRow).join("") || `<div class="lib-empty">No private libraries match “${esc(f)}”.</div>`)
                    : `<div class="lib-empty lib-empty-cta"><div class="lib-empty-icon">◇</div><div>No private libraries yet.</div><div class="lib-note">Generate one in the studio and choose “Save to my collection”.</div></div>`;
                scroll.querySelectorAll(".lib-coll-install").forEach(b => b.onclick = async (e) => {
                    e.stopPropagation();
                    const label = b.textContent;
                    b.disabled = true; b.textContent = "Installing…";
                    const r = await api.collectionInstall(b.dataset.prefix, b.dataset.version);
                    if (r && r.ok) refresh();
                    else { b.disabled = false; b.textContent = label; dialog.alert("Cannot install", { detail: (r && r.reason) || "unknown error" }); }
                });
                scroll.querySelectorAll(".lib-coll-uninstall").forEach(b => b.onclick = (e) => {
                    e.stopPropagation();
                    doUninstall(b.dataset.prefix); // shared confirm + remove + refresh
                });
            }
        } else {
            const gcells = grid.filter(match);
            const buckets = {};
            for (const c of gcells) { const k = LIB_CAT_TO_GRP[c.category] || "other"; (buckets[k] ||= []).push(c); }
            const groupsHtml = LIB_GROUPS.filter(g => buckets[g.key] && buckets[g.key].length).map(g => {
                const items = buckets[g.key].slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
                const isCollapsed = !searching && !expanded.has(g.key);
                return `<div class="lib-grp${isCollapsed ? " collapsed" : ""}" data-grp="${esc(g.key)}">
                    <button class="lib-grp-hdr" data-grp="${esc(g.key)}">
                        <span class="lib-grp-chev">&#9662;</span>
                        <span class="lib-grp-label">${esc(g.label)}</span>
                        <span class="lib-grp-sum">${ifaceDots(items)}</span>
                        <span class="lib-grp-count">${items.length}</span>
                    </button>
                    <div class="lib-grp-body">${items.map(gridRow).join("")}</div>
                </div>`;
            }).join("");
            scroll.innerHTML = gridOffline
                ? `<div class="lib-note lib-note-warn">Grid unreachable. Check the URL in <b>Settings → Registry</b>, or start your Grid.</div>`
                : (groupsHtml || `<div class="lib-empty">${grid.length ? `No Grid libraries match “${esc(f)}”.` : "No published libraries on the Grid yet."}</div>`);
        }

        // whole row opens the detail sheet (Grid → install, Installed → manage)
        scroll.querySelectorAll("[data-act='open']").forEach(r => r.onclick = () => openDetail(r.dataset.prefix, r.dataset.version));
        // expand/collapse category groups (frozen while searching — all shown)
        scroll.querySelectorAll(".lib-grp-hdr").forEach(h => h.onclick = () => {
            if (searching) return;
            const k = h.dataset.grp;
            if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
            saveExpanded();
            h.parentElement.classList.toggle("collapsed");
        });
    }

    container.querySelectorAll(".lib-tab").forEach(t => t.onclick = () => { tab = t.dataset.tab; saveTab(); paint(input.value); });
    const syncClear = () => searchBox.classList.toggle("has-text", !!input.value);
    input.oninput = () => { syncClear(); paint(input.value); };
    clearBtn.onclick = () => { input.value = ""; syncClear(); paint(""); input.focus(); };
    syncClear();
    paint("");
}

// Install a Grid library from a deep link (volt://install/<prefix>/<version>).
// Standalone — fires whether or not the Library panel is open. Fetches +
// verifies via the Grid, then shows the same signed-import consent sheet as a
// file import; the user still confirms before anything is written.
export async function installFromGrid(prefix, version) {
    if (!prefix) return;
    // The deep link may omit the version — resolve the published one.
    if (!version) {
        try {
            const cells = (await api.gridList()) || [];
            const hit = cells.find((c) => c.prefix === prefix);
            version = hit && hit.version;
        } catch (_) {}
    }
    if (!version) {
        return dialog.alert("Cannot install library", {
            detail: `“${prefix}” isn’t published on the Grid.`,
        });
    }
    let res;
    try { res = await api.gridFetch(prefix, version); }
    catch (e) { res = { ok: false, reason: String((e && e.message) || e) }; }
    if (!res || !res.token) {
        return dialog.alert("Cannot install library", {
            detail: res && res.stage === "verify"
                ? `Signature verification failed: ${res.reason}`
                : (res && res.reason) || "This library isn’t available on the Grid.",
        });
    }
    installer.showResult(res, { onClose: () => {} });
}

// ============================================================
// Context menu
// ============================================================
function openContextMenu(device, anchor, mouse) {
    closeContextMenu();

    const editorSrc = currentEditorSource();
    const status = analyzeProjectState(device, editorSrc);

    // Single install action: device + bus (if missing) + sample block.
    // Convention is consistent across every driver so users always get a
    // runnable starter, not a half-set-up declaration.
    const items = [];
    if (status.kind === "duplicate") {
        items.push({ id: "add", label: "Add another (device + sample)", hint: "Enter" });
    } else if (status.kind === "needs-bus") {
        items.push({ id: "add", label: `Add device + ${status.busType} bus + sample`, hint: "Enter" });
    } else {
        items.push({ id: "add", label: "Add to project (device + bus + sample)", hint: "Enter" });
    }
    items.push({ divider: true });
    items.push({ id: "details", label: "View details…",     hint: "I" });
    items.push({ id: "source",  label: "Open C source" });
    items.push({ divider: true });
    items.push({ id: "copy-decl",    label: "Copy declaration only" });
    items.push({ id: "copy-snippet", label: "Copy full snippet" });

    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.innerHTML = items.map((it, i) => it.divider
        ? '<div class="context-menu-divider"></div>'
        : `<button class="context-menu-item" data-action="${it.id}" data-i="${i}">
               <span class="context-menu-label">${esc(it.label)}</span>
               ${it.hint ? `<span class="context-menu-hint">${esc(it.hint)}</span>` : ""}
           </button>`
    ).join("");
    document.body.appendChild(menu);

    // Position: prefer below the anchor, flip up if no room
    const rect = anchor.getBoundingClientRect();
    const px = mouse ? mouse.x : (rect.left + rect.width / 2 - 10);
    const py = mouse ? mouse.y : (rect.bottom + 4);
    requestAnimationFrame(() => {
        const mw = menu.offsetWidth;
        const mh = menu.offsetHeight;
        let left = Math.max(8, Math.min(window.innerWidth - mw - 8, px));
        let top = py;
        if (top + mh > window.innerHeight - 8) top = Math.max(8, py - mh - 8);
        menu.style.left = left + "px";
        menu.style.top  = top + "px";
    });

    // Keyboard nav: arrow / Enter / Escape / I shortcut
    let cursor = 0;
    const activatable = items.map((it, i) => it.divider ? null : i).filter(i => i !== null);
    function focus(i) {
        cursor = i;
        menu.querySelectorAll(".context-menu-item").forEach(b => b.classList.remove("is-focus"));
        const el = menu.querySelector(`[data-i="${i}"]`);
        if (el) el.classList.add("is-focus");
    }
    focus(activatable[0]);

    function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); closeContextMenu(); }
        else if (e.key === "Enter") {
            e.preventDefault();
            const item = items[cursor];
            if (item) execute(item.id, device);
        }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const idx = activatable.indexOf(cursor);
            const step = e.key === "ArrowDown" ? 1 : -1;
            focus(activatable[(idx + step + activatable.length) % activatable.length]);
        }
        else if (e.key.toLowerCase() === "i") {
            e.preventDefault();
            execute("details", device);
        }
    }
    function onClickOutside(e) { if (!menu.contains(e.target)) closeContextMenu(); }

    menu.querySelectorAll(".context-menu-item").forEach(btn => {
        btn.onmouseenter = () => focus(Number(btn.dataset.i));
        btn.onclick = () => execute(btn.dataset.action, device);
    });

    document.addEventListener("keydown", onKey);
    setTimeout(() => document.addEventListener("click", onClickOutside), 0);

    // Stash cleanup so closeContextMenu can find it
    menu._cleanup = () => {
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("click", onClickOutside);
    };
}

function closeContextMenu() {
    const m = document.querySelector(".context-menu");
    if (!m) return;
    if (m._cleanup) m._cleanup();
    m.remove();
}

// ============================================================
// Actions
// ============================================================
function execute(actionId, device) {
    closeContextMenu();
    switch (actionId) {
        case "add":          addDevice(device, { withSample: true });   break;
        case "details":      openDetailDialog(device);                  break;
        case "source":       openCSourceViewer(device);                 break;
        case "copy-decl":    copyToClipboard(buildDeclaration(device, suggestName(device, currentEditorSource()))); break;
        case "copy-snippet": copyToClipboard(buildSnippet(device));     break;
    }
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).catch(() => {});
}

// ============================================================
// Insertion logic — manipulates the Monaco editor in place
// ============================================================
function currentEditorSource() {
    if (typeof monaco === "undefined") return "";
    const editors = monaco.editor.getEditors();
    return editors.length > 0 ? editors[0].getValue() : "";
}

function suggestName(device, source) {
    const base = device.name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "dev";
    let i = 1;
    while (new RegExp(`\\b${base}${i}\\b`).test(source)) i++;
    return `${base}${i}`;
}

function busFor(device) {
    const iface = (device.interface || "").toLowerCase();
    return { i2c: "i2c0", spi: "spi0", uart: "uart0" }[iface] || null;
}

// Volt grammar (grammar.lark):
//   bus_decl:    "bus"    NAME ":" NAME "(" named_args? ")"
//   sensor_decl: "device" NAME ":" NAME "on" NAME "at" expr
// So devices use 'on <bus> at <addr>' (NEVER '=') and buses use named
// args (sda/scl/sck/...). The 'at' clause is required even when the
// device has no real address — for SPI / GPIO devices it's the CS pin
// or the GPIO pin number.
function buildDeclaration(device, name) {
    const iface = (device.interface || "").toLowerCase();
    const bus = busFor(device);
    if (iface === "i2c" && bus) {
        const addr = device.default_address || "0x00";
        return `device ${name}: ${device.name} on ${bus} at ${addr}`;
    }
    if (iface === "spi" && bus) {
        // SPI devices need a CS pin in the 'at' slot
        return `device ${name}: ${device.name} on ${bus} at 5  // CS pin`;
    }
    if (iface === "uart" && bus) {
        // UART devices don't have an address but grammar still requires 'at'
        return `device ${name}: ${device.name} on ${bus} at 0`;
    }
    // GPIO (1-wire / analog / digital) — needs a pin declared first
    return `device ${name}: ${device.name} on gpio_pin at 4  // change pin`;
}

function buildSnippet(device) {
    const name = suggestName(device, "");
    const iface = (device.interface || "").toLowerCase();
    const bus = busFor(device);
    let busLine = "";
    // bus_decl uses NAMED args, no '=' sign. Standard ESP32 pin assignments.
    if (iface === "i2c"  && bus) busLine = `    bus ${bus}: I2C(sda: 21, scl: 22)\n`;
    if (iface === "spi"  && bus) busLine = `    bus ${bus}: SPI(sck: 18, mosi: 23, miso: 19)\n`;
    if (iface === "uart" && bus) busLine = `    bus ${bus}: UART(tx: 17, rx: 16)\n`;

    const decl = "    " + buildDeclaration(device, name);
    return `hardware {\n${busLine}${decl}\n}\n\n${buildSampleBlock(device, name)}`;
}

// ============================================================
// Sample-block generator — picks a pattern from the device's methods
// ============================================================
//
// Five patterns, in priority order:
//   1. Display with text + show         → tick counter + draw
//   2. LED strip with fill/set + show   → color cycle
//   3. ≥ 2 readers                       → log multiple readings
//   4. exactly 1 reader                  → focused let + log
//   5. only writers                      → call first writer periodically
//
// Every output starts with a // comment describing what the block does.

function buildSampleBlock(device, name) {
    const methods = device.methods || {};
    const methodNames = Object.keys(methods);
    if (methodNames.length === 0) {
        return `// ${name} has no documented methods — fill in your own loop\n` +
               `every 1s {\n    // ${name}.method()\n}\n`;
    }

    const has = (n) => methodNames.includes(n);
    const paramCount = (n) => (methods[n].params || []).length;
    // Only treat NO-PARAM methods as "free" readers — methods that take a
    // channel/index would crash with zero args under the generic pattern.
    const readers = methodNames.filter(n =>
        methods[n].returns && methods[n].returns !== "void" && paramCount(n) === 0);

    // ----- Display patterns (three distinct API shapes) -----

    // Pattern 1a: Character LCD — cursor-positioned print/clear (16x2 / 20x4 / HD44780)
    if (has("print") && has("set_cursor")) {
        const lines = [];
        lines.push(`// Two-line dashboard on ${name} — title + live counter`);
        lines.push(`var ${name}_n: int = 0`);
        lines.push(``);
        lines.push(`every 1s {`);
        lines.push(`    ${name}_n += 1`);
        lines.push(`    ${name}.clear()`);
        lines.push(`    ${name}.set_cursor(0, 0)`);
        lines.push(`    ${name}.print("Volt IDE")`);
        lines.push(`    ${name}.set_cursor(0, 1)`);
        lines.push(`    ${name}.print("Tick: {${name}_n}")`);
        lines.push(`}`);
        return lines.join("\n") + "\n";
    }

    // Pattern 1b: LED matrix / 7-segment — row writes (MAX7219)
    if (has("set_row") || has("set_digit")) {
        const lines = [];
        if (has("set_row")) {
            lines.push(`// Sweep a lit row across the 8×8 matrix every 100ms`);
            lines.push(`var ${name}_row: int = 0`);
            lines.push(``);
            lines.push(`every 100ms {`);
            lines.push(`    ${name}.clear()`);
            lines.push(`    ${name}.set_row(${name}_row, 0xFF)   // 0xFF = all 8 LEDs in the row on`);
            lines.push(`    ${name}_row = (${name}_row + 1) % 8`);
            lines.push(`}`);
        } else {
            lines.push(`// Count up on the 7-segment display`);
            lines.push(`var ${name}_n: int = 0`);
            lines.push(``);
            lines.push(`every 500ms {`);
            lines.push(`    ${name}_n = (${name}_n + 1) % 10000`);
            lines.push(`    ${name}.set_digit(0, ${name}_n / 1000 % 10, 0)`);
            lines.push(`    ${name}.set_digit(1, ${name}_n / 100  % 10, 0)`);
            lines.push(`    ${name}.set_digit(2, ${name}_n / 10   % 10, 0)`);
            lines.push(`    ${name}.set_digit(3, ${name}_n        % 10, 0)`);
            lines.push(`}`);
        }
        return lines.join("\n") + "\n";
    }

    // Pattern 1c: Pixel-grid display — clear/text(x,y)/show (SSD1306)
    if (has("show") && (has("text") || has("draw_text") || has("print"))) {
        const drawFn = has("text") ? "text" : has("draw_text") ? "draw_text" : "print";
        const lines = [];
        lines.push(`// Live dashboard layout on ${name} — title, value, status`);
        lines.push(`var ${name}_n: int = 0`);
        lines.push(``);
        lines.push(`every 1s {`);
        lines.push(`    ${name}_n += 1`);
        if (has("clear")) lines.push(`    ${name}.clear()`);
        lines.push(`    ${name}.${drawFn}(0,  0, "Volt IDE")           // top: title`);
        lines.push(`    ${name}.${drawFn}(0, 16, "Tick {${name}_n}")     // middle: live value`);
        lines.push(`    ${name}.${drawFn}(0, 48, "running")             // bottom: status`);
        lines.push(`    ${name}.show()`);
        lines.push(`}`);
        return lines.join("\n") + "\n";
    }

    // Pattern 2: LED strip / addressable colour — chase pattern with rotating hue
    if (has("show") && (has("fill") || has("set"))) {
        const lines = [];
        if (has("set")) {
            // Per-pixel: chase a single lit pixel with shifting colour
            lines.push(`// Single-pixel chase with shifting hue (adjust pixel count for your strip)`);
            lines.push(`var ${name}_pos: int = 0`);
            lines.push(`var ${name}_hue: int = 0`);
            lines.push(``);
            lines.push(`every 50ms {`);
            lines.push(`    ${name}.clear()`);
            lines.push(`    ${name}.set(${name}_pos, ${name}_hue, 128, 32)`);
            lines.push(`    ${name}_pos = (${name}_pos + 1) % 16              // strip length`);
            lines.push(`    ${name}_hue = (${name}_hue + 16) % 256`);
            lines.push(`    ${name}.show()`);
            lines.push(`}`);
        } else {
            // Whole-strip fill: cycle through R/G/B
            lines.push(`// Cycle the whole strip through red → green → blue every 500ms`);
            lines.push(`var ${name}_step: int = 0`);
            lines.push(``);
            lines.push(`every 500ms {`);
            lines.push(`    ${name}_step = (${name}_step + 1) % 3`);
            lines.push(`    if (${name}_step == 0) { ${name}.fill(255,   0,   0) }`);
            lines.push(`    if (${name}_step == 1) { ${name}.fill(  0, 255,   0) }`);
            lines.push(`    if (${name}_step == 2) { ${name}.fill(  0,   0, 255) }`);
            lines.push(`    ${name}.show()`);
            lines.push(`}`);
        }
        return lines.join("\n") + "\n";
    }

    // Pattern: ADC — channel-parameterized read (ADS1115, MCP3008)
    if ((has("voltage") && paramCount("voltage") === 1) ||
        (has("read") && paramCount("read") === 1)) {
        const m = has("voltage") ? "voltage" : "read";
        const t = methods[m].returns || "int";
        const unit = m === "voltage" ? "V" : "raw";
        const lines = [];
        lines.push(`// Read channel 0 every 100ms — try other channels by changing the index`);
        lines.push(`every 100ms {`);
        lines.push(`    let v: ${t} = ${name}.${m}(0)`);
        lines.push(`    log("${name}", "ch0={v}${unit}")`);
        lines.push(`}`);
        return lines.join("\n") + "\n";
    }

    // Pattern: DAC — single-arg write (MCP4725)
    if (has("write") && paramCount("write") === 1 && !has("set_pin")) {
        const lines = [];
        lines.push(`// Generate a 0 → 4095 → 0 triangle wave on the DAC`);
        lines.push(`var ${name}_v: int = 0`);
        lines.push(`var ${name}_dir: int = 1`);
        lines.push(``);
        lines.push(`every 10ms {`);
        lines.push(`    ${name}_v += ${name}_dir * 64`);
        lines.push(`    if (${name}_v >= 4095) { ${name}_dir = -1 }`);
        lines.push(`    if (${name}_v <= 0)    { ${name}_dir = 1 }`);
        lines.push(`    ${name}.write(${name}_v)`);
        lines.push(`}`);
        return lines.join("\n") + "\n";
    }

    // Pattern: Servo controller (PCA9685 with set_servo)
    if (has("set_servo")) {
        const lines = [];
        lines.push(`// Sweep servo on channel 0 between 0° and 180°`);
        lines.push(`var ${name}_angle: int = 0`);
        lines.push(`var ${name}_dir: int = 1`);
        lines.push(``);
        lines.push(`every 30ms {`);
        lines.push(`    ${name}_angle += ${name}_dir * 6`);
        lines.push(`    if (${name}_angle >= 180) { ${name}_dir = -1 }`);
        lines.push(`    if (${name}_angle <= 0)   { ${name}_dir = 1 }`);
        lines.push(`    ${name}.set_servo(0, ${name}_angle)`);
        lines.push(`}`);
        return lines.join("\n") + "\n";
    }

    // Pattern: PWM controller (set_duty without set_servo — fade an LED)
    if (has("set_duty")) {
        const lines = [];
        lines.push(`// Fade channel 0 from 0 → 4095 → 0 (LED breath / motor speed sweep)`);
        lines.push(`var ${name}_lvl: int = 0`);
        lines.push(`var ${name}_dir: int = 1`);
        lines.push(``);
        lines.push(`every 20ms {`);
        lines.push(`    ${name}_lvl += ${name}_dir * 64`);
        lines.push(`    if (${name}_lvl >= 4095) { ${name}_dir = -1 }`);
        lines.push(`    if (${name}_lvl <= 0)    { ${name}_dir = 1 }`);
        lines.push(`    ${name}.set_duty(0, ${name}_lvl)`);
        lines.push(`}`);
        return lines.join("\n") + "\n";
    }

    // Pattern: GPIO expander (set_pin or write(value)) — toggle pin 0
    if (has("set_pin")) {
        const lines = [];
        lines.push(`// Toggle pin 0 on ${name} every second`);
        lines.push(`var ${name}_on: int = 0`);
        lines.push(``);
        lines.push(`every 1s {`);
        lines.push(`    ${name}_on = 1 - ${name}_on`);
        lines.push(`    ${name}.set_pin(0, ${name}_on)`);
        lines.push(`}`);
        return lines.join("\n") + "\n";
    }

    // Pattern: I²C multiplexer — cycle channels (TCA9548A)
    if (has("select") && paramCount("select") === 1 && !readers.length) {
        const lines = [];
        lines.push(`// Cycle through the multiplexer's 8 channels — talk to a downstream`);
        lines.push(`// device on the selected channel between calls.`);
        lines.push(`var ${name}_ch: int = 0`);
        lines.push(``);
        lines.push(`every 1s {`);
        lines.push(`    ${name}_ch = (${name}_ch + 1) % 8`);
        lines.push(`    ${name}.select(${name}_ch)`);
        lines.push(`    log("${name}", "channel={${name}_ch}")`);
        lines.push(`}`);
        return lines.join("\n") + "\n";
    }

    // Pattern: RFID (is_card_present + read_uid)
    if (has("is_card_present") && has("read_uid")) {
        const lines = [];
        lines.push(`// Poll for an RFID card every 200ms; log the UID when one is present`);
        lines.push(`every 200ms {`);
        lines.push(`    if (${name}.is_card_present()) {`);
        lines.push(`        let uid: int = ${name}.read_uid()`);
        lines.push(`        log("${name}", "card uid={uid}")`);
        lines.push(`    }`);
        lines.push(`}`);
        return lines.join("\n") + "\n";
    }

    // Pattern: Radio (send + available) — send a heartbeat, watch for incoming
    if (has("send") && has("available")) {
        const lines = [];
        lines.push(`// Send a heartbeat once a second; log when peers respond`);
        lines.push(`every 1s {`);
        lines.push(`    ${name}.send("hello")`);
        lines.push(`}`);
        lines.push(``);
        lines.push(`every 100ms {`);
        lines.push(`    if (${name}.available()) {`);
        lines.push(`        log("${name}", "data available")`);
        lines.push(`    }`);
        lines.push(`}`);
        return lines.join("\n") + "\n";
    }

    // Pattern 3: multi-reader — log several readings with sensible variable names
    if (readers.length >= 2) {
        const interval = device.category === "motion" ? "100ms"
                       : device.category === "time"   ? "60s"
                       :                                 "5s";
        const desc = (device.description || device.name).toLowerCase();
        const picks = readers.slice(0, 4);  // cap to keep the log line readable
        const lines = [];
        lines.push(`// Read ${name} every ${interval} — ${desc}`);
        lines.push(`every ${interval} {`);
        const vars = picks.map(m => ({ m, v: letName(m), t: methods[m].returns }));
        for (const { m, v, t } of vars) {
            lines.push(`    let ${v}: ${t} = ${name}.${m}()`);
        }
        const tag = vars.map(({ m, v }) => `${tagFor(m)}={${v}}`).join(" ");
        lines.push(`    log("${name}", "${tag}")`);
        lines.push(`}`);
        return lines.join("\n") + "\n";
    }

    // Pattern 4: single reader
    if (readers.length === 1) {
        const m = readers[0];
        const t = methods[m].returns;
        const desc = methods[m].description || `Read ${name}.${m}()`;
        const lines = [];
        lines.push(`// ${desc}`);
        lines.push(`every 200ms {`);
        lines.push(`    let v: ${t} = ${name}.${m}()`);
        lines.push(`    log("${name}", "${m}={v}")`);
        lines.push(`}`);
        return lines.join("\n") + "\n";
    }

    // Pattern 5: only writers — exercise the first method
    const m = methodNames[0];
    const args = (methods[m].params || []).map(p => defaultArg(p.type)).join(", ");
    return `// Drive ${name} every second — adjust args as needed\n` +
           `every 1s {\n    ${name}.${m}(${args})\n}\n`;
}

// Short, readable let-binding name for common reading methods.
function letName(method) {
    const aliases = {
        temperature: "t", humidity: "h", pressure: "p",
        voltage: "v", current: "i", power: "pw", shunt_voltage: "sv",
        hours: "h", minutes: "m", seconds: "s",
        year: "yr", month: "mo", date: "d",
        accel_x: "ax", accel_y: "ay", accel_z: "az",
        gyro_x: "gx", gyro_y: "gy", gyro_z: "gz",
        distance_cm: "d", distance_mm: "d",
        lux: "lx", uv: "uv", ir: "ir",
        heart_rate: "hr", spo2: "spo2",
    };
    if (aliases[method]) return aliases[method];
    // Fallback: take the first letters of underscore-separated words, max 3
    return method.split("_").map(s => s[0]).join("").slice(0, 3) || "v";
}

// Compact label used in the log tag — preserves human meaning where possible.
function tagFor(method) {
    const labels = {
        temperature: "temp", humidity: "hum", pressure: "P",
        voltage: "V", current: "A", power: "W",
        hours: "h", minutes: "m", seconds: "s",
        accel_x: "ax", accel_y: "ay", accel_z: "az",
        gyro_x: "gx", gyro_y: "gy", gyro_z: "gz",
        distance_cm: "dist_cm",
    };
    return labels[method] || method;
}

function defaultArg(type) {
    switch (type) {
        case "int":    return "0";
        case "float":  return "0.0";
        case "string": return '"hello"';
        case "bool":   return "true";
        default:       return "0";
    }
}

function analyzeProjectState(device, source) {
    if (!source) return { kind: "clean" };
    // Already declared (same device type)?
    if (new RegExp(`:\\s*${device.name}\\b`).test(source)) return { kind: "duplicate" };
    // Bus required and missing?
    const iface = (device.interface || "").toLowerCase();
    if (iface === "i2c"  && !/\bbus\s+\w+\s*:\s*I2C\b/.test(source))  return { kind: "needs-bus", busType: "I²C" };
    if (iface === "spi"  && !/\bbus\s+\w+\s*:\s*SPI\b/.test(source))  return { kind: "needs-bus", busType: "SPI" };
    if (iface === "uart" && !/\bbus\s+\w+\s*:\s*UART\b/.test(source)) return { kind: "needs-bus", busType: "UART" };
    return { kind: "clean" };
}

function addDevice(device, { withSample }) {
    const editors = monaco.editor.getEditors();
    if (!editors.length) return;
    const editor = editors[0];
    const model = editor.getModel();
    const source = model.getValue();

    const name = suggestName(device, source);
    const declLine = buildDeclaration(device, name);
    const state = analyzeProjectState(device, source);

    // 1. Insert into (or create) the hardware { } block. Match accepts
    // both multi-line and single-line forms; we always insert a fresh line
    // before the closing brace, preserving existing content's line endings.
    let newSource = source;
    const hwMatch = newSource.match(/hardware\s*\{([\s\S]*?)\}/);
    const iface = (device.interface || "").toLowerCase();
    const bus = busFor(device);
    const needBus = state.kind === "needs-bus";

    let busInsert = "";
    if (needBus && bus) {
        // Named-args bus declarations matching the Volt grammar.
        if (iface === "i2c")  busInsert = `    bus ${bus}: I2C(sda: 21, scl: 22)\n`;
        if (iface === "spi")  busInsert = `    bus ${bus}: SPI(sck: 18, mosi: 23, miso: 19)\n`;
        if (iface === "uart") busInsert = `    bus ${bus}: UART(tx: 17, rx: 16)\n`;
    }

    if (hwMatch) {
        const closeIdx = hwMatch.index + hwMatch[0].length - 1;  // position of '}'
        const beforeClose = newSource.slice(0, closeIdx);
        // Ensure we start the new content on its own line, even if the
        // previous block was single-line: "hardware { pin led = 2 }".
        const needNL = !beforeClose.endsWith("\n");
        const insert = `${needNL ? "\n" : ""}${busInsert}    ${declLine}\n`;
        newSource = beforeClose + insert + newSource.slice(closeIdx);
    } else {
        newSource = `hardware {\n${busInsert}    ${declLine}\n}\n\n` + newSource;
    }

    // 2. Optionally append a sample block tailored to the device's shape
    //    (display / LED strip / multi-reader sensor / single reader / writers).
    if (withSample) {
        const sample = buildSampleBlock(device, name);
        newSource = newSource.trimEnd() + "\n\n" + sample;
    }

    // 3. Apply via executeEdits so the user can undo.
    editor.executeEdits("library-add-device", [{
        range: model.getFullModelRange(),
        text: newSource,
        forceMoveMarkers: true,
    }]);
    editor.focus();
}

// ============================================================
// Detail dialog — read-only, reached via "View details…"
//
// Renders a rich view of the device. Sections appear only when the
// underlying field exists in device.json, so backfilling metadata in
// any device.json improves its detail page with no code changes.
//
// Schema (all optional except name/methods):
//   manufacturer  string
//   datasheet     URL string
//   description   string
//   specs         { voltage, current, range, accuracy, sample_rate, ... }
//   wiring        { pins: [{ label, type: "power|ground|data|clock|...", note }] }
//   tips          string[]    bullet points for pitfalls / good-to-know
//   examples      [{ title, code }]
//   alternatives  [{ name, note }]
//   methods       { name: { returns, params: [{name, type}], description } }
// ============================================================
function openDetailDialog(device) {
    const existing = document.getElementById("deviceDetailOverlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "deviceDetailOverlay";
    overlay.className = "overlay";

    const iface = (device.interface || "").toUpperCase();
    const ifaceText = iface === "I2C" ? "I²C" : iface;
    const addr = device.default_address || "";

    // ----- Specs grid (flat key/value pairs from device.specs) -----
    const specs = device.specs || {};
    const specsHtml = Object.keys(specs).length
        ? `<dl class="device-specs">
             ${Object.entries(specs).map(([k, v]) => `
                 <dt>${esc(prettifySpec(k))}</dt>
                 <dd>${esc(String(v))}</dd>
             `).join("")}
           </dl>`
        : "";

    // ----- Wiring pin list -----
    const wiringPins = (device.wiring && device.wiring.pins) || [];
    const wiringHtml = wiringPins.length
        ? `<ul class="device-wiring">
             ${wiringPins.map(p => `
                 <li class="device-wire device-wire-${esc(p.type || "data")}">
                     <span class="device-wire-pin">${esc(p.label || "")}</span>
                     <span class="device-wire-type">${esc(p.type || "")}</span>
                     ${p.note ? `<span class="device-wire-note">${esc(p.note)}</span>` : ""}
                 </li>
             `).join("")}
           </ul>`
        : "";

    // ----- Methods table -----
    const methods = device.methods || {};
    const methodsHtml = Object.keys(methods).length
        ? `<table class="device-methods">
             ${Object.entries(methods).map(([name, m]) => `
                 <tr>
                     <td class="dm-name">.${esc(name)}(${(m.params || []).map(p => esc(p.name || "")).join(", ")})</td>
                     <td class="dm-returns">${m.returns ? "→ " + esc(m.returns) : ""}</td>
                     <td class="dm-desc">${esc(m.description || "")}</td>
                 </tr>
             `).join("")}
           </table>`
        : `<div class="device-methods-empty">No documented methods.</div>`;

    // ----- Tips / pitfalls -----
    const tips = device.tips || [];
    const tipsHtml = tips.length
        ? `<ul class="device-tips">
             ${tips.map(t => `<li>${esc(t)}</li>`).join("")}
           </ul>`
        : "";

    // ----- Examples (rich code samples with titles) -----
    let examples = device.examples;
    if (!Array.isArray(examples) || examples.length === 0) {
        // Fall back to the auto-generated snippet so users always see one example
        examples = [{ title: "Quick example", code: buildSnippet(device) }];
    }
    const examplesHtml = examples.map(ex => `
        <div class="device-example">
            <div class="device-example-title">${esc(ex.title || "Example")}</div>
            <pre class="device-detail-snippet"><code>${esc(ex.code || "")}</code></pre>
        </div>
    `).join("");

    // ----- Alternatives -----
    const alts = device.alternatives || [];
    const altsHtml = alts.length
        ? `<ul class="device-alts">
             ${alts.map(a => `
                 <li><span class="device-alt-name">${esc(a.name || "")}</span>${a.note ? ` — ${esc(a.note)}` : ""}</li>
             `).join("")}
           </ul>`
        : "";

    // ----- Header byline (manufacturer + datasheet link) -----
    const byline = [];
    if (device.manufacturer) byline.push(`<span class="device-byline-mfr">${esc(device.manufacturer)}</span>`);
    if (device.datasheet)    byline.push(`<a class="device-byline-link" href="#" data-href="${esc(device.datasheet)}">Datasheet ↗</a>`);
    const bylineHtml = byline.length ? `<div class="device-byline">${byline.join(" · ")}</div>` : "";

    overlay.innerHTML = `
        <div class="device-detail-dialog">
            <div class="device-detail-header">
                <div class="device-detail-title">
                    <span class="device-detail-name">${esc(device.name)}</span>
                    <span class="device-detail-badges">
                        <span class="device-badge device-badge-cat">${esc(CATEGORY_LABELS[device.category] || device.category || "")}</span>
                        <span class="device-badge device-badge-iface">${esc(ifaceText)}${addr ? " " + esc(addr) : ""}</span>
                    </span>
                </div>
                <button class="device-detail-close" id="deviceDetailClose" aria-label="Close">&times;</button>
            </div>
            <div class="device-detail-body">
                ${bylineHtml}
                ${device.description ? `<p class="device-detail-desc">${esc(device.description)}</p>` : ""}

                ${specsHtml ? `<div class="device-detail-section-title">Specs</div>${specsHtml}` : ""}
                ${wiringHtml ? `<div class="device-detail-section-title">Wiring</div>${wiringHtml}` : ""}

                <div class="device-detail-section-title">Methods</div>
                ${methodsHtml}

                <div class="device-detail-section-title">Examples</div>
                ${examplesHtml}

                ${tipsHtml ? `<div class="device-detail-section-title">Tips & gotchas</div>${tipsHtml}` : ""}
                ${altsHtml ? `<div class="device-detail-section-title">Alternatives</div>${altsHtml}` : ""}
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Datasheet links open in the user's external browser (not inside Electron)
    overlay.querySelectorAll(".device-byline-link[data-href]").forEach(a => {
        a.onclick = (e) => {
            e.preventDefault();
            const url = a.getAttribute("data-href");
            if (url && window.volt && window.volt.openExternal) window.volt.openExternal(url);
            else if (url) window.open(url, "_blank");
        };
    });

    const close = () => {
        overlay.classList.add("is-closing");
        setTimeout(() => overlay.remove(), 200);
    };
    overlay.querySelector("#deviceDetailClose").onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.addEventListener("keydown", function esc(e) {
        if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
    });
}

function prettifySpec(key) {
    // operating_temp → "Operating temp"; "voltage" → "Voltage"
    return String(key).replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// ============================================================
// C source viewer — read-only Monaco buffer in a dialog
// ============================================================
async function openCSourceViewer(device) {
    if (!device.c_source) {
        dialog.alert("No source available", { detail: `No C source is listed for ${device.name}.` });
        return;
    }
    const chip = detectChip();
    let result;
    try {
        result = await api.deviceSource(chip, device.c_source);
    } catch (e) {
        dialog.alert("Couldn't open source", { detail: e.message });
        return;
    }

    const existing = document.getElementById("cSourceOverlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "cSourceOverlay";
    overlay.className = "overlay";
    overlay.innerHTML = `
        <div class="c-source-dialog">
            <div class="device-detail-header">
                <div class="device-detail-title">
                    <span class="device-detail-name">${esc(device.c_source)}</span>
                    <span class="device-detail-badges">
                        <span class="device-badge device-badge-iface">read-only</span>
                    </span>
                </div>
                <button class="device-detail-close" id="cSourceClose" aria-label="Close">&times;</button>
            </div>
            <div class="c-source-body" id="cSourceBody"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    const body = overlay.querySelector("#cSourceBody");
    const ed = monaco.editor.create(body, {
        value: result.content,
        language: "c",
        theme: "volt-dark",
        readOnly: true,
        fontSize: 13,
        lineHeight: 22,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
    });

    const close = () => {
        overlay.classList.add("is-closing");
        setTimeout(() => { ed.dispose(); overlay.remove(); }, 200);
    };
    overlay.querySelector("#cSourceClose").onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.addEventListener("keydown", function esc(e) {
        if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
    });
}

function detectChip() {
    const src = currentEditorSource();
    const m = src.match(/^\s*chip\s+(\w+)/m);
    if (m) return m[1];
    const el = document.getElementById("chipLabel");
    if (el && el.textContent) return el.textContent.toLowerCase();
    return "esp32";
}

function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
