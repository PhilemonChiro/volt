"""
Volt Language Server — LSP for .volt files

Provides:
  - Autocomplete (dot-triggered: led. → toggle(), on(), off())
  - Hover info (pin map, method signatures, type info)
  - Diagnostics (real compiler errors/warnings as squiggles)
  - Pin map visualization on hover

Uses the actual Volt compiler for diagnostics (not regex approximation).
"""

import sys
import os
import re
import logging
from pathlib import Path

# Add Volt compiler to path
COMPILER_DIR = str(Path(__file__).resolve().parent.parent.parent / "compiler")
sys.path.insert(0, COMPILER_DIR)

from lsprotocol import types
from pygls.lsp.server import LanguageServer

# Import Volt compiler modules
from checker import METHOD_TYPES, BUILTIN_FUNCS
from pins_esp32 import PIN_DB, ADC2_GPIOS, RTC_GPIOS

# ============================================================
# Server setup
# ============================================================

server = LanguageServer("volt-lsp", "v0.1")

# ============================================================
# Document symbol scanning (quick regex for type lookup)
# ============================================================

PIN_DECL_RE = re.compile(r"pin\s+(\w+)\s*:\s*([\w.]+)\s*=\s*(\d+)")
SENSOR_DECL_RE = re.compile(r"sensor\s+(\w+)\s*:\s*(\w+)")
VAR_DECL_RE = re.compile(r"(?:var|let)\s+(\w+)\s*(?::\s*(\w+))?\s*=")
MACHINE_VAR_RE = re.compile(r"(?:var|let)\s+(\w+)\s*(?::\s*(\w+))?\s*=")

# Builtin singleton types
BUILTIN_OBJECTS = {
    "wifi": "WiFi",
    "mqtt": "MQTT",
    "http": "HTTP",
    "storage": "Storage",
    "system": "System",
    "ota": "OTA",
}


def scan_document(text: str) -> dict:
    """Quick scan to build name → (type, gpio) mapping."""
    symbols = {}

    for m in PIN_DECL_RE.finditer(text):
        name, pin_type, gpio = m.group(1), m.group(2), int(m.group(3))
        base_type = pin_type.split(".")[0]
        symbols[name] = {"type": base_type, "gpio": gpio, "kind": "pin", "mode": pin_type}

    for m in SENSOR_DECL_RE.finditer(text):
        name, sensor_type = m.group(1), m.group(2)
        symbols[name] = {"type": sensor_type, "kind": "sensor"}

    for m in VAR_DECL_RE.finditer(text):
        name = m.group(1)
        type_name = m.group(2) or "unknown"
        symbols[name] = {"type": type_name, "kind": "var"}

    # Add builtins
    for name, type_name in BUILTIN_OBJECTS.items():
        symbols[name] = {"type": type_name, "kind": "builtin"}

    return symbols


# ============================================================
# Pin map visualization
# ============================================================

def generate_pin_map(claimed_pins: dict) -> str:
    """Generate an ASCII pin map showing claimed pins."""
    lines = [
        "```",
        "    ESP32 DevKit V1 Pin Map",
        "    ┌─────────────────────┐",
        "    │       USB            │",
        "    ├──────┬──────────────┤",
    ]

    # Left side pins (J2 header)
    left_pins = [
        ("3V3", None), ("EN", None), ("VP/36", 36), ("VN/39", 39),
        ("34", 34), ("35", 35), ("32", 32), ("33", 33),
        ("25", 25), ("26", 26), ("27", 27), ("14", 14),
        ("12", 12), ("GND", None), ("13", 13),
    ]

    # Right side pins (J3 header)
    right_pins = [
        ("GND", None), ("23", 23), ("22", 22), ("TX/1", 1),
        ("RX/3", 3), ("21", 21), ("GND", None), ("19", 19),
        ("18", 18), ("5", 5), ("17", 17), ("16", 16),
        ("4", 4), ("0", 0), ("2", 2),
    ]

    for i in range(len(left_pins)):
        l_name, l_gpio = left_pins[i]
        r_name, r_gpio = right_pins[i] if i < len(right_pins) else ("", None)

        l_mark = ""
        r_mark = ""

        if l_gpio is not None:
            for pin_name, info in claimed_pins.items():
                if info.get("gpio") == l_gpio:
                    l_mark = f" ◄ {pin_name} ({info.get('mode', '')})"
                    break

        if r_gpio is not None:
            for pin_name, info in claimed_pins.items():
                if info.get("gpio") == r_gpio:
                    r_mark = f" ◄ {pin_name} ({info.get('mode', '')})"
                    break

        lines.append(f"    │{l_name:>6} │ {r_name:<6}│{r_mark}")

    lines.append("    └──────┴──────────────┘")
    lines.append("```")
    return "\n".join(lines)


