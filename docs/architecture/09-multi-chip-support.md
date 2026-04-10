# 09 — Multi-Chip Support Architecture

## Overview

Volt's tagline is **"the compiler knows your chip's datasheet."** For that to hold on more than one chip, every layer of the platform — compiler, framework, CLI, build system — must cleanly separate what's universal from what's chip-specific.

This document defines the architecture that makes Volt work across multiple microcontroller families without sacrificing hardware awareness, type safety, or the "zero mystery code" principle.

### Supported Targets at Launch

| Chip | Architecture | SDK | RAM | Flash | WiFi | RTOS |
|------|-------------|-----|-----|-------|------|------|
| ESP32 (WROOM-32) | Xtensa LX6, dual-core | ESP-IDF v5.4 | 520 KB | 4 MB | Yes | FreeRTOS (bundled) |
| ESP8266 | Xtensa LX106, single-core | ESP8266 RTOS SDK v3.x | 80 KB | 1-4 MB | Yes | FreeRTOS (bundled) |
| STM32F103C8 (Blue Pill) | ARM Cortex-M3 | STM32 HAL | 20 KB | 64 KB | No | Optional |
| RP2040 (Raspberry Pi Pico) | ARM Cortex-M0+, dual-core | Pico SDK | 264 KB | 2 MB | No | Optional |

---

## Design Principles

### 1. Smart Logic Is Universal, Drivers Are Thin

The platform splits into two layers:

- **Common layer** — all the complex, battle-tested logic: protothread scheduler, write coalescing with dirty buffers, auto-reconnect with non-blocking timer, boot loop detection, output state tracking (the toggle fix), ISR context management, subscription tables. This code is pure C with no SDK calls. Written once, tested once, works on every chip.

- **HAL layer** — thin wrappers around each SDK's native calls. A HAL function is 5-15 lines of C. It does one thing: translate a Volt HAL call into the equivalent SDK call. No logic, no state, no complexity.

### 2. The Compiler Is the Tree-Shaker

The compiler parses the `.volt` source and knows exactly which modules are used. If a program doesn't use WiFi, the WiFi HAL is never compiled, the WiFi library is never linked, and WiFi is never initialized. The output is minimal by construction.

The compiler emits a **build manifest** alongside the generated C code. The CLI reads this manifest to compile only the files that are needed.

### 3. Adding a Chip = Adding Files, Never Modifying Existing Code

A new chip requires:
- One Python file in `src/volt/chips/` (pin database + capabilities + validation rules)
- One directory in `framework/hal/` (HAL function implementations)

Zero changes to the compiler core, the common framework, the CLI, or any other chip's files.

### 4. Adding a Board = Adding a TOML File, No Code

A board is a chip with a specific set of pins broken out and possibly an onboard LED or button. Board definitions are pure data (TOML), not code.

### 5. Capabilities Are Checked at Compile Time

If a Volt program uses `wifi.connect()` on a chip that has no WiFi, the compiler produces a clear error:

```
ERROR [line 8]: STM32F103 does not have WiFi hardware.
  8 |     wifi.connect("SSID", "pass")
    |     ^^^^ STM32F103 has no WiFi hardware

  Chips with WiFi: esp32, esp8266
```

Not a runtime crash. Not a linker error. A human-readable compiler message with suggestions.

---

## Architecture Layers

```
+---------------------------------------------+
|  Volt Source (.volt files)                   |
+---------------------------------------------+
          |
          v
+---------------------------------------------+
|  Volt Compiler (Python)                      |
|                                              |
|  src/volt/chips/                             |
|    base.py         ChipSpec base class       |
|    registry.py     Auto-discovers chips      |
|    esp32.py        Pin DB + capabilities     |
|    esp8266.py      Pin DB + capabilities     |
|    stm32f103.py    Pin DB + capabilities     |
|    rp2040.py       Pin DB + capabilities     |
|                                              |
|  src/volt/boards/                            |
|    esp32_devkit.toml                         |
|    bluepill.toml                             |
|    pico.toml                                 |
|                                              |
|  src/volt/compiler/                          |
|    hardware.py     Uses chip's PIN_DB        |
|    codegen.py      Adapts output per chip    |
|    analyzer.py     Adapts tiers per chip     |
+---------------------------------------------+
          |
          v  (generated C + build manifest)
+---------------------------------------------+
|  Volt C Framework                            |
|                                              |
|  include/volt/                               |
|    hal.h          HAL function declarations  |
|    pin.h          Public API (all chips)     |
|    task.h         Protothread macros         |
|    wifi.h         WiFi API (conditional)     |
|    mqtt.h         MQTT API (conditional)     |
|    storage.h      Storage API (all chips)    |
|    log.h          Logging (all chips)        |
|    error.h        Error codes (all chips)    |
|    volt.h         Master include             |
|                                              |
|  common/                                     |
|    pin.c          Output state tracking      |
|    task.c         Protothread scheduler      |
|    storage.c      Write coalescing + lists   |
|    wifi.c         Auto-reconnect + stats     |
|    mqtt.c         Subscription table         |
|    log.c          Timestamped printf         |
|    error.c        Error formatting           |
|                                              |
|  hal/                                        |
|    espressif/     ESP32 + ESP8266 shared     |
|    stm32/         STM32 HAL-based            |
|    rp2040/        Pico SDK-based             |
|    minimal/       Reference implementation   |
+---------------------------------------------+
          |
          v
+---------------------------------------------+
|  Native SDK                                  |
|  ESP-IDF / ESP8266 RTOS SDK /                |
|  STM32 HAL / Pico SDK                        |
+---------------------------------------------+
          |
          v
+---------------------------------------------+
|  Target MCU Hardware                         |
+---------------------------------------------+
```

---

## The HAL Contract — `hal.h`

