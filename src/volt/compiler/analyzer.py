"""
Volt Analyzer — Pass 5: Task Classification + Yield Analysis

The most innovative pass in the pipeline. Does four things no other
embedded tool does at compile time:

1. CLASSIFY tasks into Critical / Priority / Background tiers
2. FIND yield points and variables that cross them (for lifting)
3. DETECT shared mutable state between tasks (data race prevention)
4. CHECK ISR safety for critical tasks
5. ESTIMATE WCET for critical tasks (rough heuristic)

Input:  Typed AST from checker + symbol table
Output: Annotated AST (tasks classified, vars marked for lifting, warnings)
"""

from .ast_nodes import *
from .symbols import Scope
from .errors import CompilerErrors


# ============================================================
# ISR-unsafe operations (cannot be called from critical tasks)
# ============================================================

ISR_UNSAFE_METHODS = {
    # Blocking/networking
    "connect", "disconnect", "scan",
    "send", "send_float", "send_int", "publish", "subscribe",
    "on_receive", "on_connect", "on_disconnect",
    "get", "post",  # HTTP
    "save", "load", "delete",  # storage (flash writes)
    # Sensor reads (I2C/SPI are blocking)
    "temperature", "humidity", "pressure", "lux",
    "init",
    # Display (I2C blocking)
    "clear", "text", "show",
}

ISR_UNSAFE_FUNCTIONS = {
    "log", "sleep", "deep_sleep", "light_sleep",
    "run",
}

# Methods that ARE safe in ISR (direct register access)
ISR_SAFE_METHODS = {
    "on", "off", "toggle", "write", "read",
    "is_on", "is_pressed", "is_connected",
    "set_pwm",
}

# Blocking APIs that force a task to Priority tier
BLOCKING_APIS = {
    "wifi.connect", "wifi.disconnect", "wifi.scan",
    "wifi.on_connect", "wifi.on_disconnect",
    "mqtt.connect", "mqtt.disconnect", "mqtt.on_receive",
    "mqtt.send", "mqtt.send_int", "mqtt.send_float",
    "http.get", "http.post",
    "storage.save", "storage.load",
}

# Rough cycle costs for WCET estimation (ESP32 @ 240 MHz)
WCET_COSTS = {
    "gpio_op": 10,          # pin_write, pin_read, pin_toggle
    "integer_op": 1,        # add, subtract, compare, assign
    "float_op": 5,          # FPU operation
    "adc_read": 100,        # ADC conversion
    "log_call": 5000,       # printf/UART
    "wifi_call": 100000,    # WiFi operation
    "mqtt_call": 50000,     # MQTT operation
    "sensor_read": 10000,   # I2C/SPI sensor
    "storage_op": 20000,    # flash write
    "sleep_call": 0,        # just sets wake_at
    "unknown": 100,         # conservative default
}

ISR_MAX_CYCLES = 5000   # ~20 microseconds at 240 MHz — conservative limit


# ============================================================
# Main entry point
# ============================================================

def analyze(program: Program, scope: Scope, errors: CompilerErrors):
    """Run all analyses on the program."""

    # 1. Classify each task
    for task in program.tasks:
        task.tier = _classify_task(task)
        task.has_strict = _has_strict_block(task.body)

    # 2. Find yield points and crossing variables per task
    for task in program.tasks:
        if task.tier == "background":
            yield_points = _find_yield_points(task.body)
            if yield_points:
                crossing = _find_crossing_vars(task.body, yield_points)
                task.crossing_vars = crossing
                # Mark VarDecls that need lifting
                for var in _all_var_decls(task.body):
                    if var.name in crossing:
                        var.needs_lifting = True

    # 3. Check for yielding functions (need inlining)
    for func in program.functions:
        func.contains_yield = _has_yield(func.body)
        if func.contains_yield:
            # Check for recursion in yielding functions
            if _calls_self(func.body, func.name):
                errors.error(
                    func.region, "TASK ERROR",
                    f"Function `{func.name}` contains a yield (sleep/every/on) "
                    f"and calls itself recursively. Recursive yielding functions "
                    f"cannot be inlined into protothreads.",
                    hint="Rewrite as a while loop instead of recursion.",
                )

    # 4. ISR safety check for critical tasks
    for task in program.tasks:
        if task.tier == "critical":
            _check_critical_safety(task, errors)

    # 5. Shared state detection
    _detect_shared_state(program, scope, errors)

    # 6. WCET estimation for critical tasks
    for task in program.tasks:
        if task.tier == "critical":
            _check_critical_wcet(task, errors)

    # 7. State machine verification
    for machine in program.machines:
        _verify_state_machine(machine, errors)

    # 8. Warn about tasks with no yield points
    for task in program.tasks:
        if task.tier == "background":
            yields = _find_yield_points(task.body)
            if not yields and task.body:
                errors.warning(
                    task.region, "TASK WARNING",
                    f"Task `{task.name}` has no yield points (no every/on/sleep). "
                    f"It will run once and complete.",
                )


