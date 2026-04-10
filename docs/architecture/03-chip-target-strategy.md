# Chip Target Strategy

## Primary Target: ESP32 DevKit V1 (WROOM-32)

### Why ESP32 WROOM-32 First

1. **Most widely owned:** Millions of DevKit V1 boards in developers' hands worldwide
2. **Cheapest dev board:** $3-5 for clones, available everywhere
3. **Dual-core 240MHz:** Powerful enough for WiFi + application tasks
4. **WiFi + BLE 4.2:** Covers most IoT use cases
5. **Strong toolchain:** ESP-IDF is mature, we build on top of it
6. **Huge community:** Largest hobbyist + professional community in embedded
7. **Maximum adoption:** If Volt works on the board everyone already has, everyone can try it immediately

### What We Build On

Volt has two layers, both targeting ESP-IDF:

```
Developer writes .volt files
         ↓
Volt Transpiler (Python) — type checks, validates hardware, generates C
         ↓
Generated C code (uses Volt C Framework)
         ↓
Volt C Framework (our HAL, scheduler, drivers)
         ↓
ESP-IDF (WiFi stack, BLE stack, FreeRTOS)
         ↓
ESP32 WROOM-32 Hardware
```

We don't replace ESP-IDF — we layer on top. This means:
- All ESP32 features remain accessible via `raw {}` escape hatches
- We benefit from Espressif's ongoing WiFi/BLE stack improvements
- Advanced users can write raw C against our framework (skip the DSL)
- Build system uses ESP-IDF's CMake infrastructure under the hood
- The transpiler adds ~100ms to build time — GCC is always the bottleneck

---

## Secondary Targets (Community Contributions)

### Target 2: ESP32-S3

**Why:** Most popular ESP32 variant currently. Dual-core, AI capabilities.
**Effort:** LOW — same ESP-IDF base, just different peripheral set.
**Community:** Massive. Many existing projects.
**Timeline:** Month 2-3 (easy port from ESP32)

### Target 3: ESP32-C3

**Why:** Ultra-low-cost WiFi ($0.65 at 10K volume). Budget IoT nodes.
**Effort:** LOW — same ESP-IDF base, subset of features.
**Community:** Very large.
**Timeline:** Month 2-3

### Target 4: RP2040 / RP2350

**Why:** Brings the Raspberry Pi community. Different architecture = proves portability.
**Effort:** MEDIUM — different vendor SDK (Pico SDK vs ESP-IDF). No built-in WiFi.
**Community:** Large and enthusiastic.
**Timeline:** Month 4-6

### Target 5: nRF52840

**Why:** Ultra-low-power BLE. Professional IoT market. Nordic community.
**Effort:** MEDIUM-HIGH — nRF Connect SDK (Zephyr-based) is very different from ESP-IDF.
**Community:** Professional, engaged.
**Timeline:** Month 6-9

### Target 6: STM32 (U5 or WBA series)

**Why:** Largest MCU family by market share. Industrial and professional.
**Effort:** HIGH — STM32 HAL/LL is its own world. Many subfamilies.
**Community:** Massive but fragmented across subfamilies.
**Timeline:** Month 9-12

---

## HAL Abstraction Strategy

### Layered HAL Design

```
┌────────────────────────────────────┐
│  Volt HAL API (chip-agnostic)     │  ← Users interact with this
│  gpio_write(), i2c_read(), etc.    │
├────────────────────────────────────┤
│  Volt HAL Implementation          │  ← One per chip family
│  Maps Volt API → vendor API       │
├────────────────────────────────────┤
│  Vendor SDK                        │  ← ESP-IDF, Pico SDK, nRF Connect
│  Chip-specific code                │
└────────────────────────────────────┘
```

### HAL Interface Definition

