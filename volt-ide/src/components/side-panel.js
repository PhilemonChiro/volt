// Side panel — Hardware, Tasks, Outline views (VS Code style)
// Activity bar icons on right edge toggle panels open/closed.
// Panels update live from compiler AST as user types.

let activePanel = null;
let lastAST = null;

export function init() {
    const ids = ["toggleHardware", "toggleTasks", "toggleOutline", "toggleLibrary"];
    const panels = ["hardware", "tasks", "outline", "library"];

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
    const btnMap = { hardware: "toggleHardware", tasks: "toggleTasks", outline: "toggleOutline", library: "toggleLibrary" };
    const btn = document.getElementById(btnMap[panel]);
    if (btn) btn.classList.add("active");

    // Swap visible body — fade-in via .is-active class (CSS keyframe)
    ["panelHardware", "panelTasks", "panelOutline", "panelLibrary"].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.style.display = "none"; el.classList.remove("is-active"); }
    });
    const bodyMap = {
        hardware: "panelHardware",
        tasks:    "panelTasks",
        outline:  "panelOutline",
        library:  "panelLibrary",
    };
    const body = document.getElementById(bodyMap[panel]);
    if (body) {
        body.style.display = "";
        // Re-add the class on the next frame so the keyframe restarts
        requestAnimationFrame(() => body.classList.add("is-active"));
    }

    // Title
    const titles = { hardware: "Hardware", tasks: "Tasks", outline: "Outline", library: "Library" };
    const title = document.getElementById("sidePanelTitle");
    if (title) title.textContent = titles[panel] || panel;

    if (panel === "library") {
        // Library is data-driven by the device catalog, not the editor AST
        import("./library.js").then(m => m.renderInto(body));
    } else if (panel === "hardware") {
        // Board + list, driven by the live source (hardware-panel.js), not
        // the AST — it follows keystrokes even on broken syntax.
        import("./hardware-panel.js").then(m => m.initSide(body));
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
    if (activePanel === "tasks") renderTasks(ast);
    else if (activePanel === "outline") renderOutline(ast);
    // Hardware intentionally NOT driven from the AST path — the editor's
    // onContentChange feeds hardware-panel.refresh with the live source;
    // a pin-only AST payload would make annotations flicker.
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
