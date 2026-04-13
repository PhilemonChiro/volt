"""
Volt Resolver — Pass 2: Name Resolution

Two-pass name resolution:
  Pass 2a: Register all top-level declarations (funcs, tasks, structs, pins, etc.)
  Pass 2b: Walk all bodies and resolve every name reference.

Input:  AST (Program node)
Output: Populated symbol table, errors for unknown/duplicate names
"""

from .ast_nodes import *
from .symbols import Symbol, Scope
from .errors import CompilerErrors, suggest_similar


# Names that exist without being declared in .volt source
BUILTINS = {
    "wifi":       Symbol("wifi", "builtin", "WiFi", Region()),
    "mqtt":       Symbol("mqtt", "builtin", "MQTT", Region()),
    "http":       Symbol("http", "builtin", "HTTP", Region()),
    "storage":    Symbol("storage", "builtin", "Storage", Region()),
    "system":     Symbol("system", "builtin", "System", Region()),
    "ota":        Symbol("ota", "builtin", "OTA", Region()),
    "log":        Symbol("log", "builtin", "func", Region()),
    "run":        Symbol("run", "builtin", "func", Region()),
    "sleep":      Symbol("sleep", "builtin", "func", Region()),
    "deep_sleep": Symbol("deep_sleep", "builtin", "func", Region()),
    "light_sleep": Symbol("light_sleep", "builtin", "func", Region()),
    "true":       Symbol("true", "builtin", "bool", Region()),
    "false":      Symbol("false", "builtin", "bool", Region()),
}


def resolve(program: Program, errors: CompilerErrors) -> Scope:
    """
    Run two-pass name resolution on the program.
    Returns the global scope with all symbols registered.
    """
    global_scope = Scope(name="global")

    # Register builtins
    for sym in BUILTINS.values():
        global_scope.declare(sym)

    # Pass 2a: collect all top-level declarations
    _collect_declarations(program, global_scope, errors)

    # Pass 2b: resolve names in all bodies
    _resolve_bodies(program, global_scope, errors)

    return global_scope


# ============================================================
# Pass 2a: Collect Declarations
# ============================================================

def _collect_declarations(program: Program, scope: Scope, errors: CompilerErrors):
    """Register all top-level names without examining bodies."""

    # Pins from hardware block
    if program.hardware:
        for pin in program.hardware.pins:
            _declare_or_error(scope, Symbol(
                pin.name, "pin", pin.mode, pin.region,
            ), errors)

        for bus in program.hardware.buses:
            _declare_or_error(scope, Symbol(
                bus.name, "bus", bus.bus_type, bus.region,
            ), errors)

        for sensor in program.hardware.sensors:
            _declare_or_error(scope, Symbol(
                sensor.name, "sensor", sensor.sensor_type, sensor.region,
            ), errors)

    # Structs
    for struct in program.structs:
        _declare_or_error(scope, Symbol(
            struct.name, "struct", struct.name, struct.region,
        ), errors)

    # Functions (register name + signature, don't look at body)
    for func in program.functions:
        params = [(p.name, p.type_name) for p in func.params]
        _declare_or_error(scope, Symbol(
            func.name, "func", func.return_type or "void", func.region,
            params=params, return_type=func.return_type,
        ), errors)

    # Tasks
    for task in program.tasks:
        _declare_or_error(scope, Symbol(
            task.name, "task", "task", task.region,
        ), errors)

    # State machines
    for machine in program.machines:
        _declare_or_error(scope, Symbol(
            machine.name, "machine", machine.name, machine.region,
        ), errors)

    # Storage variables
    for storage in program.storage_vars:
        _declare_or_error(scope, Symbol(
            storage.name, "storage", storage.type_name, storage.region,
            mutable=True,
        ), errors)

    # Channels
    for ch in program.channels:
        _declare_or_error(scope, Symbol(
            ch.name, "channel", f"channel<{ch.elem_type}>", ch.region,
            mutable=True,
        ), errors)

    # Global variables
    # NOTE: We can't infer types here (need type checker). Defer to checker.
    # But we'll try to infer from simple literals for common cases.
    for var in program.global_vars:
        inferred_type = var.type_name
        if not inferred_type and var.value:
            # Simple heuristic: infer int/float/bool from literal values
            if isinstance(var.value, IntLiteral):
                inferred_type = "int"
            elif isinstance(var.value, FloatLiteral):
                inferred_type = "float"
            elif isinstance(var.value, BoolLiteral):
                inferred_type = "bool"
            elif isinstance(var.value, StringLiteral):
                inferred_type = "string"

        _declare_or_error(scope, Symbol(
            var.name, "var", inferred_type or "unknown", var.region,
            mutable=var.mutable,
        ), errors)


