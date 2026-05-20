// Side panel — Hardware, Tasks, Outline views (VS Code style)
// Activity bar icons on right edge toggle panels open/closed.
// Panels update live from compiler AST as user types.

let activePanel = null;
let lastAST = null;

export function init() {
    const ids = ["toggleHardware", "toggleTasks", "toggleOutline", "toggleLibrary", "togglePinout"];
    const panels = ["hardware", "tasks", "outline", "library", "pinout"];

    ids.forEach((id, i) => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                toggle(panels[i]);
            });
        }
    });

    // Draggable resize handle on the side panel's left edge.
    // Width = (editorArea's right edge − pointer x) − activity-bar width.
    const handle = document.getElementById("sideResize");
    const side   = document.getElementById("sidePanel");
    if (handle && side) {
        handle.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            handle.setPointerCapture(e.pointerId);
            side.classList.add("is-resizing");
            const startX = e.clientX;
            const startW = side.getBoundingClientRect().width;
            const onMove = (mv) => {
                // Side panel sits to the LEFT of the activity bar; widening
                // means the cursor moves further LEFT (smaller clientX).
                const newW = Math.max(200, Math.min(800, startW + (startX - mv.clientX)));
                side.style.width = newW + "px";
                // Monaco needs a layout poke as the editor reflows
                if (typeof monaco !== "undefined") {
                    const eds = monaco.editor.getEditors();
                    if (eds.length) eds[0].layout();
                }
            };
            const onUp = () => {
                side.classList.remove("is-resizing");
                handle.releasePointerCapture(e.pointerId);
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup",   onUp);
                window.removeEventListener("pointercancel", onUp);
                // Persist preferred width across sessions
                try {
                    localStorage.setItem("volt.sidePanelWidth", side.style.width);
                } catch (_) {}
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup",   onUp);
            window.addEventListener("pointercancel", onUp);
        });

        // Restore saved width on init
        try {
            const saved = localStorage.getItem("volt.sidePanelWidth");
            if (saved) side.style.width = saved;
        } catch (_) {}
    }
}

export function toggle(panel) {
    if (activePanel === panel) {
        close();
    } else {
        open(panel);
    }
}

export function open(panel) {
    activePanel = panel;

    // Reveal side panel (CSS transitions width 0 → 280)
    const side = document.getElementById("sidePanel");
    if (side) {
        const wasHidden = side.style.display === "none" || side.style.display === "";
        side.style.display = "flex";
        if (wasHidden) {
            // First-show this session: start collapsed, then expand next frame
            side.classList.add("is-closed");
            side.offsetWidth;  // force reflow
            requestAnimationFrame(() => side.classList.remove("is-closed"));
        } else {
            side.classList.remove("is-closed");
        }
    }

    // Highlight active button in activity bar
    document.querySelectorAll(".activity-btn").forEach(b => b.classList.remove("active"));
    const btnMap = { hardware: "toggleHardware", tasks: "toggleTasks", outline: "toggleOutline", library: "toggleLibrary", pinout: "togglePinout" };
    const btn = document.getElementById(btnMap[panel]);
    if (btn) btn.classList.add("active");

    // Swap visible body — fade-in via .is-active class (CSS keyframe)
    ["panelHardware", "panelTasks", "panelOutline", "panelLibrary", "panelPinout"].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.style.display = "none"; el.classList.remove("is-active"); }
    });
    const bodyMap = {
        hardware: "panelHardware",
        tasks:    "panelTasks",
        outline:  "panelOutline",
        library:  "panelLibrary",
        pinout:   "panelPinout",
    };
    const body = document.getElementById(bodyMap[panel]);
    if (body) {
        body.style.display = "";
        // Re-add the class on the next frame so the keyframe restarts
        requestAnimationFrame(() => body.classList.add("is-active"));
    }

    // Title
    const titles = { hardware: "Hardware", tasks: "Tasks", outline: "Outline", library: "Library", pinout: "Pinout" };
    const title = document.getElementById("sidePanelTitle");
    if (title) title.textContent = titles[panel] || panel;

    if (panel === "library") {
        // Library is data-driven by the device catalog, not the editor AST
        import("./library.js").then(m => m.renderInto(body));
    } else if (panel === "pinout") {
        // Pinout uses a regex extract of the CURRENT editor source — so
        // pins, buses, and devices are all picked up immediately even if
        // the file was loaded and not yet edited (onContentChange fires
        // on edits only, never on initial setValue).
        import("./pinout-panel.js").then(m => {
            m.init(body);
            const chip = (window.chipSelector && window.chipSelector.getChip()) ||
                         (document.getElementById("chipLabel") || {}).textContent || "esp32";
            let assignments = [], hw = null;
            try {
                const editors = (typeof monaco !== "undefined") ? monaco.editor.getEditors() : [];
                const source = editors.length ? editors[0].getValue() : "";
                hw = m.extractHardware(source);
                assignments = Object.values(hw.pinByGpio);
            } catch (_) { /* fall through to empty */ }
            m.render(chip.toLowerCase(), assignments, hw);
        });
    } else if (lastAST) {
        render(lastAST);
    }

    relayoutEditorThroughTransition();
}