# ============================================================
# 1. Task Classification
# ============================================================

def _classify_task(task: TaskDecl) -> str:
    """Classify a task into one of three tiers."""

    # Rule 1: "strict" keyword → Critical (hardware timer ISR)
    if _has_strict_block(task.body):
        return "critical"

    # Rule 2: Uses blocking/networking APIs → Priority (FreeRTOS task)
    for call in _all_calls(task.body):
        call_name = _call_full_name(call)
        if call_name in BLOCKING_APIS:
            return "priority"

    # Rule 3: Everything else → Background (protothread)
    return "background"


def _has_strict_block(stmts: list) -> bool:
    """Check if any EveryBlock has strict=True."""
    for stmt in _walk_stmts(stmts):
        if isinstance(stmt, EveryBlock) and stmt.strict:
            return True
    return False


# ============================================================
# 2. Yield Point Analysis
# ============================================================

def _find_yield_points(stmts: list) -> list[Region]:
    """Find all yield/suspension points in a statement list."""
    yields = []
    for stmt in _walk_stmts(stmts):
        if isinstance(stmt, EveryBlock) and not stmt.strict:
            yields.append(stmt.region)
        elif isinstance(stmt, OnBlock):
            yields.append(stmt.region)
        elif isinstance(stmt, ExprStmt) and isinstance(stmt.expr, FuncCall):
            if stmt.expr.name in ("sleep", "deep_sleep", "light_sleep"):
                yields.append(stmt.region)
        elif isinstance(stmt, TimeoutBlock):
            yields.append(stmt.region)
    return yields


def _find_crossing_vars(stmts: list, yield_points: list[Region]) -> list[str]:
    """Find variables whose lifetime spans a yield point.

    A variable "crosses" a yield if:
    - It is declared (VarDecl) BEFORE a yield point
    - It is used (VarRef or assigned) AFTER that same yield point
    """
    crossing = set()

    # Collect all var declarations with their line numbers
    var_decl_lines = {}  # name → declaration line
    for stmt in _walk_stmts(stmts):
        if isinstance(stmt, VarDecl):
            var_decl_lines[stmt.name] = stmt.region.start_line

    # Collect all var uses with their line numbers
    var_use_lines = {}  # name → last use line
    for expr in _walk_exprs(stmts):
        if isinstance(expr, VarRef) and expr.name in var_decl_lines:
            existing = var_use_lines.get(expr.name, 0)
            var_use_lines[expr.name] = max(existing, expr.region.start_line)

    # Check which variables span a yield point
    yield_lines = [yp.start_line for yp in yield_points]

    for name, decl_line in var_decl_lines.items():
        last_use = var_use_lines.get(name, decl_line)
        for yl in yield_lines:
            if decl_line < yl < last_use:
                crossing.add(name)
                break
            # Also: declared before every block, used inside every block body
            if decl_line < yl <= last_use:
                crossing.add(name)
                break

    return list(crossing)


def _has_yield(stmts: list) -> bool:
    """Check if a statement list contains any yield point."""
    return len(_find_yield_points(stmts)) > 0


