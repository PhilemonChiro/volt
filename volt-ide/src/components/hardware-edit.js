// Hardware edits — the code is the source of truth, so every visual
// hardware action (quick fix, pin panel, bus wizard, device picker) is one
// text edit here: one undo step, then the editor scrolls to and flashes
// the changed line. Ranges are 1-based, end column exclusive (compiler and
// Monaco agree).

function activeEditor() {
    if (typeof monaco === "undefined") return null;
    return monaco.editor.getEditors()[0] || null;
}

// A compiler fix ({line, col, end_line, end_col, text}) as an edit.
export function fixToEdit(fix) {
    return {
        range: { startLine: fix.line, startCol: fix.col, endLine: fix.end_line, endCol: fix.end_col },
        text: fix.text,
    };
}

// Apply edits as a single undo step; reveal + flash the first edited line.
export function applyEdits(edits, { flash = true } = {}) {
    const ed = activeEditor();
    if (!ed || !edits.length) return false;
    const ops = edits.map(e => ({
        range: new monaco.Range(e.range.startLine, e.range.startCol, e.range.endLine, e.range.endCol),
        text: e.text,
        forceMoveMarkers: true,
    }));
    ed.pushUndoStop();
    ed.executeEdits("hardware-edit", ops);
    ed.pushUndoStop();
    if (flash) flashLine(edits[0].range.startLine);
    return true;
}

// The hardware block's `hardware {` and closing `}` lines (1-based), or null.
export function findHardwareBlock(model) {
    const n = model.getLineCount();
    for (let i = 1; i <= n; i++) {
        if (!/^\s*hardware\s*\{/.test(model.getLineContent(i))) continue;
        let depth = 0;
        for (let j = i; j <= n; j++) {
            for (const ch of model.getLineContent(j)) {
                if (ch === "{") depth++;
                else if (ch === "}" && --depth === 0) return { open: i, close: j };
            }
        }
        return null;
    }
    return null;
}

// Rewrite the hardware block in today's syntax (`i2c name(…)`, SPI
// `(cs: N)`, no UART `at 0`): the compiler's formatter, applied to the
// hardware block only, as one undo step. Returns false when unchanged.
export async function modernizeHardware(opts) {
    const ed = activeEditor();
    if (!ed) return false;
    const model = ed.getModel();
    const hw = findHardwareBlock(model);
    if (!hw) return false;
    const cur = model.getValueInRange({ startLineNumber: hw.open, startColumn: 1, endLineNumber: hw.close,
        endColumn: model.getLineMaxColumn(hw.close) });
    // Just the block: the formatter keeps files with comments verbatim.
    const formatted = await window.volt.formatCode(cur + "\n");
    if (!formatted) return false;
    const lines = formatted.split("\n");
    const open = lines.findIndex(l => /^\s*hardware\s*\{/.test(l));
    let close = -1;
    for (let j = open, depth = 0; open >= 0 && j < lines.length && close < 0; j++)
        for (const ch of lines[j]) {
            if (ch === "{") depth++;
            else if (ch === "}" && --depth === 0) { close = j; break; }
        }
    if (close < 0) return false;
    const text = lines.slice(open, close + 1).join("\n");
    if (cur === text) return false;
    const range = { startLine: hw.open, startCol: 1, endLine: hw.close, endCol: model.getLineMaxColumn(hw.close) };
    return applyEdits([{ range, text }], opts);
}

// Insert a declaration (`pin fan: Output = 23`) after the last line of the
// same kind (pin / bus / device) in the hardware block, else at the block's
// end; with no block, create one at the top of the file. Indentation
// follows the block. Returns the inserted line number. opts → applyEdits.
export function insertDecl(text, opts) {
    return insertDecls([text], opts)[0] || 0;
}

// Several declarations as ONE undo step (a device plus the bus it needs).
// Returns each text's line number after the edit.
export function insertDecls(texts, opts) {
    const ed = activeEditor();
    if (!ed || !texts.length) return [];
    const model = ed.getModel();
    const hw = findHardwareBlock(model);
    if (!hw) {
        applyEdits([{ range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
            text: `hardware {\n${texts.map(t => "    " + t + "\n").join("")}}\n\n` }], opts);
        return texts.map((_, i) => 2 + i);
    }
    let indent = "    ";
    const lastKind = {};
    let lastAny = 0;
    for (let i = hw.open + 1; i < hw.close; i++) {
        const m = model.getLineContent(i).match(/^(\s*)(pin|bus|device|i2c|spi|uart)\b/);
        if (!m) continue;
        indent = m[1];
        lastAny = i;
        lastKind[m[2] === "pin" || m[2] === "device" ? m[2] : "bus"] = i;
    }
    if (hw.open === hw.close) {
        // `hardware { }` on one line: open it up.
        const line = model.getLineContent(hw.open);
        const brace = line.lastIndexOf("}");
        applyEdits([{ range: { startLine: hw.open, startCol: brace + 1, endLine: hw.open, endCol: brace + 2 },
            text: texts.map(t => `\n${indent}${t}`).join("") + "\n}" }], opts);
        return texts.map((_, i) => hw.open + 1 + i);
    }
    // Group by insertion line (in order), one edit per group.
    const groups = new Map();
    for (const t of texts) {
        const word = t.trim().split(/\s/)[0];
        const kind = word === "pin" || word === "device" ? word : "bus";   // i2c / spi / uart / bus
        const after = lastKind[kind] || lastAny || hw.open;
        if (!groups.has(after)) groups.set(after, []);
        groups.get(after).push(t);
    }
    const edits = [...groups].map(([after, ts]) => {
        const col = model.getLineMaxColumn(after);
        return { range: { startLine: after, startCol: col, endLine: after, endCol: col },
            text: ts.map(t => `\n${indent}${t}`).join("") };
    });
    edits.sort((x, y) => x.range.startLine - y.range.startLine);
    applyEdits(edits, opts);
    // Where each text landed.
    const lines = model.getLinesContent();
    return texts.map(t => lines.findIndex(l => l.trim() === t.trim()) + 1);
}

// Replace a whole line's text (keeps its indentation and trailing comment).
export function replaceDecl(line, text) {
    const ed = activeEditor();
    if (!ed) return false;
    const cur = ed.getModel().getLineContent(line);
    const indent = cur.match(/^\s*/)[0];
    const comment = cur.match(/\s+\/\/.*$/);
    return applyEdits([{ range: { startLine: line, startCol: 1, endLine: line, endCol: cur.length + 1 },
        text: indent + text + (comment ? comment[0] : "") }]);
}

// Delete a whole line (and its newline).
export function deleteDecl(line) {
    const ed = activeEditor();
    if (!ed) return false;
    const model = ed.getModel();
    const range = line < model.getLineCount()
        ? { startLine: line, startCol: 1, endLine: line + 1, endCol: 1 }
        : { startLine: line - 1, startCol: model.getLineMaxColumn(line - 1), endLine: line, endCol: model.getLineMaxColumn(line) };
    return applyEdits([{ range, text: "" }], { flash: false });
}

let _flashDecos = null, _flashTimer = null;
export function flashLine(line) {
    const ed = activeEditor();
    if (!ed) return;
    ed.revealLineInCenterIfOutsideViewport(line);
    if (!_flashDecos) _flashDecos = ed.createDecorationsCollection([]);
    _flashDecos.set([{ range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: "hw-edit-flash" } }]);
    clearTimeout(_flashTimer);
    _flashTimer = setTimeout(() => _flashDecos.set([]), 900);
}
