# Volt Transpiler Architecture

> **Status: IMPLEMENTED and tested.** 515 tests, all passing. Full pipeline generates C code for embedded targets (ESP32 first).

## Design Principles

1. **Seven-pass pipeline** — each pass does one thing, is testable independently
2. **Errors are first-class** — structured, Elm-style, with source context and suggestions
3. **Never crash** — any input (even garbage) produces error messages, never an exception
4. **Bidirectional type checking** — simple, produces naturally good error messages
5. **Registry-based extensibility** — adding a sensor = adding to a registry, not modifying the compiler
6. **Snapshot-tested** — every test case is an input file + expected output file

---

## 1. Pipeline Overview

```
.volt source file
       │
       ▼
┌─────────────────────┐
│ Pass 1: PARSE       │  Lark LALR(1) grammar → parse tree → AST
│ grammar.lark        │  Errors: syntax errors ("unexpected token")
│ parser.py           │  Output: AST (Python dataclasses with line/col)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Pass 2: RESOLVE     │  Two-pass name resolution
│ resolver.py         │  Pass 2a: collect all top-level declarations
│                     │  Pass 2b: resolve all references in bodies
│                     │  Errors: "unknown name", "duplicate declaration"
│                     │  Output: AST + populated symbol table
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Pass 3: CHECK       │  Bidirectional type checking
│ checker.py          │  Infer types for expressions
│                     │  Check assignments, function calls, operators
│                     │  Errors: "type mismatch", "wrong argument count"
│                     │  Output: typed AST (every expr has a .type field)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Pass 4: VALIDATE    │  Hardware-aware validation (Volt-unique)
│ hardware.py         │  Pin capability checking
│ pins_esp32.py       │  Pin conflict detection (duplicate, flash, input-only)
│                     │  ADC2/WiFi conflict detection
│                     │  I2C address uniqueness per bus
│                     │  Errors: "GPIO 6 is flash", "ADC2 blocked by WiFi"
│                     │  Output: same AST, hardware-validated
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Pass 5: ANALYZE     │  Task classification + yield analysis
│ analyzer.py         │  Classify each task: Critical / Priority / Background
│                     │  Find yield points (every, sleep, on, wait_until)
│                     │  Track which variables cross yield boundaries
│                     │  Detect shared state between tasks
│                     │  Estimate WCET for critical tasks
│                     │  Errors: "critical task calls log()", "shared mutable state"
│                     │  Output: annotated AST (vars marked for lifting, tasks classified)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Pass 6: TRANSFORM   │  AST rewriting for C generation
│ transformer.py      │  Lift yield-crossing vars to context structs
│                     │  Inline functions that contain yields
│                     │  Convert match → if/else chains
│                     │  Desugar string interpolation → snprintf
│                     │  Desugar duration literals → milliseconds
│                     │  Output: C-ready AST
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Pass 7: GENERATE    │  Emit C source code
│ codegen.py          │  Emit #include "volt.h"
│                     │  Emit context structs for tasks
│                     │  Emit protothread functions (Background tasks)
│                     │  Emit FreeRTOS task functions (Priority tasks)
│                     │  Emit timer ISR functions (Critical tasks)
│                     │  Emit app_main() with init sequence
│                     │  Emit #line directives for user code only
│                     │  Output: single .c file
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ BUILD               │  Invoke ESP-IDF build system
│ (cli/build.py)      │  Copy generated .c into framework/main/
│                     │  Run idf.py build
│                     │  Parse output for memory/flash sizes
│                     │  Display build report
└─────────────────────┘
```

---

## 2. File Structure

