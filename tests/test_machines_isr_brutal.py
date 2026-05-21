"""Round 41 — State machines + critical-task ISR safety.

State-machine probes:
  - Dangling transition target
  - Single-state machine (no transitions)
  - State with no enter and no transitions

Critical-task (ISR) probes — critical tasks run from a hardware timer
interrupt context. They MUST NOT call blocking operations:
  - sleep(), volt_delay, wifi.connect, mqtt.publish
  - log() with formatting (printf in an ISR is dangerous)
  - Large local arrays (ISR stacks are small)
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent))

from test_drivers_brutal import compile_to_c  # noqa: E402


def msgs(errors_obj):
    return [(getattr(e, "severity", "error"), e.message) for e in errors_obj.errors]


def has_error(errors_obj, substring):
    return any(
        getattr(e, "severity", "error") == "error" and substring.lower() in e.message.lower()
        for e in errors_obj.errors
    )


def has_warning(errors_obj, substring):
    return any(
        getattr(e, "severity", "error") == "warning" and substring.lower() in e.message.lower()
        for e in errors_obj.errors
    )


class StateMachineEdges(unittest.TestCase):

    def test_single_state_machine_compiles(self):
        """A machine with one state and no transitions should compile —
        it's a no-op, but legal."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "machine m {\n"
            "    state only {\n"
            "        enter { led.on() }\n"
            "    }\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))

    def test_machine_with_after_transition(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "machine m {\n"
            "    state a {\n"
            "        enter { led.on() }\n"
            "        after 500ms -> b\n"
            "    }\n"
            "    state b {\n"
            "        enter { led.off() }\n"
            "        after 500ms -> a\n"
            "    }\n"
            "}\n"
        )
        errors, _ = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))

    def test_dangling_state_target(self):
        """`after 500ms -> nonexistent` must be rejected."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "machine m {\n"
            "    state a {\n"
            "        enter { led.on() }\n"
            "        after 500ms -> totally_made_up\n"
            "    }\n"
            "}\n"
        )
        errors, _ = compile_to_c(src)
        # Either rejected at parse, resolve, or analyze. Just not silent.
        self.assertTrue(
            errors.has_errors,
            "Transitioning to a non-existent state must error, not silently emit a dangling label",
        )


    def test_machine_empty_state_compiles(self):
        """A state with no enter, no exit, no transitions is degenerate
        but legal. Must not crash codegen."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "machine m {\n"
            "    state idle { }\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        try:
            errors, _ = compile_to_c(src)
        except Exception as e:
            self.fail(f"Empty state crashed codegen: {e}")

    def test_machine_self_transition(self):
        """State that transitions to itself via after."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "machine m {\n"
            "    state ticking {\n"
            "        enter { led.toggle() }\n"
            "        after 500ms -> ticking\n"
            "    }\n"
            "}\n"
        )
        errors, _ = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))

    def test_machine_with_enter_and_exit(self):
        """Both enter and exit blocks on the same state."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "machine m {\n"
            "    state a {\n"
            "        enter { led.on() }\n"
            "        exit { led.off() }\n"
            "        after 500ms -> a\n"
            "    }\n"
            "}\n"
        )
        errors, _ = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))


# ──────────────────────────────────────────────────────────────────────
# Critical-task (ISR) safety
# ──────────────────────────────────────────────────────────────────────

class CriticalTaskISRSafety(unittest.TestCase):
    """Critical tasks run as ISRs. The analyzer must flag unsafe ops."""

    def test_critical_task_compiles_with_atomic_ops(self):
        """Sanity: a well-formed critical task should compile."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "var counter = 0\n"
            "task tick {\n"
            "    every 1ms strict {\n"
            "        counter = counter + 1\n"
            "    }\n"
            "}\n"
            "task slow {\n"
            "    every 1s { led.toggle() }\n"
            "}\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))
        # ISR helpers should show up.
        self.assertIn("iram_attr", c.lower(),
                      "Critical task body should be placed in IRAM (IRAM_ATTR)")

    def test_critical_task_sleep_rejected(self):
        """Calling sleep() inside a critical task body must error —
        sleep yields the protothread but ISRs can't yield."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "task t {\n"
            "    every 1ms strict {\n"
            "        led.toggle()\n"
            "        sleep(10ms)\n"
            "    }\n"
            "}\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            errors.has_errors,
            f"sleep() in a critical task must error. Got: {msgs(errors)}",
        )

    def test_critical_task_wifi_rejected(self):
        """wifi.connect() blocks for seconds — illegal in an ISR."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "task t {\n"
            "    every 1ms strict {\n"
            "        led.toggle()\n"
            "        wifi.connect(\"s\", \"p\")\n"
            "    }\n"
            "}\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            errors.has_errors,
            f"wifi.connect in critical task must error. Got: {msgs(errors)}",
        )


# ──────────────────────────────────────────────────────────────────────
# Functions: recursion, mutual recursion, yields inside
# ──────────────────────────────────────────────────────────────────────

class FunctionEdges(unittest.TestCase):

    def test_recursive_yielding_function_rejected(self):
        """A function that yields (sleep/every) AND calls itself
        recursively cannot be inlined into a protothread. Must error."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "func go() {\n"
            "    sleep(10ms)\n"
            "    go()\n"
            "}\n"
            "task t { go() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            errors.has_errors,
            f"Recursive yielding function must error. Got: {msgs(errors)}",
        )

    def test_simple_non_recursive_function_compiles(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "func flash() {\n"
            "    led.on()\n"
            "    sleep(50ms)\n"
            "    led.off()\n"
            "}\n"
            "task t { every 1s { flash() } }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))


# ──────────────────────────────────────────────────────────────────────
# Pin mode auto-inference
# ──────────────────────────────────────────────────────────────────────

class PinModeInference(unittest.TestCase):

    def test_output_mode_inferred_from_toggle(self):
        """`pin led = 4` with no explicit mode — using led.toggle()
        should infer Output."""
        src = (
            "chip esp32\n"
            "hardware { pin led = 4 }\n"
            "every 1s { led.toggle() }\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))
        # Output mode should result in `pin_set_output(4)` during init.
        self.assertIn("pin_set_output(4)", c,
                      "Output mode should be inferred from led.toggle()")


if __name__ == "__main__":
    unittest.main(verbosity=2)