def _declare_or_error(scope: Scope, symbol: Symbol, errors: CompilerErrors):
    """Declare a symbol. If duplicate, report error."""
    existing = scope.declare(symbol)
    if existing is not None and existing.kind != "builtin":
        errors.error(
            symbol.region, "NAME ERROR",
            f"Name `{symbol.name}` is already declared.",
            hint=f"First declared at line {existing.region.start_line}.",
        )


# ============================================================
# Pass 2b: Resolve Names in Bodies
# ============================================================

def _resolve_bodies(program: Program, global_scope: Scope, errors: CompilerErrors):
    """Walk all function/task/main bodies and resolve name references."""

    # Functions
    for func in program.functions:
        func_scope = global_scope.child(f"func:{func.name}")
        for param in func.params:
            func_scope.declare(Symbol(
                param.name, "param", param.type_name, param.region,
            ))
        _resolve_stmts(func.body, func_scope, errors)

    # Tasks
    for task in program.tasks:
        task_scope = global_scope.child(f"task:{task.name}")
        _resolve_stmts(task.body, task_scope, errors)

    # State machines
    for machine in program.machines:
        machine_scope = global_scope.child(f"machine:{machine.name}")
        # Register machine variables in scope
        for var in machine.variables:
            if var.value:
                _resolve_expr(var.value, machine_scope, errors)
            machine_scope.declare(Symbol(
                var.name, "var", var.type_name or "unknown", var.region,
                mutable=var.mutable,
            ))
        for state in machine.states:
            _resolve_stmts(state.enter_body, machine_scope, errors)
            _resolve_stmts(state.exit_body, machine_scope, errors)
            _resolve_stmts(state.body, machine_scope, errors)
            # Event expressions in transitions are abstract — don't resolve as function calls.
            # They represent hardware/system events, not user-defined functions.
            # Guards and actions DO get resolved.
            for trans in state.transitions:
                if trans.guard:
                    _resolve_expr(trans.guard, machine_scope, errors)
                _resolve_stmts(trans.action, machine_scope, errors)
            for timed in state.timed_transitions:
                # Duration gets resolved (it's an expression)
                _resolve_expr(timed.duration, machine_scope, errors)
                if timed.guard:
                    _resolve_expr(timed.guard, machine_scope, errors)
                _resolve_stmts(timed.action, machine_scope, errors)

    # Setup block
    if program.setup:
        setup_scope = global_scope.child("setup")
        _resolve_stmts(program.setup.body, setup_scope, errors)

    # Loop block
    if program.loop:
        loop_scope = global_scope.child("loop")
        _resolve_stmts(program.loop.body, loop_scope, errors)


def _resolve_stmts(stmts: list, scope: Scope, errors: CompilerErrors):
    """Resolve all names in a list of statements."""
    for stmt in stmts:
        _resolve_stmt(stmt, scope, errors)


