"""Test: type checker catches type errors and validates operations."""

import sys
import os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from volt.compiler.parser import parse
from volt.compiler.resolver import resolve
from volt.compiler.checker import check_types
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

def type_check(source):
    """Parse + resolve + type check. Returns errors."""
    prog = parse(source)
    errors = CompilerErrors()
    errors.set_source(source)
    scope = resolve(prog, errors)
    if not errors.has_errors:
        check_types(prog, scope, errors)
    return errors


# ============================================================
print("\n=== Valid Programs (no type errors) ===\n")
# ============================================================

errs = type_check("""
hardware {
    pin led: Output = 2
    pin battery: Analog = 36
}
func add(a: int, b: int) -> int {
    return a + b
}
task blink {
    every 500ms {
        led.toggle()
    }
}
setup {
    let x = 42
    let y = add(x, 1)
    let pi = 3.14
    let name = "sensor"
    let flag = true
    wifi.connect("net", "pass")
    mqtt.connect("mqtt://localhost")
    run(blink)
}
""")
check("valid program", not errs.has_errors, f"got {errs.count}: {[e.message for e in errs.errors]}")


# ============================================================
print("\n=== Type Mismatch in Assignment ===\n")
# ============================================================

errs = type_check("""
setup {
    let x: int = "hello"
}
""")
check("int = string", errs.has_errors)
check("mentions type mismatch", any("TYPE MISMATCH" in e.category for e in errs.errors))

errs = type_check("""
setup {
    let x: float = true
}
""")
check("float = bool", errs.has_errors)


# ============================================================
print("\n=== Invalid Operators ===\n")
# ============================================================

errs = type_check("""
setup {
    let x = "hello" - 5
}
""")
check("string - int", errs.has_errors)

errs = type_check("""
setup {
    let x = true + false
}
""")
check("bool + bool", errs.has_errors)

errs = type_check("""
setup {
    let x = 1 + 3.14
}
""")
check("int + float auto-promotes to float", not errs.has_errors)

errs = type_check("""
setup {
    var temp: float = 25.5
    if temp > 30 {
        log("hot", "yes")
    }
}
""")
check("float > int auto-promotes", not errs.has_errors)


# ============================================================
print("\n=== Valid Operators ===\n")
# ============================================================

errs = type_check("setup {\n    let x = 1 + 2\n}\n")
check("int + int", not errs.has_errors, f"{[e.message for e in errs.errors]}")

errs = type_check("setup {\n    let x = 3.14 + 2.0\n}\n")
check("float + float", not errs.has_errors, f"{[e.message for e in errs.errors]}")

errs = type_check('setup {\n    let x = "a" + "b"\n}\n')
check("string + string", not errs.has_errors, f"{[e.message for e in errs.errors]}")

errs = type_check("setup {\n    let x = 1 > 2\n}\n")
check("int > int → bool", not errs.has_errors, f"{[e.message for e in errs.errors]}")

errs = type_check("setup {\n    let x = true && false\n}\n")
check("bool && bool", not errs.has_errors, f"{[e.message for e in errs.errors]}")

errs = type_check("setup {\n    let x = !true\n}\n")
check("!bool", not errs.has_errors, f"{[e.message for e in errs.errors]}")

errs = type_check("setup {\n    let x = -42\n}\n")
check("-int", not errs.has_errors, f"{[e.message for e in errs.errors]}")


# ============================================================
print("\n=== Unary Errors ===\n")
# ============================================================

errs = type_check("setup {\n    let x = !42\n}\n")
check("!int error", errs.has_errors)

errs = type_check('setup {\n    let x = -"hello"\n}\n')
check("-string error", errs.has_errors)


# ============================================================
print("\n=== Condition Must Be Bool ===\n")
# ============================================================

errs = type_check("""
setup {
    if 42 {
        log("nope")
    }
}
""")
check("if int → error", errs.has_errors)
check("says must be bool", any("must be" in e.message and "bool" in e.message for e in errs.errors))

errs = type_check("""
setup {
    while 1 {
        log("nope")
    }
}
""")
check("while int → error", errs.has_errors)


