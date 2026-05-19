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
print("\n=== ROUND 32: storage type dispatch, match desugar, for step ===\n")
# ============================================================

# Storage.load_float dispatches correctly
c, e = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
setup {
    storage.save("temp", 98.6)
    var t: float = storage.load_float("temp")
}
""", "storage_float.volt")
check("storage.save float dispatches", c and "storage_save_float" in c)
check("storage.load_float dispatches", c and "storage_load_float" in c)

# Storage.load_str dispatches correctly
c2, e2 = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
setup {
    storage.save("name", "volt")
    var n: string = storage.load_str("name")
}
""", "storage_str.volt")
check("storage.save str dispatches", c2 and "storage_save_str" in c2)
check("storage.load_str dispatches", c2 and "storage_load_str" in c2)

# Match statement desugars to if-else chain
c3, e3 = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
enum Mode { idle, running, error }
setup {
    var m: Mode = Mode.idle
    match(m) {
        .idle -> led.off()
        .running -> led.on()
        _ -> led.toggle()
    }
}
""", "match_desugar.volt")
check("match compiles", c3 is not None)
if c3:
    # First arm (idle) should be checked first in the if-else chain
    idle_pos = c3.find("MODE_IDLE")
    running_pos = c3.find("MODE_RUNNING")
    check("match arms in correct order", idle_pos < running_pos,
          f"idle at {idle_pos}, running at {running_pos}")

# For loop with negative literal step
c4, e4 = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
setup {
    for i in 10..0 step -2 {
        led.toggle()
    }
}
""", "for_neg.volt")
check("for negative step compiles", c4 is not None)
if c4:
    check("negative step uses > comparator", "i > " in c4 or "i >=" in c4,
          "should count down with > comparison")

# For loop with positive literal step
c5, e5 = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
setup {
    for i in 0..100 step 5 {
        led.toggle()
    }
}
""", "for_pos.volt")
check("for positive step compiles", c5 is not None)
if c5:
    check("positive step uses < comparator", "i < " in c5 or "i <=" in c5)

# Shared variable compound assign uses atomics
c6, e6 = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
shared var counter: int = 0
task inc {
    every 100ms strict {
        counter += 1
    }
}
task dec {
    every 200ms strict {
        counter -= 1
    }
}
""", "shared_compound.volt")
check("shared compound assign compiles", c6 is not None)
if c6:
    check("shared += uses atomic_fetch_add", "atomic_fetch_add" in c6)
    check("shared -= uses atomic_fetch_sub", "atomic_fetch_sub" in c6)

# ============================================================
print("\n=== Channel try_receive and helpers ===\n")
# ============================================================

c_ch, _ = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
channel queue: int[8]
task producer {
    every 1s { queue.send(42) }
}
task consumer {
    every 100ms {
        if queue.has_data() {
            var val: int = queue.receive()
        }
    }
}
""", "channel_ops.volt")
check("channel compiles", c_ch is not None)
if c_ch:
    check("try_receive generated", "queue_try_receive" in c_ch)
    check("has_data generated", "queue_has_data" in c_ch)
    check("send generated", "queue_send" in c_ch)
    check("receive generated", "queue_receive" in c_ch)
    check("count generated", "queue_count" in c_ch)

# ============================================================
print("\n=== STM32 codegen ===\n")
# ============================================================

c_stm, e_stm = compile_volt("""
chip stm32f103
hardware {
    pin led: Output = 13
}
setup {
    led.on()
}
""", "stm32_basic.volt")
check("STM32 compiles", c_stm is not None)
if c_stm:
    check("STM32 uses app_main", "void app_main(void)" in c_stm)
    check("STM32 pin_set_output", "pin_set_output(13)" in c_stm)

c_stm2, _ = compile_volt("""
chip stm32f103
hardware {
    pin led: Output = 13
}
task blink {
    every 500ms {
        led.toggle()
    }
}
""", "stm32_task.volt")
check("STM32 task compiles", c_stm2 is not None)
if c_stm2:
    check("STM32 has protothread", "VOLT_YIELD_LABEL" in c_stm2)
    check("STM32 has task table", "volt_run(_tasks," in c_stm2)

# ============================================================
print("\n=== Enum variant resolution in match ===\n")
# ============================================================

c_em, _ = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
enum State { idle, active, error }
setup {
    var s: State = State.idle
    match(s) {
        .idle -> led.off()
        .active -> led.on()
        .error -> led.toggle()
    }
}
""", "enum_match.volt")
check("enum match compiles", c_em is not None)
if c_em:
    check("match uses STATE_IDLE", "STATE_IDLE" in c_em)
    check("match uses STATE_ACTIVE", "STATE_ACTIVE" in c_em)
    check("match uses STATE_ERROR", "STATE_ERROR" in c_em)

# ============================================================
print("\n=== Include detection with or-expressions and when guards ===\n")
# ============================================================

# wifi.connect() or retry — must still detect wifi usage
c_ow, _ = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
setup {
    wifi.connect("ssid", "pass") or retry(5)
    mqtt.connect("mqtt://broker") or retry(3)
}
""", "or_include.volt")
check("or-wrapped wifi detected", c_ow is not None and 'wifi.h' in c_ow)
check("or-wrapped mqtt detected", c_ow is not None and 'mqtt.h' in c_ow)

# when guard — must detect wifi usage
c_wg, _ = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
task sender {
    every 10s when wifi.is_connected() {
        mqtt.send("topic", "data") or skip
        led.toggle()
    }
}
""", "when_include.volt")
check("when-guard wifi detected", c_wg is not None and 'wifi.h' in c_wg)
check("or-skip mqtt in body detected", c_wg is not None and 'mqtt.h' in c_wg)

# http and ble with or-expressions
c_hb, _ = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
setup {
    ble.advertise("VoltDevice") or skip
}
""", "ble_or.volt")
check("or-skip ble detected", c_hb is not None and 'ble.h' in c_hb)

# ============================================================
print("\n=== Critical task IRAM_ATTR — esp_attr.h include ===\n")
# ============================================================

# ESP32 with critical task — must include esp_attr.h for IRAM_ATTR
c_crit, _ = compile_volt("""
chip esp32
hardware { pin motor: PWM = 5 }
every 1ms strict {
    motor.set_pwm(0)
}
""", "critical_esp32.volt")
check("esp32 critical task compiles", c_crit is not None)
if c_crit:
    check("esp32 critical includes esp_attr.h", 'esp_attr.h' in c_crit)
    check("esp32 critical uses IRAM_ATTR", 'IRAM_ATTR' in c_crit)

# ESP32 WITHOUT critical task — must NOT include esp_attr.h (no IRAM_ATTR needed)
c_nocrit, _ = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
every 500ms {
    led.toggle()
}
""", "no_critical_esp32.volt")
check("esp32 no-critical compiles", c_nocrit is not None)
if c_nocrit:
    check("esp32 no-critical skips esp_attr.h", 'esp_attr.h' not in c_nocrit)

# RP2040 critical task — must NOT include esp_attr.h (Pico SDK)
c_rp, _ = compile_volt("""
chip rp2040
hardware { pin motor: PWM = 5 }
every 1ms strict {
    motor.set_pwm(0)
}
""", "critical_rp2040.volt")
check("rp2040 critical compiles", c_rp is not None)
if c_rp:
    check("rp2040 critical skips esp_attr.h", 'esp_attr.h' not in c_rp)
    check("rp2040 critical skips IRAM_ATTR", 'IRAM_ATTR' not in c_rp)

# ============================================================
# Summary
# ============================================================

print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
