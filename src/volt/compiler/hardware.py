"""
Volt Hardware Validator — Pass 4

Validates hardware configuration against the chip's pin database.
Catches pin conflicts, capability mismatches, and dangerous configurations
that would crash or malfunction at runtime.

No other embedded tool does this at compile time.

Input:  AST + symbol table + chip spec
Output: Hardware errors and warnings
"""

from .ast_nodes import *
from .symbols import Scope
from .errors import CompilerErrors

# Backwards compatibility: import PIN_DB for existing tests
try:
    from .pins_esp32 import PIN_DB, ADC2_GPIOS, RTC_GPIOS, SAFE_OUTPUT_PINS, VSPI_NATIVE, HSPI_NATIVE
except ImportError:
    PIN_DB = {}
    ADC2_GPIOS = set()
    RTC_GPIOS = set()
    SAFE_OUTPUT_PINS = []
    VSPI_NATIVE = {}
    HSPI_NATIVE = {}


def validate_hardware(program: Program, scope: Scope, errors: CompilerErrors, chip=None):
    """Run all hardware validations.
    If chip is provided, uses chip's pin database and validation rules.
    Otherwise falls back to hardcoded ESP32 (backwards compatibility)."""
    if not program.hardware:
        return

    # Check capability usage (wifi on a chip without wifi, etc.)
    if chip:
        _validate_capabilities(program, chip, errors)

    used_pins: dict[str, PinDecl] = {}  # pin_name → PinDecl (for conflict detection)
    used_i2c_addrs: dict[str, dict[int, SensorDecl]] = {}
    uses_wifi = _program_uses_wifi(program)

    # Validate each pin
    for pin in program.hardware.pins:
        if chip:
            _validate_pin_chip(pin, used_pins, uses_wifi, chip, errors)
        else:
            _validate_pin_legacy(pin, used_pins, uses_wifi, errors)

    # Validate sensors (I2C address conflicts — chip-independent)
    for sensor in program.hardware.sensors:
        _validate_sensor(sensor, used_i2c_addrs, errors)

    # Validate buses
    for bus in program.hardware.buses:
        _validate_bus(bus, chip, errors)

    # Chip-specific validation (deep sleep, SPI speed, etc.)
    if chip:
        chip.validate_hardware(program, errors)
    else:
        _validate_deep_sleep_pins(program, errors)
        _validate_spi_speed(program, errors)


def _validate_capabilities(program: Program, chip, errors: CompilerErrors):
    """Check that the program doesn't use features the chip doesn't support."""
    if _program_uses_wifi(program) and not chip.supports("wifi"):
        # Find the wifi.connect() call for the error region
        errors.error(program.region, "HARDWARE ERROR",
                     f"{chip.display_name} does not have WiFi hardware.",
                     hint=f"Chips with WiFi: esp32, esp8266")

    if _contains_method_call(program, "mqtt", "connect") and not chip.supports("wifi"):
        errors.error(program.region, "HARDWARE ERROR",
                     f"MQTT requires WiFi, but {chip.display_name} has no WiFi.",
                     hint=f"Chips with WiFi: esp32, esp8266")

    if _contains_method_call(program, "http", "get") and not chip.supports("wifi"):
        errors.error(program.region, "HARDWARE ERROR",
                     f"HTTP requires WiFi, but {chip.display_name} has no WiFi.",
                     hint=f"Chips with WiFi: esp32, esp8266")


# ============================================================
# Pin Validation (new chip-aware path)
# ============================================================

