"""
Volt Transformer — Pass 6: AST Rewriting

Prepares the AST for C code generation by:
1. Lifting yield-crossing variables to context structs
2. Inlining yielding functions at call sites
3. Desugaring match → if/else chains
4. Desugaring string interpolation → snprintf
5. Desugaring duration literals → integer milliseconds
6. Assigning unique yield point labels (counter-based, not __LINE__)

Input:  Analyzed AST from Pass 5
Output: C-ready AST with context structs and numbered yield points
"""

from dataclasses import replace, field
from .ast_nodes import *


# ============================================================
# Yield label counter — each yield point gets a unique integer
# ============================================================

class YieldCounter:
    """Assigns unique labels to yield points within a task.
    Starts at 1 because VOLT_TASK_BEGIN uses case 0."""
    def __init__(self):
        self.counter = 0

    def next(self) -> int:
        self.counter += 1
        return self.counter


# ============================================================
# Main transform function
# ============================================================

def transform(program: Program) -> Program:
    """Pass 6: Transform AST for C code generation."""

    # Build function lookup for inlining
    func_map = {f.name: f for f in program.functions}

    # Extract every/on blocks from setup into anonymous tasks
    extra_tasks, new_setup_body = _extract_setup_blocks(program)

    all_program_tasks = list(program.tasks) + extra_tasks

    # --- Fix 1+2: Split tasks with multiple every/on blocks ---
    expanded_tasks = []
    for task in all_program_tasks:
        expanded_tasks.extend(_split_multi_every(task))

    # Transform each task
    new_tasks = []
    context_structs = []

    for task in expanded_tasks:
        # Inline yielding functions
        new_body = _inline_yielding_calls(task.body, func_map)

        # Assign try_ids and decide context-lift for retry counters.
        # Background tasks lift (protothread re-entry resets stack frames);
        # priority/critical run as plain functions and don't need lifting.
        try_counter = YieldCounter()
        new_body = _assign_try_ids(new_body, try_counter,
                                   lift_when_call=(task.tier == "background"))

        # Assign yield labels
        counter = YieldCounter()
        new_body = _assign_yield_labels(new_body, counter)

        # Replace body BEFORE building context struct so the struct sees
        # the up-to-date TryBlock metadata.
        task = replace(task, body=new_body)

        if task.tier == "background" and (task.crossing_vars or
                                          any(tb.needs_context_lift
                                              for tb in _all_try_blocks(task.body))):
            ctx_struct = _build_context_struct(task)
            context_structs.append(ctx_struct)

        new_tasks.append(task)

    # Desugar match statements in all bodies
    new_tasks = [replace(t, body=_desugar_match_stmts(t.body)) for t in new_tasks]
    new_funcs = [replace(f, body=_desugar_match_stmts(f.body)) for f in program.functions]

    new_setup = None
    if program.setup:
        setup_body = new_setup_body if new_setup_body is not None else program.setup.body
        new_setup = replace(program.setup, body=_desugar_match_stmts(setup_body))

    new_loop = None
    if program.loop:
        new_loop = replace(program.loop, body=_desugar_match_stmts(program.loop.body))

    # Add context structs to program's struct list
    all_structs = list(program.structs) + context_structs

    return replace(program,
                   tasks=new_tasks,
                   functions=new_funcs,
                   structs=all_structs,
                   setup=new_setup,
                   loop=new_loop)


# ============================================================
# 0. Split Multi-Every Tasks
# ============================================================

def _extract_setup_blocks(program: Program) -> tuple[list[TaskDecl], list]:
    """Extract every/on blocks from setup into anonymous tasks.
    Returns (new_tasks, remaining_setup_body).
    If setup has `every` or `on` blocks, they become auto-generated tasks
    and a `run()` call is added if missing.
    """
    if not program.setup:
        return [], None

    concurrent = []
    remaining = []
    task_idx = 0

    for stmt in program.setup.body:
        if _is_concurrent_block(stmt):
            task_idx += 1
            name = f"_auto_task_{task_idx}"
            concurrent.append(TaskDecl(
                name=name,
                body=[stmt],
                tier="background",
                crossing_vars=[],
                has_strict=False,
                region=stmt.region if hasattr(stmt, 'region') else None,
            ))
        else:
            remaining.append(stmt)

    if not concurrent:
        return [], None

    # Check if run() is already called in remaining main body
    has_run = any(
        isinstance(s, ExprStmt) and isinstance(s.expr, FuncCall) and s.expr.name == "run"
        for s in remaining
    )

    # If no run() call, the auto-tasks need to be added to the existing task list
    # and a run() call injected. But since run() is handled by the codegen via
    # the task table (not by an explicit run() call in generated C), we just need
    # the tasks in program.tasks — they'll be picked up automatically.

    return concurrent, remaining


