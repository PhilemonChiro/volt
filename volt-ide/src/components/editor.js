// Editor component — Monaco with Volt syntax highlighting

import * as langFeatures from "./language-features.js";
import * as settings from "../services/settings.js";

let editor = null;
let currentFile = null;
let unsavedChanges = false;

export function init(container, { onContentChange, onCursorChange }) {
    // Register Volt language
    monaco.languages.register({ id: "volt" });

    // Comment markers + bracket pairs — Monaco's commentLine action and
    // bracket matching rely on this. Without it Ctrl+/ does nothing.
    monaco.languages.setLanguageConfiguration("volt", {
        comments: { lineComment: "//", blockComment: ["/*", "*/"] },
        brackets: [["{","}"], ["[","]"], ["(",")"]],
        autoClosingPairs: [
            { open: "{", close: "}" },
            { open: "[", close: "]" },
            { open: "(", close: ")" },
            { open: '"', close: '"', notIn: ["string"] },
        ],
        surroundingPairs: [
            { open: "{", close: "}" },
            { open: "[", close: "]" },
            { open: "(", close: ")" },
            { open: '"', close: '"' },
        ],
    });

    monaco.languages.setMonarchTokensProvider("volt", {
        keywords: ["setup", "loop", "task", "machine", "state", "func", "return",
            "if", "else", "while", "for", "in", "match", "on", "every", "after",
            "var", "let", "storage", "channel", "shared", "enum", "hardware",
            "pin", "bus", "device", "include", "break", "continue", "or", "when",
            "become", "strict", "initial", "enter", "exit", "debounce", "throttle"],
        pin_modes: ["Output", "Input", "PullUpInput", "PullDownInput", "Analog", "PWM", "Servo", "DAC", "Touch"],
        builtins: ["wifi", "mqtt", "http", "system", "ota", "ble", "storage", "log", "sleep"],
        constants: ["true", "false", "HIGH", "LOW", "ON", "OFF",
            "linear", "ease_in", "ease_out", "ease_in_out", "ease_bounce", "ease_back", "ease_elastic",
            "skip", "restart", "retry"],
        types: ["int", "float", "bool", "string", "void", "Duration"],
        tokenizer: {
            root: [
                [/\/\/.*$/, "comment"],
                [/\/\*/, "comment", "@comment"],
                [/"[^"]*"/, "string"],
                [/\d+(\.\d+)?(us|ms|s|seconds?|sec|minutes?|min|hours?|hour|hr)/, "number.duration"],
                [/0x[0-9a-fA-F]+/, "number.hex"],
                [/0b[01]+/, "number.binary"],
                [/\d+\.\d+/, "number.float"],
                [/\d+/, "number"],
                [/[a-zA-Z_]\w*/, {
                    cases: {
                        "@keywords": "keyword",
                        "@pin_modes": "type.pin",
                        "@builtins": "variable.builtin",
                        "@constants": "constant",
                        "@types": "type",
                        "@default": "identifier",
                    },
                }],
                [/[{}()\[\]]/, "@brackets"],
                [/[+\-*/%&|^~<>=!]+/, "operator"],
                [/[,;:]/, "delimiter"],
                [/\./, "delimiter.dot"],
            ],
            comment: [
                [/\*\//, "comment", "@pop"],
                [/./, "comment"],
            ],
        },
    });

    // Volt dark theme — harmonized with the IDE's --bg-0..4 / --t1..3 palette
    monaco.editor.defineTheme("volt-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [
            { token: "keyword",          foreground: "C586C0" },
            { token: "type",             foreground: "4EC9B0" },
            { token: "type.pin",         foreground: "4EC9B0", fontStyle: "bold" },
            { token: "variable.builtin", foreground: "9CDCFE" },
            { token: "constant",         foreground: "569CD6" },
            { token: "string",           foreground: "CE9178" },
            { token: "number",           foreground: "B5CEA8" },
            { token: "number.duration",  foreground: "D7BA7D" },
            { token: "number.hex",       foreground: "B5CEA8" },
            { token: "number.float",     foreground: "B5CEA8" },
            { token: "comment",          foreground: "6A9955", fontStyle: "italic" },
            { token: "operator",         foreground: "D4D4D4" },
            { token: "delimiter.dot",    foreground: "D4D4D4" },
        ],
        colors: {
            // Surface — match --bg-0 (hsl 220 18% 7%)
            "editor.background":                  "#0F1116",
            "editor.foreground":                  "#EBEEF3",
            "editorGutter.background":            "#0F1116",

            // Line numbers — soft, brighter on current line
            "editorLineNumber.foreground":        "#3F4654",
            "editorLineNumber.activeForeground":  "#8C95A5",

            // Cursor
            "editorCursor.foreground":            "#2B7CB3",

            // Selection — volt-tinted
            "editor.selectionBackground":         "#2B7CB34D",
            "editor.selectionHighlightBackground":"#2B7CB322",
            "editor.inactiveSelectionBackground": "#2B7CB322",

            // Current line subtle highlight
            "editor.lineHighlightBackground":     "#FFFFFF08",
            "editor.lineHighlightBorder":         "#00000000",

            // Find/match
            "editor.findMatchBackground":         "#2B7CB366",
            "editor.findMatchHighlightBackground":"#2B7CB322",

            // Bracket match
            "editorBracketMatch.background":      "#2B7CB322",
            "editorBracketMatch.border":          "#3A8DC4",

            // Indent guides — barely-there
            "editorIndentGuide.background":       "#FFFFFF08",
            "editorIndentGuide.activeBackground": "#FFFFFF18",

            // Whitespace
            "editorWhitespace.foreground":        "#FFFFFF10",

            // Widgets (autocomplete, hover, signature)
            "editorWidget.background":            "#171A21",
            "editorWidget.border":                "#FFFFFF1A",
            "editorWidget.foreground":            "#EBEEF3",
            "editorSuggestWidget.background":     "#171A21",
            "editorSuggestWidget.border":         "#FFFFFF1A",
            "editorSuggestWidget.selectedBackground": "#2B7CB333",
            "editorSuggestWidget.highlightForeground": "#3A8DC4",
            "editorHoverWidget.background":       "#171A21",
            "editorHoverWidget.border":           "#FFFFFF1A",

            // Scrollbar
            "scrollbar.shadow":                   "#00000000",
            "scrollbarSlider.background":         "#FFFFFF14",
            "scrollbarSlider.hoverBackground":    "#FFFFFF24",
            "scrollbarSlider.activeBackground":   "#FFFFFF34",

            // Minimap (not enabled but in case)
            "minimap.background":                 "#0F1116",

            // Errors / warnings underline
            "editorError.foreground":             "#E55353",
            "editorWarning.foreground":           "#FFB81C",
            "editorInfo.foreground":              "#3A8DC4",
        },
    });

    // Register language features (autocomplete, hover, signatures)
    langFeatures.register();

    // Initial Monaco options sourced from settings (with defaults as fallback).
    editor = monaco.editor.create(container, {
        value: "",
        language: "volt",
        theme: "volt-dark",
        fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
        fontSize:        settings.get("editor.fontSize", 14),
        lineHeight:      settings.get("editor.lineHeight", 24),
        fontLigatures:   settings.get("editor.fontLigatures", true),
        tabSize:         settings.get("editor.tabSize", 4),
        renderWhitespace: settings.get("editor.renderWhitespace", "none"),
        cursorSmoothCaretAnimation:
            settings.get("editor.smoothCursor", true) ? "on" : "off",
        bracketPairColorization: {
            enabled: settings.get("editor.bracketPairs", true),
        },
        automaticLayout: true,
        minimap: { enabled: false },
        padding: { top: 12, bottom: 64 },   // room for the floating quick-add row
        scrollBeyondLastLine: false,
        cursorBlinking: "smooth",
        smoothScrolling: true,
        roundedSelection: true,
        renderLineHighlight: "all",
        renderLineHighlightOnlyWhenFocus: true,
        guides: {
            bracketPairs: false,
            indentation: true,
            highlightActiveIndentation: true,
        },
        scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
            useShadows: false,
        },
    });

    // Apply live setting changes that Monaco supports without re-creating.
    settings.onChange((key, value) => {
        if (!editor) return;
        if (key === "*" || key.startsWith("editor.")) {
            const v = (k, d) => settings.get(k, d);
            editor.updateOptions({
                fontSize:        v("editor.fontSize", 14),
                lineHeight:      v("editor.lineHeight", 24),
                fontLigatures:   v("editor.fontLigatures", true),
                renderWhitespace: v("editor.renderWhitespace", "none"),
                cursorSmoothCaretAnimation:
                    v("editor.smoothCursor", true) ? "on" : "off",
                bracketPairColorization: { enabled: v("editor.bracketPairs", true) },
            });
            // tabSize lives on the model, not the editor
            const model = editor.getModel();
            if (model) model.updateOptions({ tabSize: v("editor.tabSize", 4) });
        }
    });

    // Content change → diagnostics path (which also updates the side panels via
    // diagnostics.onResult → sidePanel.update). One getValue per change.
    editor.onDidChangeModelContent(() => {
        unsavedChanges = true;
        if (onContentChange) onContentChange(editor.getValue());
    });

    // Cursor position
    editor.onDidChangeCursorPosition((e) => {
        if (onCursorChange) onCursorChange(e.position.lineNumber, e.position.column);
    });

    // Ctrl+/ (Cmd+/ on Mac) — toggle line comment. Monaco binds this by
    // default; we re-register it explicitly so it survives keybinding
    // edits and works consistently across platforms.
    editor.addAction({
        id: "volt.toggle-line-comment",
        label: "Toggle Line Comment",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash],
        contextMenuGroupId: "edit",
        run: (ed) => ed.trigger("keyboard", "editor.action.commentLine", null),
    });
    // Ctrl+Shift+/ → block comment toggle (/* … */ around the selection)
    editor.addAction({
        id: "volt.toggle-block-comment",
        label: "Toggle Block Comment",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Slash],
        contextMenuGroupId: "edit",
        run: (ed) => ed.trigger("keyboard", "editor.action.blockComment", null),
    });

    editor.addAction({
        id: "volt.history.who",
        label: "Who Changed This Line?",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1,
        run: () => import("./history.js").then(m => m.whoChanged()),
    });

    return editor;
}

