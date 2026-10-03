// Diagrams view — the full-area Code/Diagrams switcher and its System Map /
// State Machine sub-tabs. Rendering is done by bottom-panel.js (the shared
// mermaid + pan/zoom engine); this module owns the UI, gating, and auto-refresh.

import * as bp from "./bottom-panel.js";
import * as editor from "./editor.js";

let activeDiagram = "systemmap";
let diagramsVisible = false;

export function init() {
    // "Go to source" from a diagram node's click-menu: switch back to Code and
    // reveal the declaration line.
    document.addEventListener("volt:goto-source", (e) => {
        const line = e.detail && e.detail.line;
        showView("code");
        if (line) editor.gotoLine(line);
    });

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
    // Expand / collapse all loop bodies (System Map only).
    const eb = document.getElementById("dvExpandLoops");
    if (eb) eb.onclick = () => {
        bp.setLoopsExpanded(!bp.loopsAllExpanded());
        updateExpandBtn();
    };
    // Freeze / resume the edge animation (System Map only).
    const fb = document.getElementById("dvFreeze");
    if (fb) fb.onclick = () => {
        bp.setAnimationsFrozen(!bp.areAnimationsFrozen());
        updateFreezeBtn();
    };
    updateFreezeBtn();

    // Periodic auto-refresh — only acts when Diagrams is visible, and skips no-op
    // renders (bottom-panel caches by source), so it won't disturb pan/zoom.
    setInterval(() => refresh(false), 3000);
}

function updateExpandBtn() {
    const eb = document.getElementById("dvExpandLoops");
    if (!eb) return;
    eb.style.display = activeDiagram === "systemmap" ? "" : "none";
    eb.textContent = bp.loopsAllExpanded() ? "Collapse loops" : "Expand loops";
}

const FREEZE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
const RESUME_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polygon points="6 4 20 12 6 20 6 4"/></svg>';

function updateFreezeBtn() {
    const fb = document.getElementById("dvFreeze");
    if (!fb) return;
    fb.style.display = activeDiagram === "systemmap" ? "" : "none";
    const frozen = bp.areAnimationsFrozen();
    fb.classList.toggle("active", frozen);
    fb.innerHTML = (frozen ? RESUME_ICON : FREEZE_ICON) + `<span>${frozen ? "Resume" : "Freeze"}</span>`;
}

// view = "code" | "board" | "diagrams"
export function showView(view) {
    diagramsVisible = view === "diagrams";
    const editorArea = document.getElementById("editorArea");
    const diagramsView = document.getElementById("diagramsView");
    const boardView = document.getElementById("boardView");
    if (editorArea) editorArea.style.display = view === "code" ? "flex" : "none";
    if (diagramsView) diagramsView.style.display = diagramsVisible ? "flex" : "none";
    if (boardView) boardView.style.display = view === "board" ? "flex" : "none";
    document.dispatchEvent(new CustomEvent("volt:view", { detail: { view } }));
    document.querySelectorAll(".view-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.view === view));
    if (diagramsVisible) {
        updateExpandBtn();
        updateFreezeBtn();
        renderActive(true);
    } else if (typeof monaco !== "undefined") {
        // Editor was hidden while Diagrams showed — Monaco needs a relayout.
        monaco.editor.getEditors().forEach(e => e.layout());
    }
}

function showDiagram(name) {
    activeDiagram = name;
    document.getElementById("dgSystemMap").classList.toggle("active", name === "systemmap");
    document.getElementById("dgStateMachine").classList.toggle("active", name === "statemachine");
    document.querySelectorAll(".dv-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.dv === name));
    updateExpandBtn();
    updateFreezeBtn();
    renderActive(true);
}

function renderActive(force) {
    if (activeDiagram === "systemmap") bp.renderSystemMap(force);
    else bp.renderDiagram(force);
}

// Called from the compile hook and the auto-refresh interval.
export function refresh(force = false) {
    if (diagramsVisible) renderActive(force);
}

// Show the State Machine sub-tab only when the file defines a machine.
export function setMachinePresence(has) {
    const tab = document.querySelector('.dv-tab[data-dv="statemachine"]');
    if (!tab) return;
    tab.style.display = has ? "" : "none";
    if (!has && activeDiagram === "statemachine") showDiagram("systemmap");
}

// On project switch: clear diagrams and return to the Code view state (without
// forcing editorArea visibility — showEditor/showWelcome own that).
export function reset() {
    bp.resetDiagrams();
    diagramsVisible = false;
    activeDiagram = "systemmap";
    const dv = document.getElementById("diagramsView");
    if (dv) dv.style.display = "none";
    const bv = document.getElementById("boardView");
    if (bv) bv.style.display = "none";
    document.getElementById("dgSystemMap")?.classList.add("active");
    document.getElementById("dgStateMachine")?.classList.remove("active");
    document.querySelectorAll(".view-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.view === "code"));
    document.querySelectorAll(".dv-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.dv === "systemmap"));
}
