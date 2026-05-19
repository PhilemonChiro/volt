"""
Transformer tests — verify AST rewriting produces correct C.

Tests all 6 transformer passes:
  1. Multi-every splitting
  2. Context struct building (crossing vars)
  3. Yielding function inlining
  4. Yield label assignment
  5. Match desugaring
  6. Setup block extraction
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
    check(name, c is not None and text in c,
          f"'{text}' not found in output")

def c_not(c, text, name):
    check(name, c is not None and text not in c,
          f"'{text}' should NOT be in output")

def compile_ok(source, name="test"):
    c, errs = compile_volt(source, f"{name}.volt")
    errors = [e for e in errs.errors if e.severity == "error"]
    if errors:
        check(name, False, f"Compile errors: {[e.message for e in errors]}")
        return None
    check(name + " compiles", c is not None)
    return c


# ============================================================
print("\n=== PASS 0: Multi-every splitting ===\n")
# ============================================================

c = compile_ok("""
chip esp32
hardware {
    pin led1: Output = 2
    pin led2: Output = 4
}
task blinker {
    every 500ms {
        led1.toggle()
    }
    every 100ms {
        led2.toggle()
    }
}
""", "multi_every")
if c:
    c_has(c, "blinker_run", "first sub-task function")
    c_has(c, "blinker_2_run", "second sub-task function")
    # Both registered in task table
    c_has(c, "blinker_run,", "first in task table")
    c_has(c, "blinker_2_run,", "second in task table")

# Preamble only in first sub-task (not duplicated)
c2 = compile_ok("""
chip esp32
hardware {
    pin led1: Output = 2
    pin led2: Output = 4
}
task worker {
    led1.on()
    every 500ms {
        led1.toggle()
    }
    every 1s {
        led2.toggle()
    }
}
""", "preamble_split")
if c2:
    on_count = c2.count("pin_write(2, HIGH)")
    check("preamble not duplicated", on_count == 1,
          f"led1.on() appeared {on_count} times, expected 1")

# Three concurrent blocks
c3 = compile_ok("""
chip esp32
hardware {
    pin a: Output = 2
    pin b: Output = 4
    pin c: Output = 5
}
task triple {
    every 100ms { a.toggle() }
    every 200ms { b.toggle() }
    every 500ms { c.toggle() }
}
""", "triple_split")
if c3:
    c_has(c3, "triple_run", "first sub-task")
    c_has(c3, "triple_2_run", "second sub-task")
    c_has(c3, "triple_3_run", "third sub-task")

# Single every — no split
c4 = compile_ok("""
chip esp32
hardware { pin led: Output = 2 }
task blink {
    every 500ms { led.toggle() }
}
""", "single_every")
if c4:
    c_has(c4, "blink_run", "single task function")
    c_not(c4, "blink_2_run", "no split for single every")


# ============================================================
print("\n=== PASS 1: Context struct / crossing vars ===\n")
# ============================================================

c = compile_ok("""
chip esp32
hardware { pin led: Output = 2 }
task counter {
    var count: int = 0
    every 1s {
        count = count + 1
        if count > 10 {
            led.on()
        }
    }
}
""", "crossing_var")
if c:
    c_has(c, "counter_ctx_t", "context struct typedef")
    c_has(c, "int32_t count", "count field in struct")
    c_has(c, "ctx->count", "accessing via context pointer")

# Nested var inside if also crosses yield
c2 = compile_ok("""
chip esp32
hardware { pin led: Output = 2 }
task worker {
    var flag: bool = true
    if flag {
        var nested: int = 0
        every 1s {
            nested = nested + 1
            led.toggle()
        }
    }
}
""", "nested_crossing")
if c2:
    c_has(c2, "ctx->nested", "nested var lifted to context")

# No crossing vars — no context struct
c3 = compile_ok("""
chip esp32
hardware { pin led: Output = 2 }
task blink {
    every 500ms {
        led.toggle()
    }
}
""", "no_crossing")
if c3:
    c_not(c3, "blink_ctx_t", "no context struct when no crossing vars")


# ============================================================
print("\n=== PASS 2: Yielding function inlining ===\n")
# ============================================================

# Basic inlining — func with sleep
c = compile_ok("""
chip esp32
hardware { pin led: Output = 2 }
func blink_once() {
    led.on()
    sleep(100ms)
    led.off()
}
task worker {
    every 1s {
        blink_once()
    }
}
""", "basic_inline")
if c:
    c_not(c, "blink_once()", "function call should be inlined, not called")
    # Inlined code should have yield label
    c_has(c, "VOLT_YIELD_LABEL", "inlined sleep has yield label")

# Inlining with parameters — variable renaming
c2 = compile_ok("""
chip esp32
hardware { pin led: Output = 2 }
func delayed_set(val: int) {
    var x: int = val
    sleep(100ms)
    x = x + 1
}
task worker {
    every 1s {
        delayed_set(42)
    }
}
""", "inline_params")
if c2:
    check("parameter renamed with prefix", c2 and "_val = 42" in c2 and "_inl" in c2)
    check("local var renamed with prefix", c2 and "_x = " in c2 and "_inl" in c2)

# Inlining with compound assign
c3 = compile_ok("""
chip esp32
hardware { pin led: Output = 2 }
func inc() {
    var counter: int = 0
    counter += 1
    sleep(50ms)
}
task worker {
    every 500ms { inc() }
}
""", "inline_compound")
if c3:
    check("compound assign renamed during inlining",
          c3 and "_counter += 1" in c3 and "_inl" in c3)
    check("bare counter not leaked",
          c3 and "\n         counter += 1" not in c3)

# Two inlined calls get different prefixes
c4 = compile_ok("""
chip esp32
hardware { pin led: Output = 2 }
func wait_a() {
    var x: int = 1
    sleep(50ms)
}
func wait_b() {
    var x: int = 2
    sleep(100ms)
}
task worker {
    every 1s {
        wait_a()
        wait_b()
    }
}
""", "inline_two_funcs")
if c4:
    c_has(c4, "_inl", "has inlined prefix")
    # Both x variables renamed differently
    check("two funcs have different prefixes",
          c4 and "_inl" in c4 and c4.count("_x =") >= 2)

# Non-yielding function NOT inlined
c5 = compile_ok("""
chip esp32
hardware { pin led: Output = 2 }
func helper(n: int) -> int {
    return n + 1
}
setup {
    var x: int = helper(5)
}
""", "no_inline_non_yield")
if c5:
    c_has(c5, "helper(5)", "non-yielding function called normally")


# ============================================================
print("\n=== PASS 3: Yield label assignment ===\n")
# ============================================================

c = compile_ok("""
chip esp32
hardware { pin led: Output = 2 }
task multi_yield {
    every 500ms {
        led.on()
    }
    sleep(100ms)
}
""", "yield_labels")
if c:
    # Every block gets label 1, sleep gets label 2
    c_has(c, "VOLT_YIELD_LABEL(_vt, 1,", "every block gets label 1")
    c_has(c, "VOLT_YIELD_LABEL(_vt, 2,", "sleep gets label 2")

# Labels are unique per task (reset between tasks)
c2 = compile_ok("""
chip esp32
hardware {
    pin led1: Output = 2
    pin led2: Output = 4
}
task t1 {
    every 500ms { led1.toggle() }
}
task t2 {
    every 1s { led2.toggle() }
}
""", "labels_per_task")
if c2:
    # Both tasks should start labels at 1
    count = c2.count("VOLT_YIELD_LABEL(_vt, 1,")
    check("each task starts label at 1", count == 2,
          f"expected 2 label-1 occurrences, got {count}")


# ============================================================
print("\n=== PASS 4: Match desugaring ===\n")
# ============================================================

c = compile_ok("""
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
""", "match_desugar")
if c:
    # Match desugared to if-else chain
    c_has(c, "if (", "match became if statement")
    # First arm checked first (idle)
    idle_pos = c.find("MODE_IDLE")
    running_pos = c.find("MODE_RUNNING")
    check("match arms in declaration order",
          idle_pos > 0 and running_pos > 0 and idle_pos < running_pos,
          f"idle at {idle_pos}, running at {running_pos}")

# Match with integer patterns
c2 = compile_ok("""
chip esp32
hardware { pin led: Output = 2 }
setup {
    var x: int = 2
    match(x) {
        1 -> led.on()
        2 -> led.off()
        _ -> led.toggle()
    }
}
""", "match_int")
if c2:
    c_has(c2, "== 1", "integer pattern 1")
    c_has(c2, "== 2", "integer pattern 2")


# ============================================================
print("\n=== PASS 5: Setup block extraction ===\n")
# ============================================================

# Top-level every in setup becomes auto-task
c = compile_ok("""
chip esp32
hardware { pin led: Output = 2 }
setup {
    led.on()
    every 500ms {
        led.toggle()
    }
}
""", "setup_every")
if c:
    c_has(c, "_auto_task_", "auto-generated task from setup every")
    c_has(c, "VOLT_YIELD_LABEL", "auto-task has yield points")


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
