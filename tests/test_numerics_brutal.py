"""Round 38 — Numeric literals, duration parsing, and arithmetic edges.

Hunts silent footguns:
  - Negative / zero / overflowing durations
  - Hex / binary integer literals
  - Float precision in pin/address contexts
  - Enum collisions
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent))

from test_drivers_brutal import compile_to_c  # noqa: E402


def msgs(errors_obj):
    return [(getattr(e, "severity", "error"), e.message) for e in errors_obj.errors]


class DurationLiterals(unittest.TestCase):

    def test_zero_duration_every_rejected(self):
        """`every 0ms` would spin without yielding. Must reject."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "every 0ms { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            errors.has_errors,
            f"`every 0ms` should reject — would spin. Got: {msgs(errors)}",
        )

    def test_negative_duration_rejected(self):
        """Parser likely rejects this at the grammar level, but check anyway."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "every -100ms { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            errors.has_errors,
            f"negative duration should reject. Got: {msgs(errors)}",
        )

    def test_reasonable_duration_ok(self):
        for d in ("1ms", "100ms", "1s", "60s", "5minutes"):
            src = (
                "chip esp32\n"
                "hardware { pin led: Output = 4 }\n"
                f"every {d} {{ led.toggle() }}\n"
            )
            errors, _ = compile_to_c(src)
            self.assertFalse(
                errors.has_errors,
                f"`every {d}` should compile. Got: {msgs(errors)}",
            )


# ──────────────────────────────────────────────────────────────────────
# Integer literal forms
# ──────────────────────────────────────────────────────────────────────

class IntegerLiterals(unittest.TestCase):

    def test_hex_literal(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "var x = 0xFF\n"
            "every 1s { led.toggle() }\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))
        # Either preserved as 0xFF or normalized to 255 — both fine.
        self.assertTrue("0xFF" in c or "0xff" in c or " 255" in c)

    def test_negative_literal_in_var(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "var x = -42\n"
            "every 1s { led.toggle() }\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))
        self.assertIn("-42", c)


# ──────────────────────────────────────────────────────────────────────
# Enums
# ──────────────────────────────────────────────────────────────────────

class EnumEdges(unittest.TestCase):

    def test_simple_enum_compiles(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "enum mode { idle, run, stop }\n"
            "var m: mode = mode.idle\n"
            "every 1s { led.toggle() }\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))
        # The enum must materialize in some form.
        self.assertTrue(
            "idle" in c.lower(),
            "enum value names should appear in generated C",
        )


# ──────────────────────────────────────────────────────────────────────
# Sleep durations in tasks
# ──────────────────────────────────────────────────────────────────────

class SleepEdges(unittest.TestCase):

    def test_sleep_basic(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "task t {\n"
            "  led.on()\n"
            "  sleep(100ms)\n"
            "  led.off()\n"
            "}\n"
        )
        errors, _ = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))


if __name__ == "__main__":
    unittest.main(verbosity=2)
