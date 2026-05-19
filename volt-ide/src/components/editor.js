// Editor component — Monaco with Volt syntax highlighting

import * as astStore from "../services/ast-store.js";
import * as langFeatures from "./language-features.js";

let editor = null;
let currentFile = null;
let unsavedChanges = false;

export function init(container, { onContentChange, onCursorChange }) {
    // Register Volt language
    monaco.languages.register({ id: "volt" });

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

    editor = monaco.editor.create(container, {
        value: "",
        language: "volt",
        theme: "volt-dark",
        fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
        fontSize: 14,
        lineHeight: 24,
        fontLigatures: true,
        automaticLayout: true,
        minimap: { enabled: false },
        padding: { top: 12, bottom: 12 },
        scrollBeyondLastLine: false,
        renderWhitespace: "none",
        tabSize: 4,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        smoothScrolling: true,
        roundedSelection: true,
        renderLineHighlight: "all",
        renderLineHighlightOnlyWhenFocus: true,
        bracketPairColorization: { enabled: true },
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

    // Content change → diagnostics + AST update
    editor.onDidChangeModelContent(() => {
        unsavedChanges = true;
        if (onContentChange) onContentChange(editor.getValue());
        astStore.scheduleCompile(editor.getValue());
    });

    // Cursor position
    editor.onDidChangeCursorPosition((e) => {
        if (onCursorChange) onCursorChange(e.position.lineNumber, e.position.column);
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

export function markSaved() {
    unsavedChanges = false;
}

export function focus() {
    if (editor) editor.focus();
}