export function openFile(filePath, content) {
    if (!editor) return;
    currentFile = filePath;
    editor.setValue(content);
    unsavedChanges = false;
    editor.focus();
}

export function getValue() {
    return editor ? editor.getValue() : "";
}

export function getCurrentFile() {
    return currentFile;
}

export function isUnsaved() {
    return unsavedChanges;
}

// editSource says who is changing the buffer right now: "agent" (an AI
// edit), "outside" (reloaded from disk) or null (the user typing).
let editSource = null;
export function getEditSource() { return editSource; }
export function onContentChange(fn) { if (editor) editor.onDidChangeModelContent(() => fn(editSource)); }

export function markSaved() {
    unsavedChanges = false;
}

// replaceFromDisk swaps in the file's new content as one undoable edit.
export function replaceFromDisk(content) {
    if (!editor) return;
    const model = editor.getModel();
    editor.pushUndoStop();
    editSource = "outside";
    try { model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null); } finally { editSource = null; }
    editor.pushUndoStop();
    unsavedChanges = false;
}

export function focus() {
    if (editor) editor.focus();
}

// Reveal a 1-based line, place the cursor there, and briefly flash it — used by
// the diagram click-menu's "Go to source".
export function gotoLine(line) {
    if (!editor || !line || line < 1) return;
    const ln = line | 0;
    editor.revealLineInCenter(ln);
    editor.setPosition({ lineNumber: ln, column: 1 });
    editor.focus();
    const ids = editor.deltaDecorations([], [{
        range: new monaco.Range(ln, 1, ln, 1),
        options: { isWholeLine: true, className: "volt-line-flash" },
    }]);
    setTimeout(() => { if (editor) editor.deltaDecorations(ids, []); }, 1400);
}