Every chip implements exactly these functions. This is the only interface between the common layer and the per-chip drivers.

### Pin Functions (6 functions — every chip)

```c
// Initialize the GPIO subsystem (enable clocks, etc.)
void hal_gpio_init(void);

// Configure a pin as output (push-pull)
void hal_gpio_set_output(volt_pin_t pin);

// Configure a pin as input (floating)
void hal_gpio_set_input(volt_pin_t pin);

// Configure a pin as input with internal pull-up resistor
void hal_gpio_set_input_pullup(volt_pin_t pin);

// Write a digital value to an output pin (0 = LOW, 1 = HIGH)
void hal_gpio_write(volt_pin_t pin, int value);

// Read a digital value from a pin (returns 0 or 1)
int hal_gpio_read(volt_pin_t pin);
```

### Time Functions (3 functions — every chip)

```c
// Milliseconds since boot (wraps at ~49 days, use signed comparison)
uint32_t hal_millis(void);

// Blocking delay in milliseconds
void hal_delay_ms(uint32_t ms);

// Create a periodic timer that calls cb(arg) every period_us microseconds.
// Returns 0 on success, negative on error.
int hal_timer_create_periodic(uint32_t period_us, void (*cb)(void *), void *arg);
```

### Storage Functions (5 functions — every chip)

```c
// Initialize the storage backend (NVS on ESP, LittleFS on STM32/RP2040).
int hal_kv_init(void);

// Write a value to persistent storage.
// key: null-terminated string, max 15 chars.
// data: pointer to value. len: size in bytes.
int hal_kv_write(const char *key, const void *data, size_t len);

// Read a value from persistent storage.
// buf: output buffer. len: in = buffer size, out = bytes read.
int hal_kv_read(const char *key, void *buf, size_t *len);

// Delete a key from persistent storage.
int hal_kv_delete(const char *key);

// Check if a key exists without reading it.
bool hal_kv_exists(const char *key);
```

### RTOS Functions (2 functions — chips with FreeRTOS or equivalent)

```c
// Create a new task with its own stack.
// stack_bytes: stack size in bytes (HAL converts to words if needed).
int hal_task_create(void (*fn)(void *), const char *name, int stack_bytes, void *arg);

// Yield the current task for ms milliseconds.
void hal_task_delay_ms(uint32_t ms);
```

### WiFi Functions (4 functions — chips with WiFi hardware only)

```c
// Initialize the WiFi subsystem (netif, event loop, driver).
int hal_wifi_init(void);

// Connect to a WiFi network (station mode).
int hal_wifi_connect(const char *ssid, const char *password);

// Disconnect from WiFi.
void hal_wifi_disconnect(void);

// Check if currently connected and has an IP address.
bool hal_wifi_is_connected(void);
```

**Total: 20 functions.** Each is 5-15 lines of C per platform. The entire HAL for a new chip is 150-300 lines of C for a basic chip, 500-800 for a full-featured chip with WiFi.

---

## HAL Implementations — What the C Code Looks Like

### Pin — ESP32 vs STM32 vs RP2040

The same `hal_gpio_write(pin, 1)` call maps to completely different SDK calls:

```c
// --- hal/espressif/hal_pin.c ---
#include "driver/gpio.h"

void hal_gpio_write(volt_pin_t pin, int value) {
    gpio_set_level(pin.num, value);
}

void hal_gpio_set_output(volt_pin_t pin) {
    gpio_config_t cfg = {
        .pin_bit_mask = (1ULL << pin.num),
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&cfg);
}

int hal_gpio_read(volt_pin_t pin) {
    return gpio_get_level(pin.num);
}
```

```c
// --- hal/stm32/hal_pin.c ---
#include "stm32f1xx_hal.h"

// Port lookup table: port index -> GPIO peripheral
static GPIO_TypeDef *const PORT_MAP[] = { GPIOA, GPIOB, GPIOC, GPIOD, GPIOE };

// Clock enable for each port
static void enable_port_clock(uint8_t port) {
    switch (port) {
        case 0: __HAL_RCC_GPIOA_CLK_ENABLE(); break;
        case 1: __HAL_RCC_GPIOB_CLK_ENABLE(); break;
        case 2: __HAL_RCC_GPIOC_CLK_ENABLE(); break;
        case 3: __HAL_RCC_GPIOD_CLK_ENABLE(); break;
        case 4: __HAL_RCC_GPIOE_CLK_ENABLE(); break;
    }
}

void hal_gpio_write(volt_pin_t pin, int value) {
    HAL_GPIO_WritePin(PORT_MAP[pin.port], (1 << pin.num),
                      value ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

void hal_gpio_set_output(volt_pin_t pin) {
    enable_port_clock(pin.port);
    GPIO_InitTypeDef init = {
        .Pin   = (1 << pin.num),
        .Mode  = GPIO_MODE_OUTPUT_PP,
        .Pull  = GPIO_NOPULL,
        .Speed = GPIO_SPEED_FREQ_LOW,
    };
    HAL_GPIO_Init(PORT_MAP[pin.port], &init);
}

int hal_gpio_read(volt_pin_t pin) {
    return HAL_GPIO_ReadPin(PORT_MAP[pin.port], (1 << pin.num)) == GPIO_PIN_SET ? 1 : 0;
}
```

```c
// --- hal/rp2040/hal_pin.c ---
#include "hardware/gpio.h"

void hal_gpio_write(volt_pin_t pin, int value) {
    gpio_put(pin.num, value);
}

void hal_gpio_set_output(volt_pin_t pin) {
    gpio_init(pin.num);
    gpio_set_dir(pin.num, GPIO_OUT);
}

int hal_gpio_read(volt_pin_t pin) {
    return gpio_get(pin.num) ? 1 : 0;
}
```

### Storage — NVS (ESP) vs LittleFS (STM32/RP2040)

