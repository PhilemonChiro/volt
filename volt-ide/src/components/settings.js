// Settings dialog — modal with sidebar nav + right pane.
//
// Renders the schema returned by the main process and writes changes back
// via the settings service. Settings apply live (see services/settings.js
// subscribers in editor.js, diagnostics.js, etc.).

import * as settings from "../services/settings.js";
import * as dialog from "./dialog.js";

const api = window.volt;

export async function show(category) {
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
    // "advanced" schema items are surfaced in the custom Advanced pane below
    // (the __advanced nav item), so don't also render it as its own nav entry.
    const categories = Object.keys(schema).filter(c => c !== "advanced" && Object.values(schema[c].items).some(d => !d.hidden));
    let activeCategory = categories.includes(category) ? category : categories[0] || "editor";

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
                ${Object.entries(group.items).filter(([, def]) => !def.hidden).map(([name, def]) =>
                    renderRow(`${activeCategory}.${name}`, def)).join("")}
            </div>
        `;
        bindRows(pane);
        if (group.custom && activeCategory === "assistant") {
            const host = document.createElement("div");
            pane.querySelector(".settings-rows").replaceWith(host);
            import("./ai-settings.js").then(m => m.render(host)).catch(() => {});
        }
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
            <div class="settings-section-title">Toolchains</div>
            <div class="settings-rows">
                <div class="settings-row">
                    <div class="settings-row-label">
                        <div class="settings-row-title">Toolchain health</div>
                        <div class="settings-row-hint" id="toolchainHealthHint">Checking…</div>
                    </div>
                    <div class="settings-row-control">
                        <select class="settings-select" id="toolchainHealthChip" style="max-width:140px">
                            <option value="esp32">ESP32</option>
                        </select>
                    </div>
                </div>
                <div class="settings-row">
                    <div class="settings-row-label">
                        <div class="settings-row-title">Repair toolchain</div>
                        <div class="settings-row-hint">Wipes the selected chip's toolchain so the install dialog starts fresh next build. Use this after a failed or corrupted install.</div>
                    </div>
                    <div class="settings-row-control">
                        <button class="settings-action-btn settings-action-danger" id="toolchainRepairBtn">Repair</button>
                    </div>
                </div>
            </div>
            <div class="settings-section-title" style="margin-top:24px">Advanced</div>
            <div class="settings-rows">
                ${schema.advanced?.items?.showGeneratedC
                    ? renderRow("advanced.showGeneratedC", schema.advanced.items.showGeneratedC)
                    : ""}
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
                        <div class="settings-row-title">Log file</div>
                        <div class="settings-row-hint" id="logPathHint">Rotating ~2 MB · 3 generations · all sources (main + renderer + worker).</div>
                    </div>
                    <div class="settings-row-control">
                        <button class="settings-action-btn" id="settingsRevealLogBtn">Reveal in Finder</button>
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
        // Wire any schema-driven inputs rendered in this pane (e.g. the
        // "Show Generated C tab" toggle).
        bindRows(pane);

        const openBtn = pane.querySelector("#settingsOpenFileBtn");
        if (openBtn) openBtn.onclick = () => settings.openFile();

        const revealBtn = pane.querySelector("#settingsRevealLogBtn");
        const logHint   = pane.querySelector("#logPathHint");
        if (revealBtn) revealBtn.onclick = () => api.logReveal && api.logReveal();
        if (logHint && api.logPath) {
            api.logPath().then(p => {
                if (p) logHint.textContent = p;
            }).catch(() => {});
        }

        const resetBtn = pane.querySelector("#settingsResetBtn");
        if (resetBtn) resetBtn.onclick = async () => {
            const ok = await dialog.confirm("Reset all settings?", {
                detail: "This restores every setting to its default value.",
                okLabel: "Reset",
                danger: true,
            });
            if (!ok) return;
            await settings.reset();
            render();
        };

        // Toolchain health + repair
        const chipSel  = pane.querySelector("#toolchainHealthChip");
        const hintEl   = pane.querySelector("#toolchainHealthHint");
        const repairBtn= pane.querySelector("#toolchainRepairBtn");

        async function refreshHealth() {
            if (!chipSel || !hintEl) return;
            hintEl.textContent = "Checking…";
            try {
                const diag = await api.diagnoseToolchain(chipSel.value);
                if (diag.ready) {
                    hintEl.textContent = "Ready — verified compiler + SDK installed.";
                    hintEl.classList.remove("settings-row-hint-err");
                } else {
                    hintEl.textContent = "Not ready: " + (diag.missing || []).slice(0, 3).join("; ");
                    hintEl.classList.add("settings-row-hint-err");
                }
            } catch (e) {
                hintEl.textContent = "Could not check: " + (e?.message || e);
            }
        }

        if (chipSel) chipSel.onchange = refreshHealth;
        if (repairBtn) repairBtn.onclick = async () => {
            if (!chipSel) return;
            const chip = chipSel.value;
            const ok = await dialog.confirm(`Wipe the ${chip} toolchain?`, {
                detail: "The install dialog will reinstall it next time you build.",
                okLabel: "Wipe",
                danger: true,
            });
            if (!ok) return;
            repairBtn.disabled = true;
            repairBtn.textContent = "Repairing…";
            try {
                const r = await api.repairToolchain(chip);
                hintEl.textContent = `Wiped ${(r.removed || []).length} folders. Ready for fresh install.`;
                hintEl.classList.remove("settings-row-hint-err");
            } catch (e) {
                hintEl.textContent = "Repair failed: " + (e?.message || e);
                hintEl.classList.add("settings-row-hint-err");
            } finally {
                repairBtn.disabled = false;
                repairBtn.textContent = "Repair";
            }
        };

        refreshHealth();
    }

    function esc(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    render();
}
