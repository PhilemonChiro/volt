# Volt Language Design

## Overview

Volt is a typed, hardware-aware language that transpiles to C for embedded microcontrollers. It is NOT a general-purpose language — it is purpose-built for IoT firmware on ESP32 (and later other MCUs).

**Key principle:** The compiler understands your hardware. It catches wiring mistakes, pin conflicts, memory overflows, and type errors at compile time — before you flash.

---

## 1. Language Style

Go-like syntax: braces for blocks, no semicolons, clean and readable.

```volt
chip esp32

hardware {
    pin led: Output = 2
    pin button: Input.PullUp = 0
}

task blink() {
    every 500ms {
        led.toggle()
    }
}

main {
    run(blink)
}
```

### Why This Style
- **Braces** (not indentation) — unambiguous parsing, better tooling support, easy to autoformat
- **No semicolons** — cleaner to read, one statement per line
- **No curly-quote hell** — simple ASCII characters only
- **Dot notation everywhere** — enables autocomplete in IDEs
- **Keywords read like English** — `every`, `on`, `timeout`, `debounce`, `match`

---

## 2. Type System

### Primitive Types

```volt
int         // 32-bit signed integer
float       // 32-bit IEEE 754
bool        // true / false
string      // text (compiles to const char*)
byte        // 8-bit unsigned
```

### Hardware Types (built-in)

```volt
Pin.Output      // digital output
Pin.Input       // digital input
Pin.Input.PullUp    // with internal pull-up
Pin.Input.PullDown  // with internal pull-down
Pin.Analog      // analog input (ADC)
Pin.PWM         // PWM output
```

### Sensor Types (extensible)

```volt
BME280          // .temperature() -> float, .humidity() -> float, .pressure() -> float
DHT22           // .temperature() -> float, .humidity() -> float
BH1750          // .lux() -> float
SSD1306         // .clear(), .text(), .show()
SX1262          // .send(), .receive(), .on_receive()
CapacitiveSoil  // .read() -> int
```

### Communication Singletons

```volt
wifi            // .connect(), .disconnect(), .is_connected() -> bool
mqtt            // .send(), .on_receive(), .connect(), .is_connected() -> bool
serial          // .write(), .read(), .available() -> bool
storage         // .save(), .load(), .delete()
system          // .restart(), .id, .uptime()
ota             // .enable(), .check()
```

### Collections

```volt
list<int>           // typed list (stack-allocated, fixed max capacity)
buffer<128>         // byte buffer with known compile-time size
```

### User-Defined Structs

```volt
struct SensorData {
    temperature: float
    humidity: float
    timestamp: int
}

let data = SensorData {
    temperature: 23.5,
    humidity: 67.0,
    timestamp: system.uptime()
}
```

### Type Inference

```volt
let x = 42                  // inferred as int
let y = 3.14                // inferred as float
let name = "hello"          // inferred as string
let active = true           // inferred as bool
let temp = bme.temperature() // inferred as float (from return type)

let explicit: float = 42    // explicit type annotation
```

---

## 3. Core Syntax

### Variables

```volt
let x = 10              // immutable by default
var counter = 0          // mutable (must use 'var')
```

### Functions

```volt
func add(a: int, b: int) -> int {
    return a + b
}

func greet(name: string) {
    log("Hello, {name}")
}
```

### Control Flow

```volt
// If/else
if temperature > 30.0 {
    led.on()
} else if temperature > 20.0 {
    led.blink(1second)
} else {
    led.off()
}

// Match (like switch but safer — must be exhaustive)
match(PowerState.current) {
    .normal   -> sleep(10minutes)
    .low      -> sleep(30minutes)
    .critical -> sleep(1hour)
}

// While
while !wifi.is_connected() {
    led.blink(200ms)
    sleep(1second)
}

// For (range-based only)
for i in 0..10 {
    log("Count: {i}")
}
```

### Tasks (Async)

```volt
// Periodic task
task monitor() {
    every 5seconds {
        let temp = bme.temperature()
        mqtt.send("temp", temp)
    }
}

// Event-driven task
task buttons() {
    on button.press() debounce 50ms {
        led.toggle()
    }
}

// One-shot task with timeout
task connect() {
    wifi.connect("net", "pass") timeout 10seconds {
        log("WiFi failed")
        system.restart()
    }
}

// Run tasks concurrently
main {
    run(monitor, buttons, connect)
}
```

### Duration Literals

```volt
100us          // microseconds
500ms          // milliseconds
1second        // 1 second
5seconds       // 5 seconds
10minutes      // 10 minutes
1hour          // 1 hour
```

### String Interpolation

```volt
let temp = 23.5
log("Temperature: {temp}")              // basic
log("Temperature: {temp:.1f} degrees")  // formatted
```

---

## 4. Hardware Block

Declares all physical hardware connections. The compiler validates everything.

```volt
hardware {
    // Buses
    i2c sensors = i2c(sda: 21, scl: 22, speed: 400.khz)
    spi radio_bus = spi(mosi: 23, miso: 19, clk: 18, speed: 1.mhz)

    // Sensors on buses
    sensor bme: BME280 on sensors at 0x76
    sensor light: BH1750 on sensors at 0x23

    // Display on bus
    display oled: SSD1306 on sensors at 0x3C

    // Radio on bus
    radio lora: SX1262 on radio_bus cs: 5, reset: 14, busy: 27

    // Pins
    pin led: Output = 2
    pin button: Input.PullUp = 0
    pin battery: Analog = 36
    pin motor: PWM = 4
}
```

### What the Compiler Validates