```
compiler/
├── voltc.py              # Entry point — orchestrates the 7-pass pipeline
├── grammar.lark          # Lark EBNF grammar for Volt syntax
│
├── ast_nodes.py          # All AST node types (dataclasses)
│                         #   Region, ChipDecl, HardwareBlock, PinDecl,
│                         #   BusDecl, SensorDecl, VarDecl, FuncDecl,
│                         #   TaskDecl, EveryBlock, OnBlock, IfStmt,
│                         #   WhileStmt, MatchStmt, ReturnStmt, CallExpr,
│                         #   BinaryExpr, UnaryExpr, FieldAccess, Literal,
│                         #   StringInterp, MainBlock, RawBlock, StructDecl
│
├── parser.py             # Pass 1: Lark Transformer → AST
│                         #   propagate_positions=True for line/col tracking
│                         #   Every AST node gets a Region(start_line, start_col, end_line, end_col)
│
├── symbols.py            # Symbol table with nested scopes
│                         #   Scope: parent link, dict of name → Symbol
│                         #   Symbol: name, type, kind (var/func/task/pin/sensor), region
│                         #   Supports: enter_scope(), exit_scope(), declare(), lookup()
│
├── resolver.py           # Pass 2: Name resolution (two-pass)
│                         #   Pass 2a: walk top-level, register all funcs/tasks/structs/pins
│                         #   Pass 2b: walk bodies, resolve all name references
│                         #   Attaches Symbol to every VarRef/FuncCall node
│
├── types.py              # Type system
│                         #   VoltType (base), IntType, FloatType, BoolType, StringType,
│                         #   VoidType, ErrorType (poison), StructType, PinType(mode),
│                         #   SensorType(model), DurationType
│                         #   types_compatible(a, b) → bool
│                         #   common_type(a, b) → VoltType (for binary ops)
│
├── checker.py            # Pass 3: Bidirectional type checker
│                         #   infer(expr, scope) → VoltType
│                         #   check(expr, expected_type, scope) → void or error
│                         #   Rules: no implicit int↔float, string concat with +,
│                         #          bool only for &&/||/!, comparison returns bool
│
├── hardware.py           # Pass 4: Hardware validation engine
│                         #   validate_pins(ast, errors) — capability, conflicts, flash pins
│                         #   validate_buses(ast, errors) — I2C addresses unique per bus
│                         #   validate_adc_wifi(ast, errors) — ADC2 + WiFi conflict
│                         #   validate_strapping(ast, errors) — warn on GPIO 0,2,5,12,15
│
├── pins_esp32.py         # ESP32 pin database
│                         #   PIN_DB[gpio_num] → PinInfo(capabilities, adc_channel,
│                         #                              touch_channel, warnings, blocked_reason)
│                         #   is_valid(pin) → bool
│                         #   can_output(pin) → bool
│                         #   can_input(pin) → bool
│                         #   can_analog(pin) → bool
│                         #   is_adc2(pin) → bool
│                         #   get_warning(pin) → str | None
│
├── analyzer.py           # Pass 5: Task analysis
│                         #   classify_task(task) → CRITICAL | PRIORITY | BACKGROUND
│                         #   find_yield_points(task) → list[YieldPoint]
│                         #   find_crossing_vars(task, yields) → list[VarDecl]
│                         #   detect_shared_state(tasks) → list[Warning]
│                         #   estimate_wcet(task) → Duration | None
│                         #   check_critical_safety(task, errors) — no log/wifi/malloc in ISR
│
├── transformer.py        # Pass 6: AST rewriting
│                         #   lift_variables(task, crossing_vars) → add ContextStruct to task
│                         #   inline_yielding_calls(task) → flatten call sites
│                         #   desugar_match(node) → IfElseChain
│                         #   desugar_string_interp("x={val}") → snprintf call
│                         #   desugar_duration(500ms) → integer 500
│                         #   desugar_every(block) → while(1){...sleep...} protothread
│
├── codegen.py            # Pass 7: C code generation
│                         #   CCodeGen class with:
│                         #     emit_header() — includes, forward decls
│                         #     emit_structs() — user structs + context structs
│                         #     emit_task_background(task) — protothread function
│                         #     emit_task_priority(task) — FreeRTOS task function
│                         #     emit_task_critical(task) — timer ISR function
│                         #     emit_functions() — user-defined functions
│                         #     emit_app_main() — init sequence + volt_run()
│                         #     emit_line(volt_line) — #line directive
│                         #   Output: single string of C code
│
├── errors.py             # Error infrastructure
│                         #   CompilerError: region, category, message, hint, severity
│                         #   CompilerErrors: accumulator, has_errors(), report()
│                         #   format_error(error, source_lines) → colored string
│                         #   suggest_similar(name, known_names) → str | None (Levenshtein)
│                         #   Error categories:
│                         #     SYNTAX_ERROR, NAME_ERROR, TYPE_MISMATCH,
│                         #     HARDWARE_ERROR, HARDWARE_WARNING,
│                         #     TASK_ERROR, TASK_WARNING
│
├── registry.py           # Type + hardware component registries
│                         #   TypeRegistry: register/lookup built-in and sensor types
│                         #   HardwareRegistry: register/lookup hardware components
│                         #   Each sensor type defines: methods, return types, init code
│                         #   Adding a sensor = adding to registry, not modifying compiler
│
└── tests/
    ├── conftest.py       # Shared test fixtures
    ├── cases/            # Snapshot test cases
    │   ├── 01_blink/
    │   │   ├── input.volt
    │   │   └── expected.c
    │   ├── 02_wifi_mqtt/
    │   │   ├── input.volt
    │   │   └── expected.c
    │   ├── 03_type_error/
    │   │   ├── input.volt
    │   │   └── expected_errors.txt
    │   ├── 04_pin_conflict/
    │   │   ├── input.volt
    │   │   └── expected_errors.txt
    │   ├── 05_task_classify/
    │   │   ├── input.volt
    │   │   └── expected.c
    │   └── ...
    ├── test_parser.py    # Grammar rule tests
    ├── test_resolver.py  # Name resolution tests
    ├── test_checker.py   # Type checking tests
    ├── test_hardware.py  # Pin/bus validation tests
    ├── test_analyzer.py  # Yield analysis + task classification tests
    ├── test_codegen.py   # C output correctness tests
    ├── test_snapshot.py  # Snapshot test runner (all cases/ dirs)
    └── test_fuzz.py      # Fuzzer: random input must never crash
```

