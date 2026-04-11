/**
 * Volt real-time diagnostics for CodeMirror 6
 * Two systems:
 * 1. CM linter API → gutter dots + diagnostic popups
 * 2. Custom line decorations → visible error line highlighting
 */

import { linter } from "@codemirror/lint";
import { EditorView, Decoration } from "@codemirror/view";
import { StateEffect, StateField, RangeSet } from "@codemirror/state";

// ---- Effect to set error lines ----
const setErrorLines = StateEffect.define();

const errorLineField = StateField.define({
    create() { return Decoration.none; },
    update(decorations, tr) {
        for (const e of tr.effects) {
            if (e.is(setErrorLines)) {
                return e.value;
            }
        }
        return decorations;
    },
    provide: f => EditorView.decorations.from(f),
});

const errorLineDeco = Decoration.line({ class: "cm-errorLine" });
const warnLineDeco = Decoration.line({ class: "cm-warnLine" });

export { errorLineField };

// ---- Linter (provides gutter dots + popups + drives line highlighting) ----
export const voltLinter = linter(async (view) => {
    const code = view.state.doc.toString();
    if (code.trim().length < 10) {
        view.dispatch({ effects: setErrorLines.of(Decoration.none) });
        return [];
    }

    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke("check_code", { source: code });

        if (!result || !Array.isArray(result)) {
            view.dispatch({ effects: setErrorLines.of(Decoration.none) });
            return [];
        }

        // Update problems badge
        const errorCount = result.filter(e => e.severity === "error").length;
        const warnCount = result.filter(e => e.severity === "warning").length;
        const badge = document.getElementById("problemCount");
        if (badge) {
            const total = errorCount + warnCount;
            if (total > 0) {
                badge.textContent = total;
                badge.style.display = "inline";
            } else {
                badge.style.display = "none";
            }
        }

        // Build line decorations
        const lineDecos = [];
        for (const err of result) {
            const lineNum = Math.min(Math.max(err.line, 1), view.state.doc.lines);
            const line = view.state.doc.line(lineNum);
            const deco = err.severity === "error" ? errorLineDeco : warnLineDeco;
            lineDecos.push(deco.range(line.from));
        }
        const decoSet = lineDecos.length > 0
            ? RangeSet.of(lineDecos, true)
            : Decoration.none;
        view.dispatch({ effects: setErrorLines.of(decoSet) });

        // Return diagnostics for CM (gutter dots + popups)
        return result.map(err => {
            const lineNum = Math.min(Math.max(err.line, 1), view.state.doc.lines);
            const line = view.state.doc.line(lineNum);
            const trimStart = line.text.search(/\S/);
            const from = line.from + (trimStart >= 0 ? trimStart : 0);
            const to = line.to;

            return {
                from,
                to: Math.max(from + 1, to),
                severity: err.severity === "error" ? "error" : "warning",
                message: err.message + (err.hint ? "\n→ " + err.hint : ""),
            };
        });
    } catch (e) {
        view.dispatch({ effects: setErrorLines.of(Decoration.none) });
        return [];
    }
}, {
    delay: 1000,
});
