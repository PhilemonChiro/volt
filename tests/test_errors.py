"""
Round 22 — error quality tests. Verifies the compiler catches
common developer mistakes with clear, helpful error messages.
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

def compile_warns(name, source, expect_text):
    c_code, errors = compile_volt(source, f"{name}.volt")
    warnings = [e for e in errors.errors if e.severity == "warning"]
    found = any(expect_text.lower() in w.message.lower() for w in warnings)
    check(name, found, f"expected warning '{expect_text}', got: {[w.message for w in warnings]}")

def c_has(c, text, name):
    if c is None:
        check(name, False, "no C code")
        return
    check(name, text in c, f"'{text}' not found")


# ============================================================
print("\n=== Assignment Validation ===\n")
# ============================================================

compile_fail("assign_to_literal", """
chip esp32
setup {
    42 = 10
}
""", "variable")

compile_fail("assign_to_let", """
chip esp32
setup {
    let x: int = 5
    x = 10
}
""", "immutable")

c = compile_ok("assign_to_var", """
chip esp32
setup {
    var x: int = 5
    x = 10
}
""")
c_has(c, "x = 10", "var assignment works")


# ============================================================
print("\n=== Duplicate Declarations ===\n")
# ============================================================

compile_fail("duplicate_var", """
chip esp32
setup {
    var x: int = 0
    var x: int = 1
}
""", "already declared")

compile_fail("duplicate_pin", """
chip esp32
hardware {
    pin led: Output = 2
    pin btn: Output = 2
}
setup {
    led.on()
}
""", "already used")


# ============================================================
print("\n=== Multiple Chip Declarations ===\n")
# ============================================================

compile_fail("multi_chip", """
chip esp32
chip rp2040
setup {
    log("test", "hello")
}
""")


# ============================================================
print("\n=== Missing Return Warning ===\n")
# ============================================================

compile_warns("missing_return", """
chip esp32
func add(a: int, b: int) -> int {
    var c: int = a + b
}
setup {
    var x: int = add(1, 2)
}
""", "may not return")

# Function WITH return should NOT warn
c = compile_ok("has_return", """
chip esp32
func add(a: int, b: int) -> int {
    return a + b
}
setup {
    var x: int = add(1, 2)
}
""")
c_has(c, "return (a + b)", "return compiles")

# Void function should NOT warn
c = compile_ok("void_no_return", """
chip esp32
func greet() {
    log("hello", "world")
}
setup {
    greet()
}
""")


# ============================================================
print("\n=== Method Errors ===\n")
# ============================================================

compile_fail("wrong_pin_method", """
chip esp32
hardware {
    pin led: Output = 2
}
setup {
    led.read()
}
""", "no method")

compile_fail("wrong_arg_count", """
chip esp32
hardware {
    pin led: Output = 2
}
setup {
    led.write(1, 2, 3)
}
""", "expects 1 argument")

compile_fail("no_such_builtin", """
chip esp32
setup {
    system.nonexistent()
}
""", "no method")


# ============================================================
print("\n=== Type Errors ===\n")
# ============================================================

c = compile_ok("string_plus_bool", """
chip esp32
setup {
    var x = "hello" + true
}
""")
# String + bool is valid (string concat handles booleans)

compile_fail("int_and_string", """
chip esp32
setup {
    if 42 {
        log("x", "y")
    }
}
""", "bool")

compile_fail("wrong_type_assign", """
chip esp32
setup {
    var x: int = "hello"
}
""", "declared as")


# ============================================================
print("\n=== Break/Continue Validation ===\n")
# ============================================================

compile_fail("break_outside_loop", """
chip esp32
setup {
    break
}
""", "loop")

compile_fail("continue_outside_loop", """
chip esp32
setup {
    continue
}
""", "loop")

c = compile_ok("break_inside_for", """
chip esp32
setup {
    for i in 0..10 {
        if i == 5 { break }
    }
}
""")
c_has(c, "break", "break inside for works")

c = compile_ok("continue_inside_while", """
chip esp32
setup {
    var i: int = 0
    while i < 10 {
        i = i + 1
        if i == 5 { continue }
    }
}
""")
c_has(c, "continue", "continue inside while works")


# ============================================================
print("\n=== For Step Type Check ===\n")
# ============================================================

compile_fail("float_step", """
chip esp32
setup {
    for i in 0..10 step 1.5 {
        log("x", "y")
    }
}
""", "step must be `int`")

c = compile_ok("int_step", """
chip esp32
setup {
    for i in 0..100 step 10 {
        log("x", "y")
    }
}
""")
c_has(c, "+= 10", "int step works")


# ============================================================
print("\n=== Hardware Pin Validation ===\n")
# ============================================================

compile_fail("pin_999", """
chip esp32
hardware {
    pin led: Output = 999
}
setup {
    led.on()
}
""", "does not exist")

compile_fail("flash_pin", """
chip esp32
hardware {
    pin x: Output = 6
}
setup {
    x.on()
}
""", "flash")


# ============================================================
print("\n=== Undeclared Variables ===\n")
# ============================================================

compile_fail("undeclared_read", """
chip esp32
setup {
    var y: int = x + 1
}
""", "unknown")

compile_fail("undeclared_assign", """
chip esp32
setup {
    z = 42
}
""", "unknown")


# ============================================================
print("\n=== Duration Comparisons ===\n")
# ============================================================

c = compile_ok("duration_lte", """
chip esp32
setup {
    var t: Duration = 500ms
    if t <= 1s {
        log("ok", "yes")
    }
}
""")

c = compile_ok("duration_gte", """
chip esp32
setup {
    var t: Duration = 2s
    if t >= 1s {
        log("ok", "yes")
    }
}
""")


# ============================================================
# Summary
# ============================================================

print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
