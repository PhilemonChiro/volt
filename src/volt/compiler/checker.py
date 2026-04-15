"""
Volt Type Checker — Pass 3: Bidirectional Type Checking

For every expression: infer its type or check it against an expected type.
Reports type mismatches, wrong argument counts, invalid operators, and
method-not-found errors.

Uses ErrorType (poison) to prevent cascading errors from a single mistake.

Input:  AST + symbol table from resolver
Output: Type annotations on expressions, errors for mismatches
"""

from .ast_nodes import *
from .symbols import Symbol, Scope
from .errors import CompilerErrors, suggest_similar


# ============================================================
# Type constants
# ============================================================

# Poison type — absorbs all operations, prevents cascading errors
ERROR_TYPE = "<error>"

# Primitive types
INT = "int"
FLOAT = "float"
BOOL = "bool"
STRING = "string"
VOID = "void"
DURATION = "Duration"


# ============================================================
# Method signatures for hardware/builtin types
# Each entry: method_name → (return_type, [(param_name, param_type), ...])
# ============================================================

METHOD_TYPES = {
    "Output": {
        "on":       (VOID, []),
        "off":      (VOID, []),
        "toggle":   (VOID, []),
        "write":    (VOID, [("level", INT)]),
        "is_on":    (BOOL, []),
        "blink":    (VOID, [("interval", DURATION)]),
        "blink_once": (VOID, [("duration", DURATION)]),
    },
    "Input": {
        "read":       (INT, []),
    },
    "PullUpInput": {
        "read":       (INT, []),
        "is_pressed": (BOOL, []),
        "press":      (VOID, []),  # event source for on blocks
    },
    "PullDownInput": {
        "read":       (INT, []),
        "is_pressed": (BOOL, []),
        "press":      (VOID, []),
    },
    "Analog": {
        "read": (INT, []),
    },
    "DAC": {
        "write":   (VOID, [("value", INT)]),
        "voltage": (VOID, [("volts", FLOAT)]),
        "read":    (INT, []),
    },
    "Touch": {
        "read":          (INT, []),
        "is_touched":    (BOOL, []),
        "set_threshold": (VOID, [("threshold", INT)]),
        "release":       (VOID, []),
        "touch":         (VOID, []),  # event source for on blocks
    },
    "Servo": {
        "move":         (VOID, [("angle", INT)]),
        "move_us":      (VOID, [("microseconds", INT)]),
        "angle":        (FLOAT, []),
        "ease_to":      (VOID, [("angle", INT), ("duration", DURATION)]),
        "ease_to_with": (VOID, [("angle", INT), ("duration", DURATION), ("easing", INT)]),
        "sweep":        (VOID, [("from", INT), ("to", INT), ("duration", DURATION)]),
        "sweep_ease":   (VOID, [("from", INT), ("to", INT), ("duration", DURATION), ("easing", INT)]),
        "detach":       (VOID, []),
        "set_max_angle": (VOID, [("max_angle", INT)]),
    },
    "PWM": {
        "write":         (VOID, [("value", INT)]),
        "set_pwm":       (VOID, [("value", INT)]),
        "tone":          (VOID, [("frequency", INT)]),
        "tone_ms":       (VOID, [("frequency", INT), ("duration", INT)]),
        "no_tone":       (VOID, []),
        "click":         (VOID, []),
        "beep_success":  (VOID, []),
        "beep_error":    (VOID, []),
        "beep_warning":  (VOID, []),
        "beep_startup":  (VOID, []),
        "beep_shutdown": (VOID, []),
        "beep_notify":   (VOID, []),
        "beep_alarm":    (VOID, []),
        "beep_keypad":   (VOID, [("digit", INT)]),
    },
    # Sensor types
    "BME280": {
        "temperature": (FLOAT, []),
        "humidity":    (FLOAT, []),
        "pressure":    (FLOAT, []),
    },
    "AHT20": {
        "temperature": (FLOAT, []),
        "humidity":    (FLOAT, []),
    },
    "SHT31": {
        "temperature": (FLOAT, []),
        "humidity":    (FLOAT, []),
    },
    # DHT22: loaded from devices/dht22/device.json via registry
    "MPU6050": {
        "accel_x":     (FLOAT, []),
        "accel_y":     (FLOAT, []),
        "accel_z":     (FLOAT, []),
        "gyro_x":      (FLOAT, []),
        "gyro_y":      (FLOAT, []),
        "gyro_z":      (FLOAT, []),
        "temperature": (FLOAT, []),
    },
    "INA219": {
        "voltage":       (FLOAT, []),
        "current":       (FLOAT, []),
        "power":         (FLOAT, []),
        "shunt_voltage": (FLOAT, []),
    },
    "DS3231": {
        "hours":       (INT, []),
        "minutes":     (INT, []),
        "seconds":     (INT, []),
        "year":        (INT, []),
        "month":       (INT, []),
        "date":        (INT, []),
        "temperature": (FLOAT, []),
    },
    "BH1750": {
        "lux": (FLOAT, []),
    },
    "VEML7700": {
        "lux":   (FLOAT, []),
        "white": (FLOAT, []),
    },
    "SSD1306": {
        "clear":  (VOID, []),
        "text":   (VOID, [("x", INT), ("y", INT), ("text", STRING)]),
        "show":   (VOID, []),
    },
    # Additional I2C devices
    "BMP180": {
        "temperature": (FLOAT, []),
        "pressure":    (FLOAT, []),
    },
    "ADS1115": {
        "read_raw": (INT, [("channel", INT)]),
        "voltage":  (FLOAT, [("channel", INT)]),
    },
    "PCA9685": {
        "set_servo": (VOID, [("channel", INT), ("angle", INT)]),
        "set_duty":  (VOID, [("channel", INT), ("duty", INT)]),
    },
    "PCF8574": {
        "write":   (VOID, [("value", INT)]),
        "read":    (INT, []),
        "set_pin": (VOID, [("pin", INT), ("level", INT)]),
    },
    "MLX90614": {
        "ambient": (FLOAT, []),
        "object":  (FLOAT, []),
    },
    "MCP4725": {
        "write":       (VOID, [("value", INT)]),
        "set_voltage": (VOID, [("voltage", FLOAT), ("vref", FLOAT)]),
    },
    "MAX30102": {
        "red":               (INT, []),
        "ir":                (INT, []),
        "temperature":       (FLOAT, []),
        "is_finger_present": (INT, []),
    },
    "HD44780": {
        "clear":      (VOID, []),
        "print":      (VOID, [("text", STRING)]),
        "set_cursor": (VOID, [("col", INT), ("row", INT)]),
        "backlight":  (VOID, [("on", INT)]),
    },
    "BME680": {
        "temperature": (FLOAT, []),
        "humidity":    (FLOAT, []),
        "pressure":    (FLOAT, []),
        "gas":         (INT, []),
    },
    "APDS9960": {
        "proximity": (INT, []),
        "red":       (INT, []),
        "green":     (INT, []),
        "blue":      (INT, []),
    },
    "QMC5883L": {
        "x":       (FLOAT, []),
        "y":       (FLOAT, []),
        "z":       (FLOAT, []),
        "heading": (FLOAT, []),
    },
    "TCA9548A": {
        "select":  (VOID, [("channel", INT)]),
        "disable": (VOID, []),
    },
    "HTU21D": {
        "temperature": (FLOAT, []),
        "humidity":    (FLOAT, []),
    },
    "MS5611": {
        "temperature": (FLOAT, []),
        "pressure":    (FLOAT, []),
    },
    "MAX7219": {
        "set_row":       (VOID, [("row", INT), ("data", INT)]),
        "set_intensity": (VOID, [("level", INT)]),
        "clear":         (VOID, []),
        "set_digit":     (VOID, [("pos", INT), ("value", INT), ("dp", INT)]),
    },
    "MAX30100": {
        "red":               (INT, []),
        "ir":                (INT, []),
        "temperature":       (FLOAT, []),
        "is_finger_present": (INT, []),
    },
    # SPI devices
    "MAX31855": {
        "temperature": (FLOAT, []),
        "internal":    (FLOAT, []),
        "is_fault":    (INT, []),
    },
    "MCP3008": {
        "read": (INT, [("channel", INT)]),
    },
    # Builtins
    "WiFi": {
        "connect":      (VOID, [("ssid", STRING), ("password", STRING)]),
        "disconnect":   (VOID, []),
        "is_connected": (BOOL, []),
        "get_ip":       (STRING, []),
        "get_rssi":     (INT, []),
    },
    "MQTT": {
        "connect":      (VOID, [("url", STRING)]),
        "disconnect":   (VOID, []),
        "send":         (VOID, [("topic", STRING), ("data", STRING)]),
        "send_float":   (VOID, [("topic", STRING), ("value", FLOAT)]),
        "send_int":     (VOID, [("topic", STRING), ("value", INT)]),
        "on_receive":   (VOID, [("topic", STRING)]),
        "is_connected": (BOOL, []),
    },
    "HTTP": {
        "get":  (STRING, [("url", STRING)]),
        "post": (STRING, [("url", STRING), ("body", STRING)]),
    },
    "Storage": {
        "save": (VOID, [("key", STRING), ("value", None)]),  # None = any type (dispatched at codegen)
        "load": (INT, [("key", STRING)]),
        "push": (VOID, [("list_name", STRING), ("value", INT)]),
        "drain": (STRING, [("list_name", STRING)]),
        "list_count": (INT, [("list_name", STRING)]),
        "list_clear": (VOID, [("list_name", STRING)]),
    },
    "System": {
        "restart":          (VOID, []),
        "id":               (INT, []),
        "uptime":           (INT, []),
        "free_heap":        (INT, []),
        "watchdog_enable":  (VOID, [("timeout_ms", INT)]),
        "watchdog_feed":    (VOID, []),
        "watchdog_disable": (VOID, []),
    },
    "OTA": {
        "enable": (VOID, []),  # stub — driver not yet implemented
    },
    "BLE": {
        "advertise":     (VOID, [("name", STRING)]),
        "stop":          (VOID, []),
        "is_connected":  (BOOL, []),
        "expose_int":    (INT, [("name", STRING), ("value", INT)]),
        "expose_float":  (INT, [("name", STRING), ("value", FLOAT)]),
        "expose_string": (INT, [("name", STRING), ("value", STRING)]),
        "update_int":    (VOID, [("id", INT), ("value", INT)]),
        "update_float":  (VOID, [("id", INT), ("value", FLOAT)]),
        "update_string": (VOID, [("id", INT), ("value", STRING)]),
        "scan":          (INT, [("duration", DURATION)]),
        "scan_name":     (STRING, [("index", INT)]),
        "scan_rssi":     (INT, [("index", INT)]),
    },
    "UART": {
        "print":     (VOID, [("text", STRING)]),
        "read_byte": (INT, []),
        "read_line": (STRING, []),
        "available": (INT, []),
        "flush":     (VOID, []),
    },
    "SERIAL": {
        "print":     (VOID, [("text", STRING)]),
        "read_byte": (INT, []),
        "read_line": (STRING, []),
        "available": (INT, []),
        "flush":     (VOID, []),
    },
    "Channel": {
        "send":      (VOID, [("value", None)]),   # any type
        "receive":   (INT, []),                     # returns elem_type
        "try_receive": (INT, []),                   # non-blocking receive
        "count":     (INT, []),                     # items in buffer
        "has_data":  (BOOL, []),                    # true if not empty
        "is_empty":  (BOOL, []),
        "is_full":   (BOOL, []),
        "clear":     (VOID, []),
    },
}

