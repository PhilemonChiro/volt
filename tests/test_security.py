"""
Security tests — verifies the compiler rejects dangerous inputs.
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

def compile_ok(name, source):
    c_code, errors = compile_volt(source, f"{name}.volt")
    if errors.has_errors:
        err_msgs = [e.message for e in errors.errors if e.severity == "error"]
        check(name, False, f"errors: {err_msgs}")
        return None
    check(name, c_code is not None)
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
print("\n=== Channel Capacity Limits ===\n")
# ============================================================

compile_fail("channel_too_large", """
chip esp32
channel data: int[9999]
task t {
    every 1s {
        data.send(1)
    }
}
""", "exceeds maximum")

compile_fail("channel_zero", """
chip esp32
channel data: int[0]
task t {
    every 1s {
        data.send(1)
    }
}
""", "at least 1")

c = compile_ok("channel_max_ok", """
chip esp32
channel data: int[1024]
task t {
    every 1s {
        data.send(1)
    }
}
""")
c_has(c, "_ch_data_t", "max capacity compiles")

c = compile_ok("channel_small", """
chip esp32
channel data: int[4]
task t {
    every 1s {
        data.send(1)
    }
}
""")
c_has(c, "uint8_t", "small channel uses uint8_t index")

c = compile_ok("channel_medium", """
chip esp32
channel data: int[512]
task t {
    every 1s {
        data.send(1)
    }
}
""")
c_has(c, "uint16_t", "medium channel uses uint16_t index")


# ============================================================
print("\n=== Include Path Security ===\n")
# ============================================================

compile_fail("include_absolute", """
chip esp32
include "/etc/passwd"
setup {
    log("x", "y")
}
""", "absolute")

compile_fail("include_traversal", """
chip esp32
include "../../../etc/hostname"
setup {
    log("x", "y")
}
""", "escapes project")


# ============================================================
print("\n=== String Safety ===\n")
# ============================================================

c = compile_ok("string_with_quotes", '''
chip esp32
setup {
    log("test", "hello \\"world\\"")
}
''')
# Backslash-quotes should pass through safely
c_has(c, 'hello \\"world\\"', "escaped quotes preserved")

c = compile_ok("string_normal", """
chip esp32
setup {
    log("tag", "hello world")
}
""")
c_has(c, '"hello world"', "normal string")


# ============================================================
print("\n=== Adversarial Inputs ===\n")
# ============================================================

# Empty source should not crash
c = compile_ok("empty_source", "")

# Whitespace only
c = compile_ok("whitespace_only", "   \n\n\n   \n")

# Very long variable name (not a security issue, but robustness)
c = compile_ok("long_var_name", """
chip esp32
setup {
    var abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz: int = 42
}
""")

# Deeply nested parens — should compile or fail gracefully, never crash
c_code, errors = compile_volt("chip esp32\nsetup {\n    var x: int = " + "(" * 200 + "1" + ")" * 200 + "\n}\n", "deep.volt")
check("deep_nesting_no_crash", True, "didn't crash")  # reaching here = no exception


# ============================================================
print("\n=== FORMAT STRING SAFETY ===\n")
# ============================================================

# log() with string variable must use %s, never pass variable as format string
c_code, errors = compile_volt("""
chip esp32
hardware { pin led = 2 }
task main {
    var msg: string = "hello %x %x"
    log("app", msg)
}
""", "fmt_safe.volt")
check("log_uses_safe_format", c_code and '%s"' in c_code,
      "log() must generate format-safe log_info(tag, \"%s\", msg)")
check("log_no_bare_variable_format",
      c_code and 'log_info("app", msg)' not in c_code,
      "must not pass variable directly as format string")

# log() with one arg — tag only, safe
c_code2, _ = compile_volt("""
chip esp32
hardware { pin led = 2 }
task main { log("hello") }
""", "log_one.volt")
check("log_one_arg_safe", c_code2 and 'log_info("hello", "%s", "")' in c_code2,
      "single-arg log must use safe format")

# log() with two string literals — still safe
c_code3, _ = compile_volt("""
chip esp32
hardware { pin led = 2 }
task main { log("tag", "message with %d") }
""", "log_two.volt")
check("log_two_args_safe", c_code3 and '"%s"' in c_code3,
      "two-arg log must still use %s wrapper")


# ============================================================
print("\n=== YIELD DETECTION: sleep() or skip ===\n")
# ============================================================

# sleep() wrapped in OrExpr should still be detected as a yield point
c_code4, errors4 = compile_volt("""
chip esp32
hardware { pin led = 2 }
task worker {
    every 1s {
        led.toggle()
    }
    sleep(500ms) or skip
}
""", "yield_or.volt")
# Should NOT get a "no yield points" warning
warnings = [e for e in errors4.errors if "no yield" in e.message.lower()]
check("sleep_or_skip_detected_as_yield", len(warnings) == 0,
      "sleep() or skip should be detected as yield point")


# ============================================================
# Summary
# ============================================================

print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
