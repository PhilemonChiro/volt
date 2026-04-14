"""
Tests for the Servo pin mode: parse, type-check, codegen, easing constants, multi-chip.
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
        check(name, False, f"expected success but got errors: {err_msgs}")
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
        check(name, found, f"expected '{expect_text}' in errors, got: {[e.message for e in errors.errors]}")
    else:
        check(name, True)

def c_contains(c_code, text, name):
    if c_code is None:
        check(name, False, "no C code generated")
        return
    check(name, text in c_code, f"'{text}' not found in generated C")

def c_not_contains(c_code, text, name):
    if c_code is None:
        check(name, False, "no C code generated")
        return
    check(name, text not in c_code, f"'{text}' unexpectedly found in generated C")


# ============================================================
print("\n=== Servo: Basic Pin Declaration ===\n")
# ============================================================

c = compile_ok("servo_basic", """
chip esp32

hardware {
    pin arm: Servo = 13
}

setup {
    arm.move(90)
}
""")
c_contains(c, 'servo_attach(13)', "servo_attach in init")
c_contains(c, 'servo_write(13,', "servo_write for move")
c_contains(c, '#include "volt/servo.h"', "servo.h included")


c = compile_ok("servo_detach", """
chip esp32

hardware {
    pin arm: Servo = 13
}

setup {
    arm.move(0)
    arm.detach()
}
""")
c_contains(c, 'servo_detach(13)', "servo_detach call")


# ============================================================
print("\n=== Servo: All Methods ===\n")
# ============================================================

c = compile_ok("servo_move", """
chip esp32
hardware {
    pin s: Servo = 5
}
setup {
    s.move(45)
}
""")
c_contains(c, 'servo_write(5, 45', "move maps to servo_write")


c = compile_ok("servo_move_us", """
chip esp32
hardware {
    pin s: Servo = 5
}
setup {
    s.move_us(1500)
}
""")
c_contains(c, 'servo_write_us(5, 1500', "move_us maps to servo_write_us")


c = compile_ok("servo_angle_read", """
chip esp32
hardware {
    pin s: Servo = 5
}
setup {
    var a: float = s.angle()
}
""")
c_contains(c, 'servo_read(5)', "angle maps to servo_read")


c = compile_ok("servo_ease_to_default", """
chip esp32
hardware {
    pin s: Servo = 5
}
setup {
    s.ease_to(180, 1000ms)
}
""")
c_contains(c, 'servo_ease_to(5,', "ease_to call")
c_contains(c, 'SERVO_EASE_IN_OUT', "default easing is ease_in_out")


c = compile_ok("servo_ease_to_custom", """
chip esp32
hardware {
    pin s: Servo = 5
}
setup {
    s.ease_to_with(180, 1000ms, ease_out)
}
""")
c_contains(c, 'servo_ease_to(5,', "ease_to_with maps to servo_ease_to")
c_contains(c, 'SERVO_EASE_OUT', "custom easing constant")


c = compile_ok("servo_sweep", """
chip esp32
hardware {
    pin s: Servo = 5
}
setup {
    s.sweep(0, 180, 2000ms)
}
""")
c_contains(c, 'servo_sweep(5,', "sweep call")


c = compile_ok("servo_sweep_ease", """
chip esp32
hardware {
    pin s: Servo = 5
}
setup {
    s.sweep_ease(0, 180, 2000ms, ease_bounce)
}
""")
c_contains(c, 'servo_sweep_ease(5,', "sweep_ease call")
c_contains(c, 'SERVO_EASE_BOUNCE', "bounce easing constant")


c = compile_ok("servo_set_max_angle", """
chip esp32
hardware {
    pin s: Servo = 5
}
setup {
    s.set_max_angle(270)
}
""")
c_contains(c, 'servo_set_max_angle(5,', "set_max_angle call")


# ============================================================
print("\n=== Servo: Easing Constants ===\n")
# ============================================================

easing_pairs = [
    ("linear", "SERVO_LINEAR"),
    ("ease_in", "SERVO_EASE_IN"),
    ("ease_out", "SERVO_EASE_OUT"),
    ("ease_in_out", "SERVO_EASE_IN_OUT"),
    ("ease_in_cubic", "SERVO_EASE_IN_CUBIC"),
    ("ease_out_cubic", "SERVO_EASE_OUT_CUBIC"),
    ("ease_in_out_cubic", "SERVO_EASE_IN_OUT_CUBIC"),
    ("ease_in_sine", "SERVO_EASE_IN_SINE"),
    ("ease_out_sine", "SERVO_EASE_OUT_SINE"),
    ("ease_in_out_sine", "SERVO_EASE_IN_OUT_SINE"),
    ("ease_bounce", "SERVO_EASE_BOUNCE"),
    ("ease_back", "SERVO_EASE_BACK"),
    ("ease_elastic", "SERVO_EASE_ELASTIC"),
]

for volt_name, c_name in easing_pairs:
    c = compile_ok(f"easing_{volt_name}", f"""