The common `storage.c` (write coalescing, dirty buffers, lists, mutex) calls `hal_kv_write()`. On ESP, this maps to NVS. On STM32/RP2040, it maps to LittleFS file operations.

```c
// --- hal/espressif/hal_storage.c ---
#include "nvs_flash.h"
#include "nvs.h"

static nvs_handle_t s_handle;

int hal_kv_init(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    if (err != ESP_OK) return -1;
    return nvs_open("volt", NVS_READWRITE, &s_handle) == ESP_OK ? 0 : -1;
}

int hal_kv_write(const char *key, const void *data, size_t len) {
    esp_err_t err = nvs_set_blob(s_handle, key, data, len);
    if (err != ESP_OK) return -1;
    return nvs_commit(s_handle) == ESP_OK ? 0 : -1;
}

int hal_kv_read(const char *key, void *buf, size_t *len) {
    return nvs_get_blob(s_handle, key, buf, len) == ESP_OK ? 0 : -1;
}

int hal_kv_delete(const char *key) {
    nvs_erase_key(s_handle, key);
    return nvs_commit(s_handle) == ESP_OK ? 0 : -1;
}

bool hal_kv_exists(const char *key) {
    nvs_type_t type;
    return nvs_find_key(s_handle, key, &type) == ESP_OK;
}
```

```c
// --- hal/stm32/hal_storage.c ---
// Uses LittleFS over STM32 HAL flash
#include "lfs.h"
#include "stm32f1xx_hal.h"

// LittleFS instance and config (flash callbacks omitted for brevity)
static lfs_t s_lfs;
static struct lfs_config s_cfg;

int hal_kv_init(void) {
    // Configure LittleFS over the last 4 pages of flash (4KB)
    s_cfg.read_size      = 4;
    s_cfg.prog_size      = 4;
    s_cfg.block_size     = 1024;    // STM32F1 page = 1KB
    s_cfg.block_count    = 4;
    s_cfg.cache_size     = 256;
    s_cfg.lookahead_size = 16;
    s_cfg.block_cycles   = 500;
    s_cfg.read  = stm32_lfs_read;   // wraps direct flash memory read
    s_cfg.prog  = stm32_lfs_prog;   // wraps HAL_FLASH_Program
    s_cfg.erase = stm32_lfs_erase;  // wraps HAL_FLASHEx_Erase
    s_cfg.sync  = stm32_lfs_sync;   // no-op (flash is synchronous)

    int err = lfs_mount(&s_lfs, &s_cfg);
    if (err) {
        lfs_format(&s_lfs, &s_cfg);
        err = lfs_mount(&s_lfs, &s_cfg);
    }
    return err;
}

int hal_kv_write(const char *key, const void *data, size_t len) {
    lfs_file_t file;
    if (lfs_file_open(&s_lfs, &file, key, LFS_O_WRONLY | LFS_O_CREAT | LFS_O_TRUNC) < 0)
        return -1;
    lfs_ssize_t written = lfs_file_write(&s_lfs, &file, data, len);
    lfs_file_close(&s_lfs, &file);
    return (written == (lfs_ssize_t)len) ? 0 : -1;
}

int hal_kv_read(const char *key, void *buf, size_t *len) {
    lfs_file_t file;
    if (lfs_file_open(&s_lfs, &file, key, LFS_O_RDONLY) < 0)
        return -1;
    lfs_ssize_t read = lfs_file_read(&s_lfs, &file, buf, *len);
    lfs_file_close(&s_lfs, &file);
    if (read < 0) return -1;
    *len = (size_t)read;
    return 0;
}

int hal_kv_delete(const char *key) {
    return lfs_remove(&s_lfs, key) == 0 ? 0 : -1;
}

bool hal_kv_exists(const char *key) {
    struct lfs_info info;
    return lfs_stat(&s_lfs, key, &info) == 0;
}
```

### Timer — Different on Every Platform

```c
// --- hal/espressif/hal_task.c ---
#include "esp_timer.h"

int hal_timer_create_periodic(uint32_t period_us, void (*cb)(void *), void *arg) {
    esp_timer_handle_t timer;
    esp_timer_create_args_t args = {
        .callback = cb,
        .arg = arg,
        .name = "volt_timer",
    };
    if (esp_timer_create(&args, &timer) != ESP_OK) return -1;
    return esp_timer_start_periodic(timer, period_us) == ESP_OK ? 0 : -1;
}

uint32_t hal_millis(void) {
    return (uint32_t)(esp_timer_get_time() / 1000);
}
```

```c
// --- hal/stm32/hal_task.c ---
#include "stm32f1xx_hal.h"

uint32_t hal_millis(void) {
    return HAL_GetTick();  // SysTick-based, 1ms resolution
}

void hal_delay_ms(uint32_t ms) {
    HAL_Delay(ms);
}

// Hardware timer for periodic callbacks (uses TIM2)
static void (*s_timer_cb)(void *) = NULL;
static void *s_timer_arg = NULL;

int hal_timer_create_periodic(uint32_t period_us, void (*cb)(void *), void *arg) {
    s_timer_cb = cb;
    s_timer_arg = arg;

    __HAL_RCC_TIM2_CLK_ENABLE();
    TIM_HandleTypeDef htim = {
        .Instance = TIM2,
        .Init.Prescaler = (HAL_RCC_GetPCLK1Freq() / 1000000) - 1,  // 1MHz tick
        .Init.Period = period_us - 1,
        .Init.CounterMode = TIM_COUNTERMODE_UP,
    };
    HAL_TIM_Base_Init(&htim);
    HAL_NVIC_SetPriority(TIM2_IRQn, 0, 0);
    HAL_NVIC_EnableIRQ(TIM2_IRQn);
    HAL_TIM_Base_Start_IT(&htim);
    return 0;
}

// IRQ handler calls the registered callback
void TIM2_IRQHandler(void) {
    if (__HAL_TIM_GET_FLAG(&htim, TIM_FLAG_UPDATE)) {
        __HAL_TIM_CLEAR_FLAG(&htim, TIM_FLAG_UPDATE);
        if (s_timer_cb) s_timer_cb(s_timer_arg);
    }
}
```

