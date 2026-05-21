"""Round 40 — Adversarial input stress.

Goal: the compiler must never crash on adversarial input. It can
reject with an error message, but it must not raise an unhandled
exception or hang. Compile-time complexity must stay linear-ish
in the source size.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent))

from test_drivers_brutal import compile_to_c  # noqa: E402


def msgs(errors_obj):
    return [(getattr(e, "severity", "error"), e.message) for e in errors_obj.errors]


class EmptyAndWhitespace(unittest.TestCase):

    def test_completely_empty(self):
        """Empty source should not crash. Either an empty C output or a
        clear error — either is acceptable, but not a Python traceback."""
        try:
            errors, _ = compile_to_c("")
        except Exception as e:
            self.fail(f"Empty source crashed compiler: {e}")
        # Either fails cleanly or produces a degenerate program — both fine.

    def test_whitespace_only(self):
        try:
            errors, _ = compile_to_c("   \n  \t  \n\n")
        except Exception as e:
            self.fail(f"Whitespace-only source crashed: {e}")

    def test_comments_only(self):
        try:
            errors, _ = compile_to_c("// just a comment\n// another\n")
        except Exception as e:
            self.fail(f"Comments-only source crashed: {e}")


class DeepNesting(unittest.TestCase):

    def test_deeply_nested_braces(self):
        """50 levels of `if true { ... }` nesting. Must not stack-overflow
        Python's recursion or hang."""
        depth = 50
        body = "led.toggle()"
        for _ in range(depth):
            body = "if true {\n  " + body + "\n}"
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "every 1s {\n"
            + body + "\n"
            "}\n"
        )
        try:
            errors, _ = compile_to_c(src)
        except RecursionError:
            self.fail("Deep nesting hit Python recursion limit — compiler must handle this")
        except Exception as e:
            # Other exceptions are also unacceptable
            self.fail(f"Deep nesting raised unexpected exception: {e}")

    def test_many_top_level_decls(self):
        """200 var declarations at module scope. Must not hang."""
        decls = "\n".join(f"var v{i} = {i}" for i in range(200))
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            + decls + "\n"
            "every 1s { led.toggle() }\n"
        )
        try:
            errors, _ = compile_to_c(src)
        except Exception as e:
            self.fail(f"200 declarations raised: {e}")
        self.assertFalse(
            errors.has_errors,
            f"200 unique vars should compile. Got: {msgs(errors)[:3]}",
        )


class MalformedInputs(unittest.TestCase):

    def test_unbalanced_braces(self):
        """Missing closing brace must produce a useful error, not crash."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 \n"   # missing }
            "every 1s { led.toggle() }\n"
        )
        try:
            errors, _ = compile_to_c(src)
        except Exception as e:
            self.fail(f"Unbalanced braces crashed: {e}")
        self.assertTrue(errors.has_errors, "Unbalanced braces must fail")

    def test_random_garbage_in_source(self):
        """Random ASCII garbage should reject, not crash."""
        garbage = "@#$%^&*()_+={}[]|\\:\"'<>,.?/~`"
        src = "chip esp32\n" + garbage + "\n"
        try:
            errors, _ = compile_to_c(src)
        except Exception as e:
            self.fail(f"Garbage source crashed: {e}")
        self.assertTrue(errors.has_errors, "Garbage source must reject")

    def test_very_long_string_literal(self):
        """5000-char string literal — must compile, not buffer-overflow."""
        long_str = "x" * 5000
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            f'var s: string = "{long_str}"\n'
            "every 1s { led.toggle() }\n"
        )
        try:
            errors, c = compile_to_c(src)
        except Exception as e:
            self.fail(f"Long string crashed: {e}")
        # The literal must survive into the C output (or be rejected with
        # a clear length-limit message). Either is acceptable, but a
        # silent truncation would be a bug.
        if not errors.has_errors:
            self.assertIn(long_str[:100], c,
                "Long string literal seems to have been silently truncated")


class DuplicateDeclarations(unittest.TestCase):

    def test_three_vars_same_name(self):
        """`var x = 0` three times in a row at top level."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "var x = 0\n"
            "var x = 1\n"
            "var x = 2\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            errors.has_errors,
            "Three vars with the same name must error",
        )

    def test_two_functions_same_name(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "func f() { led.toggle() }\n"
            "func f() { led.toggle() }\n"
            "every 1s { f() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            errors.has_errors,
            "Two functions with the same name must error",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
