/**
 * Volt real-time diagnostics for CodeMirror 6
 * Runs the compiler on debounced changes, shows errors inline
 */

import { linter } from "@codemirror/lint";

let checkTimer = null;

export const voltLinter = linter(async (view) => {
    const code = view.state.doc.toString();
    if (code.trim().length < 10) return [];

    try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke("check_code", { source: code });

        // result is array of { line, col, message, severity, hint }
        return result.map(err => {
            const line = view.state.doc.line(Math.min(err.line, view.state.doc.lines));
            const from = line.from + Math.max(0, (err.col || 1) - 1);
            const to = Math.min(from + 20, line.to); // underline ~20 chars

            return {
                from,
                to,
                severity: err.severity === "error" ? "error" : "warning",
                message: err.message + (err.hint ? "\n→ " + err.hint : ""),
            };
        });
    } catch (e) {
        // Not in Tauri or check failed
        return [];
    }
}, {
    delay: 800, // debounce 800ms after typing stops
});