def _is_concurrent_block(stmt) -> bool:
    """Check if a statement is an every or on block (runs forever)."""
    if isinstance(stmt, EveryBlock) and not stmt.strict:
        return True
    if isinstance(stmt, OnBlock):
        return True
    return False


def _split_multi_every(task: TaskDecl) -> list[TaskDecl]:
    """If a task has multiple concurrent blocks (every/on) at the top level,
    split each into its own internal task so they run concurrently.
    Only statements before the FIRST concurrent block go into the first sub-task.
    """
    if task.tier != "background":
        return [task]

    concurrent_blocks = [s for s in task.body if _is_concurrent_block(s)]
    if len(concurrent_blocks) <= 1:
        return [task]

    preamble = []
    result_tasks = []
    block_idx = 0
    found_first_block = False

    for stmt in task.body:
        if _is_concurrent_block(stmt):
            block_idx += 1
            sub_name = task.name if block_idx == 1 else f"{task.name}_{block_idx}"
            # Only the first sub-task gets the preamble (avoid duplicate side effects)
            sub_body = (list(preamble) + [stmt]) if not found_first_block else [stmt]
            found_first_block = True
            # Re-detect crossing vars for this sub-task's body
            from .analyzer import _find_yield_points, _find_crossing_vars
            yield_pts = _find_yield_points(sub_body)
            crossing = _find_crossing_vars(sub_body, yield_pts) if yield_pts else []
            result_tasks.append(replace(
                task,
                name=sub_name,
                body=sub_body,
                crossing_vars=crossing,
            ))
        else:
            preamble.append(stmt)

    return result_tasks


# ============================================================
# 1. Context Struct Building
# ============================================================

def _build_context_struct(task: TaskDecl) -> StructDecl:
    """Build a context struct for lifted variables and try-block retry counters."""
    fields = []
    for var in _all_var_decls(task.body):
        if var.name in task.crossing_vars:
            fields.append(FieldDecl(
                name=var.name,
                type_name=var.type_name or "int",
                region=var.region,
            ))
    # Lifted try-block retry counters — one int32 per bounded-retry try
    # block whose body yields. Set by _assign_try_ids() during transform.
    for tb in _all_try_blocks(task.body):
        if tb.needs_context_lift:
            fields.append(FieldDecl(
                name=f"_try_attempts_{tb.try_id}",
                type_name="int",
                region=tb.region,
            ))
    return StructDecl(
        name=f"{task.name}_ctx_t",
        fields=fields,
        region=task.region,
    )


def _all_try_blocks(stmts: list):
    """Yield every TryBlock node reachable from this statement list."""
    for s in stmts:
        if s is None:
            continue
        if isinstance(s, TryBlock):
            yield s
            yield from _all_try_blocks(s.body)
        for attr in ("body", "try_body", "fallback_body", "then_body", "else_body"):
            if hasattr(s, attr):
                inner = getattr(s, attr)
                if isinstance(inner, list):
                    yield from _all_try_blocks(inner)


def _stmts_contain_call(stmts: list) -> bool:
    """True iff any expression statement in this list contains a FuncCall or
    MethodCall. Used to decide whether a try block's retry counter must lift
    to the task's context struct — calls might internally yield, and a
    yielding body means the protothread re-enters from outside the block,
    which would reset a stack-local counter to zero on every retry."""
    def walk(node) -> bool:
        if node is None:
            return False
        if isinstance(node, (FuncCall, MethodCall)):
            return True
        if hasattr(node, "__dict__"):
            for v in node.__dict__.values():
                if isinstance(v, list):
                    if any(walk(x) for x in v):
                        return True
                elif walk(v):
                    return True
        return False
    return any(walk(s) for s in stmts)