# Built-in function signatures: name → (return_type, [(param_name, param_type)])
BUILTIN_FUNCS = {
    "log":         (VOID, [("tag", STRING), ("message", STRING)]),
    "run":         (VOID, []),  # variable args (task names)
    "sleep":       (VOID, [("duration", DURATION)]),
    "deep_sleep":  (VOID, [("duration", DURATION)]),
    "light_sleep": (VOID, [("duration", DURATION)]),
    "float":       (FLOAT, [("value", INT)]),  # int to float conversion
    "int":         (INT, [("value", FLOAT)]),   # float to int conversion
}


# ============================================================
# Operator result types
# ============================================================

# (left_type, op, right_type) → result_type
BINARY_OP_TYPES = {
    # Arithmetic
    (INT, "+", INT): INT,
    (INT, "-", INT): INT,
    (INT, "*", INT): INT,
    (INT, "/", INT): INT,
    (INT, "%", INT): INT,
    (FLOAT, "+", FLOAT): FLOAT,
    (FLOAT, "-", FLOAT): FLOAT,
    (FLOAT, "*", FLOAT): FLOAT,
    (FLOAT, "/", FLOAT): FLOAT,
    (STRING, "+", STRING): STRING,  # concatenation
    (STRING, "+", INT): STRING,    # string interpolation: "count=" + 42 → "count=42"
    (STRING, "+", FLOAT): STRING,
    (STRING, "+", BOOL): STRING,
    (INT, "+", STRING): STRING,
    (FLOAT, "+", STRING): STRING,
    (BOOL, "+", STRING): STRING,

    # Comparison → bool
    (INT, "==", INT): BOOL,
    (INT, "!=", INT): BOOL,
    (INT, "<", INT): BOOL,
    (INT, ">", INT): BOOL,
    (INT, "<=", INT): BOOL,
    (INT, ">=", INT): BOOL,
    (FLOAT, "==", FLOAT): BOOL,
    (FLOAT, "!=", FLOAT): BOOL,
    (FLOAT, "<", FLOAT): BOOL,
    (FLOAT, ">", FLOAT): BOOL,
    (FLOAT, "<=", FLOAT): BOOL,
    (FLOAT, ">=", FLOAT): BOOL,

    # Mixed int/float — auto-promotes int to float (matches C behavior)
    (INT, "+", FLOAT): FLOAT,
    (FLOAT, "+", INT): FLOAT,
    (INT, "-", FLOAT): FLOAT,
    (FLOAT, "-", INT): FLOAT,
    (INT, "*", FLOAT): FLOAT,
    (FLOAT, "*", INT): FLOAT,
    (INT, "/", FLOAT): FLOAT,
    (FLOAT, "/", INT): FLOAT,
    (INT, "==", FLOAT): BOOL,
    (FLOAT, "==", INT): BOOL,
    (INT, "!=", FLOAT): BOOL,
    (FLOAT, "!=", INT): BOOL,
    (INT, "<", FLOAT): BOOL,
    (FLOAT, "<", INT): BOOL,
    (INT, ">", FLOAT): BOOL,
    (FLOAT, ">", INT): BOOL,
    (INT, "<=", FLOAT): BOOL,
    (FLOAT, "<=", INT): BOOL,
    (INT, ">=", FLOAT): BOOL,
    (FLOAT, ">=", INT): BOOL,

    (STRING, "==", STRING): BOOL,
    (STRING, "!=", STRING): BOOL,
    (BOOL, "==", BOOL): BOOL,
    (BOOL, "!=", BOOL): BOOL,

    # Boolean
    (BOOL, "&&", BOOL): BOOL,
    (BOOL, "||", BOOL): BOOL,

    # Bitwise
    (INT, "&", INT): INT,
    (INT, "|", INT): INT,
    (INT, "^", INT): INT,
    (INT, "<<", INT): INT,
    (INT, ">>", INT): INT,

    # Duration comparison
    (DURATION, "==", DURATION): BOOL,
    (DURATION, "!=", DURATION): BOOL,
    (DURATION, "<", DURATION): BOOL,
    (DURATION, ">", DURATION): BOOL,
    (DURATION, "<=", DURATION): BOOL,
    (DURATION, ">=", DURATION): BOOL,
}


