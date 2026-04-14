"""
Volt Parser — Pass 1

Converts Lark parse tree into Volt AST nodes.
Uses Lark's Transformer pattern: each method matches a grammar rule,
called bottom-up (leaves first, then parents).

Input:  .volt source string
Output: ast_nodes.Program
"""

from pathlib import Path
from lark import Lark, Transformer, Token, Tree

from .ast_nodes import *

# Load grammar once at module level
_grammar_path = Path(__file__).parent / "grammar.lark"
_grammar_text = _grammar_path.read_text()
_lark_parser = Lark(_grammar_text, parser='lalr', propagate_positions=True)


# ============================================================
# Helper: extract source Region from Token or Tree
# ============================================================

def _region(item) -> Region:
    """Build a Region from a Lark Token or Tree with position info."""
    if isinstance(item, Token):
        return Region(
            start_line=item.line or 0,
            start_col=item.column or 0,
            end_line=item.end_line or 0,
            end_col=item.end_column or 0,
        )
    if isinstance(item, Tree) and hasattr(item, 'meta'):
        m = item.meta
        return Region(
            start_line=getattr(m, 'line', 0) or 0,
            start_col=getattr(m, 'column', 0) or 0,
            end_line=getattr(m, 'end_line', 0) or 0,
            end_col=getattr(m, 'end_column', 0) or 0,
        )
    # Fallback: try to get region from first child
    if isinstance(item, Node):
        return item.region
    return Region()


def _region_span(items) -> Region:
    """Build a Region spanning from first to last item."""
    first = _region(items[0]) if items else Region()
    last = _region(items[-1]) if items else first
    return Region(first.start_line, first.start_col, last.end_line, last.end_col)


# ============================================================
# Duration parsing
# ============================================================

_DURATION_TO_US = {
    "us": 1,
    "ms": 1000,
    "s": 1000000, "sec": 1000000,
    "second": 1000000, "seconds": 1000000,
    "min": 60000000, "minute": 60000000, "minutes": 60000000,
    "hr": 3600000000, "hour": 3600000000, "hours": 3600000000,
}

def _parse_duration(raw: str) -> tuple[int, str]:
    """Parse '500ms' into (microseconds, original_string)."""
    for unit in sorted(_DURATION_TO_US.keys(), key=len, reverse=True):
        if raw.endswith(unit):
            num_str = raw[:-len(unit)]
            number = float(num_str) if '.' in num_str else int(num_str)
            us = int(number * _DURATION_TO_US[unit])
            return us, raw
    return 0, raw


# ============================================================
# AST Builder Transformer
# ============================================================