def _assign_try_ids(stmts: list, counter, lift_when_call: bool):
    """Walk statements, assign unique try_id per TryBlock encountered, and
    decide whether the retry counter needs to lift to the context struct.

    Args:
      counter: a YieldCounter (or any .next() provider) to allocate IDs.
      lift_when_call: True for background protothread tasks (where yields
        across the try body reset stack-local counters). False for setup,
        priority tasks, and the main loop where the function never re-enters.

    Returns the (possibly transformed) list of statements with try_ids assigned.
    """
    out = []
    for s in stmts:
        if s is None:
            out.append(s); continue
        if isinstance(s, TryBlock):
            # Assign before recursing so nested try IDs are unique.
            tid = counter.next()
            new_body = _assign_try_ids(s.body, counter, lift_when_call)
            lift = (
                s.policy == "retry"
                and s.retry_limit is not None
                and lift_when_call
                and _stmts_contain_call(new_body)
            )
            out.append(replace(s, body=new_body, try_id=tid,
                               needs_context_lift=lift,
                               is_yield_point=_stmts_contain_call(new_body)))
            continue
        # Recurse into the usual nested-body attributes.
        new_s = s
        for attr in ("body", "try_body", "fallback_body", "then_body"):
            if hasattr(s, attr):
                inner = getattr(s, attr)
                if isinstance(inner, list):
                    new_s = replace(new_s, **{attr: _assign_try_ids(inner, counter, lift_when_call)})
        # else_body can be either a list or a single IfStmt
        if hasattr(s, "else_body") and isinstance(s.else_body, list):
            new_s = replace(new_s, else_body=_assign_try_ids(s.else_body, counter, lift_when_call))
        out.append(new_s)
    return out


# ============================================================
# 2. Inline Yielding Functions
# ============================================================

_inline_counter = 0

def _inline_yielding_calls(stmts: list, func_map: dict) -> list:
    """Replace calls to yielding functions with their inlined body."""
    global _inline_counter
    result = []

    for stmt in stmts:
        if isinstance(stmt, ExprStmt) and isinstance(stmt.expr, FuncCall):
            func = func_map.get(stmt.expr.name)
            if func and func.contains_yield:
                _inline_counter += 1
                prefix = f"_inl{_inline_counter}"

                # Generate argument bindings
                for param, arg in zip(func.params, stmt.expr.args):
                    result.append(VarDecl(
                        name=f"{prefix}_{param.name}",
                        type_name=param.type_name,
                        value=arg,
                        mutable=True,
                        region=stmt.region,
                    ))

                # Clone body with renamed variables
                rename_map = {p.name: f"{prefix}_{p.name}" for p in func.params}
                for v in _all_var_decls(func.body):
                    rename_map[v.name] = f"{prefix}_{v.name}"

                inlined = _rename_vars_in_stmts(func.body, rename_map)
                # Recursively inline any nested yielding calls
                inlined = _inline_yielding_calls(inlined, func_map)
                result.extend(inlined)
                continue

        # Recurse into nested blocks
        if isinstance(stmt, EveryBlock):
            new_body = _inline_yielding_calls(stmt.body, func_map)
            result.append(replace(stmt, body=new_body))
        elif isinstance(stmt, OnBlock):
            new_body = _inline_yielding_calls(stmt.body, func_map)
            result.append(replace(stmt, body=new_body))
        elif isinstance(stmt, IfStmt):
            new_then = _inline_yielding_calls(stmt.then_body, func_map)
            new_else = None
            if isinstance(stmt.else_body, list):
                new_else = _inline_yielding_calls(stmt.else_body, func_map)
            elif isinstance(stmt.else_body, IfStmt):
                new_else = _inline_yielding_calls([stmt.else_body], func_map)[0]
            result.append(replace(stmt, then_body=new_then, else_body=new_else))
        elif isinstance(stmt, WhileStmt):
            new_body = _inline_yielding_calls(stmt.body, func_map)
            result.append(replace(stmt, body=new_body))
        elif isinstance(stmt, ForStmt):
            new_body = _inline_yielding_calls(stmt.body, func_map)
            result.append(replace(stmt, body=new_body))
        elif isinstance(stmt, TimeoutBlock):
            new_try = _inline_yielding_calls(stmt.try_body, func_map)
            new_fall = _inline_yielding_calls(stmt.fallback_body, func_map)
            result.append(replace(stmt, try_body=new_try, fallback_body=new_fall))
        else:
            result.append(stmt)

    return result


def _rename_vars_in_stmts(stmts: list, rename_map: dict) -> list:
    """Deep-clone statements with renamed variables."""
    result = []
    for stmt in stmts:
        result.append(_rename_vars_in_node(stmt, rename_map))
    return result