# ============================================================
# Main checker
# ============================================================

def check_types(program: Program, scope: Scope, errors: CompilerErrors):
    """Run type checking on the entire program."""

    # Load device registry — merge into METHOD_TYPES
    from .device_registry import get_registry
    registry = get_registry()
    for dev_name, methods in registry.get_method_types().items():
        if dev_name not in METHOD_TYPES:
            METHOD_TYPES[dev_name] = methods

    # Check functions
    for func in program.functions:
        func_scope = scope.child(f"func:{func.name}")
        for param in func.params:
            func_scope.declare(Symbol(param.name, "param", param.type_name, param.region))
        _check_stmts(func.body, func_scope, errors, func.return_type)

    # Check tasks
    for task in program.tasks:
        task_scope = scope.child(f"task:{task.name}")
        _check_stmts(task.body, task_scope, errors, None)

    # Check state machines
    for machine in program.machines:
        machine_scope = scope.child(f"machine:{machine.name}")
        for state in machine.states:
            _check_stmts(state.enter_body, machine_scope, errors, None)
            _check_stmts(state.exit_body, machine_scope, errors, None)
            _check_stmts(state.body, machine_scope, errors, None)
            # Check transition guards and actions
            for trans in state.transitions:
                if trans.guard:
                    _infer(trans.guard, machine_scope, errors)
                _check_stmts(trans.action, machine_scope, errors, None)
            for timed in state.timed_transitions:
                if timed.guard:
                    _infer(timed.guard, machine_scope, errors)
                _check_stmts(timed.action, machine_scope, errors, None)

    # Check setup
    if program.setup:
        setup_scope = scope.child("setup")
        _check_stmts(program.setup.body, setup_scope, errors, None)

    # Check loop
    if program.loop:
        loop_scope = scope.child("loop")
        _check_stmts(program.loop.body, loop_scope, errors, None)

    # Check global variable declarations
    for gv in program.global_vars:
        if gv.value:
            _infer(gv.value, scope, errors)

    # Check storage declarations
    for storage in program.storage_vars:
        if storage.default_value:
            val_type = _infer(storage.default_value, scope, errors)
            normalized = _normalize_type(storage.type_name)
            if val_type != ERROR_TYPE and val_type != normalized:
                errors.error(
                    storage.region, "TYPE MISMATCH",
                    f"Storage `{storage.name}` declared as `{storage.type_name}` "
                    f"but default value is `{val_type}`.",
                )


