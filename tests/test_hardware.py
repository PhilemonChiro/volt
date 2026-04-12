"""Test: hardware validator catches pin conflicts, dangerous configs, and ESP32-specific gotchas."""

import sys
import os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from volt.compiler.parser import parse
from volt.compiler.resolver import resolve
from volt.compiler.checker import check_types
from volt.compiler.hardware import validate_hardware
from volt.compiler.errors import CompilerErrors

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

def validate(source):
    """Full pipeline: parse → resolve → check types → validate hardware."""
    prog = parse(source)
    errors = CompilerErrors()
    errors.set_source(source)
    scope = resolve(prog, errors)
    if not errors.has_errors:
        check_types(prog, scope, errors)
    if not errors.has_errors:
        validate_hardware(prog, scope, errors)
    return errors

def count_errors(errors):
    return sum(1 for e in errors.errors if e.severity == "error")

def count_warnings(errors):
    return sum(1 for e in errors.errors if e.severity == "warning")

def has_error_about(errors, text):
    return any(text.lower() in e.message.lower() for e in errors.errors if e.severity == "error")

def has_warning_about(errors, text):
    return any(text.lower() in e.message.lower() for e in errors.errors if e.severity == "warning")


# ============================================================
print("\n=== Valid Hardware (no errors) ===\n")
# ============================================================

errs = validate("""
hardware {
    pin led: Output = 2
    pin button: PullUpInput = 0
    pin battery: Analog = 36
}
setup {
    led.toggle()
}
""")
check("valid config", count_errors(errs) == 0, f"got {count_errors(errs)} errors")


# ============================================================
print("\n=== Flash Pins (GPIO 6-11) ===\n")
# ============================================================

for gpio in range(6, 12):
    errs = validate(f"hardware {{\n    pin x: Output = {gpio}\n}}\n")
    check(f"GPIO {gpio} blocked", has_error_about(errs, "flash") or has_error_about(errs, "spi flash"),
          f"errors: {[e.message for e in errs.errors]}")


# ============================================================
print("\n=== Input-Only Pins as Output ===\n")
# ============================================================

for gpio in (34, 35, 36, 39):
    errs = validate(f"hardware {{\n    pin x: Output = {gpio}\n}}\n")
    check(f"GPIO {gpio} input-only", has_error_about(errs, "input-only"),
          f"errors: {[e.message for e in errs.errors]}")


# ============================================================
print("\n=== No Pull-Up on Input-Only ===\n")
# ============================================================

errs = validate("hardware {\n    pin btn: PullUpInput = 34\n}\n")
check("GPIO 34 no pullup", has_error_about(errs, "pull-up"),
      f"errors: {[e.message for e in errs.errors]}")


# ============================================================
print("\n=== Pin Conflict (Duplicate) ===\n")
# ============================================================

errs = validate("""
hardware {
    pin led: Output = 2
    pin motor: Output = 2
}
""")
check("duplicate pin", has_error_about(errs, "already used"),
      f"errors: {[e.message for e in errs.errors]}")


# ============================================================
print("\n=== Strapping Pin Warnings ===\n")
# ============================================================

for gpio in (0, 2, 5, 12, 15):
    errs = validate(f"hardware {{\n    pin x: Output = {gpio}\n}}\n")
    check(f"GPIO {gpio} strapping warning", has_warning_about(errs, "strapping"),
          f"warnings: {[e.message for e in errs.errors if e.severity == 'warning']}")


# ============================================================
print("\n=== GPIO 12 Critical Warning ===\n")
# ============================================================

errs = validate("hardware {\n    pin x: Output = 12\n}\n")
check("GPIO 12 VDD_SDIO warning", has_warning_about(errs, "vdd_sdio") or has_warning_about(errs, "1.8v"),
      f"warnings: {[e.message for e in errs.errors if e.severity == 'warning']}")


# ============================================================
print("\n=== UART0 Warning ===\n")
# ============================================================

errs = validate("hardware {\n    pin x: Output = 1\n}\n")
check("GPIO 1 UART0 warning", has_warning_about(errs, "uart0") or has_warning_about(errs, "serial"),
      f"warnings: {[e.message for e in errs.errors if e.severity == 'warning']}")

errs = validate("hardware {\n    pin x: Input = 3\n}\n")
check("GPIO 3 UART0 warning", has_warning_about(errs, "uart0") or has_warning_about(errs, "serial"),
      f"warnings: {[e.message for e in errs.errors if e.severity == 'warning']}")


