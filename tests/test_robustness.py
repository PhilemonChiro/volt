"""
Round 20 robustness tests — single-line blocks, complex programs,
edge cases that stress the full pipeline.
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
    c_code, errors = compile_volt(source, f"{name}.volt")
    if errors.has_errors:
        err_msgs = [e.message for e in errors.errors if e.severity == "error"]
        check(name, False, f"errors: {err_msgs}")
        return None
    check(name, c_code is not None, "c_code is None")
    return c_code

def compile_fail(name, source, expect_text=None):
    c_code, errors = compile_volt(source, f"{name}.volt")
    if not errors.has_errors:
        check(name, False, "expected failure but compiled OK")
        return
    if expect_text:
        found = any(expect_text.lower() in e.message.lower() for e in errors.errors)
        check(name, found, f"expected '{expect_text}', got: {[e.message for e in errors.errors]}")
    else:
        check(name, True)

def c_has(c, text, name):
    if c is None:
        check(name, False, "no C code")
        return
    check(name, text in c, f"'{text}' not found")


# ============================================================
print("\n=== Single-Line Blocks ===\n")
# ============================================================

c = compile_ok("if_single_line", """
chip esp32
setup {
    var x: int = 5
    if x > 0 { x = 0 }
}
""")
c_has(c, "x = 0", "assign inside single-line if")

c = compile_ok("if_continue_single", """
chip esp32
setup {
    for i in 0..10 {
        if i == 5 { continue }
    }
}
""")
c_has(c, "continue", "continue in single-line if")

c = compile_ok("if_break_single", """
chip esp32
setup {
    for i in 0..10 {
        if i == 8 { break }
    }
}
""")
c_has(c, "break", "break in single-line if")

c = compile_ok("if_return_single", """
chip esp32
func clamp(val: int, lo: int, hi: int) -> int {
    if val < lo { return lo }
    if val > hi { return hi }
    return val
}
setup {
    var x: int = clamp(150, 0, 100)
}
""")
c_has(c, "return lo", "return in single-line if")
c_has(c, "return hi", "second return")

c = compile_ok("if_compound_assign_single", """
chip esp32
setup {
    var x: int = 0
    if true { x += 10 }
}
""")
c_has(c, "+= 10", "compound assign in single-line if")

c = compile_ok("if_method_single", """
chip esp32
hardware {
    pin led: Output = 2
}
setup {
    if true { led.on() }
}
""")
c_has(c, "pin_write(2, HIGH)", "method call in single-line if")


# ============================================================
print("\n=== Complex Multi-Feature Programs ===\n")
# ============================================================

c = compile_ok("multi_task_channels", """
chip esp32
channel data: int[16]
shared var total: int = 0

task producer {
    every 1s {
        total += 1
        data.send(total)
    }
}

task consumer {
    every 500ms {
        if data.has_data() {
            var val: int = data.receive()
            total -= val
        }
    }
}
""")
c_has(c, "_Atomic", "shared var atomic")
c_has(c, "_ch_data_t", "channel struct")
c_has(c, "data_send(", "channel send")
c_has(c, "data_receive(", "channel receive")
c_has(c, "atomic_fetch_add(", "atomic += on shared")
c_has(c, "atomic_fetch_sub(", "atomic -= on shared")

c = compile_ok("state_machine_full", """
chip esp32
hardware {
    pin led: Output = 2
}
machine traffic {
    initial state green {
        enter {
            led.on()
        }
        exit {
            led.off()
        }
        after 5s -> yellow
    }
    state yellow {
        enter {
            led.on()
        }
        after 2s -> red
    }
    state red {
        enter {
            led.off()
        }
        after 5s -> green
    }
}
""")
c_has(c, "TRAFFIC_GREEN", "state enum green")
c_has(c, "TRAFFIC_YELLOW", "state enum yellow")
c_has(c, "TRAFFIC_RED", "state enum red")
c_has(c, "traffic_transition", "transition function")

c = compile_ok("function_with_logic", """
chip esp32
func max(a: int, b: int) -> int {
    if a > b {
        return a
    }
    return b
}

