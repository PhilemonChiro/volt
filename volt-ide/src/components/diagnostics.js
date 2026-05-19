// Diagnostics — red squiggles + problems from compiler errors

import * as settings from "../services/settings.js";

let timer = null;
let onResultCallback = null;

export function scheduleCheck(source) {
    clearTimeout(timer);
    const delay = settings.get("diagnostics.debounceMs", 250);
    timer = setTimeout(() => runCheck(source), delay);
}

export function onResult(callback) {
    onResultCallback = callback;
}

async function runCheck(source) {
    try {
        const result = await window.volt.compileFull(source);
        const allDiags = result.diagnostics || [];
        // Honor "show warnings" / "show info" settings; errors are always shown
        const showWarn = settings.get("diagnostics.showWarnings", true);
        const showInfo = settings.get("diagnostics.showInfo", true);
        const diags = allDiags.filter(d =>
            d.severity === "error" ||
            (d.severity === "warning" && showWarn) ||
            (d.severity === "info" && showInfo)
        );
        applyMarkers(diags);
        if (onResultCallback) onResultCallback(diags, result);
    } catch (e) {
        console.warn("[diagnostics] check failed:", e);
    }
}

function applyMarkers(diags) {
    const model = monaco.editor.getModels()[0];
    if (!model) return;

    const markers = diags.map(d => {
        const sev = d.severity === "error" ? monaco.MarkerSeverity.Error
            : d.severity === "warning" ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info;

        let msg = d.message;
        if (d.hint) msg += "\n\nHint: " + d.hint;

        let startCol = d.col || 1;
        let endCol = startCol + 1;
        try {
            const line = model.getLineContent(d.line || 1);
            let s = startCol - 1;
            let e = startCol - 1;
            while (s > 0 && /\w/.test(line[s - 1])) s--;
            while (e < line.length && /\w/.test(line[e])) e++;
            if (e > s) { startCol = s + 1; endCol = e + 1; }
        } catch (_) {}

        return {
            severity: sev,
            startLineNumber: d.line || 1,
            startColumn: startCol,
            endLineNumber: d.line || 1,
            endColumn: endCol,
            message: msg,
        };
    });

    monaco.editor.setModelMarkers(model, "volt", markers);
}
