"""
End-to-end tests: .volt source → full pipeline → generated C

Tests the complete transpiler: parse → resolve → check → validate → analyze → transform → codegen.
Covers all features, edge cases, error cases, and three task tiers.
"""

import sys
import os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from volt.compiler.voltc import compile_volt

passed = 0
failed = 0

def check(name, condition, detail=""):
    global passed, failed
    if condition:
        print(f"  OK: {name}")
        passed += 1
    else:
        print(f"FAIL: {name} — {detail}")
        failed += 1

def compile_ok(name, source):
    """Compile and expect success. Returns C code."""
    c_code, errors = compile_volt(source, f"{name}.volt")
    if errors.has_errors:
        err_msgs = [e.message for e in errors.errors if e.severity == "error"]
        check(name, False, f"expected success but got errors: {err_msgs}")
        return None
    check(name, c_code is not None, "c_code is None")
    return c_code

def compile_fail(name, source, expect_text=None):
    """Compile and expect failure."""
    c_code, errors = compile_volt(source, f"{name}.volt")
    if not errors.has_errors:
        check(name, False, "expected failure but compiled OK")
        return
    if expect_text:
        found = any(expect_text.lower() in e.message.lower() for e in errors.errors)
        check(name, found, f"expected '{expect_text}' in errors, got: {[e.message for e in errors.errors]}")
    else:
        check(name, True)

def c_contains(c_code, text, name):
    """Check generated C contains expected text."""
    if c_code is None:
        check(name, False, "no C code generated")
        return
    check(name, text in c_code, f"'{text}' not found in generated C")

def c_not_contains(c_code, text, name):
    """Check generated C does NOT contain text."""
    if c_code is None:
        check(name, False, "no C code generated")
        return
    check(name, text not in c_code, f"'{text}' unexpectedly found in generated C")


# ============================================================
print("\n=== BASIC PROGRAMS ===\n")
# ============================================================

# Minimal program
c = compile_ok("minimal chip only", "chip esp32\nsetup {\n}\n")
c_contains(c, "app_main", "has app_main")
c_contains(c, "volt_init", "has volt_init")

# Empty program
c = compile_ok("empty program", "\n")

# Just a function
c = compile_ok("just a func", """
func add(a: int, b: int) -> int {
    return a + b
}
""")
c_contains(c, "int32_t add(int32_t a, int32_t b)", "func signature correct")
c_contains(c, "return (a + b)", "return expression")


# ============================================================
print("\n=== BLINK (Background Task) ===\n")
# ============================================================

c = compile_ok("blink", """
chip esp32
hardware {
    pin led: Output = 2
}
task blink {
    every 500ms {
        led.toggle()
    }
}
setup {
    run(blink)
}
""")
c_contains(c, "static void blink_run(volt_task_t *_vt)", "protothread function")
c_contains(c, "VOLT_TASK_BEGIN(_vt)", "task begin")
c_contains(c, "VOLT_TASK_END(_vt)", "task end")
c_contains(c, "pin_toggle(2)", "led.toggle() → pin_toggle(2)")
c_contains(c, "VOLT_YIELD_LABEL(_vt,", "yield with counter label")
c_contains(c, "500", "500ms interval")
c_contains(c, "pin_set_output(2)", "pin init in app_main")
c_contains(c, "volt_run(_tasks,", "task scheduler")
c_not_contains(c, "__LINE__", "no __LINE__ in generated code")


# ============================================================
print("\n=== THREE TIERS ===\n")
# ============================================================

c = compile_ok("three tiers", """
chip esp32
hardware {
    pin led: Output = 2
    pin motor: PWM = 4
}
task blink {
    every 500ms {
        led.toggle()
    }
}
task motor_pid {
    every 1ms strict {
        motor.set_pwm(0)
    }
}
task telemetry {
    every 5seconds {
        mqtt.send_int("status", 1)
    }
}
setup {
    wifi.connect("net", "pass")
    mqtt.connect("mqtt://broker")
    run(blink, motor_pid, telemetry)
}
""")
# Background tier
c_contains(c, "static void blink_run(volt_task_t *_vt)", "blink is protothread")
c_contains(c, "VOLT_YIELD_LABEL", "protothread yield")