# ============================================================
print("\n=== ADC2 + WiFi Conflict ===\n")
# ============================================================

errs = validate("""
hardware {
    pin sensor: Analog = 4
}
setup {
    wifi.connect("net", "pass")
    let val = sensor.read()
}
""")
check("ADC2 GPIO4 + WiFi", has_warning_about(errs, "adc2"),
      f"warnings: {[e.message for e in errs.errors if e.severity == 'warning']}")

# ADC1 should be fine
errs = validate("""
hardware {
    pin sensor: Analog = 36
}
setup {
    wifi.connect("net", "pass")
    let val = sensor.read()
}
""")
adc2_warns = [e for e in errs.errors if "adc2" in e.message.lower()]
check("ADC1 GPIO36 + WiFi OK", len(adc2_warns) == 0,
      f"unexpected ADC2 warning for ADC1 pin")


# ============================================================
print("\n=== GPIO 36/39 Interrupt Errata ===\n")
# ============================================================

errs = validate("hardware {\n    pin btn: Input = 36\n}\n")
check("GPIO 36 errata", has_warning_about(errs, "errata") or has_warning_about(errs, "spurious"),
      f"warnings: {[e.message for e in errs.errors if e.severity == 'warning']}")

errs = validate("hardware {\n    pin btn: Input = 39\n}\n")
check("GPIO 39 errata", has_warning_about(errs, "errata") or has_warning_about(errs, "spurious"),
      f"warnings: {[e.message for e in errs.errors if e.severity == 'warning']}")


# ============================================================
print("\n=== I2C Address Conflict ===\n")
# ============================================================

errs = validate("""
hardware {
    i2c bus = i2c(sda: 21, scl: 22)
    sensor bme: BME280 on bus at 0x76
    sensor bmp: BME280 on bus at 0x76
}
""")
check("I2C addr conflict", has_error_about(errs, "address") and has_error_about(errs, "already used"),
      f"errors: {[e.message for e in errs.errors]}")

# Different addresses should be fine
errs = validate("""
hardware {
    i2c bus = i2c(sda: 21, scl: 22)
    sensor bme: BME280 on bus at 0x76
    sensor light: BH1750 on bus at 0x23
}
""")
i2c_errs = [e for e in errs.errors if "address" in e.message.lower() and e.severity == "error"]
check("I2C different addrs OK", len(i2c_errs) == 0)


# ============================================================
print("\n=== Invalid GPIO Number ===\n")
# ============================================================

errs = validate("hardware {\n    pin x: Output = 50\n}\n")
check("GPIO 50 invalid", has_error_about(errs, "does not exist"),
      f"errors: {[e.message for e in errs.errors]}")


# ============================================================
print("\n=== Non-Analog Pin as Analog ===\n")
# ============================================================

errs = validate("hardware {\n    pin x: Analog = 21\n}\n")
check("GPIO 21 not analog", has_error_about(errs, "adc") or has_error_about(errs, "analog"),
      f"errors: {[e.message for e in errs.errors]}")


# ============================================================
print("\n=== JTAG Pin Warning ===\n")
# ============================================================

errs = validate("hardware {\n    pin x: Output = 14\n}\n")
check("GPIO 14 JTAG warning", has_warning_about(errs, "jtag"),
      f"warnings: {[e.message for e in errs.errors if e.severity == 'warning']}")


# ============================================================
print("\n=== Full Valid System (many pins) ===\n")
# ============================================================

errs = validate("""
chip esp32

hardware {
    pin led: Output = 2
    pin motor: PWM = 4
    pin button: PullUpInput = 0
    pin battery: Analog = 36
    pin soil: Analog = 39
}

setup {
    led.toggle()
    let bat = battery.read()
}
""")
check("full valid system", count_errors(errs) == 0,
      f"errors: {[e.message for e in errs.errors if e.severity == 'error']}")


# ============================================================
print("\n=== Error Message Quality ===\n")
# ============================================================

errs = validate("hardware {\n    pin motor: Output = 6\n}\n")
report = errs.report("main.volt")
check("report has filename", "main.volt" in report)
check("report has HARDWARE ERROR", "HARDWARE ERROR" in report)
check("report has flash", "flash" in report.lower())
check("report suggests pins", "available" in report.lower() or "output pins" in report.lower())

print("\n  Sample error:")
for line in report.split('\n')[:10]:
    print(f"    {line}")


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}\n")

if failed > 0:
    exit(1)
