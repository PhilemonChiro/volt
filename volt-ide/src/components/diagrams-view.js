// Diagrams view — the full-area Code/Diagrams switcher and its State Machine /
// Sequence sub-tabs. Rendering is done by bottom-panel.js (the shared
// mermaid + pan/zoom engine); this module owns the UI, gating, and auto-refresh.

import * as bp from "./bottom-panel.js";
import * as editor from "./editor.js";

let activeDiagram = "statemachine";
let diagramsVisible = false;

export function init() {
    // Top-level Code / Diagrams view tabs
    document.querySelectorAll(".view-tab").forEach(t => {
        t.onclick = () => showView(t.dataset.view);
    });
    // Diagram sub-tabs
    document.querySelectorAll(".dv-tab").forEach(t => {
        t.onclick = () => showDiagram(t.dataset.dv);
    });
    // Refresh (with a brief spin so the click registers)
    const rb = document.getElementById("dvRefresh");
    if (rb) rb.onclick = function() {
        const svg = this.querySelector("svg");
        if (svg) {
            svg.style.transition = "transform 400ms var(--ease-out)";
            svg.style.transform = "rotate(360deg)";
            setTimeout(() => { svg.style.transition = ""; svg.style.transform = ""; }, 420);
        }
        renderActive(true);
    };
    // Periodic auto-refresh — only acts when Diagrams is visible, and skips no-op
    // renders (bottom-panel caches by source), so it won't disturb pan/zoom.
    setInterval(() => refresh(false), 3000);
}

// placeBottomPanel puts the Output panel under the editor in the Code view, so
// the side panel beside it runs the full height (as in Cursor); the Board and
// Diagrams views keep it full width at the bottom of the window.
export function placeBottomPanel(view) {
    const bp = document.getElementById("bottomPanel");
    const main = document.querySelector("#editorArea .workspace-main");
    if (!bp || !main) return;
    const home = view === "code" ? main : document.getElementById("statusBar").parentElement;
    if (bp.parentElement === home) return;
    bp.style.animation = "none"; // moving it must not replay its entrance
    if (view === "code") main.appendChild(bp);
    else home.insertBefore(bp, document.getElementById("statusBar"));
}

// view = "code" | "board" | "diagrams"
export function showView(view) {
    // No project open (welcome page showing): nothing to switch to.
    const welcome = document.getElementById("welcome");
    if (welcome && getComputedStyle(welcome).display !== "none") return;
    diagramsVisible = view === "diagrams";
    const editorArea = document.getElementById("editorArea");
    const diagramsView = document.getElementById("diagramsView");
    const boardView = document.getElementById("boardView");
    if (editorArea) editorArea.style.display = view === "code" ? "flex" : "none";
    if (diagramsView) diagramsView.style.display = diagramsVisible ? "flex" : "none";
    if (boardView) boardView.style.display = view === "board" ? "flex" : "none";
    placeBottomPanel(view);
    document.dispatchEvent(new CustomEvent("volt:view", { detail: { view } }));
    document.querySelectorAll(".view-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.view === view));
    if (diagramsVisible) {
        renderActive(true);
    } else if (typeof monaco !== "undefined") {
        // Editor was hidden while Diagrams showed — Monaco needs a relayout.
        monaco.editor.getEditors().forEach(e => e.layout());
    }
}

export function showDiagram(name) {
    activeDiagram = name;
    document.getElementById("dgStateMachine").classList.toggle("active", name === "statemachine");
    document.getElementById("dgSequence").classList.toggle("active", name === "sequence");
    document.querySelectorAll(".dv-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.dv === name));
    renderActive(true);
}

function renderActive(force) {
    if (activeDiagram === "sequence") bp.renderSequence(force);
    else bp.renderDiagram(force);
}

// Called from the compile hook and the auto-refresh interval.
export function refresh(force = false) {
    if (diagramsVisible) renderActive(force);
}

// Show the State Machine sub-tab only when the file defines a machine; without
// one, Sequence is the diagram.
export function setMachinePresence(has) {
    const tab = document.querySelector('.dv-tab[data-dv="statemachine"]');
    if (!tab) return;
    tab.style.display = has ? "" : "none";
    if (!has && activeDiagram === "statemachine") showDiagram("sequence");
}

// On project switch: clear diagrams and return to the Code view state (without
// forcing editorArea visibility — showEditor/showWelcome own that).
export function reset() {
    bp.resetDiagrams();
    diagramsVisible = false;
    activeDiagram = "statemachine";
    const dv = document.getElementById("diagramsView");
    if (dv) dv.style.display = "none";
    const bv = document.getElementById("boardView");
    if (bv) bv.style.display = "none";
    document.getElementById("dgStateMachine")?.classList.add("active");
    document.getElementById("dgSequence")?.classList.remove("active");
    document.querySelectorAll(".view-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.view === "code"));
    document.querySelectorAll(".dv-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.dv === "statemachine"));
}
