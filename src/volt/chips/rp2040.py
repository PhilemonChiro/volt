"""
RP2040 (Raspberry Pi Pico) Chip Specification

30 GPIOs (GP0-GP28 + no GP29 for user), dual-core ARM Cortex-M0+,
264KB SRAM, 2MB flash. No WiFi (Pico W has WiFi via CYW43439).

Sources: RP2040 Datasheet, Raspberry Pi Pico Pinout,
         Pico SDK documentation.
"""

from .base import ChipSpec, PinInfo
from .registry import register


def _build_pins() -> dict[int, PinInfo]:
    """Build the complete RP2040 pin database."""
    pins = {}

    # GP0-GP22 — general purpose, all support output/input/PWM/PIO
    for i in range(23):
        notes = []
        spi = ""
        i2c = ""

        # Default I2C pins
        if i == 0: i2c = "I2C0_SDA"
        if i == 1: i2c = "I2C0_SCL"
        if i == 4: i2c = "I2C0_SDA"
        if i == 5: i2c = "I2C0_SCL"

        # Default SPI pins
        if i == 16: spi = "SPI0_MISO"
        if i == 17: spi = "SPI0_CS"
        if i == 18: spi = "SPI0_CLK"
        if i == 19: spi = "SPI0_MOSI"

        # Default UART pins
        is_uart = False
        if i == 0:
            notes.append("UART0 TX (default)")
            is_uart = True
        if i == 1:
            notes.append("UART0 RX (default)")
            is_uart = True

        pins[i] = PinInfo(
            name=f"GP{i}", gpio=i,
            can_output=True, can_input=True,
            can_analog=False, can_pwm=True,
            has_internal_pullup=True,
            has_internal_pulldown=True,
            is_uart0=is_uart,
            spi_native=spi,
            i2c_default=i2c,
            notes=notes,
        )

    # GP23 — used for onboard voltage regulator on Pico board (SMPS control)
    pins[23] = PinInfo(
        name="GP23", gpio=23,
        can_output=True, can_input=True, can_pwm=True,
        has_internal_pullup=True, has_internal_pulldown=True,
        notes=["Controls onboard SMPS power save mode on Pico board. "
               "Using it may affect power efficiency."],
    )

    # GP24 — VBUS detect on Pico board
    pins[24] = PinInfo(
        name="GP24", gpio=24,
        can_output=True, can_input=True, can_pwm=True,
        has_internal_pullup=True, has_internal_pulldown=True,
        notes=["VBUS sense on Pico board — HIGH when USB is connected."],
    )

    # GP25 — onboard LED on Pico (directly connected, active HIGH)
    pins[25] = PinInfo(
        name="GP25", gpio=25,
        can_output=True, can_input=True, can_pwm=True,
        has_internal_pullup=True, has_internal_pulldown=True,
        notes=["Onboard LED on Raspberry Pi Pico (active HIGH). "
               "On Pico W, this pin is used for WiFi SPI, not LED."],
    )

    # GP26 — ADC0
    pins[26] = PinInfo(
        name="GP26", gpio=26,
        can_output=True, can_input=True, can_analog=True,
        can_pwm=True,
        adc_unit=1, adc_channel=0,
        has_internal_pullup=True, has_internal_pulldown=True,
        notes=["ADC channel 0 (12-bit, 0-3.3V)."],
    )

    # GP27 — ADC1
    pins[27] = PinInfo(
        name="GP27", gpio=27,
        can_output=True, can_input=True, can_analog=True,
        can_pwm=True,
        adc_unit=1, adc_channel=1,
        has_internal_pullup=True, has_internal_pulldown=True,
        notes=["ADC channel 1 (12-bit, 0-3.3V)."],
    )

    # GP28 — ADC2
    pins[28] = PinInfo(
        name="GP28", gpio=28,
        can_output=True, can_input=True, can_analog=True,
        can_pwm=True,
        adc_unit=1, adc_channel=2,
        has_internal_pullup=True, has_internal_pulldown=True,
        notes=["ADC channel 2 (12-bit, 0-3.3V)."],
    )

    # GP29 — ADC3 (internal — reads VSYS/3 voltage divider on Pico board)
    pins[29] = PinInfo(
        name="GP29", gpio=29,
        can_output=False, can_input=True, can_analog=True,
        can_pwm=False,
        adc_unit=1, adc_channel=3,
        has_internal_pullup=False, has_internal_pulldown=False,
        blocked=True,
        blocked_reason="GP29 is connected to the VSYS/3 voltage divider on Pico. "
                       "It reads the system voltage, not an external signal.",
        notes=["Internal ADC3 — reads VSYS/3 for battery/power monitoring."],
    )

    return pins