def _validate_pin_chip(pin: PinDecl, used_pins: dict, uses_wifi: bool,
                       chip, errors: CompilerErrors):
    """Validate a pin using the chip's pin database."""
    pin_name = str(pin.gpio)

    # 1. Run chip-specific pin validation
    pin_errors = chip.validate_pin(pin_name, pin.mode)
    for severity, message, hint in pin_errors:
        if severity == "error":
            errors.error(pin.region, "HARDWARE ERROR", message, hint=hint)
        else:
            errors.warning(pin.region, "HARDWARE WARNING", message, hint=hint)

    # Stop if there were errors (pin doesn't exist, blocked, etc.)
    if any(sev == "error" for sev, _, _ in pin_errors):
        return

    # 2. Pin conflict detection (chip-independent)
    if pin_name in used_pins:
        first = used_pins[pin_name]
        errors.error(pin.region, "HARDWARE ERROR",
                     f"Pin {pin_name} is already used by `{first.name}` "
                     f"(line {first.region.start_line}).",
                     hint="Each pin can only be used once.")
        return
    used_pins[pin_name] = pin

    # 3. ADC2 + WiFi conflict (if applicable for this chip)
    adc2_gpios = chip.get_adc2_gpios()
    if pin.mode == "Analog" and uses_wifi:
        try:
            gpio_num = int(pin_name)
            if gpio_num in adc2_gpios:
                errors.warning(pin.region, "HARDWARE WARNING",
                               f"Pin {pin_name} is on ADC2, which is blocked while WiFi is active. "
                               "Analog reads will return errors.",
                               hint="Use ADC1 pins instead.")
        except ValueError:
            pass


# ============================================================
# Pin Validation
# ============================================================

def _validate_pin_legacy(pin: PinDecl, used_pins: dict, uses_wifi: bool,
                        errors: CompilerErrors):
    """Validate a single pin declaration."""
    gpio = pin.gpio
    info = PIN_DB.get(gpio)

    # 1. Pin exists?
    if info is None:
        errors.error(pin.region, "HARDWARE ERROR",
                     f"GPIO {gpio} does not exist on ESP32 (valid: 0-39).")
        return

    # 2. Pin blocked? (flash pins, unavailable pins)
    if info.blocked:
        errors.error(pin.region, "HARDWARE ERROR",
                     info.blocked_reason,
                     hint=f"Available output pins: {', '.join(str(p) for p in SAFE_OUTPUT_PINS)}")
        return

    # 3. Pin already in use? (conflict detection)
    if gpio in used_pins:
        first = used_pins[gpio]
        errors.error(pin.region, "HARDWARE ERROR",
                     f"GPIO {gpio} is already used by pin `{first.name}` (line {first.region.start_line}).",
                     hint="Each GPIO can only be used once.")
        return
    used_pins[gpio] = pin

    # 4. Capability check: can this pin do what the mode requires?
    mode = pin.mode

    if mode == "Output" and not info.can_output:
        errors.error(pin.region, "HARDWARE ERROR",
                     f"GPIO {gpio} is input-only — cannot be used as Output.",
                     hint=f"Input-only pins: 34-39. Available output pins: {', '.join(str(p) for p in SAFE_OUTPUT_PINS)}")
        return

    if mode == "PWM" and not info.can_pwm:
        errors.error(pin.region, "HARDWARE ERROR",
                     f"GPIO {gpio} cannot be used as PWM (input-only pin).")
        return

    if mode == "Analog" and not info.can_analog:
        errors.error(pin.region, "HARDWARE ERROR",
                     f"GPIO {gpio} does not have an ADC channel — cannot be used as Analog.",
                     hint="ADC1 (safe with WiFi): GPIO 32-39. ADC2 (blocked by WiFi): GPIO 0, 2, 4, 12-15, 25-27.")
        return

    if "PullUp" in mode and not info.has_internal_pullup:
        errors.error(pin.region, "HARDWARE ERROR",
                     f"GPIO {gpio} has no internal pull-up resistor (input-only pins 34-39).",
                     hint="Use an external pull-up resistor, or use a different pin.")
        return

    if "PullDown" in mode and not info.has_internal_pulldown:
        errors.error(pin.region, "HARDWARE ERROR",
                     f"GPIO {gpio} has no internal pull-down resistor (input-only pins 34-39).",
                     hint="Use an external pull-down resistor, or use a different pin.")
        return

    # 5. Strapping pin warning
    if info.is_strapping and info.strapping_warning:
        errors.warning(pin.region, "HARDWARE WARNING",
                       f"GPIO {gpio}: {info.strapping_warning}")

    # 6. UART0 warning
    if info.is_uart0:
        errors.warning(pin.region, "HARDWARE WARNING",
                       f"GPIO {gpio} is used by UART0 (USB serial). "
                       f"Using it will break serial monitor and firmware flashing.",
                       hint="Use a different pin unless you specifically intend to disable serial output.")

    # 7. ADC2 + WiFi conflict
    if mode == "Analog" and uses_wifi and gpio in ADC2_GPIOS:
        errors.warning(pin.region, "HARDWARE WARNING",
                       f"GPIO {gpio} is on ADC2, which is BLOCKED while WiFi is active. "
                       f"Analog reads will return errors or garbage.",
                       hint="Use ADC1 pins instead (GPIO 32-39) which work with WiFi.")

    # 8. GPIO 36/39 interrupt errata
    if gpio in (36, 39):
        errors.warning(pin.region, "HARDWARE WARNING",
                       f"GPIO {gpio} has a hardware errata: interrupts may fire spuriously "
                       f"during WiFi/BT light sleep. Use a different pin for interrupt-driven input.",
                       hint="GPIO 34, 35 do not have this errata.")

    # 9. JTAG pin warning
    if info.is_jtag:
        errors.warning(pin.region, "HARDWARE WARNING",
                       f"GPIO {gpio} is a JTAG pin. Using it disables JTAG debugging.")

    # 10. Pin notes (DAC, crystal, etc.)
    for note in info.notes:
        errors.warning(pin.region, "HARDWARE NOTE", f"GPIO {gpio}: {note}")


