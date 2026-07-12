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
import re
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
from volt.compiler.analyzer import analyze
from volt.compiler.errors import CompilerErrors
from volt.compiler.formatter import format_source
from volt.compiler.ast_nodes import (
    AssignExpr, BecomeStmt, BinaryExpr, CompoundAssign, DotAccess, EveryBlock,
    ExprStmt, ForStmt, FuncCall, IfStmt, MatchStmt, MethodCall,
    OnBlock, Region, ReturnStmt, TimeoutBlock, UnaryExpr, VarDecl, VarRef,
    WhileStmt,
)
from dataclasses import fields, is_dataclass


def handle_compile_full(req, emit_progress=None):
    """compile + AST extraction for diagnostics and side-panel rendering.

    If emit_progress is callable, it's invoked as emit_progress(phase, pct)
    after each compiler pass.
    """
    source = req["source"]
    filename = req.get("filename", "main.volt")

    c_code, errors = compile_volt(source, filename, progress=emit_progress)

    # Re-parse to extract AST (compile_volt doesn't return the program).
    # Each pass is wrapped independently so a failure in (say) analyze
    # doesn't wipe out the parse result — the side panel still gets
    # tasks/machines/pins from whatever stage succeeded.
    program = None
    scope = None
    try:
        program = parse(source)
    except Exception:
        program = None

    if program is not None:
        errs2 = CompilerErrors()
        errs2.set_source(source)
        try:
            scope = resolve(program, errs2)
        except Exception:
            scope = None
        if scope is not None:
            try:
                check_types(program, scope, errs2)
            except Exception:
                pass
            try:
                analyze(program, scope, errs2)
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


def handle_state_diagram(req):
    """Emit a Mermaid `stateDiagram-v2` per machine, plus a state->line map so
    the IDE can wire click-to-source. Labels are sliced from the original
    source by node region (1-based line/col) rather than re-stringified."""
    source = req["source"]
    try:
        program = parse(source)
    except Exception:
        return {"machines": []}

    lines = source.splitlines()

    def snip(region):
        if region is None:
            return ""
        try:
            if region.start_line == region.end_line:
                return lines[region.start_line - 1][region.start_col - 1:region.end_col - 1].strip()
            return lines[region.start_line - 1][region.start_col - 1:].strip()
        except Exception:
            return ""

    def label(text):
        # Edge labels must be single-line and must not contain the ':' that
        # separates target from label in Mermaid.
        return " ".join((text or "").split()).replace(":", " ").strip()

    def widest_region(node):
        # A BinaryExpr's region often covers only its left operand, so walk the
        # expression subtree and take the min-start / max-end span — otherwise a
        # condition like "x == 1" would render as just "x".
        acc = []

        def walk(n):
            if n is None:
                return
            if isinstance(n, list):
                for x in n:
                    walk(x)
                return
            if is_dataclass(n) and not isinstance(n, Region):
                r = getattr(n, "region", None)
                if r is not None and (r.end_line or r.end_col):
                    acc.append(r)
                for f in fields(n):
                    v = getattr(n, f.name, None)
                    if isinstance(v, list) or is_dataclass(v):
                        walk(v)

        walk(node)
        if not acc:
            return None
        s = min((r.start_line, r.start_col) for r in acc)
        e = max((r.end_line, r.end_col) for r in acc)
        return Region(s[0], s[1], e[0], e[1])

    def collect_becomes(node, out):
        # Imperative transitions (`become <state>`) can appear anywhere inside a
        # state's enter/exit/body or a transition action — nested in if/while/
        # match/on blocks. Walk the AST generically to find them all.
        if node is None:
            return
        if isinstance(node, list):
            for x in node:
                collect_becomes(x, out)
        elif isinstance(node, BecomeStmt):
            if node.target:
                out.append(node.target)
        elif is_dataclass(node):
            for f in fields(node):
                val = getattr(node, f.name, None)
                if isinstance(val, list) or is_dataclass(val):
                    collect_becomes(val, out)

    machines = []
    for m in program.machines:
        header = ["stateDiagram-v2"]
        initial = next((s for s in m.states if getattr(s, "is_initial", False)), None)
        if initial is None and m.states:
            initial = m.states[0]
        if initial is not None:
            header.append(f"    [*] --> {initial.name}")

        edges = []
        state_map = []
        for s in m.states:
            state_map.append({"name": s.name, "line": s.region.start_line})

            for t in s.transitions:
                lbl = label(snip(widest_region(getattr(t, "event", None))))
                guard = label(snip(widest_region(getattr(t, "guard", None))))
                if guard:
                    lbl = f"{lbl} [{guard}]" if lbl else f"[{guard}]"
                edge = f"    {s.name} --> {t.target_state}"
                if lbl:
                    edge += f" : {lbl}"
                edges.append(edge)

            for t in s.timed_transitions:
                dur = label(snip(widest_region(getattr(t, "duration", None))))
                lbl = f"after {dur}" if dur else "after"
                guard = label(snip(widest_region(getattr(t, "guard", None))))
                if guard:
                    lbl += f" [{guard}]"
                edges.append(f"    {s.name} --> {t.target_state} : {lbl}")

            # Imperative `become <state>` transitions from enter/exit/body and
            # from any declared transition's action block.
            becomes = []
            collect_becomes(s.enter_body, becomes)
            collect_becomes(s.exit_body, becomes)
            collect_becomes(getattr(s, "body", None), becomes)
            for t in s.transitions:
                collect_becomes(getattr(t, "action", None), becomes)
            for t in s.timed_transitions:
                collect_becomes(getattr(t, "action", None), becomes)
            seen = set()
            for target in becomes:
                if target and target not in seen:
                    seen.add(target)
                    edges.append(f"    {s.name} --> {target} : become")

        machines.append({
            "name": m.name,
            "mermaid": "\n".join(header + edges),
            "states": state_map,
        })

    return {"machines": machines}


