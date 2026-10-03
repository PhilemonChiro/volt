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

// Insert a declaration (`pin fan: Output = 23`) after the last line of the
// same kind (pin / bus / device) in the hardware block, else at the block's
// end; with no block, create one at the top of the file. Indentation
// follows the block. Returns the inserted line number. opts → applyEdits.
export function insertDecl(text, opts) {
    const ed = activeEditor();
    if (!ed) return 0;
    const model = ed.getModel();
    const kind = text.trim().split(/\s/)[0];
    const hw = findHardwareBlock(model);
    if (!hw) {
        applyEdits([{ range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
            text: `hardware {\n    ${text}\n}\n\n` }], opts);
        return 2;
    }
    let after = hw.close - 1, indent = "    ";
    let lastKind = 0, lastAny = 0;
    for (let i = hw.open + 1; i < hw.close; i++) {
        const line = model.getLineContent(i);
        const m = line.match(/^(\s*)(pin|bus|device)\b/);
        if (!m) continue;
        indent = m[1];
        lastAny = i;
        if (m[2] === kind) lastKind = i;
    }
    if (lastKind) after = lastKind;
    else if (lastAny) after = lastAny;
    else if (hw.open === hw.close) {
        // `hardware { }` on one line: open it up.
        const line = model.getLineContent(hw.open);
        const brace = line.lastIndexOf("}");
        applyEdits([{ range: { startLine: hw.open, startCol: brace + 1, endLine: hw.open, endCol: brace + 2 },
            text: `\n${indent}${text}\n}` }], opts);
        return hw.open + 1;
    } else {
        after = hw.open;
    }
    const col = model.getLineMaxColumn(after);
    applyEdits([{ range: { startLine: after, startCol: col, endLine: after, endCol: col },
        text: `\n${indent}${text}` }], opts);
    return after + 1;
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
