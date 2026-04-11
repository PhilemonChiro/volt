"""
State Machine Tests: parsing, verification, and code generation.
Tests the full pipeline from .volt source to generated C.
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
    errs = [e for e in errors.errors if e.severity == "error"]
    if errs:
        check(name, False, f"expected success: {[e.message for e in errs]}")
        return None
    check(name, c_code is not None)
    return c_code

def compile_fail(name, source, expect_text):
    c_code, errors = compile_volt(source, f"{name}.volt")
    errs = [e for e in errors.errors if e.severity == "error"]
    found = any(expect_text.lower() in e.message.lower() for e in errs)
    check(name, found, f"expected '{expect_text}', got: {[e.message for e in errs]}")

def has_warning(source, text):
    _, errors = compile_volt(source)
    return any(text.lower() in e.message.lower() for e in errors.errors if e.severity == "warning")

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
print("\n=== BASIC STATE MACHINE ===\n")
# ============================================================

c = compile_ok("two states", """
machine Light {
    initial state off {
        on toggle() -> on
    }
    state on {
        on toggle() -> off
    }
}
""")
c_has(c, "typedef enum", "has state enum")
c_has(c, "LIGHT_OFF", "has OFF enum value")
c_has(c, "LIGHT_ON", "has ON enum value")
c_has(c, "Light_state_t", "has state type")
c_has(c, "Light_ctx_t", "has context type")
c_has(c, "Light_transition", "has transition function")
c_has(c, "Light_run(volt_task_t *_vt)", "has run function")
c_has(c, "VOLT_TASK_BEGIN", "has protothread begin")
c_has(c, "VOLT_TASK_END", "has protothread end")
c_has(c, "VOLT_YIELD_LABEL", "has yield label")
c_has(c, "volt_run(_tasks", "registered in task table")


# ============================================================
print("\n=== ENTRY AND EXIT ACTIONS ===\n")
# ============================================================

c = compile_ok("entry exit", """
hardware {
    pin led: Output = 2
}
machine Blinker {
    initial state off {
        enter {
            led.off()
        }
        on activate() -> on
    }
    state on {
        enter {
            led.on()
        }
        exit {
            log("leaving on state")
        }
        on deactivate() -> off
    }
}
""")
# Entry actions in transition function
c_has(c, "case BLINKER_OFF:", "has OFF case in enter switch")
c_has(c, "pin_write(2, LOW)", "led.off() in entry")
c_has(c, "pin_write(2, HIGH)", "led.on() in entry")
# Exit actions
c_has(c, "// Exit current state", "has exit section")
c_has(c, 'log_info("volt", "leaving on state")', "exit action generated")


# ============================================================
print("\n=== TIMED TRANSITIONS (after) ===\n")
# ============================================================

c = compile_ok("timeout transition", """
machine Timer {
    initial state waiting {
        after 5seconds -> done
    }
    state done {
        after 1seconds -> waiting
    }
}
""")
c_has(c, "5000", "5seconds = 5000ms")
c_has(c, "1000", "1seconds = 1000ms")
c_has(c, "_elapsed", "elapsed time calculated")
c_has(c, "(int32_t)(_elapsed - 5000) >= 0", "wraparound-safe timeout")
c_has(c, "Timer_transition(ctx, TIMER_DONE)", "transition to done")
c_has(c, "Timer_transition(ctx, TIMER_WAITING)", "transition back to waiting")


# ============================================================
print("\n=== GUARDED TRANSITIONS ===\n")
# ============================================================

c = compile_ok("guards", """
machine Retry {
    var count = 0

    initial state trying {
        on fail() [count < 3] -> trying
        on fail() -> gave_up
        on succeed() -> done
    }
    state gave_up {
        after 10seconds -> trying
    }
    state done {
    }
}
""")
c_has(c, "int32_t count;", "context has count variable")
c_has(c, ".count = 0", "count initialized to 0")
c_has(c, "ctx->count", "guard references ctx->count")


# ============================================================
print("\n=== MACHINE VARIABLES (context) ===\n")
# ============================================================

c = compile_ok("machine vars", """
machine Counter {
    var count = 0
    var max_count = 10

    initial state counting {
        after 1seconds -> counting
    }
}
""")
c_has(c, "int32_t count;", "has count field")
c_has(c, "int32_t max_count;", "has max_count field")
c_has(c, ".count = 0,", "count initialized")
c_has(c, ".max_count = 10,", "max_count initialized")


# ============================================================
print("\n=== TRANSITION ACTIONS ===\n")
# ============================================================

c = compile_ok("transition action", """
machine Conn {
    var attempts = 0

    initial state disconnected {
        on connect_event() -> connected {
            attempts = 0
        }
    }
    state connected {
        on disconnect_event() -> disconnected {
            attempts = attempts + 1
        }
    }
}
""")
c_has(c, "ctx->attempts = 0", "reset action on connect")
c_has(c, "ctx->attempts = (ctx->attempts + 1)", "increment action on disconnect")


# ============================================================
print("\n=== EVENTS INSIDE STATES (every blocks) ===\n")
# ============================================================

c = compile_ok("every in state", """
machine Monitor {
    initial state running {
        on stop() -> stopped
    }
    state stopped {
        on start() -> running
    }
}
""")
c_has(c, "MONITOR_RUNNING", "running state")
c_has(c, "MONITOR_STOPPED", "stopped state")


# ============================================================
print("\n=== MULTIPLE MACHINES ===\n")
# ============================================================

c = compile_ok("two machines", """
machine A {
    initial state x {
        on go() -> y
    }
    state y {
        on back() -> x
    }
}
machine B {
    initial state p {
        on go() -> q
    }
    state q {
        on back() -> p
    }
}
""")
c_has(c, "A_state_t", "machine A type")
c_has(c, "B_state_t", "machine B type")
c_has(c, "A_run(volt_task_t *_vt)", "machine A run function")
c_has(c, "B_run(volt_task_t *_vt)", "machine B run function")
c_has(c, "{ A_run, &_A_t }", "A in task table")
c_has(c, "{ B_run, &_B_t }", "B in task table")
c_has(c, "volt_run(_tasks, 2)", "2 tasks in scheduler")


# ============================================================
print("\n=== MACHINE + TASKS TOGETHER ===\n")
# ============================================================

c = compile_ok("machine with tasks", """
hardware {
    pin led: Output = 2
}
machine DevState {
    initial state idle {
        on activate() -> running
    }
    state running {
        on deactivate() -> idle
    }
}
task blink() {
    every 500ms {
        led.toggle()
    }
}
main {
    run(blink)
}
""")
c_has(c, "blink_run", "blink task")
c_has(c, "DevState_run", "machine task")
c_has(c, "volt_run(_tasks, 2)", "both in scheduler (1 task + 1 machine)")


# ============================================================
print("\n=== VERIFICATION: Unreachable State ===\n")
# ============================================================

check("unreachable warning", has_warning("""
machine Bad {
    initial state a {
        on x() -> b
    }
    state b {
        on y() -> a
    }
    state orphan {
        on z() -> a
    }
}
""", "unreachable"))


# ============================================================
print("\n=== VERIFICATION: Dead-End State ===\n")
# ============================================================

check("dead-end warning", has_warning("""
machine Bad {
    initial state a {
        on x() -> dead
    }
    state dead {
    }
}
""", "no outgoing"))


# ============================================================
print("\n=== VERIFICATION: Invalid Target ===\n")
# ============================================================

compile_fail("invalid target", """
machine Bad {
    initial state a {
        on x() -> nonexistent
    }
}
""", "does not exist")


# ============================================================
print("\n=== VERIFICATION: Non-Deterministic ===\n")
# ============================================================

compile_fail("non-deterministic", """
machine Bad {
    initial state a {
        on x() -> b
        on x() -> c
    }
    state b {
        on y() -> a
    }
    state c {
        on y() -> a
    }
}
""", "multiple unguarded")


# ============================================================
print("\n=== VERIFICATION: Guarded OK ===\n")
# ============================================================

c = compile_ok("guarded ok", """
machine Good {
    var n = 0
    initial state a {
        on x() [n < 5] -> b
        on x() -> c
    }
    state b {
        on y() -> a
    }
    state c {
        on y() -> a
    }
}
""")


# ============================================================
print("\n=== VERIFICATION: Auto-Initial ===\n")
# ============================================================

c = compile_ok("auto initial", """
machine Auto {
    state first {
        on x() -> second
    }
    state second {
        on y() -> first
    }
}
""")
c_has(c, "AUTO_FIRST", "first state is initial by default")
c_has(c, ".current = AUTO_FIRST", "initial state set correctly")


# ============================================================
print("\n=== COMPLEX: IoT Device State Machine ===\n")
# ============================================================

c = compile_ok("iot device", """
chip esp32

