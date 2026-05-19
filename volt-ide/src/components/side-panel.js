// Side panel — Hardware, Tasks, Outline views (VS Code style)
// Activity bar icons on right edge toggle panels open/closed.
// Panels update live from compiler AST as user types.

let activePanel = null;
let lastAST = null;

export function init() {
    const ids = ["toggleHardware", "toggleTasks", "toggleOutline"];
    const panels = ["hardware", "tasks", "outline"];

    ids.forEach((id, i) => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                toggle(panels[i]);
            });
        }
    });
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

    // Show side panel
    const side = document.getElementById("sidePanel");
    if (side) side.style.display = "flex";

    // Highlight active button in activity bar
    document.querySelectorAll(".activity-btn").forEach(b => b.classList.remove("active"));
    const btnMap = { hardware: "toggleHardware", tasks: "toggleTasks", outline: "toggleOutline" };
    const btn = document.getElementById(btnMap[panel]);
    if (btn) btn.classList.add("active");

    // Show correct body, hide others
    ["panelHardware", "panelTasks", "panelOutline"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = "none";
    });
    const bodyMap = { hardware: "panelHardware", tasks: "panelTasks", outline: "panelOutline" };
    const body = document.getElementById(bodyMap[panel]);
    if (body) body.style.display = "";

    // Title
    const titles = { hardware: "Hardware", tasks: "Tasks", outline: "Outline" };
    const title = document.getElementById("sidePanelTitle");
    if (title) title.textContent = titles[panel] || panel;

    // Render with last known AST
    if (lastAST) render(lastAST);

    // Tell Monaco to relayout (editor width changed)
    relayoutEditor();
}

export function close() {
    activePanel = null;
    const side = document.getElementById("sidePanel");
    if (side) side.style.display = "none";
    document.querySelectorAll(".activity-btn").forEach(b => b.classList.remove("active"));
    relayoutEditor();
}

function relayoutEditor() {
    requestAnimationFrame(() => {
        if (typeof monaco !== "undefined") {
            const editors = monaco.editor.getEditors();
            if (editors.length > 0) editors[0].layout();
        }
    });
}

// Called when compiler produces new AST data
export function update(ast) {
    if (!ast) return;  // Skip null/undefined AST (e.g. compile failed)
    lastAST = ast;
    if (activePanel) render(ast);
}

function render(ast) {
    if (!ast) return;
    if (activePanel === "hardware") renderHardware(ast);
    else if (activePanel === "tasks") renderTasks(ast);
    else if (activePanel === "outline") renderOutline(ast);
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
        el.innerHTML = '<div class="panel-empty">No hardware declared.<br>Add a <code>hardware { }</code> block.</div>';
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
        el.innerHTML = '<div class="panel-empty">No tasks or machines.<br>Add a <code>task</code> block.</div>';
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
                html += `<div class="hw-item" style="padding-left:24px">
                    <span class="hw-icon">S</span>
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
        el.innerHTML = '<div class="panel-empty">No symbols found.</div>';
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