def generate_pin_hover(gpio: int, name: str, mode: str) -> str:
    """Generate rich hover info for a pin declaration."""
    info = PIN_DB.get(gpio)
    if not info:
        return f"**{name}**: GPIO {gpio} ({mode})"

    parts = [f"### 📌 Pin `{name}` — GPIO {gpio}\n"]
    parts.append(f"**Mode:** `{mode}`\n")

    # Capabilities
    caps = []
    if info.can_output: caps.append("Output")
    if info.can_input: caps.append("Input")
    if info.can_analog: caps.append(f"ADC{info.adc_unit}_CH{info.adc_channel}")
    if info.can_touch: caps.append(f"Touch T{info.touch_channel}")
    if info.can_wake_deep_sleep: caps.append("Deep Sleep Wake")
    if info.spi_native: caps.append(f"SPI: {info.spi_native}")
    if info.i2c_default: caps.append(f"I2C: {info.i2c_default}")
    parts.append(f"**Capabilities:** {', '.join(caps)}\n")

    # Warnings
    if info.is_strapping:
        parts.append(f"⚠️ **Strapping pin** — {info.strapping_warning}\n")
    if info.is_uart0:
        parts.append(f"⚠️ **UART0** — Using this pin breaks serial monitor\n")
    if info.is_jtag:
        parts.append(f"ℹ️ **JTAG pin** — Disables JTAG debugging\n")
    if gpio in ADC2_GPIOS and mode == "Analog":
        parts.append(f"⚠️ **ADC2** — Blocked while WiFi is active. Use ADC1 (GPIO 32-39)\n")
    if gpio in RTC_GPIOS:
        parts.append(f"✅ **RTC GPIO** — Can wake from deep sleep\n")
    for note in info.notes:
        parts.append(f"ℹ️ {note}\n")

    return "".join(parts)


# ============================================================
# Diagnostics (real compiler integration)
# ============================================================

def validate_document(ls: LanguageServer, uri: str):
    """Run the Volt compiler and publish diagnostics."""
    doc = ls.workspace.get_text_document(uri)
    diagnostics = []

    try:
        from voltc import compile_volt
        c_code, errors = compile_volt(doc.source, os.path.basename(uri))

        for err in errors.errors:
            severity = (types.DiagnosticSeverity.Error
                        if err.severity == "error"
                        else types.DiagnosticSeverity.Warning)

            start_line = max(0, err.region.start_line - 1)
            start_col = max(0, err.region.start_col - 1)
            end_line = max(0, err.region.end_line - 1) if err.region.end_line > 0 else start_line
            end_col = max(0, err.region.end_col - 1) if err.region.end_col > 0 else start_col + 1

            diag = types.Diagnostic(
                range=types.Range(
                    start=types.Position(line=start_line, character=start_col),
                    end=types.Position(line=end_line, character=end_col),
                ),
                message=err.message + (f"\nHint: {err.hint}" if err.hint else ""),
                severity=severity,
                source="volt",
            )
            diagnostics.append(diag)

    except Exception as e:
        # Parse error
        diagnostics.append(types.Diagnostic(
            range=types.Range(
                start=types.Position(line=0, character=0),
                end=types.Position(line=0, character=1),
            ),
            message=str(e).split('\n')[0],
            severity=types.DiagnosticSeverity.Error,
            source="volt",
        ))

    ls.text_document_publish_diagnostics(
        types.PublishDiagnosticsParams(uri=uri, diagnostics=diagnostics)
    )


@server.feature(types.TEXT_DOCUMENT_DID_OPEN)
def did_open(ls, params: types.DidOpenTextDocumentParams):
    validate_document(ls, params.text_document.uri)


@server.feature(types.TEXT_DOCUMENT_DID_CHANGE)
def did_change(ls, params: types.DidChangeTextDocumentParams):
    validate_document(ls, params.text_document.uri)


