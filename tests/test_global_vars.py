"""
Global variable codegen tests: module-level var/let → static C globals.

Tests:
  - Basic var emission (static int32_t)
  - Immutable let (static, no volatile)
  - volatile when shared across tiers
  - no volatile for single-tier access
  - volatile for any critical task access
  - multiple mixed global vars
  - detection via nested if/while/for blocks
  - detection via complex expressions (x + y * z)
  - detection via assignment target (x = x + 1)
  - no global vars → no "Module-level variables" section
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


def compile_ok(name, source):
    """Compile and expect success. Returns C code."""
    c_code, errors = compile_volt(source, f"{name}.volt")
    if errors.has_errors:
        err_msgs = [e.message for e in errors.errors if e.severity == "error"]
        check(name, False, f"expected success but got errors: {err_msgs}")
        return None
    check(name, c_code is not None, "c_code is None")
    return c_code


def c_contains(c_code, text, name):
    """Check generated C contains expected text."""
    if c_code is None:
        check(name, False, "no C code generated")
        return
    check(name, text in c_code, f"'{text}' not found in generated C")


def c_not_contains(c_code, text, name):
    """Check generated C does NOT contain text."""
    if c_code is None:
        check(name, False, "no C code generated")
        return
    check(name, text not in c_code, f"'{text}' unexpectedly found in generated C")


# ============================================================
print("\n=== BASIC GLOBAL VAR EMISSION ===\n")
# ============================================================

# Test 1: var x: int = 42 → static int32_t x = 42;
c = compile_ok("basic var int", """
var x: int = 42
setup {
}
""")
c_contains(c, "static int32_t x = 42;", "var int emitted as static int32_t")
c_contains(c, "// Module-level variables", "module-level section header present")

# Test 2: var f: float = 3.14 → static float f = 3.14f;
c = compile_ok("basic var float", """
var f: float = 3.14
setup {
}
""")
c_contains(c, "static float f = 3.14f;", "var float emitted as static float")

# Test 3: var b: bool = true → static bool b = true;
c = compile_ok("basic var bool", """
var b: bool = true
setup {
}
""")
c_contains(c, "static bool b = true;", "var bool emitted as static bool")


# ============================================================
print("\n=== IMMUTABLE LET — NO VOLATILE ===\n")
# ============================================================

# Test 4: let is immutable — emitted as static, never volatile
c = compile_ok("let immutable", """
let x: int = 10
setup {
}
""")
c_contains(c, "static int32_t x = 10;", "let emitted as static int32_t")
c_not_contains(c, "volatile", "let is never volatile (immutable)")


# ============================================================
print("\n=== VOLATILE WHEN SHARED ACROSS TIERS ===\n")
# ============================================================

# Test 5: var used in a strict task (critical) AND a normal task → volatile
c = compile_ok("volatile shared across tiers", """
var counter: int = 0
task slow_task {
    every 1seconds {
        counter = counter + 1
    }
}
task fast_task {
    every 1ms strict {
        counter = counter + 1
    }
}
setup {
    run(slow_task, fast_task)
}
""")
c_contains(c, "static _Atomic int32_t counter", "counter is volatile (shared across tiers)")


# ============================================================
print("\n=== NO VOLATILE FOR SINGLE-TIER ===\n")
# ============================================================

# Test 6: var used only in one background task → not volatile
c = compile_ok("no volatile single tier", """
var ticks: int = 0
task ticker {
    every 500ms {
        ticks = ticks + 1
    }
}
setup {
    run(ticker)
}
""")
c_contains(c, "static int32_t ticks", "ticks is static (single tier — no volatile needed)")
c_not_contains(c, "volatile int32_t ticks", "ticks is not volatile (single tier)")


# ============================================================
print("\n=== VOLATILE FOR CRITICAL TASK ACCESS ===\n")
# ============================================================

# Test 7: var only in a critical task → volatile (even single tier)
c = compile_ok("volatile critical only", """
var isr_count: int = 0
task isr_task {
    every 1ms strict {
        isr_count = isr_count + 1
    }
}
setup {
    run(isr_task)
}
""")
c_contains(c, "static _Atomic int32_t isr_count", "isr_count is volatile (critical task)")


# ============================================================
print("\n=== MULTIPLE GLOBAL VARS — MIXED ===\n")
# ============================================================

# Test 8: mix of let/var, shared/unshared — each gets correct qualifiers
c = compile_ok("multiple global vars mixed", """
let max_speed: int = 100
var speed: int = 0
var shared_flag: int = 0
task control {
    every 1ms strict {
        shared_flag = 1
    }
}
task monitor {
    every 500ms {
        speed = shared_flag + max_speed
    }
}
setup {
    run(control, monitor)
}
""")
c_contains(c, "static int32_t max_speed = 100;", "let max_speed is non-volatile static")
c_not_contains(c, "volatile int32_t max_speed", "let max_speed cannot be volatile")
c_contains(c, "static _Atomic int32_t shared_flag", "shared_flag used in critical+background → volatile")
# speed is only in background task monitor, not volatile
c_contains(c, "static int32_t speed", "speed is in single tier — no volatile")
c_not_contains(c, "volatile int32_t speed", "speed is not volatile")


# ============================================================
print("\n=== DETECTION VIA NESTED CONTROL FLOW ===\n")
# ============================================================

# Test 9: global var inside nested if/while inside task body → still detected
c = compile_ok("global var in nested if while", """
var depth: int = 0
task deep {
    every 100ms {
        if depth > 0 {
            while depth > 0 {
                depth = depth - 1
            }
        }
    }
}
task isr {
    every 1ms strict {
        depth = depth + 1
    }
}
setup {
    run(deep, isr)
}
""")
c_contains(c, "static _Atomic int32_t depth", "depth detected through nested if/while → volatile")


# ============================================================
print("\n=== DETECTION VIA COMPLEX EXPRESSIONS ===\n")
# ============================================================

# Test 10: x + y * z — all three should be detected as refs in the same task
c = compile_ok("global var in expression x plus y times z", """
var x: int = 1
var y: int = 2
var z: int = 3
task expr_task {
    every 1ms strict {
        x = x + y * z
    }
}
setup {
    run(expr_task)
}
""")
# All three used only in critical tier → all volatile
c_contains(c, "static _Atomic int32_t x", "x detected in expression → volatile")
c_contains(c, "static _Atomic int32_t y", "y detected in expression → volatile")
c_contains(c, "static _Atomic int32_t z", "z detected in expression → volatile")


# ============================================================
print("\n=== DETECTION VIA ASSIGNMENT TARGET ===\n")
# ============================================================

# Test 11: x = x + 1 → x detected as both target and rhs ref
c = compile_ok("global var via assignment", """
var x: int = 0
task bg {
    every 500ms {
        x = x + 1
    }
}
task isr {
    every 1ms strict {
        x = 0
    }
}
setup {
    run(bg, isr)
}
""")
c_contains(c, "static _Atomic int32_t x", "x detected as assignment target + rhs → volatile")


# ============================================================
print("\n=== EDGE: NO GLOBAL VARS ===\n")
# ============================================================

# Test 12: program with no module-level vars → no section header emitted
c = compile_ok("no global vars no section", """
setup {
    let local = 5
}
""")
c_not_contains(c, "// Module-level variables", "no global vars → no section header")


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}\n")

if failed > 0:
    exit(1)
