// Side panel — Hardware, Outline, Library views (VS Code style)
// Activity bar icons on right edge toggle panels open/closed.
// Panels update live from compiler AST as user types.

import { outline } from "./outline.js";

let activePanel = null;
let lastAST = null;

export function init() {
    const ids = ["toggleHardware", "toggleOutline", "toggleLibrary", "toggleHistory", "toggleAssistant"];
    const panels = ["hardware", "outline", "library", "history", "assistant"];

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
    if (panel === "library") return open(panel); // a dialog, not a panel
    if (activePanel === panel) {
        close();
    } else {
        open(panel);
    }
}

export function open(panel) {
    // The Library is a full dialog now (library-view.js), not a side panel.
    if (panel === "library") { import("./library-view.js").then(m => m.openLibrary()); return; }
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
    const btnMap = { hardware: "toggleHardware", outline: "toggleOutline", library: "toggleLibrary", history: "toggleHistory", assistant: "toggleAssistant" };
    const btn = document.getElementById(btnMap[panel]);
    if (btn) btn.classList.add("active");

    // Swap visible body — fade-in via .is-active class (CSS keyframe)
    ["panelHardware", "panelOutline", "panelLibrary", "panelHistory", "panelAssistant"].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.style.display = "none"; el.classList.remove("is-active"); }
    });
    const bodyMap = {
        hardware: "panelHardware",
        outline:  "panelOutline",
        library:  "panelLibrary",
        history: "panelHistory",
        assistant: "panelAssistant",
    };
    const body = document.getElementById(bodyMap[panel]);
    if (body) {
        body.style.display = "";
        // Re-add the class on the next frame so the keyframe restarts
        requestAnimationFrame(() => body.classList.add("is-active"));
    }

    // Title
    const titles = { hardware: "Hardware", outline: "Outline", library: "Library", history: "History", assistant: "Assistant" };
    const title = document.getElementById("sidePanelTitle");
    if (title) title.textContent = titles[panel] || panel;

    if (panel === "assistant") {
        import("./assistant-panel.js").then(m => m.renderInto(body));
    } else if (panel === "history") {
        import("./history.js").then(m => m.renderInto(body));
    } else if (panel === "library") {
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

/** refresh(panel) — redraw panel if it is the open one (e.g. the project changed). */
export function refresh(panel) {
    if (activePanel === panel) open(panel);
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
    if (activePanel === "outline") renderOutline();
    // Hardware intentionally NOT driven from the AST path — the editor's
    // onContentChange feeds hardware-panel.refresh with the live source;
    // a pin-only AST payload would make annotations flicker.
}

// ============================================================
// Outline panel — what runs, the data it keeps, functions. Read from the
// live source (outline.js) so it follows every keystroke.
// ============================================================

let _outlineHooked = false, _outlineTimer = 0;

function editorNow() {
    return typeof monaco !== "undefined" ? monaco.editor.getEditors()[0] : null;
}

function renderOutline() {
    const el = document.getElementById("panelOutline");
    const ed = editorNow();
    if (!el) return;
    if (ed && !_outlineHooked) {
        _outlineHooked = true;
        const again = () => {
            clearTimeout(_outlineTimer);
            _outlineTimer = setTimeout(() => { if (activePanel === "outline") renderOutline(); }, 150);
        };
        ed.onDidChangeModelContent(again);
        ed.onDidChangeModel(again);
    }
    const { runs, data, funcs } = outline(ed && ed.getModel() ? ed.getModel().getValue() : "");

    if (!runs.length && !data.length && !funcs.length) {
        el.innerHTML = `<div class="panel-empty">
            <svg class="empty-illustration" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            <div class="empty-title">Nothing to outline yet</div>
            <div class="empty-hint">Add <code>setup</code>, <code>every</code>, a <code>task</code> or a <code>func</code> — they show up here.</div>
        </div>`;
        return;
    }

    // Task tiers come from the compiler when it has run.
    const tiers = Object.fromEntries(((lastAST && lastAST.tasks) || []).map(t => [t.name, t.tier]));
    const ICON = { setup: ["S", "task"], loop: ["L", "task"], every: ["E", "task"], task: ["T", "task"], on: ["O", "task"],
        machine: ["M", "machine"], var: ["V", "var"], shared: ["V", "var"], storage: ["D", "var"], channel: ["C", "var"],
        struct: ["S", "enum"], enum: ["E", "enum"], func: ["ƒ", "fn"] };
    const row = (kind, name, detail, line, badge) => {
        const [icon, cls] = ICON[kind] || ["·", "var"];
        return `<div class="outline-item" data-line="${line}">
            <span class="outline-icon ${cls}">${icon}</span>
            <span class="outline-name">${esc(name)}</span>
            ${badge ? `<span class="task-tier ${esc(badge)}">${esc(badge)}</span>` : ""}
            <span class="outline-detail">${esc(detail || "")}</span>
        </div>`;
    };
    const section = (title, items) => items.length
        ? `<div class="hw-section"><div class="hw-section-title hwl-title">${title}<span class="hwl-count">${items.length}</span></div>${items.join("")}</div>` : "";

    el.innerHTML =
        section("Runs", runs.map(r => {
            const tier = r.kind === "task" && tiers[r.name] && tiers[r.name] !== "background" ? tiers[r.name] : "";
            return row(r.kind, r.name, r.detail, r.line, tier) + r.children.map(c =>
                `<div class="outline-item is-nested" data-line="${c.line}"><span class="outline-name">${esc(c.name)}</span></div>`).join("");
        })) +
        section("Data", data.map(d => row(d.kind, d.name, d.detail, d.line))) +
        section("Functions", funcs.map(f => row("func", f.name, f.detail, f.line)));
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