```c
// --- hal/rp2040/hal_task.c ---
#include "pico/stdlib.h"
#include "pico/time.h"

uint32_t hal_millis(void) {
    return (uint32_t)(time_us_64() / 1000);
}

void hal_delay_ms(uint32_t ms) {
    sleep_ms(ms);
}

static void (*s_timer_cb)(void *) = NULL;
static void *s_timer_arg = NULL;

static int64_t timer_callback_wrapper(alarm_id_t id, void *user_data) {
    uint32_t period_us = (uint32_t)(uintptr_t)user_data;
    if (s_timer_cb) s_timer_cb(s_timer_arg);
    return period_us;  // positive = reschedule in N microseconds
}

int hal_timer_create_periodic(uint32_t period_us, void (*cb)(void *), void *arg) {
    s_timer_cb = cb;
    s_timer_arg = arg;
    alarm_id_t id = add_alarm_in_us(period_us, timer_callback_wrapper,
                                     (void *)(uintptr_t)period_us, false);
    return id >= 0 ? 0 : -1;
}
```

---

## Entry Point Generation Per Chip

The codegen produces different `main.c` boilerplate depending on the chip.

### ESP32 / ESP8266

```c
// Generated by Volt compiler
#include "volt/volt.h"

void app_main(void) {
    hal_gpio_init();
    // hal_kv_init();     ← only if storage is used
    // hal_wifi_init();   ← only if WiFi is used

    // Pin configuration
    hal_gpio_set_output(VOLT_PIN(2));

    // User's main block
    // ...

    // Start scheduler
    volt_run();
}
```

### STM32F103

```c
// Generated by Volt compiler
#include "volt/volt.h"

// STM32 requires explicit clock and HAL initialization
extern void SystemClock_Config(void);

int main(void) {
    HAL_Init();
    SystemClock_Config();

    hal_gpio_init();
    // hal_kv_init();     ← only if storage is used

    // Pin configuration
    hal_gpio_set_output(VOLT_PIN_PORT(2, 13));  // PC13

    // User's main block
    // ...

    // Start scheduler (bare-metal protothread loop)
    volt_run();
}
```

### RP2040

```c
// Generated by Volt compiler
#include "volt/volt.h"

int main(void) {
    stdio_init_all();   // optional: USB/UART stdio

    hal_gpio_init();
    // hal_kv_init();     ← only if storage is used

    // Pin configuration
    hal_gpio_set_output(VOLT_PIN(25));

    // User's main block
    // ...

    // Start scheduler
    volt_run();
}
```

---

## The Pin Type — `volt_pin_t`

Different chips name pins differently. The `volt_pin_t` type unifies them:

```c
// include/volt/hal.h

typedef struct {
    uint8_t port;   // 0 for chips without ports (ESP32, RP2040)
                    // 0=A, 1=B, 2=C for STM32
    uint8_t num;    // Pin number within port
} volt_pin_t;

// Convenience macros
#define VOLT_PIN(n)          ((volt_pin_t){ .port = 0, .num = (n) })
#define VOLT_PIN_PORT(p, n)  ((volt_pin_t){ .port = (p), .num = (n) })
```

The compiler knows the chip's pin naming scheme and generates the right macro:

```volt
chip esp32
hardware { pin led: Output = 2 }
```
Generates: `hal_gpio_set_output(VOLT_PIN(2));`

```volt
chip stm32f103
hardware { pin led: Output = PC13 }
```
Generates: `hal_gpio_set_output(VOLT_PIN_PORT(2, 13));`

```volt
chip rp2040
hardware { pin led: Output = GP25 }
```
Generates: `hal_gpio_set_output(VOLT_PIN(25));`

---

## Chip Specification — Compiler Side

### ChipSpec Base Class

```python
# src/volt/chips/base.py

class ChipSpec:
    """Base class for all chip specifications.
    Every chip implements this interface. The compiler uses it for
    hardware validation, code generation, and capability checking."""

    # ---- Identity (override in subclass) ----
    name: str = ""                   # "esp32", "stm32f103", "rp2040"
    display_name: str = ""           # "ESP32 (WROOM-32)"
    arch: str = ""                   # "xtensa-lx6", "arm-cortex-m3"
    cores: int = 1
    ram_kb: int = 0
    flash_kb: int = 0

    # ---- SDK / Build ----
    sdk: str = ""                    # "esp-idf", "stm32hal", "pico-sdk"
    entry_point: str = "main"        # "app_main" for ESP-IDF

    # ---- Pin Database ----
    def get_pin(self, name: str):
        """Look up a pin by name (e.g., "2", "PA5", "GP25").
        Returns PinInfo or None."""
        raise NotImplementedError

    def all_pins(self) -> list:
        """All available pins. Used for error suggestions."""
        raise NotImplementedError

    def parse_pin_name(self, name: str):
        """Parse a pin name from Volt source into internal representation.
        ESP32: "2" -> gpio 2
        STM32: "PA5" -> port A, pin 5
        RP2040: "GP25" -> gpio 25"""
        raise NotImplementedError

    def format_pin_c(self, pin_name: str) -> str:
        """Generate C code for a pin reference.
        ESP32: "2" -> "VOLT_PIN(2)"
        STM32: "PC13" -> "VOLT_PIN_PORT(2, 13)"
        RP2040: "GP25" -> "VOLT_PIN(25)" """
        raise NotImplementedError

    # ---- Capabilities ----
    def supports(self, feature: str) -> bool:
        """Does this chip support a feature?
        Features: 'wifi', 'bluetooth', 'ble', 'pwm', 'dac', 'touch',
                  'rtos', 'hardware_timer', 'deep_sleep', 'usb'"""
        return False

    def available_tiers(self) -> list:
        """Which task tiers this chip supports.
        Returns subset of ['background', 'priority', 'critical']."""
        return ["background"]

    # ---- Validation ----
    def validate_pin(self, pin_name: str, mode: str) -> list:
        """Check if a pin can be used in a given mode.
        Returns list of CompilerError/CompilerWarning."""
        return []

    def validate_hardware(self, program) -> list:
        """Run all chip-specific validation rules.
        Called during Pass 4 (hardware validation)."""
        return []

    # ---- Code Generation ----
    def get_includes(self, modules_used: set) -> list:
        """Return list of C #include lines needed for the given modules."""
        return []

    def get_init_code(self, modules_used: set) -> list:
        """Return list of C statements for platform initialization."""
        return []

    # ---- Build ----
    def get_hal_dir(self) -> str:
        """Which HAL directory to use (e.g., 'espressif', 'stm32', 'rp2040')."""
        raise NotImplementedError

    def get_build_files(self, modules_used: set) -> dict:
        """Given modules used, return which files to compile.
        Returns { 'common': [...], 'hal': [...], 'sdk_deps': [...] }."""
        raise NotImplementedError
```

