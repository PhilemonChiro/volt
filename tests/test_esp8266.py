"""Test: ESP8266 chip spec — pin database, validation, capability checks."""

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
    errs = [e for e in errors.errors if e.severity == "error"]
    check(name, len(errs) == 0, f"expected no errors but got: {[e.message for e in errs]}")
    return c_code, errors

def compile_err(name, source):
    c_code, errors = compile_volt(source, f"{name}.volt")
    errs = [e for e in errors.errors if e.severity == "error"]
    check(name, len(errs) > 0, "expected errors but got none")
    return c_code, errors


# ============================================================
print("\n=== ESP8266 BASIC COMPILATION ===\n")
# ============================================================

# Simple blink compiles
c, errors = compile_ok("esp8266 blink compiles", """
chip esp8266

hardware {
    pin led: Output = 2
}

task blink() {
    every 500ms {
        led.toggle()
    }
}

main {
    run(blink)
}
""")
check("generates valid C", c is not None and "pin_toggle" in c)


# ============================================================
print("\n=== ESP8266 PIN VALIDATION ===\n")
# ============================================================

# Valid pins: 0-16
c, errors = compile_ok("gpio 4 valid", """
chip esp8266
hardware {
    pin sensor: Input = 4
}
main {}
""")

c, errors = compile_ok("gpio 16 valid output", """
chip esp8266
hardware {
    pin wake: Output = 16
}
main {}
""")

# Invalid pin: GPIO 17+ doesn't exist
c, errors = compile_err("gpio 17 invalid", """
chip esp8266
hardware {
    pin led: Output = 17
}
main {}
""")
errs = [e for e in errors.errors if e.severity == "error"]
check("error mentions ESP8266", any("ESP8266" in e.message or "esp8266" in e.message for e in errs))

# Invalid pin: GPIO 23 doesn't exist
c, errors = compile_err("gpio 23 invalid", """
chip esp8266
hardware {
    pin led: Output = 23
}
main {}
""")

# Flash pins: GPIO 6-11 blocked
c, errors = compile_err("gpio 6 flash", """
chip esp8266
hardware {
    pin x: Output = 6
}
main {}
""")
errs = [e for e in errors.errors if e.severity == "error"]
check("flash pin error mentions SPI", any("flash" in e.message.lower() or "SPI" in e.message for e in errs))

c, errors = compile_err("gpio 9 flash", """
chip esp8266
hardware {
    pin x: Output = 9
}
main {}
""")


# ============================================================
print("\n=== ESP8266 STRAPPING PINS ===\n")
# ============================================================

# GPIO 0, 2, 15 are strapping — should warn but compile
c, errors = compile_ok("gpio 0 strapping warns", """
chip esp8266
hardware {
    pin boot_btn: Input = 0
}
main {}
""")
warns = [e for e in errors.errors if e.severity == "warning"]
check("strapping warning on GPIO 0", any("boot" in e.message.lower() or "strapping" in e.message.lower() for e in warns))

c, errors = compile_ok("gpio 15 strapping warns", """
chip esp8266
hardware {
    pin x: Output = 15
}
main {}
""")
warns = [e for e in errors.errors if e.severity == "warning"]
check("strapping warning on GPIO 15", any("boot" in e.message.lower() or "strapping" in e.message.lower() for e in warns))


# ============================================================
print("\n=== ESP8266 ANALOG NOT SUPPORTED ON GPIO ===\n")
# ============================================================

# ESP8266 has only A0/TOUT for analog, NOT gpio-based
c, errors = compile_err("analog on gpio pin", """
chip esp8266
hardware {
    pin sensor: Analog = 4
}
main {}
""")
errs = [e for e in errors.errors if e.severity == "error"]
check("error mentions A0 or TOUT", any("A0" in e.message or "TOUT" in e.message or "one" in e.message.lower() for e in errs))


# ============================================================
print("\n=== ESP8266 NO TOUCH SUPPORT ===\n")
# ============================================================

c, errors = compile_err("touch not supported", """
chip esp8266
hardware {
    pin t: Touch = 4
}
main {}
""")
errs = [e for e in errors.errors if e.severity == "error"]
check("error mentions touch not available", any("touch" in e.message.lower() for e in errs))


# ============================================================
print("\n=== ESP8266 GPIO 16 SPECIAL ===\n")
# ============================================================

# GPIO 16 cannot do PWM
c, errors = compile_err("gpio 16 no pwm", """
chip esp8266
hardware {
    pin motor: PWM = 16
}
main {}
""")
errs = [e for e in errors.errors if e.severity == "error"]
check("gpio 16 pwm error", any("PWM" in e.message or "pwm" in e.message.lower() for e in errs))


# ============================================================
print("\n=== ESP8266 WIFI WORKS (HAS WIFI) ===\n")
# ============================================================

c, errors = compile_ok("wifi compiles on esp8266", """
chip esp8266
hardware {
    pin led: Output = 2
}
main {
    wifi.connect("test", "pass")
}
""")


# ============================================================
print("\n=== ESP8266 PIN CONFLICT ===\n")
# ============================================================

c, errors = compile_err("duplicate pin", """
chip esp8266
hardware {
    pin a: Output = 4
    pin b: Output = 4
}
main {}
""")
errs = [e for e in errors.errors if e.severity == "error"]
check("duplicate pin error", any("already used" in e.message for e in errs))


# ============================================================
print("\n=== ESP8266 UART WARNING ===\n")
# ============================================================

c, errors = compile_ok("uart pin warns", """
chip esp8266
hardware {
    pin x: Output = 1
}
main {}
""")
warns = [e for e in errors.errors if e.severity == "warning"]
check("uart warning on GPIO 1", any("UART" in e.message or "serial" in e.message.lower() for e in warns))


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed+failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