# ============================================================
# Statement checking
# ============================================================

def _check_stmts(stmts: list, scope: Scope, errors: CompilerErrors,
                  expected_return: str | None):
    for stmt in stmts:
        _check_stmt(stmt, scope, errors, expected_return)


def _check_stmt(stmt, scope: Scope, errors: CompilerErrors,
                 expected_return: str | None):
    if stmt is None:
        return

    if isinstance(stmt, VarDecl):
        # Reject assignment expressions as values (var x = y = 5 is a mistake)
        if stmt.value and isinstance(stmt.value, AssignExpr):
            errors.error(stmt.region, "SYNTAX ERROR",
                         f"Invalid initializer for `{stmt.name}` — did you mean `var {stmt.name}: type = value`?",
                         hint="Use `:` for type annotations: `var x: int = 5`")
            return
        val_type = _infer(stmt.value, scope, errors) if stmt.value else ERROR_TYPE

        if stmt.type_name:
            # Explicit type: check value matches
            normalized = _normalize_type(stmt.type_name)
            if val_type != ERROR_TYPE and val_type != normalized:
                errors.error(
                    stmt.region, "TYPE MISMATCH",
                    f"Variable `{stmt.name}` declared as `{stmt.type_name}` "
                    f"but assigned `{val_type}`.",
                )
        else:
            # Infer type from value
            if val_type == ERROR_TYPE and not stmt.value:
                errors.error(
                    stmt.region, "TYPE ERROR",
                    f"Variable `{stmt.name}` has no type annotation and no initial value.",
                    hint="Add a type: `var {}: int = 0` or provide a value.".format(stmt.name),
                )
                stmt.type_name = "unknown"
            else:
                stmt.type_name = val_type

        # Register in scope with resolved type
        resolved_type = _normalize_type(stmt.type_name) if stmt.type_name else "unknown"
        scope.declare(Symbol(
            stmt.name, "var", resolved_type, stmt.region,
            mutable=stmt.mutable,
        ))

    elif isinstance(stmt, AssignExpr):
        # Validate target is an l-value (variable or field, not a literal)
        if not isinstance(stmt.target, (VarRef, DotAccess)):
            errors.error(stmt.region, "SYNTAX ERROR",
                         "Cannot assign to this expression — left side must be a variable.",
                         hint="Use `var name = value` to declare, or assign to an existing variable.")
            return

        target_type = _infer(stmt.target, scope, errors)
        val_type = _infer(stmt.value, scope, errors)

        # Check mutability
        if isinstance(stmt.target, VarRef):
            sym = scope.lookup(stmt.target.name)
            if sym and not sym.mutable and sym.kind == "var":
                errors.error(
                    stmt.region, "MUTABILITY ERROR",
                    f"Cannot assign to `{stmt.target.name}` — it was declared with `let` (immutable).",
                    hint="Use `var` instead of `let` to make it mutable.",
                )

        # Check type compatibility
        if target_type != ERROR_TYPE and val_type != ERROR_TYPE:
            if target_type != val_type:
                errors.error(
                    stmt.region, "TYPE MISMATCH",
                    f"Cannot assign `{val_type}` to `{target_type}`.",
                )

    elif isinstance(stmt, BreakStmt) or isinstance(stmt, ContinueStmt):
        # Validated by analyzer — break/continue only valid in loops
        pass

    elif isinstance(stmt, CompoundAssign):
        target_type = _infer(stmt.target, scope, errors)
        val_type = _infer(stmt.value, scope, errors)

        # Check mutability
        if isinstance(stmt.target, VarRef):
            sym = scope.lookup(stmt.target.name)
            if sym and not sym.mutable and sym.kind == "var":
                errors.error(
                    stmt.region, "MUTABILITY ERROR",
                    f"Cannot assign to `{stmt.target.name}` — it was declared with `let` (immutable).",
                    hint="Use `var` instead of `let` to make it mutable.",
                )

        # Check type compatibility — compound ops require matching types
        if target_type != ERROR_TYPE and val_type != ERROR_TYPE:
            base_op = stmt.op[0] if stmt.op[0] != '<' and stmt.op[0] != '>' else stmt.op[:2]
            key = (target_type, base_op, val_type)
            if key not in BINARY_OP_TYPES:
                errors.error(
                    stmt.region, "TYPE MISMATCH",
                    f"Cannot use `{stmt.op}` between `{target_type}` and `{val_type}`.",
                )

    elif isinstance(stmt, ExprStmt):
        # Warn if a DotAccess is used as a statement — likely missing ()
        if isinstance(stmt.expr, DotAccess):
            errors.error(stmt.region, "SYNTAX ERROR",
                         f"Did you mean `{stmt.expr.obj.name if isinstance(stmt.expr.obj, VarRef) else '?'}.{stmt.expr.field_name}()`?",
                         hint="Method calls require parentheses: `.method()`")
        else:
            _infer(stmt.expr, scope, errors)

    elif isinstance(stmt, ReturnStmt):
        if stmt.value:
            val_type = _infer(stmt.value, scope, errors)
            if expected_return and val_type != ERROR_TYPE and val_type != expected_return:
                errors.error(
                    stmt.region, "TYPE MISMATCH",
                    f"Function returns `{expected_return}` but got `{val_type}`.",
                )
        elif expected_return and expected_return != VOID:
            errors.error(
                stmt.region, "TYPE MISMATCH",
                f"Function expects return type `{expected_return}` but got empty return.",
            )

    elif isinstance(stmt, IfStmt):
        cond_type = _infer(stmt.condition, scope, errors)
        if cond_type != ERROR_TYPE and cond_type != BOOL:
            errors.error(
                stmt.condition.region, "TYPE MISMATCH",
                f"Condition must be `bool`, got `{cond_type}`.",
                hint="Use a comparison like `x > 0` or a boolean function.",
            )
        _check_stmts(stmt.then_body, scope, errors, expected_return)
        if stmt.else_body is not None:
            if isinstance(stmt.else_body, list):
                _check_stmts(stmt.else_body, scope, errors, expected_return)
            elif isinstance(stmt.else_body, IfStmt):
                _check_stmt(stmt.else_body, scope, errors, expected_return)

    elif isinstance(stmt, WhileStmt):
        cond_type = _infer(stmt.condition, scope, errors)
        if cond_type != ERROR_TYPE and cond_type != BOOL:
            errors.error(
                stmt.condition.region, "TYPE MISMATCH",
                f"While condition must be `bool`, got `{cond_type}`.",
            )
        _check_stmts(stmt.body, scope, errors, expected_return)

    elif isinstance(stmt, ForStmt):
        start_type = _infer(stmt.start, scope, errors)
        end_type = _infer(stmt.end, scope, errors)
        if start_type != ERROR_TYPE and start_type != INT:
            errors.error(stmt.start.region, "TYPE MISMATCH",
                         f"For range start must be `int`, got `{start_type}`.")
        if end_type != ERROR_TYPE and end_type != INT:
            errors.error(stmt.end.region, "TYPE MISMATCH",
                         f"For range end must be `int`, got `{end_type}`.")
        if stmt.step:
            step_type = _infer(stmt.step, scope, errors)
            if step_type != ERROR_TYPE and step_type != INT:
                errors.error(stmt.step.region, "TYPE MISMATCH",
                             f"For step must be `int`, got `{step_type}`.")
        for_scope = scope.child(f"for:{stmt.var_name}")
        for_scope.declare(Symbol(stmt.var_name, "var", INT, stmt.region))
        _check_stmts(stmt.body, for_scope, errors, expected_return)

    elif isinstance(stmt, EveryBlock):
        interval_type = _infer(stmt.interval, scope, errors)
        if interval_type != ERROR_TYPE and interval_type != DURATION:
            errors.error(
                stmt.interval.region, "TYPE MISMATCH",
                f"Interval must be a duration (e.g., 500ms), got `{interval_type}`.",
            )
        _check_stmts(stmt.body, scope, errors, expected_return)

    elif isinstance(stmt, OnBlock):
        _infer(stmt.event, scope, errors)
        if stmt.debounce:
            deb_type = _infer(stmt.debounce, scope, errors)
            if deb_type != ERROR_TYPE and deb_type != DURATION:
                errors.error(stmt.debounce.region, "TYPE MISMATCH",
                             f"Debounce must be a duration, got `{deb_type}`.")
        if stmt.throttle:
            thr_type = _infer(stmt.throttle, scope, errors)
            if thr_type != ERROR_TYPE and thr_type != DURATION:
                errors.error(stmt.throttle.region, "TYPE MISMATCH",
                             f"Throttle must be a duration, got `{thr_type}`.")
        _check_stmts(stmt.body, scope, errors, expected_return)

    elif isinstance(stmt, TimeoutBlock):
        dur_type = _infer(stmt.duration, scope, errors)
        if dur_type != ERROR_TYPE and dur_type != DURATION:
            errors.error(stmt.duration.region, "TYPE MISMATCH",
                         f"Timeout must be a duration, got `{dur_type}`.")
        _check_stmts(stmt.try_body, scope, errors, expected_return)
        _check_stmts(stmt.fallback_body, scope, errors, expected_return)

    elif isinstance(stmt, MatchStmt):
        _infer(stmt.expr, scope, errors)
        for arm in stmt.arms:
            if isinstance(arm.body, list):
                _check_stmts(arm.body, scope, errors, expected_return)
            elif isinstance(arm.body, Node):
                _infer(arm.body, scope, errors)