def _resolve_stmt(stmt, scope: Scope, errors: CompilerErrors):
    """Resolve names in a single statement."""
    if stmt is None:
        return

    if isinstance(stmt, VarDecl):
        # Resolve the value expression first (before declaring the var)
        if stmt.value:
            _resolve_expr(stmt.value, scope, errors)
        # Declare the variable in current scope
        scope.declare(Symbol(
            stmt.name, "var", stmt.type_name or "unknown", stmt.region,
            mutable=stmt.mutable,
        ))

    elif isinstance(stmt, AssignExpr):
        _resolve_expr(stmt.target, scope, errors)
        _resolve_expr(stmt.value, scope, errors)

    elif isinstance(stmt, CompoundAssign):
        _resolve_expr(stmt.target, scope, errors)
        _resolve_expr(stmt.value, scope, errors)

    elif isinstance(stmt, ExprStmt):
        _resolve_expr(stmt.expr, scope, errors)

    elif isinstance(stmt, ReturnStmt):
        if stmt.value:
            _resolve_expr(stmt.value, scope, errors)

    elif isinstance(stmt, IfStmt):
        _resolve_expr(stmt.condition, scope, errors)
        _resolve_stmts(stmt.then_body, scope, errors)
        if stmt.else_body is not None:
            if isinstance(stmt.else_body, list):
                _resolve_stmts(stmt.else_body, scope, errors)
            elif isinstance(stmt.else_body, IfStmt):
                _resolve_stmt(stmt.else_body, scope, errors)

    elif isinstance(stmt, WhileStmt):
        _resolve_expr(stmt.condition, scope, errors)
        _resolve_stmts(stmt.body, scope, errors)

    elif isinstance(stmt, ForStmt):
        _resolve_expr(stmt.start, scope, errors)
        _resolve_expr(stmt.end, scope, errors)
        # Declare loop variable in a child scope
        for_scope = scope.child(f"for:{stmt.var_name}")
        for_scope.declare(Symbol(
            stmt.var_name, "var", "int", stmt.region,
        ))
        _resolve_stmts(stmt.body, for_scope, errors)

    elif isinstance(stmt, EveryBlock):
        _resolve_expr(stmt.interval, scope, errors)
        _resolve_stmts(stmt.body, scope, errors)

    elif isinstance(stmt, OnBlock):
        _resolve_expr(stmt.event, scope, errors)
        if stmt.debounce:
            _resolve_expr(stmt.debounce, scope, errors)
        if stmt.throttle:
            _resolve_expr(stmt.throttle, scope, errors)
        _resolve_stmts(stmt.body, scope, errors)

    elif isinstance(stmt, TimeoutBlock):
        _resolve_expr(stmt.duration, scope, errors)
        _resolve_stmts(stmt.try_body, scope, errors)
        _resolve_stmts(stmt.fallback_body, scope, errors)

    elif isinstance(stmt, MatchStmt):
        _resolve_expr(stmt.expr, scope, errors)
        for arm in stmt.arms:
            if isinstance(arm.body, list):
                _resolve_stmts(arm.body, scope, errors)
            elif isinstance(arm.body, Node):
                _resolve_expr(arm.body, scope, errors)


def _resolve_expr(expr, scope: Scope, errors: CompilerErrors):
    """Resolve names in an expression."""
    if expr is None:
        return

    if isinstance(expr, VarRef):
        sym = scope.lookup(expr.name)
        if sym is None:
            suggestion = suggest_similar(expr.name, scope.all_names())
            hint = f"Did you mean `{suggestion}`?" if suggestion else None
            errors.error(expr.region, "NAME ERROR",
                         f"Unknown name `{expr.name}`.", hint=hint)

    elif isinstance(expr, BinaryExpr):
        _resolve_expr(expr.left, scope, errors)
        _resolve_expr(expr.right, scope, errors)

    elif isinstance(expr, UnaryExpr):
        _resolve_expr(expr.operand, scope, errors)

    elif isinstance(expr, DotAccess):
        # Resolve the object, but NOT the field name (that's a property, not a scope name)
        _resolve_expr(expr.obj, scope, errors)

    elif isinstance(expr, FuncCall):
        sym = scope.lookup(expr.name)
        if sym is None:
            suggestion = suggest_similar(expr.name, scope.all_names())
            hint = f"Did you mean `{suggestion}`?" if suggestion else None
            errors.error(expr.region, "NAME ERROR",
                         f"Unknown function `{expr.name}`.", hint=hint)
        for arg in expr.args:
            _resolve_expr(arg, scope, errors)

    elif isinstance(expr, MethodCall):
        # Resolve the object, but the method name is validated by the type checker
        _resolve_expr(expr.obj, scope, errors)
        for arg in expr.args:
            _resolve_expr(arg, scope, errors)

    elif isinstance(expr, ArrayLiteral):
        for elem in expr.elements:
            _resolve_expr(elem, scope, errors)

    # Literals don't need resolution
    elif isinstance(expr, (IntLiteral, FloatLiteral, BoolLiteral,
                           StringLiteral, DurationLiteral)):
        pass