### Capability Mixins

Optional capabilities are added via Python mixins. A chip that has WiFi inherits `WiFiCapable`. A chip that doesn't, doesn't. The compiler checks `isinstance(chip, WiFiCapable)` before allowing WiFi API calls.

```python
# src/volt/chips/base.py (continued)

class WiFiCapable:
    """Mixin for chips with WiFi hardware."""

    def wifi_supports_sta(self) -> bool:
        return True

    def wifi_supports_ap(self) -> bool:
        return True

    def validate_wifi_usage(self, program) -> list:
        """Chip-specific WiFi validation (e.g., ADC2/WiFi conflict on ESP32)."""
        return []


class BluetoothCapable:
    """Mixin for chips with Bluetooth hardware."""

    def bt_supports_classic(self) -> bool:
        return False

    def bt_supports_ble(self) -> bool:
        return True
```

### Chip Registry

```python
# src/volt/chips/registry.py

_chips = {}

def register(cls):
    """Decorator. Each chip file uses @register on its class."""
    spec = cls()
    _chips[spec.name] = cls
    # Also register short aliases
    for alias in getattr(cls, 'aliases', []):
        _chips[alias] = cls
    return cls

def get_chip(name: str):
    """Called by the compiler when it sees 'chip esp32'."""
    name_lower = name.lower()
    if name_lower not in _chips:
        available = ", ".join(sorted(set(
            cls().name for cls in _chips.values()
        )))
        raise ValueError(f"Unknown chip '{name}'. Available: {available}")
    return _chips[name_lower]()

def all_chips() -> list:
    """All registered chip names (deduplicated)."""
    return sorted(set(cls().name for cls in _chips.values()))
```

### Example: ESP32 Chip Spec

```python
# src/volt/chips/esp32.py

from .base import ChipSpec, WiFiCapable, BluetoothCapable
from .registry import register

@register
class ESP32(ChipSpec, WiFiCapable, BluetoothCapable):
    name = "esp32"
    display_name = "ESP32 (WROOM-32)"
    aliases = ["esp32-wroom"]
    arch = "xtensa-lx6"
    cores = 2
    ram_kb = 520
    flash_kb = 4096
    sdk = "esp-idf"
    entry_point = "app_main"

    # Pin database (migrated from pins_esp32.py)
    _pins = { ... }  # gpio -> PinInfo

    def get_pin(self, name):
        try:
            gpio = int(name)
        except ValueError:
            return None
        return self._pins.get(gpio)

    def parse_pin_name(self, name):
        return int(name)

    def format_pin_c(self, pin_name):
        return f"VOLT_PIN({int(pin_name)})"

    def supports(self, feature):
        return feature in {
            "wifi", "bluetooth", "ble", "pwm", "dac", "touch",
            "rtos", "hardware_timer", "deep_sleep", "adc",
        }

    def available_tiers(self):
        return ["background", "priority", "critical"]

    def validate_pin(self, pin_name, mode):
        errors = []
        gpio = int(pin_name)
        pin = self._pins.get(gpio)
        if pin is None:
            errors.append(Error(f"GPIO {gpio} does not exist on ESP32"))
            return errors
        if pin.is_flash_pin:
            errors.append(Error(f"GPIO {gpio} is connected to SPI flash"))
        if mode == "Output" and not pin.can_output:
            errors.append(Error(f"GPIO {gpio} is input-only (34-39)"))
        # ... more rules
        return errors

    def validate_hardware(self, program):
        errors = []
        # ADC2/WiFi conflict
        # Strapping pin warnings
        # UART0 conflict
        # GPIO 36/39 interrupt errata
        # ... (migrated from hardware.py)
        return errors

    def bt_supports_classic(self):
        return True  # ESP32 has classic BT + BLE

    def get_hal_dir(self):
        return "espressif"

    def get_build_files(self, modules_used):
        common = ["pin.c", "task.c", "log.c", "error.c"]
        hal = ["hal_pin.c", "hal_task.c"]
        sdk_deps = []

        if "storage" in modules_used:
            common.append("storage.c")
            hal.append("hal_storage.c")
        if "wifi" in modules_used:
            common.append("wifi.c")
            hal.append("hal_wifi.c")
            sdk_deps.append("esp_wifi")
        if "mqtt" in modules_used:
            common.append("mqtt.c")
            sdk_deps.append("mqtt")
        if "http" in modules_used:
            sdk_deps.append("esp_http_client")

        return {"common": common, "hal": hal, "sdk_deps": sdk_deps}
```

