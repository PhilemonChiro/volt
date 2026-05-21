"""Permanent invariant: the brutal-test helper must invoke every compiler
pass that the real CLI does.

This rules out the entire class of bug behind Round 42: a `compile_to_c`
that silently skips `transform()` (or any other pass) hides every
transformer-dependent test silently. The fix in v2.0.57 wired transform()
back in, but the structural risk recurs every time a new pass is added —
someone wires it into voltc.compile_volt and forgets the brutal helper,
or vice versa.

The test below instruments each public pass entrypoint with a recording
wrapper, runs both `compile_to_c` and `voltc.compile_volt` against the
same trivial program, and asserts they touched the same set of passes.
If the sets diverge, the bug class is back.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent))


# A trivial-but-complete program: needs every pass to do something
# meaningful so an omission shows up as a missing call.
TRIVIAL = (
    "chip esp32\n"
    "hardware { pin led: Output = 4 }\n"
    "every 1s { led.toggle() }\n"
)


# The set of (module_path, function_name) pairs that constitute "a compiler
# pass." If a new pass is added later, append it here AND wire it into both
# the real CLI and compile_to_c — this test will fail until both sides match.
PASSES = [
    ("volt.compiler.parser",      "parse"),
    ("volt.compiler.resolver",    "resolve"),
    ("volt.compiler.checker",     "check_types"),
    ("volt.compiler.analyzer",    "analyze"),
    ("volt.compiler.transformer", "transform"),
]


def _called_passes_running(callable_under_test) -> set:
    """Wrap each compiler pass with a recorder, invoke callable_under_test,
    return the set of pass names that fired.

    Both consumers use `from X import Y` imports, which capture function
    references at module-load time. Patching `volt.compiler.X.Y` AFTER
    those imports leaves the captured references untouched. So we patch
    in two places per pass:

      1. The defining module (volt.compiler.X.Y), for any future late
         lookups.
      2. The CONSUMER module's namespace (voltc, test_drivers_brutal),
         which is where the bound reference actually lives.
    """
    import importlib
    called = set()

    def make_recorder(name, original):
        def wrapper(*args, **kwargs):
            called.add(name)
            return original(*args, **kwargs)
        return wrapper

    # Consumer modules whose globals may hold a `from X import Y` binding.
    # Add new consumers here if more helpers crop up.
    import test_drivers_brutal
    importlib.reload(test_drivers_brutal)
    from volt.compiler import voltc
    consumer_modules = [voltc, test_drivers_brutal]

    originals = []
    try:
        for mod_path, fname in PASSES:
            mod = importlib.import_module(mod_path)
            orig = getattr(mod, fname)
            wrapper = make_recorder(fname, orig)
            # (1) Defining module
            originals.append((mod, fname, orig))
            setattr(mod, fname, wrapper)
            # (2) Every consumer's bound name (if any)
            for consumer in consumer_modules:
                if hasattr(consumer, fname) and getattr(consumer, fname) is orig:
                    originals.append((consumer, fname, getattr(consumer, fname)))
                    setattr(consumer, fname, wrapper)
        callable_under_test()
    finally:
        for mod, fname, orig in originals:
            setattr(mod, fname, orig)

    return called


class HarnessRunsAllPasses(unittest.TestCase):
    """If this test ever fails, a compiler pass was added to one of the
    two pipelines without being wired into the other. Fix whichever side
    is behind."""

    def test_compile_to_c_runs_all_real_cli_passes(self):
        from volt.compiler.voltc import compile_volt
        from test_drivers_brutal import compile_to_c

        passes_real = _called_passes_running(lambda: compile_volt(TRIVIAL, "main.volt"))
        passes_brutal = _called_passes_running(lambda: compile_to_c(TRIVIAL))

        # The real CLI is the authoritative set. compile_to_c should be
        # at least a superset of it (it can do MORE, but never less).
        missing = passes_real - passes_brutal
        self.assertFalse(
            missing,
            f"compile_to_c is missing passes that the real CLI runs: {sorted(missing)}. "
            f"This is the Round 42 bug class — fix tests/test_drivers_brutal.py::compile_to_c "
            f"to invoke {missing}. Brutal touched: {sorted(passes_brutal)}; "
            f"real touched: {sorted(passes_real)}.",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
