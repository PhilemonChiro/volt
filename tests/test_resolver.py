"""Test: resolver catches name errors and handles scoping correctly."""

import sys
import os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from volt.compiler.parser import parse
from volt.compiler.resolver import resolve
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

def resolve_program(source):
    """Parse + resolve, return (scope, errors)."""
    prog = parse(source)
    errors = CompilerErrors()
    errors.set_source(source)
    scope = resolve(prog, errors)
    return scope, errors


# ============================================================
print("\n=== Valid Programs (no errors expected) ===\n")
# ============================================================

scope, errors = resolve_program("""
chip esp32

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
    wifi.connect("net", "pass")
    run(blink)
}
""")
check("no errors", not errors.has_errors, f"got {errors.count} errors")
check("led in scope", scope.lookup("led") is not None)
check("led is pin", scope.lookup("led").kind == "pin")
check("battery in scope", scope.lookup("battery") is not None)
check("add in scope", scope.lookup("add") is not None)
check("add is func", scope.lookup("add").kind == "func")
check("add has params", len(scope.lookup("add").params) == 2)
check("blink in scope", scope.lookup("blink") is not None)
check("wifi is builtin", scope.lookup("wifi") is not None and scope.lookup("wifi").kind == "builtin")
check("run is builtin", scope.lookup("run") is not None)


# ============================================================
print("\n=== Unknown Name ===\n")
# ============================================================

_, errors = resolve_program("""
setup {
    let x = unknown_var
}
""")
check("catches unknown name", errors.has_errors)
check("1 error", errors.count == 1, f"got {errors.count}")
check("error mentions name", "unknown_var" in errors.errors[0].message)


# ============================================================
print("\n=== 'Did You Mean?' Suggestion ===\n")
# ============================================================

_, errors = resolve_program("""
hardware {
    pin led: Output = 2
}
setup {
    lde.toggle()
}
""")
check("catches typo", errors.has_errors)
# "lde" is distance 2 from both "led" and "log" in Levenshtein, so either suggestion is valid
check("has suggestion", errors.errors[0].hint is not None and "Did you mean" in errors.errors[0].hint,
      f"hint was: {errors.errors[0].hint}")


# ============================================================
print("\n=== Duplicate Declaration ===\n")
# ============================================================

_, errors = resolve_program("""
hardware {
    pin led: Output = 2
    pin led: Output = 4
}
""")
check("catches duplicate", errors.has_errors)
check("error mentions already declared", "already declared" in errors.errors[0].message)


# ============================================================
print("\n=== Scope: Function Params ===\n")
# ============================================================

_, errors = resolve_program("""
func process(data: int) -> int {
    return data + 1
}
""")
check("params resolve", not errors.has_errors, f"got {errors.count} errors")


# ============================================================
print("\n=== Scope: Local Variables ===\n")
# ============================================================

_, errors = resolve_program("""
task monitor {
    let count = 0
    every 1second {
        count = count + 1
    }
}
""")
check("local var resolves", not errors.has_errors, f"got {errors.count} errors")


# ============================================================
print("\n=== Scope: For Loop Variable ===\n")
# ============================================================

_, errors = resolve_program("""
setup {
    for i in 0..10 {
        log(i)
    }
}
""")
check("for var resolves", not errors.has_errors, f"got {errors.count} errors")


# ============================================================
print("\n=== Forward Reference (function called before declared) ===\n")
# ============================================================

_, errors = resolve_program("""
task startup {
    init_stuff()
}

func init_stuff() {
    log("done")
}
""")
check("forward ref works", not errors.has_errors, f"got {errors.count} errors")


# ============================================================
print("\n=== Unknown Function ===\n")
# ============================================================

_, errors = resolve_program("""
setup {
    nonexistent_func(42)
}
""")
check("catches unknown func", errors.has_errors)
check("error says unknown function", "Unknown function" in errors.errors[0].message)


# ============================================================
print("\n=== Storage Variable ===\n")
# ============================================================

_, errors = resolve_program("""
storage boot_count: int = 0

setup {
    boot_count = boot_count + 1
}
""")
check("storage resolves", not errors.has_errors, f"got {errors.count} errors")


# ============================================================
print("\n=== State Machine Names ===\n")
# ============================================================

_, errors = resolve_program("""
hardware {
    pin led: Output = 2
    pin button: PullUpInput = 0
}

machine DeviceState {
    state idle {
        on button.press() -> running
    }
    state running {
        every 1second {
            led.toggle()
        }
    }
}
""")
check("machine resolves", not errors.has_errors,
      f"got {errors.count} errors: {[e.message for e in errors.errors]}")


# ============================================================
print("\n=== Multiple Errors (doesn't stop at first) ===\n")
# ============================================================

_, errors = resolve_program("""
setup {
    let x = unknown1
    let y = unknown2
    let z = unknown3
}
""")
check("catches multiple errors", errors.count == 3, f"got {errors.count}")


# ============================================================
print("\n=== Error Formatting ===\n")
# ============================================================

_, errors = resolve_program("""
setup {
    let x = oops
}
""")
report = errors.report("test.volt")
check("report contains filename", "test.volt" in report)
check("report contains line number", ":3" in report)
check("report contains NAME ERROR", "NAME ERROR" in report)
check("report contains oops", "oops" in report)
print("\n  Sample error output:")
for line in report.split('\n')[:8]:
    print(f"    {line}")


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}\n")

if failed > 0:
    exit(1)
