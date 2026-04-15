"""
Tests for enum type declarations — type-safe named constants.
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

def c_not(c, text, name):
    if c is None:
        check(name, False, "no C code")
        return
    check(name, text not in c, f"'{text}' found unexpectedly")


# ============================================================
print("\n=== Enum Declaration ===\n")
# ============================================================

c = compile_ok("enum_basic", """
chip esp32
enum Color {
    red
    green
    blue
}
setup {
    var c: Color = Color.red
}
""")
c_has(c, "typedef enum {", "C enum typedef")
c_has(c, "COLOR_RED", "variant RED")
c_has(c, "COLOR_GREEN", "variant GREEN")
c_has(c, "COLOR_BLUE", "variant BLUE")
c_has(c, "} color_t;", "enum type name")
c_has(c, "color_t c = COLOR_RED", "var declaration with enum type")

c = compile_ok("enum_two_variants", """
chip esp32
enum OnOff {
    on
    off
}
setup {
    var state: OnOff = OnOff.off
}
""")
c_has(c, "ONOFF_ON", "two-variant enum ON")
c_has(c, "ONOFF_OFF", "two-variant enum OFF")
c_has(c, "onoff_t state = ONOFF_OFF", "enum var init")


# ============================================================
print("\n=== Enum Comparison ===\n")
# ============================================================

c = compile_ok("enum_eq", """
chip esp32
enum DoorState {
    locked
    unlocked
    ajar
}
hardware {
    pin led: Output = 2
}
setup {
    var state: DoorState = DoorState.locked
    if state == DoorState.unlocked {
        led.on()
    }
}
""")
c_has(c, "state == DOORSTATE_UNLOCKED", "enum == comparison")

c = compile_ok("enum_neq", """
chip esp32
enum Mode {
    idle
    active
}
setup {
    var m: Mode = Mode.idle
    if m != Mode.active {
        log("status", "not active")
    }
}
""")
c_has(c, "m != MODE_ACTIVE", "enum != comparison")


# ============================================================
print("\n=== Enum in Tasks ===\n")
# ============================================================

c = compile_ok("enum_in_task", """
chip esp32
enum AlertLevel {
    normal
    warning
    critical
}
hardware {
    pin buzzer: PWM = 25
}
task monitor {
    every 5s {
        var level: AlertLevel = AlertLevel.normal
        if level == AlertLevel.critical {
            buzzer.beep_alarm()
        }
    }
}
""")
c_has(c, "alertlevel_t level = ALERTLEVEL_NORMAL", "enum in task")
c_has(c, "ALERTLEVEL_CRITICAL", "enum comparison in task")


# ============================================================
print("\n=== Enum Assignment ===\n")
# ============================================================

c = compile_ok("enum_reassign", """
chip esp32
enum TrafficLight {
    red
    yellow
    green
}
setup {
    var light: TrafficLight = TrafficLight.red
    light = TrafficLight.green
}
""")
c_has(c, "light = TRAFFICLIGHT_GREEN", "enum reassignment")


# ============================================================
print("\n=== Multiple Enums ===\n")
# ============================================================

c = compile_ok("multiple_enums", """
chip esp32
enum Color {
    red
    green
    blue
}
enum Size {
    small
    medium
    large
}
setup {
    var c: Color = Color.blue
    var s: Size = Size.medium
}
""")
c_has(c, "color_t c = COLOR_BLUE", "first enum")
c_has(c, "size_t s = SIZE_MEDIUM", "second enum")
c_has(c, "} color_t;", "color typedef")
c_has(c, "} size_t;", "size typedef")


# ============================================================
print("\n=== Enum Type Mismatch ===\n")
# ============================================================

compile_fail("enum_wrong_type", """
chip esp32
enum Color {
    red
    green
}
enum Size {
    small
    large
}
setup {
    var c: Color = Color.red
    if c == Size.small {
        log("x", "y")
    }
}
""", "cannot use")


# ============================================================
print("\n=== Enum on RP2040 ===\n")
# ============================================================

c = compile_ok("enum_rp2040", """
chip rp2040
enum Mode {
    standby
    active
    sleep
}
setup {
    var m: Mode = Mode.standby
}
""")
c_has(c, "int main(void)", "rp2040 entry point")
c_has(c, "mode_t m = MODE_STANDBY", "enum on rp2040")


# ============================================================
# Summary
# ============================================================

print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