```c
// volt/hal/gpio.h — chip-agnostic interface

typedef enum {
    GPIO_INPUT,
    GPIO_OUTPUT,
    GPIO_INPUT_PULLUP,
    GPIO_INPUT_PULLDOWN,
} gpio_mode_t;

typedef enum {
    GPIO_LOW = 0,
    GPIO_HIGH = 1,
} gpio_level_t;

typedef enum {
    GPIO_EDGE_RISING,
    GPIO_EDGE_FALLING,
    GPIO_EDGE_BOTH,
} gpio_edge_t;

// Core GPIO API
volt_err_t gpio_set_mode(uint8_t pin, gpio_mode_t mode);
volt_err_t gpio_write(uint8_t pin, gpio_level_t level);
gpio_level_t gpio_read(uint8_t pin);
volt_err_t gpio_toggle(uint8_t pin);

// Async GPIO
volt_err_t gpio_wait_for_edge(task_t *t, uint8_t pin, gpio_edge_t edge);

// ISR callback
typedef void (*gpio_isr_t)(uint8_t pin, void *arg);
volt_err_t gpio_attach_interrupt(uint8_t pin, gpio_edge_t edge, gpio_isr_t isr, void *arg);
```

### Chip Port Structure

```
targets/
├── esp32/
│   ├── hal_gpio.c        # GPIO implementation using ESP-IDF gpio driver
│   ├── hal_adc.c         # ADC implementation
│   ├── hal_i2c.c         # I2C implementation
│   ├── hal_spi.c         # SPI implementation
│   ├── hal_uart.c        # UART implementation
│   ├── hal_pwm.c         # PWM (LEDC) implementation
│   ├── hal_wifi.c        # WiFi using ESP-IDF wifi driver
│   ├── hal_ble.c         # BLE using NimBLE
│   ├── hal_timer.c       # Hardware timer for scheduler tick
│   ├── hal_flash.c       # Flash storage (NVS)
│   ├── hal_power.c       # Sleep modes, power management
│   ├── chip_init.c       # Chip initialization sequence
│   └── CMakeLists.txt    # Build integration
├── esp32s3/
│   └── ... (similar structure, different peripheral registers)
├── rp2040/
│   └── ... (uses Pico SDK underneath)
└── nrf52840/
    └── ... (uses nRF Connect SDK underneath)
```

### Adding a New Chip Port

Contributors adding a new chip target need to implement:

1. **Required (minimum viable port):**
   - `hal_gpio.c` — digital I/O
   - `hal_timer.c` — scheduler tick source
   - `chip_init.c` — clock, memory, basic setup
   - `CMakeLists.txt` — build integration

2. **Expected (useful port):**
   - `hal_adc.c` — analog input
   - `hal_i2c.c` — I2C bus
   - `hal_spi.c` — SPI bus
   - `hal_uart.c` — serial communication
   - `hal_pwm.c` — PWM output

3. **Full port:**
   - `hal_wifi.c` — WiFi (if chip has it)
   - `hal_ble.c` — BLE (if chip has it)
   - `hal_flash.c` — persistent storage
   - `hal_power.c` — sleep modes

This modular approach means a contributor can get a basic port working in a day (GPIO + timer), then incrementally add peripherals.

---

## ATmega328P Consideration

The ATmega328P (Arduino Uno's chip) is interesting as a statement of portability but has severe limitations:

| Spec | ATmega328P | ESP32 (WROOM-32) |
|------|-----------|------------------|
| Architecture | 8-bit AVR | 32-bit Xtensa LX6 dual-core |
| Clock | 16 MHz | 240 MHz |
| Flash | 32 KB | 4 MB |
| SRAM | 2 KB | 520 KB |
| WiFi | No | 802.11 b/g/n |
| BLE | No | BLE 4.2 |
| Price | ~$2.50 | ~$2.14 |

**Verdict:** The ATmega328P is obsolete for new designs. It's more expensive than an ESP32-C3 ($1.15) while being 100x less capable. Supporting it would:
- Severely limit framework features (2KB RAM can't run async scheduler + WiFi + MQTT)
- Force a "lowest common denominator" API
- Distract from the core value proposition

**However:** If someone wants to contribute an ATmega328P port as a proof of portability (GPIO + timers only, no networking), that's welcome. It just shouldn't be a priority.

---

## Build System Per Target

Each target integrates with its vendor's build system:

```
ESP32 family   → ESP-IDF CMake (idf.py build)
RP2040/RP2350  → Pico SDK CMake
nRF family     → nRF Connect SDK / west
STM32          → STM32CubeMX generated + CMake
```

The `volt` CLI abstracts this:
```bash
$ volt build --target esp32    # Uses ESP-IDF under the hood
$ volt build --target rp2040     # Uses Pico SDK under the hood
$ volt build --target nrf52840   # Uses nRF Connect SDK under the hood
```

Users don't need to know which build system runs underneath.