@server.feature(types.TEXT_DOCUMENT_DID_SAVE)
def did_save(ls, params: types.DidSaveTextDocumentParams):
    validate_document(ls, params.text_document.uri)


# ============================================================
# Autocomplete
# ============================================================

VOLT_KEYWORDS = [
    "chip", "hardware", "pin", "sensor", "power", "struct", "func", "task",
    "machine", "state", "initial", "main", "storage", "raw",
    "let", "var", "return", "if", "else", "while", "for", "in", "match",
    "on", "every", "strict", "timeout", "after", "enter", "exit",
    "debounce", "throttle", "true", "false", "run",
]

PIN_MODES = ["Output", "Input", "PullUpInput", "PullDownInput", "Analog", "PWM"]

DURATION_UNITS = ["ms", "seconds", "second", "minutes", "minute", "hours", "hour", "us"]


@server.feature(
    types.TEXT_DOCUMENT_COMPLETION,
    types.CompletionOptions(trigger_characters=[".", ":"]),
)
def completions(ls, params: types.CompletionParams):
    doc = ls.workspace.get_text_document(params.text_document.uri)
    pos = params.position

    try:
        line = doc.lines[pos.line]
    except IndexError:
        return []

    line_to_cursor = line[:pos.character]

    # ── Dot completion: obj.| → methods ──
    dot_match = re.match(r".*?(\w+)\.\s*$", line_to_cursor)
    if dot_match:
        obj_name = dot_match.group(1)
        symbols = scan_document(doc.source)
        sym = symbols.get(obj_name)

        if sym:
            obj_type = sym["type"]
            methods = METHOD_TYPES.get(obj_type, {})
            items = []
            for method, (ret_type, param_list) in methods.items():
                param_str = ", ".join(f"{n}: {t}" for n, t in param_list)
                items.append(types.CompletionItem(
                    label=method,
                    kind=types.CompletionItemKind.Method,
                    detail=f"({param_str}) → {ret_type}",
                    documentation=f"`{obj_name}.{method}({param_str})` returns `{ret_type}`",
                    insert_text=f"{method}($0)" if param_list else f"{method}()",
                    insert_text_format=types.InsertTextFormat.Snippet,
                ))
            return items

    # ── Colon completion: pin name: | → pin modes ──
    colon_match = re.match(r".*pin\s+\w+\s*:\s*$", line_to_cursor)
    if colon_match:
        return [
            types.CompletionItem(
                label=mode,
                kind=types.CompletionItemKind.TypeParameter,
                detail=f"Pin mode: {mode}",
            )
            for mode in PIN_MODES
        ]

    # ── After number → duration units ──
    num_match = re.match(r".*\b(\d+)\s*$", line_to_cursor)
    if num_match:
        num = num_match.group(1)
        return [
            types.CompletionItem(
                label=f"{num}{unit}",
                kind=types.CompletionItemKind.Unit,
                detail=f"Duration: {num} {unit}",
                insert_text=f"{num}{unit}",
            )
            for unit in DURATION_UNITS
        ]

    # ── General completions ──
    items = []

    # Keywords
    for kw in VOLT_KEYWORDS:
        items.append(types.CompletionItem(
            label=kw,
            kind=types.CompletionItemKind.Keyword,
        ))

    # Builtin functions
    for func_name, (ret_type, param_list) in BUILTIN_FUNCS.items():
        param_str = ", ".join(f"{n}: {t}" for n, t in param_list)
        items.append(types.CompletionItem(
            label=func_name,
            kind=types.CompletionItemKind.Function,
            detail=f"({param_str}) → {ret_type}",
        ))

    # Symbols from current document
    symbols = scan_document(doc.source)
    for name, sym in symbols.items():
        if sym["kind"] == "pin":
            items.append(types.CompletionItem(
                label=name,
                kind=types.CompletionItemKind.Variable,
                detail=f"Pin: GPIO {sym.get('gpio', '?')} ({sym['type']})",
            ))
        elif sym["kind"] == "sensor":
            items.append(types.CompletionItem(
                label=name,
                kind=types.CompletionItemKind.Variable,
                detail=f"Sensor: {sym['type']}",
            ))
        elif sym["kind"] == "builtin":
            items.append(types.CompletionItem(
                label=name,
                kind=types.CompletionItemKind.Module,
                detail=f"Builtin: {sym['type']}",
            ))

    return items


