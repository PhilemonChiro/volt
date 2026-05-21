"""Round 36 — Brutal codegen-output safety probes.

Focus:
  - C reserved word collisions in user identifiers (C89, C99, C11)
  - Format string injection through log() / serial / println
  - Buffer sizing for string interpolation
  - Very long identifiers
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent))

from test_drivers_brutal import compile_to_c  # noqa: E402


def msgs(errors_obj):
    return [(getattr(e, "severity", "error"), e.message) for e in errors_obj.errors]


# ──────────────────────────────────────────────────────────────────────
# C reserved word collisions
# ──────────────────────────────────────────────────────────────────────

class ReservedWordIdentifiers(unittest.TestCase):
    """A Volt identifier that happens to be a C keyword must be escaped
    by codegen — otherwise gcc rejects the file with a confusing error."""

    def assert_safe(self, ident, c_keyword=True):
        """Common helper — declare `var <ident> = 0` and check that the
        generated C doesn't have a bare `int32_t <ident>` line.

        If c_keyword=True, the identifier IS a C keyword so it must be
        escaped (e.g. as v_<ident>). If c_keyword=False, the identifier
        is a non-keyword C reserved/stdlib name and the test verifies
        it at least compiles cleanly.
        """
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            f"var {ident} = 0\n"
            "every 1s { led.toggle() }\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(
            errors.has_errors,
            f"`var {ident}` should compile but errored: {msgs(errors)}",
        )
        if c_keyword:
            # The reserved keyword must not appear as a bare C identifier.
            # We check that no line declares "int32_t <ident>" or
            # "_Atomic int32_t <ident>" — i.e. the escape worked.
            bad_patterns = [
                f"int32_t {ident} ",
                f"int32_t {ident};",
                f"int32_t {ident}=",
                f"_Atomic int32_t {ident} ",
            ]
            for p in bad_patterns:
                self.assertNotIn(p, c,
                    f"Identifier `{ident}` is a C keyword but codegen emitted "
                    f"it bare: '{p}' found in output. This will fail gcc.")

    def test_c89_keyword_for(self):
        self.assert_safe("for")

    def test_c89_keyword_if(self):
        self.assert_safe("if")

    def test_c89_keyword_static(self):
        self.assert_safe("static")

    def test_c89_keyword_return(self):
        self.assert_safe("return")

    def test_c89_keyword_sizeof(self):
        self.assert_safe("sizeof")

    def test_c99_keyword_inline(self):
        """C99 keyword. Currently not in C_KEYWORDS — Round 36 bug."""
        self.assert_safe("inline")

    def test_c99_keyword_restrict(self):
        """C99 keyword."""
        self.assert_safe("restrict")


# ──────────────────────────────────────────────────────────────────────
# Format string safety (log, serial, println)
# ──────────────────────────────────────────────────────────────────────

class FormatStringSafety(unittest.TestCase):

    def test_log_with_user_string_uses_format_specifier(self):
        """`log("tag", user_var)` must NOT pass user_var as the format
        string. It must wrap as log_info(tag, "%s", user_var)."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "var msg: string = \"hello %s %n attack\"\n"
            "every 1s {\n"
            "  led.toggle()\n"
            "  log(\"tag\", msg)\n"
            "}\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))
        # The generated C must use "%s" wrapper so the literal %s %n in
        # the user string never reaches printf's parser.
        self.assertIn('log_info(', c)
        self.assertNotIn("log_info(\"tag\", msg)", c,
            "log() passed user variable directly as format string — "
            "%n in the string could write to memory")


# ──────────────────────────────────────────────────────────────────────
# Long / edge identifiers
# ──────────────────────────────────────────────────────────────────────

class IdentifierLimits(unittest.TestCase):

    def test_very_long_identifier(self):
        """Variable name with 200 characters — must compile (C standard
        requires 63-char significance for external, 31 internal). Volt
        should at minimum not crash on it."""
        long_name = "a" + "b" * 199
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            f"var {long_name} = 0\n"
            "every 1s { led.toggle() }\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(
            errors.has_errors,
            f"Long identifier should compile. Got: {msgs(errors)}",
        )
        # Name should survive into the output (truncation would be a footgun)
        self.assertIn(long_name, c)

    def test_leading_underscore_identifier(self):
        """`_foo` is a valid Volt identifier; in C, leading-underscore
        names are reserved in some contexts. Codegen should still produce
        valid output."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "var _hidden = 0\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertFalse(errors.has_errors, msgs(errors))


if __name__ == "__main__":
    unittest.main(verbosity=2)
