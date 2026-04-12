"""Test: concurrency analyzer warns on shared state between tasks."""

import sys
import os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from volt.compiler.parser import parse
from volt.compiler.resolver import resolve
from volt.compiler.checker import check_types
from volt.compiler.hardware import validate_hardware
from volt.compiler.analyzer import analyze
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

def full_analyze(source):
    """Run full pipeline through Pass 5 (analyze)."""
    prog = parse(source)
    errors = CompilerErrors()
    errors.set_source(source)
    scope = resolve(prog, errors)
    if not errors.has_errors:
        check_types(prog, scope, errors)
    if not errors.has_errors:
        validate_hardware(prog, scope, errors)
    analyze(prog, scope, errors)
    return prog, errors

def has_error(errors, text):
    return any(text.lower() in e.message.lower() for e in errors.errors if e.severity == "error")

def has_warning(errors, text):
    return any(text.lower() in e.message.lower() for e in errors.errors if e.severity == "warning")

def has_category_warning(errors, category):
    return any(category.lower() in e.category.lower() for e in errors.errors if e.severity == "warning")

def has_category_error(errors, category):
    return any(category.lower() in e.category.lower() for e in errors.errors if e.severity == "error")

def concurrency_warnings(errors):
    return [e for e in errors.errors if "concurrency" in e.category.lower() and e.severity == "warning"]

def concurrency_errors(errors):
    return [e for e in errors.errors if "concurrency" in e.category.lower() and e.severity == "error"]


# ============================================================
print("\n=== Test 1: Critical + Background sharing a var (should warn, not error) ===\n")
# ============================================================

# shared_counter is a global var. writer runs in a critical task (strict),
# reader runs in a background task (every without strict). This crosses tiers —
# the analyzer must emit a CONCURRENCY warning (not error) because the codegen
# handles it by marking the variable volatile.
prog, errs = full_analyze("""
chip esp32

hardware {
    pin led: Output = 2
    pin motor: PWM = 4
}

var shared_counter = 0

task fast_control {
    every 1ms strict {
        motor.set_pwm(shared_counter)
    }
}

task slow_monitor {
    every 500ms {
        shared_counter = shared_counter + 1
        led.toggle()
    }
}

setup {
    run(fast_control, slow_monitor)
}
""")

warns = concurrency_warnings(errs)
errs_c = concurrency_errors(errs)

check(
    "critical+background sharing var produces a CONCURRENCY warning",
    len(warns) > 0 and any("shared_counter" in w.message for w in warns),
    f"warnings: {[w.message for w in warns]}",
)
check(
    "critical+background sharing var is NOT a CONCURRENCY error",
    len(errs_c) == 0,
    f"errors: {[e.message for e in errs_c]}",
)
check(
    "warning mentions 'volatile' (codegen will handle it)",
    any("volatile" in w.message.lower() for w in warns),
    f"warnings: {[w.message for w in warns]}",
)


# ============================================================
print("\n=== Test 2: Two background tasks sharing a var (multiple-writer warning) ===\n")
# ============================================================

# counter is written by both task_a and task_b. Neither is critical, but
# multiple writers to the same global is still dangerous — the analyzer should
# warn about the multiple-writer race.
prog, errs = full_analyze("""
chip esp32

hardware {
    pin led: Output = 2
    pin button: PullUpInput = 0
}

var counter = 0

task task_a {
    every 200ms {
        counter = counter + 1
        led.toggle()
    }
}

task task_b {
    every 300ms {
        counter = counter + 2
    }
}

setup {
    run(task_a, task_b)
}
""")

warns = concurrency_warnings(errs)
all_warns = [e for e in errs.errors if e.severity == "warning"]

check(
    "two background tasks writing same var produces a warning",
    any("counter" in w.message for w in warns),
    f"concurrency warnings: {[w.message for w in warns]}, all warnings: {[w.message for w in all_warns]}",
)
check(
    "multiple-writer warning is not an error",
    not has_category_error(errs, "concurrency"),
    f"errors: {[e.message for e in errs.errors if e.severity == 'error']}",
)


# ============================================================
print("\n=== Test 3: Single task using a var — no concurrency warning ===\n")
# ============================================================

