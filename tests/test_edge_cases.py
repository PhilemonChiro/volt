"""Comprehensive grammar test: all features, edge cases, and invalid inputs."""

from pathlib import Path
from lark import Lark, exceptions

grammar_path = Path(__file__).parent / "grammar.lark"
grammar = grammar_path.read_text()
parser = Lark(grammar, parser='lalr', propagate_positions=True)

passed = 0
failed = 0
total = 0

def expect_ok(name, src):
    global passed, failed, total
    total += 1
    try:
        parser.parse(src)
        print(f"  OK: {name}")
        passed += 1
    except Exception as e:
        err = str(e).split('\n')[0]
        print(f"FAIL: {name:55s} -> {err}")
        failed += 1

def expect_fail(name, src):
    global passed, failed, total
    total += 1
    try:
        parser.parse(src)
        print(f"FAIL: {name:55s} -> SHOULD FAIL but parsed OK")
        failed += 1
    except (exceptions.UnexpectedToken, exceptions.UnexpectedCharacters,
            exceptions.UnexpectedEOF) as e:
        print(f"  OK: {name} (rejected)")
        passed += 1
    except Exception as e:
        print(f"FAIL: {name:55s} -> CRASH: {type(e).__name__}: {str(e)[:60]}")
        failed += 1


# ============================================================
print("\n=== CORE SYNTAX ===\n")
# ============================================================

expect_ok("empty program",          "\n")
expect_ok("chip",                   "chip esp32\n")
expect_ok("hardware pins",          "hardware {\n    pin led: Output = 2\n    pin btn: Input.PullUp = 0\n}\n")
expect_ok("hardware bus + sensor",  "hardware {\n    i2c bus = i2c(sda: 21, scl: 22)\n    sensor bme: BME280 on bus at 0x76\n}\n")
expect_ok("struct",                 "struct P {\n    x: int\n    y: float\n}\n")
expect_ok("func",                   "func add(a: int, b: int) -> int {\n    return a + b\n}\n")
expect_ok("func void",             "func greet(name: string) {\n    log(name)\n}\n")
expect_ok("func no params",        "func ping() {\n    log(\"pong\")\n}\n")
expect_ok("task",                   "task blink() {\n    every 500ms {\n        led.toggle()\n    }\n}\n")
expect_ok("main",                   "main {\n    run(blink)\n}\n")
expect_ok("let infer",             "main {\n    let x = 42\n}\n")
expect_ok("let typed",             "main {\n    let x: int = 42\n}\n")
expect_ok("var mutable",           "main {\n    var count = 0\n    count = count + 1\n}\n")

# ============================================================
print("\n=== CONTROL FLOW ===\n")
# ============================================================

expect_ok("if",                     "main {\n    if x > 0 {\n        log(x)\n    }\n}\n")
expect_ok("if else",                "main {\n    if x > 0 {\n        log(x)\n    } else {\n        log(0)\n    }\n}\n")
expect_ok("if-elseif-else",         "main {\n    if x > 10 {\n        log(\"high\")\n    } else if x > 5 {\n        log(\"mid\")\n    } else {\n        log(\"low\")\n    }\n}\n")
expect_ok("while",                  "main {\n    while x > 0 {\n        x = x - 1\n    }\n}\n")
expect_ok("for range",             "main {\n    for i in 0..10 {\n        log(i)\n    }\n}\n")
expect_ok("match",                  "main {\n    match(state) {\n        .idle -> log(\"idle\")\n        .active -> log(\"active\")\n    }\n}\n")
expect_ok("match with block",      "main {\n    match(state) {\n        .error -> {\n            log(\"error\")\n            led.blink(100ms)\n        }\n    }\n}\n")
expect_ok("return value",          "func f() -> int {\n    return 42\n}\n")
expect_ok("return void",           "func f() {\n    return\n}\n")
expect_ok("nested if",             "main {\n    if a > 0 {\n        if b > 0 {\n            log(\"both\")\n        }\n    }\n}\n")
expect_ok("deep nesting",          "main {\n    if a {\n        if b {\n            if c {\n                if d {\n                    log(\"deep\")\n                }\n            }\n        }\n    }\n}\n")

# ============================================================
print("\n=== TASK FEATURES ===\n")
# ============================================================

expect_ok("every ms",              "task t() {\n    every 500ms {\n        led.toggle()\n    }\n}\n")
expect_ok("every seconds",         "task t() {\n    every 5seconds {\n        log(\"tick\")\n    }\n}\n")
expect_ok("every strict",          "task t() {\n    every 1ms strict {\n        motor.set(0)\n    }\n}\n")
expect_ok("on event",              "task t() {\n    on button.press() {\n        led.toggle()\n    }\n}\n")
expect_ok("on debounce",           "task t() {\n    on button.press() debounce 50ms {\n        led.toggle()\n    }\n}\n")
expect_ok("on throttle",           "task t() {\n    on sensor.change() throttle 1second {\n        mqtt.send(\"data\", sensor.value())\n    }\n}\n")
expect_ok("on debounce+throttle",  "task t() {\n    on button.press() debounce 50ms throttle 500ms {\n        led.toggle()\n    }\n}\n")
expect_ok("timeout block",         "main {\n    timeout 10seconds {\n        wifi.connect(\"net\", \"pass\")\n    } {\n        log(\"timeout\")\n        system.restart()\n    }\n}\n")
expect_ok("multi every in task",   "task t() {\n    every 1second {\n        log(\"fast\")\n    }\n    every 10seconds {\n        log(\"slow\")\n    }\n}\n")

