"""
Volt Formatter — AST-aware pretty-printer for Volt source code.

Parses the source through the real Volt parser, then re-emits it
with consistent style. Because it uses the same parser as the compiler,
it automatically supports all language features — new syntax is formatted
correctly as soon as the grammar is updated.

Style rules:
  - 4-space indentation
  - One blank line between top-level blocks
  - Spaces around binary operators: x + 1, not x+1
  - Space after keywords: if expr, not if(expr)
  - No trailing whitespace
  - Single blank lines (no double blanks)
  - Hardware block items on separate lines
  - Short blocks on one line: enter { led.on() }
"""

from .parser import parse
from .ast_nodes import *


INDENT = "    "
ONE_LINE_THRESHOLD = 60  # max chars for a single-line block body


def format_source(source: str) -> str:
    """Format Volt source code. Returns formatted string.

    Two paths:
      - AST round-trip (preferred): parse → re-emit. Maximum style polish.
      - Brace-based basic format: indentation-only, but preserves all
        original text including comments and blank lines verbatim.

    Comments are currently stripped by the grammar (%ignore COMMENT in
    grammar.lark) so the AST round-trip would lose them. Until comments
    are threaded through the AST, fall back to basic formatting whenever
    the source has any '//' line comments or '/* */' block comments.
    """
    if _has_comments(source):
        return _basic_format(source)
    try:
        program = parse(source)
        return _emit_program(program)
    except Exception:
        # Parse failed — fall back to basic brace formatter
        return _basic_format(source)


def _has_comments(source: str) -> bool:
    """Detect '//' line comments or '/* */' block comments outside of strings.
    Conservative: a single '//' inside a string would also match, but the
    consequence is just using the basic formatter — never lost data."""
    in_str = False
    quote = ""
    i = 0
    n = len(source)
    while i < n:
        ch = source[i]
        if in_str:
            if ch == "\\" and i + 1 < n:
                i += 2
                continue
            if ch == quote:
                in_str = False
            i += 1
            continue
        if ch in ('"', "'"):
            in_str = True
            quote = ch
            i += 1
            continue
        if ch == "/" and i + 1 < n:
            nxt = source[i + 1]
            if nxt == "/" or nxt == "*":
                return True
        i += 1
    return False


# ============================================================
# Program structure
# ============================================================

def _emit_program(p: Program) -> str:
    parts = []

    if p.chip:
        parts.append(f"chip {p.chip.target}")

    if p.includes:
        for inc in p.includes:
            parts.append(f'include "{inc.path}"')

    if p.hardware:
        parts.append(_emit_hardware(p.hardware))

    if p.enums:
        for enum in p.enums:
            parts.append(_emit_enum(enum))

    if p.structs:
        for s in p.structs:
            parts.append(_emit_struct(s))

    if p.channels:
        for ch in p.channels:
            parts.append(_emit_channel(ch))

    for sv in p.storage_vars:
        parts.append(_emit_storage_var(sv))

    # Global vars (top-level)
    for gv in p.global_vars:
        parts.append(_emit_var_decl(gv, 0))

    for func in p.functions:
        parts.append(_emit_function(func))

    for task in p.tasks:
        # Internal tasks from top-level every/on — emit as bare blocks
        if task.name.startswith("_rule") or task.name.startswith("_auto_task"):
            for stmt in task.body:
                parts.append(_emit_stmt(stmt, 0))
        else:
            parts.append(_emit_task(task))

    for machine in p.machines:
        parts.append(_emit_machine(machine))

    if p.setup:
        parts.append(_emit_block_construct("setup", p.setup.body))

    if p.loop:
        parts.append(_emit_block_construct("loop", p.loop.body))

    # Join with single blank line between top-level items
    result = "\n\n".join(p for p in parts if p)
    # Ensure trailing newline
    if result and not result.endswith("\n"):
        result += "\n"
    return result


# ============================================================
# Top-level constructs
# ============================================================

def _emit_hardware(hw) -> str:
    lines = ["hardware {"]
    for pin in hw.pins:
        lines.append(INDENT + _emit_pin_decl(pin))
    for bus in hw.buses:
        lines.append(INDENT + _emit_bus_decl(bus))
    for sensor in hw.sensors:
        lines.append(INDENT + _emit_sensor_decl(sensor))
    lines.append("}")
    return "\n".join(lines)


def _emit_pin_decl(pin) -> str:
    mode = pin.mode if pin.mode else ""
    if mode:
        return f"pin {pin.name}: {mode} = {_emit_expr(pin.gpio)}"
    else:
        return f"pin {pin.name} = {_emit_expr(pin.gpio)}"


def _emit_bus_decl(bus) -> str:
    params = ", ".join(f"{k}: {_emit_expr(v)}" for k, v in bus.params.items())
    bus_type = bus.bus_type.upper()  # parser lowercases; display as I2C, SPI
    return f"bus {bus.name}: {bus_type}({params})"


