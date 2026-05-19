"""
Codegen Utilities — helper functions for C code generation.

Extracted from codegen.py for separation of concerns.
These are pure functions with no dependency on the CCodeGen class.
"""

from .ast_nodes import *


# C keywords that Volt names might collide with
C_KEYWORDS = {
    "auto", "break", "case", "char", "const", "continue", "default",
    "do", "double", "else", "enum", "extern", "float", "for", "goto",
    "if", "int", "long", "register", "return", "short", "signed",
    "sizeof", "static", "struct", "switch", "typedef", "union",
    "unsigned", "void", "volatile", "while", "NULL", "bool",
}

# Volt type → C type
TYPE_MAP = {
    "int": "int32_t",
    "i8": "int8_t",
    "i16": "int16_t",
    "i32": "int32_t",
    "u8": "uint8_t",
    "u16": "uint16_t",
    "u32": "uint32_t",
    "float": "float",
    "bool": "bool",
    "string": "const char*",
    "void": "void",
    "Duration": "uint32_t",
    "unknown": "int32_t",
}


def c_name(name: str) -> str:
    """Escape Volt names that collide with C keywords."""
    if name in C_KEYWORDS:
        return f"v_{name}"
    return name


def collect_var_refs(stmts: list) -> set:
    """Collect all variable names referenced in a statement list (recursive)."""
    names = set()
    for stmt in stmts:
        if stmt is None:
            continue
        if isinstance(stmt, VarDecl) and stmt.value:
            names |= collect_expr_refs(stmt.value)
        elif isinstance(stmt, AssignExpr):
            if isinstance(stmt.target, VarRef):
                names.add(stmt.target.name)
            names |= collect_expr_refs(stmt.value)
        elif isinstance(stmt, CompoundAssign):
            if isinstance(stmt.target, VarRef):
                names.add(stmt.target.name)
            names |= collect_expr_refs(stmt.value)
        elif isinstance(stmt, ExprStmt):
            names |= collect_expr_refs(stmt.expr)
        elif isinstance(stmt, ReturnStmt) and stmt.value:
            names |= collect_expr_refs(stmt.value)
        elif isinstance(stmt, IfStmt):
            names |= collect_expr_refs(stmt.condition)
            names |= collect_var_refs(stmt.then_body)
            if isinstance(stmt.else_body, list):
                names |= collect_var_refs(stmt.else_body)
            elif isinstance(stmt.else_body, IfStmt):
                names |= collect_var_refs([stmt.else_body])
        elif isinstance(stmt, WhileStmt):
            names |= collect_expr_refs(stmt.condition)
            names |= collect_var_refs(stmt.body)
        elif isinstance(stmt, ForStmt):
            names |= collect_expr_refs(stmt.start)
            names |= collect_expr_refs(stmt.end)
            if stmt.step:
                names |= collect_expr_refs(stmt.step)
            names |= collect_var_refs(stmt.body)
        elif isinstance(stmt, EveryBlock):
            names |= collect_expr_refs(stmt.interval)
            names |= collect_var_refs(stmt.body)
        elif isinstance(stmt, OnBlock):
            names |= collect_expr_refs(stmt.event)
            names |= collect_var_refs(stmt.body)
        elif isinstance(stmt, TimeoutBlock):
            names |= collect_expr_refs(stmt.duration)
            names |= collect_var_refs(stmt.try_body)
            names |= collect_var_refs(stmt.fallback_body)
    return names


def collect_expr_refs(expr) -> set:
    """Collect all variable names from an expression tree."""
    if expr is None:
        return set()
    names = set()
    if isinstance(expr, VarRef):
        names.add(expr.name)
    elif isinstance(expr, BinaryExpr):
        names |= collect_expr_refs(expr.left)
        names |= collect_expr_refs(expr.right)
    elif isinstance(expr, UnaryExpr):
        names |= collect_expr_refs(expr.operand)
    elif isinstance(expr, FuncCall):
        for arg in expr.args:
            names |= collect_expr_refs(arg)
    elif isinstance(expr, MethodCall):
        names |= collect_expr_refs(expr.obj)
        for arg in expr.args:
            names |= collect_expr_refs(arg)
    elif isinstance(expr, AssignExpr):
        if isinstance(expr.target, VarRef):
            names.add(expr.target.name)
        names |= collect_expr_refs(expr.value)
    elif isinstance(expr, StringLiteral):
        import re
        for match in re.finditer(r'\{(\w+)(?:\.\w+\(\))?\}', expr.value):
            names.add(match.group(1))
    elif isinstance(expr, DotAccess):
        names |= collect_expr_refs(expr.obj)
    return names


