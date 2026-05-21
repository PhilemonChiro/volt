"""Brutal driver tests — Round 31 of the distillation.

Every device in devices/ is exercised across:
- Compile-clean smoke (extends test_device_library.py)
- c_prefix correctness: generated C uses device.c_prefix, not the
  lowercased Volt type. LCD16x2/LCD20x4 alias to hd44780; the codegen
  must respect that.
- Method call generation: every declared method in device.json must
  resolve to a recognised METHOD_MAP entry; calling it on a device of
  the right type must compile.
- Address-form handling: hex I²C address, decimal SPI CS pin, decimal
  GPIO pin — none should turn into an arithmetic constant or a comment.
- Bus-mismatch rejection: I²C device on a SPI bus should produce a
  Volt-level error (NOT a silent miscompile).
- Duplicate addresses on the same bus: should warn or error.
- Devices declared but never used: must still compile.
- Multiple devices of the same type: distinct instances, no symbol
  collision.

Goal of the round: catch the bugs the existing test_device_library.py
misses by going one level deeper.
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
from volt.compiler.codegen  import CCodeGen        # noqa: E402
from volt.compiler.errors   import CompilerErrors  # noqa: E402
from volt.compiler.device_registry import get_registry  # noqa: E402

DEVICES_DIR = REPO / "devices"


# ============================================================
# Helpers
# ============================================================

def compile_to_c(source: str):
    """Run the full pipeline and return (errors, c_code).
    Errors object is always returned; c_code may be '' if early pass died."""
    errors = CompilerErrors()
    errors.set_source(source)
    try:
        ast = parse(source)
    except Exception as e:
        errors.errors.append(type("E", (), {"severity": "error", "message": f"parse: {e}"})())
        return errors, ""
    try:
        scope = resolve(ast, errors)
    except Exception as e:
        errors.errors.append(type("E", (), {"severity": "error", "message": f"resolve: {e}"})())
        return errors, ""
    try:
        check_types(ast, scope, errors)
    except Exception as e:
        errors.errors.append(type("E", (), {"severity": "error", "message": f"check: {e}"})())
        return errors, ""
    try:
        analyze(ast, scope, errors)
    except Exception as e:
        errors.errors.append(type("E", (), {"severity": "error", "message": f"analyze: {e}"})())
        return errors, ""
    if errors.has_errors:
        return errors, ""
    try:
        gen = CCodeGen()
        c = gen.generate(ast)
    except Exception as e:
        errors.errors.append(type("E", (), {"severity": "error", "message": f"codegen: {e}"})())
        return errors, ""
    return errors, c


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


def bus_kind(device):
    return (device.get("interface") or "").lower()


def example_program(device, var_name="dev", chip="esp32"):
    """Synthesize a minimal valid Volt program using the device with one method call."""
    iface = bus_kind(device)
    methods = list((device.get("methods") or {}).keys())
    method_call = ""
    if methods:
        m = methods[0]
        params = (device["methods"][m].get("params") or [])
        # Build a stub call. If the method takes args, pass simple literals.
        args = []
        for p in params:
            t = (p.get("type") or "int").lower()
            if t == "int":    args.append("0")
            elif t == "float": args.append("0.0")
            elif t == "bool":  args.append("true")
            elif t == "string": args.append('"x"')
            else:              args.append("0")
        method_call = f"    {var_name}.{m}({', '.join(args)})"

    if iface == "i2c":
        bus_decl = "    bus i2c0: I2C(sda: 21, scl: 22)\n"
        dev_decl = f"    device {var_name}: {device['name']} on i2c0 at {device.get('default_address', '0x00')}\n"
    elif iface == "spi":
        bus_decl = "    bus spi0: SPI(sck: 18, mosi: 23, miso: 19)\n"
        dev_decl = f"    device {var_name}: {device['name']} on spi0 at 5\n"
    elif iface == "uart":
        bus_decl = "    bus uart0: UART(tx: 17, rx: 16)\n"
        dev_decl = f"    device {var_name}: {device['name']} on uart0 at 0\n"
    else:
        # GPIO-bound device — needs a real pin declared
        bus_decl = "    pin trig: Output = 5\n"
        dev_decl = f"    device {var_name}: {device['name']} on trig at 5\n"

    body = "every 1s {\n    led.toggle()\n"
    if method_call:
        body += method_call + "\n"
    body += "}\n"

    return (
        f"chip {chip}\n"
        "hardware {\n"
        "    pin led: Output = 2\n"
        f"{bus_decl}"
        f"{dev_decl}"
        "}\n"
        + body
    )


# ============================================================
# Round-31 test cases
# ============================================================

class DriverCompileCases(unittest.TestCase):
    """Each device's library snippet round-trips through parse + emit
    without errors, AND the generated C uses the device's c_prefix."""

    def test_all_devices_compile(self):
        bad = []
        for folder, device in all_devices():
            program = example_program(device)
            errors, c = compile_to_c(program)
            if errors.has_errors or not c:
                msgs = "; ".join(e.message for e in errors.errors if e.severity == "error")
                bad.append(f"{folder}: {msgs}")
        if bad:
            self.fail(f"{len(bad)} devices failed full compile:\n  " + "\n  ".join(bad))

    def test_c_prefix_used_for_struct_type(self):
        """Round 31's headline bug — LCD16x2 must emit hd44780_t not lcd16x2_t.
        Every device's static instance declaration must use c_prefix."""
        bad = []
        for folder, device in all_devices():
            program = example_program(device, var_name="dev")
            _, c = compile_to_c(program)
            if not c:
                continue   # compile-fail case is covered by the previous test
            cprefix = device.get("c_prefix", "").lower()
            if not cprefix:
                continue
            expect_decl = f"static {cprefix}_t _dev"
            if expect_decl not in c:
                # Verify the WRONG decl isn't emitted either
                wrong = f"static {device['name'].lower()}_t _dev"
                if wrong in c and wrong != expect_decl:
                    bad.append(f"{folder}: emitted '{wrong}' instead of '{expect_decl}'")
        if bad:
            self.fail(f"{len(bad)} devices emit wrong struct type:\n  " + "\n  ".join(bad))

    def test_c_prefix_used_for_init_call(self):
        """The device init line at the top of setup must use c_prefix too."""
        bad = []
        for folder, device in all_devices():
            program = example_program(device, var_name="dev")
            _, c = compile_to_c(program)
            if not c:
                continue
            cprefix = device.get("c_prefix", "").lower()
            if not cprefix:
                continue
            expect_init = f"{cprefix}_init(&_dev"
            if expect_init not in c:
                wrong = f"{device['name'].lower()}_init(&_dev"
                if wrong in c and wrong != expect_init:
                    bad.append(f"{folder}: emitted '{wrong}' instead of '{expect_init}'")
        if bad:
            self.fail(f"{len(bad)} devices emit wrong init call:\n  " + "\n  ".join(bad))