---

## 3. AST Node Design

Every node carries its source location for error reporting:

```python
@dataclass
class Region:
    start_line: int
    start_col: int
    end_line: int
    end_col: int

@dataclass
class ASTNode:
    region: Region

# Declarations
@dataclass
class ChipDecl(ASTNode):
    target: str                # "esp32"

@dataclass
class PinDecl(ASTNode):
    name: str                  # "led"
    mode: str                  # "Output", "Input", "Input.PullUp", "Analog", "PWM"
    gpio: int                  # 2

@dataclass
class BusDecl(ASTNode):
    name: str                  # "sensors"
    bus_type: str              # "i2c" or "spi"
    params: dict               # {"sda": 21, "scl": 22, "speed": 400000}

@dataclass
class SensorDecl(ASTNode):
    name: str                  # "bme"
    sensor_type: str           # "BME280"
    bus_name: str              # "sensors" (references a BusDecl)
    address: int               # 0x76

@dataclass
class VarDecl(ASTNode):
    name: str
    var_type: VoltType | None  # None = needs inference
    value: Expr
    mutable: bool              # let = False, var = True

@dataclass
class FuncDecl(ASTNode):
    name: str
    params: list[Param]
    return_type: VoltType | None  # None = void
    body: list[Statement]

@dataclass
class TaskDecl(ASTNode):
    name: str
    body: list[Statement]
    strict: bool = False       # "strict" keyword = Critical tier
    # Populated by analyzer:
    tier: str = ""             # "critical", "priority", "background"
    crossing_vars: list = None # Variables that need lifting
    context_struct: str = ""   # Generated struct name

@dataclass
class StructDecl(ASTNode):
    name: str
    fields: list[FieldDecl]

# Statements
@dataclass
class EveryBlock(ASTNode):
    interval: Expr             # Duration expression
    body: list[Statement]
    strict: bool = False

@dataclass
class OnBlock(ASTNode):
    event: Expr                # e.g., button.press()
    body: list[Statement]
    debounce: Expr | None      # Optional debounce duration

@dataclass
class IfStmt(ASTNode):
    condition: Expr
    then_body: list[Statement]
    else_body: list[Statement] | None

@dataclass
class WhileStmt(ASTNode):
    condition: Expr
    body: list[Statement]

@dataclass
class MatchStmt(ASTNode):
    expr: Expr
    arms: list[MatchArm]       # [(pattern, body), ...]

@dataclass
class ReturnStmt(ASTNode):
    value: Expr | None

@dataclass
class RawBlock(ASTNode):
    c_code: str                # Passed through verbatim

@dataclass
class MainBlock(ASTNode):
    body: list[Statement]

# Expressions
@dataclass
class Literal(ASTNode):
    value: any
    lit_type: VoltType         # IntType, FloatType, BoolType, StringType

@dataclass
class VarRef(ASTNode):
    name: str
    symbol: Symbol = None      # Populated by resolver

@dataclass
class BinaryExpr(ASTNode):
    left: Expr
    op: str                    # "+", "-", "*", "/", "==", "!=", "<", ">", "&&", "||"
    right: Expr

@dataclass
class CallExpr(ASTNode):
    name: str                  # "log", "wifi.connect", "bme.temperature"
    args: list[Expr]

@dataclass
class FieldAccess(ASTNode):
    obj: Expr
    field: str

@dataclass
class StringInterp(ASTNode):
    parts: list                # Mix of strings and expressions: ["temp=", Expr, " degrees"]

@dataclass
class DurationLiteral(ASTNode):
    value: int
    unit: str                  # "us", "ms", "s", "seconds", "minutes", "hours"
```