1. Pin numbers exist on the target chip
2. Pin capabilities match usage (Output, Input, Analog, PWM)
3. No two devices use the same pin
4. No two I2C devices share the same address on the same bus
5. SPI chip-select pins are unique
6. Strapping pins (GPIO 0, 2, 5, 12, 15) generate warnings
7. Flash pins (GPIO 6-11) are rejected
8. Input-only pins (GPIO 34-39) reject Output/PWM usage
9. ADC2 pins generate warnings if WiFi is used
10. PSRAM pins (GPIO 16-17) rejected on WROVER modules

---

## 5. State Machines

First-class language feature for managing device states.

```volt
machine DeviceState {
    state idle {
        on button.press() -> connecting
        led.off()
    }

    state connecting {
        enter {
            led.blink(200ms)
            wifi.connect("net", "pass") timeout 10seconds -> error
        }
        on wifi.connected() -> running
    }

    state running {
        enter {
            led.on()
        }
        on wifi.disconnected() -> connecting

        every 5seconds {
            mqtt.send("status", "online")
        }
    }

    state error {
        enter {
            led.blink(100ms)
            log("Error state")
        }
        after 5seconds -> idle
    }
}
```

### Compiler Verifications

- All states are reachable from initial state
- No dead-end states (unless explicitly marked `terminal`)
- Transition targets exist
- `enter` blocks don't block indefinitely
- Timeout transitions have valid durations

---

## 6. Power Management

```volt
power {
    source: battery(3.7.v, 2000.mah)
    charging: solar
}

// Deep sleep (all RAM lost except storage variables)
deep_sleep(10minutes)

// Light sleep (RAM retained, WiFi maintainable)
light_sleep(5seconds)

// The compiler tracks what survives deep sleep:
storage counter: int = 0    // placed in RTC memory automatically
var temp_data: float = 0    // WARNING: lost on deep_sleep(), use 'storage' keyword
```

---

## 7. Store-and-Forward

Built-in offline data buffering for unreliable connectivity.

```volt
storage queue: list<SensorPacket> max: 48

// Auto-queue when offline
task report() {
    every 5minutes {
        let data = collect()

        if mqtt.is_connected() {
            mqtt.send("data", data)

            // Flush stored readings
            while queue.has_items() {
                mqtt.send("data", queue.pop())
            }
        } else {
            queue.push(data)
            log("Queued: {queue.count}/48")
        }
    }
}
```

---

## 8. Raw C Escape Hatch

For advanced users who need direct hardware access:

```volt
raw {
    #include "driver/mcpwm.h"

    void IRAM_ATTR motor_isr(void *arg) {
        // Direct register access for critical timing
        GPIO.out_w1ts = (1 << 4);
    }
}
```

Raw blocks are passed through to the generated C file verbatim. The compiler does not validate their contents.

---

## 9. Multi-Device (Fleet)

Describe a system of devices:

```volt
device gateway: esp32 {
    hardware {
        radio lora: SX1262 on spi(23, 19, 18) cs: 5
    }

    task collect() {
        on lora.receive() {
            let data = lora.data()
            mqtt.send("fleet/{data.id}", data.value)
        }
    }
}

device sensor_node: esp32 {
    hardware {
        sensor bme: BME280 on i2c(21, 22) at 0x76
        radio lora: SX1262 on spi(23, 19, 18) cs: 5
    }

    task report() {
        every 10minutes {
            lora.send(gateway, bme.temperature())
            deep_sleep(10minutes)
        }
    }
}
```

---

## 10. What Volt Generates

Every `.volt` file compiles to a `.c` file that uses the Volt C framework:

```volt
// Input: blink.volt
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
```

```c
// Output: blink.c (generated — do not edit)
#line 1 "blink.volt"
#include "volt.h"

#line 4 "blink.volt"
#define PIN_LED 2

#line 7 "blink.volt"
static void blink_task(task_t *_t) {
    switch(_t->_line) { case 0:
    while (1) {
#line 8 "blink.volt"
        pin_toggle(PIN_LED);
        _t->wake_at = volt_tick_ms() + 500;
        _t->_line = __LINE__; return; case __LINE__:
        if (volt_tick_ms() < _t->wake_at) return;
    }
    }
}

#line 12 "blink.volt"
void app_main(void) {
    volt_init();
    pin_set_output(PIN_LED);
    volt_run(blink_task, NULL);
}
```

The generated C is:
- Readable (an expert could maintain it)
- Zero overhead (no VM, no GC, no runtime type checks)
- Traceable (compiler errors point to .volt line numbers via #line)
- Identical performance to hand-written C

---

## 11. Compiler Error Messages

Volt errors are human-readable, not cryptic:

```
error[E001]: Invalid pin assignment
  --> main.volt:5:22
   |
 5 |     pin motor: Output = 6
   |                          ^
   | GPIO 6 is connected to the SPI flash chip and cannot be used.
   | Available output pins: 2, 4, 5, 12-19, 21-23, 25-27, 32-33

error[E002]: Type mismatch
  --> main.volt:12:25
   |
12 |     let name: string = bme.temperature()
   |                        ^^^^^^^^^^^^^^^^^
   | Expected 'string' but got 'float'
   | Hint: use string conversion: "{bme.temperature()}"

warning[W001]: ADC2 conflict with WiFi
  --> main.volt:18:15
   |
18 |     let val = adc.read(15)
   |               ^^^^^^^^^^^^
   | GPIO 15 is on ADC2, which is blocked while WiFi is active.
   | WiFi is connected at main.volt:9
   | Suggestion: use ADC1 pins (GPIO 32-39) instead.
```
