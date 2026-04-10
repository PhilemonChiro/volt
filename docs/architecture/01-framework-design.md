# Framework Architecture Design

> **Status: IMPLEMENTED.** C framework running on ESP32 DevKit V1. Transpiler generating C from .volt files. 441 tests passing.

## Vision

Volt is a **typed, hardware-aware language** that transpiles to C for embedded microcontrollers, plus the C framework underneath. It sits between Arduino (too simple) and ESP-IDF/Zephyr (too complex). ESP32 is the first supported target.

**One-line pitch:** "A typed embedded language that compiles to C — catches hardware bugs at compile time, not at runtime."

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────┐
│         Developer writes .volt files         │
│     (typed DSL with hardware awareness)      │
├─────────────────────────────────────────────┤
│         Volt Transpiler (Python)             │
│  Parse → Type Check → Hardware Validate →    │
│  Generate C with #line directives            │
├─────────────────────────────────────────────┤
│              CLI Tool (volt)                 │
│    new / build / flash / monitor / test      │
├─────────────────────────────────────────────┤
│          Volt C Framework                    │
│  ┌──────┐ ┌──────┐ ┌─────┐ ┌─────┐        │
│  │ WiFi │ │ BLE  │ │MQTT │ │HTTP │        │
│  └──────┘ └──────┘ └─────┘ └─────┘        │
│  ┌──────┐ ┌──────┐ ┌─────┐ ┌─────┐        │
│  │ OTA  │ │ Log  │ │Timer│ │FS   │        │
│  └──────┘ └──────┘ └─────┘ └─────┘        │
├─────────────────────────────────────────────┤
│           Async Runtime (Scheduler)          │
│     Cooperative coroutine-based tasks        │
│     Zero-allocation, single-stack            │
├─────────────────────────────────────────────┤
│        Hardware Abstraction Layer (HAL)       │
│   GPIO / ADC / SPI / I2C / UART / PWM       │
├─────────────────────────────────────────────┤
│          Chip Support Package (CSP)          │
│   ┌──────────┐ ┌────────┐ ┌──────────┐    │
│   │  ESP32   │ │ RP2040 │ │ nRF52840 │    │
│   │ (WROOM)  │ │(future)│ │ (future) │    │
│   └──────────┘ └────────┘ └──────────┘    │
└─────────────────────────────────────────────┘
```

**Two paths for developers:**
- **Normal users** write `.volt` files — the transpiler generates C that calls the framework
- **Advanced users** can write raw C directly against the framework (skip the DSL)
- Both paths produce identical binaries with identical performance

---

## 2. Core Design Principles

### 2.1 Progressive Disclosure of Complexity

```volt
Level 1 — Volt DSL (what most users write):

    chip esp32
    hardware {
        pin led: Output = 2
    }
    task blink() {
        every 500ms {
            led.toggle()
        }
    }
    main {
        run(blink)
    }

Level 2 — Raw C against Volt framework (advanced users):

    #include "volt.h"
    void app_main(void) {
        pin_set_output(2);
        // Use C framework directly
    }

Level 3 — Escape hatch to raw registers (experts):

    raw {
        REG_WRITE(GPIO_OUT_REG, 1 << pin);
    }
```

Users start with `.volt` files and never touch C. Power users drop to C when needed. Experts access raw registers via `raw {}` blocks.

### 2.2 Async-First

Concurrent tasks are the default way to write firmware in Volt. No RTOS configuration, no stack sizing, no mutexes.

```volt
// In Volt — what developers write:
task sensor() {
    every 5seconds {
        let temp = bme.temperature()
        mqtt.send("home/temp", temp)
    }
}

task blink() {
    every 500ms {
        led.toggle()
    }
}

task buttons() {
    on button.press() debounce 50ms {
        log("Button pressed!")
    }
}

main {
    run(sensor, blink, buttons)
}
```

Under the hood, the transpiler generates C code using cooperative coroutines (protothreads / Duff's device). Zero dynamic allocation. See `02-async-runtime-deep-dive.md` for the C implementation details.

### 2.3 Batteries Included

Everything is built into the Volt language — no hunting for libraries:

```volt
// WiFi — one line, auto-reconnect handled internally
wifi.connect("MyNetwork", "password")

// MQTT — built-in
mqtt.connect("broker.example.com")
mqtt.send("sensors/temp", temp)
mqtt.on_receive("commands/#") { message in
    log("Got: {message}")
}

// OTA — one line
ota.enable()

// Logging — with string interpolation
log("temp={temp:.1f} humidity={hum:.0f}%")

// Storage — key-value, survives reboot
storage.save("calibration", cal_value)
let cal = storage.load("calibration")
```

For the C framework API that the transpiler targets, see `05-firmware-patterns.md`.

### 2.4 Beautiful CLI

```bash
# Create new project
$ volt new weather-station --chip esp32
  Creating project 'weather-station'...
  ✓ Project created at ./weather-station

# Build
$ volt build
  Compiling weather-station v0.1.0
  ✓ Built successfully (42.3 KB flash, 12.1 KB RAM)