class ASTBuilder(Transformer):
    """Transforms Lark parse tree into Volt AST nodes."""

    # --- Program root ---

    def start(self, children):
        prog = Program()
        for child in children:
            if child is None:
                continue
            elif isinstance(child, ChipDecl):
                prog.chip = child
            elif isinstance(child, HardwareBlock):
                prog.hardware = child
            elif isinstance(child, PowerBlock):
                prog.power = child
            elif isinstance(child, StructDecl):
                prog.structs.append(child)
            elif isinstance(child, FuncDecl):
                prog.functions.append(child)
            elif isinstance(child, TaskDecl):
                prog.tasks.append(child)
            elif isinstance(child, MachineDecl):
                prog.machines.append(child)
            elif isinstance(child, StorageDecl):
                prog.storage_vars.append(child)
            elif isinstance(child, SetupBlock):
                prog.setup = child
            elif isinstance(child, LoopBlock):
                prog.loop = child
            elif isinstance(child, RawBlock):
                prog.raw_blocks.append(child)
            elif isinstance(child, VarDecl):
                prog.global_vars.append(child)
            elif isinstance(child, ChannelDecl):
                prog.channels.append(child)
            elif isinstance(child, str) and child.endswith('.volt'):
                prog.includes.append(child)
        return prog

    # --- Chip ---

    def chip_decl(self, children):
        name = children[0]
        return ChipDecl(target=str(name), region=_region(name))

    # --- Hardware ---

    def hardware_block(self, children):
        hw = HardwareBlock(region=_region_span(children) if children else Region())
        for child in children:
            if isinstance(child, PinDecl):
                hw.pins.append(child)
            elif isinstance(child, BusDecl):
                hw.buses.append(child)
            elif isinstance(child, SensorDecl):
                hw.sensors.append(child)
        return hw

    def pin_decl(self, children):
        name = children[0]
        mode = children[1]
        gpio_expr = children[2]
        # Extract GPIO number from: integer (2), GP-prefixed name (GP25), or PA-style (PA5)
        if isinstance(gpio_expr, IntLiteral):
            gpio_val = gpio_expr.value
        elif isinstance(gpio_expr, VarRef):
            pin_str = gpio_expr.name.upper()
            if pin_str.startswith("GP") and pin_str[2:].isdigit():
                gpio_val = int(pin_str[2:])
            elif pin_str.startswith("P") and len(pin_str) >= 3 and pin_str[1].isalpha() and pin_str[2:].isdigit():
                # STM32 style: PA5 → port=0, pin=5 — store as (port * 16 + pin) for now
                port = ord(pin_str[1]) - ord('A')
                gpio_val = port * 16 + int(pin_str[2:])
            else:
                gpio_val = 0
        else:
            gpio_val = 0
        return PinDecl(
            name=str(name), mode=mode, gpio=gpio_val,
            region=_region(name),
        )

    def pin_mode(self, children):
        return ".".join(str(c) for c in children)

    def bus_decl(self, children):
        # bus name: Type(params)
        name = str(children[0])
        bus_type = str(children[1]).lower()
        constructor = bus_type
        params = children[3] if len(children) > 3 else {}
        return BusDecl(
            bus_type=bus_type, name=name, params=params,
            region=_region(children[0]),
        )

    def sensor_decl(self, children):
        name = str(children[0])
        sensor_type = str(children[1])
        bus_name = str(children[2])
        addr_expr = children[3]
        addr = addr_expr.value if isinstance(addr_expr, IntLiteral) else 0
        return SensorDecl(
            name=name, sensor_type=sensor_type,
            bus_name=bus_name, address=addr,
            region=_region(children[0]),
        )

    # --- Power ---

    def power_block(self, children):
        items = {}
        for child in children:
            if isinstance(child, tuple) and len(child) == 2:
                items[child[0]] = child[1]
        return PowerBlock(items=items)

    def power_item(self, children):
        key = str(children[0])
        value = children[1]
        return (key, value)

    def power_value(self, children):
        if len(children) == 1:
            return str(children[0])
        return str(children[0])

    # --- Struct ---

    def struct_decl(self, children):
        name = str(children[0])
        fields = [c for c in children[1:] if isinstance(c, FieldDecl)]
        return StructDecl(name=name, fields=fields, region=_region(children[0]))

    def struct_field(self, children):
        name = str(children[0])
        type_name = children[1]
        return FieldDecl(name=name, type_name=type_name, region=_region(children[0]))

    # --- Function ---

    def func_decl(self, children):
        name = str(children[0])
        # Find param_list, return_type, and block among children
        params = []
        ret_type = None
        body = []
        for child in children[1:]:
            if isinstance(child, list):
                # Could be param_list result or block result
                if child and isinstance(child[0], Param):
                    params = child
                else:
                    body = child
            elif isinstance(child, str) and child not in ("", None):
                ret_type = child
        return FuncDecl(
            name=name, params=params, return_type=ret_type, body=body,
            region=_region(children[0]),
        )

    def return_type(self, children):
        return children[0]

    def param_list(self, children):
        return list(children)

    def param(self, children):
        name = str(children[0])
        type_name = children[1]
        return Param(name=name, type_name=type_name, region=_region(children[0]))

    # --- Task ---

    def task_decl(self, children):
        name = str(children[0])
        body = []
        for child in children[1:]:
            if isinstance(child, list):
                body = child
        return TaskDecl(name=name, body=body, region=_region(children[0]))

    # --- State Machine ---

    def machine_decl(self, children):
        name = str(children[0])
        states = [c for c in children[1:] if isinstance(c, StateDecl)]
        variables = [c for c in children[1:] if isinstance(c, VarDecl)]
        return MachineDecl(name=name, states=states, variables=variables,
                           region=_region(children[0]))

    def state_decl(self, children):
        # First token might be INITIAL keyword
        is_initial = False
        name_idx = 0
        if isinstance(children[0], Token) and children[0].type == 'INITIAL':
            is_initial = True
            name_idx = 1

        name = str(children[name_idx])
        state = StateDecl(name=name, is_initial=is_initial, region=_region(children[name_idx]))

        enter_set = False
        exit_set = False
        for child in children[name_idx + 1:]:
            if isinstance(child, tuple):
                if child[0] == 'enter':
                    state.enter_body = child[1]
                elif child[0] == 'exit':
                    state.exit_body = child[1]
            elif isinstance(child, StateTransition):
                state.transitions.append(child)
            elif isinstance(child, TimedTransition):
                state.timed_transitions.append(child)
            elif isinstance(child, (EveryBlock, OnBlock, ExprStmt, VarDecl,
                                     IfStmt, WhileStmt, ForStmt, AssignExpr)):
                state.body.append(child)
        return state

    def state_enter(self, children):
        return ('enter', children[0] if children else [])

    def state_exit(self, children):
        return ('exit', children[0] if children else [])

    def state_on(self, children):
        event = children[0]
        guard = None
        target = None
        action = []

        for child in children[1:]:
            if isinstance(child, Token) and child.type == 'NAME':
                target = str(child)
            elif isinstance(child, list):
                # Could be guard result (single expr wrapped) or action block
                if not target:
                    # Before target = guard
                    guard = child[0] if len(child) == 1 else child
                else:
                    # After target = action
                    action = child
            elif isinstance(child, Node) and target is None:
                guard = child

        if target is None:
            target = str(children[-1]) if children else ""

        return StateTransition(
            event=event, target_state=target, guard=guard, action=action,
            region=_region(children[0]),
        )

    def state_after(self, children):
        duration = children[0]
        guard = None
        target = None
        action = []

        for child in children[1:]:
            if isinstance(child, Token) and child.type == 'NAME':
                target = str(child)
            elif isinstance(child, list):
                if not target:
                    guard = child[0] if len(child) == 1 else child
                else:
                    action = child
            elif isinstance(child, Node) and target is None:
                guard = child

        if target is None:
            target = str(children[-1]) if children else ""

        return TimedTransition(
            duration=duration, target_state=target, guard=guard, action=action,
            region=_region(children[0]),
        )

    def state_guard(self, children):
        return children[0]

    def state_action(self, children):
        return children[0] if children else []

    # --- Storage ---

    def storage_decl(self, children):
        name = str(children[0])
        type_name = children[1]
        value = children[2]
        return StorageDecl(
            name=name, type_name=type_name, default_value=value,
            region=_region(children[0]),
        )

    # --- Setup (v2) ---

    def setup_block(self, children):
        body = children[0] if children and isinstance(children[0], list) else []
        return SetupBlock(body=body)

    # --- Loop (v2) ---

    def loop_block(self, children):
        body = children[0] if children and isinstance(children[0], list) else []
        return LoopBlock(body=body)

    # --- Include ---

    def include_decl(self, children):
        path = str(children[0]).strip('"')
        return path

    # --- Raw ---

    def raw_block(self, children):
        code = str(children[0]).strip('"')
        return RawBlock(c_code=code)

    # --- Block ---

    def block(self, children):
        """Return list of statements, filtering out None/newlines."""
        return [c for c in children if c is not None and isinstance(c, Node)]

    # --- Statements ---

    def var_decl(self, children):
        keyword = str(children[0])
        name = str(children[1])
        mutable = (keyword == "var")

        type_name = None
        value = None
        for child in children[2:]:
            if isinstance(child, str):
                type_name = child
            elif isinstance(child, Node):
                value = child

        return VarDecl(
            name=name, type_name=type_name, value=value, mutable=mutable,
            region=_region(children[1]),
        )

    def shared_var_decl(self, children):
        keyword = str(children[0])
        name = str(children[1])
        mutable = (keyword == "var")

        type_name = None
        value = None
        for child in children[2:]:
            if isinstance(child, str):
                type_name = child
            elif isinstance(child, Node):
                value = child

        return VarDecl(
            name=name, type_name=type_name, value=value, mutable=mutable,
            shared=True,
            region=_region(children[1]),
        )

    def channel_decl(self, children):
        name = str(children[0])
        elem_type = str(children[1])
        capacity = 4  # default
        for child in children[2:]:
            if isinstance(child, Token) and child.type == 'INT':
                capacity = int(str(child))
        return ChannelDecl(name=name, elem_type=elem_type, capacity=capacity,
                          region=_region(children[0]))

    def type_annotation(self, children):
        return children[0]

    def assign_op(self, children):
        return AssignExpr(target=children[0], value=children[1], region=_region(children[0]))

    def return_stmt(self, children):
        value = children[0] if children else None
        return ReturnStmt(value=value)

    def expr_stmt(self, children):
        expr = children[0]
        if isinstance(expr, AssignExpr):
            return expr
        return ExprStmt(expr=expr)

    def if_stmt(self, children):
        condition = children[0]
        then_body = children[1] if len(children) > 1 and isinstance(children[1], list) else []
        else_body = None
        if len(children) > 2:
            else_body = children[2]
        return IfStmt(
            condition=condition, then_body=then_body, else_body=else_body,
            region=_region(children[0]),
        )

    def else_clause(self, children):
        if isinstance(children[0], IfStmt):
            return children[0]
        return children[0]

    def while_stmt(self, children):
        return WhileStmt(
            condition=children[0],
            body=children[1] if len(children) > 1 and isinstance(children[1], list) else [],
            region=_region(children[0]),
        )

    def for_stmt(self, children):
        var_name = str(children[0])
        start = children[1]
        end = children[2]
        step = None
        body = []
        for child in children[3:]:
            if isinstance(child, list):
                body = child
            elif isinstance(child, Node):
                step = child  # step clause expression
        return ForStmt(
            var_name=var_name, start=start, end=end, body=body,
            region=_region(children[0]),
        )

    def step_clause(self, children):
        return children[0]

    def loop_stmt(self, children):
        body = children[0] if children and isinstance(children[0], list) else []
        return WhileStmt(
            condition=BoolLiteral(value=True),
            body=body,
            region=_region_span(children) if children else Region(),
        )

    def break_stmt(self, children):
        return BreakStmt(region=_region(children[0]) if children else Region())

    def continue_stmt(self, children):
        return ContinueStmt(region=_region(children[0]) if children else Region())

    def assign_stmt(self, children):
        target = children[0]
        op = str(children[1])
        value = children[2]
        return CompoundAssign(target=target, op=op, value=value, region=_region(children[0]))

    def every_block(self, children):
        interval = children[0]
        strict = False
        body = []
        for child in children[1:]:
            if isinstance(child, Token) and child.type == 'STRICT':
                strict = True
            elif isinstance(child, list):
                body = child
        return EveryBlock(interval=interval, strict=strict, body=body, region=_region(children[0]))

    def on_block(self, children):
        event = children[0]
        debounce = None
        throttle = None
        body = []
        for child in children[1:]:
            if isinstance(child, list):
                body = child
            elif isinstance(child, tuple):
                kind, val = child
                if kind == 'debounce':
                    debounce = val
                elif kind == 'throttle':
                    throttle = val
        return OnBlock(
            event=event, debounce=debounce, throttle=throttle, body=body,
            region=_region(children[0]),
        )

    def debounce_clause(self, children):
        return ('debounce', children[0])

    def throttle_clause(self, children):
        return ('throttle', children[0])

    def timeout_block(self, children):
        duration = children[0]
        try_body = children[1] if len(children) > 1 and isinstance(children[1], list) else []
        fallback = children[2] if len(children) > 2 and isinstance(children[2], list) else []
        return TimeoutBlock(
            duration=duration, try_body=try_body, fallback_body=fallback,
            region=_region(children[0]),
        )

    def match_stmt(self, children):
        expr = children[0]
        arms = [c for c in children[1:] if isinstance(c, MatchArm)]
        return MatchStmt(expr=expr, arms=arms, region=_region(children[0]))

    def match_arm(self, children):
        pattern = children[0]
        body = children[1] if len(children) > 1 else None
        return MatchArm(pattern=pattern, body=body, region=_region(children[0]) if not isinstance(children[0], str) else Region())

    def match_name(self, children):
        return str(children[0])

    def match_int(self, children):
        return str(children[0])

    def match_range(self, children):
        return f"{children[0]}..{children[1]}"

    def match_wildcard(self, children):
        return "_"

    # --- Expressions ---

    def or_op(self, children):
        return BinaryExpr(left=children[0], op="||", right=children[1], region=_region(children[0]))

    def and_op(self, children):
        return BinaryExpr(left=children[0], op="&&", right=children[1], region=_region(children[0]))

    def comp_op(self, children):
        return BinaryExpr(left=children[0], op=str(children[1]), right=children[2], region=_region(children[0]))

    def add_op(self, children):
        return BinaryExpr(left=children[0], op="+", right=children[1], region=_region(children[0]))

    def sub_op(self, children):
        return BinaryExpr(left=children[0], op="-", right=children[1], region=_region(children[0]))

    def mul_op(self, children):
        return BinaryExpr(left=children[0], op="*", right=children[1], region=_region(children[0]))

    def div_op(self, children):
        return BinaryExpr(left=children[0], op="/", right=children[1], region=_region(children[0]))

    def mod_op(self, children):
        return BinaryExpr(left=children[0], op="%", right=children[1], region=_region(children[0]))

    # Bitwise operators
    def bitor_op(self, children):
        return BinaryExpr(left=children[0], op="|", right=children[2], region=_region(children[0]))

    def bitxor_op(self, children):
        return BinaryExpr(left=children[0], op="^", right=children[2], region=_region(children[0]))

    def bitand_op(self, children):
        return BinaryExpr(left=children[0], op="&", right=children[2], region=_region(children[0]))

    def shl_op(self, children):
        return BinaryExpr(left=children[0], op="<<", right=children[2], region=_region(children[0]))

    def shr_op(self, children):
        return BinaryExpr(left=children[0], op=">>", right=children[2], region=_region(children[0]))

    def comp_lt(self, children):
        return BinaryExpr(left=children[0], op="<", right=children[2], region=_region(children[0]))

    def comp_gt(self, children):
        return BinaryExpr(left=children[0], op=">", right=children[2], region=_region(children[0]))

    def not_expr(self, children):
        return UnaryExpr(op="!", operand=children[0], region=_region(children[0]))

    def neg_expr(self, children):
        return UnaryExpr(op="-", operand=children[0], region=_region(children[0]))

    def bitnot_expr(self, children):
        return UnaryExpr(op="~", operand=children[0], region=_region(children[0]))

    def dot_access(self, children):
        obj = children[0]
        field_name = str(children[1])
        return DotAccess(obj=obj, field_name=field_name, region=_region(children[0]))

    def func_call(self, children):
        callee = children[0]
        args = children[1] if len(children) > 1 else []
        if isinstance(args, Node):
            args = [args]

        # led.toggle() → MethodCall
        if isinstance(callee, DotAccess):
            return MethodCall(
                obj=callee.obj, method=callee.field_name, args=args,
                region=callee.region,
            )

        # log(42) → FuncCall
        if isinstance(callee, VarRef):
            return FuncCall(name=callee.name, args=args, region=callee.region)

        # Fallback: shouldn't normally happen
        return FuncCall(name=str(callee), args=args, region=_region(callee))

    def arg_list(self, children):
        return list(children)

    def named_args(self, children):
        result = {}
        for child in children:
            if isinstance(child, tuple):
                result[child[0]] = child[1]
        return result

    def named_arg(self, children):
        return (str(children[0]), children[1])

    # --- Literals ---

    def int_lit(self, tokens):
        token = tokens[0]
        val = str(token)
        value = int(val, 16) if val.startswith('0x') else int(val)
        return IntLiteral(value=value, region=_region(token))

    def float_lit(self, tokens):
        token = tokens[0]
        return FloatLiteral(value=float(str(token)), region=_region(token))

    def string_lit(self, tokens):
        token = tokens[0]
        # Remove surrounding quotes and handle escapes
        raw = str(token)
        if raw.startswith('"') and raw.endswith('"'):
            raw = raw[1:-1]
        return StringLiteral(value=raw, region=_region(token))

    def true_lit(self, tokens):
        return BoolLiteral(value=True, region=_region(tokens[0]) if tokens else Region())

    def false_lit(self, tokens):
        return BoolLiteral(value=False, region=_region(tokens[0]) if tokens else Region())

    def duration_lit(self, tokens):
        token = tokens[0]
        us, original = _parse_duration(str(token))
        return DurationLiteral(microseconds=us, original=original, region=_region(token))

    def hex_lit(self, tokens):
        token = tokens[0]
        return IntLiteral(value=int(str(token), 16), region=_region(token))

    def bin_lit(self, tokens):
        token = tokens[0]
        return IntLiteral(value=int(str(token).replace('_', ''), 2), region=_region(token))

    def array_literal(self, children):
        return ArrayLiteral(elements=list(children), region=_region_span(children) if children else Region())

    def var_ref(self, tokens):
        token = tokens[0]
        return VarRef(name=str(token), region=_region(token))

    # --- Types ---

    def simple_type(self, tokens):
        return str(tokens[0])

    def generic_type(self, children):
        return f"{children[0]}<{children[1]}>"

    def sized_type(self, children):
        return f"{children[0]}<{children[1]}>"


# ============================================================
# Public API
# ============================================================

def parse(source: str) -> Program:
    """Parse a Volt source string into an AST Program node."""
    tree = _lark_parser.parse(source)
    return ASTBuilder().transform(tree)