# ============================================================
print("\n=== STATE MACHINES ===\n")
# ============================================================

expect_ok("simple machine", """
machine DeviceState {
    state idle {
        on button.press() -> connecting
    }
    state connecting {
        on wifi.connected() -> running
        after 10seconds -> error
    }
    state running {
        on wifi.disconnected() -> connecting
    }
    state error {
        after 5seconds -> idle
    }
}
""")

expect_ok("machine with enter", """
machine Mode {
    state off {
        enter {
            led.off()
            log("off")
        }
        on button.press() -> on
    }
    state on {
        enter {
            led.on()
            log("on")
        }
        on button.press() -> off
    }
}
""")

expect_ok("machine with every", """
machine Sensor {
    state running {
        every 5seconds {
            mqtt.send("temp", bme.temperature())
        }
        on battery_low() -> sleep
    }
    state sleep {
        after 10minutes -> running
    }
}
""")

# ============================================================
print("\n=== STORAGE ===\n")
# ============================================================

expect_ok("storage int",           "storage boot_count: int = 0\n")
expect_ok("storage float",         "storage last_temp: float = 0.0\n")
expect_ok("storage string",        "storage device_name: string = \"sensor-01\"\n")

# ============================================================
print("\n=== POWER ===\n")
# ============================================================

expect_ok("power block", """
power {
    source: battery(3700, 2000)
    charging: solar
}
""")

# ============================================================
print("\n=== EXPRESSIONS ===\n")
# ============================================================

expect_ok("binary +",              "main {\n    let x = a + b\n}\n")
expect_ok("binary -",              "main {\n    let x = a - b\n}\n")
expect_ok("binary *",              "main {\n    let x = a * b\n}\n")
expect_ok("binary /",              "main {\n    let x = a / b\n}\n")
expect_ok("binary %",              "main {\n    let x = a % b\n}\n")
expect_ok("comp ==",               "main {\n    let x = a == b\n}\n")
expect_ok("comp !=",               "main {\n    let x = a != b\n}\n")
expect_ok("comp <",                "main {\n    let x = a < b\n}\n")
expect_ok("comp >",                "main {\n    let x = a > b\n}\n")
expect_ok("comp <=",               "main {\n    let x = a <= b\n}\n")
expect_ok("comp >=",               "main {\n    let x = a >= b\n}\n")
expect_ok("bool &&",               "main {\n    let x = a && b\n}\n")
expect_ok("bool ||",               "main {\n    let x = a || b\n}\n")
expect_ok("not !",                 "main {\n    let x = !a\n}\n")
expect_ok("unary -",               "main {\n    let x = -42\n}\n")
expect_ok("precedence",            "main {\n    let x = 1 + 2 * 3\n}\n")
expect_ok("nested parens",         "main {\n    let x = ((1 + 2) * 3)\n}\n")
expect_ok("complex bool",          "main {\n    let x = a > 0 && b < 10 || !c\n}\n")

# ============================================================
print("\n=== LITERALS ===\n")
# ============================================================

expect_ok("int",                   "main {\n    let x = 42\n}\n")
expect_ok("int zero",             "main {\n    let x = 0\n}\n")
expect_ok("int hex",              "main {\n    let x = 0xFF\n}\n")
expect_ok("int large",            "main {\n    let x = 2147483647\n}\n")
expect_ok("float",                "main {\n    let x = 3.14\n}\n")
expect_ok("float zero",           "main {\n    let x = 0.0\n}\n")
expect_ok("string",               "main {\n    let x = \"hello\"\n}\n")
expect_ok("string escape",        "main {\n    let x = \"hello\\nworld\"\n}\n")
expect_ok("true",                 "main {\n    let x = true\n}\n")
expect_ok("false",                "main {\n    let x = false\n}\n")
expect_ok("duration us",          "main {\n    let x = 100us\n}\n")
expect_ok("duration ms",          "main {\n    let x = 500ms\n}\n")
expect_ok("duration second",      "main {\n    let x = 1second\n}\n")
expect_ok("duration seconds",     "main {\n    let x = 5seconds\n}\n")
expect_ok("duration minute",      "main {\n    let x = 1minute\n}\n")
expect_ok("duration minutes",     "main {\n    let x = 10minutes\n}\n")
expect_ok("duration hour",        "main {\n    let x = 1hour\n}\n")
expect_ok("duration hours",       "main {\n    let x = 24hours\n}\n")
expect_ok("array empty",          "main {\n    let x = []\n}\n")
expect_ok("array ints",           "main {\n    let x = [1, 2, 3]\n}\n")
expect_ok("array exprs",          "main {\n    let x = [a + 1, b * 2]\n}\n")

# ============================================================
print("\n=== CALLS AND ACCESS ===\n")
# ============================================================