def _emit_sensor_decl(sensor) -> str:
    # Emit I2C addresses as hex (convention)
    addr = sensor.address
    if isinstance(addr, int) and addr > 0:
        addr_str = f"0x{addr:02X}"
    elif addr is not None:
        addr_str = _emit_expr(addr)
    else:
        addr_str = "0"
    return f"device {sensor.name}: {sensor.sensor_type} on {sensor.bus_name} at {addr_str}"


def _emit_enum(enum) -> str:
    variants = ", ".join(enum.variants)
    # Short enums on one line
    if len(variants) < ONE_LINE_THRESHOLD:
        return f"enum {enum.name} {{ {variants} }}"
    # Long enums on separate lines
    lines = [f"enum {enum.name} {{"]
    for v in enum.variants:
        lines.append(f"{INDENT}{v},")
    lines.append("}")
    return "\n".join(lines)


def _emit_struct(s) -> str:
    lines = [f"struct {s.name} {{"]
    for f in s.fields:
        lines.append(f"{INDENT}{f.name}: {f.type_name}")
    lines.append("}")
    return "\n".join(lines)


def _emit_channel(ch) -> str:
    if ch.capacity and ch.capacity != 1:
        return f"channel {ch.name}: {ch.elem_type}[{ch.capacity}]"
    return f"channel {ch.name}: {ch.elem_type}"


def _emit_storage_var(sv) -> str:
    default = _emit_expr(sv.default_value) if sv.default_value else "0"
    return f"storage {sv.name}: {sv.type_name} = {default}"


def _emit_function(func) -> str:
    params = ", ".join(f"{p.name}: {p.type_name}" for p in func.params)
    ret = f" -> {func.return_type}" if func.return_type else ""
    header = f"func {func.name}({params}){ret}"
    return _emit_block_construct(header, func.body)


def _emit_task(task) -> str:
    annotations = ""
    if task.has_strict:
        annotations = "@critical "
    header = f"{annotations}task {task.name}"
    return _emit_block_construct(header, task.body)


def _emit_machine(machine) -> str:
    lines = [f"machine {machine.name} {{"]
    # Machine-level variables
    for var in getattr(machine, 'vars', []):
        lines.append(INDENT + _emit_var_decl(var, 0))
    # States
    for i, state in enumerate(machine.states):
        if i > 0:
            lines.append("")
        lines.extend(_emit_state(state, 1))
    lines.append("}")
    return "\n".join(lines)


def _emit_state(state, depth) -> list:
    ind = INDENT * depth
    is_initial = getattr(state, 'is_initial', False)
    prefix = "initial " if is_initial else ""
    lines = [f"{ind}{prefix}state {state.name} {{"]

    # Enter block
    if state.enter_body:
        enter_str = _emit_body_maybe_inline(state.enter_body, depth + 1)
        if "\n" not in enter_str:
            lines.append(f"{ind}{INDENT}enter {{ {enter_str} }}")
        else:
            lines.append(f"{ind}{INDENT}enter {{")
            for stmt in state.enter_body:
                lines.append(_emit_stmt(stmt, depth + 2))
            lines.append(f"{ind}{INDENT}}}")

    # Exit block
    if state.exit_body:
        exit_str = _emit_body_maybe_inline(state.exit_body, depth + 1)
        if "\n" not in exit_str:
            lines.append(f"{ind}{INDENT}exit {{ {exit_str} }}")
        else:
            lines.append(f"{ind}{INDENT}exit {{")
            for stmt in state.exit_body:
                lines.append(_emit_stmt(stmt, depth + 2))
            lines.append(f"{ind}{INDENT}}}")

    # Event transitions
    for trans in state.transitions:
        lines.append(_emit_event_transition(trans, depth + 1))

    # Timed transitions
    for trans in state.timed_transitions:
        lines.append(_emit_timed_transition(trans, depth + 1))

    lines.append(f"{ind}}}")
    return lines


def _emit_event_transition(trans, depth) -> str:
    ind = INDENT * depth
    guard = f" [{_emit_expr(trans.guard)}]" if trans.guard else ""
    event = _emit_expr(trans.event) if trans.event else ""
    return f"{ind}on {event}{guard} -> {trans.target_state}"


def _emit_timed_transition(trans, depth) -> str:
    ind = INDENT * depth
    guard = f" [{_emit_expr(trans.guard)}]" if trans.guard else ""
    dur = _emit_expr(trans.duration) if trans.duration else "0ms"
    return f"{ind}after {dur}{guard} -> {trans.target_state}"


# ============================================================
# Statements
# ============================================================

