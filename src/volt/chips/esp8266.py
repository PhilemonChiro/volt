"""
ESP8266 Chip Specification

17 GPIOs (0-16), single-core Xtensa LX106, 80KB RAM.
WiFi-capable but no Bluetooth. GPIO16 is RTC domain (special).
API mirrors ESP-IDF (shared HAL with ESP32).

Sources: ESP8266 Technical Reference, ESP8266 RTOS SDK docs,
         ESP8266EX Datasheet.
"""

from .base import ChipSpec, PinInfo, WiFiCapable
from .registry import register


def _build_pins() -> dict[int, PinInfo]:
    """Build the complete ESP8266 pin database."""
    pins = {}

    # GPIO 0 — boot mode select, pull-up at boot
    # LOW at boot = flash mode. HIGH = normal boot.
    pins[0] = PinInfo(
        name="0", gpio=0, is_strapping=True,
        can_analog=False, can_touch=False,
        has_internal_pullup=True, has_internal_pulldown=False,
        strapping_warning="GPIO 0 must be HIGH during boot. "
                          "If LOW, chip enters flash/programming mode.",
        notes=["Often connected to FLASH button on dev boards."],
    )

    # GPIO 1 — UART0 TX (serial output)
    pins[1] = PinInfo(
        name="1", gpio=1, is_uart0=True,
        can_analog=False, can_touch=False,
        has_internal_pullup=True, has_internal_pulldown=False,
        notes=["UART0 TX — used for serial output/programming. "
               "Using this pin breaks serial communication."],
    )

    # GPIO 2 — boot mode select, must be HIGH at boot
    # Often connected to onboard LED (active LOW)
    pins[2] = PinInfo(
        name="2", gpio=2, is_strapping=True,
        can_analog=False, can_touch=False,
        has_internal_pullup=True, has_internal_pulldown=False,
        strapping_warning="GPIO 2 must be HIGH at boot. "
                          "Often connected to onboard LED.",
        notes=["Onboard LED on most ESP8266 modules (active LOW)."],
    )

    # GPIO 3 — UART0 RX (serial input)
    pins[3] = PinInfo(
        name="3", gpio=3, is_uart0=True,
        can_analog=False, can_touch=False,
        has_internal_pullup=True, has_internal_pulldown=False,
        notes=["UART0 RX — used for serial input/programming."],
    )

    # GPIO 4 — general purpose, I2C SDA default
    pins[4] = PinInfo(
        name="4", gpio=4,
        can_analog=False, can_touch=False,
        has_internal_pullup=True, has_internal_pulldown=False,
        i2c_default="SDA",
    )

    # GPIO 5 — general purpose, I2C SCL default
    pins[5] = PinInfo(
        name="5", gpio=5,
        can_analog=False, can_touch=False,
        has_internal_pullup=True, has_internal_pulldown=False,
        i2c_default="SCL",
    )

    # GPIO 6-11 — connected to SPI flash (DO NOT USE)
    for i in range(6, 12):
        pins[i] = PinInfo(
            name=str(i), gpio=i, is_flash_pin=True, blocked=True,
            can_output=False, can_input=False, can_pwm=False,
            can_analog=False, can_touch=False,
            blocked_reason=f"GPIO {i} is connected to the SPI flash chip. "
                           "Using it will crash the ESP8266.",
        )

    # GPIO 12 — general purpose, HSPI MISO
    pins[12] = PinInfo(
        name="12", gpio=12,
        can_analog=False, can_touch=False,
        has_internal_pullup=True, has_internal_pulldown=False,
        spi_native="HSPI_MISO",
    )

    # GPIO 13 — general purpose, HSPI MOSI
    pins[13] = PinInfo(
        name="13", gpio=13,
        can_analog=False, can_touch=False,
        has_internal_pullup=True, has_internal_pulldown=False,
        spi_native="HSPI_MOSI",
    )

    # GPIO 14 — general purpose, HSPI CLK
    pins[14] = PinInfo(
        name="14", gpio=14,
        can_analog=False, can_touch=False,
        has_internal_pullup=True, has_internal_pulldown=False,
        spi_native="HSPI_CLK",
    )

    # GPIO 15 — boot mode select, must be LOW at boot
    # HSPI CS
    pins[15] = PinInfo(
        name="15", gpio=15, is_strapping=True,
        can_analog=False, can_touch=False,
        has_internal_pullup=True, has_internal_pulldown=False,
        spi_native="HSPI_CS",
        strapping_warning="GPIO 15 must be LOW during boot. "
                          "If HIGH, chip boots from SD card (not flash).",
        notes=["Must have external pull-down for reliable boot."],
    )

    # GPIO 16 — RTC domain, special behavior
    # Can wake from deep sleep. No interrupt support.
    # Different hardware register from GPIO 0-15.
    pins[16] = PinInfo(
        name="16", gpio=16,
        can_analog=False, can_touch=False, can_pwm=False,
        can_wake_deep_sleep=True,
        has_internal_pullup=False,   # RTC GPIO has pull-down only
        has_internal_pulldown=True,  # opposite of normal GPIOs
        notes=["RTC domain GPIO. Can wake from deep sleep. "
               "No interrupt support. Different register from GPIO 0-15. "
               "Often connected to onboard LED on NodeMCU."],
    )

    return pins


