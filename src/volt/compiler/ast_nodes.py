"""
Volt AST Node Definitions

Every construct in the Volt language is represented by one of these
dataclasses. The parser (parser.py) converts Lark's parse tree into
these nodes. Every node carries a Region (source location) so errors
can point to the exact line and column.

Passes 2-7 of the pipeline read and transform these nodes.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any


# ============================================================
# Source Location
# ============================================================

@dataclass
class Region:
    """Points to a span in the source file. Every AST node has one."""
    start_line: int = 0
    start_col: int = 0
    end_line: int = 0
    end_col: int = 0


# ============================================================
# Base Node
# ============================================================

@dataclass
class Node:
    """Base class for all AST nodes."""
    region: Region = field(default_factory=Region)


# ============================================================
# Program (root)
# ============================================================

@dataclass
class Program(Node):
    """The root of every .volt file."""
    chip: ChipDecl | None = None
    hardware: HardwareBlock | None = None
    power: PowerBlock | None = None
    structs: list[StructDecl] = field(default_factory=list)
    enums: list[EnumDecl] = field(default_factory=list)
    functions: list[FuncDecl] = field(default_factory=list)
    tasks: list[TaskDecl] = field(default_factory=list)
    machines: list[MachineDecl] = field(default_factory=list)
    storage_vars: list[StorageDecl] = field(default_factory=list)
    global_vars: list[VarDecl] = field(default_factory=list)
    channels: list[ChannelDecl] = field(default_factory=list)
    setup: SetupBlock | None = None         # runs once at boot
    loop: LoopBlock | None = None           # super-loop (alternative to tasks)
    raw_blocks: list[RawBlock] = field(default_factory=list)
    includes: list[str] = field(default_factory=list)


# ============================================================
# Top-Level Declarations
# ============================================================

@dataclass
class ChipDecl(Node):
    """chip esp32"""
    target: str = ""


@dataclass
class HardwareBlock(Node):
    """hardware { ... }"""
    pins: list[PinDecl] = field(default_factory=list)
    buses: list[BusDecl] = field(default_factory=list)
    sensors: list[SensorDecl] = field(default_factory=list)


@dataclass
class PinDecl(Node):
    """pin led: Output = 2"""
    name: str = ""
    mode: str = ""          # "Output", "Input", "PullUpInput", "Analog", "PWM"
    gpio: int = 0


@dataclass
class BusDecl(Node):
    """i2c sensors = i2c(sda: 21, scl: 22, speed: 400000)"""
    bus_type: str = ""      # "i2c" or "spi"
    name: str = ""
    params: dict = field(default_factory=dict)  # {"sda": 21, "scl": 22}


@dataclass
class SensorDecl(Node):
    """device bme: BME280 on sensors at 0x76"""
    name: str = ""
    sensor_type: str = ""   # "BME280", "DHT22", etc.
    bus_name: str = ""      # which bus it's on
    address: int = 0        # I2C address


@dataclass
class PowerBlock(Node):
    """power { source: battery(3700, 2000), charging: solar }"""
    items: dict = field(default_factory=dict)


@dataclass
class StructDecl(Node):
    """struct Reading { temperature: float ... }"""
    name: str = ""
    fields: list[FieldDecl] = field(default_factory=list)


@dataclass
class EnumDecl(Node):
    """enum Color { red, green, blue }"""
    name: str = ""
    variants: list[str] = field(default_factory=list)


@dataclass
class FieldDecl(Node):
    """A field inside a struct definition."""
    name: str = ""
    type_name: str = ""


@dataclass
class FuncDecl(Node):
    """func add(a: int, b: int) -> int { ... }"""
    name: str = ""
    params: list[Param] = field(default_factory=list)
    return_type: str | None = None  # None = void
    body: list[Statement] = field(default_factory=list)
    # Populated by analyzer:
    contains_yield: bool = False    # does this function sleep/yield?


@dataclass
class Param(Node):
    """A function parameter: name: type"""
    name: str = ""
    type_name: str = ""


@dataclass
class TaskDecl(Node):
    """task blink() { ... }"""
    name: str = ""
    body: list[Statement] = field(default_factory=list)
    # Populated by analyzer (Pass 5):
    tier: str = ""              # "critical", "priority", "background"
    crossing_vars: list[str] = field(default_factory=list)  # vars that need lifting
    has_strict: bool = False    # contains every...strict


@dataclass
class SetupBlock(Node):
    """setup { ... } — runs once at boot before tasks start"""
    body: list[Statement] = field(default_factory=list)


@dataclass
class LoopBlock(Node):
    """loop { ... } — super-loop, runs forever (alternative to tasks)"""
    body: list[Statement] = field(default_factory=list)


@dataclass
class BreakStmt(Node):
    """break — exit a loop or every block"""
    pass


@dataclass
class ContinueStmt(Node):
    """continue — skip to next iteration"""
    pass


@dataclass
class CompoundAssign(Node):
    """count += 1, mask |= 0x04"""
    target: Expr = None
    op: str = ""            # "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="
    value: Expr = None


@dataclass
class RawBlock(Node):
    """raw { ... } — C code passed through verbatim."""
    c_code: str = ""


@dataclass
class OrExpr(Node):
    """expr or fallback — error handling for fallible calls."""
    expr: Expr = None           # the fallible call
    fallback: Expr = None       # default value, or None for skip/restart
    kind: str = "default"       # "skip", "restart", "retry", "default"


@dataclass
class StorageDecl(Node):
    """storage boot_count: int = 0 — persists across reboot/deep sleep."""
    name: str = ""
    type_name: str = ""
    default_value: Expr = None


# ============================================================
# State Machine
# ============================================================

@dataclass
class MachineDecl(Node):
    """machine DeviceState { var x = 0  state idle { ... } ... }"""
    name: str = ""
    states: list[StateDecl] = field(default_factory=list)
    variables: list[VarDecl] = field(default_factory=list)  # machine context vars


@dataclass
class StateDecl(Node):
    """state idle { enter { ... } on X -> Y ... }"""
    name: str = ""
    is_initial: bool = False                                   # initial state
    enter_body: list[Statement] = field(default_factory=list)  # enter { ... }
    exit_body: list[Statement] = field(default_factory=list)   # exit { ... }
    transitions: list[StateTransition] = field(default_factory=list)
    timed_transitions: list[TimedTransition] = field(default_factory=list)
    body: list[Statement] = field(default_factory=list)  # every, on, etc.


@dataclass
class StateTransition(Node):
    """on wifi.connected() [guard] -> running { action }"""
    event: Expr = None
    target_state: str = ""
    guard: Expr | None = None                                  # [condition]
    action: list[Statement] = field(default_factory=list)      # { transition code }


@dataclass
class TimedTransition(Node):
    """after 5seconds [guard] -> idle { action }"""
    duration: Expr = None
    target_state: str = ""
    guard: Expr | None = None
    action: list[Statement] = field(default_factory=list)


# ============================================================
# Statements
# ============================================================

# Type alias for clarity
Statement = Any  # VarDecl | AssignStmt | ReturnStmt | ExprStmt | IfStmt | ...
Expr = Any       # Literal | VarRef | BinaryExpr | CallExpr | ...


@dataclass
class VarDecl(Node):
    """let x = 42  or  var count: int = 0  or  shared var x: int = 0"""
    name: str = ""
    type_name: str | None = None  # None = infer from value
    value: Expr = None
    mutable: bool = False         # let = False, var = True
    shared: bool = False          # shared = atomic access across tasks
    # Populated by analyzer:
    needs_lifting: bool = False   # must be moved to context struct


@dataclass
class ChannelDecl(Node):
    """channel<int, 8> sensor_data"""
    name: str = ""
    elem_type: str = "int"
    capacity: int = 4             # default buffer size


@dataclass
class AssignExpr(Node):
    """x = 5  or  data.temp = 23.5"""
    target: Expr = None     # VarRef or FieldAccess
    value: Expr = None


@dataclass
class ReturnStmt(Node):
    """return expr  or  return"""
    value: Expr | None = None


@dataclass
class ExprStmt(Node):
    """An expression used as a statement (e.g., a function call)."""
    expr: Expr = None


@dataclass
class IfStmt(Node):
    """if condition { ... } else { ... }"""
    condition: Expr = None
    then_body: list[Statement] = field(default_factory=list)
    else_body: list[Statement] | None = None  # None = no else


@dataclass
class WhileStmt(Node):
    """while condition { ... }"""
    condition: Expr = None
    body: list[Statement] = field(default_factory=list)


@dataclass
class ForStmt(Node):
    """for i in 0..10 { ... }  or  for i in 0..100 step 5 { ... }"""
    var_name: str = ""
    start: Expr = None
    end: Expr = None
    body: list[Statement] = field(default_factory=list)
    step: Expr = None


@dataclass
class EveryBlock(Node):
    """every 500ms { ... }  or  every 1ms strict { ... }  or  every 10s when expr { ... }"""
    interval: Expr = None           # duration expression
    strict: bool = False            # strict = critical tier (hardware timer ISR)
    guard: Expr = None              # v3: when clause — body only runs if guard is true
    body: list[Statement] = field(default_factory=list)
    yield_label: int = 0            # assigned by transformer (Pass 6)


@dataclass
class OnBlock(Node):
    """on button.press() debounce 50ms { ... }"""
    event: Expr = None
    debounce: Expr | None = None    # optional debounce duration
    throttle: Expr | None = None    # optional throttle duration
    body: list[Statement] = field(default_factory=list)
    yield_label: int = 0            # assigned by transformer (Pass 6)
    debounce_label: int = 0         # assigned by transformer (Pass 6)


@dataclass
class TimeoutBlock(Node):
    """timeout 10seconds { action } { on_timeout }"""
    duration: Expr = None
    try_body: list[Statement] = field(default_factory=list)
    fallback_body: list[Statement] = field(default_factory=list)


@dataclass
class MatchStmt(Node):
    """match(state) { .idle -> expr ... }"""
    expr: Expr = None
    arms: list[MatchArm] = field(default_factory=list)


@dataclass
class MatchArm(Node):
    """A single arm: .idle -> log("idle")"""
    pattern: str = ""       # the name after the dot
    body: Expr | list[Statement] = None  # single expr or block


# ============================================================
# Expressions
# ============================================================

@dataclass
class IntLiteral(Node):
    """42, 0xFF"""
    value: int = 0


@dataclass
class FloatLiteral(Node):
    """3.14"""
    value: float = 0.0


@dataclass
class BoolLiteral(Node):
    """true, false"""
    value: bool = False


@dataclass
class StringLiteral(Node):
    """\"hello world\""""
    value: str = ""