# ============================================================
# Expression type inference
# ============================================================

_INT_ALIASES = {"u8", "u16", "u32", "i8", "i16", "i32"}

def _normalize_type(t: str) -> str:
    """Normalize sized integer aliases to INT for type checking."""
    return INT if t in _INT_ALIASES else t

def _infer(expr, scope: Scope, errors: CompilerErrors) -> str:
    """Infer the type of an expression. Returns type name string or ERROR_TYPE."""
    if expr is None:
        return ERROR_TYPE

    # Literals
    if isinstance(expr, IntLiteral):
        return INT
    if isinstance(expr, FloatLiteral):
        return FLOAT
    if isinstance(expr, BoolLiteral):
        return BOOL
    if isinstance(expr, StringLiteral):
        return STRING
    if isinstance(expr, DurationLiteral):
        return DURATION
    if isinstance(expr, ArrayLiteral):
        if not expr.elements:
            return "list"
        first_type = _infer(expr.elements[0], scope, errors)
        return f"list<{first_type}>"

    # Variable reference
    if isinstance(expr, VarRef):
        sym = scope.lookup(expr.name)
        if sym is None:
            return ERROR_TYPE  # resolver already reported the error
        return _normalize_type(sym.type_name)

    # Binary expression
    if isinstance(expr, BinaryExpr):
        left_type = _infer(expr.left, scope, errors)
        right_type = _infer(expr.right, scope, errors)

        if left_type == ERROR_TYPE or right_type == ERROR_TYPE:
            return ERROR_TYPE

        result = BINARY_OP_TYPES.get((left_type, expr.op, right_type))
        if result is None:
            # Allow == and != between same enum types
            if left_type == right_type and expr.op in {"==", "!="} and \
               scope.lookup(left_type) and scope.lookup(left_type).kind == "enum":
                result = BOOL
            else:
                errors.error(
                    expr.region, "TYPE MISMATCH",
                    f"Cannot use `{expr.op}` between `{left_type}` and `{right_type}`.",
                )
                return ERROR_TYPE

        expr.result_type = result
        return result

    # Unary expression
    if isinstance(expr, UnaryExpr):
        operand_type = _infer(expr.operand, scope, errors)
        if operand_type == ERROR_TYPE:
            return ERROR_TYPE
        if expr.op == "!" and operand_type != BOOL:
            errors.error(expr.region, "TYPE MISMATCH",
                         f"Cannot negate `{operand_type}` with `!`. Only `bool` allowed.")
            return ERROR_TYPE
        if expr.op == "-" and operand_type not in (INT, FLOAT):
            errors.error(expr.region, "TYPE MISMATCH",
                         f"Cannot negate `{operand_type}` with `-`.")
            return ERROR_TYPE
        return operand_type

    # Field access (dot without call): data.temperature
    if isinstance(expr, DotAccess):
        # Check for enum variant access: EnumName.variant
        if isinstance(expr.obj, VarRef):
            sym = scope.lookup(expr.obj.name)
            if sym and sym.kind == "enum":
                # Validate variant exists — find enum in program context
                # For now, trust that the resolver registered it; return enum type
                return sym.type_name

        obj_type = _infer(expr.obj, scope, errors)
        if obj_type == ERROR_TYPE:
            return ERROR_TYPE
        # Look up field in struct definitions or method tables
        # Normalize channel<T> → Channel for method lookup
        lookup_type = "Channel" if obj_type.startswith("channel<") else obj_type.upper() if obj_type in ("uart", "serial") else obj_type
        methods = METHOD_TYPES.get(lookup_type, {})
        if expr.field_name in methods:
            return methods[expr.field_name][0]
        # Could be a struct field
        return "unknown"

    # Or expression: expr or fallback
    if isinstance(expr, OrExpr):
        expr_type = _infer(expr.expr, scope, errors)
        if expr.kind == "skip" or expr.kind == "restart":
            return expr_type  # skip/restart don't produce a value
        elif expr.kind == "retry":
            if expr.fallback:
                _infer(expr.fallback, scope, errors)  # validate retry count
            return expr_type
        else:
            # Default value — check type matches
            fallback_type = _infer(expr.fallback, scope, errors)
            if expr_type != ERROR_TYPE and fallback_type != ERROR_TYPE:
                if expr_type != fallback_type and not (
                    {expr_type, fallback_type} == {INT, FLOAT}):
                    errors.error(expr.region, "TYPE MISMATCH",
                                 f"`or` fallback is `{fallback_type}` but expression returns `{expr_type}`.")
            return expr_type

    # Function call
    if isinstance(expr, FuncCall):
        # Check builtin functions
        if expr.name in BUILTIN_FUNCS:
            ret_type, params = BUILTIN_FUNCS[expr.name]
            # log() and run() accept any args
            if expr.name not in ("log", "run"):
                _check_arg_count(expr, len(params), errors)
            for arg in expr.args:
                _infer(arg, scope, errors)
            return ret_type

        # Check user-defined functions
        sym = scope.lookup(expr.name)
        if sym is None:
            return ERROR_TYPE  # resolver already reported

        if sym.kind == "func":
            _check_arg_count(expr, len(sym.params), errors)
            # Check each argument type
            for i, arg in enumerate(expr.args):
                arg_type = _infer(arg, scope, errors)
                if i < len(sym.params):
                    expected = sym.params[i][1]
                    if arg_type != ERROR_TYPE and arg_type != expected:
                        errors.error(
                            arg.region, "TYPE MISMATCH",
                            f"Argument {i+1} of `{expr.name}` expects `{expected}`, "
                            f"got `{arg_type}`.",
                        )
            return sym.return_type or VOID

        return ERROR_TYPE

    # Method call
    if isinstance(expr, MethodCall):
        obj_type = _infer(expr.obj, scope, errors)
        if obj_type == ERROR_TYPE:
            return ERROR_TYPE

        lookup_type = "Channel" if obj_type.startswith("channel<") else obj_type.upper() if obj_type in ("uart", "serial") else obj_type
        methods = METHOD_TYPES.get(lookup_type, {})
        if expr.method not in methods:
            known_methods = list(methods.keys())
            suggestion = suggest_similar(expr.method, known_methods)
            hint = f"Did you mean `{suggestion}`?" if suggestion else None
            if known_methods:
                hint = (hint or "") + f" Available: {', '.join(known_methods)}"
            errors.error(
                expr.region, "TYPE MISMATCH",
                f"Type `{obj_type}` has no method `{expr.method}`.",
                hint=hint.strip() if hint else None,
            )
            return ERROR_TYPE

        ret_type, params = methods[expr.method]
        _check_arg_count(expr, len(params), errors)
        for i, arg in enumerate(expr.args):
            arg_type = _infer(arg, scope, errors)
            if i < len(params):
                expected = params[i][1]
                if expected is not None and arg_type != ERROR_TYPE and arg_type != expected:
                    errors.error(
                        arg.region, "TYPE MISMATCH",
                        f"Argument {i+1} of `{expr.method}` expects `{expected}`, "
                        f"got `{arg_type}`.",
                    )
        return ret_type

    return ERROR_TYPE


def _check_arg_count(call, expected: int, errors: CompilerErrors):
    """Check that a call has the right number of arguments."""
    name = call.name if isinstance(call, FuncCall) else call.method
    actual = len(call.args)
    if actual != expected:
        errors.error(
            call.region, "ARGUMENT ERROR",
            f"`{name}` expects {expected} argument{'s' if expected != 1 else ''}, "
            f"got {actual}.",
        )