# Critical tier
c_contains(c, "static void IRAM_ATTR motor_pid_isr(void *arg)", "motor_pid is ISR")
c_contains(c, "pin_pwm_write(4, 0)", "motor ISR body")
c_contains(c, "volt_critical_create", "critical task creation")
c_contains(c, "1000", "1ms = 1000us period")

# Priority tier
c_contains(c, "static void telemetry_run(void *arg)", "telemetry is FreeRTOS")
c_contains(c, "volt_delay_ms(5000)", "priority task uses blocking delay")
c_contains(c, "volt_rt_create", "priority task creation")

# WiFi/MQTT
c_contains(c, 'wifi_connect("net", "pass")', "wifi connect in main")
c_contains(c, 'mqtt_connect("mqtt://broker")', "mqtt connect in main")

# Includes
c_contains(c, '#include "volt/wifi.h"', "wifi include (used)")
c_contains(c, '#include "volt/mqtt.h"', "mqtt include (used)")


# ============================================================
print("\n=== VARIABLES AND EXPRESSIONS ===\n")
# ============================================================

c = compile_ok("variables", """
setup {
    let x = 42
    let pi = 3.14
    let name = "hello"
    let flag = true
    var count = 0
    count = count + 1
}
""")
c_contains(c, "int32_t x = 42", "int var")
c_contains(c, "float pi = 3.14f", "float var")
c_contains(c, 'const char* name = "hello"', "string var")
c_contains(c, "bool flag = true", "bool var")
c_contains(c, "int32_t count = 0", "var decl")
c_contains(c, "count = (count + 1)", "assignment")


# ============================================================
print("\n=== CONTROL FLOW ===\n")
# ============================================================

c = compile_ok("if else", """
setup {
    let x = 42
    if x > 10 {
        log("high")
    } else {
        log("low")
    }
}
""")
c_contains(c, "x > 10", "if condition")
c_contains(c, "} else {", "else clause")

c = compile_ok("while loop", """
setup {
    var i = 0
    while i < 10 {
        i = i + 1
    }
}
""")
c_contains(c, "i < 10", "while condition")

c = compile_ok("for loop", """
setup {
    for i in 0..10 {
        log("tick")
    }
}
""")
c_contains(c, "for (int32_t i = 0; i < 10; i++)", "for loop")

c = compile_ok("nested if", """
setup {
    let a = true
    let b = true
    if a {
        if b {
            log("both")
        }
    }
}
""")
c_contains(c, "if (a)", "outer if")


# ============================================================
print("\n=== FUNCTIONS ===\n")
# ============================================================

c = compile_ok("func with return", """
func clamp(val: int, lo: int, hi: int) -> int {
    if val < lo {
        return lo
    }
    if val > hi {
        return hi
    }
    return val
}
setup {
    let x = clamp(42, 0, 100)
}
""")
c_contains(c, "int32_t clamp(int32_t val, int32_t lo, int32_t hi)", "func signature")
c_contains(c, "return lo", "return low")
c_contains(c, "return hi", "return high")
c_contains(c, "return val", "return val")
c_contains(c, "clamp(42, 0, 100)", "func call in main")

c = compile_ok("void func", """
func greet(name: string) {
    log(name)
}
setup {
    greet("world")
}
""")
c_contains(c, "void greet(const char* name)", "void func signature")


# ============================================================
print("\n=== PIN METHODS ===\n")
# ============================================================

c = compile_ok("pin methods", """
hardware {
    pin led: Output = 2
    pin btn: PullUpInput = 0
    pin bat: Analog = 36
}
setup {
    led.on()
    led.off()
    led.toggle()
    let pressed = btn.is_pressed()
    let val = bat.read()
}
""")
c_contains(c, "pin_write(2, HIGH)", "led.on()")
c_contains(c, "pin_write(2, LOW)", "led.off()")
c_contains(c, "pin_toggle(2)", "led.toggle()")
c_contains(c, "(pin_read(0) == LOW)", "btn.is_pressed()")
c_contains(c, "pin_read(36)", "bat.read()")


