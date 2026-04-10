"""
ESP32-WROOM-32 Pin Database

Complete hardware knowledge of every GPIO on the ESP32.
Used by hardware.py (Pass 4) to validate pin assignments at compile time.

Sources: ESP32 Datasheet, ESP32 Technical Reference Manual,
         ESP-IDF documentation, community-documented errata.
"""

from dataclasses import dataclass, field


@dataclass
class PinInfo:
    """Everything the compiler knows about a single GPIO."""
    gpio: int
    can_output: bool = True
    can_input: bool = True
    can_analog: bool = False
    can_touch: bool = False
    can_pwm: bool = True        # any output-capable pin via GPIO matrix
    can_wake_deep_sleep: bool = False  # RTC GPIO only
    has_internal_pullup: bool = True
    has_internal_pulldown: bool = True
    adc_unit: int = 0           # 0=none, 1=ADC1, 2=ADC2
    adc_channel: int = -1
    touch_channel: int = -1
    is_flash_pin: bool = False  # GPIO 6-11
    is_strapping: bool = False  # GPIO 0, 2, 5, 12, 15
    is_uart0: bool = False      # GPIO 1, 3
    is_jtag: bool = False       # GPIO 12, 13, 14, 15
    is_psram: bool = False      # GPIO 16, 17 on WROVER
    blocked: bool = False       # absolutely cannot use
    blocked_reason: str = ""
    strapping_warning: str = ""
    notes: list[str] = field(default_factory=list)
    # SPI native pins
    spi_native: str = ""        # "HSPI_MOSI", "VSPI_CLK", etc. or empty
    # I2C common defaults
    i2c_default: str = ""       # "SDA", "SCL" or empty


