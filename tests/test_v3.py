"""
Tests for v3 language features in combination.
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

def c_has(c, text, name):
    if c is None:
        check(name, False, "no C code")
        return
    check(name, text in c, f"'{text}' not found")


# ============================================================
print("\n=== Single-Line Hardware Blocks ===\n")
# ============================================================

c = compile_ok("hw_single_line", """
hardware { pin led = 2 }
every 500ms { led.toggle() }
""")
c_has(c, "pin_set_output(2)", "inferred Output")
c_has(c, "pin_toggle(2)", "toggle call")

c = compile_ok("hw_single_pullup", """
hardware { pin btn: PullUpInput = 0 }
setup {
    var p: bool = btn.is_pressed()
}
""")
c_has(c, "pin_set_input_pullup(0)", "pullup init")


# ============================================================
print("\n=== Top-Level Every + When + Or ===\n")
# ============================================================

c = compile_ok("toplevel_when_or", """
hardware {
    bus s: I2C(sda: 21, scl: 22)
    device bme: BME280 on s at 0x76
}
setup {
    wifi.connect("net", "pass") or retry(10)
}
every 10s when wifi.is_connected() {
    var temp: float = bme.temperature() or skip
    mqtt.send_float("temp", temp) or retry(3)
}
""")
c_has(c, "wifi_is_connected()", "when guard")
c_has(c, "_retry < 10", "wifi retry")
c_has(c, "_retry < 3", "mqtt retry")
c_has(c, "or skip", "skip comment")

c = compile_ok("multiple_toplevel", """
hardware { pin led = 2 }
every 100ms { led.toggle() }
every 5s { log("health", "alive") }
every 30s { log("stats", "ok") }
""")
c_has(c, "_rule0_run", "first auto-task")
c_has(c, "_rule1_run", "second auto-task")
c_has(c, "_rule2_run", "third auto-task")


# ============================================================
print("\n=== Enum + When Guard ===\n")
# ============================================================

c = compile_ok("enum_when_guard", """
enum State { idle, active }
hardware { pin led = 2 }
var s: State = State.idle
every 1s when s == State.active {
    led.toggle()
}
""")
c_has(c, "STATE_ACTIVE", "enum constant in guard")
c_has(c, "if (", "guard emitted as if")


# ============================================================
print("\n=== Pin Inference + Enum + Or Combined ===\n")
# ============================================================

c = compile_ok("v3_combined", """
enum AlertLevel { normal, warning, critical }

hardware {
    pin led = 2
    pin buzzer: PWM = 25
    bus s: I2C(sda: 21, scl: 22)
    device bme: BME280 on s at 0x76
}

storage boot_count: int = 0
channel alerts: int[8]

setup {
    boot_count += 1
    system.watchdog_enable(15000)
    wifi.connect("net", "pass") or retry(10)
    mqtt.connect("mqtt://broker") or retry(5)
    buzzer.beep_startup()
}

every 10s when wifi.is_connected() {
    system.watchdog_feed()
    var temp: float = bme.temperature() or skip
    mqtt.send_float("temp", temp) or retry(3)
    if temp > 35 {
        alerts.send(1)
        buzzer.beep_warning()
    }
}

every 100ms {
    if alerts.has_data() {
        var code: int = alerts.receive()
        led.on()
    }
}

every 1s { led.toggle() }
""")
c_has(c, "alertlevel_t", "enum typedef")
c_has(c, "pin_set_output(2)", "inferred Output")
c_has(c, "wifi_is_connected()", "when guard")
c_has(c, "_retry < 10", "wifi retry")
c_has(c, "volt_wdt_enable(15000)", "watchdog")
c_has(c, "bme280_temperature(&_bme)", "sensor call")
c_has(c, "pin_tone_startup(25)", "tone pattern")
c_has(c, "_ch_alerts_t", "channel struct")


# ============================================================
print("\n=== Become in State Machine ===\n")
# ============================================================

c = compile_ok("become_basic", """
hardware { pin led = 2 }
machine blinker {
    state on_state {
        enter {
            led.on()
        }
        after 1s -> off_state
    }
    state off_state {
        enter {
            led.off()
        }
        after 1s -> on_state
    }
}
""")
c_has(c, "BLINKER_ON_STATE", "first state is initial by default")
c_has(c, "blinker_transition", "transition function")


# ============================================================
print("\n=== No Chip In Source (volt.toml) ===\n")
# ============================================================

c = compile_ok("no_chip_source", """
hardware { pin led = 2 }
setup { led.on() }
""")
c_has(c, "app_main", "defaults to esp32 entry point")


# ============================================================
# Summary
# ============================================================

print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