def _emit_stmt(stmt, depth) -> str:
    ind = INDENT * depth

    if isinstance(stmt, VarDecl):
        return ind + _emit_var_decl(stmt, 0)

    if isinstance(stmt, AssignExpr):
        return f"{ind}{_emit_expr(stmt.target)} = {_emit_expr(stmt.value)}"

    if isinstance(stmt, CompoundAssign):
        return f"{ind}{_emit_expr(stmt.target)} {stmt.op} {_emit_expr(stmt.value)}"

    if isinstance(stmt, ExprStmt):
        return f"{ind}{_emit_expr(stmt.expr)}"

    if isinstance(stmt, ReturnStmt):
        if stmt.value:
            return f"{ind}return {_emit_expr(stmt.value)}"
        return f"{ind}return"

    if isinstance(stmt, BreakStmt):
        return f"{ind}break"

    if isinstance(stmt, ContinueStmt):
        return f"{ind}continue"

    if isinstance(stmt, BecomeStmt):
        return f"{ind}become {stmt.target}"

    if isinstance(stmt, IfStmt):
        return _emit_if(stmt, depth)

    if isinstance(stmt, WhileStmt):
        return _emit_block_stmt(f"while {_emit_expr(stmt.condition)}", stmt.body, depth)

    if isinstance(stmt, ForStmt):
        step = f" step {_emit_expr(stmt.step)}" if stmt.step else ""
        header = f"for {stmt.var_name} in {_emit_expr(stmt.start)}..{_emit_expr(stmt.end)}{step}"
        return _emit_block_stmt(header, stmt.body, depth)

    if isinstance(stmt, EveryBlock):
        strict = " strict" if stmt.strict else ""
        guard = f" when {_emit_expr(stmt.guard)}" if stmt.guard else ""
        header = f"every {_emit_expr(stmt.interval)}{strict}{guard}"
        return _emit_block_stmt(header, stmt.body, depth)

    if isinstance(stmt, OnBlock):
        deb = f" debounce {_emit_expr(stmt.debounce)}" if stmt.debounce else ""
        thr = f" throttle {_emit_expr(stmt.throttle)}" if stmt.throttle else ""
        header = f"on {_emit_expr(stmt.event)}{deb}{thr}"
        return _emit_block_stmt(header, stmt.body, depth)

    if isinstance(stmt, TimeoutBlock):
        header = f"timeout {_emit_expr(stmt.duration)}"
        lines = [f"{ind}{header} {{"]
        for s in stmt.try_body:
            lines.append(_emit_stmt(s, depth + 1))
        lines.append(f"{ind}}} else {{")
        for s in stmt.fallback_body:
            lines.append(_emit_stmt(s, depth + 1))
        lines.append(f"{ind}}}")
        return "\n".join(lines)

    if isinstance(stmt, TryBlock):
        # Format:
        #   try {
        #       <body>
        #   } or <policy>
        if stmt.policy == "retry" and stmt.retry_limit is None:
            tail = "or retry"
        elif stmt.policy == "retry":
            tail = f"or retry {stmt.retry_limit} times else {stmt.terminal}"
        else:
            tail = f"or {stmt.policy}"
        lines = [f"{ind}try {{"]
        for s in stmt.body:
            lines.append(_emit_stmt(s, depth + 1))
        lines.append(f"{ind}}} {tail}")
        return "\n".join(lines)

    if isinstance(stmt, MatchStmt):
        return _emit_match(stmt, depth)

    # Fallback: stringify
    return f"{ind}// (unformatted: {type(stmt).__name__})"


def _emit_var_decl(v, _unused_depth) -> str:
    keyword = "let" if not v.mutable else "var"
    shared = "shared " if getattr(v, 'shared', False) else ""
    type_ann = f": {v.type_name}" if v.type_name else ""
    value = f" = {_emit_expr(v.value)}" if v.value else ""
    return f"{shared}{keyword} {v.name}{type_ann}{value}"


def _emit_if(stmt, depth) -> str:
    ind = INDENT * depth
    lines = []

    # First if
    lines.append(f"{ind}if {_emit_expr(stmt.condition)} {{")
    for s in stmt.then_body:
        lines.append(_emit_stmt(s, depth + 1))

    # Else / else if
    if stmt.else_body:
        if isinstance(stmt.else_body, IfStmt):
            # else if — emit on same line as closing brace
            else_if = _emit_if(stmt.else_body, depth).lstrip()
            lines.append(f"{ind}}} else {else_if}")
            return "\n".join(lines)
        elif isinstance(stmt.else_body, list) and stmt.else_body:
            lines.append(f"{ind}}} else {{")
            for s in stmt.else_body:
                lines.append(_emit_stmt(s, depth + 1))

    lines.append(f"{ind}}}")
    return "\n".join(lines)


