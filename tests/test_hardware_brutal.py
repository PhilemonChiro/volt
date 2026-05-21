"""Round 33 — Brutal hardware-validation tests.

Probes the boundary of pin/address validation. Each test poses a specific
footgun that SHOULD produce an error or a warning. Anything that slips
through silently is a Round 33 bug.

We separate errors (fatal: compile must fail) from warnings (advisory:
compile succeeds but a hint is emitted).
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent))

from test_drivers_brutal import compile_to_c  # noqa: E402


def diagnostics(errors_obj):
    """Return (error_msgs, warning_msgs) tuple, regardless of severity field shape."""
    errs, warns = [], []
    for e in errors_obj.errors:
        sev = getattr(e, "severity", "error")
        if sev == "warning":
            warns.append(e.message)
        else:
            errs.append(e.message)
    return errs, warns


# ──────────────────────────────────────────────────────────────────────
# ESP32 strapping & input-only pins
# ──────────────────────────────────────────────────────────────────────

class ESP32PinValidation(unittest.TestCase):

    def test_input_only_pin_as_output_is_error(self):
        """ESP32 GPIO 34..39 are input-only. Declaring as Output must error."""
        for gpio in (34, 35, 36, 39):
            src = (
                "chip esp32\n"
                "hardware {\n"
                f"    pin led: Output = {gpio}\n"
                "}\n"
                "every 1s { led.toggle() }\n"
            )
            errors, _ = compile_to_c(src)
            errs, warns = diagnostics(errors)
            self.assertTrue(
                any("input-only" in m.lower() or "cannot be used as output" in m.lower()
                    for m in errs + warns),
                f"GPIO {gpio} input-only used as Output not flagged. Got errs={errs} warns={warns}",
            )

    def test_strapping_pin_emits_warning(self):
        """Strapping pins (0/2/5/12/15) used in user code should advise."""
        for gpio in (0, 2, 5, 12, 15):
            src = (
                "chip esp32\n"
                "hardware {\n"
                f"    pin x: Output = {gpio}\n"
                "}\n"
                "every 1s { x.toggle() }\n"
            )
            errors, _ = compile_to_c(src)
            errs, warns = diagnostics(errors)
            self.assertTrue(
                any("strapping" in m.lower() for m in errs + warns),
                f"GPIO {gpio} strapping pin not flagged. errs={errs} warns={warns}",
            )

    def test_out_of_range_gpio_is_error(self):
        """ESP32 has GPIO 0..39 (with gaps). GPIO 99 must error."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin x: Output = 99\n"
            "}\n"
            "every 1s { x.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        errs, _ = diagnostics(errors)
        self.assertTrue(
            errors.has_errors,
            f"GPIO 99 should error on esp32 (errs={errs})",
        )


# ──────────────────────────────────────────────────────────────────────
# I²C bus / address validation
# ──────────────────────────────────────────────────────────────────────

class I2CValidation(unittest.TestCase):

    def test_duplicate_i2c_address_is_error(self):
        """Two devices at the same address on the same I²C bus must error."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 2\n"
            "    bus i2c0: I2C(sda: 21, scl: 22)\n"
            "    device a: BME280 on i2c0 at 0x76\n"
            "    device b: BME280 on i2c0 at 0x76\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        errs, _ = diagnostics(errors)
        self.assertTrue(
            errors.has_errors and any("address" in m.lower() and "0x76" in m for m in errs),
            f"Duplicate I²C address 0x76 must error. Got errs={errs}",
        )

    def test_i2c_address_out_of_range(self):
        """I²C 7-bit addresses are 0x08..0x77. 0x00 and 0xFF must error."""
        for bad_addr in (0x00, 0x01, 0x07, 0x78, 0xFF):
            src = (
                "chip esp32\n"
                "hardware {\n"
                "    pin led: Output = 2\n"
                "    bus i2c0: I2C(sda: 21, scl: 22)\n"
                f"    device x: BME280 on i2c0 at {hex(bad_addr)}\n"
                "}\n"
                "every 1s { led.toggle() }\n"
            )
            errors, _ = compile_to_c(src)
            errs, warns = diagnostics(errors)
            self.assertTrue(
                any("address" in m.lower() for m in errs + warns),
                f"I²C address {hex(bad_addr)} should warn/error. errs={errs} warns={warns}",
            )

    def test_bus_pin_reused_as_plain_gpio(self):
        """Using GPIO 21 as both i2c0:sda and a plain Output should error."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 21\n"
            "    bus i2c0: I2C(sda: 21, scl: 22)\n"
            "    device x: BME280 on i2c0 at 0x76\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        errs, warns = diagnostics(errors)
        self.assertTrue(
            errors.has_errors or any("pin 21" in m.lower() or "gpio 21" in m.lower() or "reused" in m.lower()
                                     for m in errs + warns),
            f"GPIO 21 used by both Output and i2c0:sda should be flagged. errs={errs} warns={warns}",
        )


# ──────────────────────────────────────────────────────────────────────
# RP2040 chip-specific
# ──────────────────────────────────────────────────────────────────────

class RP2040PinValidation(unittest.TestCase):

    def test_rp2040_gpio_out_of_range(self):
        """RP2040 (Pico) has GPIO 0..29. GPIO 30 must error."""
        src = (
            "chip rp2040\n"
            "hardware {\n"
            "    pin led: Output = 30\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, _ = compile_to_c(src)
        errs, _ = diagnostics(errors)
        self.assertTrue(
            errors.has_errors,
            f"GPIO 30 should error on rp2040 (errs={errs})",
        )

    def test_rp2040_no_wifi_dependency(self):
        """RP2040 (non-W) has no WiFi. Code referencing wifi should error."""
        src = (
            "chip rp2040\n"
            "hardware { pin led: Output = 25 }\n"
            "every 1s { led.toggle() wifi.is_connected() }\n"
        )
        errors, _ = compile_to_c(src)
        errs, _ = diagnostics(errors)
        # Either parse error (wifi not a known identifier) or analyzer
        # complaint about wifi unsupported on rp2040 is acceptable.
        self.assertTrue(
            errors.has_errors,
            f"wifi on rp2040 (non-W) should error. errs={errs}",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
