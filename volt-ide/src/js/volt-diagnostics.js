/**
 * Volt diagnostics — custom implementation, no CM lint API
 * Shows: red line highlight + inline error message + gutter dot
 */

import { EditorView, Decoration, gutter, GutterMarker } from "@codemirror/view";
import { StateEffect, StateField, RangeSet } from "@codemirror/state";

// ---- State effects ----
const setDiagnostics = StateEffect.define();

// ---- Error line decoration ----
const errorLineDeco = Decoration.line({ class: "volt-error-line" });
const warnLineDeco = Decoration.line({ class: "volt-warn-line" });

// ---- Inline error message widget ----
class ErrorWidget {
    constructor(message, severity) {
        this.message = message;
        this.severity = severity;
    }
    eq(other) { return this.message === other.message; }
    toDOM() {
        const el = document.createElement("div");
        el.className = `volt-inline-error ${this.severity === "error" ? "volt-inline-error-red" : "volt-inline-error-yellow"}`;
        el.textContent = this.message;
        return el;
    }
}

// ---- Gutter marker ----
class ErrorMarker extends GutterMarker {
    constructor(severity) { super(); this.severity = severity; }
    toDOM() {
        const dot = document.createElement("div");
        dot.className = this.severity === "error" ? "volt-gutter-error" : "volt-gutter-warn";
        return dot;
    }
}
const errorMarker = new ErrorMarker("error");
const warnMarker = new ErrorMarker("warning");

// ---- State field for decorations ----
const diagnosticField = StateField.define({
    create() { return { lines: Decoration.none, widgets: Decoration.none, gutters: [] }; },
    update(state, tr) {
        for (const e of tr.effects) {
            if (e.is(setDiagnostics)) return e.value;
        }
        return state;
    },
});

// Line decorations provider
const lineDecorations = EditorView.decorations.from(diagnosticField, s => s.lines);
// Widget decorations provider
const widgetDecorations = EditorView.decorations.from(diagnosticField, s => s.widgets);

// Gutter
const diagnosticGutter = gutter({
    class: "volt-diagnostic-gutter",
    markers: view => {
        const state = view.state.field(diagnosticField, false);
        if (!state || !state.gutters.length) return RangeSet.empty;
        return RangeSet.of(state.gutters, true);
    },
});

export const voltDiagnosticExtensions = [
    diagnosticField,
    lineDecorations,
    widgetDecorations,
    diagnosticGutter,
];

// ---- Run diagnostics ----
let diagTimer = null;

export function setupDiagnostics(editorView) {
    // Run on changes, debounced
    editorView.dom.addEventListener("keyup", () => {
        clearTimeout(diagTimer);
        diagTimer = setTimeout(() => runCheck(editorView), 1200);
    });
    // Initial check
    setTimeout(() => runCheck(editorView), 2000);
}

async function runCheck(view) {
    const code = view.state.doc.toString();
    if (code.trim().length < 10) {
        clearDiagnostics(view);
        return;
    }

    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke("check_code", { source: code });

        if (!result || !Array.isArray(result) || result.length === 0) {
            clearDiagnostics(view);
            return;
        }

        const lineDecos = [];
        const widgetDecos = [];
        const gutterMarkers = [];

        for (const err of result) {
            const lineNum = Math.min(Math.max(err.line, 1), view.state.doc.lines);
            const line = view.state.doc.line(lineNum);

            // Line highlight
            const deco = err.severity === "error" ? errorLineDeco : warnLineDeco;
            lineDecos.push(deco.range(line.from));

            // Inline error message below the line
            const widget = Decoration.widget({
                widget: new ErrorWidget(err.message, err.severity),
                block: true,
            });
            widgetDecos.push(widget.range(line.to));

            // Gutter marker
            const marker = err.severity === "error" ? errorMarker : warnMarker;
            gutterMarkers.push(marker.range(line.from));
        }

        // Update badge
        const badge = document.getElementById("problemCount");
        if (badge) {
            badge.textContent = result.length;
            badge.style.display = "inline";
        }

        view.dispatch({
            effects: setDiagnostics.of({
                lines: RangeSet.of(lineDecos, true),
                widgets: RangeSet.of(widgetDecos, true),
                gutters: gutterMarkers,
            }),
        });
    } catch (e) {
        clearDiagnostics(view);
    }
}

function clearDiagnostics(view) {
    const badge = document.getElementById("problemCount");
    if (badge) badge.style.display = "none";

    view.dispatch({
        effects: setDiagnostics.of({
            lines: Decoration.none,
            widgets: Decoration.none,
            gutters: [],
        }),
    });
}
