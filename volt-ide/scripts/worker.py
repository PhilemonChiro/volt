"""Long-lived Volt compiler worker.

Started once by main.js, then receives JSON-line requests on stdin and writes
JSON-line responses to stdout. The expensive imports (Lark, the whole compiler
chain) happen once at startup — every subsequent compile is ~5ms instead of
~194ms for a fresh subprocess invocation.

Protocol:
  Request:  {"id": "<seq>", "op": "<name>", ...op-specific fields}
  Response: {"id": "<seq>", "ok": true,  "result": ...}
            {"id": "<seq>", "ok": false, "error": "..."}
  Ready signal at startup: {"id": "_ready", "ok": true}

Ops: compile_full, format_code, find_symbols
"""
import json
import os
import sys
import traceback

if len(sys.argv) < 2:
    sys.stderr.write("worker.py: missing volt src path\n")
    sys.exit(1)

sys.path.insert(0, sys.argv[1])

# Eager imports — pay the 166ms cost once
from volt.compiler.voltc import compile_volt
from volt.compiler.parser import parse
from volt.compiler.resolver import resolve
from volt.compiler.checker import check_types
from volt.compiler.errors import CompilerErrors
from volt.compiler.formatter import format_source
from volt.compiler.ast_nodes import (
    AssignExpr, BinaryExpr, CompoundAssign, DotAccess, EveryBlock,
    ExprStmt, ForStmt, FuncCall, IfStmt, MatchStmt, MethodCall,
    OnBlock, ReturnStmt, TimeoutBlock, UnaryExpr, VarDecl, VarRef,
    WhileStmt,
)


def handle_compile_full(req, emit_progress=None):
    """compile + AST extraction for diagnostics and side-panel rendering.

    If emit_progress is callable, it's invoked as emit_progress(phase, pct)
    after each compiler pass.
    """
    source = req["source"]
    filename = req.get("filename", "main.volt")

    c_code, errors = compile_volt(source, filename, progress=emit_progress)

    # Re-parse to extract AST (compile_volt doesn't return the program)
    program = None
    try:
        errs2 = CompilerErrors()
        errs2.set_source(source)
        program = parse(source)
        scope = resolve(program, errs2)
        check_types(program, scope, errs2)
    except Exception:
        pass

    result = {
        "diagnostics": [{
            "line": e.region.start_line if e.region else 1,
            "col": e.region.start_col if e.region else 1,
            "message": e.message,
            "severity": e.severity,
            "hint": e.hint or "",
        } for e in errors.errors],
        "c_code": c_code or "",
        "pins": [], "devices": [], "buses": [], "tasks": [],
        "machines": [], "channels": [], "enums": [], "chip": "",
    }

    if program:
        if program.chip:
            result["chip"] = program.chip.target
        if program.hardware:
            result["pins"] = [
                {"name": p.name, "mode": p.mode, "gpio": p.gpio}
                for p in program.hardware.pins
            ]
            result["devices"] = [
                {"name": s.name, "type": s.sensor_type, "bus": s.bus_name, "address": s.address}
                for s in program.hardware.sensors
            ]
            result["buses"] = [
                {"name": b.name, "type": b.bus_type}
                for b in program.hardware.buses
            ]
        result["tasks"] = [
            {"name": t.name, "tier": getattr(t, "tier", "background"), "line": t.region.start_line}
            for t in program.tasks
        ]
        result["machines"] = [
            {"name": m.name, "states": [s.name for s in m.states], "line": m.region.start_line}
            for m in program.machines
        ]
        result["channels"] = [
            {"name": c.name, "elem_type": c.elem_type, "capacity": c.capacity}
            for c in program.channels
        ]
        result["enums"] = [
            {"name": e.name, "variants": e.variants}
            for e in program.enums
        ]

    return result


def handle_format_code(req):
    return format_source(req["source"])


def handle_find_symbols(req):
    """Returns array of {name, kind, def_line, def_col, refs: [{line,col}]}."""
    source = req["source"]

    try:
        program = parse(source)
    except Exception:
        return []

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
            "name": name, "kind": kind,
            "def_line": region.start_line, "def_col": region.start_col,
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
            walk_expr(expr.left); walk_expr(expr.right)
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
            walk_expr(expr.target); walk_expr(expr.value)

    def walk_stmts(stmts):
        for stmt in stmts or []:
            if stmt is None:
                continue
            if isinstance(stmt, VarDecl):
                if stmt.name not in symbols:
                    add(stmt.name, stmt.name, "var", stmt.region)
                walk_expr(stmt.value)
            elif isinstance(stmt, (AssignExpr, CompoundAssign)):
                walk_expr(stmt.target); walk_expr(stmt.value)
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
                walk_expr(stmt.condition); walk_stmts(stmt.body)
            elif isinstance(stmt, ForStmt):
                walk_expr(stmt.start); walk_expr(stmt.end); walk_stmts(stmt.body)
            elif isinstance(stmt, EveryBlock):
                walk_stmts(stmt.body)
            elif isinstance(stmt, OnBlock):
                walk_expr(stmt.event); walk_stmts(stmt.body)
            elif isinstance(stmt, TimeoutBlock):
                walk_stmts(stmt.try_body); walk_stmts(stmt.fallback_body)
            elif isinstance(stmt, MatchStmt):
                walk_expr(stmt.expr)

    for func in program.functions:
        walk_stmts(func.body)
    for task in program.tasks:
        walk_stmts(task.body)
    for machine in program.machines:
        for state in machine.states:
            walk_stmts(state.enter_body); walk_stmts(state.exit_body); walk_stmts(state.body)
    if program.setup:
        walk_stmts(program.setup.body)
    if program.loop:
        walk_stmts(program.loop.body)

    return list(symbols.values())


HANDLERS = {
    "compile_full": handle_compile_full,
    "format_code": handle_format_code,
    "find_symbols": handle_find_symbols,
}


def main():
    # Signal readiness — main.js waits for this before sending requests
    sys.stdout.write(json.dumps({"id": "_ready", "ok": True}) + "\n")
    sys.stdout.flush()

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id", "")
            op = req.get("op", "")
            handler = HANDLERS.get(op)
            if handler is None:
                resp = {"id": req_id, "ok": False, "error": f"unknown op: {op}"}
            else:
                try:
                    # If the request asks for streaming progress, build a
                    # callback that writes intermediate JSON-line events.
                    emit_progress = None
                    if op == "compile_full" and req.get("emit_progress"):
                        def emit_progress(phase, pct):
                            sys.stdout.write(json.dumps({
                                "id": req_id,
                                "progress": {"phase": phase, "pct": pct},
                            }) + "\n")
                            sys.stdout.flush()
                        result = handler(req, emit_progress=emit_progress)
                    else:
                        result = handler(req)
                    resp = {"id": req_id, "ok": True, "result": result}
                except Exception as e:
                    resp = {
                        "id": req_id, "ok": False,
                        "error": str(e),
                        "trace": traceback.format_exc(),
                    }
        except Exception as e:
            resp = {"id": "_error", "ok": False, "error": f"bad request: {e}"}

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