# ============================================================
# 3. Yielding Function Detection
# ============================================================

def _calls_self(stmts: list, func_name: str) -> bool:
    """Check if a function body calls itself (recursion)."""
    for call in _all_calls(stmts):
        if isinstance(call, FuncCall) and call.name == func_name:
            return True
    return False


# ============================================================
# 4. ISR Safety Check
# ============================================================

def _check_critical_safety(task: TaskDecl, errors: CompilerErrors):
    """Verify a critical (ISR) task doesn't call unsafe functions."""
    for call in _all_calls(task.body):
        if isinstance(call, FuncCall):
            if call.name in ISR_UNSAFE_FUNCTIONS:
                errors.error(
                    call.region, "TASK ERROR",
                    f"Critical task `{task.name}` calls `{call.name}()` which is "
                    f"not safe in ISR context (hardware timer interrupt).",
                    hint=f"Remove `{call.name}()` from this task, or remove `strict` "
                         f"to make it a Background task.",
                )

        elif isinstance(call, MethodCall):
            method = call.method
            if method in ISR_UNSAFE_METHODS and method not in ISR_SAFE_METHODS:
                obj_name = call.obj.name if isinstance(call.obj, VarRef) else "?"
                errors.error(
                    call.region, "TASK ERROR",
                    f"Critical task `{task.name}` calls `{obj_name}.{method}()` which "
                    f"is not safe in ISR context (may block on I2C/SPI/UART).",
                    hint="Move this to a Background or Priority task. "
                         "Share data with the critical task via a volatile variable.",
                )


# ============================================================
# 5. Shared State Detection
# ============================================================

def _detect_shared_state(program: Program, scope: Scope, errors: CompilerErrors):
    """Detect variables accessed by multiple tasks, flag dangerous combinations."""

    # Collect global/storage variable names
    global_names = set()
    for var in program.global_vars:
        global_names.add(var.name)
    for storage in program.storage_vars:
        global_names.add(storage.name)

    # Build access map: var_name → [(task_name, tier, access_type)]
    var_access = {}  # name → list of (task, tier, "read"|"write")

    for task in program.tasks:
        for expr in _walk_exprs(task.body):
            if isinstance(expr, VarRef) and expr.name in global_names:
                if expr.name not in var_access:
                    var_access[expr.name] = []
                var_access[expr.name].append((task.name, task.tier, "read"))

            elif isinstance(expr, AssignExpr):
                if isinstance(expr.target, VarRef) and expr.target.name in global_names:
                    name = expr.target.name
                    if name not in var_access:
                        var_access[name] = []
                    var_access[name].append((task.name, task.tier, "write"))

    # Check for dangerous combinations
    for var_name, accesses in var_access.items():
        task_names = set(t for t, _, _ in accesses)
        if len(task_names) < 2:
            continue  # only one task accesses it — safe

        writers = [(t, tier) for t, tier, access in accesses if access == "write"]
        tiers = set(tier for _, tier, _ in accesses)

        # CRITICAL + non-CRITICAL = data race (ISR preempts)
        if "critical" in tiers and tiers - {"critical"}:
            critical_tasks = [t for t, tier, _ in accesses if tier == "critical"]
            other_tasks = [t for t, tier, _ in accesses if tier != "critical"]
            errors.error(
                program.region, "CONCURRENCY ERROR",
                f"Variable `{var_name}` is accessed by critical task "
                f"({', '.join(critical_tasks)}) and non-critical task "
                f"({', '.join(other_tasks)}). This is a data race — the ISR "
                f"can preempt at any time.",
                hint=f"Declare `{var_name}` as `volatile` in generated C, "
                     f"or use atomic operations. Better: use a channel.",
            )

        # Multiple writers across different tasks = warning
        elif len(writers) > 1 and len(set(t for t, _ in writers)) > 1:
            writer_names = list(set(t for t, _ in writers))
            errors.warning(
                program.region, "CONCURRENCY WARNING",
                f"Variable `{var_name}` is written by multiple tasks: "
                f"{', '.join(writer_names)}. This may cause unexpected behavior.",
                hint="Consider using a channel for inter-task communication.",
            )