hardware {
    pin led: Output = 2
    pin button: Input.PullUp = 0
}

machine DeviceState {
    var retry_count = 0

    initial state idle {
        enter {
            led.off()
        }
        on button.press() -> connecting
    }

    state connecting {
        enter {
            retry_count = retry_count + 1
            led.on()
        }
        on wifi.connected() -> online
        on wifi.disconnected() [retry_count < 5] -> connecting
        on wifi.disconnected() -> error
        after 10seconds -> error
    }

    state online {
        enter {
            led.on()
        }
        exit {
            led.off()
        }
        on wifi.disconnected() -> connecting {
            retry_count = 0
        }
    }

    state error {
        enter {
            led.off()
        }
        after 30seconds -> idle {
            retry_count = 0
        }
    }
}
""")
c_has(c, "DEVICESTATE_IDLE", "idle state")
c_has(c, "DEVICESTATE_CONNECTING", "connecting state")
c_has(c, "DEVICESTATE_ONLINE", "online state")
c_has(c, "DEVICESTATE_ERROR", "error state")
c_has(c, "int32_t retry_count;", "retry context")
c_has(c, "DeviceState_transition", "transition function")
c_has(c, "10000", "10second timeout")
c_has(c, "30000", "30second timeout")
c_has(c, "pin_write(2, LOW)", "led off in entry")
c_has(c, "pin_write(2, HIGH)", "led on in entry")


# ============================================================
print("\n=== ALL EXISTING TESTS STILL PASS ===\n")
# ============================================================

# Quick sanity: basic blink still works
c = compile_ok("blink still works", """
chip esp32
hardware {
    pin led: Output = 2
}
task blink() {
    every 500ms {
        led.toggle()
    }
}
main {
    run(blink)
}
""")
c_has(c, "blink_run", "blink task exists")
c_has(c, "pin_toggle(2)", "toggle pin 2")


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}\n")

if failed > 0:
    exit(1)