def _emit_match(stmt, depth) -> str:
    ind = INDENT * depth
    lines = [f"{ind}match({_emit_expr(stmt.expr)}) {{"]
    for arm in stmt.arms:
        pattern = arm.pattern if isinstance(arm.pattern, str) else str(arm.pattern)
        if not pattern.startswith(".") and not pattern.startswith("_") and not pattern.isdigit():
            pattern = f".{pattern}"
        body = _emit_expr(arm.body) if not isinstance(arm.body, list) else "; ".join(
            _emit_stmt(s, 0).strip() for s in arm.body)
        lines.append(f"{ind}{INDENT}{pattern} -> {body}")
    lines.append(f"{ind}}}")
    return "\n".join(lines)


# ============================================================
# Expressions
# ============================================================

def _emit_expr(expr) -> str:
    if expr is None:
        return ""

    if isinstance(expr, IntLiteral):
        return str(expr.value)

    if isinstance(expr, FloatLiteral):
        return str(expr.value)

    if isinstance(expr, StringLiteral):
        return f'"{expr.value}"'

    if isinstance(expr, BoolLiteral):
        return "true" if expr.value else "false"

    if isinstance(expr, DurationLiteral):
        if hasattr(expr, 'original') and expr.original:
            return expr.original
        return f"{expr.milliseconds}ms"

    if isinstance(expr, VarRef):
        return expr.name

    if isinstance(expr, BinaryExpr):
        left = _emit_expr(expr.left)
        right = _emit_expr(expr.right)
        return f"{left} {expr.op} {right}"

    if isinstance(expr, UnaryExpr):
        operand = _emit_expr(expr.operand)
        if expr.op == "!":
            return f"!{operand}"
        if expr.op == "-":
            return f"-{operand}"
        if expr.op == "~":
            return f"~{operand}"
        return f"{expr.op}{operand}"

    if isinstance(expr, FuncCall):
        args = ", ".join(_emit_expr(a) for a in expr.args)
        return f"{expr.name}({args})"

    if isinstance(expr, MethodCall):
        obj = _emit_expr(expr.obj)
        args = ", ".join(_emit_expr(a) for a in expr.args)
        return f"{obj}.{expr.method}({args})"

    if isinstance(expr, DotAccess):
        obj = _emit_expr(expr.obj)
        return f"{obj}.{expr.field_name}"

    if isinstance(expr, AssignExpr):
        return f"{_emit_expr(expr.target)} = {_emit_expr(expr.value)}"

    if isinstance(expr, OrExpr):
        call = _emit_expr(expr.expr)
        if expr.kind == "skip":
            return f"{call} or skip"
        if expr.kind == "restart":
            return f"{call} or restart"
        if expr.kind == "retry":
            count = _emit_expr(expr.fallback)
            return f"{call} or retry({count})"
        if expr.fallback:
            return f"{call} or {_emit_expr(expr.fallback)}"
        return f"{call} or skip"

    if isinstance(expr, ArrayLiteral):
        elems = ", ".join(_emit_expr(e) for e in expr.elements)
        return f"[{elems}]"

    # Fallback
    return str(expr)


# ============================================================
# Helpers
# ============================================================

def _emit_block_construct(header: str, body: list) -> str:
    """Emit 'header { body }' with proper indentation."""
    lines = [f"{header} {{"]
    for stmt in body:
        lines.append(_emit_stmt(stmt, 1))
    lines.append("}")
    return "\n".join(lines)


def _emit_block_stmt(header: str, body: list, depth: int) -> str:
    """Emit indented 'header { body }' at given depth."""
    ind = INDENT * depth

    # Try single-line if body is short
    inline = _emit_body_maybe_inline(body, depth)
    if inline and "\n" not in inline and len(f"{ind}{header} {{ {inline} }}") < ONE_LINE_THRESHOLD:
        return f"{ind}{header} {{ {inline} }}"

    lines = [f"{ind}{header} {{"]
    for stmt in body:
        lines.append(_emit_stmt(stmt, depth + 1))
    lines.append(f"{ind}}}")
    return "\n".join(lines)


def _emit_body_maybe_inline(body: list, depth: int) -> str:
    """Try to emit body as single line. Returns None if too complex."""
    if not body:
        return ""
    if len(body) == 1:
        text = _emit_stmt(body[0], 0).strip()
        if "\n" not in text and len(text) < ONE_LINE_THRESHOLD:
            return text
    return "\n".join(_emit_stmt(s, depth + 1) for s in body)


def _basic_format(source: str) -> str:
    """Fallback brace-based formatter when parsing fails."""
    lines = source.split("\n")
    indent = 0
    result = []
    for raw in lines:
        trimmed = raw.strip()
        if not trimmed:
            result.append("")
            continue
        if trimmed.startswith("}"):
            indent = max(0, indent - 1)
        result.append(INDENT * indent + trimmed)
        if trimmed.endswith("{"):
            indent += 1
    return "\n".join(result)