def _rename_vars_in_node(node, rename_map: dict):
    """Recursively rename variables in any node."""
    if node is None:
        return None

    if isinstance(node, VarDecl):
        new_name = rename_map.get(node.name, node.name)
        new_value = _rename_vars_in_node(node.value, rename_map)
        return replace(node, name=new_name, value=new_value)

    if isinstance(node, VarRef):
        new_name = rename_map.get(node.name, node.name)
        return replace(node, name=new_name)

    if isinstance(node, AssignExpr):
        return replace(node,
                       target=_rename_vars_in_node(node.target, rename_map),
                       value=_rename_vars_in_node(node.value, rename_map))

    if isinstance(node, BinaryExpr):
        return replace(node,
                       left=_rename_vars_in_node(node.left, rename_map),
                       right=_rename_vars_in_node(node.right, rename_map))

    if isinstance(node, UnaryExpr):
        return replace(node, operand=_rename_vars_in_node(node.operand, rename_map))

    if isinstance(node, FuncCall):
        new_args = [_rename_vars_in_node(a, rename_map) for a in node.args]
        return replace(node, args=new_args)

    if isinstance(node, MethodCall):
        new_obj = _rename_vars_in_node(node.obj, rename_map)
        new_args = [_rename_vars_in_node(a, rename_map) for a in node.args]
        return replace(node, obj=new_obj, args=new_args)

    if isinstance(node, DotAccess):
        return replace(node, obj=_rename_vars_in_node(node.obj, rename_map))

    if isinstance(node, ExprStmt):
        return replace(node, expr=_rename_vars_in_node(node.expr, rename_map))

    if isinstance(node, ReturnStmt):
        return replace(node, value=_rename_vars_in_node(node.value, rename_map))

    if isinstance(node, IfStmt):
        return replace(node,
                       condition=_rename_vars_in_node(node.condition, rename_map),
                       then_body=_rename_vars_in_stmts(node.then_body, rename_map),
                       else_body=(_rename_vars_in_stmts(node.else_body, rename_map)
                                  if isinstance(node.else_body, list)
                                  else _rename_vars_in_node(node.else_body, rename_map)))

    if isinstance(node, WhileStmt):
        return replace(node,
                       condition=_rename_vars_in_node(node.condition, rename_map),
                       body=_rename_vars_in_stmts(node.body, rename_map))

    if isinstance(node, EveryBlock):
        return replace(node, body=_rename_vars_in_stmts(node.body, rename_map))

    if isinstance(node, OnBlock):
        return replace(node, body=_rename_vars_in_stmts(node.body, rename_map))

    if isinstance(node, CompoundAssign):
        return replace(node,
                       target=_rename_vars_in_node(node.target, rename_map),
                       value=_rename_vars_in_node(node.value, rename_map))

    if isinstance(node, OrExpr):
        return replace(node,
                       expr=_rename_vars_in_node(node.expr, rename_map),
                       fallback=_rename_vars_in_node(node.fallback, rename_map))

    if isinstance(node, ForStmt):
        new_name = rename_map.get(node.var_name, node.var_name)
        return replace(node,
                       var_name=new_name,
                       start=_rename_vars_in_node(node.start, rename_map),
                       end=_rename_vars_in_node(node.end, rename_map),
                       step=_rename_vars_in_node(node.step, rename_map),
                       body=_rename_vars_in_stmts(node.body, rename_map))

    return node


# ============================================================
# 3. Assign Yield Labels
# ============================================================

def _assign_yield_labels(stmts: list, counter: YieldCounter) -> list:
    """Walk statements and assign unique integer labels to yield points."""
    result = []
    for stmt in stmts:
        if isinstance(stmt, EveryBlock):
            label = counter.next()
            new_body = _assign_yield_labels(stmt.body, counter)
            result.append(replace(stmt, body=new_body, yield_label=label))
        elif isinstance(stmt, OnBlock):
            label = counter.next()
            deb_label = counter.next() if stmt.debounce else 0
            new_body = _assign_yield_labels(stmt.body, counter)
            result.append(replace(stmt, body=new_body, yield_label=label, debounce_label=deb_label))
        elif isinstance(stmt, ExprStmt) and isinstance(stmt.expr, FuncCall):
            if stmt.expr.name in ("sleep", "deep_sleep", "light_sleep"):
                # Store label as dynamic attr — codegen reads with getattr
                new_stmt = replace(stmt)
                new_stmt._yield_label = counter.next()
                result.append(new_stmt)
            else:
                result.append(stmt)
        elif isinstance(stmt, TimeoutBlock):
            new_stmt = replace(stmt,
                try_body=_assign_yield_labels(stmt.try_body, counter),
                fallback_body=_assign_yield_labels(stmt.fallback_body, counter))
            new_stmt._yield_label = counter.next()
            result.append(new_stmt)
        elif isinstance(stmt, TryBlock):
            # Yield labels inside the body still need assigning so any
            # sleep()/etc. inside a try gets a proper protothread label.
            new_body = _assign_yield_labels(stmt.body, counter)
            result.append(replace(stmt, body=new_body))
        elif isinstance(stmt, IfStmt):
            new_then = _assign_yield_labels(stmt.then_body, counter)
            new_else = None
            if isinstance(stmt.else_body, list):
                new_else = _assign_yield_labels(stmt.else_body, counter)
            elif isinstance(stmt.else_body, IfStmt):
                new_else = _assign_yield_labels([stmt.else_body], counter)[0]
            result.append(replace(stmt, then_body=new_then, else_body=new_else))
        elif isinstance(stmt, WhileStmt):
            result.append(replace(stmt, body=_assign_yield_labels(stmt.body, counter)))
        elif isinstance(stmt, ForStmt):
            result.append(replace(stmt, body=_assign_yield_labels(stmt.body, counter)))
        else:
            result.append(stmt)
    return result


