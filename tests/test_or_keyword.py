"""
Tests for the `or` keyword — error handling for fallible calls.
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
    check(name, c_code is not None)
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
print("\n=== or retry (statement) ===\n")
# ============================================================

c = compile_ok("or_retry_wifi", """
chip esp32
setup {
    wifi.connect("net", "pass") or retry(3)
}
""")
c_has(c, "volt_error_t _err", "retry generates error check")
c_has(c, "_retry < 3", "retry count is 3")
c_has(c, "wifi_connect(", "call emitted")

c = compile_ok("or_retry_mqtt", """
chip esp32
setup {
    wifi.connect("net", "pass") or retry(10)
    mqtt.connect("mqtt://broker") or retry(5)
}
""")
c_has(c, "_retry < 10", "wifi retry 10")
c_has(c, "_retry < 5", "mqtt retry 5")


# ============================================================
print("\n=== or skip (in var decl) ===\n")
# ============================================================

c = compile_ok("or_skip_sensor", """
chip esp32
hardware {
    bus sensors: I2C(sda: 21, scl: 22)
    device bme: BME280 on sensors at 0x76
}
task monitor {
    every 10s {
        var temp: float = bme.temperature() or skip
    }
}
""")
c_has(c, "bme280_temperature(&_bme)", "sensor call emitted")
c_has(c, "or skip", "skip comment present")


# ============================================================
print("\n=== or default value ===\n")
# ============================================================

c = compile_ok("or_default_int", """
chip esp32
setup {
    var x: int = 42 or 0
}
""")
c_has(c, "int32_t x = 42", "value emitted")

c = compile_ok("or_default_float", """
chip esp32
setup {
    var x: float = 3.14 or 0.0
}
""")


# ============================================================
print("\n=== or skip (statement) ===\n")
# ============================================================

c = compile_ok("or_skip_stmt", """
chip esp32
setup {
    wifi.connect("net", "pass") or skip
}
""")
c_has(c, "continue", "skip generates continue")
c_has(c, "VOLT_OK", "checks error code")


# ============================================================
print("\n=== or restart ===\n")
# ============================================================

c = compile_ok("or_restart", """
chip esp32
setup {
    wifi.connect("net", "pass") or restart
}
""")
c_has(c, "system_restart()", "restart on failure")


# ============================================================
print("\n=== or in task ===\n")
# ============================================================

c = compile_ok("or_in_task", """
chip esp32
setup {
    wifi.connect("net", "pass") or retry(5)
}
task telemetry {
    every 30s {
        mqtt.send_int("t", 25) or retry(3)
    }
}
""")
c_has(c, "_retry < 5", "setup retry")
c_has(c, "_retry < 3", "task retry")


# ============================================================
print("\n=== or type mismatch ===\n")
# ============================================================

compile_fail("or_type_mismatch", """
chip esp32
setup {
    var x: int = 42 or "hello"
}
""", "fallback")


# ============================================================
print("\n=== v3 weather station pattern ===\n")
# ============================================================

c = compile_ok("v3_weather", """
chip esp32
hardware {
    pin led: Output = 2
    bus sensors: I2C(sda: 21, scl: 22)
    device bme: BME280 on sensors at 0x76
}
storage boot_count: int = 0
setup {
    boot_count += 1
    wifi.connect("WeatherNet", "pass") or retry(10)
    mqtt.connect("mqtt://192.168.1.100") or retry(5)
}
task monitor {
    every 10s {
        var temp: float = bme.temperature() or skip
        var hum: float = bme.humidity() or skip
        mqtt.send_float("weather/temp", temp) or retry(3)
        mqtt.send_float("weather/hum", hum) or retry(3)
    }
}
task heartbeat {
    every 1s {
        led.toggle()
    }
}
""")
c_has(c, "_retry < 10", "wifi retry 10")
c_has(c, "_retry < 5", "mqtt retry 5")
c_has(c, "_retry < 3", "publish retry 3")
c_has(c, "bme280_temperature(&_bme)", "sensor read")
c_has(c, "or skip", "skip on sensor fail")


# ============================================================
print("\n=== or skip — skip counter codegen ===\n")
# ============================================================

c, e = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
task worker {
    every 500ms {
        led.toggle() or skip
    }
}
""", "skip_counter.volt")
check("or skip compiles", c is not None)
if c:
    c_has(c, "continue;", "skip generates continue")
    c_has(c, "_skip_count_", "skip counter declared")
    c_has(c, "VOLT_OK", "checks error return")

# or restart
c2, e2 = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
task worker {
    every 1s {
        led.on() or restart
    }
}
""", "or_restart.volt")
check("or restart compiles", c2 is not None)
if c2:
    c_has(c2, "system_restart()", "restart on failure")

# or retry with count
c3, e3 = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
task worker {
    every 1s {
        led.on() or retry(5)
    }
}
""", "or_retry5.volt")
check("or retry(5) compiles", c3 is not None)
if c3:
    c_has(c3, "_retry < 5", "retry loop with count 5")
    c_has(c3, "VOLT_OK", "checks error in retry")


# ============================================================
print("\n=== or skip in variable init ===\n")
# ============================================================

c4, e4 = compile_volt("""
chip esp32
hardware { pin btn: Input = 4 }
task reader {
    every 2s {
        var val: int = btn.read() or skip
    }
}
""", "var_or_skip.volt")
check("var init or skip compiles", c4 is not None)


# ============================================================
# Summary
# ============================================================

print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
