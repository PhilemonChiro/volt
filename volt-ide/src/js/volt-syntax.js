/**
 * Volt language support for CodeMirror 6
 * Syntax highlighting using CodeMirror's streaming parser
 */

import { StreamLanguage } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";

// Volt keywords by category
const DECLARATIONS = new Set(["chip", "hardware", "task", "func", "machine", "struct", "main"]);
const STATE_KW = new Set(["state", "initial", "enter", "exit", "on", "after"]);
const CONTROL = new Set(["if", "else", "while", "for", "match", "return", "every", "strict"]);
const TYPES = new Set(["int", "float", "bool", "string", "void", "Output", "Input", "Analog", "PWM", "Touch"]);
const BUILTINS = new Set(["wifi", "mqtt", "http", "storage", "system", "ota", "log", "run", "sleep"]);
const CONSTANTS = new Set(["true", "false"]);
const VAR_KW = new Set(["let", "var", "pin", "sensor", "bus"]);

const voltLanguage = StreamLanguage.define({
    startState() {
        return { inComment: false, inString: false };
    },

    token(stream, state) {
        // Skip whitespace
        if (stream.eatSpace()) return null;

        // Line comment
        if (stream.match("//")) {
            stream.skipToEnd();
            return "lineComment";
        }

        // Strings
        if (stream.match('"')) {
            while (!stream.eol()) {
                if (stream.next() === '"') break;
            }
            return "string";
        }

        // Duration literals: 500ms, 1seconds, 10ms
        if (stream.match(/^\d+(?:ms|seconds|s)\b/)) {
            return "unit";
        }

        // Numbers (float must come before int)
        if (stream.match(/^\d+\.\d+/)) return "float";
        if (stream.match(/^0x[0-9a-fA-F]+/)) return "integer";
        if (stream.match(/^\d+/)) return "integer";

        // Transition arrow
        if (stream.match("->")) return "punctuation";

        // Operators
        if (stream.match(/^[+\-*/%=!<>&|^~]+/)) return "operator";

        // Words (identifiers and keywords)
        if (stream.match(/^[a-zA-Z_]\w*/)) {
            const word = stream.current();

            if (DECLARATIONS.has(word)) return "keyword";
            if (STATE_KW.has(word)) return "keyword";
            if (CONTROL.has(word)) return "keyword";
            if (TYPES.has(word)) return "typeName";
            if (BUILTINS.has(word)) return "variableName.special";
            if (CONSTANTS.has(word)) return "bool";
            if (VAR_KW.has(word)) return "definitionKeyword";

            // Check if next char is ( → function call
            if (stream.peek() === "(") return "function(callee)";

            // Check if next char is . → object
            if (stream.peek() === ".") return "variableName.special";

            return "variableName";
        }

        // Braces, brackets, parens
        if (stream.match(/^[{}()\[\]]/)) return "bracket";

        // Punctuation
        if (stream.match(/^[,:;.]/)) return "punctuation";

        // Skip unknown
        stream.next();
        return null;
    },

    languageData: {
        commentTokens: { line: "//" },
        closeBrackets: { brackets: ["(", "[", "{", '"'] },
    }
});

// Volt dark theme colors
const voltHighlight = HighlightStyle.define([
    { tag: t.keyword, color: "#c586c0" },           // purple — chip, task, machine
    { tag: t.definitionKeyword, color: "#569cd6" },  // blue — let, var, pin
    { tag: t.typeName, color: "#4ec9b0" },           // teal — int, Output, Analog
    { tag: t.string, color: "#ce9178" },             // brown — "strings"
    { tag: t.integer, color: "#b5cea8" },            // green — 42, 0xFF
    { tag: t.float, color: "#b5cea8" },              // green — 3.14
    { tag: t.bool, color: "#569cd6" },               // blue — true, false
    { tag: t.lineComment, color: "#6a9955" },        // green — // comments
    { tag: t.variableName, color: "#9cdcfe" },       // light blue — variables
    { tag: [t.special(t.variableName)], color: "#dcdcaa" }, // yellow — builtins, objects
    { tag: [t.function(t.variableName)], color: "#dcdcaa" }, // yellow — function calls
    { tag: t.operator, color: "#d4d4d4" },           // white — + - == !=
    { tag: t.bracket, color: "#ffd700" },             // gold — { } ( )
    { tag: t.punctuation, color: "#d4d4d4" },         // white — , : ; ->
    { tag: t.unit, color: "#ce9178" },                // brown — 500ms, 1seconds
]);

export { voltLanguage, voltHighlight, syntaxHighlighting };