# ============================================================
# 4. Desugar Match → If/Else
# ============================================================

def _desugar_match_stmts(stmts: list) -> list:
    """Replace MatchStmt with IfStmt chains throughout."""
    result = []
    for stmt in stmts:
        if isinstance(stmt, MatchStmt):
            result.append(_desugar_one_match(stmt))
        elif isinstance(stmt, IfStmt):
            new_then = _desugar_match_stmts(stmt.then_body)
            new_else = None
            if isinstance(stmt.else_body, list):
                new_else = _desugar_match_stmts(stmt.else_body)
            elif isinstance(stmt.else_body, IfStmt):
                new_else = _desugar_match_stmts([stmt.else_body])[0]
            result.append(replace(stmt, then_body=new_then, else_body=new_else))
        elif isinstance(stmt, WhileStmt):
            result.append(replace(stmt, body=_desugar_match_stmts(stmt.body)))
        elif isinstance(stmt, EveryBlock):
            result.append(replace(stmt, body=_desugar_match_stmts(stmt.body)))
        elif isinstance(stmt, OnBlock):
            result.append(replace(stmt, body=_desugar_match_stmts(stmt.body)))
        elif isinstance(stmt, ForStmt):
            result.append(replace(stmt, body=_desugar_match_stmts(stmt.body)))
        elif isinstance(stmt, TimeoutBlock):
            result.append(replace(stmt,
                try_body=_desugar_match_stmts(stmt.try_body),
                fallback_body=_desugar_match_stmts(stmt.fallback_body)))
        else:
            result.append(stmt)
    return result


def _desugar_one_match(match: MatchStmt) -> IfStmt:
    """Convert match(expr) { .a -> X, .b -> Y, _ -> Z } to if/else chain."""
    chain = None
    for arm in reversed(match.arms):
        body = arm.body if isinstance(arm.body, list) else [ExprStmt(expr=arm.body, region=arm.region)]
        pattern = arm.pattern.strip() if isinstance(arm.pattern, str) else str(arm.pattern)

        if pattern == "_":
            # Wildcard: unconditional else — just set body directly
            if chain is None:
                chain = IfStmt(
                    condition=BoolLiteral(value=True, region=arm.region),
                    then_body=body, else_body=None, region=arm.region,
                )
            else:
                # Wildcard with existing chain: wrap as else
                chain = IfStmt(
                    condition=BoolLiteral(value=True, region=arm.region),
                    then_body=body, else_body=[chain] if chain else None,
                    region=arm.region,
                )
        else:
            # Determine the right-hand comparand
            try:
                int_val = int(pattern)
                right = IntLiteral(value=int_val, region=arm.region)
            except ValueError:
                # State/enum pattern (e.g., ".idle" → stripped to "idle")
                right = VarRef(name=pattern.lstrip("."), region=arm.region)

            condition = BinaryExpr(
                left=match.expr, op="==", right=right, region=arm.region,
            )
            chain = IfStmt(
                condition=condition, then_body=body,
                else_body=[chain] if chain else None,
                region=arm.region,
            )
    return chain


# ============================================================
# Helpers
# ============================================================

def _all_var_decls(stmts: list):
    """Yield all VarDecl nodes from statements (non-recursive for top level)."""
    for stmt in stmts:
        if isinstance(stmt, VarDecl):
            yield stmt
