"""
ESP32 (WROOM-32) Chip Specification

Complete hardware knowledge of every GPIO, capability, and restriction.
Used by the compiler for pin validation, code generation, and build manifests.
"""

from .base import ChipSpec, PinInfo, WiFiCapable, BluetoothCapable
from .registry import register


def _build_pins() -> dict[int, PinInfo]:
    """Build the complete ESP32 pin database."""
    pins = {}

    # GPIO 0 — strapping, ADC2_CH1, Touch T1
    pins[0] = PinInfo(
        name="0", gpio=0, is_strapping=True, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=1, can_analog=True,
        can_touch=True,
        strapping_warning="GPIO 0 must be HIGH during boot (pulled up by default). "
                          "If driven LOW externally, the chip enters bootloader mode.",
    )

    # GPIO 1 — UART0 TX (serial output)
    pins[1] = PinInfo(
        name="1", gpio=1, is_uart0=True,
        notes=["UART0 TX — used for serial output. Using this pin may break serial communication."],
    )

    # GPIO 2 — strapping, ADC2_CH2, Touch T2, onboard LED on many boards
    pins[2] = PinInfo(
        name="2", gpio=2, is_strapping=True, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=2, can_analog=True,
        can_touch=True,
        strapping_warning="GPIO 2 must be LOW during boot for flash programming.",
    )

    # GPIO 3 — UART0 RX (serial input)
    pins[3] = PinInfo(
        name="3", gpio=3, is_uart0=True,
        notes=["UART0 RX — used for serial input. Using this pin may break serial communication."],
    )

    # GPIO 4 — ADC2_CH0, Touch T0
    pins[4] = PinInfo(
        name="4", gpio=4, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=0, can_analog=True,
        can_touch=True,
    )

    # GPIO 5 — strapping (affects debug output on boot)
    pins[5] = PinInfo(
        name="5", gpio=5, is_strapping=True,
        strapping_warning="GPIO 5 controls boot debug output. Usually safe for general use.",
    )

    # GPIO 6-11 — SPI flash (DO NOT USE)
    for i in range(6, 12):
        pins[i] = PinInfo(
            name=str(i), gpio=i, is_flash_pin=True, blocked=True,
            can_output=False, can_input=False, can_pwm=False,
            blocked_reason=f"GPIO {i} is connected to the SPI flash chip. Using it will crash.",
        )

    # GPIO 12 — strapping, JTAG TDI, ADC2_CH5, Touch T5
    pins[12] = PinInfo(
        name="12", gpio=12, is_strapping=True, is_jtag=True, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=5, can_analog=True,
        can_touch=True,
        strapping_warning="GPIO 12 controls flash voltage at boot. If pulled HIGH, "
                          "the chip may fail to boot (sets flash to 1.8V instead of 3.3V).",
    )

    # GPIO 13 — JTAG TCK, ADC2_CH4, Touch T4
    pins[13] = PinInfo(
        name="13", gpio=13, is_jtag=True, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=4, can_analog=True,
        can_touch=True,
    )

    # GPIO 14 — JTAG TMS, ADC2_CH6, Touch T6
    pins[14] = PinInfo(
        name="14", gpio=14, is_jtag=True, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=6, can_analog=True,
        can_touch=True, spi_native="HSPI_CLK",
    )

    # GPIO 15 — strapping, JTAG TDO, ADC2_CH3, Touch T3
    pins[15] = PinInfo(
        name="15", gpio=15, is_strapping=True, is_jtag=True, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=3, can_analog=True,
        can_touch=True, spi_native="HSPI_CS0",
        strapping_warning="GPIO 15 controls boot log output. If pulled LOW, "
                          "boot messages are suppressed (usually harmless).",
    )

    # GPIO 16 — PSRAM CS on WROVER
    pins[16] = PinInfo(
        name="16", gpio=16,
        notes=["Used by PSRAM on ESP32-WROVER modules. Safe on WROOM."],
    )

    # GPIO 17 — PSRAM CLK on WROVER
    pins[17] = PinInfo(
        name="17", gpio=17,
        notes=["Used by PSRAM on ESP32-WROVER modules. Safe on WROOM."],
    )

    # GPIO 18 — VSPI CLK
    pins[18] = PinInfo(name="18", gpio=18, spi_native="VSPI_CLK")

    # GPIO 19 — VSPI MISO
    pins[19] = PinInfo(name="19", gpio=19, spi_native="VSPI_MISO")

    # GPIO 20 — not available on WROOM-32
    pins[20] = PinInfo(
        name="20", gpio=20, blocked=True,
        can_output=False, can_input=False,
        blocked_reason="GPIO 20 is not available on ESP32-WROOM-32.",
    )

    # GPIO 21 — I2C SDA (default)
    pins[21] = PinInfo(name="21", gpio=21, i2c_default="SDA")

    # GPIO 22 — I2C SCL (default)
    pins[22] = PinInfo(name="22", gpio=22, i2c_default="SCL")

    # GPIO 23 — VSPI MOSI
    pins[23] = PinInfo(name="23", gpio=23, spi_native="VSPI_MOSI")

    # GPIO 24 — not available on WROOM-32
    pins[24] = PinInfo(
        name="24", gpio=24, blocked=True,
        can_output=False, can_input=False,
        blocked_reason="GPIO 24 is not available on ESP32-WROOM-32.",
    )

    # GPIO 25 — DAC1, ADC2_CH8
    pins[25] = PinInfo(
        name="25", gpio=25, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=8, can_analog=True,
        notes=["Also DAC channel 1."],
    )

    # GPIO 26 — DAC2, ADC2_CH9
    pins[26] = PinInfo(
        name="26", gpio=26, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=9, can_analog=True,
        notes=["Also DAC channel 2."],
    )

    # GPIO 27 — ADC2_CH7, Touch T7
    pins[27] = PinInfo(
        name="27", gpio=27, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=7, can_analog=True,
        can_touch=True,
    )

    # GPIO 28-31 — not available
    for i in range(28, 32):
        pins[i] = PinInfo(
            name=str(i), gpio=i, blocked=True,
            can_output=False, can_input=False,
            blocked_reason=f"GPIO {i} is not available on ESP32-WROOM-32.",
        )

    # GPIO 32 — ADC1_CH4, Touch T9, 32K crystal
    pins[32] = PinInfo(
        name="32", gpio=32, can_wake_deep_sleep=True,
        adc_unit=1, adc_channel=4, can_analog=True,
        can_touch=True,
        notes=["Also 32kHz crystal pin (XTAL_32K_P)."],
    )

    # GPIO 33 — ADC1_CH5, Touch T8, 32K crystal
    pins[33] = PinInfo(
        name="33", gpio=33, can_wake_deep_sleep=True,
        adc_unit=1, adc_channel=5, can_analog=True,
        can_touch=True,
        notes=["Also 32kHz crystal pin (XTAL_32K_N)."],
    )

    # GPIO 34-39 — Input only, no pull-up/pull-down
    input_only = {
        34: (1, 6, ""),
        35: (1, 7, ""),
        36: (1, 0, "Hardware errata: interrupts may fire spuriously during WiFi/BT light sleep."),
        37: (1, 1, "Not exposed on most DevKit boards."),
        38: (1, 2, "Not exposed on most DevKit boards."),
        39: (1, 3, "Hardware errata: interrupts may fire spuriously during WiFi/BT light sleep."),
    }
    for gpio, (adc_u, adc_ch, note) in input_only.items():
        notes = [note] if note else []
        pins[gpio] = PinInfo(
            name=str(gpio), gpio=gpio,
            can_output=False, can_pwm=False,
            can_input=True, can_analog=True,
            has_internal_pullup=False, has_internal_pulldown=False,
            can_wake_deep_sleep=True,
            adc_unit=adc_u, adc_channel=adc_ch,
            notes=notes,
        )

    return pins


