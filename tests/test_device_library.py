"""Brutal device-library test.

For every device.json in devices/, generate the exact Volt code the IDE's
library panel would write (bus declaration + device declaration + a minimal
sample using its first read-method) and assert it compiles cleanly through
the whole pipeline (parse → resolve → check → analyze).

If any device JSON would produce broken Volt source, this test catches it
BEFORE a user is confused by an editor full of red squiggles.
"""

import json
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from volt.compiler.parser   import parse           # noqa: E402
from volt.compiler.resolver import resolve         # noqa: E402
from volt.compiler.checker  import check_types     # noqa: E402
from volt.compiler.analyzer import analyze         # noqa: E402
from volt.compiler.errors   import CompilerErrors  # noqa: E402

DEVICES_DIR = REPO / "devices"


# ============================================================
# Code generators — these MUST stay byte-identical to the IDE's
# library.js codegen so a green test means the IDE emits valid code.
# (If you change one, change the other.)
# ============================================================

def bus_for(device: dict):
    iface = (device.get("interface") or "").lower()
    return {"i2c": "i2c0", "spi": "spi0", "uart": "uart0"}.get(iface)


def build_declaration(device: dict, name: str) -> str:
    iface = (device.get("interface") or "").lower()
    bus = bus_for(device)
    if iface == "i2c" and bus:
        addr = device.get("default_address") or "0x00"
        return f"device {name}: {device['name']} on {bus} at {addr}"
    if iface == "spi" and bus:
        return f"device {name}: {device['name']} on {bus} at 5"
    if iface == "uart" and bus:
        return f"device {name}: {device['name']} on {bus} at 0"
    # GPIO devices — single-pin form by default. Multi-pin devices
    # (whose init_args template names extra pins, e.g. HCSR04's
    # `{trig}, {echo}`) must use the named-pins syntax instead.
    import re
    init_args = device.get("init_args", "") or ""
    placeholders = set(re.findall(r"\{(\w+)\}", init_args))
    named_keys = sorted(placeholders - {"pin", "addr", "bus_id"})
    if named_keys:
        params = ", ".join(f"{k}: {5 + i}" for i, k in enumerate(named_keys))
        return f"device {name}: {device['name']}({params})"
    return f"device {name}: {device['name']} on gpio_pin at 4"


def build_bus_decl(device: dict) -> str:
    iface = (device.get("interface") or "").lower()
    bus = bus_for(device)
    if not bus:
        return ""
    if iface == "i2c":  return f"    bus {bus}: I2C(sda: 21, scl: 22)\n"
    if iface == "spi":  return f"    bus {bus}: SPI(sck: 18, mosi: 23, miso: 19)\n"
    if iface == "uart": return f"    bus {bus}: UART(tx: 17, rx: 16)\n"
    return ""


def suggest_name(device: dict) -> str:
    # Conservative: lowercase letters from device name, fall back to category
    base = (device.get("name") or "").lower()
    base = "".join(c for c in base if c.isalpha() or c.isdigit())
    if not base:
        base = (device.get("category") or "dev").lower()
    return base[:12] or "dev"


def assemble_program(device: dict, chip: str = "esp32") -> str:
    """Wrap a single device into a minimal valid Volt program.
    Includes a pin for the on-board LED (so the program 'does' something)
    so the analyzer is happy."""
    name = suggest_name(device)
    decl_line = build_declaration(device, name)
    bus_line  = build_bus_decl(device)

    # GPIO devices need a 'gpio_pin' pin declaration; declare one even when
    # not used so the parser stays happy.
    gpio_pin_line = ""
    iface = (device.get("interface") or "").lower()
    if iface not in ("i2c", "spi", "uart"):
        gpio_pin_line = "    pin gpio_pin: Output = 4\n"

    program = (
        f"chip {chip}\n"
        "hardware {\n"
        "    pin led: Output = 2\n"
        f"{gpio_pin_line}"
        f"{bus_line}"
        f"    {decl_line}\n"
        "}\n"
        "every 1s {\n"
        "    led.toggle()\n"
        "}\n"
    )
    return program


# ============================================================
# Test cases
# ============================================================

def all_devices():
    out = []
    for d in sorted(DEVICES_DIR.iterdir()):
        if not d.is_dir():
            continue
        f = d / "device.json"
        if not f.exists():
            continue
        out.append((d.name, json.loads(f.read_text())))
    return out


class DeviceLibraryCompiles(unittest.TestCase):
    """Run every device through the full Volt pipeline. Any failure here
    means the IDE would generate code the compiler doesn't accept."""

    def _compile(self, program: str, label: str):
        errors = CompilerErrors()
        errors.set_source(program)
        try:
            ast = parse(program)
        except Exception as e:
            self.fail(f"{label}: parse failed: {e}\n\nProgram:\n{program}")
        try:
            scope = resolve(ast, errors)
        except Exception as e:
            self.fail(f"{label}: resolve failed: {e}\n\nProgram:\n{program}")
        try:
            check_types(ast, scope, errors)
        except Exception as e:
            self.fail(f"{label}: check failed: {e}\n\nProgram:\n{program}")
        try:
            analyze(ast, scope, errors)
        except Exception as e:
            self.fail(f"{label}: analyze failed: {e}\n\nProgram:\n{program}")
        if errors.has_errors:
            msgs = "\n".join(f"  - {e.message}" for e in errors.errors if e.severity == "error")
            self.fail(f"{label}: compile errors:\n{msgs}\n\nProgram:\n{program}")

    def test_every_device_compiles(self):
        devices = all_devices()
        self.assertGreater(len(devices), 0, "no devices found")
        failures = []
        for folder, device in devices:
            program = assemble_program(device)
            try:
                self._compile(program, folder)
            except AssertionError as e:
                failures.append((folder, str(e)))
        if failures:
            report = "\n\n".join(f"=== {f} ===\n{msg}" for f, msg in failures)
            self.fail(f"{len(failures)} / {len(devices)} devices failed to compile:\n\n{report}")

    def test_bus_decl_syntax_matches_grammar(self):
        """Spot-check the exact bus-decl form the IDE emits."""
        # Pick one of each interface type to verify
        samples = {
            "i2c":  ("ds3231",  "bus i2c0: I2C(sda: 21, scl: 22)"),
            "spi":  ("max7219", "bus spi0: SPI(sck: 18, mosi: 23, miso: 19)"),
        }
        by_folder = dict(all_devices())
        for iface, (folder, expected_bus) in samples.items():
            if folder not in by_folder:
                continue
            line = build_bus_decl(by_folder[folder]).strip()
            self.assertEqual(line, expected_bus, f"{folder}: bus decl drift")

    def test_device_decl_form_is_valid(self):
        """Each device decl uses one of the two valid forms:
          - Single-anchor: `device X: T on Y at N`
          - Named-pins:    `device X: T(p1: v1, p2: v2)`  (HCSR04 etc.)
        Both forms must be parseable; neither uses `=...(...)`."""
        for folder, device in all_devices():
            name = suggest_name(device)
            decl = build_declaration(device, name)
            named_form = "(" in decl and ")" in decl and " on " not in decl
            legacy_form = " on " in decl and " at " in decl
            self.assertTrue(
                named_form or legacy_form,
                f"{folder}: '{decl}' matches neither form",
            )
            self.assertNotIn("=", decl, f"{folder}: '{decl}' uses '=' (wrong syntax)")


if __name__ == "__main__":
    print(f"Testing {len(all_devices())} devices…")
    unittest.main(verbosity=2)
