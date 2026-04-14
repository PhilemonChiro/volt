"""
Round 16 coverage tests — filling the top gaps found by audit.
Covers: channels, shared keyword, PullDownInput, compound ops,
string interpolation, float/int casts, UART, storage methods,
for-step edge cases, wifi-in-if include detection.
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

def c_not(c, text, name):
    if c is None:
        check(name, False, "no C code")
        return
    check(name, text not in c, f"'{text}' unexpectedly found")


# ============================================================
print("\n=== Channels ===\n")
# ============================================================

c = compile_ok("channel_basic", """
chip esp32
channel readings: int[16]

task producer {
    every 1s {
        readings.send(42)
    }
}

task consumer {
    every 500ms {
        if readings.has_data() {
            var val: int = readings.receive()
        }
    }
}
""")
c_has(c, "_ch_readings_t", "channel struct generated")
c_has(c, "readings_send(", "send function generated")
c_has(c, "readings_receive(", "receive function generated")
c_has(c, "readings_has_data(", "has_data function generated")
c_has(c, "atomic_load(", "uses atomic ops")
c_has(c, "atomic_fetch_add(", "atomic increment on send")

c = compile_ok("channel_all_methods", """
chip esp32
channel q: int[8]

task t {
    every 1s {
        q.send(1)
        var x: int = q.receive()
        var n: int = q.count()
        var empty: bool = q.is_empty()
        var full: bool = q.is_full()
        q.clear()
    }
}
""")
c_has(c, "q_count(", "count function")
c_has(c, "q_is_empty(", "is_empty function")
c_has(c, "q_is_full(", "is_full function")
c_has(c, "q_clear(", "clear function")

c = compile_ok("channel_large", """
chip esp32
channel big: int[300]
task t {
    every 1s {
        big.send(1)
    }
}
""")
c_has(c, "uint16_t", "uint16_t for capacity > 255")


# ============================================================
print("\n=== Shared Keyword ===\n")
# ============================================================

c = compile_ok("shared_explicit", """
chip esp32
shared var counter: int = 0

task a {
    every 1s {
        counter += 1
    }
}
""")
c_has(c, "_Atomic", "shared var gets _Atomic")

c = compile_ok("shared_auto_detect", """
chip esp32
var total: int = 0

task a {
    every 1s {
        total += 1
    }
}
task b {
    every 2s {
        total += 10
    }
}
""")
c_has(c, "_Atomic", "auto-detected shared var gets _Atomic")


# ============================================================
print("\n=== PullDownInput ===\n")
# ============================================================

c = compile_ok("pulldown_basic", """
chip esp32
hardware {
    pin btn: PullDownInput = 4
}
setup {
    var pressed: bool = btn.is_pressed()
    var level: int = btn.read()
}
""")
c_has(c, "pin_set_input_pulldown(4)", "pulldown init")
c_has(c, "pin_read(4) == HIGH", "is_pressed uses == HIGH")


# ============================================================
print("\n=== Compound Assignment Operators ===\n")
# ============================================================

ops = [
    ("-=", "-="),
    ("*=", "*="),
    ("/=", "/="),
    ("%=", "%="),
    ("&=", "&="),
    ("|=", "|="),
    ("^=", "^="),
    ("<<=", "<<="),
    (">>=", ">>="),
]

for volt_op, c_op in ops:
    c = compile_ok(f"compound_{volt_op}", f"""
chip esp32
setup {{
    var x: int = 100
    x {volt_op} 2
}}
""")
    c_has(c, c_op, f"{volt_op} generates {c_op}")


# ============================================================
print("\n=== Float/Int Conversion Builtins ===\n")
# ============================================================

c = compile_ok("float_cast", """
chip esp32
setup {
    var x: int = 42
    var f: float = float(x)
}
""")
c_has(c, "(float)(", "float() generates C cast")

c = compile_ok("int_cast", """
chip esp32
setup {
    var f: float = 3.14
    var x: int = int(f)
}
""")
c_has(c, "(int32_t)(", "int() generates C cast")


# ============================================================
print("\n=== UART/Serial Methods ===\n")
# ============================================================

c = compile_ok("uart_basic", """
chip esp32
hardware {
    bus com: UART(tx: 17, rx: 16, baud: 115200)
}
setup {
    com.print("hello")
}
""")
c_has(c, "volt_uart_init(0,", "uart init")
c_has(c, "volt_uart_print(0,", "uart print")
c_has(c, '#include "volt/uart.h"', "uart header included")


# ============================================================
print("\n=== For Step Edge Cases ===\n")
# ============================================================

c = compile_ok("for_step_var", """
chip esp32
setup {
    var stride: int = 5
    for i in 0..100 step stride {
        log("step", "i")
    }
}
""")
c_has(c, "+= stride", "variable step generates += var")

compile_fail("for_step_float", """
chip esp32
setup {
    for i in 0..10 step 1.5 {
        log("x", "y")
    }
}
""", "step must be `int`")


# ============================================================
print("\n=== WiFi Inside If (Include Detection) ===\n")
# ============================================================

c = compile_ok("wifi_in_if", """
chip esp32

task net {
    every 5s {
        if system.free_heap() > 10000 {
            wifi.connect("ssid", "pass")
        }
    }
}
""")
c_has(c, '#include "volt/wifi.h"', "wifi.h included even inside if block")


# ============================================================
print("\n=== Storage Methods ===\n")
# ============================================================

c = compile_ok("storage_save_load", """
chip esp32
storage boot_count: int = 0

setup {
    boot_count = boot_count + 1
    storage.save("boot_count", boot_count)
}
""")
c_has(c, "storage_save_int(", "storage save generates correct call")
c_has(c, '#include "volt/storage.h"', "storage header included")


# ============================================================
print("\n=== System/OTA Methods ===\n")
# ============================================================

c = compile_ok("system_methods", """
chip esp32
setup {
    var mem: int = system.free_heap()
    var up: int = system.uptime()
    system.restart()
}
""")
c_has(c, "system_free_heap(", "free_heap call")
c_has(c, "system_uptime(", "uptime call")
c_has(c, "system_restart(", "restart call")


# ============================================================
print("\n=== Multi-Chip: RP2040 Specifics ===\n")
# ============================================================

c = compile_ok("rp2040_no_iram", """
chip rp2040
hardware {
    pin led: Output = 25
}

task blink {
    every 500ms {
        led.toggle()
    }
}
""")
c_has(c, "int main(void)", "rp2040 main")
c_has(c, "stdio_init_all()", "rp2040 stdio init")
c_not(c, "IRAM_ATTR", "no IRAM_ATTR on rp2040")
c_not(c, "app_main", "no app_main on rp2040")


# ============================================================
print("\n=== String Concat Types ===\n")
# ============================================================

c = compile_ok("string_concat_int", """
chip esp32
setup {
    var x: int = 42
    var s: string = "value=" + x
}
""")
c_has(c, "snprintf(", "string+int generates snprintf")
c_has(c, "%ld", "int format specifier")


# ============================================================
# Summary
# ============================================================

print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