### Example: STM32F103 Chip Spec

```python
# src/volt/chips/stm32f103.py

from .base import ChipSpec
from .registry import register

@register
class STM32F103(ChipSpec):
    name = "stm32f103"
    display_name = "STM32F103C8 (Blue Pill)"
    aliases = ["bluepill", "stm32"]
    arch = "arm-cortex-m3"
    cores = 1
    ram_kb = 20
    flash_kb = 64
    sdk = "stm32hal"
    entry_point = "main"

    def get_pin(self, name):
        # Parse "PA5", "PB3", "PC13"
        name = name.upper()
        if len(name) < 3 or name[0] != 'P':
            return None
        port = ord(name[1]) - ord('A')
        try:
            pin = int(name[2:])
        except ValueError:
            return None
        return self._pins.get((port, pin))

    def parse_pin_name(self, name):
        name = name.upper()
        port = ord(name[1]) - ord('A')
        pin = int(name[2:])
        return (port, pin)

    def format_pin_c(self, pin_name):
        port, pin = self.parse_pin_name(pin_name)
        return f"VOLT_PIN_PORT({port}, {pin})"

    def supports(self, feature):
        return feature in {
            "pwm", "hardware_timer", "deep_sleep", "adc", "usb",
        }
        # NOTE: no wifi, no bluetooth, no rtos (bare metal default)

    def available_tiers(self):
        # No RTOS by default — only protothreads + hardware timer
        return ["background", "critical"]

    def validate_pin(self, pin_name, mode):
        errors = []
        name = pin_name.upper()
        # JTAG pins: PA13, PA14, PA15, PB3, PB4
        jtag_pins = {"PA13", "PA14", "PA15", "PB3", "PB4"}
        if name in jtag_pins:
            errors.append(Warning(
                f"{name} is a JTAG/SWD pin — using it disables debugging"
            ))
        # BOOT1 pin: PB2
        if name == "PB2":
            errors.append(Warning(f"PB2 is the BOOT1 pin — affects boot mode"))
        return errors

    def get_hal_dir(self):
        return "stm32"
```

---

## Board Definitions — TOML Format

Boards are data files that restrict or annotate a chip's pin database.

```toml
# src/volt/boards/bluepill.toml

[board]
name = "bluepill"
chip = "stm32f103"
display_name = "STM32 Blue Pill (STM32F103C8T6)"

[board.pins]
# Onboard LED
LED = "PC13"

# Pins broken out on the board headers
available = [
    "PA0", "PA1", "PA2", "PA3", "PA4", "PA5", "PA6", "PA7",
    "PA8", "PA9", "PA10", "PA11", "PA12", "PA15",
    "PB0", "PB1", "PB3", "PB4", "PB5", "PB6", "PB7", "PB8",
    "PB9", "PB10", "PB11", "PB12", "PB13", "PB14", "PB15",
    "PC13", "PC14", "PC15",
]

[board.upload]
tool = "stlink"
address = "0x08000000"
```

```toml
# src/volt/boards/esp32_devkit.toml

[board]
name = "esp32-devkit"
chip = "esp32"
display_name = "ESP32 DevKit V1 (30-pin)"

[board.pins]
LED = "2"
BOOT = "0"

[board.upload]
tool = "esptool"
baud = 921600
```

```toml
# src/volt/boards/pico.toml

[board]
name = "pico"
chip = "rp2040"
display_name = "Raspberry Pi Pico"

[board.pins]
LED = "GP25"

[board.upload]
tool = "picotool"
# Alternative: tool = "uf2"
```

---

## Build Manifest — Compiler Output

When the compiler processes a `.volt` file, it outputs two things:

1. **Generated C code** (`main.c`)
2. **Build manifest** (`build.json`)

The CLI reads the build manifest to know exactly what to compile and link.

```json
{
    "chip": "esp32",
    "board": "esp32-devkit",
    "sdk": "esp-idf",
    "hal_dir": "espressif",
    "entry_point": "app_main",
    "modules_used": ["pin", "task", "wifi", "mqtt"],
    "task_tiers": ["background", "priority"],
    "common_files": ["pin.c", "task.c", "wifi.c", "mqtt.c", "log.c", "error.c"],
    "hal_files": ["hal_pin.c", "hal_task.c", "hal_wifi.c"],
    "sdk_components": ["driver", "esp_wifi", "mqtt"],
    "needs_rtos": true,
    "needs_timer": false,
    "needs_storage": false,
    "needs_littlefs": false
}
```

For a blink program on STM32:

```json
{
    "chip": "stm32f103",
    "board": "bluepill",
    "sdk": "stm32hal",
    "hal_dir": "stm32",
    "entry_point": "main",
    "modules_used": ["pin", "task"],
    "task_tiers": ["background"],
    "common_files": ["pin.c", "task.c", "log.c", "error.c"],
    "hal_files": ["hal_pin.c", "hal_task.c", "hal_init.c"],
    "sdk_components": [],
    "needs_rtos": false,
    "needs_timer": false,
    "needs_storage": false,
    "needs_littlefs": false
}
```

The blink program on STM32 compiles only 7 C files. No WiFi stack, no MQTT, no storage, no FreeRTOS. Binary is under 20KB.

---

## Build System Per Platform

Each SDK uses CMake but configured differently. The CLI generates the appropriate `CMakeLists.txt` based on the build manifest.

### ESP-IDF (ESP32 / ESP8266)

```cmake
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(volt_app)
```