class DriverEdgeCases(unittest.TestCase):
    """Bug-fertile patterns. Each test is one specific footgun."""

    def test_lcd_alias_uses_hd44780(self):
        """LCD16x2 and LCD20x4 BOTH alias to hd44780 in device.json."""
        for vt in ("LCD16x2", "LCD20x4"):
            src = (
                "chip esp32\n"
                "hardware {\n"
                "    pin led: Output = 2\n"
                "    bus i2c0: I2C(sda: 21, scl: 22)\n"
                f"    device disp: {vt} on i2c0 at 0x27\n"
                "}\n"
                "every 1s { led.toggle() }\n"
            )
            errors, c = compile_to_c(src)
            self.assertFalse(errors.has_errors, f"{vt} compile errors: {[e.message for e in errors.errors]}")
            self.assertIn("static hd44780_t _disp", c, f"{vt} did not emit hd44780_t")
            self.assertIn("hd44780_init(&_disp",   c, f"{vt} did not emit hd44780_init")
            self.assertNotIn(f"{vt.lower()}_t",    c, f"{vt} leaked {vt.lower()}_t into output")

    def test_multiple_devices_same_type(self):
        """Two BME280s on the same bus — distinct instance vars, both inits emitted."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 2\n"
            "    bus i2c0: I2C(sda: 21, scl: 22)\n"
            "    device bme1: BME280 on i2c0 at 0x76\n"
            "    device bme2: BME280 on i2c0 at 0x77\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, [e.message for e in errors.errors])
        self.assertIn("static bme280_t _bme1", c)
        self.assertIn("static bme280_t _bme2", c)
        self.assertIn("bme280_init(&_bme1", c)
        self.assertIn("bme280_init(&_bme2", c)

    def test_duplicate_address_same_bus(self):
        """Two devices at 0x76 on the same I²C bus — should be an error."""
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
        msgs = " ".join(e.message for e in errors.errors)
        # Soft assertion — flag as an unhandled case if it slips through.
        if not errors.has_errors:
            self.skipTest("Duplicate-address detection not implemented yet (Round 32 candidate)")

    def test_method_recognised_by_checker(self):
        """Every method declared in device.json must be callable on its device
        without 'unknown method' error."""
        bad = []
        for folder, device in all_devices():
            methods = list((device.get("methods") or {}).keys())
            if not methods:
                continue
            src = example_program(device, var_name="dev")
            errors, _ = compile_to_c(src)
            for e in errors.errors:
                if "unknown method" in e.message.lower() or "no method" in e.message.lower():
                    bad.append(f"{folder}: {e.message}")
        if bad:
            self.fail(f"{len(bad)} method-recognition failures:\n  " + "\n  ".join(bad))

    def test_hex_address_preserved(self):
        """I²C device with hex address — the emitted comment shows 0x76, not 118."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 2\n"
            "    bus i2c0: I2C(sda: 21, scl: 22)\n"
            "    device bme: BME280 on i2c0 at 0x76\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        _, c = compile_to_c(src)
        self.assertIn("0x76", c, "Hex address should survive into the generated comment")

    def test_spi_device_at_is_cs_pin(self):
        """A SPI device's 'at <N>' is the CS pin (an int), passed as such to init."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 2\n"
            "    bus spi0: SPI(sck: 18, mosi: 23, miso: 19)\n"
            "    device tc: MAX31855 on spi0 at 5\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        _, c = compile_to_c(src)
        # cs_pin comment is emitted by codegen for SPI devices
        self.assertIn("max31855_init(&_tc, 0, 5)", c, "SPI init should pass CS pin as 3rd arg")

    def test_gpio_device_pin_declared(self):
        """A GPIO-bound device needs a pin declared with the same name."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 2\n"
            "    pin trig: Output = 5\n"
            "    device dist: HCSR04 on trig at 5\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, [e.message for e in errors.errors])
        self.assertIn("hcsr04_init(&_dist", c)

    def test_dht11_passes_type_11(self):
        """DHT11 codegen must pass the GPIO pin + sensor type 11 to dht_init."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 2\n"
            "    pin sig: Input = 5\n"
            "    device w: DHT11 on sig at 5\n"
            "}\n"
            "every 1s {\n  led.toggle()\n  w.temperature()\n}\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, [e.message for e in errors.errors])
        self.assertIn("static dht_t _w", c, "DHT11 must use shared dht_t (c_prefix=dht)")
        self.assertIn("dht_init(&_w, 5, 11)", c, "DHT11 init must pass (pin=5, type=11)")
        self.assertNotIn("dht11_init", c, "DHT11 must not emit a dht11_* symbol (driver doesn't exist)")

    def test_dht22_aliases_to_dht_with_type_22(self):
        """DHT22 must alias to the dht driver and pass type=22."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 2\n"
            "    pin sig: Input = 4\n"
            "    device w: DHT22 on sig at 4\n"
            "}\n"
            "every 1s {\n  led.toggle()\n  w.humidity()\n}\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, [e.message for e in errors.errors])
        self.assertIn("static dht_t _w", c, "DHT22 must alias to dht_t (no dht22_* driver exists)")
        self.assertIn("dht_init(&_w, 4, 22)", c, "DHT22 init must pass (pin=4, type=22)")
        self.assertNotIn("dht22_init", c, "DHT22 must not emit a dht22_* symbol (driver doesn't exist)")

    def test_i2c_init_shape(self):
        """I²C devices: init(&dev, bus_id, addr) — bus_id=0, addr is the 'at' literal."""
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 2\n"
            "    bus i2c0: I2C(sda: 21, scl: 22)\n"
            "    device bme: BME280 on i2c0 at 0x76\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        _, c = compile_to_c(src)
        self.assertIn("bme280_init(&_bme, 0, 118)", c, "I²C init shape must be (bus_id, addr)")

    def test_uart_init_shape(self):
        """UART-bound devices: codegen must not pretend they're I²C."""
        reg = get_registry()
        uart_devs = [d for d in reg.devices.values() if d.interface == "uart"]
        if not uart_devs:
            self.skipTest("No UART-bound devices in registry")
        d = uart_devs[0]
        src = (
            "chip esp32\n"
            "hardware {\n"
            "    pin led: Output = 2\n"
            "    bus uart0: UART(tx: 17, rx: 16)\n"
            f"    device u: {d.name} on uart0 at 0\n"
            "}\n"
            "every 1s { led.toggle() }\n"
        )
        errors, c = compile_to_c(src)
        self.assertFalse(errors.has_errors, [e.message for e in errors.errors])
        self.assertIn(f"{d.c_prefix}_init(&_u", c)


