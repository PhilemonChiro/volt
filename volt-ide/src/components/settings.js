// Settings dialog — modal with sidebar nav + right pane.
//
// Renders the schema returned by the main process and writes changes back
// via the settings service. Settings apply live (see services/settings.js
// subscribers in editor.js, diagnostics.js, etc.).

import * as settings from "../services/settings.js";

const api = window.volt;

export async function show() {
    await settings.init();

    const old = document.getElementById("settingsOverlay");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "settingsOverlay";
    overlay.className = "overlay";
    document.body.appendChild(overlay);

    function close() {
        overlay.classList.add("is-closing");
        setTimeout(() => overlay.remove(), 200);
    }

    const schema = settings.getSchema();
    const categories = Object.keys(schema);
    let activeCategory = categories[0] || "editor";

    function render() {
        overlay.innerHTML = `
            <div class="settings-dialog">
                <div class="settings-header">
                    <span class="settings-title">Settings</span>
                    <button class="settings-close" id="settingsClose" aria-label="Close">&times;</button>
                </div>
                <div class="settings-body">
                    <nav class="settings-nav">
                        ${categories.map(cat => `
                            <button class="settings-nav-item ${cat === activeCategory ? "is-active" : ""}"
                                    data-cat="${cat}">
                                ${esc(schema[cat].label)}
                            </button>
                        `).join("")}
                        <div class="settings-nav-spacer"></div>
                        <button class="settings-nav-item settings-nav-advanced" data-cat="__advanced">
                            Advanced
                        </button>
                    </nav>
                    <div class="settings-pane" id="settingsPane"></div>
                </div>
            </div>
        `;

        renderPane();

        overlay.querySelector("#settingsClose").onclick = close;
        overlay.onclick = (e) => { if (e.target === overlay) close(); };

        overlay.querySelectorAll(".settings-nav-item").forEach(btn => {
            btn.onclick = () => {
                activeCategory = btn.dataset.cat;
                render();
            };
        });
    }

    function renderPane() {
        const pane = overlay.querySelector("#settingsPane");
        if (activeCategory === "__advanced") {
            pane.innerHTML = renderAdvanced();
            bindAdvanced(pane);
            return;
        }
        const group = schema[activeCategory];
        if (!group) { pane.innerHTML = ""; return; }

        pane.innerHTML = `
            <div class="settings-section-title">${esc(group.label)}</div>
            <div class="settings-rows">
                ${Object.entries(group.items).map(([name, def]) =>
                    renderRow(`${activeCategory}.${name}`, def)).join("")}
            </div>
        `;
        bindRows(pane);
    }

    function renderRow(key, def) {
        const value = settings.get(key, def.default);
        const inputHtml = renderInput(key, def, value);
        return `
            <div class="settings-row" data-key="${key}">
                <div class="settings-row-label">
                    <div class="settings-row-title">${esc(def.label)}</div>
                    ${def.hint ? `<div class="settings-row-hint">${esc(def.hint)}</div>` : ""}
                </div>
                <div class="settings-row-control">${inputHtml}</div>
            </div>
        `;
    }

    function renderInput(key, def, value) {
        const safeKey = esc(key);
        switch (def.type) {
            case "bool":
                return `
                    <label class="settings-toggle">
                        <input type="checkbox" data-input="${safeKey}" ${value ? "checked" : ""}>
                        <span class="settings-toggle-track"><span class="settings-toggle-thumb"></span></span>
                    </label>`;
            case "int":
            case "float": {
                const min = def.min ?? 0;
                const max = def.max ?? 100;
                const step = def.step ?? 1;
                return `
                    <div class="settings-slider-wrap">
                        <input type="range" class="settings-slider"
                               data-input="${safeKey}"
                               min="${min}" max="${max}" step="${step}" value="${value}">
                        <span class="settings-slider-value" data-output="${safeKey}">${value}</span>
                    </div>`;
            }
            case "enum": {
                const options = def.options || [];
                return `
                    <select class="settings-select" data-input="${safeKey}">
                        ${options.map(opt => `
                            <option value="${esc(String(opt.value))}"
                                ${String(opt.value) === String(value) ? "selected" : ""}>
                                ${esc(opt.label)}
                            </option>
                        `).join("")}
                    </select>`;
            }
            case "string":
                return `
                    <input type="text" class="settings-input"
                           data-input="${safeKey}"
                           value="${esc(String(value))}">`;
            case "path":
                return `
                    <div class="settings-path-row">
                        <input type="text" class="settings-input settings-path-input"
                               data-input="${safeKey}"
                               placeholder="(auto-detect)"
                               value="${esc(String(value))}">
                        <button class="settings-path-browse" data-browse="${safeKey}">Browse…</button>
                    </div>`;
            default:
                return `<span class="settings-row-hint">(unsupported: ${def.type})</span>`;
        }
    }

    function bindRows(pane) {
        pane.querySelectorAll("input[type='checkbox'][data-input]").forEach(el => {
            el.onchange = () => settings.set(el.dataset.input, el.checked);
        });
        pane.querySelectorAll("input[type='range'][data-input]").forEach(el => {
            const out = pane.querySelector(`[data-output="${el.dataset.input}"]`);
            el.oninput = () => { if (out) out.textContent = el.value; };
            el.onchange = () => settings.set(el.dataset.input, Number(el.value));
        });
        pane.querySelectorAll("select[data-input]").forEach(el => {
            el.onchange = () => {
                let v = el.value;
                // Try to coerce numeric strings back to numbers when the schema had numeric options
                if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
                settings.set(el.dataset.input, v);
            };
        });
        pane.querySelectorAll("input[type='text'][data-input]").forEach(el => {
            // Save on blur or Enter — typing every keystroke would be too chatty
            const save = () => settings.set(el.dataset.input, el.value);
            el.onblur = save;
            el.onkeydown = (e) => { if (e.key === "Enter") { save(); el.blur(); } };
        });
        pane.querySelectorAll("[data-browse]").forEach(btn => {
            btn.onclick = async () => {
                try {
                    const folder = await api.browseFolder();
                    if (folder) {
                        const key = btn.dataset.browse;
                        await settings.set(key, folder);
                        const input = pane.querySelector(`[data-input="${key}"]`);
                        if (input) input.value = folder;
                    }
                } catch (_) {}
            };
        });
    }

    function renderAdvanced() {
        return `
            <div class="settings-section-title">Advanced</div>
            <div class="settings-rows">
                <div class="settings-row">
                    <div class="settings-row-label">
                        <div class="settings-row-title">Open settings file</div>
                        <div class="settings-row-hint">Edit settings.json directly in your default text editor.</div>
                    </div>
                    <div class="settings-row-control">
                        <button class="settings-action-btn" id="settingsOpenFileBtn">Open file</button>
                    </div>
                </div>
                <div class="settings-row">
                    <div class="settings-row-label">
                        <div class="settings-row-title">Reset all settings</div>
                        <div class="settings-row-hint">Restore every setting to its default. This cannot be undone.</div>
                    </div>
                    <div class="settings-row-control">
                        <button class="settings-action-btn settings-action-danger" id="settingsResetBtn">Reset all</button>
                    </div>
                </div>
            </div>
        `;
    }

    function bindAdvanced(pane) {
        const openBtn = pane.querySelector("#settingsOpenFileBtn");
        if (openBtn) openBtn.onclick = () => settings.openFile();

        const resetBtn = pane.querySelector("#settingsResetBtn");
        if (resetBtn) resetBtn.onclick = async () => {
            if (!confirm("Reset all settings to their defaults?")) return;
            await settings.reset();
            render();
        };
    }

    function esc(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    render();
}