# ============================================================
# 6. WCET Estimation
# ============================================================

def _check_critical_wcet(task: TaskDecl, errors: CompilerErrors):
    """Rough WCET estimate for critical tasks."""
    cycles, breakdown = _estimate_wcet(task.body)

    if cycles > ISR_MAX_CYCLES:
        detail = ""
        if breakdown:
            top = sorted(breakdown, key=lambda x: x[1], reverse=True)[:3]
            detail = " Top costs: " + ", ".join(
                f"{name}(~{cost} cycles)" for name, cost in top
            )
        errors.warning(
            task.region, "TASK WARNING",
            f"Critical task `{task.name}` estimated at ~{cycles} cycles "
            f"(~{cycles * 1000 // 240000}us at 240MHz), "
            f"may exceed ISR time budget.{detail}",
            hint="Keep critical tasks under ~20us. Move heavy work to a Background task.",
        )


def _estimate_wcet(stmts: list) -> tuple[int, list]:
    """Rough WCET in cycles. Returns (total_cycles, [(operation, cost)])."""
    total = 0
    breakdown = []

    for stmt in _walk_stmts(stmts):
        if isinstance(stmt, ExprStmt):
            cost, name = _expr_cost(stmt.expr)
            total += cost
            if cost > 10:
                breakdown.append((name, cost))
        elif isinstance(stmt, VarDecl):
            cost, name = _expr_cost(stmt.value) if stmt.value else (1, "decl")
            total += cost + 1  # +1 for the assignment
        elif isinstance(stmt, AssignExpr):
            cost, name = _expr_cost(stmt.value)
            total += cost + 1
        elif isinstance(stmt, (IfStmt, WhileStmt, ForStmt)):
            total += 5  # branch cost
        elif isinstance(stmt, ReturnStmt):
            total += 2

    return total, breakdown


def _expr_cost(expr) -> tuple[int, str]:
    """Estimate the cost of an expression in cycles."""
    if expr is None:
        return 0, ""

    if isinstance(expr, (IntLiteral, FloatLiteral, BoolLiteral, StringLiteral)):
        return 1, "literal"

    if isinstance(expr, VarRef):
        return 1, "var_read"

    if isinstance(expr, BinaryExpr):
        left_cost, _ = _expr_cost(expr.left)
        right_cost, _ = _expr_cost(expr.right)
        op_cost = WCET_COSTS["float_op"] if "float" in str(type(expr.left)) else WCET_COSTS["integer_op"]
        return left_cost + right_cost + op_cost, f"op:{expr.op}"

    if isinstance(expr, FuncCall):
        if expr.name == "log":
            return WCET_COSTS["log_call"], "log()"
        if expr.name in ("sleep", "deep_sleep"):
            return WCET_COSTS["sleep_call"], "sleep()"
        return WCET_COSTS["unknown"], f"{expr.name}()"

    if isinstance(expr, MethodCall):
        obj_name = expr.obj.name if isinstance(expr.obj, VarRef) else "?"
        method = expr.method

        if method in ("on", "off", "toggle", "write", "read", "set_pwm"):
            return WCET_COSTS["gpio_op"], f"{obj_name}.{method}()"
        if method in ("temperature", "humidity", "pressure", "lux"):
            return WCET_COSTS["sensor_read"], f"{obj_name}.{method}()"
        if method in ("connect", "disconnect", "send", "publish"):
            return WCET_COSTS["wifi_call"], f"{obj_name}.{method}()"
        if method in ("save", "load"):
            return WCET_COSTS["storage_op"], f"{obj_name}.{method}()"

        return WCET_COSTS["unknown"], f"{obj_name}.{method}()"

    return WCET_COSTS["unknown"], "unknown"


# ============================================================
# AST Walking Helpers
# ============================================================