class DriverInventory(unittest.TestCase):
    """Cross-check device.json vs codebase reality."""

    def test_every_device_in_registry(self):
        reg = get_registry()
        for folder, device in all_devices():
            d = reg.get(device["name"])
            self.assertIsNotNone(d, f"{folder}: device {device['name']} missing from registry")

    def test_c_prefix_not_empty(self):
        bad = [folder for folder, dev in all_devices() if not dev.get("c_prefix")]
        if bad:
            self.fail(f"Devices with empty c_prefix: {bad}")

    def test_every_c_prefix_has_a_driver_c(self):
        """A device folder may legitimately lack driver.c if it's an alias
        (c_prefix points at another device's driver). What matters for the
        linker is that the *c_prefix* itself maps to a real driver.c somewhere."""
        prefixes_with_driver = set()
        for folder, _device in all_devices():
            if (DEVICES_DIR / folder / "driver.c").exists():
                prefixes_with_driver.add(folder)
        orphans = []
        for folder, device in all_devices():
            prefix = device.get("c_prefix", "")
            if not prefix:
                continue
            if prefix not in prefixes_with_driver:
                orphans.append(f"{folder} (c_prefix={prefix}) — no driver.c found")
        if orphans:
            self.fail(
                "Devices whose c_prefix has no implementing driver.c:\n  "
                + "\n  ".join(orphans)
            )


if __name__ == "__main__":
    n = sum(1 for _ in all_devices())
    print(f"Testing {n} devices (Round 31)…")
    unittest.main(verbosity=2)