func min(a: int, b: int) -> int {
    if a < b {
        return a
    }
    return b
}

setup {
    var big: int = max(10, 20)
    var small: int = min(10, 20)
}
""")
c_has(c, "static int32_t max(", "max function")
c_has(c, "static int32_t min(", "min function")
c_has(c, "max(10, 20)", "max call")
c_has(c, "min(10, 20)", "min call")


# ============================================================
print("\n=== Mixed Int/Float Operations ===\n")
# ============================================================

c = compile_ok("float_int_arithmetic", """
chip esp32
setup {
    var x: int = 10
    var f: float = 3.14
    var result: float = x + f
    var result2: float = f * x
}
""")
c_has(c, "x + f", "int + float compiles")

c = compile_ok("float_int_comparison", """
chip esp32
setup {
    var temp: float = 25.5
    if temp > 30 {
        log("hot", "yes")
    }
    if temp <= 20 {
        log("cold", "yes")
    }
    if 100 >= temp {
        log("normal", "yes")
    }
}
""")
c_has(c, "temp > 30", "float > int")
c_has(c, "temp <= 20", "float <= int")
c_has(c, "100 >= temp", "int >= float")


# ============================================================
print("\n=== I2C + Sensor Full Pipeline ===\n")
# ============================================================

c = compile_ok("i2c_sensor_full", """
chip esp32
hardware {
    bus sensors: I2C(sda: 21, scl: 22)
    device bme: BME280 on sensors at 0x76
}

task monitor {
    every 5s {
        var temp: float = bme.temperature()
        var hum: float = bme.humidity()
        var pres: float = bme.pressure()
        if temp > 35 {
            log("alert", "hot")
        }
    }
}
""")
c_has(c, "bme280_temperature(&_bme)", "sensor temperature call")
c_has(c, "bme280_humidity(&_bme)", "sensor humidity call")
c_has(c, "bme280_pressure(&_bme)", "sensor pressure call")
c_has(c, "volt_i2c_init(0,", "i2c init")
c_has(c, "bme280_init(&_bme,", "sensor init")


# ============================================================
print("\n=== Servo with Easing in Task ===\n")
# ============================================================

c = compile_ok("servo_task_easing", """
chip esp32
hardware {
    pin arm: Servo = 13
    pin base: Servo = 14
}

task wave {
    every 3s {
        arm.ease_to_with(0, 1s, ease_out)
        arm.ease_to_with(180, 1s, ease_in)
        base.sweep(0, 90, 2s)
    }
}
""")
c_has(c, "servo_ease_to(13,", "arm ease_to")
c_has(c, "SERVO_EASE_OUT", "ease_out constant")
c_has(c, "SERVO_EASE_IN", "ease_in constant")
c_has(c, "servo_sweep(14,", "base sweep")


# ============================================================
print("\n=== For Step Clause Edge Cases ===\n")
# ============================================================

c = compile_ok("for_step_large", """
chip esp32
setup {
    for i in 0..1000 step 100 {
        log("step", "i")
    }
}
""")
c_has(c, "+= 100", "large step value")

c = compile_ok("for_no_step", """
chip esp32
setup {
    for i in 0..10 {
        log("loop", "i")
    }
}
""")
c_has(c, "i++", "default step is ++")


# ============================================================
print("\n=== Error Cases ===\n")
# ============================================================

compile_fail("wrong_pin_method", """
chip esp32
hardware {
    pin led: Output = 2
}
setup {
    led.read()
}
""", "no method")

compile_fail("type_mismatch_assign", """
chip esp32
setup {
    var x: int = "hello"
}
""", "declared as")

compile_fail("undeclared_var", """
chip esp32
setup {
    x = 42
}
""", "unknown name")

compile_fail("bool_condition_required", """
chip esp32
setup {
    if 42 {
        log("bad", "condition")
    }
}
""", "bool")

compile_fail("break_outside_loop", """
chip esp32
setup {
    break
}
""", "loop")


# ============================================================
# Summary
# ============================================================

print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