def _walk_stmts(stmts: list):
    """Yield all statements recursively, including nested blocks."""
    for stmt in stmts:
        if stmt is None:
            continue
        yield stmt
        if isinstance(stmt, IfStmt):
            yield from _walk_stmts(stmt.then_body)
            if isinstance(stmt.else_body, list):
                yield from _walk_stmts(stmt.else_body)
            elif isinstance(stmt.else_body, IfStmt):
                yield from _walk_stmts([stmt.else_body])
        elif isinstance(stmt, WhileStmt):
            yield from _walk_stmts(stmt.body)
        elif isinstance(stmt, ForStmt):
            yield from _walk_stmts(stmt.body)
        elif isinstance(stmt, EveryBlock):
            yield from _walk_stmts(stmt.body)
        elif isinstance(stmt, OnBlock):
            yield from _walk_stmts(stmt.body)
        elif isinstance(stmt, TimeoutBlock):
            yield from _walk_stmts(stmt.try_body)
            yield from _walk_stmts(stmt.fallback_body)
        elif isinstance(stmt, MatchStmt):
            for arm in stmt.arms:
                if isinstance(arm.body, list):
                    yield from _walk_stmts(arm.body)


def _walk_exprs(stmts: list):
    """Yield all expressions recursively from statements."""
    for stmt in _walk_stmts(stmts):
        if isinstance(stmt, VarDecl) and stmt.value:
            yield from _walk_expr_tree(stmt.value)
        elif isinstance(stmt, AssignExpr):
            yield stmt  # the assign itself
            yield from _walk_expr_tree(stmt.target)
            yield from _walk_expr_tree(stmt.value)
        elif isinstance(stmt, ExprStmt):
            yield from _walk_expr_tree(stmt.expr)
        elif isinstance(stmt, ReturnStmt) and stmt.value:
            yield from _walk_expr_tree(stmt.value)
        elif isinstance(stmt, IfStmt):
            yield from _walk_expr_tree(stmt.condition)
        elif isinstance(stmt, WhileStmt):
            yield from _walk_expr_tree(stmt.condition)
        elif isinstance(stmt, EveryBlock):
            yield from _walk_expr_tree(stmt.interval)
        elif isinstance(stmt, OnBlock):
            yield from _walk_expr_tree(stmt.event)


def _walk_expr_tree(expr):
    """Yield an expression and all sub-expressions."""
    if expr is None:
        return
    yield expr
    if isinstance(expr, BinaryExpr):
        yield from _walk_expr_tree(expr.left)
        yield from _walk_expr_tree(expr.right)
    elif isinstance(expr, UnaryExpr):
        yield from _walk_expr_tree(expr.operand)
    elif isinstance(expr, FuncCall):
        for arg in expr.args:
            yield from _walk_expr_tree(arg)
    elif isinstance(expr, MethodCall):
        yield from _walk_expr_tree(expr.obj)
        for arg in expr.args:
            yield from _walk_expr_tree(arg)
    elif isinstance(expr, DotAccess):
        yield from _walk_expr_tree(expr.obj)
    elif isinstance(expr, ArrayLiteral):
        for elem in expr.elements:
            yield from _walk_expr_tree(elem)


def _all_calls(stmts: list):
    """Yield all FuncCall and MethodCall nodes from statements."""
    for expr in _walk_exprs(stmts):
        if isinstance(expr, (FuncCall, MethodCall)):
            yield expr


def _all_var_decls(stmts: list):
    """Yield all VarDecl nodes from statements."""
    for stmt in _walk_stmts(stmts):
        if isinstance(stmt, VarDecl):
            yield stmt


def _call_full_name(call) -> str:
    """Get the full dotted name of a call: 'wifi.connect', 'log', etc."""
    if isinstance(call, FuncCall):
        return call.name
    if isinstance(call, MethodCall):
        obj_name = call.obj.name if isinstance(call.obj, VarRef) else "?"
        return f"{obj_name}.{call.method}"
    return ""


# ============================================================
# 7. State Machine Verification
# ============================================================