def handle_system_graph(req):
    """Whole-program system / causal map: the concurrent units (tasks, machines,
    setup, functions) and the resources they touch (channels, shared vars, pins,
    services), as a Mermaid flowchart. Exact — Volt has no aliasing or dynamic
    dispatch, so every edge is a real, named reference resolvable from the AST."""
    source = req["source"]
    try:
        program = parse(source)
    except Exception:
        return {"mermaid": "", "units": []}

    src_lines = source.splitlines()
    _hw_pins = program.hardware.pins if program.hardware else []
    pins = {p.name for p in _hw_pins}
    channels = {c.name for c in program.channels}
    globals_ = {v.name for v in program.global_vars} | {s.name for s in program.storage_vars}
    funcs = {f.name for f in program.functions}

    # Declaration lookups — used to attach a source line + a short detail string
    # to every node for the click-menu (Go to source / inspect).
    pin_decls = {p.name: p for p in _hw_pins}
    chan_decls = {c.name: c for c in program.channels}
    var_decls = {v.name: v for v in program.global_vars}
    storage_decls = {s.name: s for s in program.storage_vars}
    task_decls = {t.name: t for t in program.tasks}
    machine_decls = {m.name: m for m in program.machines}
    func_decls = {f.name: f for f in program.functions}

    nodes = {}   # id -> {"label", "kind"}
    edges = {}   # (src, dst, kind, label) -> True  (dedupe)
    unit_lines = []

    READ_METHODS = {"read", "value", "get", "receive", "has_data", "peek", "pop", "available"}

    def is_read_method(m):
        # A read/query returns data TO the caller, so its edge flows resource→unit
        # (dotted, arrowhead at the reader). Covers the explicit set plus the
        # conventional query prefixes (is_connected, has_*, get_*).
        return isinstance(m, str) and (m in READ_METHODS or m.startswith(("is_", "has_", "get_")))

    def node(nid, label, kind):
        nodes.setdefault(nid, {"label": label, "kind": kind})

    def base_name(target):
        while isinstance(target, DotAccess):
            target = target.obj
        return target.name if isinstance(target, VarRef) else None

    def snip(region):
        if region is None:
            return ""
        try:
            if region.start_line == region.end_line:
                return src_lines[region.start_line - 1][region.start_col - 1:region.end_col - 1].strip()
            return src_lines[region.start_line - 1][region.start_col - 1:].strip()
        except Exception:
            return ""

    def walk(n, unit):
        if n is None:
            return
        if isinstance(n, list):
            for x in n:
                walk(x, unit)
            return
        if isinstance(n, (AssignExpr, CompoundAssign)):
            nm = base_name(n.target)
            if nm in globals_:
                node("v_" + nm, nm, "var")
                edges[(unit, "v_" + nm, "write", "write")] = True
            walk(n.value, unit)
            return
        if isinstance(n, MethodCall):
            recv = n.obj.name if isinstance(n.obj, VarRef) else None
            m = n.method
            if recv in channels:
                node("c_" + recv, recv, "channel")
                if is_read_method(m):
                    edges[("c_" + recv, unit, "consume", m)] = True
                else:
                    edges[(unit, "c_" + recv, "produce", m)] = True
            elif recv in pins:
                node("p_" + recv, recv, "pin")
                if is_read_method(m):
                    edges[("p_" + recv, unit, "in", m)] = True
                else:
                    edges[(unit, "p_" + recv, "out", m)] = True
            elif recv is not None and recv not in globals_:
                node("s_" + recv, recv, "service")
                if is_read_method(m):
                    # a query (is_connected, get_*, read…) returns data to the unit
                    edges[("s_" + recv, unit, "in", m)] = True
                else:
                    edges[(unit, "s_" + recv, "service", m)] = True
            for a in n.args:
                walk(a, unit)
            return
        if isinstance(n, FuncCall):
            if n.name in funcs:
                node("f_" + n.name, n.name + "()", "func")
                edges[(unit, "f_" + n.name, "call", "call")] = True
            else:
                node("s_" + n.name, n.name, "service")
                edges[(unit, "s_" + n.name, "service", n.name)] = True
            for a in n.args:
                walk(a, unit)
            return
        if isinstance(n, VarRef):
            if n.name in globals_:
                node("v_" + n.name, n.name, "var")
                edges[("v_" + n.name, unit, "read", "read")] = True
            return
        if is_dataclass(n) and not isinstance(n, Region):
            for f in fields(n):
                v = getattr(n, f.name, None)
                if isinstance(v, list) or is_dataclass(v):
                    walk(v, unit)

    def first_interval(body):
        found = []

        def scan(n):
            if found or n is None:
                return
            if isinstance(n, list):
                for x in n:
                    scan(x)
            elif isinstance(n, EveryBlock):
                found.append(snip(getattr(getattr(n, "interval", None), "region", None)))
            elif is_dataclass(n) and not isinstance(n, Region):
                for f in fields(n):
                    scan(getattr(n, f.name, None))
        scan(body)
        return found[0] if found else ""

    def add_unit(uid, label, kind, body, region):
        node(uid, label, kind)
        if region is not None:
            unit_lines.append({"id": uid, "name": label, "line": region.start_line})
        walk(body, uid)

    if program.setup is not None:
        add_unit("u_setup", "setup", "task", program.setup.body, program.setup.region)

    for t in program.tasks:
        iv = first_interval(t.body)   # non-empty → this task loops on a timer
        if iv:
            # Periodic source: circle shape + rate-forward label + loop marker.
            kind = "timer"
            disp = "" if t.name.startswith("_rule") else t.name
            label = ("↻ " + iv) if not disp else (disp + "<br>↻ " + iv)
        else:
            kind = "task"
            disp = t.name
            label = t.name
        add_unit("u_" + t.name, label, kind, t.body, t.region)
        if kind == "timer":
            nodes["u_" + t.name]["rate"] = iv
            nodes["u_" + t.name]["name"] = disp

    for m in program.machines:
        node("u_" + m.name, m.name, "machine")
        unit_lines.append({"id": "u_" + m.name, "name": m.name, "line": m.region.start_line})
        for s in m.states:
            walk(s.enter_body, "u_" + m.name)
            walk(s.exit_body, "u_" + m.name)
            walk(getattr(s, "body", None), "u_" + m.name)
            for tr in s.transitions:
                walk(getattr(tr, "event", None), "u_" + m.name)
                walk(getattr(tr, "guard", None), "u_" + m.name)
                walk(getattr(tr, "action", None), "u_" + m.name)
            for tr in s.timed_transitions:
                walk(getattr(tr, "guard", None), "u_" + m.name)
                walk(getattr(tr, "action", None), "u_" + m.name)

    for f in program.functions:
        add_unit("u_" + f.name, f.name + "()", "func", f.body, f.region)

    # ---- per-node metadata for the click-menu (declaration line + a short
    # detail line, e.g. "Analog · GPIO 36", "every 500ms", "3 states") ----
    def line_of(obj):
        r = getattr(obj, "region", None) if obj is not None else None
        return getattr(r, "start_line", None) if r is not None else None

    def val_str(x):
        if x is None:
            return ""
        if is_dataclass(x) and not isinstance(x, Region):
            return snip(getattr(x, "region", None)) or ""
        return str(x)

    svc_methods = {}   # service id -> methods invoked on it (for its detail line)
    for (s_id, d_id, _k, label) in edges:
        for nid in (s_id, d_id):
            if nid.startswith("s_"):
                svc_methods.setdefault(nid, []).append(label)

    def node_meta(nid, m):
        kind = m["kind"]
        name = nid[2:]
        line, detail = None, ""
        try:
            if nid.startswith("p_") and name in pin_decls:
                p = pin_decls[name]
                line = line_of(p)
                detail = (f"{val_str(p.mode)} · GPIO {val_str(p.gpio)}").strip(" ·")
            elif nid.startswith("c_") and name in chan_decls:
                c = chan_decls[name]
                line = line_of(c)
                cap = val_str(c.capacity)
                detail = val_str(c.elem_type) + (f"[{cap}]" if cap else "")
            elif nid.startswith("v_"):
                if name in var_decls:
                    v = var_decls[name]
                    line = line_of(v)
                    detail = ("shared " if getattr(v, "shared", False) else "") + val_str(v.type_name)
                elif name in storage_decls:
                    sd = storage_decls[name]
                    line = line_of(sd)
                    detail = (val_str(sd.type_name) + " · storage").strip(" ·")
            elif nid.startswith("s_"):
                ms = sorted(set(svc_methods.get(nid, [])))
                detail = ", ".join(ms[:4]) + (" …" if len(ms) > 4 else "")
            elif nid.startswith("f_") and name in func_decls:
                line = line_of(func_decls[name])
                detail = "function"
            elif nid == "u_setup":
                line = line_of(program.setup)
                detail = "setup block"
            elif nid.startswith("u_"):
                if kind == "machine" and name in machine_decls:
                    mc = machine_decls[name]
                    line = line_of(mc)
                    detail = f"{len(mc.states)} state" + ("s" if len(mc.states) != 1 else "")
                elif kind == "func" and name in func_decls:
                    line = line_of(func_decls[name])
                    detail = "function"
                elif name in task_decls:
                    line = line_of(task_decls[name])
                    detail = f"every {m.get('rate','')}" if kind == "timer" else "task"
        except Exception:
            pass
        return {"kind": kind, "label": m.get("label", name), "line": line, "detail": detail}

    node_info = {nid: node_meta(nid, m) for nid, m in nodes.items()}

    # ---- assemble Mermaid flowchart ----
    SHAPE = {
        "task":    ('["', '"]'),
        "timer":   ('(("', '"))'),   # circle → periodic/cyclic source (research: shape = strongest cue)
        "machine": ('[["', '"]]'),
        "func":    ('("', '")'),
        "channel": ('[/"', '"/]'),
        "var":     ('("', '")'),
        "pin":     ('(["', '"])'),
        "service": ('{{"', '"}}'),
    }

    def decl(nid):
        op, cl = SHAPE.get(nodes[nid]["kind"], ('["', '"]'))
        return f'{nid}{op}{nodes[nid]["label"]}{cl}'

    # Which unit(s) touch each resource → sole owner vs shared.
    res_units = {}
    for (src, dst, kind, label) in edges:
        if src.startswith("u_") and not dst.startswith("u_"):
            res_units.setdefault(dst, set()).add(src)
        elif dst.startswith("u_") and not src.startswith("u_"):
            res_units.setdefault(src, set()).add(dst)
    owner = {rid: next(iter(us)) for rid, us in res_units.items() if len(us) == 1}
    shared = {rid for rid, us in res_units.items()
              if len(us) >= 2 and nodes.get(rid, {}).get("kind") in ("var", "channel", "pin")}

    RES_KINDS = ("var", "channel", "pin", "service", "func")
    loop_ids = [nid for nid, m in nodes.items() if m["kind"] == "timer"]
    expanded = set(req.get("expanded") or [])

    def folded(rid):
        # A resource is hidden only when its sole owner is a COLLAPSED loop.
        o = owner.get(rid)
        return o in loop_ids and o not in expanded

    out = ["flowchart LR"]

    # Nodes: everything except loops (emitted below) and resources folded into a
    # collapsed loop. Loops are flat circles — the circle already reads as
    # "cyclic", so no container box is needed (a box around one node is just
    # redundancy). Collapsed hides the owned body; expanded shows it as ordinary
    # connected nodes.
    for nid, m in nodes.items():
        if nid in loop_ids:
            continue
        if m["kind"] in RES_KINDS and folded(nid):
            continue
        out.append(f"    {decl(nid)}")
    for lid in loop_ids:
        out.append(f"    {decl(lid)}")

    # Aggregate parallel edges; drop any touching a folded node.
    agg = {}
    for (src, dst, kind, label) in edges:
        if folded(src) or folded(dst):
            continue
        agg.setdefault((src, dst, kind), set()).add(label)

    # ---- per-edge "nature" for animated shafts (renderer overlays a traveling
    # pulse per edge, in THIS emission order; also carries src/dst so the click
    # menu can highlight a node's connections) ----
    #   drive = the unit endpoint's kind — timer→periodic pulse, task→continuous
    #   march, machine/func→event pulse, setup→one-shot. Flow always travels
    #   toward the arrowhead (src→dst).
    IN_KINDS = {"read", "consume", "in"}

    def unit_res(src, dst):
        return (src, dst) if src.startswith("u_") else (dst, src)

    # Parse a timer interval snippet ("100ms", "1 s", "500us", "2m") → milliseconds.
    # The renderer clamps this into a watchable range and uses it as the pulse
    # period, so a 100ms timer visibly fires faster than a 400ms one.
    _RATE_UNIT_MS = {"us": 0.001, "ms": 1.0, "s": 1000.0, "m": 60000.0}

    def rate_to_ms(txt):
        if not txt:
            return None
        m = re.search(r"([0-9]*\.?[0-9]+)\s*(ms|us|s|m)?", txt)
        if not m:
            return None
        try:
            return float(m.group(1)) * _RATE_UNIT_MS.get(m.group(2) or "ms", 1.0)
        except ValueError:
            return None

    edge_anim = []
    for (src, dst, kind), labels in agg.items():
        arrow = "-.->" if kind in IN_KINDS else "-->"
        labs = sorted(labels)
        lbl = ", ".join(labs[:3]) + (", +" + str(len(labs) - 3) if len(labs) > 3 else "")
        out.append(f"    {src} {arrow}|{lbl}| {dst}")
        u, _ = unit_res(src, dst)
        drive = "setup" if u == "u_setup" else nodes.get(u, {}).get("kind", "task")
        meta = {"drive": drive, "src": src, "dst": dst}
        if drive == "timer":
            meta["rate_ms"] = rate_to_ms(nodes.get(u, {}).get("rate"))
        edge_anim.append(meta)

    out += [
        "    classDef task fill:#1f3a4d,stroke:#2B7CB3,color:#e8e8e8;",
        "    classDef timer fill:#33291a,stroke:#d0a83a,color:#f5e9cf;",
        "    classDef machine fill:#2d1f3d,stroke:#7a3ac0,color:#e8e8e8;",
        "    classDef func fill:#26333a,stroke:#5a8fa0,color:#e8e8e8;",
        "    classDef channel fill:#3a2d1f,stroke:#c08a3a,color:#e8e8e8;",
        "    classDef var fill:#2a2d33,stroke:#8a8f98,color:#e8e8e8;",
        "    classDef pin fill:#1f3d2a,stroke:#3aa06a,color:#e8e8e8;",
        "    classDef service fill:#33262f,stroke:#a03a6a,color:#e8e8e8;",
        "    classDef shared fill:#3d2a1f,stroke:#d08a3a,stroke-width:2.5px,color:#f0e0c0;",
    ]
    for nid, meta in nodes.items():
        if meta["kind"] in RES_KINDS and folded(nid):
            continue   # folded → not rendered, so no class
        cls = "shared" if nid in shared else meta["kind"]
        out.append(f"    class {nid} {cls};")

    # Node clicks are wired by the renderer (attaches listeners per .node and
    # opens the context menu); loop expand/collapse now lives in that menu.

    return {"mermaid": "\n".join(out), "units": unit_lines, "loops": loop_ids,
            "edges": edge_anim, "nodes": node_info}


HANDLERS = {
    "compile_full": handle_compile_full,
    "format_code": handle_format_code,
    "find_symbols": handle_find_symbols,
    "state_diagram": handle_state_diagram,
    "system_graph": handle_system_graph,
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
