"""
Volt ChipSpec — Base class for all chip specifications.

Every supported chip implements this interface. The compiler uses it for
hardware validation, code generation, capability checking, and build
manifest generation.

Adding a new chip = subclass ChipSpec + @register. Zero core changes.
"""

from dataclasses import dataclass, field


@dataclass
class PinInfo:
    """Everything the compiler knows about a single GPIO pin."""
    name: str = ""                  # display name: "2", "PA5", "GP25"
    gpio: int = -1                  # numeric GPIO (for ESP/RP2040)
    port: int = -1                  # port index: 0=A, 1=B, 2=C (for STM32)
    pin: int = -1                   # pin within port (for STM32)
    can_output: bool = True
    can_input: bool = True
    can_analog: bool = False
    can_touch: bool = False
    can_pwm: bool = True
    can_wake_deep_sleep: bool = False
    has_internal_pullup: bool = True
    has_internal_pulldown: bool = True
    adc_unit: int = 0               # 0=none, 1=ADC1, 2=ADC2
    adc_channel: int = -1
    is_flash_pin: bool = False
    is_strapping: bool = False
    is_uart0: bool = False
    is_jtag: bool = False
    blocked: bool = False
    blocked_reason: str = ""
    strapping_warning: str = ""
    notes: list[str] = field(default_factory=list)
    spi_native: str = ""
    i2c_default: str = ""


class ChipSpec:
    """Base class for all chip specifications."""

    # ---- Identity (override in subclass) ----
    name: str = ""
    display_name: str = ""
    aliases: list = []
    arch: str = ""
    cores: int = 1
    ram_kb: int = 0
    flash_kb: int = 0

    # ---- SDK / Build ----
    sdk: str = ""
    entry_point: str = "main"

    # ---- Pin Database ----

    def get_pin(self, name: str) -> PinInfo | None:
        """Look up a pin by name. Returns None if not found."""
        return None

    def all_pins(self) -> list[PinInfo]:
        """All available pins (non-blocked). Used for suggestions."""
        return []

    def parse_pin_name(self, name: str) -> dict | None:
        """Parse a pin name from source. Returns internal representation or None."""
        return None

    def format_pin_c(self, pin_name: str) -> str:
        """Generate C macro for this pin. e.g. VOLT_PIN(2), VOLT_PIN_PORT(2,13)"""
        return f"VOLT_PIN({pin_name})"

    # ---- Capabilities ----

    def supports(self, feature: str) -> bool:
        """Does this chip support a feature?
        Features: wifi, bluetooth, ble, pwm, dac, touch, rtos,
                  hardware_timer, deep_sleep, usb, adc"""
        return False

    def available_tiers(self) -> list[str]:
        """Which task tiers this chip supports.
        Subset of ['background', 'priority', 'critical']."""
        return ["background"]

    # ---- Validation ----

    def validate_pin(self, pin_name: str, mode: str) -> list:
        """Check if a pin can do this mode. Returns list of (severity, message, hint)."""
        return []

    def validate_hardware(self, program, errors) -> None:
        """Run all chip-specific validation rules."""
        pass

    # ---- Code Generation ----

    def get_hal_dir(self) -> str:
        """Which HAL directory to use."""
        return "minimal"

    def get_safe_output_pins(self) -> list[str]:
        """Pin names safe for output. Used in error suggestions."""
        return []

    def get_adc2_gpios(self) -> set:
        """GPIOs on ADC2 (conflict with WiFi). Empty if not applicable."""
        return set()

    def get_rtc_gpios(self) -> set:
        """GPIOs that can wake from deep sleep."""
        return set()


# ---- Capability Mixins ----

class WiFiCapable:
    """Mixin for chips with WiFi hardware."""
    pass


class BluetoothCapable:
    """Mixin for chips with Bluetooth hardware."""

    def bt_supports_classic(self) -> bool:
        return False

    def bt_supports_ble(self) -> bool:
        return True