```cmake
# main/CMakeLists.txt — generated from build manifest
idf_component_register(
    SRCS
        "main.c"
        "common/pin.c"
        "common/task.c"
        "common/wifi.c"
        "common/mqtt.c"
        "common/log.c"
        "common/error.c"
        "hal/espressif/hal_pin.c"
        "hal/espressif/hal_task.c"
        "hal/espressif/hal_wifi.c"
    INCLUDE_DIRS "." "include"
    REQUIRES driver esp_wifi mqtt
)
```

Build: `idf.py build`
Flash: `idf.py -p /dev/ttyUSB0 flash`

### Pico SDK (RP2040)

```cmake
cmake_minimum_required(VERSION 3.13)
include($ENV{PICO_SDK_PATH}/external/pico_sdk_import.cmake)

project(volt_app C CXX ASM)
pico_sdk_init()

add_executable(volt_app
    main.c
    common/pin.c
    common/task.c
    common/log.c
    common/error.c
    hal/rp2040/hal_pin.c
    hal/rp2040/hal_task.c
)

target_include_directories(volt_app PRIVATE . include)
target_link_libraries(volt_app pico_stdlib hardware_gpio hardware_timer)

pico_add_extra_outputs(volt_app)
```

Build: `cmake -B build && cmake --build build`
Flash: `picotool load build/volt_app.uf2 --execute` or drag-and-drop UF2

### STM32 HAL

```cmake
cmake_minimum_required(VERSION 3.16)
set(CMAKE_TOOLCHAIN_FILE ${CMAKE_SOURCE_DIR}/toolchain-stm32f1.cmake)

project(volt_app C ASM)

set(MCU_FLAGS "-mcpu=cortex-m3 -mthumb -mfloat-abi=soft")
set(CMAKE_C_FLAGS "${MCU_FLAGS} -DSTM32F103xB -DUSE_HAL_DRIVER")

add_executable(volt_app.elf
    main.c
    common/pin.c
    common/task.c
    common/log.c
    common/error.c
    hal/stm32/hal_pin.c
    hal/stm32/hal_task.c
    hal/stm32/hal_init.c
    startup_stm32f103xb.s
    Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal.c
    Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal_gpio.c
    Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal_rcc.c
    Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal_cortex.c
    Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal_tim.c
)

target_include_directories(volt_app.elf PRIVATE
    . include
    Drivers/STM32F1xx_HAL_Driver/Inc
    Drivers/CMSIS/Device/ST/STM32F1xx/Include
    Drivers/CMSIS/Include
)

target_link_options(volt_app.elf PRIVATE
    -T${CMAKE_SOURCE_DIR}/STM32F103C8Tx_FLASH.ld
    -Wl,--gc-sections
    -specs=nano.specs -specs=nosys.specs
)

add_custom_command(TARGET volt_app.elf POST_BUILD
    COMMAND arm-none-eabi-objcopy -O binary volt_app.elf volt_app.bin
)
```

Build: `cmake -B build && cmake --build build`
Flash: `st-flash write build/volt_app.bin 0x08000000`

---

## Toolchain Installation Per Platform

The CLI (`volt setup`) handles toolchain installation:

| Platform | Compiler | Install method |
|---|---|---|
| ESP32 | `xtensa-esp32-elf-gcc` | `esp-idf/install.sh` (managed by Volt in `~/.volt/toolchains/`) |
| ESP8266 | `xtensa-lx106-elf-gcc` | ESP8266 RTOS SDK `install.sh` |
| STM32 | `arm-none-eabi-gcc` | System package (`apt`, `brew`, or ARM download) |
| RP2040 | `arm-none-eabi-gcc` | Same binary as STM32 — shared toolchain |

Note: STM32 and RP2040 share the same compiler (`arm-none-eabi-gcc`). Installing once covers both.

---

## Flash/Upload Commands

| Platform | Tool | Command |
|---|---|---|
| ESP32 | `esptool.py` | `esptool.py --chip esp32 --port PORT write_flash 0x10000 app.bin` |
| ESP8266 | `esptool.py` | `esptool.py --chip esp8266 --port PORT write_flash 0x0 app.bin` |
| STM32 | `st-flash` | `st-flash write app.bin 0x08000000` |
| RP2040 | `picotool` | `picotool load app.uf2 --execute` |
| RP2040 | UF2 drag-drop | Copy `.uf2` to `RPI-RP2` USB drive |

---

## Task Tier Availability Per Chip

| Tier | ESP32 | ESP8266 | STM32F103 | RP2040 |
|------|-------|---------|-----------|--------|
| **Background** (protothread, 12 bytes) | Yes | Yes | Yes | Yes |
| **Priority** (FreeRTOS task, 4KB) | Yes (bundled) | Yes (bundled) | Optional (add FreeRTOS) | Optional (FreeRTOS or Core 1) |
| **Critical** (hardware timer ISR) | Yes (esp_timer) | Yes (hw_timer) | Yes (TIMx) | Yes (alarm_pool) |

On STM32F103 with only 20KB RAM, the priority tier is disabled by default. Background protothreads (12 bytes each) and critical hardware timer ISRs are the primary execution models. FreeRTOS can be enabled but each task consumes ~512 bytes minimum.

On RP2040, the priority tier can use native dual-core (`multicore_launch_core1`) instead of FreeRTOS. One priority task runs on Core 1, background tasks run on Core 0. Zero RTOS overhead.

---

## ESP32 and ESP8266 — Shared HAL

The research confirmed that ESP8266 RTOS SDK v3.x mirrors ESP-IDF v3.x. The function names are identical for GPIO, NVS, FreeRTOS, and WiFi core operations.

### Differences requiring `#ifdef`