# Pre-built database
_PIN_DB = _build_pins()

# Derived sets
_SAFE_OUTPUT = [g for g, p in _PIN_DB.items()
                if p.can_output and not p.blocked and not p.is_uart0
                and not p.is_strapping]


@register
class ESP8266(ChipSpec, WiFiCapable):
    name = "esp8266"
    display_name = "ESP8266 (ESP-12E/F)"
    aliases = ["esp8266ex", "esp12"]
    arch = "xtensa-lx106"
    cores = 1
    ram_kb = 80
    flash_kb = 4096   # typical module (ESP-12E/F)
    sdk = "esp8266-rtos-sdk"
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
            "wifi", "pwm", "rtos", "hardware_timer", "deep_sleep", "adc",
        }
        # No bluetooth, no BLE, no touch, no DAC, no USB

    def available_tiers(self) -> list[str]:
        # FreeRTOS is bundled in ESP8266 RTOS SDK
        return ["background", "priority", "critical"]

    def validate_pin(self, pin_name: str, mode: str) -> list:
        errors = []
        pin = self.get_pin(pin_name)
        if pin is None:
            errors.append(("error",
                           f"GPIO {pin_name} does not exist on ESP8266. "
                           "ESP8266 has GPIO 0-16 only.",
                           f"Available output pins: {', '.join(str(p) for p in _SAFE_OUTPUT)}"))
            return errors
        if pin.blocked:
            errors.append(("error", pin.blocked_reason, None))
            return errors
        if pin.is_flash_pin:
            errors.append(("error",
                           f"GPIO {pin_name} is connected to SPI flash — using it will crash.",
                           f"Available output pins: {', '.join(str(p) for p in _SAFE_OUTPUT)}"))
        if mode == "Output" and not pin.can_output:
            errors.append(("error",
                           f"GPIO {pin_name} cannot be used as output.",
                           f"Available output pins: {', '.join(str(p) for p in _SAFE_OUTPUT)}"))
        if mode == "Analog":
            # ESP8266 has only ONE ADC pin — the dedicated TOUT/A0 pin
            # which is NOT a GPIO. ADC reads are done via system_adc_read()
            errors.append(("error",
                           f"GPIO {pin_name} is not an analog pin. ESP8266 has only one "
                           "ADC input (A0/TOUT) which is not a GPIO.",
                           "Use the dedicated A0 pin for analog reads."))
        if mode == "Touch":
            errors.append(("error",
                           "ESP8266 does not have capacitive touch pins.",
                           "Capacitive touch is available on ESP32."))
        if mode in ("Input.PullDown", "InputPullDown"):
            if pin.gpio != 16:
                errors.append(("error",
                               f"ESP8266 GPIOs 0-15 do not support pull-down. "
                               f"Only GPIO 16 (RTC domain) has internal pull-down.",
                               "Use an external pull-down resistor."))
        if mode in ("Input.PullUp", "InputPullUp") and not pin.has_internal_pullup:
            errors.append(("error",
                           f"GPIO {pin_name} has no internal pull-up (GPIO 16 is RTC domain).",
                           "Use an external pull-up resistor."))
        if pin.gpio == 16 and mode == "PWM":
            errors.append(("error",
                           "GPIO 16 does not support PWM (RTC domain, different hardware).",
                           f"PWM-capable pins: {', '.join(str(p) for p in _SAFE_OUTPUT)}"))
        if pin.is_strapping and pin.strapping_warning:
            errors.append(("warning", f"Strapping pin: {pin.strapping_warning}", None))
        if pin.is_uart0:
            errors.append(("warning",
                           f"GPIO {pin_name} is UART0 ({'TX' if pin.gpio == 1 else 'RX'}) — "
                           "using it will break serial communication.", None))
        return errors

    def get_safe_output_pins(self) -> list[str]:
        return [str(g) for g in _SAFE_OUTPUT]

    def get_adc2_gpios(self) -> set:
        return set()  # ESP8266 has no ADC2/WiFi conflict

    def get_rtc_gpios(self) -> set:
        return {16}   # only GPIO16 can wake from deep sleep

    def get_hal_dir(self) -> str:
        return "espressif"  # shared with ESP32
