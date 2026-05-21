"""Round 34 — Brutal compiler-robustness + error-quality tests.

Each test pokes at a different edge of the compiler's input space.
Two kinds of assertion:
  - "must compile cleanly" — small/empty programs that are legal Volt.
  - "must reject with a useful message" — illegal programs where the
    error must name the actual user identifier and quote a line number.
"""

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent))

from test_drivers_brutal import compile_to_c  # noqa: E402


def all_msgs(errors_obj):
    return [e.message for e in errors_obj.errors]


def has_line_number(msgs):
    """Any of these messages quote a line number? Required for usability."""
    return any(re.search(r"line \d+|:\d+:|line:\s*\d+", m, re.I) for m in msgs)


# ──────────────────────────────────────────────────────────────────────
# Minimal/degenerate programs that should compile cleanly
# ──────────────────────────────────────────────────────────────────────

class MinimalPrograms(unittest.TestCase):

    def test_chip_only(self):
        """A `chip esp32` declaration alone is degenerate but legal —
        compiler should produce a stub C file, not crash."""
        errors, c = compile_to_c("chip esp32\n")
        self.assertFalse(errors.has_errors, all_msgs(errors))
        self.assertTrue(len(c) > 0, "Empty program produced no C output")

    def test_chip_plus_empty_hardware(self):
        errors, c = compile_to_c("chip esp32\nhardware { }\n")
        self.assertFalse(errors.has_errors, all_msgs(errors))

    def test_chip_plus_empty_every(self):
        """An `every` with no body is harmless — should compile."""
        errors, c = compile_to_c("chip esp32\nhardware { pin led: Output = 2 }\nevery 1s { }\n")
        self.assertFalse(errors.has_errors, all_msgs(errors))


# ──────────────────────────────────────────────────────────────────────
# Programs that must be rejected with a clear message
# ──────────────────────────────────────────────────────────────────────

class UsefulRejections(unittest.TestCase):

    def test_unknown_identifier_is_named(self):
        """`mystery_var` is used but never declared. Error must name it."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 2 }\n"
            "every 1s { led.toggle() mystery_var = 5 }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(errors.has_errors, "Should reject unknown identifier")
        msgs = all_msgs(errors)
        self.assertTrue(
            any("mystery_var" in m for m in msgs),
            f"Error message must name 'mystery_var'. Got: {msgs}",
        )

    def test_unknown_method_is_named(self):
        """Calling a method that doesn't exist on a device → must name it."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 2\n"
            "    bus i2c0: I2C(sda: 21, scl: 22)\n"
            "    device bme: BME280 on i2c0 at 0x76\n"
            "}\n"
            "every 1s {\n  led.toggle()\n  bme.fly_to_the_moon()\n}\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(errors.has_errors)
        msgs = all_msgs(errors)
        self.assertTrue(
            any("fly_to_the_moon" in m for m in msgs),
            f"Error message must name 'fly_to_the_moon'. Got: {msgs}",
        )

    def test_undeclared_pin_use(self):
        """Using a pin name that was never declared."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 2 }\n"
            "every 1s { ghost.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(errors.has_errors)
        msgs = all_msgs(errors)
        self.assertTrue(
            any("ghost" in m for m in msgs),
            f"Error must name the undeclared identifier 'ghost'. Got: {msgs}",
        )

    def test_duplicate_pin_name_is_clear(self):
        """Two pins with the same name must be rejected."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 2\n"
            "    pin led: Output = 4\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(errors.has_errors, "Should reject duplicate pin name")
        msgs = all_msgs(errors)
        self.assertTrue(
            any("led" in m for m in msgs),
            f"Error must name the duplicated pin 'led'. Got: {msgs}",
        )

    def test_type_mismatch_assignment(self):
        """Assigning a string literal to an int variable must error."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 2 }\n"
            "let x: int = \"hello\"\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(errors.has_errors, "Should reject int <- string assignment")

    def test_state_machine_unknown_target_state(self):
        """A state machine transitioning to a non-existent state should
        be caught — otherwise codegen would emit dangling labels."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 2 }\n"
            "state_machine door {\n"
            "    state closed {\n"
            "        on event { -> totally_made_up_state }\n"
            "    }\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        # Either the parser rejects (because syntax wasn't right) OR the
        # checker should catch the dangling state name. Either is acceptable
        # — but silently succeeding is a bug.
        if not errors.has_errors:
            self.fail("State machine with unknown target state was silently accepted")


# ──────────────────────────────────────────────────────────────────────
# Error message quality: line numbers
# ──────────────────────────────────────────────────────────────────────

class ErrorQuality(unittest.TestCase):

    def test_errors_have_line_numbers(self):
        """At least one error from a multi-line program should carry a
        line number, otherwise the user can't jump to the problem."""
        src = (
            "chip esp32\n"
            "\n"
            "\n"
            "hardware { pin led: Output = 2 }\n"
            "\n"
            "every 1s { ghost.toggle() }\n"   # ghost is line 6
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(errors.has_errors)
        msgs = all_msgs(errors)
        # Either the message itself includes a line number OR the error
        # object carries a region with start_line set.
        has_region = any(
            getattr(e, "region", None) is not None
            and getattr(e.region, "start_line", 0) > 0
            for e in errors.errors
        )
        self.assertTrue(
            has_region or has_line_number(msgs),
            f"No line-number info in any error. Msgs: {msgs}",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
