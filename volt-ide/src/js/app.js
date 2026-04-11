/**
 * Volt IDE — Main Application
 * Phase 1: Editor with Volt syntax highlighting
 */

import { EditorView, keymap, lineNumbers, highlightActiveLine,
         highlightActiveLineGutter, drawSelection, rectangularSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { voltLanguage, voltHighlight, syntaxHighlighting } from "./volt-syntax.js";

// ---- Dark theme for the editor chrome ----
const voltTheme = EditorView.theme({
    "&": {
        backgroundColor: "hsl(230, 10%, 13%)",
        color: "hsl(220, 15%, 88%)",
    },
    ".cm-content": {
        caretColor: "#e0c070",
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
        fontSize: "14px",
        lineHeight: "1.65",
        padding: "8px 0",
    },
    ".cm-cursor": {
        borderLeftColor: "#e0c070",
        borderLeftWidth: "2px",
    },
    ".cm-activeLine": { backgroundColor: "hsla(230, 8%, 20%, 0.5)" },
    ".cm-activeLineGutter": { backgroundColor: "hsla(230, 8%, 20%, 0.5)" },
    ".cm-gutters": {
        backgroundColor: "hsl(230, 10%, 13%)",
        color: "hsl(220, 6%, 35%)",
        border: "none",
        paddingRight: "12px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "3em",
        textAlign: "right",
        padding: "0 4px",
    },
    ".cm-foldGutter": { width: "14px" },
    ".cm-selectionBackground": { backgroundColor: "hsla(45, 60%, 40%, 0.2) !important" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "hsla(45, 60%, 40%, 0.25) !important" },
    ".cm-matchingBracket": {
        backgroundColor: "hsla(45, 60%, 50%, 0.15)",
        outline: "1px solid hsla(45, 60%, 50%, 0.3)",
    },
    ".cm-searchMatch": { backgroundColor: "hsla(45, 60%, 50%, 0.2)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "hsla(45, 80%, 50%, 0.3)" },
    ".cm-selectionMatch": { backgroundColor: "hsla(152, 60%, 40%, 0.15)" },
}, { dark: true });

// ---- Default Volt code ----
const DEFAULT_CODE = `chip esp32

hardware {
    pin led: Output = 2
}

task blink() {
    every 500ms {
        led.toggle()
    }
}

main {
    run(blink)
}
`;

// ---- Create editor ----
const container = document.getElementById("editorContainer");

const state = EditorState.create({
    doc: DEFAULT_CODE,
    extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        foldGutter(),
        drawSelection(),
        rectangularSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...closeBracketsKeymap,
            ...searchKeymap,
            indentWithTab,
        ]),
        voltLanguage,
        syntaxHighlighting(voltHighlight),
        voltTheme,
        // Update cursor position in status bar
        EditorView.updateListener.of(update => {
            if (update.selectionSet) {
                const pos = update.state.selection.main.head;
                const line = update.state.doc.lineAt(pos);
                const col = pos - line.from + 1;
                document.getElementById("statusLine").textContent =
                    `Ln ${line.number}, Col ${col}`;
            }
        }),
    ],
});

const editor = new EditorView({
    state,
    parent: container,
});

// ---- Sidebar buttons (Phase 1: visual only) ----
document.getElementById("buildBtn").addEventListener("click", () => {
    document.getElementById("statusBuild").textContent = "Building...";
    // Phase 3: will call Tauri backend
    setTimeout(() => {
        document.getElementById("statusBuild").textContent = "✓ Built";
    }, 500);
});

document.getElementById("flashBtn").addEventListener("click", () => {
    document.getElementById("statusBuild").textContent = "Flashing...";
});

document.getElementById("monitorBtn").addEventListener("click", () => {
    const dot = document.getElementById("monitorDot");
    const status = document.getElementById("monitorStatus");
    if (dot.classList.contains("dot-on")) {
        dot.className = "dot dot-off";
        status.textContent = "Disconnected";
    } else {
        dot.className = "dot dot-on";
        status.textContent = "Connected";
    }
});

document.getElementById("monitorClearBtn").addEventListener("click", () => {
    document.getElementById("monitorOutput").textContent = "";
});

// ---- Focus editor on load ----
editor.focus();