# ============================================================
print("\n=== WIFI AND MQTT METHODS ===\n")
# ============================================================

c = compile_ok("wifi mqtt methods", """
setup {
    wifi.connect("ssid", "pass")
    mqtt.connect("mqtt://broker")
    mqtt.send("topic", "data")
    mqtt.send_int("topic", 42)
    mqtt.send_float("topic", 3.14)
    let connected = wifi.is_connected()
}
""")
c_contains(c, 'wifi_connect("ssid", "pass")', "wifi connect")
c_contains(c, 'mqtt_connect("mqtt://broker")', "mqtt connect")
c_contains(c, 'mqtt_send("topic", "data")', "mqtt send")
c_contains(c, 'mqtt_send_int("topic", 42)', "mqtt send int")
c_contains(c, 'mqtt_send_float("topic", 3.14f)', "mqtt send float")
c_contains(c, "wifi_is_connected()", "wifi is_connected")


# ============================================================
print("\n=== VARIABLE LIFTING (Crossing Yields) ===\n")
# ============================================================

c = compile_ok("var lifting", """
task monitor {
    var count = 0
    every 1seconds {
        count = count + 1
        log("tick")
    }
}
""")
# count should be lifted to context struct
c_contains(c, "monitor_ctx_t", "context struct generated")
c_contains(c, "ctx->count", "lifted variable accessed via ctx")

c = compile_ok("non-crossing var stays local", """
task simple {
    every 1seconds {
        let temp = 42
        log("done")
    }
}
""")
# temp should NOT be lifted — it's local to every body
c_not_contains(c, "simple_ctx_t", "no context struct needed")


# ============================================================
print("\n=== DURATION UNITS ===\n")
# ============================================================

c = compile_ok("durations", """
task t {
    every 500ms {
        log("a")
    }
}
""")
c_contains(c, "500", "500ms → 500")

c = compile_ok("duration seconds", """
task t {
    every 5seconds {
        log("b")
    }
}
""")
c_contains(c, "5000", "5seconds → 5000")


# ============================================================
print("\n=== STORAGE ===\n")
# ============================================================

c = compile_ok("storage vars", """
storage boot_count: int = 0
setup {
    log("boot")
}
""")
c_contains(c, "storage_init()", "storage init called")
c_contains(c, "static int32_t boot_count = 0;", "storage var declared")


# ============================================================
print("\n=== ERROR: Type Mismatch ===\n")
# ============================================================

compile_fail("int = string", 'setup {\n    let x: int = "hello"\n}\n', "declared as")
compile_fail("int + float", "setup {\n    let x = 1 + 3.14\n}\n", "cannot")
compile_fail("if int", "setup {\n    if 42 {\n        log(\"no\")\n    }\n}\n", "bool")
compile_fail("wrong arg type", """
func add(a: int, b: int) -> int {
    return a + b
}
setup {
    add("a", "b")
}
""", "expects")


# ============================================================
print("\n=== ERROR: Name Errors ===\n")
# ============================================================

compile_fail("unknown var", "setup {\n    let x = unknown\n}\n", "unknown")
compile_fail("unknown func", "setup {\n    nonexistent()\n}\n", "unknown")
compile_fail("duplicate pin", """
hardware {
    pin led: Output = 2
    pin led: Output = 4
}
""", "already")


# ============================================================
print("\n=== ERROR: Hardware Errors ===\n")
# ============================================================

