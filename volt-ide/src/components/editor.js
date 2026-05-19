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

    // Dark theme
    monaco.editor.defineTheme("volt-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [
            { token: "keyword", foreground: "C586C0" },
            { token: "type", foreground: "4EC9B0" },
            { token: "type.pin", foreground: "4EC9B0", fontStyle: "bold" },
            { token: "variable.builtin", foreground: "9CDCFE" },
            { token: "constant", foreground: "569CD6" },
            { token: "string", foreground: "CE9178" },
            { token: "number", foreground: "B5CEA8" },
            { token: "number.duration", foreground: "D7BA7D" },
            { token: "number.hex", foreground: "B5CEA8" },
            { token: "number.float", foreground: "B5CEA8" },
            { token: "comment", foreground: "6A9955" },
            { token: "operator", foreground: "D4D4D4" },
            { token: "delimiter.dot", foreground: "D4D4D4" },
        ],
        colors: {
            "editor.background": "#12141a",
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
        automaticLayout: true,
        minimap: { enabled: false },
        padding: { top: 8 },
        scrollBeyondLastLine: false,
        renderWhitespace: "none",
        tabSize: 4,
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
