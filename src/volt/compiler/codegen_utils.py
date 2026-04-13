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
            names |= collect_var_refs(stmt.body)
        elif isinstance(stmt, EveryBlock):
            names |= collect_var_refs(stmt.body)
        elif isinstance(stmt, OnBlock):
            names |= collect_expr_refs(stmt.event)
            names |= collect_var_refs(stmt.body)
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


def find_var_decls_by_name(stmts: list, names: list):
    """Find VarDecl nodes with specific names in a statement list."""
    for stmt in stmts:
        if isinstance(stmt, VarDecl) and stmt.name in names:
            yield stmt
        if isinstance(stmt, EveryBlock):
            yield from find_var_decls_by_name(stmt.body, names)
        if isinstance(stmt, OnBlock):
            yield from find_var_decls_by_name(stmt.body, names)


def find_calls(stmts: list, obj_name: str):
    """Find method calls on a specific object in a statement list."""
    for stmt in stmts:
        if isinstance(stmt, ExprStmt) and isinstance(stmt.expr, MethodCall):
            if isinstance(stmt.expr.obj, VarRef) and stmt.expr.obj.name == obj_name:
                yield stmt
        if isinstance(stmt, EveryBlock):
            yield from find_calls(stmt.body, obj_name)
        if isinstance(stmt, OnBlock):
            yield from find_calls(stmt.body, obj_name)
