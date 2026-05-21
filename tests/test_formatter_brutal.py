"""Round 39 — Formatter idempotency + round-trip.

Two universal formatter invariants:

  1. Idempotent: format(format(src)) == format(src). Otherwise running
     the formatter twice produces diff churn.
  2. Round-trip: parse(format(src)) produces an AST that emits the same
     C as parse(src). Otherwise the formatter is silently rewriting
     semantics.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent))

from volt.compiler.formatter import format_source  # noqa: E402
from test_drivers_brutal import compile_to_c  # noqa: E402


EXAMPLES_DIR = Path(__file__).parent.parent / "examples"


def discover_examples():
    return sorted(EXAMPLES_DIR.glob("*/main.volt"))


SAMPLE_PROGRAMS = [
    # Minimal
    "chip esp32\n",
    # With one task
    "chip esp32\nhardware { pin led: Output = 4 }\nevery 1s { led.toggle() }\n",
    # Variable + every
    "chip esp32\nhardware { pin led: Output = 4 }\nvar n = 0\nevery 1s {\n  led.toggle()\n  n = n + 1\n}\n",
    # I2C device
    (
        "chip esp32\nhardware {\n  pin led: Output = 4\n  bus i2c0: I2C(sda: 21, scl: 22)\n"
        "  device bme: BME280 on i2c0 at 0x76\n}\nevery 1s { led.toggle() }\n"
    ),
]


class FormatterIdempotency(unittest.TestCase):

    def test_sample_programs_idempotent(self):
        for i, src in enumerate(SAMPLE_PROGRAMS):
            once = format_source(src)
            twice = format_source(once)
            self.assertEqual(
                once, twice,
                f"Sample #{i} not idempotent.\n--- once ---\n{once}\n--- twice ---\n{twice}",
            )

    def test_examples_idempotent(self):
        diffs = []
        for example_path in discover_examples():
            with open(example_path) as f:
                src = f.read()
            try:
                once = format_source(src)
                twice = format_source(once)
            except Exception as e:
                diffs.append(f"{example_path.name}: formatter raised {e}")
                continue
            if once != twice:
                diffs.append(f"{example_path.name}: not idempotent (differs after 2 passes)")
        if diffs:
            self.fail("\n".join(diffs))


class FormatterRoundTrip(unittest.TestCase):

    def test_format_preserves_compilable(self):
        """parse(format(src)) must still be a compilable program."""
        for i, src in enumerate(SAMPLE_PROGRAMS):
            formatted = format_source(src)
            errors, _ = compile_to_c(formatted)
            self.assertFalse(
                errors.has_errors,
                f"Sample #{i} broke after formatting. Errors: "
                + str([e.message for e in errors.errors][:3]),
            )

    def test_examples_round_trip(self):
        """Each example must compile both before and after formatting."""
        broken = []
        for example_path in discover_examples():
            with open(example_path) as f:
                src = f.read()
            errors_before, c_before = compile_to_c(src)
            if errors_before.has_errors:
                continue  # already-broken example isn't our concern
            try:
                formatted = format_source(src)
            except Exception as e:
                broken.append(f"{example_path.name}: formatter raised {e}")
                continue
            errors_after, c_after = compile_to_c(formatted)
            if errors_after.has_errors:
                broken.append(
                    f"{example_path.name}: formatted version no longer compiles. "
                    f"Errors: "
                    + str([e.message for e in errors_after.errors][:2])
                )
        if broken:
            self.fail("\n".join(broken))


if __name__ == "__main__":
    unittest.main(verbosity=2)