export function close() {
    activePanel = null;
    const side = document.getElementById("sidePanel");
    if (side) {
        side.classList.add("is-closed");
        // Hide after the transition so display:flex isn't reclaimed mid-animation
        setTimeout(() => {
            if (side.classList.contains("is-closed")) side.style.display = "none";
        }, 320);  // slightly longer than --dur-slow (280ms)
    }
    document.querySelectorAll(".activity-btn").forEach(b => b.classList.remove("active"));
    relayoutEditorThroughTransition();
}

// Monaco needs explicit layout() — drive it on every frame for the duration
// of the panel transition so the editor flows smoothly with the panel width.
function relayoutEditorThroughTransition() {
    if (typeof monaco === "undefined") return;
    const editors = monaco.editor.getEditors();
    if (!editors.length) return;
    const ed = editors[0];
    const start = performance.now();
    const duration = 320;  // matches --dur-slow + safety margin
    function tick(now) {
        ed.layout();
        if (now - start < duration) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

// Called when compiler produces new AST data
export function update(ast) {
    if (!ast) return;
    lastAST = ast;
    if (activePanel) render(ast);
}

function render(ast) {
    if (!ast) return;
    if (activePanel === "hardware") renderHardware(ast);
    else if (activePanel === "tasks") renderTasks(ast);
    else if (activePanel === "outline") renderOutline(ast);
    // Pinout intentionally NOT driven from the AST path — the editor's
    // onContentChange already feeds pinout.render with the full
    // extractHardware result (pins + buses + devices). Letting the AST
    // path also call render(chip, ast.pins) overwrites bus/device state
    // with an incomplete pin-only payload, causing annotations to flicker
    // or disappear ~150ms after each keystroke.
}

// ============================================================
// Hardware panel
// ============================================================

function renderHardware(ast) {
    const el = document.getElementById("panelHardware");
    if (!el) return;

    const pins = ast.pins || [];
    const buses = ast.buses || [];
    const devices = ast.devices || [];

    if (pins.length === 0 && buses.length === 0 && devices.length === 0) {
        el.innerHTML = `<div class="panel-empty">
            <svg class="empty-illustration" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="15" x2="4" y2="15"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="15" x2="23" y2="15"/></svg>
            <div class="empty-title">No hardware yet</div>
            <div class="empty-hint">Add a <code>hardware { }</code> block to declare pins, buses, or devices.</div>
        </div>`;
        return;
    }

    let html = "";

    if (pins.length > 0) {
        html += '<div class="hw-section"><div class="hw-section-title">Pins</div>';
        for (const pin of pins) {
            const mode = (pin.mode || "Output").toLowerCase();
            const badgeCls = mode.includes("output") ? "output"
                : mode.includes("input") || mode.includes("pull") ? "input"
                : mode.includes("pwm") || mode.includes("servo") || mode.includes("dac") ? "pwm"
                : mode.includes("analog") || mode.includes("touch") ? "analog" : "";
            html += `<div class="hw-item">
                <span class="hw-icon">P</span>
                <span class="hw-name">${esc(pin.name)}</span>
                <span class="hw-badge ${badgeCls}">${esc(pin.mode || "Output")}</span>
                <span class="hw-detail">GPIO ${esc(String(pin.gpio))}</span>
            </div>`;
        }
        html += "</div>";
    }

    if (buses.length > 0) {
        html += '<div class="hw-section"><div class="hw-section-title">Buses</div>';
        for (const bus of buses) {
            html += `<div class="hw-item">
                <span class="hw-icon">B</span>
                <span class="hw-name">${esc(bus.name)}</span>
                <span class="hw-badge">${esc((bus.type || "").toUpperCase())}</span>
            </div>`;
        }
        html += "</div>";
    }

    if (devices.length > 0) {
        html += '<div class="hw-section"><div class="hw-section-title">Devices</div>';
        for (const dev of devices) {
            html += `<div class="hw-item">
                <span class="hw-icon">D</span>
                <span class="hw-name">${esc(dev.name)}</span>
                <span class="hw-badge">${esc(dev.type)}</span>
                <span class="hw-detail">${esc(dev.bus || "")}</span>
            </div>`;
        }
        html += "</div>";
    }

    el.innerHTML = html;
}

// ============================================================
// Tasks panel
// ============================================================

function renderTasks(ast) {
    const el = document.getElementById("panelTasks");
    if (!el) return;

    const tasks = ast.tasks || [];
    const machines = ast.machines || [];
    const channels = ast.channels || [];

    if (tasks.length === 0 && machines.length === 0 && channels.length === 0) {
        el.innerHTML = `<div class="panel-empty">
            <svg class="empty-illustration" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <div class="empty-title">No tasks running</div>
            <div class="empty-hint">Add a <code>task</code> or <code>every</code> block to schedule work.</div>
        </div>`;
        return;
    }

    let html = "";

    if (tasks.length > 0) {
        html += '<div class="hw-section"><div class="hw-section-title">Tasks</div>';
        for (const task of tasks) {
            const tier = task.tier || "background";
            html += `<div class="task-item" data-line="${task.line || 1}">
                <span class="task-tier ${esc(tier)}">${esc(tier)}</span>
                <span class="task-name">${esc(task.name)}</span>
            </div>`;
        }
        html += "</div>";
    }

    if (machines.length > 0) {
        html += '<div class="hw-section"><div class="hw-section-title">State Machines</div>';
        for (const m of machines) {
            html += `<div class="task-item" data-line="${m.line || 1}">
                <span class="task-tier background">machine</span>
                <span class="task-name">${esc(m.name)}</span>
                <span class="hw-detail">${(m.states || []).length} states</span>
            </div>`;
            for (const state of (m.states || [])) {
                html += `<div class="hw-item is-nested">
                    <span class="hw-icon">·</span>
                    <span class="hw-name">${esc(state)}</span>
                </div>`;
            }
        }
        html += "</div>";
    }

    if (channels.length > 0) {
        html += '<div class="hw-section"><div class="hw-section-title">Channels</div>';
        for (const ch of channels) {
            html += `<div class="hw-item">
                <span class="hw-icon">C</span>
                <span class="hw-name">${esc(ch.name)}</span>
                <span class="hw-badge">${esc(ch.elem_type)}[${ch.capacity || 1}]</span>
            </div>`;
        }
        html += "</div>";
    }

    el.innerHTML = html;
    bindLineClicks(el);
}

// ============================================================
// Outline panel
// ============================================================

function renderOutline(ast) {
    const el = document.getElementById("panelOutline");
    if (!el) return;

    const items = [];
    for (const pin of (ast.pins || []))
        items.push({ icon: "P", cls: "pin", name: pin.name, detail: pin.mode || "Output", line: 0 });
    for (const en of (ast.enums || []))
        items.push({ icon: "E", cls: "enum", name: en.name, detail: `${en.variants.length} variants`, line: 0 });
    for (const task of (ast.tasks || []))
        items.push({ icon: "T", cls: "task", name: task.name, detail: task.tier || "background", line: task.line || 1 });
    for (const m of (ast.machines || []))
        items.push({ icon: "M", cls: "machine", name: m.name, detail: `${(m.states || []).length} states`, line: m.line || 1 });
    for (const ch of (ast.channels || []))
        items.push({ icon: "C", cls: "var", name: ch.name, detail: `channel<${ch.elem_type}>`, line: 0 });

    if (items.length === 0) {
        el.innerHTML = `<div class="panel-empty">
            <svg class="empty-illustration" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            <div class="empty-title">Nothing to outline</div>
            <div class="empty-hint">Symbols appear here as you declare pins, tasks, machines, and enums.</div>
        </div>`;
        return;
    }

    el.innerHTML = items.map(it => `
        <div class="outline-item" data-line="${it.line}">
            <span class="outline-icon ${it.cls}">${it.icon}</span>
            <span class="outline-name">${esc(it.name)}</span>
            <span class="outline-detail">${esc(it.detail)}</span>
        </div>
    `).join("");

    bindLineClicks(el);
}

// ============================================================
// Helpers
// ============================================================

function bindLineClicks(container) {
    container.querySelectorAll("[data-line]").forEach(item => {
        item.onclick = () => {
            const ln = parseInt(item.dataset.line);
            if (ln > 0 && typeof monaco !== "undefined") {
                const editors = monaco.editor.getEditors();
                if (editors.length > 0) {
                    editors[0].revealLineInCenter(ln);
                    editors[0].setPosition({ lineNumber: ln, column: 1 });
                    editors[0].focus();
                }
            }
        };
    });
}

function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