@dataclass
class DurationLiteral(Node):
    """500ms, 5s, 10min, 100us"""
    microseconds: int = 0   # everything normalized to microseconds
    original: str = ""      # "500ms", "5s" — for error messages

    @property
    def milliseconds(self) -> int:
        return self.microseconds // 1000


@dataclass
class ArrayLiteral(Node):
    """[1, 2, 3]"""
    elements: list[Expr] = field(default_factory=list)


@dataclass
class VarRef(Node):
    """Reference to a variable by name."""
    name: str = ""
    # Populated by resolver (Pass 2):
    # symbol: Symbol | None = None


@dataclass
class BinaryExpr(Node):
    """a + b, x == y, p && q, mask & 0xFF, val << 2"""
    left: Expr = None
    op: str = ""            # "+", "-", "*", "/", "%", "==", "!=", "<", ">", "<=", ">=",
                            # "&&", "||", "&", "|", "^", "<<", ">>"
    right: Expr = None
    # Populated by checker (Pass 3):
    result_type: str | None = None


@dataclass
class UnaryExpr(Node):
    """!done, -42"""
    op: str = ""            # "!" or "-"
    operand: Expr = None


@dataclass
class DotAccess(Node):
    """data.temperature — field access on a struct or object."""
    obj: Expr = None
    field_name: str = ""


@dataclass
class FuncCall(Node):
    """log(42), add(1, 2)"""
    name: str = ""
    args: list[Expr] = field(default_factory=list)


@dataclass
class MethodCall(Node):
    """led.toggle(), wifi.connect("net", "pass")"""
    obj: Expr = None        # the object before the dot
    method: str = ""        # the method name
    args: list[Expr] = field(default_factory=list)


# ============================================================
# Type annotations (used in VarDecl, Param, StructField, etc.)
# ============================================================

@dataclass
class SimpleType(Node):
    """int, float, bool, string, or a struct name."""
    name: str = ""


@dataclass
class GenericType(Node):
    """list<int>, list<float>"""
    name: str = ""
    type_arg: str = ""


@dataclass
class SizedType(Node):
    """buffer<128>"""
    name: str = ""
    size: int = 0
