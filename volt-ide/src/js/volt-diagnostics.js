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

        if (!result || !Array.isArray(result)) return [];

        // Update problems count badge
        const errorCount = result.filter(e => e.severity === "error").length;
        const badge = document.getElementById("problemCount");
        if (badge) {
            if (errorCount > 0) {
                badge.textContent = errorCount;
                badge.style.display = "inline";
            } else {
                badge.style.display = "none";
            }
        }

        return result.map(err => {
            const lineNum = Math.min(Math.max(err.line, 1), view.state.doc.lines);
            const line = view.state.doc.line(lineNum);
            const col = Math.max(0, (err.col || 1) - 1);
            const from = line.from + Math.min(col, line.length);
            const to = Math.min(from + 20, line.to);

            return {
                from,
                to: Math.max(from + 1, to),
                severity: err.severity === "error" ? "error" : "warning",
                message: err.message + (err.hint ? "\n→ " + err.hint : ""),
            };
        });
    } catch (e) {
        return [];
    }
}, {
    delay: 1000,
});