---

## 4. Error System Design

### Error Structure

```python
@dataclass
class CompilerError:
    region: Region
    category: str              # "SYNTAX ERROR", "TYPE MISMATCH", "HARDWARE ERROR", etc.
    message: str               # Human-readable main message
    hint: str | None = None    # Optional suggestion
    severity: str = "error"    # "error" or "warning"

class CompilerErrors:
    def __init__(self):
        self.errors: list[CompilerError] = []
        self._source_lines: list[str] = []

    def set_source(self, source: str):
        self._source_lines = source.splitlines()

    def error(self, region: Region, category: str, message: str, hint: str = None):
        self.errors.append(CompilerError(region, category, message, hint, "error"))

    def warning(self, region: Region, category: str, message: str, hint: str = None):
        self.errors.append(CompilerError(region, category, message, hint, "warning"))

    @property
    def has_errors(self) -> bool:
        return any(e.severity == "error" for e in self.errors)

    def report(self) -> str:
        """Format all errors with source context, sorted by line number."""
        lines = []
        for err in sorted(self.errors, key=lambda e: e.region.start_line):
            lines.append(format_error(err, self._source_lines))
        return "\n".join(lines)
```

### Error Output Format

```
-- HARDWARE ERROR -------------------- main.volt:5

GPIO 6 is connected to the SPI flash chip and cannot be used.

 4 | hardware {
 5 |     pin motor: Output = 6
   |                          ^
 6 | }

Available output pins: 2, 4, 5, 12-19, 21-23, 25-27, 32-33


-- TYPE MISMATCH --------------------- main.volt:12

Expected `int` but got `string`.

 11 | task blink() {
 12 |     let delay: int = "fast"
    |                      ^^^^^^
 13 | }

Hint: Remove the type annotation to let the compiler infer it,
      or change the value to an integer like `500`.


-- TASK WARNING ---------------------- main.volt:18

Task `motor_pid` is classified as Critical (runs in hardware timer ISR)
but calls `log()` which is not safe in ISR context.

 17 | task motor_pid() {
 18 |     every 1ms strict {
 19 |         log("tick")
    |         ^^^
 20 |     }
 21 | }

Hint: Remove the log() call, or remove `strict` to make this
      a Background task instead.
```

---

## 5. Type System

### Bidirectional Type Checking

Two modes that call each other:

```
infer(expr) → Type
    "Given this expression, what type does it have?"
    Used for: literals, variable references, function calls, field access

check(expr, expected_type) → void or error
    "Verify this expression has this type."
    Used for: assignments, function arguments, return statements
```

### Type Compatibility Rules

```
int     + int     → int
float   + float   → float
int     + float   → ERROR ("cannot mix int and float, use float(x)")
string  + string  → string (concatenation)
int     == int    → bool
float   == float  → bool
string  == string → bool
bool    && bool   → bool
bool    || bool   → bool
!bool             → bool

Assignment: let x: int = float_expr → ERROR
            let x: float = int_expr → ERROR (no implicit conversion)
            let x = 42             → x is int (inferred)
            let x = 3.14           → x is float (inferred)
```

### The ErrorType (Poison)

When a type error is found, the variable gets `ErrorType`. Any operation on `ErrorType` silently returns `ErrorType` — this prevents cascading errors where one mistake produces 20 error messages.

```python
class ErrorType(VoltType):
    """Poison type — absorbs all operations silently."""
    pass

def infer_binary_op(op, left_type, right_type):
    if isinstance(left_type, ErrorType) or isinstance(right_type, ErrorType):
        return ErrorType()  # Don't report another error
    # ... normal checking
```

---

## 6. Task Auto-Classification

The analyzer looks at each task and decides its tier:

```python
def classify_task(task: TaskDecl, symbols: SymbolTable) -> str:
    # Rule 1: "strict" keyword → Critical
    if task.strict or any_block_is_strict(task.body):
        return "critical"

    # Rule 2: Uses blocking/callback APIs → Priority
    blocking_apis = {"wifi.connect", "mqtt.connect", "mqtt.on_receive",
                     "http.get", "http.post", "wifi.on_connect"}
    if calls_any(task.body, blocking_apis):
        return "priority"

    # Rule 3: Everything else → Background (protothread)
    return "background"
```