| Feature | ESP32 | ESP8266 | HAL impact |
|---|---|---|---|
| `pin_bit_mask` type | `uint64_t` | `uint32_t` | Cast in HAL |
| GPIO pull-down | Supported | Not supported (silently ignored) | Compiler warning |
| `xTaskCreatePinnedToCore` | Available | Not available | Use `xTaskCreate` for both |
| WiFi netif layer | `esp_netif_init()` | `tcpip_adapter_init()` | `#ifdef` in hal_wifi.c |
| Event handler signature | New-style (base + id) | Old-style (system_event_t) | `#ifdef` in hal_wifi.c |
| Bluetooth | Available | Not available | Compiler rejects BT on ESP8266 |
| ADC2/WiFi conflict | Yes | No (only 1 ADC channel) | Chip-specific validation |

Total `#ifdef` code: ~50 lines across 2 files. Both chips use the `espressif/` HAL directory.

---

## The Minimal Target — Reference HAL

A `minimal/` HAL directory serves as documentation and test harness. It implements the absolute minimum: GPIO + delay. No WiFi, no storage, no RTOS.

```c
// hal/minimal/hal_pin.c
// Reference implementation — replace with your chip's SDK calls

static uint8_t pin_state[32] = {0};

void hal_gpio_init(void) { /* nothing */ }
void hal_gpio_set_output(volt_pin_t pin) { /* nothing */ }
void hal_gpio_set_input(volt_pin_t pin) { /* nothing */ }
void hal_gpio_set_input_pullup(volt_pin_t pin) { /* nothing */ }

void hal_gpio_write(volt_pin_t pin, int value) {
    pin_state[pin.num] = value;
    // YOUR SDK CALL HERE: e.g., gpio_set_level(pin.num, value);
}

int hal_gpio_read(volt_pin_t pin) {
    return pin_state[pin.num];
    // YOUR SDK CALL HERE: e.g., return gpio_get_level(pin.num);
}
```

Anyone porting Volt to a new chip starts by copying `minimal/` and replacing the stub implementations with real SDK calls.

---

## How to Add a New Chip (Step by Step)

### Step 1: Create the chip specification

Create `src/volt/chips/your_chip.py`:

```python
from .base import ChipSpec
from .registry import register

@register
class YourChip(ChipSpec):
    name = "your_chip"
    display_name = "Your Chip Name"
    arch = "arm-cortex-m4"
    cores = 1
    ram_kb = 256
    flash_kb = 512
    sdk = "your-sdk"
    entry_point = "main"

    def get_pin(self, name): ...
    def format_pin_c(self, pin_name): ...
    def supports(self, feature): ...
    def available_tiers(self): ...
    def validate_pin(self, pin_name, mode): ...
    def get_hal_dir(self): return "your_chip"
    def get_build_files(self, modules_used): ...
```

### Step 2: Create the HAL directory

Copy `framework/hal/minimal/` to `framework/hal/your_chip/` and replace stubs with your SDK calls.

### Step 3: Create a board definition

Create `src/volt/boards/your_board.toml` with pin mappings and upload tool configuration.

### Step 4: Test

```bash
volt new test-project --chip your_chip
volt check
volt build
volt flash
```

**Zero changes to the compiler, the common framework, the CLI, or any other chip's files.**

---

## Design Decisions and Rationale

### Why STM32 HAL over libopencm3?

STM32 HAL works across all STM32 families (F0, F1, F4, L4, H7). libopencm3 has different GPIO APIs even between F1 (`gpio_set_mode`) and F4 (`gpio_mode_setup`) within the same library. HAL means one Volt backend covers dozens of STM32 chips — only clock config changes per family.

### Why LittleFS over raw flash for STM32/RP2040?

Raw flash requires erasing a full page (1KB on STM32F1, 4KB on RP2040) to write even one byte. LittleFS handles wear leveling, power-fail safety, and garbage collection — the same guarantees NVS provides on ESP. Our write coalescing layer sits on top of either NVS or LittleFS identically.

### Why shared Espressif HAL instead of separate ESP32/ESP8266?

ESP8266 RTOS SDK v3.x mirrors ESP-IDF v3.x by design. GPIO, NVS, FreeRTOS, and WiFi core APIs have identical function names. The differences are ~50 lines of `#ifdef`. Maintaining two separate HALs would duplicate 90% of the code.

### Why RP2040 dual-core instead of FreeRTOS?

The Pico SDK's `multicore_launch_core1()` runs a function on Core 1 with zero RTOS overhead. For Volt's "priority" tier, this is simpler and more deterministic than FreeRTOS. FreeRTOS on RP2040 is available as a fallback for programs needing more than 2 concurrent priority tasks.

### Why static allocation in the HAL?

Dynamic allocation (malloc) on embedded leads to heap fragmentation over time. A device running 24/7 for months will eventually fail if it fragments its heap. All HAL data structures use static allocation with generous but bounded limits. The storage module documents its limits in the header file.

### Why the compiler drives the build manifest?

The compiler already parses the AST and knows which modules are used. Generating a build manifest means the CLI doesn't need to duplicate this analysis. A blink program on STM32 compiles 7 files in 2 seconds. A full IoT program on ESP32 compiles the WiFi stack in 30 seconds. The build time matches the program complexity, not the platform size.

---

## Summary

The multi-chip architecture is built on five guarantees:

1. **The Volt language is the same on every chip.** `task`, `machine`, `pin`, `every`, `strict` — identical syntax, identical semantics. Only the generated C changes.

2. **The compiler catches chip-specific bugs.** Flash pins on ESP32, JTAG pins on STM32, ADC-only pins on RP2040 — each chip's datasheet constraints are encoded in its ChipSpec and validated at compile time.

3. **Common logic is written once.** Protothreads, write coalescing, auto-reconnect, boot loop detection — tested once, deployed on every chip.

4. **Per-chip code is thin.** The HAL contract is 20 functions. Each is 5-15 lines. A new chip HAL is 150-800 lines of C depending on features.

5. **The build output is minimal.** Only the modules your program uses are compiled. A blink program doesn't compile the WiFi stack. The compiler is the tree-shaker.