# Pre-built database
_PIN_DB = _build_pins()

# Derived sets
_SAFE_OUTPUT = [g for g, p in _PIN_DB.items()
                if p.can_output and not p.blocked]
_ADC_PINS = [g for g, p in _PIN_DB.items() if p.can_analog and not p.blocked]


@register
class RP2040(ChipSpec):
    name = "rp2040"
    display_name = "RP2040 (Raspberry Pi Pico)"
    aliases = ["pico", "raspberrypi", "rpipico"]
    arch = "arm-cortex-m0+"
    cores = 2
    ram_kb = 264
    flash_kb = 2048
    sdk = "pico-sdk"
    entry_point = "main"

    def get_pin(self, name: str) -> PinInfo | None:
        # Accept "GP25", "gp25", "25"
        name_upper = name.upper()
        if name_upper.startswith("GP"):
            try:
                gpio = int(name_upper[2:])
                return _PIN_DB.get(gpio)
            except ValueError:
                return None
        try:
            gpio = int(name)
            return _PIN_DB.get(gpio)
        except ValueError:
            return None

    def all_pins(self) -> list[PinInfo]:
        return [p for p in _PIN_DB.values() if not p.blocked]

    def parse_pin_name(self, name: str) -> dict | None:
        pin = self.get_pin(name)
        if pin:
            return {"gpio": pin.gpio}
        return None

    def format_pin_c(self, pin_name: str) -> str:
        name_upper = pin_name.upper()
        if name_upper.startswith("GP"):
            return f"VOLT_PIN({name_upper[2:]})"
        return f"VOLT_PIN({pin_name})"

    def supports(self, feature: str) -> bool:
        return feature in {
            "pwm", "hardware_timer", "deep_sleep", "adc", "usb",
            "pio",  # Programmable IO — unique to RP2040
        }
        # No WiFi, no Bluetooth (Pico W would be a separate chip spec)

    def available_tiers(self) -> list[str]:
        # No RTOS by default. Background (protothreads) + Critical (alarm_pool).
        # Dual-core can replace RTOS priority tier.
        return ["background", "critical"]

    def validate_pin(self, pin_name: str, mode: str) -> list:
        errors = []
        pin = self.get_pin(pin_name)
        if pin is None:
            errors.append(("error",
                           f"Pin {pin_name} does not exist on RP2040. "
                           "RP2040 has GP0-GP28.",
                           f"Available pins: GP0-GP22, GP25-GP28"))
            return errors
        if pin.blocked:
            errors.append(("error", pin.blocked_reason, None))
            return errors
        if mode == "Output" and not pin.can_output:
            errors.append(("error",
                           f"{pin.name} cannot be used as output.",
                           f"Available output pins: {', '.join(f'GP{g}' for g in _SAFE_OUTPUT)}"))
        if mode == "Analog" and not pin.can_analog:
            errors.append(("error",
                           f"{pin.name} is not an analog pin. "
                           "RP2040 ADC is on GP26, GP27, GP28 only.",
                           f"Analog pins: {', '.join(f'GP{g}' for g in _ADC_PINS)}"))
        if mode == "Touch":
            errors.append(("error",
                           "RP2040 does not have capacitive touch pins.",
                           "Capacitive touch is available on ESP32."))
        if pin.gpio == 25:
            errors.append(("warning",
                           "GP25 is the onboard LED on Pico. "
                           "On Pico W, GP25 is used for WiFi SPI — not available as GPIO.", None))
        if pin.gpio in (23, 24):
            errors.append(("warning",
                           f"{pin.name} is used by the Pico board's power circuit. "
                           "Using it may affect power management.", None))
        return errors

    def get_safe_output_pins(self) -> list[str]:
        return [f"GP{g}" for g in _SAFE_OUTPUT]

    def get_adc2_gpios(self) -> set:
        return set()  # No ADC2/WiFi conflict on RP2040

    def get_rtc_gpios(self) -> set:
        return set()  # All GPIOs can wake from dormant mode

    def get_hal_dir(self) -> str:
        return "rp2040"