def build_pin_database() -> dict[int, PinInfo]:
    """Build the complete ESP32 pin database."""
    pins = {}

    # GPIO 0 — strapping, ADC2_CH1, Touch T1
    pins[0] = PinInfo(
        gpio=0, is_strapping=True, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=1, can_analog=True,
        can_touch=True, touch_channel=1,
        strapping_warning="GPIO 0 is a strapping pin. LOW at boot = download mode. "
                          "Ensure pull-up (internal or external) for normal boot.",
    )

    # GPIO 1 — UART0 TX
    pins[1] = PinInfo(
        gpio=1, is_uart0=True,
        notes=["Connected to USB-serial on DevKit. Using this pin breaks serial monitor/flashing."],
    )

    # GPIO 2 — strapping, ADC2_CH2, Touch T2, onboard LED on most DevKits
    pins[2] = PinInfo(
        gpio=2, is_strapping=True, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=2, can_analog=True,
        can_touch=True, touch_channel=2,
        strapping_warning="GPIO 2 is a strapping pin. Must be LOW or floating for download mode.",
    )

    # GPIO 3 — UART0 RX
    pins[3] = PinInfo(
        gpio=3, is_uart0=True,
        notes=["Connected to USB-serial on DevKit. Using this pin breaks serial monitor/flashing."],
    )

    # GPIO 4 — ADC2_CH0, Touch T0
    pins[4] = PinInfo(
        gpio=4, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=0, can_analog=True,
        can_touch=True, touch_channel=0,
    )

    # GPIO 5 — strapping, VSPI CS0
    pins[5] = PinInfo(
        gpio=5, is_strapping=True,
        spi_native="VSPI_CS0",
        strapping_warning="GPIO 5 is a strapping pin. Outputs PWM signal during boot. "
                          "Connected loads (relays, motors) may briefly activate.",
    )

    # GPIO 6-11 — SPI flash, BLOCKED
    for i in range(6, 12):
        pins[i] = PinInfo(
            gpio=i, blocked=True, is_flash_pin=True,
            can_output=False, can_input=False, can_analog=False,
            can_pwm=False, can_touch=False,
            has_internal_pullup=False, has_internal_pulldown=False,
            blocked_reason=f"GPIO {i} is connected to the SPI flash chip. Using it will crash the ESP32.",
        )

    # GPIO 12 — strapping (VDD_SDIO), JTAG MTDI, ADC2_CH5, Touch T5, HSPI MISO
    pins[12] = PinInfo(
        gpio=12, is_strapping=True, is_jtag=True, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=5, can_analog=True,
        can_touch=True, touch_channel=5,
        spi_native="HSPI_MISO",
        strapping_warning="GPIO 12 is a CRITICAL strapping pin. If pulled HIGH at boot, "
                          "VDD_SDIO switches to 1.8V, which CRASHES 3.3V flash chips. "
                          "Never connect a pull-up resistor. If using SD card on this pin, "
                          "burn the VDD_SDIO eFuse: espefuse.py set_flash_voltage 3.3V",
    )

    # GPIO 13 — JTAG MTCK, ADC2_CH4, Touch T4, HSPI MOSI
    pins[13] = PinInfo(
        gpio=13, is_jtag=True, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=4, can_analog=True,
        can_touch=True, touch_channel=4,
        spi_native="HSPI_MOSI",
    )

    # GPIO 14 — JTAG MTMS, ADC2_CH6, Touch T6, HSPI CLK
    pins[14] = PinInfo(
        gpio=14, is_jtag=True, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=6, can_analog=True,
        can_touch=True, touch_channel=6,
        spi_native="HSPI_CLK",
    )

    # GPIO 15 — strapping, JTAG MTDO, ADC2_CH3, Touch T3, HSPI CS0
    pins[15] = PinInfo(
        gpio=15, is_strapping=True, is_jtag=True, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=3, can_analog=True,
        can_touch=True, touch_channel=3,
        spi_native="HSPI_CS0",
        strapping_warning="GPIO 15 is a strapping pin. Outputs PWM signal during boot. "
                          "LOW at boot suppresses UART boot log messages.",
    )

    # GPIO 16 — PSRAM CS on WROVER modules
    pins[16] = PinInfo(
        gpio=16, is_psram=True,
        notes=["Free on WROOM-32. Reserved for PSRAM on WROVER modules."],
    )

    # GPIO 17 — PSRAM CLK on WROVER modules
    pins[17] = PinInfo(
        gpio=17, is_psram=True,
        notes=["Free on WROOM-32. Reserved for PSRAM on WROVER modules."],
    )

    # GPIO 18 — VSPI CLK
    pins[18] = PinInfo(gpio=18, spi_native="VSPI_CLK")

    # GPIO 19 — VSPI MISO
    pins[19] = PinInfo(gpio=19, spi_native="VSPI_MISO")

    # GPIO 20 — not available on ESP32-WROOM-32
    pins[20] = PinInfo(
        gpio=20, blocked=True,
        can_output=False, can_input=False,
        blocked_reason="GPIO 20 is not available on ESP32-WROOM-32.",
    )

    # GPIO 21 — common I2C SDA
    pins[21] = PinInfo(gpio=21, i2c_default="SDA")

    # GPIO 22 — common I2C SCL
    pins[22] = PinInfo(gpio=22, i2c_default="SCL")

    # GPIO 23 — VSPI MOSI
    pins[23] = PinInfo(gpio=23, spi_native="VSPI_MOSI")

    # GPIO 24 — not available on ESP32-WROOM-32
    pins[24] = PinInfo(
        gpio=24, blocked=True,
        can_output=False, can_input=False,
        blocked_reason="GPIO 24 is not available on ESP32-WROOM-32.",
    )

    # GPIO 25 — DAC1, ADC2_CH8
    pins[25] = PinInfo(
        gpio=25, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=8, can_analog=True,
        notes=["Also DAC channel 1. When DAC is enabled, outputs ~1.6V by default."],
    )

    # GPIO 26 — DAC2, ADC2_CH9
    pins[26] = PinInfo(
        gpio=26, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=9, can_analog=True,
        notes=["Also DAC channel 2. When DAC is enabled, outputs ~1.6V by default."],
    )

    # GPIO 27 — ADC2_CH7, Touch T7
    pins[27] = PinInfo(
        gpio=27, can_wake_deep_sleep=True,
        adc_unit=2, adc_channel=7, can_analog=True,
        can_touch=True, touch_channel=7,
    )

    # GPIO 28-31 — not available on ESP32-WROOM-32
    for i in range(28, 32):
        pins[i] = PinInfo(
            gpio=i, blocked=True,
            can_output=False, can_input=False,
            blocked_reason=f"GPIO {i} is not available on ESP32-WROOM-32.",
        )

    # GPIO 32 — ADC1_CH4, Touch T9, 32K_XP (crystal)
    pins[32] = PinInfo(
        gpio=32, can_wake_deep_sleep=True,
        adc_unit=1, adc_channel=4, can_analog=True,
        can_touch=True, touch_channel=9,
        notes=["Also 32kHz crystal pin (XTAL_32K_P). If external 32kHz crystal is used, this pin is unavailable."],
    )

    # GPIO 33 — ADC1_CH5, Touch T8, 32K_XN (crystal)
    pins[33] = PinInfo(
        gpio=33, can_wake_deep_sleep=True,
        adc_unit=1, adc_channel=5, can_analog=True,
        can_touch=True, touch_channel=8,
        notes=["Also 32kHz crystal pin (XTAL_32K_N). If external 32kHz crystal is used, this pin is unavailable."],
    )

    # GPIO 34-39 — Input only, no pull-up/pull-down, ADC1
    input_only = {
        34: (1, 6, ""),
        35: (1, 7, ""),
        36: (1, 0, "Hardware errata: interrupts on GPIO 36 may fire spuriously during WiFi/BT light sleep."),
        37: (1, 1, "Not exposed on most DevKit boards."),
        38: (1, 2, "Not exposed on most DevKit boards."),
        39: (1, 3, "Hardware errata: interrupts on GPIO 39 may fire spuriously during WiFi/BT light sleep."),
    }
    for gpio, (adc_u, adc_ch, note) in input_only.items():
        notes = []
        if note:
            notes.append(note)
        pins[gpio] = PinInfo(
            gpio=gpio,
            can_output=False, can_pwm=False,
            can_input=True, can_analog=True,
            has_internal_pullup=False, has_internal_pulldown=False,
            can_wake_deep_sleep=True,
            adc_unit=adc_u, adc_channel=adc_ch,
            notes=notes,
        )

    return pins


# Module-level database instance
PIN_DB: dict[int, PinInfo] = build_pin_database()

# VSPI native pins (for SPI speed validation)
VSPI_NATIVE = {23: "MOSI", 19: "MISO", 18: "CLK", 5: "CS0"}

# HSPI native pins
HSPI_NATIVE = {13: "MOSI", 12: "MISO", 14: "CLK", 15: "CS0"}

# RTC GPIOs (can wake from deep sleep)
RTC_GPIOS = {0, 2, 4, 12, 13, 14, 15, 25, 26, 27, 32, 33, 34, 35, 36, 37, 38, 39}

# ADC2 pins (blocked during WiFi)
ADC2_GPIOS = {0, 2, 4, 12, 13, 14, 15, 25, 26, 27}

# Safe output pins (for "available pins" suggestion in errors)
SAFE_OUTPUT_PINS = [2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33]
