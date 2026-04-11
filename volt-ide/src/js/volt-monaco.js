/**
 * Volt language definition for Monaco Editor
 */

export const VOLT_LANGUAGE_ID = "volt";

export function registerVoltLanguage(monaco) {
    // Register language
    monaco.languages.register({ id: VOLT_LANGUAGE_ID });

    // Syntax highlighting tokens
    monaco.languages.setMonarchTokensProvider(VOLT_LANGUAGE_ID, {
        keywords: ["chip", "hardware", "task", "func", "machine", "struct", "main",
                   "state", "initial", "enter", "exit", "on", "after",
                   "if", "else", "while", "for", "match", "return",
                   "every", "strict", "let", "var", "pin", "sensor", "bus", "run"],
        typeKeywords: ["int", "float", "bool", "string", "void",
                       "Output", "Input", "Analog", "PWM", "Touch"],
        builtins: ["wifi", "mqtt", "http", "storage", "system", "ota", "log",
                   "true", "false"],
        operators: ["=", "==", "!=", "<", ">", "<=", ">=", "+", "-", "*", "/", "%",
                    "&&", "||", "!", "->"],

        tokenizer: {
            root: [
                // Duration literals (before numbers)
                [/\d+(?:ms|seconds|s)\b/, "number.duration"],
                // Numbers
                [/0x[0-9a-fA-F]+/, "number.hex"],
                [/\d+\.\d+/, "number.float"],
                [/\d+/, "number"],
                // Strings
                [/"/, "string", "@string"],
                // Comments
                [/\/\/.*$/, "comment"],
                // Transition arrow
                [/->/, "operator.arrow"],
                // Identifiers and keywords
                [/[a-zA-Z_]\w*/, {
                    cases: {
                        "@keywords": "keyword",
                        "@typeKeywords": "type",
                        "@builtins": "variable.predefined",
                        "@default": "identifier",
                    },
                }],
                // Operators
                [/[{}()\[\]]/, "@brackets"],
                [/[=!<>+\-*/%&|]+/, "operator"],
                // Punctuation
                [/[;,.:]+/, "delimiter"],
            ],
            string: [
                [/[^"\\]+/, "string"],
                [/"/, "string", "@pop"],
            ],
        },
    });

    // Completions
    monaco.languages.registerCompletionItemProvider(VOLT_LANGUAGE_ID, {
        triggerCharacters: [".", " "],
        provideCompletionItems: (model, position) => {
            const textBefore = model.getValueInRange({
                startLineNumber: position.lineNumber,
                startColumn: 1,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
            });

            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endLineNumber: position.lineNumber,
                endColumn: word.endColumn,
            };

            // After "chip " → chip names
            if (/chip\s+$/.test(textBefore)) {
                return {
                    suggestions: ["esp32", "esp8266", "rp2040", "stm32f103"].map(c => ({
                        label: c, kind: monaco.languages.CompletionItemKind.Constant,
                        insertText: c, range,
                    })),
                };
            }

            // After "object." → methods
            const dotMatch = textBefore.match(/(\w+)\.\s*$/);
            if (dotMatch) {
                const obj = dotMatch[1];
                const methods = {
                    wifi: ["connect(ssid, pass)", "disconnect()", "is_connected()"],
                    mqtt: ["connect(url)", "send_int(topic, value)", "send(topic, payload)", "is_connected()"],
                    http: ["get(url)", "post(url, body)"],
                    storage: ["save(key, value)", "load(key)", "push(list, value)", "drain(list)", "list_count(list)"],
                    system: ["restart()", "free_heap()", "uptime()"],
                };
                const pinMethods = ["toggle()", "on()", "off()", "write(value)", "read()", "set_pwm(duty)"];
                const list = methods[obj] || pinMethods;
                return {
                    suggestions: list.map(m => ({
                        label: m, kind: monaco.languages.CompletionItemKind.Method,
                        insertText: m.replace(/\(.*\)/, "("), range,
                    })),
                };
            }

            // Default suggestions
            const keywords = [
                { label: "chip", kind: monaco.languages.CompletionItemKind.Keyword, insertText: "chip " },
                { label: "hardware", kind: monaco.languages.CompletionItemKind.Keyword, insertText: "hardware {\n    pin ${1:led}: ${2:Output} = ${3:2}\n}", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
                { label: "task", kind: monaco.languages.CompletionItemKind.Keyword, insertText: "task ${1:name}() {\n    every ${2:500ms} {\n        ${3}\n    }\n}", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
                { label: "func", kind: monaco.languages.CompletionItemKind.Keyword, insertText: "func ${1:name}(${2}) -> ${3:int} {\n    ${4}\n}", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
                { label: "machine", kind: monaco.languages.CompletionItemKind.Keyword, insertText: "machine ${1:Name} {\n    initial state ${2:idle} {\n        enter {\n            ${3}\n        }\n    }\n}", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
                { label: "main", kind: monaco.languages.CompletionItemKind.Keyword, insertText: "main {\n    ${1}\n}", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
                { label: "every", kind: monaco.languages.CompletionItemKind.Keyword, insertText: "every ${1:500ms} {\n    ${2}\n}", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
                { label: "wifi", kind: monaco.languages.CompletionItemKind.Variable, insertText: "wifi" },
                { label: "mqtt", kind: monaco.languages.CompletionItemKind.Variable, insertText: "mqtt" },
                { label: "storage", kind: monaco.languages.CompletionItemKind.Variable, insertText: "storage" },
                { label: "log", kind: monaco.languages.CompletionItemKind.Function, insertText: "log(\"${1:tag}\", \"${2:message}\")", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
                { label: "run", kind: monaco.languages.CompletionItemKind.Function, insertText: "run(${1})", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
            ];
            return { suggestions: keywords.map(k => ({ ...k, range })) };
        },
    });

    // Hover provider
    monaco.languages.registerHoverProvider(VOLT_LANGUAGE_ID, {
        provideHover: (model, position) => {
            const word = model.getWordAtPosition(position);
            if (!word) return null;

            const docs = {
                chip: "Declare the target microcontroller.\nSupported: esp32, esp8266, rp2040, stm32f103",
                hardware: "Define pin assignments.\nPins are validated against the chip's datasheet at compile time.",
                task: "Declare a concurrent task.\nAuto-classified: background (12B) / priority (4KB) / critical (ISR).",
                machine: "State machine with compile-time verification.\nChecks: reachability, dead states, determinism.",
                every: "Periodic execution block.\nDuration: 100ms, 500ms, 1seconds, etc.",
                strict: "Hardware timer ISR — exact timing.\nCannot call WiFi, MQTT, log, or blocking functions.",
                wifi: "WiFi module.\nMethods: connect(ssid, pass), disconnect(), is_connected()",
                mqtt: "MQTT module.\nMethods: connect(url), send_int(topic, val), is_connected()",
                storage: "Persistent storage.\nMethods: save(), load(), push(), drain(), list_count()",
                Output: "Digital output pin.\nMethods: on(), off(), toggle(), write(value)",
                Input: "Digital input pin.\nMethods: read() → 0 or 1",
                Analog: "Analog input (ADC).\nMethods: read() → 0-4095",
                PWM: "PWM output.\nMethods: set_pwm(0-255)",
                esp32: "ESP32 — Xtensa LX6 dual-core, 520KB RAM, WiFi + BT",
                esp8266: "ESP8266 — Xtensa LX106, 80KB RAM, WiFi",
                rp2040: "RP2040 — ARM Cortex-M0+ dual-core, 264KB RAM",
            };

            const doc = docs[word.word];
            if (!doc) return null;

            return {
                range: new monaco.Range(
                    position.lineNumber, word.startColumn,
                    position.lineNumber, word.endColumn
                ),
                contents: [
                    { value: `**${word.word}**` },
                    { value: doc },
                ],
            };
        },
    });
}

// Define Volt dark theme
export function defineVoltTheme(monaco) {
    monaco.editor.defineTheme("volt-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [
            { token: "keyword", foreground: "c586c0" },
            { token: "type", foreground: "4ec9b0" },
            { token: "variable.predefined", foreground: "dcdcaa" },
            { token: "string", foreground: "ce9178" },
            { token: "number", foreground: "b5cea8" },
            { token: "number.duration", foreground: "ce9178", fontStyle: "bold" },
            { token: "number.hex", foreground: "b5cea8" },
            { token: "number.float", foreground: "b5cea8" },
            { token: "comment", foreground: "6a9955" },
            { token: "operator", foreground: "d4d4d4" },
            { token: "operator.arrow", foreground: "569cd6", fontStyle: "bold" },
            { token: "delimiter", foreground: "d4d4d4" },
            { token: "identifier", foreground: "9cdcfe" },
        ],
        colors: {
            "editor.background": "#111318",
            "editor.foreground": "#d4d4d4",
            "editorCursor.foreground": "#5BA4D9",
            "editor.lineHighlightBackground": "#1a1d24",
            "editor.selectionBackground": "#264f7833",
            "editorLineNumber.foreground": "#454a55",
            "editorLineNumber.activeForeground": "#8a8f9a",
            "editorGutter.background": "#111318",
            "editorWidget.background": "#1e2128",
            "editorWidget.border": "#2a2e38",
            "editorHoverWidget.background": "#1e2128",
            "editorHoverWidget.border": "#2a2e38",
            "editorSuggestWidget.background": "#1e2128",
            "editorSuggestWidget.border": "#2a2e38",
            "editorSuggestWidget.selectedBackground": "#2B7CB333",
        },
    });
}