compile_fail("flash pin", "hardware {\n    pin x: Output = 6\n}\n", "flash")
compile_fail("input-only output", "hardware {\n    pin x: Output = 34\n}\n", "input-only")
compile_fail("no pullup on 34", "hardware {\n    pin x: PullUpInput = 34\n}\n", "pull-up")
compile_fail("invalid gpio", "hardware {\n    pin x: Output = 50\n}\n", "does not exist")
compile_fail("non-analog pin", "hardware {\n    pin x: Analog = 21\n}\n", "adc")
compile_fail("i2c addr conflict", """
hardware {
    i2c bus = i2c(sda: 21, scl: 22)
    sensor a: BME280 on bus at 0x76
    sensor b: BME280 on bus at 0x76
}
""", "address")


# ============================================================
print("\n=== ERROR: ISR Safety ===\n")
# ============================================================

compile_fail("log in critical", """
task pid {
    every 1ms strict {
        log("tick")
    }
}
""", "critical")

compile_fail("wifi in critical", """
task pid {
    every 1ms strict {
        wifi.connect("a", "b")
    }
}
""", "critical")

compile_fail("sensor in critical", """
hardware {
    sensor bme: BME280 on bus at 0x76
}
task pid {
    every 1ms strict {
        bme.temperature()
    }
}
""", "critical")


# ============================================================
print("\n=== ERROR: Task Errors ===\n")
# ============================================================

compile_fail("recursive yield", """
func retry(n: int) {
    sleep(1second)
    retry(n)
}
""", "recursive")

compile_fail("wrong return type", """
func get_name() -> string {
    return 42
}
""", "returns")

compile_fail("immutable assign", """
setup {
    let x = 5
    x = 10
}
""", "immutable")

compile_fail("too few args", """
func add(a: int, b: int) -> int {
    return a + b
}
setup {
    add(1)
}
""", "expects 2")

compile_fail("method not found", """
hardware {
    pin led: Output = 2
}
setup {
    led.read()
}
""", "no method")


# ============================================================
print("\n=== COMPLEX PROGRAM ===\n")
# ============================================================

c = compile_ok("complex iot", """
chip esp32

hardware {
    pin led: Output = 2
    pin button: PullUpInput = 0
    pin motor: PWM = 4
    pin battery: Analog = 36
}

storage boot_count: int = 0

func clamp(val: int, lo: int, hi: int) -> int {
    if val < lo {
        return lo
    }
    if val > hi {
        return hi
    }
    return val
}

task blink {
    every 500ms {
        led.toggle()
    }
}

task motor_control {
    every 1ms strict {
        motor.set_pwm(0)
    }
}

task monitor {
    var count = 0
    every 5seconds {
        count = count + 1
        let bat = battery.read()
        let pct = clamp(bat, 0, 4095)
        mqtt.send_int("volt/battery", pct)
        if count > 100 {
            count = 0
        }
    }
}

setup {
    wifi.connect("MyNet", "MyPass")
    mqtt.connect("mqtt://broker.local")
    run(blink, motor_control, monitor)
}
""")
# Verify all three tiers
c_contains(c, "blink_run(volt_task_t *_vt)", "blink = background")
c_contains(c, "IRAM_ATTR motor_control_isr", "motor = critical")
c_contains(c, "monitor_run(void *arg)", "monitor = priority")
# monitor is Priority tier (uses mqtt) — FreeRTOS task, no protothread context struct
# count is a local var in the FreeRTOS task — stays on the stack, no lifting needed
c_contains(c, "monitor_run(void *arg)", "monitor is priority FreeRTOS task")
c_contains(c, "clamp(", "user func called")
c_contains(c, "storage_init()", "storage init")
c_contains(c, "volt_critical_create", "critical task created")
c_contains(c, "volt_rt_create", "priority task created")
c_contains(c, "volt_run(", "background scheduler")


# ============================================================
print("\n=== SYNTAX ERRORS (graceful failure) ===\n")
# ============================================================

compile_fail("missing brace", "setup {\n    log(42)\n", None)
compile_fail("garbage", "!@#$%^&\n", None)
compile_fail("empty parens", "setup {\n    let x = ()\n}\n", None)


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}\n")

if failed > 0:
    exit(1)
