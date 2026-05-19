"""Symbol scanner for Volt source — invoked from main.js via stdin/stdout.

Reads Volt source from stdin, prints a JSON array of symbols (with definition
sites and reference locations) to stdout. Used by the IDE for outline panels
and jump-to-definition.

Args:
    argv[1]: path to the Volt compiler src/ root (so we can import volt.compiler.*)
"""
import json
import sys

if len(sys.argv) < 2:
    print("[]")
    sys.exit(0)

sys.path.insert(0, sys.argv[1])

try:
    from volt.compiler.parser import parse
    from volt.compiler.resolver import resolve
    from volt.compiler.errors import CompilerErrors
    from volt.compiler.ast_nodes import (
        AssignExpr,
        BinaryExpr,
        CompoundAssign,
        DotAccess,
        EveryBlock,
        ExprStmt,
        ForStmt,
        FuncCall,
        IfStmt,
        MatchStmt,
        MethodCall,
        OnBlock,
        ReturnStmt,
        TimeoutBlock,
        UnaryExpr,
        VarDecl,
        VarRef,
        WhileStmt,
    )
except Exception:
    print("[]")
    sys.exit(0)

source = sys.stdin.read()

try:
    program = parse(source)
except Exception:
    print("[]")
    sys.exit(0)

errors = CompilerErrors()
errors.set_source(source)
try:
    resolve(program, errors)
except Exception:
    pass

symbols = {}


def add(key, name, kind, region):
    if region is None:
        return
    symbols[key] = {
        "name": name,
        "kind": kind,
        "def_line": region.start_line,
        "def_col": region.start_col,
        "refs": [],
    }


if program.hardware:
    for pin in program.hardware.pins:
        add(pin.name, pin.name, "pin", pin.region)
    for sensor in program.hardware.sensors:
        add(sensor.name, sensor.name, "sensor", sensor.region)
    for bus in program.hardware.buses:
        add(bus.name, bus.name, "bus", bus.region)

for func in program.functions:
    add(func.name, func.name, "func", func.region)
    for param in func.params:
        add(param.name, param.name, "param", param.region)

for task in program.tasks:
    add(task.name, task.name, "task", task.region)

for machine in program.machines:
    add(machine.name, machine.name, "machine", machine.region)
    for state in machine.states:
        add(f"{machine.name}.{state.name}", state.name, "state", state.region)

for sv in program.storage_vars:
    add(sv.name, sv.name, "storage", sv.region)

for gv in program.global_vars:
    add(gv.name, gv.name, "var", gv.region)


def record_ref(name, region):
    if region is None or name not in symbols:
        return
    symbols[name]["refs"].append({"line": region.start_line, "col": region.start_col})


def walk_expr(expr):
    if expr is None:
        return
    if isinstance(expr, VarRef):
        record_ref(expr.name, expr.region)
    elif isinstance(expr, BinaryExpr):
        walk_expr(expr.left)
        walk_expr(expr.right)
    elif isinstance(expr, UnaryExpr):
        walk_expr(expr.operand)
    elif isinstance(expr, DotAccess):
        walk_expr(expr.obj)
    elif isinstance(expr, FuncCall):
        record_ref(expr.name, expr.region)
        for arg in expr.args:
            walk_expr(arg)
    elif isinstance(expr, MethodCall):
        walk_expr(expr.obj)
        for arg in expr.args:
            walk_expr(arg)
    elif isinstance(expr, AssignExpr):
        walk_expr(expr.target)
        walk_expr(expr.value)


def walk_stmts(stmts):
    for stmt in stmts or []:
        if stmt is None:
            continue
        if isinstance(stmt, VarDecl):
            if stmt.name not in symbols:
                add(stmt.name, stmt.name, "var", stmt.region)
            walk_expr(stmt.value)
        elif isinstance(stmt, (AssignExpr, CompoundAssign)):
            walk_expr(stmt.target)
            walk_expr(stmt.value)
        elif isinstance(stmt, ExprStmt):
            walk_expr(stmt.expr)
        elif isinstance(stmt, ReturnStmt):
            walk_expr(stmt.value)
        elif isinstance(stmt, IfStmt):
            walk_expr(stmt.condition)
            walk_stmts(stmt.then_body)
            if isinstance(stmt.else_body, list):
                walk_stmts(stmt.else_body)
            elif isinstance(stmt.else_body, IfStmt):
                walk_stmts([stmt.else_body])
        elif isinstance(stmt, WhileStmt):
            walk_expr(stmt.condition)
            walk_stmts(stmt.body)
        elif isinstance(stmt, ForStmt):
            walk_expr(stmt.start)
            walk_expr(stmt.end)
            walk_stmts(stmt.body)
        elif isinstance(stmt, EveryBlock):
            walk_stmts(stmt.body)
        elif isinstance(stmt, OnBlock):
            walk_expr(stmt.event)
            walk_stmts(stmt.body)
        elif isinstance(stmt, TimeoutBlock):
            walk_stmts(stmt.try_body)
            walk_stmts(stmt.fallback_body)
        elif isinstance(stmt, MatchStmt):
            walk_expr(stmt.expr)


for func in program.functions:
    walk_stmts(func.body)
for task in program.tasks:
    walk_stmts(task.body)
for machine in program.machines:
    for state in machine.states:
        walk_stmts(state.enter_body)
        walk_stmts(state.exit_body)
        walk_stmts(state.body)
if program.setup:
    walk_stmts(program.setup.body)
if program.loop:
    walk_stmts(program.loop.body)

print(json.dumps(list(symbols.values())))