# ============================================================
print("\n=== Function Argument Checking ===\n")
# ============================================================

errs = type_check("""
func add(a: int, b: int) -> int {
    return a + b
}
setup {
    let x = add(1, 2)
}
""")
check("correct args", not errs.has_errors, f"{[e.message for e in errs.errors]}")

errs = type_check("""
func add(a: int, b: int) -> int {
    return a + b
}
setup {
    let x = add(1)
}
""")
check("too few args", errs.has_errors)
check("says expects 2", any("expects 2" in e.message for e in errs.errors))

errs = type_check("""
func add(a: int, b: int) -> int {
    return a + b
}
setup {
    let x = add("one", "two")
}
""")
check("wrong arg types", errs.has_errors)


# ============================================================
print("\n=== Method Type Checking ===\n")
# ============================================================

errs = type_check("""
hardware {
    pin led: Output = 2
}
setup {
    led.toggle()
    led.on()
    led.off()
}
""")
check("valid Output methods", not errs.has_errors, f"{[e.message for e in errs.errors]}")

errs = type_check("""
hardware {
    pin led: Output = 2
}
setup {
    led.read()
}
""")
check("Output.read() → error", errs.has_errors)
check("says no method read", any("no method" in e.message and "read" in e.message for e in errs.errors))

errs = type_check("""
hardware {
    pin battery: Analog = 36
}
setup {
    let val = battery.read()
}
""")
check("Analog.read() → int", not errs.has_errors, f"{[e.message for e in errs.errors]}")


# ============================================================
print("\n=== WiFi/MQTT Method Checking ===\n")
# ============================================================

errs = type_check("""
setup {
    wifi.connect("net", "pass")
    mqtt.connect("mqtt://localhost")
    mqtt.send("topic", "data")
    let connected = wifi.is_connected()
}
""")
check("WiFi/MQTT methods", not errs.has_errors, f"{[e.message for e in errs.errors]}")

errs = type_check("""
setup {
    wifi.connect(42, true)
}
""")
check("WiFi wrong arg types", errs.has_errors)


# ============================================================
print("\n=== Return Type Checking ===\n")
# ============================================================

errs = type_check("""
func get_name() -> string {
    return 42
}
""")
check("wrong return type", errs.has_errors)
check("says returns string got int", any("string" in e.message and "int" in e.message for e in errs.errors))


# ============================================================
print("\n=== Mutability ===\n")
# ============================================================

errs = type_check("""
setup {
    let x = 42
    x = 10
}
""")
check("let is immutable", errs.has_errors)
check("says immutable", any("immutable" in e.message or "let" in e.message for e in errs.errors))

errs = type_check("""
setup {
    var x = 42
    x = 10
}
""")
check("var is mutable", not errs.has_errors, f"{[e.message for e in errs.errors]}")


# ============================================================
print("\n=== Duration Type ===\n")
# ============================================================

errs = type_check("""
task t {
    every 500ms {
        log("tick")
    }
}
""")
check("every with duration", not errs.has_errors, f"{[e.message for e in errs.errors]}")

errs = type_check("""
task t {
    every 42 {
        log("tick")
    }
}
""")
check("every with int → error", errs.has_errors)
check("says must be duration", any("duration" in e.message.lower() for e in errs.errors))


# ============================================================
print("\n=== ErrorType Poison (no cascading) ===\n")
# ============================================================

errs = type_check("""
setup {
    let x: int = "hello"
    let y = x + 1
    let z = y * 2
}
""")
check("poison prevents cascade", errs.count == 1,
      f"got {errs.count} errors (expected 1): {[e.message for e in errs.errors]}")


# ============================================================
print("\n=== Storage Type Check ===\n")
# ============================================================

errs = type_check("""
storage count: int = 0
""")
check("storage int = 0", not errs.has_errors, f"{[e.message for e in errs.errors]}")

errs = type_check("""
storage count: int = "hello"
""")
check("storage int = string → error", errs.has_errors)


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}\n")

if failed > 0:
    exit(1)