# sole_var is only touched by one task. No sharing means no race — the
# analyzer must stay silent on concurrency.
prog, errs = full_analyze("""
chip esp32

hardware {
    pin led: Output = 2
}

var sole_var = 42

task solo {
    every 1second {
        sole_var = sole_var + 1
        led.toggle()
    }
}

setup {
    run(solo)
}
""")

warns = concurrency_warnings(errs)

check(
    "single task using a var produces no concurrency warning",
    len(warns) == 0,
    f"unexpected concurrency warnings: {[w.message for w in warns]}",
)


# ============================================================
print("\n=== Test 4: Critical task using a var alone — no concurrency warning ===\n")
# ============================================================

# A variable used only inside a critical (strict) task has no cross-task
# sharing, so there is no race. Volatile is a codegen detail, not an
# analyzer warning.
prog, errs = full_analyze("""
chip esp32

hardware {
    pin motor: PWM = 4
}

var pwm_setpoint = 0

task pid_loop {
    every 1ms strict {
        motor.set_pwm(pwm_setpoint)
    }
}

setup {
    run(pid_loop)
}
""")

warns = concurrency_warnings(errs)

check(
    "critical task using a var alone produces no concurrency warning",
    len(warns) == 0,
    f"unexpected concurrency warnings: {[w.message for w in warns]}",
)


# ============================================================
print("\n=== Test 5: Read-only sharing across tiers — should NOT warn ===\n")
# ============================================================

# read_only_cfg is a global that both tasks only READ — neither writes it.
# A shared read is always safe, so the analyzer must not warn about it.
prog, errs = full_analyze("""
chip esp32

hardware {
    pin led: Output = 2
    pin motor: PWM = 4
}

var read_only_cfg = 100

task critical_reader {
    every 1ms strict {
        motor.set_pwm(read_only_cfg)
    }
}

task background_reader {
    every 500ms {
        led.toggle()
    }
}

setup {
    run(critical_reader, background_reader)
}
""")

warns = concurrency_warnings(errs)
cfg_warns = [w for w in warns if "read_only_cfg" in w.message]

check(
    "read-only global shared across tiers produces no concurrency warning",
    len(cfg_warns) == 0,
    f"unexpected concurrency warnings: {[w.message for w in cfg_warns]}",
)


# ============================================================
print("\n=== Test 6: Multiple vars, mixed sharing patterns ===\n")
# ============================================================

# Three globals:
#   - mixed_val:    written by critical task, read by background task → CONCURRENCY warning
#   - private_a:   only used by task_a → no warning
#   - private_b:   only used by task_b → no warning
#
# The analyzer must warn about mixed_val but stay silent about private_a and private_b.
prog, errs = full_analyze("""
chip esp32

hardware {
    pin led: Output = 2
    pin motor: PWM = 4
}

var mixed_val = 0
var private_a = 10
var private_b = 20

task isr_task {
    every 1ms strict {
        motor.set_pwm(mixed_val)
        private_a = private_a + 1
    }
}

task bg_task {
    every 500ms {
        mixed_val = mixed_val + 1
        private_b = private_b + 1
        led.toggle()
    }
}

setup {
    run(isr_task, bg_task)
}
""")

warns = concurrency_warnings(errs)
mixed_warns = [w for w in warns if "mixed_val" in w.message]
private_a_warns = [w for w in warns if "private_a" in w.message]
private_b_warns = [w for w in warns if "private_b" in w.message]

check(
    "mixed_val (cross-tier) produces a CONCURRENCY warning",
    len(mixed_warns) > 0,
    f"concurrency warnings: {[w.message for w in warns]}",
)
check(
    "private_a (single-task) produces no concurrency warning",
    len(private_a_warns) == 0,
    f"unexpected warnings about private_a: {[w.message for w in private_a_warns]}",
)
check(
    "private_b (single-task) produces no concurrency warning",
    len(private_b_warns) == 0,
    f"unexpected warnings about private_b: {[w.message for w in private_b_warns]}",
)
check(
    "mixed sharing: mixed_val warned, private vars silent",
    len(mixed_warns) > 0 and len(private_a_warns) == 0 and len(private_b_warns) == 0,
    f"all concurrency warnings: {[w.message for w in warns]}",
)


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}\n")

if failed > 0:
    exit(1)