# ============================================================
# Sensor / I2C Validation
# ============================================================

def _validate_sensor(sensor: SensorDecl, used_addrs: dict, errors: CompilerErrors):
    """Validate sensor declaration (I2C address conflicts)."""

    bus = sensor.bus_name
    addr = sensor.address

    if bus not in used_addrs:
        used_addrs[bus] = {}

    if addr in used_addrs[bus]:
        first = used_addrs[bus][addr]
        errors.error(sensor.region, "HARDWARE ERROR",
                     f"I2C address 0x{addr:02X} on bus `{bus}` is already used by "
                     f"sensor `{first.name}` (line {first.region.start_line}).",
                     hint="Each I2C address must be unique per bus. "
                          "Check the sensor datasheet for alternative addresses.")
        return

    used_addrs[bus][addr] = sensor


# ============================================================
# Bus Validation
# ============================================================

def _validate_bus(bus: BusDecl, chip, errors: CompilerErrors):
    """Validate bus pin assignments."""
    if bus.bus_type == "i2c":
        sda = bus.params.get("sda")
        scl = bus.params.get("scl")

        if sda is not None:
            sda_val = sda.value if isinstance(sda, IntLiteral) else sda
            if isinstance(sda_val, int):
                info = PIN_DB.get(sda_val)
                if info and info.blocked:
                    errors.error(bus.region, "HARDWARE ERROR",
                                 f"I2C SDA pin GPIO {sda_val}: {info.blocked_reason}")

        if scl is not None:
            scl_val = scl.value if isinstance(scl, IntLiteral) else scl
            if isinstance(scl_val, int):
                info = PIN_DB.get(scl_val)
                if info and info.blocked:
                    errors.error(bus.region, "HARDWARE ERROR",
                                 f"I2C SCL pin GPIO {scl_val}: {info.blocked_reason}")


# ============================================================
# Deep Sleep Wake Pin Validation
# ============================================================

def _validate_deep_sleep_pins(program: Program, errors: CompilerErrors):
    """Check that pins used in deep sleep wake sources are RTC GPIOs."""
    if not program.hardware:
        return

    has_deep_sleep = _program_uses_deep_sleep(program)
    if not has_deep_sleep:
        return

    for pin in program.hardware.pins:
        # If a pin is used as Input (potential wake source) and deep_sleep is used
        if pin.mode.startswith("Input"):
            info = PIN_DB.get(pin.gpio)
            if info and not info.can_wake_deep_sleep:
                errors.warning(pin.region, "HARDWARE WARNING",
                               f"GPIO {pin.gpio} cannot wake the ESP32 from deep sleep. "
                               f"Only RTC GPIOs can: 0, 2, 4, 12-15, 25-27, 32-39.",
                               hint="If this pin is used as a wake source, use an RTC GPIO instead.")


# ============================================================
# SPI Speed Validation
# ============================================================