# ============================================================
# Hover
# ============================================================

@server.feature(types.TEXT_DOCUMENT_HOVER)
def hover(ls, params: types.HoverParams):
    doc = ls.workspace.get_text_document(params.text_document.uri)
    pos = params.position

    try:
        line = doc.lines[pos.line]
    except IndexError:
        return None

    # Find word under cursor
    for match in re.finditer(r"\b(\w+)\b", line):
        start, end = match.start(), match.end()
        if start <= pos.character <= end:
            word = match.group(1)
            break
    else:
        return None

    symbols = scan_document(doc.source)
    content = None

    # ── Pin hover: show pin info + map ──
    if word in symbols and symbols[word]["kind"] == "pin":
        sym = symbols[word]
        content = generate_pin_hover(sym["gpio"], word, sym.get("mode", sym["type"]))

        # Add claimed pins map
        claimed = {n: s for n, s in symbols.items() if s["kind"] == "pin"}
        if claimed:
            content += "\n---\n" + generate_pin_map(claimed)

    # ── Sensor hover ──
    elif word in symbols and symbols[word]["kind"] == "sensor":
        sym = symbols[word]
        methods = METHOD_TYPES.get(sym["type"], {})
        method_lines = [f"- `.{m}({', '.join(n+': '+t for n,t in p)})` → `{r}`"
                        for m, (r, p) in methods.items()]
        content = f"### 🔬 Sensor `{word}`: `{sym['type']}`\n\n"
        if method_lines:
            content += "**Methods:**\n" + "\n".join(method_lines)

    # ── Builtin object hover ──
    elif word in symbols and symbols[word]["kind"] == "builtin":
        sym = symbols[word]
        methods = METHOD_TYPES.get(sym["type"], {})
        method_lines = [f"- `.{m}({', '.join(n+': '+t for n,t in p)})` → `{r}`"
                        for m, (r, p) in methods.items()]
        content = f"### 🔌 `{word}` ({sym['type']})\n\n"
        if method_lines:
            content += "**Methods:**\n" + "\n".join(method_lines)

    # ── Variable hover ──
    elif word in symbols and symbols[word]["kind"] == "var":
        sym = symbols[word]
        content = f"**{word}**: `{sym['type']}`"

    # ── Builtin function hover ──
    elif word in BUILTIN_FUNCS:
        ret_type, params_list = BUILTIN_FUNCS[word]
        param_str = ", ".join(f"{n}: {t}" for n, t in params_list)
        content = f"### `{word}({param_str})` → `{ret_type}`\n\nBuilt-in function"

    # ── Keyword hover ──
    elif word in VOLT_KEYWORDS:
        keyword_docs = {
            "chip": "Declares the target microcontroller",
            "hardware": "Block declaring physical pin and sensor connections",
            "task": "Defines a concurrent task (background, priority, or critical)",
            "func": "Defines a function with typed parameters",
            "machine": "Defines a state machine with states and transitions",
            "state": "A state within a state machine",
            "initial": "Marks the starting state of a state machine",
            "every": "Periodic execution — runs the block at the given interval",
            "strict": "Marks a task as critical (runs in hardware timer ISR at exact timing)",
            "on": "Event handler — runs when the event occurs",
            "after": "Timed transition — changes state after a duration",
            "enter": "Code that runs when entering a state",
            "exit": "Code that runs when leaving a state",
            "storage": "Persistent variable — survives reboot and deep sleep",
            "debounce": "Filters rapid repeated events (e.g., button bounce)",
            "throttle": "Rate-limits event handling to at most once per interval",
            "match": "Pattern matching — like switch but safer",
            "let": "Declares an immutable variable",
            "var": "Declares a mutable variable",
            "run": "Starts background tasks in the cooperative scheduler",
        }
        doc_text = keyword_docs.get(word, "Volt keyword")
        content = f"**`{word}`** — {doc_text}"

    if content:
        return types.Hover(
            contents=types.MarkupContent(
                kind=types.MarkupKind.Markdown,
                value=content,
            ),
        )
    return None


# ============================================================
# Entry point
# ============================================================

if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING, format="%(message)s", stream=sys.stderr)
    server.start_io()
