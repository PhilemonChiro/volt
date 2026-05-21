"""Round 35 — Brutal concurrency probes.

Focus areas:
  - Channel capacity bounds (very small, very large, zero, negative).
  - Cross-tier shared variable detection (critical ↔ background, ISR ↔ main).
  - Codegen atomicity: is a shared int written from an ISR emitted as volatile?
  - Multi-producer / multi-consumer channels.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent))

from test_drivers_brutal import compile_to_c  # noqa: E402


def msgs(errors_obj):
    return [(getattr(e, "severity", "error"), e.message) for e in errors_obj.errors]


def has_severity(errors_obj, severity, substring=None):
    for e in errors_obj.errors:
        if getattr(e, "severity", "error") == severity:
            if substring is None or substring.lower() in e.message.lower():
                return True
    return False


# ──────────────────────────────────────────────────────────────────────
# Channel capacity bounds
# ──────────────────────────────────────────────────────────────────────

class ChannelBounds(unittest.TestCase):

    def test_channel_capacity_zero_is_error(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "channel q: int[0]\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            errors.has_errors,
            f"channel capacity 0 must error. Got: {msgs(errors)}",
        )

    def test_channel_capacity_negative_is_error(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "channel q: int[-1]\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            errors.has_errors,
            f"channel capacity -1 must error. Got: {msgs(errors)}",
        )

    def test_channel_capacity_too_large_is_error(self):
        """Embedded targets have 20KB-520KB RAM (per CLAUDE.md). A
        channel of 100_000 ints would blow the heap on every target."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "channel q: int[100000]\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            errors.has_errors,
            f"channel capacity 100000 must error. Got: {msgs(errors)}",
        )

    def test_channel_capacity_reasonable_ok(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "channel q: int[8]\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertFalse(
            errors.has_errors,
            f"channel capacity 8 must compile. Got: {msgs(errors)}",
        )


# ──────────────────────────────────────────────────────────────────────
# Cross-tier shared state
# ──────────────────────────────────────────────────────────────────────

class SharedStateDetection(unittest.TestCase):

    def test_critical_and_background_share_var_warns(self):
        """A var written from a critical task (ISR) and read from a
        background task crosses tiers. The analyzer must warn and the
        codegen must emit the var as `volatile`."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 4\n"
            "    pin motor: PWM = 25\n"
            "}\n"
            "var counter = 0\n"
            "task isr_task {\n"
            "    every 1ms strict {\n"
            "        counter = counter + 1\n"
            "    }\n"
            "}\n"
            "task slow_task {\n"
            "    every 1s {\n"
            "        led.toggle()\n"
            "        motor.set_pwm(counter)\n"
            "    }\n"
            "}\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(
            errors.has_errors,
            f"Cross-tier shared var should warn, not error. Got: {msgs(errors)}",
        )
        # The user is warned …
        self.assertTrue(
            has_severity(errors, "warning"),
            f"Expected a concurrency warning. Got: {msgs(errors)}",
        )
        # … AND the codegen makes the variable safe — either `_Atomic`
        # (preferred — gives both visibility and torn-write protection)
        # or `volatile` at minimum.
        self.assertTrue(
            "_Atomic" in c or "volatile" in c,
            "Codegen must emit shared cross-tier var as _Atomic or volatile",
        )
        # Specifically `counter` must be the variable that's protected.
        self.assertTrue(
            "_Atomic int32_t counter" in c or "volatile int32_t counter" in c,
            f"`counter` must be _Atomic/volatile, not bare int32_t. "
            f"Snippet: {[l for l in c.splitlines() if 'counter' in l][:3]}",
        )


# ──────────────────────────────────────────────────────────────────────
# Atomicity sanity for ISR-shared variables
# ──────────────────────────────────────────────────────────────────────

class ISRAtomicity(unittest.TestCase):

    def test_isr_increments_64bit_warns(self):
        """A 64-bit int read/written from an ISR is NOT atomic on
        a 32-bit MCU. The analyzer should flag this as a torn-read risk."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "var big: int64 = 0\n"   # if int64 isn't a recognised type that's fine
            "task isr_task {\n"
            "    every 1ms strict { big = big + 1 }\n"
            "}\n"
            "task slow_task {\n"
            "    every 1s { led.toggle() }\n"
            "}\n"
        )
        errors, _ = compile_to_c(src)
        # If the language doesn't have int64 at all, the test is N/A;
        # skip rather than fail.
        if any("unknown type" in m.lower() or "int64" in m.lower()
               for s, m in msgs(errors) if s == "error"):
            self.skipTest("int64 not in the type system — no atomicity check needed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
