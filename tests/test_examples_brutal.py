"""Round 37 — Brutally compile every example in examples/.

Stricter than test_examples_build.py: any error (not just missing
include macros) fails the round. Also flags warnings that the previous
rounds wired in (strapping pins, etc.) — examples must use safe pins
or accept they emit warnings.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent))

from test_drivers_brutal import compile_to_c  # noqa: E402


EXAMPLES_DIR = Path(__file__).parent.parent / "examples"


def discover_examples():
    return sorted(EXAMPLES_DIR.glob("*/main.volt"))


class ExampleCompilation(unittest.TestCase):

    def test_every_example_compiles(self):
        bad = []
        for example_path in discover_examples():
            with open(example_path) as f:
                src = f.read()
            errors, c = compile_to_c(src)
            if errors.has_errors:
                err_msgs = [e.message for e in errors.errors
                            if getattr(e, "severity", "error") == "error"]
                bad.append(f"{example_path.relative_to(EXAMPLES_DIR.parent)}:\n  "
                           + "\n  ".join(err_msgs[:3]))
            elif not c:
                bad.append(f"{example_path.relative_to(EXAMPLES_DIR.parent)}: empty C output")
        if bad:
            self.fail(
                f"{len(bad)} examples failed to compile:\n\n"
                + "\n\n".join(bad)
            )

    def test_no_example_emits_dangling_init(self):
        """A device init must be paired with a real declaration in the
        generated C — i.e. `bme280_init(&_x, ...)` requires `static
        bme280_t _x` somewhere above. Catches the kind of c_prefix
        mismatch Round 32 fixed."""
        bad = []
        for example_path in discover_examples():
            with open(example_path) as f:
                src = f.read()
            errors, c = compile_to_c(src)
            if errors.has_errors:
                continue
            import re
            inits = re.findall(r"(\w+)_init\(&_(\w+),", c)
            for prefix, var in inits:
                expected_decl = f"static {prefix}_t _{var}"
                if expected_decl not in c:
                    bad.append(
                        f"{example_path.relative_to(EXAMPLES_DIR.parent)}: "
                        f"{prefix}_init(&_{var}, …) emitted but no "
                        f"`static {prefix}_t _{var}` declared"
                    )
        if bad:
            self.fail("\n".join(bad))


class ExampleCount(unittest.TestCase):
    """A sanity check that we still have a reasonable number of examples."""

    def test_at_least_five_examples(self):
        n = len(discover_examples())
        self.assertGreaterEqual(n, 5, f"Only {n} examples found, expected ≥ 5")


if __name__ == "__main__":
    n = len(discover_examples())
    print(f"Found {n} example programs.")
    unittest.main(verbosity=2)