# Pre-built pin database
_PIN_DB = _build_pins()

# Derived sets
_ADC2_GPIOS = {g for g, p in _PIN_DB.items() if p.adc_unit == 2}
_RTC_GPIOS = {g for g, p in _PIN_DB.items() if p.can_wake_deep_sleep}
_SAFE_OUTPUT = [g for g, p in _PIN_DB.items()
                if p.can_output and not p.blocked and not p.is_flash_pin
                and not p.is_uart0]
_VSPI_NATIVE = {23: "MOSI", 19: "MISO", 18: "CLK", 5: "CS0"}
_HSPI_NATIVE = {13: "MOSI", 12: "MISO", 14: "CLK", 15: "CS0"}


@register
class ESP32(ChipSpec, WiFiCapable, BluetoothCapable):
    name = "esp32"
    display_name = "ESP32 (WROOM-32)"
    aliases = ["esp32wroom"]
    arch = "xtensa-lx6"
    cores = 2
    ram_kb = 520
    flash_kb = 4096
    sdk = "esp-idf"
    entry_point = "app_main"

    def get_pin(self, name: str) -> PinInfo | None:
        try:
            gpio = int(name)
        except ValueError:
            return None
        return _PIN_DB.get(gpio)

    def all_pins(self) -> list[PinInfo]:
        return [p for p in _PIN_DB.values() if not p.blocked]

    def parse_pin_name(self, name: str) -> dict | None:
        try:
            gpio = int(name)
            if gpio in _PIN_DB:
                return {"gpio": gpio}
        except ValueError:
            pass
        return None

    def format_pin_c(self, pin_name: str) -> str:
        return f"VOLT_PIN({int(pin_name)})"

    def supports(self, feature: str) -> bool:
        return feature in {
            "wifi", "bluetooth", "ble", "pwm", "dac", "touch",
            "rtos", "hardware_timer", "deep_sleep", "adc",
        }

    def available_tiers(self) -> list[str]:
        return ["background", "priority", "critical"]

    def validate_pin(self, pin_name: str, mode: str) -> list:
        errors = []
        pin = self.get_pin(pin_name)
        if pin is None:
            errors.append(("error", f"GPIO {pin_name} does not exist on ESP32.",
                           f"Available pins: 0-39 (excluding 20, 24, 28-31)"))
            return errors
        if pin.blocked:
            errors.append(("error", pin.blocked_reason, None))
            return errors
        if pin.is_flash_pin:
            errors.append(("error",
                           f"GPIO {pin_name} is connected to SPI flash — using it will crash the chip.",
                           f"Available output pins: {', '.join(str(p) for p in _SAFE_OUTPUT)}"))
        if mode == "Output" and not pin.can_output:
            errors.append(("error",
                           f"GPIO {pin_name} is input-only (GPIO 34-39 cannot output).",
                           f"Available output pins: {', '.join(str(p) for p in _SAFE_OUTPUT)}"))
        if mode == "Analog" and not pin.can_analog:
            adc_pins = [str(g) for g, p in _PIN_DB.items() if p.can_analog and not p.blocked]
            errors.append(("error",
                           f"GPIO {pin_name} has no ADC channel.",
                           f"Pins with ADC: {', '.join(adc_pins)}"))
        if mode in ("Input.PullUp", "InputPullUp") and not pin.has_internal_pullup:
            errors.append(("error",
                           f"GPIO {pin_name} has no internal pull-up resistor (GPIO 34-39).",
                           "Use an external pull-up resistor."))
        if pin.is_strapping and pin.strapping_warning:
            errors.append(("warning", f"Strapping pin: {pin.strapping_warning}", None))
        if pin.is_uart0:
            errors.append(("warning",
                           f"GPIO {pin_name} is UART0 ({'TX' if pin.gpio == 1 else 'RX'}) — "
                           "using it may break serial communication.", None))
        return errors

    def get_safe_output_pins(self) -> list[str]:
        return [str(g) for g in _SAFE_OUTPUT]

    def get_adc2_gpios(self) -> set:
        return _ADC2_GPIOS

    def get_rtc_gpios(self) -> set:
        return _RTC_GPIOS

    def get_hal_dir(self) -> str:
        return "espressif"

    def bt_supports_classic(self) -> bool:
        return True