chip esp32
hardware {{
    pin s: Servo = 5
}}
setup {{
    s.ease_to_with(90, 500ms, {volt_name})
}}
""")
    c_contains(c, c_name, f"{volt_name} → {c_name}")


# ============================================================
print("\n=== Servo: Multi-Chip Support ===\n")
# ============================================================

c = compile_ok("servo_rp2040", """
chip rp2040

hardware {
    pin arm: Servo = 15
}

setup {
    arm.move(90)
    arm.ease_to(0, 1000ms)
}
""")
c_contains(c, 'servo_attach(15)', "rp2040 servo_attach")
c_contains(c, 'servo_write(15,', "rp2040 servo_write")
c_contains(c, 'int main(void)', "rp2040 entry point")
c_not_contains(c, 'IRAM_ATTR', "no IRAM_ATTR on rp2040")


c = compile_ok("servo_esp8266", """
chip esp8266

hardware {
    pin arm: Servo = 14
}

setup {
    arm.move(45)
}
""")
c_contains(c, 'servo_attach(14)', "esp8266 servo_attach")
c_contains(c, 'void app_main(void)', "esp8266 entry point")


# ============================================================
print("\n=== Servo: No Include Without Servo ===\n")
# ============================================================

c = compile_ok("no_servo_include", """
chip esp32

hardware {
    pin led: Output = 2
}

setup {
    led.on()
}
""")
c_not_contains(c, 'servo.h', "no servo.h when no Servo pins")


# ============================================================
print("\n=== Servo: Multiple Servos ===\n")
# ============================================================

c = compile_ok("multi_servo", """
chip esp32

hardware {
    pin base: Servo = 13
    pin shoulder: Servo = 14
    pin elbow: Servo = 15
}

setup {
    base.move(90)
    shoulder.move(45)
    elbow.move(135)
}
""")
c_contains(c, 'servo_attach(13)', "base servo attached")
c_contains(c, 'servo_attach(14)', "shoulder servo attached")
c_contains(c, 'servo_attach(15)', "elbow servo attached")
c_contains(c, 'servo_write(13,', "base servo write")
c_contains(c, 'servo_write(14,', "shoulder servo write")
c_contains(c, 'servo_write(15,', "elbow servo write")


# ============================================================
print("\n=== Servo: In Tasks ===\n")
# ============================================================

c = compile_ok("servo_in_task", """
chip esp32

hardware {
    pin arm: Servo = 13
}

task waver {
    every 2s {
        arm.ease_to(0, 500ms)
        arm.ease_to(180, 500ms)
    }
}
""")
c_contains(c, 'servo_ease_to(13,', "servo in task body")


# ============================================================
print("\n=== Servo: For Step Clause (bonus: test Round 15 fix) ===\n")
# ============================================================

c = compile_ok("for_step", """
chip esp32

hardware {
    pin arm: Servo = 5
}

setup {
    for i in 0..180 step 10 {
        arm.move(i)
        sleep(100ms)
    }
}
""")
c_contains(c, '+= 10', "for step clause generates += step_val")
c_contains(c, 'servo_write(5,', "servo write in for loop")


# ============================================================
# Summary
# ============================================================

print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