# Flash
$ volt flash
  Flashing to /dev/ttyUSB0...
  ████████████████████████ 100%
  ✓ Flashed successfully

# Monitor (beautiful terminal UI, not raw serial)
$ volt monitor
  ┌─ weather-station @ esp32 ──────────────────┐
  │ 12:34:56.123 [INFO]  WiFi connected: 192.168.1.42
  │ 12:34:56.456 [INFO]  MQTT connected to broker
  │ 12:34:57.001 [DATA]  temp=23.5 humidity=67.2
  │ 12:34:58.001 [DATA]  temp=23.6 humidity=67.1
  └─────────────────────────────────────────────┘

# Test (run unit tests on host machine)
$ volt test
  Running 12 tests...
  ✓ test_sensor_calibration
  ✓ test_mqtt_reconnect
  ✓ test_ota_validation
  12/12 passed

# Show resource usage
$ volt size
  Flash: 42.3 KB / 4096 KB (1.0%)
  RAM:   12.1 KB / 512 KB  (2.4%)
  Tasks: 3 active, 0 suspended
```

---

## 3. Project Structure

The project has two main components: the C framework and the Volt transpiler.

```
volt/
├── compiler/                  # Volt transpiler (Python)
│   ├── voltc.py               # Main entry point
│   ├── grammar.lark           # PEG grammar definition
│   ├── parser.py              # Parse .volt → AST
│   ├── checker.py             # Type checking + hardware validation
│   ├── codegen.py             # AST → C code generation
│   ├── pins_esp32.py          # ESP32 pin database
│   └── errors.py              # Human-readable error messages
│
├── framework/                 # Volt C framework
│   ├── include/volt/          # Public headers
│   │   ├── volt.h             # Main include
│   │   ├── pin.h              # GPIO abstraction
│   │   ├── task.h             # Async task scheduler
│   │   ├── wifi.h             # WiFi wrapper
│   │   ├── mqtt.h             # MQTT client wrapper
│   │   ├── log.h              # Logging
│   │   ├── storage.h          # NVS key-value storage
│   │   ├── ota.h              # Over-the-air updates
│   │   └── error.h            # Error codes
│   ├── src/                   # Implementations
│   ├── drivers/               # Sensor/device drivers
│   └── targets/
│       └── esp32/             # ESP32 WROOM-32 HAL
│
├── cli/                       # CLI tool (volt new/build/flash/monitor)
├── examples/                  # Example .volt projects
└── tests/                     # Tests for compiler and framework
        ├── hal_spi.c
        ├── hal_i2c.c
        ├── hal_wifi.c
        └── chip.c           # Chip init, clock config
```

### 3.2 Driver Ecosystem (Community Contributions)

```
drivers/
├── sensors/
│   ├── bme280.c/.h          # Temp/humidity/pressure
│   ├── dht22.c/.h           # Temp/humidity
│   ├── bh1750.c/.h          # Light sensor
│   └── mpu6050.c/.h         # Accelerometer/gyroscope
├── displays/
│   ├── ssd1306.c/.h         # OLED 128x64
│   ├── st7789.c/.h          # TFT color display
│   └── hd44780.c/.h         # Character LCD
├── actuators/
│   ├── servo.c/.h           # Servo motor
│   └── stepper.c/.h         # Stepper motor
├── connectivity/
│   ├── sx1262.c/.h          # LoRa radio
│   ├── sim7000.c/.h         # Cellular modem
│   └── nrf24l01.c/.h        # 2.4GHz radio
└── storage/
    ├── sdcard.c/.h           # SD card via SPI
    └── w25qxx.c/.h           # External flash
```

Each driver follows a standard interface:
```c
// drivers/sensors/bme280.h
typedef struct {
    float temperature;
    float humidity;
    float pressure;
} bme280_data_t;

volt_err_t bme280_init(i2c_port_t port, uint8_t addr);
volt_err_t bme280_read(bme280_data_t *data);

// Async version
async volt_err_t bme280_read_async(bme280_data_t *data);
```

---

## 4. Async Runtime Design

### 4.1 Coroutine Implementation Options

**Option A: Protothreads-style (stackless, portable)**
```c
// Uses Duff's device / switch-case state machine
// Pro: Zero overhead, no stack per task, portable C
// Con: Can't use local variables across await points
#define async_task(name) void name(task_t *_task)
#define await(expr) do { _task->state = __LINE__; return; case __LINE__:; } while(!(expr))
#define async_begin() switch(_task->state) { case 0:
#define async_end() } _task->state = -1;
```

**Option B: setjmp/longjmp (stackful, more natural)**
```c
// Pro: Normal C code, local variables work, natural control flow
// Con: Requires stack per task (configurable, e.g., 2KB default)
```

**Option C: GCC computed goto (fast, GCC-specific)**
```c
// Pro: Fastest context switch, no function call overhead
// Con: GCC/Clang only (not MSVC, but we don't need MSVC for MCUs)
```

**Recommendation:** Start with Option A (protothreads-style) for portability and zero overhead. Provide Option B as an alternative for complex tasks. Both compile with any C compiler targeting MCUs.

### 4.2 Scheduler

```c
// Simple round-robin cooperative scheduler
// No preemption — tasks yield explicitly via await
// Priority levels optional (high/normal/low)
// Idle hook for power management (enter light sleep when all tasks waiting)

