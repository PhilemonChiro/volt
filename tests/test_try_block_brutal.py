"""Round 42 — Brutal try-block tests.

All test inputs verbatim from the implementation spec (section 11).
Plus a few deep-nesting / mixed-policy probes.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent))

from test_drivers_brutal import compile_to_c  # noqa: E402


def has_error(errs, substring=None, severity="error"):
    for e in errs.errors:
        if getattr(e, "severity", "error") == severity:
            if substring is None or substring.lower() in e.message.lower():
                return True
    return False


def has_warning(errs, substring=None):
    return has_error(errs, substring, severity="warning")


# ──────────────────────────────────────────────────────────────────────
# Grammar
# ──────────────────────────────────────────────────────────────────────

class GrammarPositive(unittest.TestCase):
    """Each of these should parse + check + codegen cleanly."""

    def _ok(self, body_src):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            f"setup {{ {body_src} }}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(
            errors.has_errors,
            f"{body_src} -> {[(getattr(e,'severity','?'), e.message) for e in errors.errors]}",
        )
        self.assertTrue(c)
        return c

    def test_unbounded_retry(self):
        self._ok('try { wifi.connect("a","b") } or retry')

    def test_bounded_retry_else_skip(self):
        self._ok('try { wifi.connect("a","b") } or retry 3 times else skip')

    def test_bounded_retry_else_restart(self):
        self._ok('try { wifi.connect("a","b") } or retry 5 times else restart')

    def test_bounded_retry_else_fail(self):
        self._ok('try { wifi.connect("a","b") } or retry 2 times else fail')

    def test_or_skip(self):
        self._ok('try { wifi.connect("a","b") } or skip')

    def test_or_restart(self):
        self._ok('try { wifi.connect("a","b") } or restart')


class GrammarNegative(unittest.TestCase):
    """Each of these MUST fail to parse or compile."""

    def _bad(self, body_src):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            f"setup {{ {body_src} }}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            errors.has_errors,
            f"{body_src!r} parsed/compiled cleanly when it shouldn't have",
        )

    def test_empty_body(self):
        self._bad("try { } or retry")

    def test_bounded_without_else(self):
        self._bad('try { wifi.connect("a","b") } or retry 3 times')

    def test_fail_as_top_level_policy(self):
        self._bad('try { wifi.connect("a","b") } or fail')


# ──────────────────────────────────────────────────────────────────────
# Checker — dead policy warning
# ──────────────────────────────────────────────────────────────────────

class CheckerDeadPolicy(unittest.TestCase):

    def test_dead_policy_warning(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "setup { try { let x: int = 1 } or retry }\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            has_warning(errors, "dead code"),
            f"expected dead-policy warning, got {[e.message for e in errors.errors]}",
        )


# ──────────────────────────────────────────────────────────────────────
# Analyzer restrictions
# ──────────────────────────────────────────────────────────────────────

class AnalyzerRestrictions(unittest.TestCase):

    def test_critical_task_forbids_try(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "task tick {\n"
            "    every 1ms strict {\n"
            "        try { wifi.connect(\"a\",\"b\") } or skip\n"
            "    }\n"
            "}\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            has_error(errors, "forbidden in critical"),
            [e.message for e in errors.errors],
        )

    def test_state_machine_unbounded_retry_enter_rejected(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "machine m {\n"
            "    state s {\n"
            "        enter { try { wifi.connect(\"a\",\"b\") } or retry }\n"
            "    }\n"
            "}\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            has_error(errors, "unbounded"),
            [e.message for e in errors.errors],
        )

    def test_state_machine_bounded_retry_enter_ok(self):
        """Bounded retry IS allowed in state-machine enter because it terminates."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "machine m {\n"
            "    state a { enter { try { wifi.connect(\"a\",\"b\") } or retry 3 times else skip } after 1s -> b }\n"
            "    state b { enter { led.on() } }\n"
            "}\n"
        )
        errors, _ = compile_to_c(src)
        # Bounded retry should not produce a state-machine error
        self.assertFalse(
            any("unbounded" in e.message.lower() for e in errors.errors),
            [e.message for e in errors.errors],
        )

    def test_synchronous_body_does_not_lift(self):
        """A bounded-retry try block whose body is purely synchronous (no
        sleep, no wifi/mqtt/http/storage, no nested every/on/timeout) does
        not need a context-struct counter — the function never re-enters.
        We assert the counter is stack-local to avoid ctx-struct bloat."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 4\n"
            "    bus i2c0: I2C(sda: 21, scl: 22)\n"
            "    device bme: BME280 on i2c0 at 0x76\n"
            "}\n"
            "machine m {\n"
            "    state a {\n"
            "        enter { try { bme.temperature() } or retry 3 times else skip }\n"
            "        after 1s -> b\n"
            "    }\n"
            "    state b { enter { led.on() } }\n"
            "}\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, [e.message for e in errors.errors])
        # Stack-local: `int32_t _try_attempts_<N> = 0;` declared, no ctx-> deref.
        self.assertIn("int32_t _try_attempts_", c)
        self.assertNotIn("ctx->_try_attempts_", c)
        # And the machine's ctx struct must NOT carry the counter.
        import re
        m_ctx = re.search(r"typedef struct \{([^}]*)\} m_ctx_t;", c, re.S)
        self.assertTrue(m_ctx)
        self.assertNotIn("_try_attempts_", m_ctx.group(1),
                         "synchronous body should not bloat the ctx struct")

    def test_state_machine_retry_counter_lifts_to_machine_ctx(self):
        """When a bounded-retry try block lives inside a state-machine enter
        block AND its body contains a call (which may yield), the retry counter
        MUST live in the machine's context struct. A stack-local counter would
        reset on every scheduler re-entry of m_run, defeating the bound."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "machine m {\n"
            "    state a {\n"
            "        enter { try { wifi.connect(\"a\",\"b\") } or retry 3 times else skip }\n"
            "        after 1s -> b\n"
            "    }\n"
            "    state b { enter { led.on() } }\n"
            "}\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, [e.message for e in errors.errors])
        # The machine's context struct must include the counter field.
        # _try_attempts_<N> for some N (transformer numbers them per-machine).
        import re
        self.assertTrue(
            re.search(r"typedef struct \{[^}]*int32_t _try_attempts_\d+;[^}]*\} m_ctx_t;", c, re.S),
            "machine context struct must include _try_attempts_<N>",
        )
        # The counter increment/check must dereference ctx->, not a local.
        self.assertIn("ctx->_try_attempts_", c)
        self.assertNotIn("int32_t _try_attempts_0 = 0;", c)  # would be stack-local
        self.assertNotIn("int32_t _try_attempts_1 = 0;", c)

    def test_mutable_global_inside_retry_warns(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "var counter: int = 0\n"
            "setup {\n"
            "    try {\n"
            "        counter += 1\n"
            "        wifi.connect(\"a\",\"b\")\n"
            "    } or retry 3 times else skip\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            has_warning(errors, "side effects will repeat"),
            [e.message for e in errors.errors],
        )

    def test_hardware_write_no_warn(self):
        """led.on() inside retry should NOT warn — hardware writes are idempotent."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "setup {\n"
            "    try {\n"
            "        led.on()\n"
            "        wifi.connect(\"a\",\"b\")\n"
            "    } or retry 3 times else skip\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertFalse(
            has_warning(errors, "side effects will repeat"),
            [e.message for e in errors.errors],
        )


# ──────────────────────────────────────────────────────────────────────
# Codegen golden-output checks
# ──────────────────────────────────────────────────────────────────────

class CodegenShape(unittest.TestCase):

    def _compile(self, src):
        errs, c = compile_to_c(src)
        self.assertFalse(errs.has_errors, [e.message for e in errs.errors])
        return c

    def test_or_skip_emits_end_label(self):
        c = self._compile(
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "setup { try { wifi.connect(\"a\",\"b\") } or skip }\n"
            "every 1s { led.toggle() }\n"
        )
        self.assertIn("goto _try_0_end", c)
        self.assertIn("_try_0_end:", c)
        self.assertIn("wifi_connect", c)

    def test_or_retry_emits_start_label(self):
        c = self._compile(
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "setup { try { wifi.connect(\"a\",\"b\") } or retry }\n"
            "every 1s { led.toggle() }\n"
        )
        self.assertIn("_try_0_start:", c)
        self.assertIn("goto _try_0_start", c)

    def test_bounded_retry_emits_counter_and_check(self):
        c = self._compile(
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "setup { try { wifi.connect(\"a\",\"b\") } or retry 5 times else restart }\n"
            "every 1s { led.toggle() }\n"
        )
        self.assertIn("_try_attempts_0", c)
        self.assertIn("< 5", c)
        self.assertIn("system_restart()", c)

    def test_else_fail_emits_log_plus_return(self):
        c = self._compile(
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "setup { try { wifi.connect(\"a\",\"b\") } or retry 3 times else fail }\n"
            "every 1s { led.toggle() }\n"
        )
        self.assertIn("log_error", c)
        self.assertIn("exhausted retries", c)

    def test_or_restart_calls_system_restart(self):
        c = self._compile(
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "setup { try { wifi.connect(\"a\",\"b\") } or restart }\n"
            "every 1s { led.toggle() }\n"
        )
        self.assertIn("system_restart()", c)


# ──────────────────────────────────────────────────────────────────────
# Nested / mixed policies
# ──────────────────────────────────────────────────────────────────────

class NestedTryBlocks(unittest.TestCase):

    def test_nested_two_levels(self):
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "setup {\n"
            "    try {\n"
            "        try {\n"
            "            wifi.connect(\"a\",\"b\")\n"
            "        } or retry 2 times else fail\n"
            "        storage.load(\"config\")\n"
            "    } or retry 3 times else restart\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, c = compile_to_c(src)
        # The redundant-nesting warning fires if the outer try has a single inner-try
        # statement. Here the outer has TWO statements, so no warning.
        self.assertFalse(errors.has_errors,
                         [e.message for e in errors.errors])
        # Both try IDs must appear in the output.
        self.assertIn("_try_0", c)
        self.assertIn("_try_1", c)

    def test_redundant_nesting_warns(self):
        """Outer try whose body is exactly one inner try → warn."""
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            "setup {\n"
            "    try {\n"
            "        try { wifi.connect(\"a\",\"b\") } or retry 2 times else fail\n"
            "    } or retry 3 times else restart\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        self.assertTrue(
            has_warning(errors, "redundant"),
            [e.message for e in errors.errors],
        )


# ──────────────────────────────────────────────────────────────────────
# Stress
# ──────────────────────────────────────────────────────────────────────

class Stress(unittest.TestCase):

    def test_deeply_nested_ten_levels(self):
        """10 levels of nested try blocks must compile."""
        body = "wifi.connect(\"a\",\"b\")"
        for _ in range(10):
            body = "try {\n  " + body + "\n} or retry 2 times else skip"
        src = (
            "chip esp32\n"
            "hardware { pin led: Output = 4 }\n"
            f"setup {{ {body} }}\n"
            "every 1s {{ led.toggle() }}\n"
        )
        errors, c = compile_to_c(src.replace("{{", "{").replace("}}", "}"))
        # May warn about redundant nesting at each level — that's fine.
        # What matters: no errors, and 10 distinct try IDs in the output.
        self.assertFalse(any(getattr(e,'severity','error')=='error' for e in errors.errors),
                         [e.message for e in errors.errors])
        for i in range(10):
            self.assertIn(f"_try_{i}", c, f"missing _try_{i} label")


# ──────────────────────────────────────────────────────────────────────
# Formatter idempotency
# ──────────────────────────────────────────────────────────────────────

class FormatterRoundTrip(unittest.TestCase):

    def test_each_policy_round_trips(self):
        from volt.compiler.formatter import format_source
        sources = [
            'chip esp32\nhardware { pin led: Output = 4 }\nsetup { try { wifi.connect("a","b") } or skip }\nevery 1s { led.toggle() }\n',
            'chip esp32\nhardware { pin led: Output = 4 }\nsetup { try { wifi.connect("a","b") } or retry }\nevery 1s { led.toggle() }\n',
            'chip esp32\nhardware { pin led: Output = 4 }\nsetup { try { wifi.connect("a","b") } or retry 3 times else restart }\nevery 1s { led.toggle() }\n',
        ]
        for s in sources:
            once = format_source(s)
            twice = format_source(once)
            self.assertEqual(once, twice, f"not idempotent for:\n{s}\nonce:\n{once}\ntwice:\n{twice}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