def _verify_state_machine(machine: MachineDecl, errors: CompilerErrors):
    """Verify state machine correctness at compile time."""

    if not machine.states:
        errors.error(machine.region, "STATE MACHINE ERROR",
                     f"Machine `{machine.name}` has no states.")
        return

    state_names = {s.name for s in machine.states}

    # Check: at least one initial state
    initial_states = [s for s in machine.states if s.is_initial]
    if len(initial_states) == 0:
        # If no explicit initial, use the first state
        machine.states[0].is_initial = True
        initial_states = [machine.states[0]]
    elif len(initial_states) > 1:
        errors.error(machine.region, "STATE MACHINE ERROR",
                     f"Machine `{machine.name}` has {len(initial_states)} initial states "
                     f"({', '.join(s.name for s in initial_states)}). Only one allowed.")
        return

    initial_state = initial_states[0]

    # Check: all transition targets exist
    for state in machine.states:
        for trans in state.transitions:
            if trans.target_state not in state_names:
                errors.error(trans.region, "STATE MACHINE ERROR",
                             f"Transition target `{trans.target_state}` does not exist. "
                             f"Available states: {', '.join(sorted(state_names))}.")

        for timed in state.timed_transitions:
            if timed.target_state not in state_names:
                errors.error(timed.region, "STATE MACHINE ERROR",
                             f"Timed transition target `{timed.target_state}` does not exist. "
                             f"Available states: {', '.join(sorted(state_names))}.")

    # Reachability: BFS from initial state
    reachable = set()
    queue = [initial_state.name]
    while queue:
        current = queue.pop(0)
        if current in reachable:
            continue
        reachable.add(current)
        # Find the state object
        state_obj = next((s for s in machine.states if s.name == current), None)
        if state_obj is None:
            continue
        # Add all transition targets
        for trans in state_obj.transitions:
            if trans.target_state not in reachable:
                queue.append(trans.target_state)
        for timed in state_obj.timed_transitions:
            if timed.target_state not in reachable:
                queue.append(timed.target_state)

    unreachable = state_names - reachable
    for uname in unreachable:
        ustate = next(s for s in machine.states if s.name == uname)
        errors.warning(ustate.region, "STATE MACHINE WARNING",
                       f"State `{uname}` in machine `{machine.name}` is unreachable "
                       f"from initial state `{initial_state.name}`.")

    # Dead state detection: states with no outgoing transitions
    for state in machine.states:
        has_outgoing = bool(state.transitions) or bool(state.timed_transitions)
        if not has_outgoing:
            errors.warning(state.region, "STATE MACHINE WARNING",
                           f"State `{state.name}` in machine `{machine.name}` has no "
                           f"outgoing transitions (dead-end state).",
                           hint="Add a transition or mark with @terminal if intentional.")

    # Determinism: check for duplicate unguarded transitions on same event
    for state in machine.states:
        # Group transitions by event (simplified: by event string representation)
        event_groups: dict[str, list] = {}
        for trans in state.transitions:
            key = _event_key(trans.event)
            if key not in event_groups:
                event_groups[key] = []
            event_groups[key].append(trans)

        for key, transitions in event_groups.items():
            if len(transitions) <= 1:
                continue
            # Check if multiple unguarded transitions exist for same event
            unguarded = [t for t in transitions if t.guard is None]
            if len(unguarded) > 1:
                errors.error(state.region, "STATE MACHINE ERROR",
                             f"State `{state.name}`: multiple unguarded transitions for "
                             f"event `{key}`. Add guards [condition] to distinguish them.")
            elif len(unguarded) == 0 and len(transitions) > 1:
                errors.warning(state.region, "STATE MACHINE WARNING",
                               f"State `{state.name}`: all transitions for event `{key}` "
                               f"have guards. If no guard matches, event is silently dropped.",
                               hint="Add a default (unguarded) transition as fallback.")


def _event_key(event) -> str:
    """Generate a string key for an event expression (for grouping)."""
    if isinstance(event, MethodCall):
        obj = event.obj.name if isinstance(event.obj, VarRef) else "?"
        return f"{obj}.{event.method}"
    if isinstance(event, FuncCall):
        return event.name
    if isinstance(event, VarRef):
        return event.name
    return str(event)