def _sub_bodies(stmt):
    """Yield all child statement lists from a compound statement."""
    if isinstance(stmt, EveryBlock):
        yield stmt.body
    elif isinstance(stmt, OnBlock):
        yield stmt.body
    elif isinstance(stmt, IfStmt):
        yield stmt.then_body
        if isinstance(stmt.else_body, list):
            yield stmt.else_body
        elif isinstance(stmt.else_body, IfStmt):
            yield [stmt.else_body]
    elif isinstance(stmt, WhileStmt):
        yield stmt.body
    elif isinstance(stmt, ForStmt):
        yield stmt.body
    elif isinstance(stmt, TimeoutBlock):
        yield stmt.try_body
        yield stmt.fallback_body
    elif isinstance(stmt, MatchStmt):
        for arm in stmt.arms:
            if isinstance(arm.body, list):
                yield arm.body


def find_var_decls_by_name(stmts: list, names: list):
    """Find VarDecl nodes with specific names in a statement list (recursive)."""
    for stmt in stmts:
        if isinstance(stmt, VarDecl) and stmt.name in names:
            yield stmt
        for body in _sub_bodies(stmt):
            yield from find_var_decls_by_name(body, names)


def find_calls(stmts: list, obj_name: str):
    """Find statements containing method calls on a specific object (recursive).
    Checks ALL expressions in every statement type:
    - Direct calls: wifi.connect()
    - Or-wrapped: wifi.connect() or retry(3)
    - Conditions: if wifi.is_connected() { ... }, while wifi.is_connected() { ... }
    - Var inits: var x = wifi.is_connected()
    - Assignments: status = wifi.is_connected()
    - Return values: return wifi.is_connected()
    - Guards: every 1s when wifi.is_connected() { ... }
    - Event triggers: on wifi.on_connect() { ... }
    - Compound assigns: count += wifi.get_rssi()
    - Nested inside binary/unary expressions: x && wifi.is_connected()
    """
    for stmt in stmts:
        if _stmt_has_call(stmt, obj_name):
            yield stmt
        for body in _sub_bodies(stmt):
            yield from find_calls(body, obj_name)


def _stmt_has_call(stmt, obj_name: str) -> bool:
    """Check if a statement's expressions contain a method call on obj_name."""
    if isinstance(stmt, ExprStmt):
        return _expr_has_call(stmt.expr, obj_name)
    if isinstance(stmt, VarDecl):
        return stmt.value is not None and _expr_has_call(stmt.value, obj_name)
    if isinstance(stmt, AssignExpr):
        return _expr_has_call(stmt.target, obj_name) or _expr_has_call(stmt.value, obj_name)
    if isinstance(stmt, CompoundAssign):
        return _expr_has_call(stmt.target, obj_name) or _expr_has_call(stmt.value, obj_name)
    if isinstance(stmt, ReturnStmt):
        return stmt.value is not None and _expr_has_call(stmt.value, obj_name)
    if isinstance(stmt, IfStmt):
        return _expr_has_call(stmt.condition, obj_name)
    if isinstance(stmt, WhileStmt):
        return _expr_has_call(stmt.condition, obj_name)
    if isinstance(stmt, ForStmt):
        return (_expr_has_call(stmt.start, obj_name)
                or _expr_has_call(stmt.end, obj_name)
                or (stmt.step is not None and _expr_has_call(stmt.step, obj_name)))
    if isinstance(stmt, EveryBlock):
        return ((stmt.guard is not None and _expr_has_call(stmt.guard, obj_name))
                or _expr_has_call(stmt.interval, obj_name))
    if isinstance(stmt, OnBlock):
        return _expr_has_call(stmt.event, obj_name)
    if isinstance(stmt, TimeoutBlock):
        return _expr_has_call(stmt.duration, obj_name)
    if isinstance(stmt, MatchStmt):
        return _expr_has_call(stmt.expr, obj_name)
    return False


def _expr_has_call(expr, obj_name: str) -> bool:
    """Recursively check if an expression tree contains a method call on obj_name."""
    if expr is None:
        return False
    if isinstance(expr, MethodCall):
        if isinstance(expr.obj, VarRef) and expr.obj.name == obj_name:
            return True
        # Recurse into method args too: foo(wifi.is_connected())
        if _expr_has_call(expr.obj, obj_name):
            return True
        for arg in expr.args:
            if _expr_has_call(arg, obj_name):
                return True
        return False
    if isinstance(expr, BinaryExpr):
        return _expr_has_call(expr.left, obj_name) or _expr_has_call(expr.right, obj_name)
    if isinstance(expr, UnaryExpr):
        return _expr_has_call(expr.operand, obj_name)
    if isinstance(expr, OrExpr):
        return _expr_has_call(expr.expr, obj_name) or _expr_has_call(expr.fallback, obj_name)
    if isinstance(expr, FuncCall):
        for arg in expr.args:
            if _expr_has_call(arg, obj_name):
                return True
        return False
    if isinstance(expr, AssignExpr):
        return _expr_has_call(expr.target, obj_name) or _expr_has_call(expr.value, obj_name)
    if isinstance(expr, DotAccess):
        return _expr_has_call(expr.obj, obj_name)
    return False
