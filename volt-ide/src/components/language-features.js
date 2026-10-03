// Language features — providers extracted from Tauri app.js
// Registers: autocomplete, hover, signatures, go-to-def, references, rename, symbols, formatting

import { fixesFor } from "./diagnostics.js";
import * as hwEditor from "./hardware-editor.js";
import { SNIPPETS, PIN_METHODS, SENSOR_METHODS, TYPES, CHIPS, DURATIONS, CONSTANTS,
    KEYWORD_DOCS, TYPE_DOCS, CHIP_DOCS, ESP32_PIN_NOTES, METHOD_SIGS, METHOD_DOCS, EASING_DOCS,
    DOT_METHODS, BUILTIN_DOCS } from "./language-data.js";

export function register() {
    var Kind = monaco.languages.CompletionItemKind;
    var Insert = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

    // Convert "_kind" string to Monaco Kind enum
    function resolveKind(item) {
        if (item._kind) return Kind[item._kind] || Kind.Text;
        if (item.kind) return item.kind;
        return Kind.Text;
    }

    // Scan document for pin and sensor declarations.
    // Cached by model.getVersionId() so hover/completion/definition don't
    // each re-scan the whole document on every keystroke-triggered popup.
    var declCache = null;
    var declCacheVersion = -1;
    function scanDeclarations(model) {
        var version = model.getVersionId();
        if (declCache && declCacheVersion === version) return declCache;
        var pins = {};
        var sensors = {};
        var lines = model.getLineCount();
        for (var i = 1; i <= lines; i++) {
            var line = model.getLineContent(i);
            var pm = line.match(/\bpin\s+(\w+)\s*(?::\s*(Output|PullUpInput|PullDownInput|Input|Analog|PWM|Servo|DAC|Touch))?\s*=/);
            if (pm) pins[pm[1]] = pm[2] || 'Output';
            var sm = line.match(/\bdevice\s+(\w+)\s*:\s*(BME280|AHT20|SHT31|DHT22|MPU6050|INA219|DS3231|BH1750|VEML7700|SSD1306)/);
            if (sm) sensors[sm[1]] = sm[2];
        }
        declCache = { pins: pins, sensors: sensors };
        declCacheVersion = version;
        return declCache;
    }

    function detectChip(model) {
        for (var i = 1; i <= Math.min(model.getLineCount(), 5); i++) {
            var m = model.getLineContent(i).match(/^\s*chip\s+(\w+)/);
            if (m) return m[1];
        }
        return 'esp32';
    }

    function getPinNote(chip, num) {
        if (chip === 'esp32' && ESP32_PIN_NOTES[num]) return '**GPIO ' + num + ':** ' + ESP32_PIN_NOTES[num];
        return null;
    }

    // Hardware positions (pin numbers, modes, buses, addresses) first;
    // anything else falls through to the general provider.
    function hardwareFirst(general) {
        return function (model, position) {
            var before = model.getLineContent(position.lineNumber).substring(0, position.column - 1);
            var w = model.getWordUntilPosition(position);
            var r = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
                startColumn: w.startColumn, endColumn: w.endColumn };
            return hwEditor.complete(model, position, before, r).then(function (hw) {
                return hw ? { suggestions: hw } : general(model, position);
            }, function () { return general(model, position); });
        };
    }

    // ---- completionProvider ----
    monaco.languages.registerCompletionItemProvider("volt", {
        triggerCharacters: [".", " ", ":"],
        provideCompletionItems: hardwareFirst(function (model, position) {
            var line = model.getLineContent(position.lineNumber);
            var textBefore = line.substring(0, position.column - 1);
            var word = model.getWordUntilPosition(position);
            var range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };

            var suggestions = [];

            // --- Dot completions: object.method ---
            var dotMatch = textBefore.match(/\b(\w+)\.\s*$/);
            if (dotMatch) {
                var obj = dotMatch[1];
                var methods = null;

                // Check builtins first
                if (DOT_METHODS[obj]) {
                    methods = DOT_METHODS[obj];
                } else {
                    // Check document pins and sensors
                    var decls = scanDeclarations(model);
                    if (decls.pins[obj]) {
                        methods = PIN_METHODS[decls.pins[obj]] || [];
                    } else if (decls.sensors[obj]) {
                        methods = SENSOR_METHODS[decls.sensors[obj]] || [];
                    }
                }

                if (methods) {
                    methods.forEach(function (m) {
                        suggestions.push({
                            label: m.label,
                            kind: Kind.Method,
                            detail: m.detail,
                            insertText: m.insert,
                            insertTextRules: Insert,
                            range: range,
                        });
                    });
                    return { suggestions: suggestions };
                }
            }

            // --- After "chip " — suggest chip names ---
            if (/\bchip\s+$/.test(textBefore)) {
                CHIPS.forEach(function (c) {
                    suggestions.push({
                        label: c.label,
                        kind: Kind.EnumMember,
                        detail: c.detail,
                        insertText: c.label,
                        range: range,
                    });
                });
                return { suggestions: suggestions };
            }

            // --- After colon — suggest types ---
            if (/:\s*$/.test(textBefore)) {
                TYPES.forEach(function (t) {
                    suggestions.push({
                        label: t.label,
                        kind: Kind.TypeParameter,
                        detail: t.detail,
                        insertText: t.label,
                        range: range,
                    });
                });
                return { suggestions: suggestions };
            }

            // --- After number — suggest duration units ---
            if (/\b\d+$/.test(textBefore)) {
                DURATIONS.forEach(function (d) {
                    var unit = d.replace(/^\d+/, "");
                    suggestions.push({
                        label: d,
                        kind: Kind.Unit,
                        detail: "Duration",
                        insertText: unit,
                        range: range,
                    });
                });
                return { suggestions: suggestions };
            }

            // --- General completions: snippets + constants + document symbols ---
            SNIPPETS.forEach(function (s) {
                suggestions.push({
                    label: s.label,
                    kind: resolveKind(s),
                    detail: s.detail,
                    insertText: s.insert,
                    insertTextRules: Insert,
                    range: range,
                });
            });

            CONSTANTS.forEach(function (c) {
                suggestions.push({
                    label: c.label,
                    kind: resolveKind(c),
                    detail: c.detail,
                    insertText: c.label,
                    range: range,
                });
            });

            // Add declared pin/sensor names as variables
            var decls = scanDeclarations(model);
            Object.keys(decls.pins).forEach(function (name) {
                suggestions.push({
                    label: name,
                    kind: Kind.Variable,
                    detail: "Pin: " + decls.pins[name],
                    insertText: name,
                    range: range,
                });
            });
            Object.keys(decls.sensors).forEach(function (name) {
                suggestions.push({
                    label: name,
                    kind: Kind.Variable,
                    detail: "Device: " + decls.sensors[name],
                    insertText: name,
                    range: range,
                });
            });

            // Add builtin objects
            ["wifi", "mqtt", "http", "storage", "system", "ota"].forEach(function (b) {
                suggestions.push({
                    label: b,
                    kind: Kind.Module,
                    detail: "Builtin: " + b,
                    insertText: b,
                    range: range,
                });
            });

            return { suggestions: suggestions };
        })
    });
    // AST-aware formatter — uses the Volt compiler's parser via IPC.
    // Auto-updates when DSL grammar changes (same parser, same AST).
    // Falls back to basic brace-indentation if the IPC call fails.
    monaco.languages.registerDocumentFormattingEditProvider("volt", {
        provideDocumentFormattingEdits: function (model) {
            var source = model.getValue();
            return window.volt.formatCode(source).then(function (formatted) {
                if (!formatted) {
                    // IPC failed — fallback to basic indent
                    return _basicFormat(model);
                }
                return [{
                    range: model.getFullModelRange(),
                    text: formatted,
                }];
            }).catch(function () {
                return _basicFormat(model);
            });
        }
    });

    function _basicFormat(model) {
        var lines = model.getLinesContent();
        var indent = 0;
        var formatted = [];
        for (var i = 0; i < lines.length; i++) {
            var trimmed = lines[i].trim();
            if (trimmed === "") { formatted.push(""); continue; }
            if (trimmed.startsWith("}")) indent = Math.max(0, indent - 1);
            var spaces = "";
            for (var s = 0; s < indent; s++) spaces += "    ";
            formatted.push(spaces + trimmed);
            if (trimmed.endsWith("{")) indent++;
        }
        return [{ range: model.getFullModelRange(), text: formatted.join("\n") }];
    }

    // ----------------------------------------------------------------
    // Hover provider — rich documentation on mouse hover
    // ----------------------------------------------------------------

    // ---- hoverProvider ----
    // Pin hover (board facts + compiler warnings) on hardware lines first.
    function pinHoverFirst(general) {
        return function (model, position) {
            return hwEditor.hover(model, position).then(function (h) {
                return h || general(model, position);
            }, function () { return general(model, position); });
        };
    }

    monaco.languages.registerHoverProvider("volt", {
        provideHover: pinHoverFirst(function (model, position) {
            var word = model.getWordAtPosition(position);
            var line = model.getLineContent(position.lineNumber);
            var col = position.column - 1;
            var contents = [];
            var hoverRange = null;

            // -- Try to detect obj.method pattern --
            if (word) {
                var beforeDot = line.substring(0, word.startColumn - 1);
                var dotMatch = beforeDot.match(/(\w+)\.\s*$/);

                if (dotMatch) {
                    var obj = dotMatch[1];
                    var method = word.word;
                    var fullKey = obj + "." + method;
                    hoverRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);

                    // Check builtin object methods
                    if (METHOD_DOCS[fullKey]) {
                        var md = METHOD_DOCS[fullKey];
                        contents.push({ value: "```volt\n" + md.sig + "\n```" });
                        contents.push({ value: md.desc });
                        if (md.detail) contents.push({ value: md.detail });
                    } else {
                        // Check if obj is a declared pin/sensor — look up by type
                        var decls = scanDeclarations(model);
                        var pinMode = decls.pins[obj];
                        var sensorType = decls.sensors[obj];

                        if (pinMode) {
                            // Normalize: PullUpInput -> Input for method lookup
                            var baseMode = pinMode.split(".")[0];
                            var typeKey = baseMode + "." + method;
                            if (METHOD_DOCS[typeKey]) {
                                var pmd = METHOD_DOCS[typeKey];
                                contents.push({ value: "**" + obj + "** (" + pinMode + " pin)" });
                                contents.push({ value: "```volt\n" + pmd.sig + "\n```" });
                                contents.push({ value: pmd.desc });
                                if (pmd.detail) contents.push({ value: pmd.detail });
                            }
                        } else if (sensorType) {
                            var stKey = sensorType + "." + method;
                            if (METHOD_DOCS[stKey]) {
                                var smd = METHOD_DOCS[stKey];
                                contents.push({ value: "**" + obj + "** (" + sensorType + " sensor)" });
                                contents.push({ value: "```volt\n" + smd.sig + "\n```" });
                                contents.push({ value: smd.desc });
                                if (smd.detail) contents.push({ value: smd.detail });
                            }
                        }
                    }

                    if (contents.length > 0) return { range: hoverRange, contents: contents };
                }
            }

            // -- Standard word hover --
            if (!word) return null;
            var w = word.word;
            hoverRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);

            // Keywords
            if (KEYWORD_DOCS[w]) {
                var kd = KEYWORD_DOCS[w];
                contents.push({ value: "**" + kd.cat + "**" });
                contents.push({ value: "```volt\n" + kd.sig + "\n```" });
                contents.push({ value: kd.desc });
                if (kd.detail) contents.push({ value: kd.detail });
            }
            // Types
            else if (TYPE_DOCS[w]) {
                var td = TYPE_DOCS[w];
                contents.push({ value: "**Type**" });
                contents.push({ value: "`" + w + "` — " + td.desc });
                if (td.detail) contents.push({ value: td.detail });
            }
            // Builtin objects
            else if (BUILTIN_DOCS[w]) {
                var bd = BUILTIN_DOCS[w];
                contents.push({ value: "**Builtin Module**" });
                contents.push({ value: "`" + w + "` — " + bd.desc });
                if (bd.detail) contents.push({ value: bd.detail });
            }
            // Chip names
            else if (CHIP_DOCS[w]) {
                var chd = CHIP_DOCS[w];
                contents.push({ value: "**Chip**" });
                contents.push({ value: "`" + w + "` — " + chd.desc });
                if (chd.detail) contents.push({ value: chd.detail });
            }
            // Pin numbers (in any numeric context — hardware block or assignment)
            else if (/^\d+$/.test(w)) {
                var num = parseInt(w);
                var chip = detectChip(model);
                var note = getPinNote(chip, num);
                if (note) contents.push({ value: note });
            }
            // Constants
            else if (w === "true" || w === "false") {
                contents.push({ value: "**Constant** — Boolean literal `" + w + "`" });
            }
            else if (w === "HIGH" || w === "LOW" || w === "ON" || w === "OFF") {
                contents.push({ value: "**Constant** — Pin level `" + w + "` (" + (w === "HIGH" || w === "ON" ? "1" : "0") + ")" });
            }
            else if (EASING_DOCS[w]) {
                var ed = EASING_DOCS[w];
                contents.push({ value: "**Easing** \u2014 `" + w + "`" });
                contents.push({ value: ed.desc });
                contents.push({ value: "**When to use:** " + ed.use_case });
                if (ed.examples) contents.push({ value: "**Examples:** " + ed.examples });
            }
            // Declared pins — show pin info when hovering the variable name
            else {
                var decls = scanDeclarations(model);
                if (decls.pins[w]) {
                    var mode = decls.pins[w];
                    contents.push({ value: "**Pin** `" + w + "` : " + mode });
                    if (TYPE_DOCS[mode]) contents.push({ value: TYPE_DOCS[mode].detail || TYPE_DOCS[mode].desc });
                    // Try to find the GPIO number
                    var pinLine = model.findMatches("\\bpin\\s+" + w + "\\s*:.*=\\s*(\\d+)", false, true, false, null, true);
                    if (pinLine.length > 0) {
                        var gpio = parseInt(pinLine[0].matches[1]);
                        var pnote = getPinNote(detectChip(model), gpio);
                        if (pnote) contents.push({ value: pnote });
                    }
                } else if (decls.sensors[w]) {
                    var stype = decls.sensors[w];
                    contents.push({ value: "**Sensor** `" + w + "` : " + stype });
                    // Show available methods
                    var smethods = SENSOR_METHODS[stype];
                    if (smethods) {
                        contents.push({ value: "**Methods:** " + smethods.map(function(m) { return "`." + m.label + "()` " + m.detail; }).join("\n\n") });
                    }
                }
            }

            // Duration literals — show human-readable conversion
            var durRegex = /\b(\d+)(us|ms|s|sec|seconds?|min|minutes?|hr|hours?)\b/g;
            var durMatch;
            while ((durMatch = durRegex.exec(line)) !== null) {
                var dStart = durMatch.index + 1;
                var dEnd = dStart + durMatch[0].length;
                if (position.column >= dStart && position.column <= dEnd) {
                    var amount = parseInt(durMatch[1]);
                    var unit = durMatch[2];
                    var us = amount;
                    if (unit === "us") us = amount;
                    else if (unit === "ms") us = amount * 1000;
                    else if (unit === "s" || unit === "sec" || unit === "second" || unit === "seconds") us = amount * 1000000;
                    else if (unit === "min" || unit === "minute" || unit === "minutes") us = amount * 60000000;
                    else if (unit === "hr" || unit === "hour" || unit === "hours") us = amount * 3600000000;

                    // Show human-readable conversions
                    var parts = [];
                    if (us < 1000) parts.push(us + " microseconds");
                    else if (us < 1000000) parts.push((us / 1000) + "ms");
                    else if (us < 60000000) parts.push((us / 1000000) + " seconds");
                    else if (us < 3600000000) parts.push((us / 60000000) + " minutes");
                    else parts.push((us / 3600000000) + " hours");

                    contents.push({ value: "**" + parts.join(" = ") + "**" });
                    break;
                }
            }

            if (contents.length === 0) return null;
            return { range: hoverRange, contents: contents };
        })
    });

    // ----------------------------------------------------------------
    // Signature help — parameter hints while typing function calls
    // ----------------------------------------------------------------

    // ---- signatureProvider ----
    monaco.languages.registerSignatureHelpProvider("volt", {
        signatureHelpTriggerCharacters: ["(", ","],
        provideSignatureHelp: function (model, position) {
            var line = model.getLineContent(position.lineNumber);
            var textBefore = line.substring(0, position.column - 1);

            // Find the function call context
            // Match: word( or word.word(
            var callMatch = textBefore.match(/\b(\w+(?:\.\w+)?)\s*\(([^)]*)$/);
            if (!callMatch) return null;

            var funcName = callMatch[1];
            var argsText = callMatch[2];

            // Count commas to determine active parameter
            var activeParam = (argsText.match(/,/g) || []).length;

            var sig = METHOD_SIGS[funcName];
            if (!sig) return null;

            return {
                value: {
                    signatures: [{
                        label: sig.label,
                        parameters: sig.params.map(function (p) {
                            return { label: p.label, documentation: p.doc };
                        }),
                    }],
                    activeSignature: 0,
                    activeParameter: activeParam,
                },
                dispose: function () {},
            };
        }
    });

    // ----------------------------------------------------------------
    // ----------------------------------------------------------------
    // Go-to-definition, Find references, Rename symbol
    // ----------------------------------------------------------------
    var cachedSymbols = null;
    var symbolCacheVersion = -1;

    function getSymbols(model) {
        if (!model) {
            var models = monaco.editor.getModels();
            model = models.length > 0 ? models[0] : null;
        }
        if (!model) return Promise.resolve([]);
        var version = model.getVersionId();
        if (cachedSymbols && symbolCacheVersion === version) {
            return Promise.resolve(cachedSymbols);
        }
        var source = model.getValue();
        return window.volt.findSymbols(source).then(function (syms) {
            cachedSymbols = syms;
            symbolCacheVersion = version;
            return syms;
        }).catch(function () { return []; });
    }

    function findSymbolAt(syms, line, col) {
        // Find a symbol whose definition or reference is at this position
        for (var i = 0; i < syms.length; i++) {
            var s = syms[i];
            if (s.def_line === line) {
                // Check if cursor is on the symbol name at definition
                return s;
            }
            for (var j = 0; j < s.refs.length; j++) {
                if (s.refs[j].line === line) {
                    return s;
                }
            }
        }
        // Fallback: match by word at position
        return null;
    }

    function findSymbolByWord(syms, word) {
        for (var i = 0; i < syms.length; i++) {
            if (syms[i].name === word) return syms[i];
        }
        return null;
    }

    // Go-to-definition: Ctrl+Click or F12

    // ---- definitionProvider ----
    monaco.languages.registerDefinitionProvider("volt", {
        provideDefinition: function (model, position) {
            var word = model.getWordAtPosition(position);
            if (!word) return null;
            return getSymbols().then(function (syms) {
                var sym = findSymbolByWord(syms, word.word);
                if (!sym || !sym.def_line) return null;
                return {
                    uri: model.uri,
                    range: new monaco.Range(sym.def_line, sym.def_col, sym.def_line, sym.def_col + sym.name.length),
                };
            });
        }
    });

    // Find references: Shift+F12

    // ---- referenceProvider ----
    monaco.languages.registerReferenceProvider("volt", {
        provideReferences: function (model, position) {
            var word = model.getWordAtPosition(position);
            if (!word) return null;
            return getSymbols().then(function (syms) {
                var sym = findSymbolByWord(syms, word.word);
                if (!sym) return [];
                var results = [];
                // Include definition
                results.push({
                    uri: model.uri,
                    range: new monaco.Range(sym.def_line, sym.def_col, sym.def_line, sym.def_col + sym.name.length),
                });
                // Include all references
                for (var j = 0; j < sym.refs.length; j++) {
                    var ref = sym.refs[j];
                    results.push({
                        uri: model.uri,
                        range: new monaco.Range(ref.line, ref.col, ref.line, ref.col + sym.name.length),
                    });
                }
                return results;
            });
        }
    });

    // Rename symbol: F2

    // ---- renameProvider ----
    monaco.languages.registerRenameProvider("volt", {
        provideRenameEdits: function (model, position, newName) {
            var word = model.getWordAtPosition(position);
            if (!word) return null;
            return getSymbols().then(function (syms) {
                var sym = findSymbolByWord(syms, word.word);
                if (!sym) return null;
                var edits = [];
                // Rename at definition
                edits.push({
                    resource: model.uri,
                    textEdit: {
                        range: new monaco.Range(sym.def_line, sym.def_col, sym.def_line, sym.def_col + sym.name.length),
                        text: newName,
                    },
                    versionId: model.getVersionId(),
                });
                // Rename all references
                for (var j = 0; j < sym.refs.length; j++) {
                    var ref = sym.refs[j];
                    edits.push({
                        resource: model.uri,
                        textEdit: {
                            range: new monaco.Range(ref.line, ref.col, ref.line, ref.col + sym.name.length),
                            text: newName,
                        },
                        versionId: model.getVersionId(),
                    });
                }
                return { edits: edits };
            });
        },
        resolveRenameLocation: function (model, position) {
            var word = model.getWordAtPosition(position);
            if (!word) return { rejectReason: "Not a renamable symbol" };
            return getSymbols().then(function (syms) {
                var sym = findSymbolByWord(syms, word.word);
                if (!sym) return { rejectReason: "Symbol not found" };
                return {
                    range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
                    text: sym.name,
                };
            });
        }
    });

    // Document symbol outline: Ctrl+Shift+O

    // ---- symbolProvider ----
    monaco.languages.registerDocumentSymbolProvider("volt", {
        provideDocumentSymbols: function (model) {
            return getSymbols().then(function (syms) {
                var kindMap = {
                    pin: monaco.languages.SymbolKind.Field,
                    sensor: monaco.languages.SymbolKind.Field,
                    bus: monaco.languages.SymbolKind.Interface,
                    var: monaco.languages.SymbolKind.Variable,
                    storage: monaco.languages.SymbolKind.Variable,
                    func: monaco.languages.SymbolKind.Function,
                    task: monaco.languages.SymbolKind.Function,
                    machine: monaco.languages.SymbolKind.Class,
                    state: monaco.languages.SymbolKind.Enum,
                    param: monaco.languages.SymbolKind.Variable,
                };
                return syms.map(function (s) {
                    return {
                        name: s.name,
                        kind: kindMap[s.kind] || monaco.languages.SymbolKind.Variable,
                        range: new monaco.Range(s.def_line, s.def_col, s.def_line, s.def_col + s.name.length),
                        selectionRange: new monaco.Range(s.def_line, s.def_col, s.def_line, s.def_col + s.name.length),
                        detail: s.kind,
                    };
                });
            });
        }
    });

    // ----------------------------------------------------------------
    // Quick fixes (code actions) — the compiler attaches fixes to
    // hardware diagnostics (e.g. "Move to GPIO 23" with the exact span of
    // the pin number); each becomes a one-click, single-undo edit.
    // ----------------------------------------------------------------
    monaco.languages.registerCodeActionProvider("volt", {
        provideCodeActions: function (model, range, context) {
            var actions = [];
            var seen = {};
            var markers = (context && context.markers) || [];
            // A selection over several pins: say which pin each fix moves.
            var lines = {};
            markers.forEach(function (m) { if (fixesFor(m).length) lines[m.startLineNumber] = true; });
            var several = Object.keys(lines).length > 1;
            markers.forEach(function (m) {
                fixesFor(m).forEach(function (f, i) {
                    var key = f.title + "@" + f.line + ":" + f.col;
                    if (seen[key]) return;
                    seen[key] = true;
                    var title = f.title;
                    if (several) {
                        var decl = model.getLineContent(f.line).match(/^\s*(?:pin|bus|device)\s+(\w+)/);
                        if (decl) title = decl[1] + ": " + title;
                    }
                    actions.push({
                        title: title,
                        kind: "quickfix",
                        diagnostics: [m],
                        isPreferred: i === 0 && !several,
                        edit: {
                            edits: [{
                                resource: model.uri,
                                textEdit: {
                                    range: new monaco.Range(f.line, f.col, f.end_line, f.end_col),
                                    text: f.text,
                                },
                            }],
                        },
                    });
                });
            });
            return { actions: actions, dispose: function () {} };
        },
    });

    // ----------------------------------------------------------------
    // Real-time diagnostics — check as you type
    // ----------------------------------------------------------------

    console.log("[volt] language features registered");
}

