"""
Tests for internal drivers: Watchdog, Touch, BLE, DAC.
Verifies compiler integration end-to-end.
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
print("\n=== Watchdog ===\n")
# ============================================================

c = compile_ok("watchdog_basic", """
chip esp32
setup {
    system.watchdog_enable(5000)
}
task heartbeat {
    every 2s {
        system.watchdog_feed()
    }
}
""")
c_has(c, "volt_wdt_enable(5000)", "watchdog enable")
c_has(c, "volt_wdt_feed()", "watchdog feed")

c = compile_ok("watchdog_disable", """
chip esp32
setup {
    system.watchdog_enable(10000)
    system.watchdog_disable()
}
""")
c_has(c, "volt_wdt_disable()", "watchdog disable")

c = compile_ok("watchdog_rp2040", """
chip rp2040
setup {
    system.watchdog_enable(8000)
}
task alive {
    every 3s {
        system.watchdog_feed()
    }
}
""")
c_has(c, "volt_wdt_enable(8000)", "rp2040 watchdog")
c_has(c, "int main(void)", "rp2040 entry point")


# ============================================================
print("\n=== Touch ===\n")
# ============================================================

c = compile_ok("touch_basic", """
chip esp32
hardware {
    pin pad: Touch = 4
}
task sense {
    every 100ms {
        if pad.is_touched() {
            log("touch", "detected")
        }
    }
}
""")
c_has(c, "touch_init(4)", "touch init")
c_has(c, "touch_is_touched(4)", "is_touched call")
c_has(c, '#include "volt/touch.h"', "touch header included")

c = compile_ok("touch_read_threshold", """
chip esp32
hardware {
    pin pad: Touch = 15
}
setup {
    pad.set_threshold(25)
    var raw: int = pad.read()
}
""")
c_has(c, "touch_set_threshold(15, 25)", "set_threshold")
c_has(c, "touch_read(15)", "touch read")

c = compile_ok("touch_release", """
chip esp32
hardware {
    pin pad: Touch = 4
}
setup {
    pad.release()
}
""")
c_has(c, "touch_release(4)", "touch release")

c = compile_ok("touch_multi", """
chip esp32
hardware {
    pin pad1: Touch = 4
    pin pad2: Touch = 15
    pin pad3: Touch = 27
}
task sense {
    every 50ms {
        if pad1.is_touched() {
            log("touch", "pad1")
        }
        if pad2.is_touched() {
            log("touch", "pad2")
        }
    }
}
""")
c_has(c, "touch_init(4)", "multi touch init 1")
c_has(c, "touch_init(15)", "multi touch init 2")
c_has(c, "touch_init(27)", "multi touch init 3")

c = compile_ok("touch_no_include_without", """
chip esp32
hardware {
    pin led: Output = 2
}
setup {
    led.on()
}
""")
c_not(c, "touch.h", "no touch.h when no Touch pins")


# ============================================================
print("\n=== BLE ===\n")
# ============================================================

c = compile_ok("ble_peripheral", """
chip esp32
setup {
    ble.advertise("Volt Sensor")
    var temp_id: int = ble.expose_int("temperature", 0)
    var hum_id: int = ble.expose_float("humidity", 0.0)
}
task update {
    every 5s {
        ble.update_int(0, 25)
        ble.update_float(1, 65.5)
    }
}
""")
c_has(c, 'ble_advertise("Volt Sensor")', "ble advertise")
c_has(c, 'ble_expose_int("temperature", 0)', "ble expose int")
c_has(c, 'ble_expose_float("humidity"', "ble expose float")
c_has(c, "ble_update_int(0, 25)", "ble update int")
c_has(c, "ble_update_float(1,", "ble update float")
c_has(c, '#include "volt/ble.h"', "ble header included")

c = compile_ok("ble_connected_check", """
chip esp32
hardware {
    pin led: Output = 2
}
setup {
    ble.advertise("Device")
}
task status {
    every 1s {
        if ble.is_connected() {
            led.on()
        } else {
            led.off()
        }
    }
}
""")
c_has(c, "ble_is_connected()", "ble is_connected")

c = compile_ok("ble_scan", """
chip esp32
setup {
    var count: int = ble.scan(3000ms)
}
""")
c_has(c, "ble_scan(", "ble scan")

c = compile_ok("ble_stop", """
chip esp32
setup {
    ble.advertise("Test")
    ble.stop()
}
""")
c_has(c, "ble_stop()", "ble stop")

c = compile_ok("no_ble_include", """
chip esp32
setup {
    wifi.connect("ssid", "pass")
}
""")
c_not(c, "ble.h", "no ble.h when ble not used")
c_has(c, "wifi.h", "wifi.h still included")


# ============================================================
print("\n=== DAC ===\n")
# ============================================================

c = compile_ok("dac_all_methods", """
chip esp32
hardware {
    pin audio: DAC = 25
    pin ref: DAC = 26
}
setup {
    audio.write(128)
    audio.voltage(1.65)
    var level: int = audio.read()
    ref.write(255)
}
""")
c_has(c, "pin_set_dac(25)", "dac init ch0")
c_has(c, "pin_set_dac(26)", "dac init ch1")
c_has(c, "pin_dac_write(25, 128)", "dac write")
c_has(c, "pin_dac_voltage(25,", "dac voltage")
c_has(c, "pin_dac_read(25)", "dac read")
c_has(c, "pin_dac_write(26, 255)", "dac write ch1")


# ============================================================
print("\n=== All Pin Modes Combined (ESP32) ===\n")
# ============================================================

c = compile_ok("all_pin_modes", """
chip esp32
hardware {
    pin led: Output = 2
    pin btn: PullUpInput = 0
    pin pot: Analog = 34
    pin motor: PWM = 25
    pin arm: Servo = 13
    pin audio: DAC = 26
    pin pad: Touch = 4
}
setup {
    led.on()
    var pressed: bool = btn.is_pressed()
    var reading: int = pot.read()
    motor.write(128)
    arm.move(90)
    audio.write(128)
    var touched: bool = pad.is_touched()
}
""")
c_has(c, "pin_set_output(2)", "output init")
c_has(c, "pin_set_input_pullup(0)", "pullup init")
c_has(c, "pin_set_pwm(25)", "pwm init")
c_has(c, "servo_attach(13)", "servo init")
c_has(c, "pin_set_dac(26)", "dac init")
c_has(c, "touch_init(4)", "touch init")
c_has(c, '#include "volt/servo.h"', "servo header")
c_has(c, '#include "volt/touch.h"', "touch header")


# ============================================================
print("\n=== All Builtins Combined ===\n")
# ============================================================

c = compile_ok("all_builtins", """
chip esp32
storage count: int = 0
setup {
    count = count + 1
    storage.save("count", count)
    system.watchdog_enable(10000)
    ble.advertise("Volt")
    wifi.connect("ssid", "pass")
}
task main {
    every 5s {
        system.watchdog_feed()
        if ble.is_connected() {
            ble.update_int(0, count)
        }
    }
}
""")
c_has(c, '#include "volt/wifi.h"', "wifi include")
c_has(c, '#include "volt/storage.h"', "storage include")
c_has(c, '#include "volt/ble.h"', "ble include")
c_has(c, "volt_wdt_enable(10000)", "watchdog")
c_has(c, "ble_advertise(", "ble")
c_has(c, "wifi_connect(", "wifi")
c_has(c, "storage_save_int(", "storage")


# ============================================================
# Summary
# ============================================================

print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