typedef struct {
    task_func_t func;
    task_state_t state;
    uint32_t wake_time;    // For sleep_ms()
    uint8_t priority;
} task_t;

void volt_run(task_t *tasks[], size_t count);
```

---

## 5. Build System

### 5.1 Based on CMake (Standard, IDE-Compatible)

```cmake
# CMakeLists.txt — minimal user-facing config
cmake_minimum_required(VERSION 3.20)

project(weather-station)

volt_app(
    TARGET weather-station
    CHIP esp32
    SOURCES src/main.c
    DRIVERS bme280 ssd1306
)
```

### 5.2 CLI Wraps CMake

Users never touch CMake directly:
```bash
$ volt build           # Runs cmake + ninja under the hood
$ volt build --release # Optimized build
$ volt build --size    # Show flash/RAM usage
```

### 5.3 User Project Structure

```
weather-station/
├── main.volt            # User's Volt source code
├── volt.toml            # Project config (chip, features)
├── drivers/             # Optional local .volt driver definitions
├── build/               # Generated C + build artifacts (gitignored)
│   ├── generated/       # .c files from transpiler
│   └── firmware.bin     # Final binary
└── .volt/               # Cached toolchain (gitignored)
```

### volt.toml
```toml
[project]
name = "weather-station"
version = "0.1.0"

[chip]
target = "esp32"
flash_size = "4MB"
clock = 240  # MHz

[wifi]
ssid = "MyNetwork"
password = "${WIFI_PASSWORD}"  # From environment variable
```

---

## 6. Testing Strategy

### 6.1 Host-Side Unit Tests

Framework provides a host-side HAL mock that allows running tests on the developer's machine without hardware:

```c
// tests/test_sensor.c
#include "volt_test.h"
#include "drivers/bme280.h"

TEST(bme280_init_returns_ok) {
    // Mock I2C to return device ID
    i2c_mock_read(BME280_CHIP_ID_REG, BME280_CHIP_ID);
    
    volt_err_t err = bme280_init(I2C_PORT_0, 0x76);
    ASSERT_EQ(err, VOLT_OK);
}

TEST(bme280_read_parses_correctly) {
    // Mock I2C to return known raw values
    i2c_mock_read_buf(BME280_DATA_REG, raw_data, sizeof(raw_data));
    
    bme280_data_t data;
    bme280_read(&data);
    
    ASSERT_FLOAT_NEAR(data.temperature, 23.5, 0.1);
}
```

### 6.2 On-Device Tests

```bash
$ volt test --device    # Flash test firmware, run on real hardware
```

---

## 7. Contribution Architecture

The framework is designed so that contributions are self-contained and easy to review:

### Easy contributions (new contributors):
- **Drivers:** .volt driver definition files (describe registers → get auto-generated driver)
- **Examples:** Complete .volt project in examples/ directory
- **Documentation:** Tutorials, guides

### Medium contributions:
- **Chip ports:** Add a new target/ directory with C HAL implementations
- **Transpiler features:** New syntax, type system extensions
- **CLI features:** New volt subcommands
- **Sensor/device types:** Add to the type registry (enables autocomplete)

### Hard contributions (core team):
- **Scheduler improvements:** Performance, priority support
- **LSP server:** Autocomplete, error highlighting in VS Code
- **Hardware validation rules:** Pin conflict detection, memory budgeting
- **State machine compiler:** Verification, dead-state detection

---

## 8. Comparison Table (for README)

| Feature | Arduino | ESP-IDF | Zephyr | ESPHome | **Volt** |
|---------|---------|---------|--------|---------|----------|
| Language | C++ | C | C | YAML | **Volt (typed DSL)** |
| Learning curve | 5 min | Weeks | Weeks | 30 min | **30 min** |
| Type safety | Partial (C++) | Minimal (C) | Minimal (C) | None | **Full (hardware-aware)** |
| Pin conflict detection | No | No | No | Partial | **Yes (compile-time)** |
| Multitasking | No | FreeRTOS | Yes (complex) | Single-threaded | **Async (simple)** |
| Built-in WiFi/MQTT | Libraries | Yes (complex) | Yes (complex) | YAML config | **Yes (simple)** |
| State machines | No | No | No | No | **Language feature** |
| OTA updates | No | Manual | Manual | Yes | **Built-in** |
| Memory reporting | No | No | No | No | **Yes** |
| Power estimation | No | No | No | No | **Yes** |
| IDE autocomplete | Arduino IDE | Limited | Limited | YAML schema | **Full LSP** |
| CLI tooling | Arduino IDE | idf.py | west | esphome | **volt** |
| Performance | Native | Native | Native | Native | **Native (compiles to C)** |