expect_ok("func call",            "main {\n    log(42)\n}\n")
expect_ok("method call",          "main {\n    led.toggle()\n}\n")
expect_ok("method with args",     "main {\n    wifi.connect(\"a\", \"b\")\n}\n")
expect_ok("chained dots",         "main {\n    a.b.c()\n}\n")
expect_ok("nested calls",         "main {\n    log(add(1, 2))\n}\n")
expect_ok("field access",         "main {\n    let x = data.temperature\n}\n")
expect_ok("deep chain",           "main {\n    a.b.c.d.e.f()\n}\n")
expect_ok("dot assign",           "main {\n    data.x = 5\n}\n")

# ============================================================
print("\n=== TYPES ===\n")
# ============================================================

expect_ok("type int",             "main {\n    let x: int = 0\n}\n")
expect_ok("type float",           "main {\n    let x: float = 0.0\n}\n")
expect_ok("type bool",            "main {\n    let x: bool = true\n}\n")
expect_ok("type string",          "main {\n    let x: string = \"hi\"\n}\n")
expect_ok("type generic",         "main {\n    let x: list<int> = []\n}\n")
expect_ok("type sized",           "main {\n    let x: buffer<128> = []\n}\n")

# ============================================================
print("\n=== COMPLETE PROGRAMS ===\n")
# ============================================================

expect_ok("IoT sensor", """
chip esp32

hardware {
    pin led: Output = 2
    pin button: Input.PullUp = 0
    pin battery: Analog = 36
}

storage boot_count: int = 0

func clamp(val: int, lo: int, hi: int) -> int {
    if val < lo {
        return lo
    }
    if val > hi {
        return hi
    }
    return val
}

task blink() {
    every 500ms {
        led.toggle()
    }
}

task monitor() {
    var count = 0
    every 5seconds {
        count = count + 1
        let bat = battery.read()
        let pct = clamp(bat, 0, 4095)
        mqtt.send_int("volt/battery", pct)
        if count > 100 {
            count = 0
        }
    }
}

main {
    boot_count = boot_count + 1
    wifi.connect("MyNet", "MyPass")
    mqtt.connect("mqtt://broker.local")
    run(blink, monitor)
}
""")

expect_ok("drone controller", """
chip esp32

hardware {
    pin motor: PWM = 4
    pin led: Output = 2
}

machine FlightState {
    state disarmed {
        enter {
            led.off()
        }
        on arm_command() -> armed
    }
    state armed {
        enter {
            led.on()
        }
        on disarm_command() -> disarmed
        on takeoff_command() -> flying
    }
    state flying {
        enter {
            led.blink(200ms)
        }
        every 1ms strict {
            motor.set_pwm(pid.compute())
        }
        on land_command() -> landing
    }
    state landing {
        after 5seconds -> disarmed
    }
}

task telemetry() {
    every 100ms {
        mqtt.send_int("drone/alt", altitude())
    }
}

main {
    wifi.connect("ground", "station")
    run(telemetry)
}
""")

expect_ok("agricultural sensor", """
chip esp32

hardware {
    pin led: Output = 2
    pin battery_sense: Analog = 36
}

storage queue_count: int = 0

power {
    source: battery(3700, 2000)
    charging: solar
}

task main_cycle() {
    let temp = bme.temperature()
    let soil = soil_sensor.read()
    log("temp={temp} soil={soil}")

    timeout 5seconds {
        lora.send(temp)
    } {
        log("send failed")
        queue_count = queue_count + 1
    }

    deep_sleep(10minutes)
}

main {
    main_cycle()
}
""")


# ============================================================
print("\n=== INVALID PROGRAMS (must reject, must not crash) ===\n")
# ============================================================

expect_fail("missing close brace",     "main {\n    log(42)\n")
expect_fail("missing open brace",      "main\n    log(42)\n}\n")
expect_fail("missing parens func",     "func foo {\n}\n")
expect_fail("double equals",           "main {\n    let x = = 5\n}\n")
expect_fail("missing rhs",             "main {\n    let x = 5 +\n}\n")
expect_fail("hardware no braces",      "hardware\n")
expect_fail("pin no value",            "hardware {\n    pin led: Output\n}\n")
expect_fail("unclosed string",         "main {\n    let x = \"hello\n}\n")
expect_fail("empty parens expr",       "main {\n    let x = ()\n}\n")
expect_fail("stray brace",             "}\n")
expect_fail("garbage 1",               "asdf!@#$%\n")
expect_fail("garbage 2",               "{{{{{\n")
expect_fail("struct no type",          "struct S {\n    x\n}\n")
expect_fail("task with params",        "task blink(pin: int) {\n}\n")
expect_fail("assign no value",         "main {\n    x =\n}\n")
expect_fail("lone operator",           "main {\n    +\n}\n")
expect_fail("state outside machine",   "state idle {\n}\n")
expect_fail("storage no type",         "storage x = 0\n")
expect_fail("for no range",            "main {\n    for i in {\n    }\n}\n")


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{total} passed, {failed} failed")
print(f"{'='*60}\n")

if failed > 0:
    exit(1)
