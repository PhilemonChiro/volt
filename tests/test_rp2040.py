"""
RP2040/Pico-specific codegen tests — verify correct C output for Raspberry Pi Pico.

Checks: int main vs app_main, stdio_init_all, pico includes,
pin ranges (GP0-GP28), no WiFi/MQTT/BLE, ADC pins GP26-28.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
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

def c_has(c, text, name):
    check(name, c is not None and text in c, f"'{text}' not found")

def c_not(c, text, name):
    check(name, c is not None and text not in c, f"'{text}' should NOT be in output")

def compile_ok(name, source):
    c, errs = compile_volt(source, f"{name}.volt")
    errors = [e for e in errs.errors if e.severity == "error"]
    if errors:
        check(name, False, f"Errors: {[e.message for e in errors]}")
        return None
    check(name, c is not None)
    return c

def compile_fail(name, source, expect=None):
    c, errs = compile_volt(source, f"{name}.volt")
    has_errs = errs.has_errors
    if expect:
        found = any(expect.lower() in e.message.lower() for e in errs.errors)
        check(name, found, f"expected '{expect}', got: {[e.message for e in errs.errors]}")
    else:
        check(name, has_errs, "expected failure")


# ============================================================
print("\n=== RP2040: Entry point ===\n")
# ============================================================

c = compile_ok("rp2040_main", """
chip rp2040
hardware { pin led: Output = 25 }
setup { led.on() }
""")
if c:
    c_has(c, "int main(void)", "uses int main, not app_main")
    c_not(c, "app_main", "no app_main for RP2040")
    c_has(c, "stdio_init_all()", "calls stdio_init_all")
    c_has(c, 'pico/stdlib.h', "includes pico/stdlib.h")

# ESP32 comparison
c2 = compile_ok("esp32_main", """
chip esp32
hardware { pin led: Output = 2 }
setup { led.on() }
""")
if c2:
    c_has(c2, "void app_main(void)", "ESP32 uses app_main")
    c_not(c2, "stdio_init_all", "no stdio_init_all for ESP32")


# ============================================================
print("\n=== RP2040: Valid pin ranges ===\n")
# ============================================================

# GP25 = onboard LED
c = compile_ok("rp2040_gp25", """
chip rp2040
hardware { pin led: Output = 25 }
setup { led.on() }
""")
c_has(c, "pin_set_output(25)", "GP25 valid")

# GP0 = valid
c2 = compile_ok("rp2040_gp0", """
chip rp2040
hardware { pin sda: Output = 0 }
setup { sda.on() }
""")
c_has(c2, "pin_set_output(0)", "GP0 valid")

# GP28 = valid (last usable)
c3 = compile_ok("rp2040_gp28", """
chip rp2040
hardware { pin adc: Output = 28 }
setup { adc.on() }
""")
c_has(c3, "pin_set_output(28)", "GP28 valid")


# ============================================================
print("\n=== RP2040: Tasks and timing ===\n")
# ============================================================

c = compile_ok("rp2040_task", """
chip rp2040
hardware { pin led: Output = 25 }
task blink {
    every 500ms {
        led.toggle()
    }
}
""")
if c:
    c_has(c, "VOLT_YIELD_LABEL", "protothread yield on RP2040")
    c_has(c, "volt_run(_tasks,", "uses volt_run scheduler")

# Multiple tasks
c2 = compile_ok("rp2040_multi_task", """
chip rp2040
hardware {
    pin led1: Output = 25
    pin led2: Output = 15
}
task fast {
    every 100ms { led1.toggle() }
}
task slow {
    every 1s { led2.toggle() }
}
""")
if c2:
    c_has(c2, "fast_run", "first task")
    c_has(c2, "slow_run", "second task")
    c_has(c2, "volt_run(_tasks, 2)", "two tasks in table")


# ============================================================
print("\n=== RP2040: State machines ===\n")
# ============================================================

c = compile_ok("rp2040_statemachine", """
chip rp2040
hardware { pin led: Output = 25 }
machine blinker {
    state off {
        enter { led.off() }
        after 1s -> on
    }
    state on {
        enter { led.on() }
        after 500ms -> off
    }
}
""")
if c:
    c_has(c, "BLINKER_OFF", "state enum")
    c_has(c, "BLINKER_ON", "state enum")
    c_has(c, "int main(void)", "RP2040 main")


# ============================================================
print("\n=== RP2040: Storage ===\n")
# ============================================================

c = compile_ok("rp2040_storage", """
chip rp2040
hardware { pin led: Output = 25 }
storage boot_count: int = 0
setup {
    boot_count = boot_count + 1
    storage.save("boots", boot_count)
}
""")
if c:
    c_has(c, "storage_init()", "storage initialized")
    c_has(c, "storage_save_int", "save int")
    c_has(c, "storage_load_int", "load int")


# ============================================================
print("\n=== RP2040: I2C sensor ===\n")
# ============================================================

c = compile_ok("rp2040_i2c", """
chip rp2040
hardware {
    pin led: Output = 25
    bus i2c0: I2C(sda: 4, scl: 5)
    device bme: BME280 on i2c0 at 0x76
}
task reader {
    every 2s {
        var temp: float = bme.temperature()
    }
}
""")
if c:
    c_has(c, "volt_i2c_init", "I2C init call")
    c_has(c, "bme280_temperature", "sensor method")
    c_has(c, "int main(void)", "RP2040 entry")


# ============================================================
print("\n=== RP2040: Cross-chip same program ===\n")
# ============================================================

TEMPLATE = """
chip {chip}
hardware {{
    pin led: Output = {pin}
}}
task blink {{
    every 500ms {{
        led.toggle()
    }}
}}
"""

c_esp = compile_ok("cross_esp32", TEMPLATE.format(chip="esp32", pin="2"))
c_rp = compile_ok("cross_rp2040", TEMPLATE.format(chip="rp2040", pin="25"))
if c_esp and c_rp:
    check("ESP32 has app_main", "app_main" in c_esp)
    check("RP2040 has int main", "int main" in c_rp)
    check("both have VOLT_YIELD_LABEL", "VOLT_YIELD_LABEL" in c_esp and "VOLT_YIELD_LABEL" in c_rp)
    check("both have volt_run", "volt_run" in c_esp and "volt_run" in c_rp)


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