// ---- AI agent edits and marks (src/agent.js) ----

let agentLineIds = [];

// applyAgentEdit replaces the buffer with text, or applies ranged edits
// ({start_line, start_col?, end_line?, end_col?, text}, 1-based), as one
// undo step. Returns the first line it touched.
export function applyAgentEdit({ text, edits }) {
    if (!editor) throw new Error("No file is open in the editor.");
    const model = editor.getModel();
    let ops;
    if (typeof text === "string") {
        ops = [{ range: model.getFullModelRange(), text }];
    } else {
        ops = (edits || []).map((e) => {
            const endLine = e.end_line || e.start_line;
            return {
                range: new monaco.Range(e.start_line, e.start_col || 1, endLine,
                    e.end_col || model.getLineMaxColumn(endLine)),
                text: e.text || "",
            };
        });
    }
    editor.pushUndoStop();
    editSource = "agent";
    try { editor.executeEdits("agent", ops); } finally { editSource = null; }
    editor.pushUndoStop();
    const first = ops.length ? Math.min(...ops.map(o => o.range.startLineNumber)) : 1;
    editor.revealLineInCenterIfOutsideViewport(first);
    return first;
}

export function undo() {
    if (editor) editor.trigger("agent", "undo", null);
}

// highlightLines marks 1-based lines until the next call (an empty list
// clears them); note shows on hover.
export function highlightLines(lines, note) {
    if (!editor) throw new Error("No file is open in the editor.");
    // Each line carries a text label, not just a colour.
    const model = editor.getModel();
    agentLineIds = editor.deltaDecorations(agentLineIds, (lines || []).map((ln, i) => ({
        range: new monaco.Range(ln, 1, ln, model.getLineMaxColumn(ln)),
        options: {
            isWholeLine: true,
            className: "volt-agent-line",
            hoverMessage: note ? { value: note } : undefined,
            overviewRuler: { color: "#3A8DC4", position: monaco.editor.OverviewRulerLane.Full },
            after: i === 0
                ? { content: "  \u2190 AI" + (note ? ": " + note : ""), inlineClassName: "volt-agent-note" }
                : undefined,
        },
    })));
    if (lines && lines.length) editor.revealLineInCenter(lines[0]);
}

export function getCursor() {
    if (!editor) return null;
    const p = editor.getPosition();
    const s = editor.getSelection();
    const cursor = p ? { line: p.lineNumber, col: p.column } : null;
    const selection = s && !s.isEmpty()
        ? { start_line: s.startLineNumber, start_col: s.startColumn, end_line: s.endLineNumber, end_col: s.endColumn,
            text: editor.getModel().getValueInRange(s) }
        : null;
    return { cursor, selection };
}