def _validate_spi_speed(program: Program, errors: CompilerErrors):
    """Warn when SPI pins use GPIO matrix (limiting speed to 26.6 MHz)."""
    if not program.hardware:
        return

    for bus in program.hardware.buses:
        if bus.bus_type != "spi":
            continue

        non_native = []
        native_set = VSPI_NATIVE  # default to VSPI

        for param_name in ("mosi", "miso", "clk", "cs"):
            param_val = bus.params.get(param_name)
            if param_val is None:
                continue
            gpio = param_val.value if isinstance(param_val, IntLiteral) else param_val
            if isinstance(gpio, int):
                if gpio not in native_set:
                    non_native.append((param_name, gpio))

        if non_native:
            pin_list = ", ".join(f"{name}=GPIO {gpio}" for name, gpio in non_native)
            errors.warning(bus.region, "HARDWARE WARNING",
                           f"SPI bus `{bus.name}`: pins {pin_list} use GPIO matrix routing. "
                           f"Maximum speed limited to 26.6 MHz (full-duplex) / 40 MHz (half-duplex).",
                           hint=f"For 80 MHz, use VSPI native pins: "
                                f"MOSI=23, MISO=19, CLK=18, CS=5.")


# ============================================================
# Helpers
# ============================================================

def _program_uses_wifi(program: Program) -> bool:
    """Check if the program calls wifi.connect() anywhere."""
    return _contains_method_call(program, "wifi", "connect")


def _program_uses_deep_sleep(program: Program) -> bool:
    """Check if the program calls deep_sleep() anywhere."""
    return _contains_func_call(program, "deep_sleep")


def _contains_method_call(program: Program, obj_name: str, method_name: str) -> bool:
    """Search the entire AST for a specific method call."""
    all_stmts = _collect_all_stmts(program)
    for stmt in all_stmts:
        if isinstance(stmt, ExprStmt) and isinstance(stmt.expr, MethodCall):
            if (isinstance(stmt.expr.obj, VarRef) and
                stmt.expr.obj.name == obj_name and
                stmt.expr.method == method_name):
                return True
        if isinstance(stmt, AssignExpr) and isinstance(stmt.value, MethodCall):
            if (isinstance(stmt.value.obj, VarRef) and
                stmt.value.obj.name == obj_name and
                stmt.value.method == method_name):
                return True
    return False


def _contains_func_call(program: Program, func_name: str) -> bool:
    """Search the entire AST for a specific function call."""
    all_stmts = _collect_all_stmts(program)
    for stmt in all_stmts:
        if isinstance(stmt, ExprStmt) and isinstance(stmt.expr, FuncCall):
            if stmt.expr.name == func_name:
                return True
    return False


def _collect_all_stmts(program: Program) -> list:
    """Collect all statements from all functions, tasks, main, machines."""
    stmts = []
    for func in program.functions:
        stmts.extend(_flatten_stmts(func.body))
    for task in program.tasks:
        stmts.extend(_flatten_stmts(task.body))
    if program.setup:
        stmts.extend(_flatten_stmts(program.setup.body))
    for machine in program.machines:
        for state in machine.states:
            stmts.extend(_flatten_stmts(state.enter_body))
            stmts.extend(_flatten_stmts(state.body))
    return stmts


def _flatten_stmts(stmts: list) -> list:
    """Recursively collect all statements including nested blocks."""
    result = []
    for stmt in stmts:
        result.append(stmt)
        if isinstance(stmt, IfStmt):
            result.extend(_flatten_stmts(stmt.then_body))
            if isinstance(stmt.else_body, list):
                result.extend(_flatten_stmts(stmt.else_body))
            elif isinstance(stmt.else_body, IfStmt):
                result.extend(_flatten_stmts([stmt.else_body]))
        elif isinstance(stmt, WhileStmt):
            result.extend(_flatten_stmts(stmt.body))
        elif isinstance(stmt, ForStmt):
            result.extend(_flatten_stmts(stmt.body))
        elif isinstance(stmt, EveryBlock):
            result.extend(_flatten_stmts(stmt.body))
        elif isinstance(stmt, OnBlock):
            result.extend(_flatten_stmts(stmt.body))
        elif isinstance(stmt, TimeoutBlock):
            result.extend(_flatten_stmts(stmt.try_body))
            result.extend(_flatten_stmts(stmt.fallback_body))
    return result