Then validate:
- **Critical tasks** cannot call: `log()`, `printf()`, `malloc()`, `wifi.*`, `mqtt.*`, `http.*`, `storage.*`
- **Critical tasks** must have `every N strict` with a duration
- **Priority tasks** get a stack size estimate from call graph depth

---

## 7. Build Report

After successful compilation:

```
$ volt build

Compiling main.volt...

  Task Analysis:
  ┌──────────────────┬────────────┬─────────┬──────────┐
  │ Task             │ Tier       │ Period  │ Status   │
  ├──────────────────┼────────────┼─────────┼──────────┤
  │ motor_pid        │ Critical   │ 1 ms    │ ✓ ok     │
  │ wifi_handler     │ Priority   │ event   │ ✓ ok     │
  │ blink            │ Background │ 500 ms  │ ✓ ok     │
  │ logger           │ Background │ 2 s     │ ✓ ok     │
  └──────────────────┴────────────┴─────────┴──────────┘

  Hardware:
  ┌──────────────────┬──────────────────────────┐
  │ GPIO 2           │ Output (led)             │
  │ GPIO 4           │ PWM (motor)              │
  │ GPIO 21/22       │ I2C bus (sensors)        │
  │ GPIO 36          │ Analog (battery)         │
  └──────────────────┴──────────────────────────┘

  Memory:
    Flash: 189 KB / 4096 KB (4.6%)
    RAM:   68 KB / 328 KB (20.7%)
    Free:  260 KB

  ✓ Build successful (2.3s)
```

---

## 8. Testing Strategy

### Snapshot Tests (Primary)

```
tests/cases/
  01_blink/
    input.volt          ← Volt source
    expected.c          ← What the transpiler should produce

  02_type_error/
    input.volt          ← Has a type error
    expected_errors.txt ← Exact error output
```

Test runner compares actual output against expected. Update snapshots with `UPDATE_SNAPSHOTS=1 pytest`.

### Compiler-Output Verification

Every generated `.c` file is syntax-checked with `gcc -fsyntax-only` to verify it's valid C.

### Fuzz Testing

Feed random strings into the compiler. It must NEVER crash — always produce either output or error messages.

### Property Tests

- Every valid program produces valid C
- Every invalid program produces at least one error
- Output is deterministic (compile twice → same result)
- Line numbers in errors are within source range

---

## 9. Registry System (Extensibility)

### Adding a New Sensor

To support a new sensor, add one file — no compiler changes needed:

```python
# compiler/sensors/bme280.py
from compiler.registry import SensorDef, Method, Param

bme280 = SensorDef(
    name="BME280",
    bus_type="i2c",
    methods=[
        Method("temperature", returns="float",
               c_call="bme280_read_temperature(&{self})"),
        Method("humidity", returns="float",
               c_call="bme280_read_humidity(&{self})"),
        Method("pressure", returns="float",
               c_call="bme280_read_pressure(&{self})"),
    ],
    c_type="bme280_t",
    c_include="volt/drivers/bme280.h",
    c_init="bme280_init(&{self}, &{bus}, {address})",
)
```

The compiler discovers all sensor definitions at startup and registers them. The type checker knows `bme.temperature()` returns `float`. The code generator knows to call `bme280_read_temperature()`. No compiler code modified.

### Adding a New Chip

```python
# compiler/chips/esp32s3.py
from compiler.registry import ChipDef

esp32s3 = ChipDef(
    name="esp32s3",
    pin_database=load_pins("esp32s3_pins.json"),
    flash_size_default="4MB",
    ram_size=512*1024,
    cpu_cores=2,
    has_wifi=True,
    has_ble=True,
)
```

---

## 10. What Makes This Innovative

| Feature | Existing Tools | Volt |
|---------|---------------|------|
| Parse + type check | Everyone does this | We do it too |
| Hardware pin validation | **Nobody** | **Compile-time pin conflict detection** |
| ADC2/WiFi conflict | **Nobody** at compile time | **Compile-time warning with suggestion** |
| Auto task classification | **Nobody** | **Transpiler analyzes timing + API usage** |
| Yield-crossing var analysis | Rust compiler, C++20 coroutines | **Our transpiler does it for C** |
| "Did you mean?" suggestions | Rust, Elm | **We do it too** |
| Build report with memory + tasks | **Nobody** in one view | **Unified report after every build** |
| Snapshot-tested transpiler | TypeScript, Elm | **Same rigor** |
| Registry-based extensibility | ESPHome | **Inspired by ESPHome, cleaner** |
| ISR safety checking | Manual in all platforms | **Compile-time enforcement** |
