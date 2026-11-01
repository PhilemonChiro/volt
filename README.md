<p align="center">
  <img src="assets/logo.png" alt="Volt" width="120">
</p>

<h1 align="center">Volt Embedded</h1>

<p align="center">
  <strong>Arduino is too simple. ESP-IDF is too complex. Volt is neither.</strong><br>
  A typed embedded language with automatic task scheduling, compile-time pin validation (hardware-aware), and first-class state machines.
</p>

<p align="center">
  <strong>New here?</strong>
  <a href="docs/GETTING_STARTED.md">Getting Started</a> · 
  <a href="docs/LANGUAGE_QUICK_REFERENCE.md">Quick Reference</a> · 
  <a href="docs/TROUBLESHOOTING.md">Troubleshooting</a><br>
  <a href="#examples">Examples</a> · 
  <a href="#what-the-compiler-catches">Error Detection</a> · 
  <a href="#architecture">Architecture</a> · 
  <a href="docs/architecture/06-volt-language-design.md">Language Spec</a>
</p>

---

## What is Volt?

Volt is a typed language that transpiles to C for embedded microcontrollers. You write clean, high-level code — the compiler knows your chip's datasheet:

- **Three-tier task scheduling** — one `task` keyword, auto-classified into background (protothreads, 12 bytes), priority (FreeRTOS, 4KB), or critical (hardware timer ISR)
- **Compile-time hardware validation** — pin conflicts, flash pins, input-only pins, ADC2/WiFi interference, ISR safety
- **First-class state machines** — `machine` / `state` with verified transitions, reachability analysis, and dead state detection
- **Bidirectional type checking** — full type inference with hardware-aware types
- **Zero overhead** — compiles to clean C, runs at native speed

## Onboarding Path

| Step | What you'll learn | Time |
|------|-------------------|------|
| [Getting Started](docs/GETTING_STARTED.md) | Blink an LED from scratch | 5 min |
| [Language Quick Reference](docs/LANGUAGE_QUICK_REFERENCE.md) | All syntax in one page | 2 min |
| [Troubleshooting Guide](docs/TROUBLESHOOTING.md) | Fix common errors fast | — |
| [Examples](#examples) | Real programs to learn from | — |
| [Full Language Spec](docs/architecture/06-volt-language-design.md) | Deep language reference | 15 min |

## Quick Install

**Volt IDE** (editor, wiring view, build, flash, serial monitor): download it from
[voltembedded.com](https://voltembedded.com).

**Command line** (macOS, Linux):

```bash
curl -fsSL https://voltembedded.com/install.sh | sh
volt new blink && cd blink
volt check               # type-check and validate the hardware
volt run                 # build, flash, then show the board's serial output
```

On Windows, download [volt-windows-amd64.zip](https://dl.voltembedded.com/latest/volt-windows-amd64.zip)
and put `volt.exe` on your `PATH`. Documentation: [docs.voltembedded.com](https://docs.voltembedded.com).
Try it in the browser: [play.voltembedded.com](https://play.voltembedded.com).

## Examples

New to Volt? Try the examples in this order:

| Example | Concepts | Difficulty |
|---------|----------|------------|
| [01-blink](examples/01-blink/) | Multiple pins, anonymous `every` blocks | Beginner |
| [03-state-blink](examples/03-state-blink/) | State machines | Beginner |
| [02-iot-sensor](examples/02-iot-sensor/) | WiFi + MQTT + ADC + PWM | Beginner |
| [07-safe-boot](examples/07-safe-boot/) | Try blocks, error recovery | Intermediate |
| [04-multi-state](examples/04-multi-state/) | Multiple state machines + tasks | Intermediate |
| [06-combined-all](examples/06-combined-all/) | Functions + state machines + storage | Intermediate |
| [05-stress-machine](examples/05-stress-machine/) | Sequencer + watchdog + ISR tasks | Advanced |
| [door-lock](examples/door-lock/) | Full product: state machine + MQTT + storage + channels | Advanced |
| [smart-led](examples/smart-led/) | PWM breathing + button input + shared state | Advanced |
| [weather-station](examples/weather-station/) | ADC + storage + deep sleep + MQTT telemetry | Advanced |

### Smart greenhouse — 3 task tiers from one keyword

```volt
chip esp32

hardware {
    pin fan: Output = 23
    pin heater: Output = 22
    pin pump: PWM = 4
    pin soil: Analog = 36
    pin temp: Analog = 39
}

task read_sensors() {
    every 2seconds {
        let moisture = soil.read()
        let temperature = temp.read()
        if moisture < 400 {
            pump.set_pwm(200)
        } else {
            pump.set_pwm(0)
        }
        if temperature > 800 {
            fan.on()
        } else {
            fan.off()
        }
    }
}

task log_data() {
    every 30seconds {
        storage.push("readings", soil.read())
        storage.push("readings", temp.read())
    }
}

task cloud_sync() {
    every 60seconds {
        if wifi.is_connected() {
            let data = storage.drain("readings")
            mqtt.send("greenhouse/data", data)
            http.post("https://api.farm.io/readings", data)
        }
    }
}

main {
    wifi.connect("FarmNet", "password")
    mqtt.connect("mqtt://broker.local")
    run(read_sensors, log_data, cloud_sync)
}
```

You wrote `task` three times. The compiler generated **two different execution models**:

| Task | Compiler decision | Memory cost |
|------|-------------------|-------------|
| `read_sensors` | **Background** protothread — no blocking calls | 12 bytes |
| `log_data` | **Background** protothread — local storage only | 12 bytes |
| `cloud_sync` | **Priority** FreeRTOS task — uses `mqtt.*` | 4KB stack |

In Arduino, this is 150+ lines. In ESP-IDF, it's 300+. In Volt, you don't even think about it.

**Built for devices that run for years:** `storage.push()` writes to RAM — zero flash wear. The flush timer batches everything into one write every 30 seconds. But if WiFi is up, `drain()` sends the data over MQTT/HTTP and clears the list before it ever touches flash. Flash is the backup path, not the primary path. Typical NVS flash survives ~100,000 erase cycles — this approach keeps your device running for years, not months.

### Door lock — state machine with compile-time verification

```volt
chip esp32

hardware {
    pin lock: Output = 23
    pin buzzer: PWM = 18
    pin button: Input = 4
}

machine DoorLock {
    let attempts: int = 0

    initial state locked {
        enter {
            lock.off()
            buzzer.set_pwm(0)
        }
        on valid_code -> unlocked
        on wrong_code -> alarming when attempts > 3
        on wrong_code -> locked
    }

    state unlocked {
        enter {
            lock.on()
        }
        after 10seconds -> locked
        on button_press -> locked
    }

    state alarming {
        enter {
            buzzer.set_pwm(255)
        }
        exit {
            buzzer.set_pwm(0)
        }
        after 30seconds -> locked
        on master_code -> locked
    }
}
```

The compiler **proves at compile time**:
- All states are reachable (no dead code)
- Every transition target exists (no typo = `-> loccked`)
- Guards are deterministic (no ambiguous `wrong_code` with overlapping conditions)
- Entry/exit actions are ISR-safe

Try doing that with a `switch` statement and a `state` variable.

### Connected motor controller — all three tiers working together

```volt
chip esp32

hardware {
    pin motor: PWM = 4
    pin encoder: Analog = 34
    pin temp_sensor: Analog = 36
    pin fault_led: Output = 2
}

var setpoint: int = 1000
var integral: int = 0
var last_error: int = 0

let kp: int = 10
let ki: int = 2
let kd: int = 5

task pid_loop() {
    every 1ms strict {
        let actual = encoder.read()
        let error = setpoint - actual
        integral = integral + error
        let derivative = error - last_error
        let output = kp * error + ki * integral + kd * derivative
        last_error = error

        if output > 255 {
            output = 255
        }
        if output < 0 {
            output = 0
        }
        motor.set_pwm(output)
    }
}

task thermal_protect() {
    every 500ms {
        let temp = temp_sensor.read()
        if temp > 800 {
            fault_led.on()
            motor.set_pwm(0)
            setpoint = 0
        }
    }
}

task report() {
    every 10seconds {
        mqtt.send_int("motor/speed", encoder.read())
        mqtt.send_int("motor/temp", temp_sensor.read())
        mqtt.send_int("motor/setpoint", setpoint)
    }
}

main {
    wifi.connect("Factory", "password")
    mqtt.connect("mqtt://10.0.1.50")
    run(pid_loop, thermal_monitor, report)
}
```

Real PID — error calculation, integral accumulation, derivative from last error, Kp/Ki/Kd gains, output clamping. And it runs as a **1ms hardware timer ISR** because of `strict` — never interrupted, never delayed. The thermal protection task can override by zeroing the setpoint. The telemetry task runs as a **FreeRTOS task** with its own stack for MQTT. All from the same `task` keyword. The compiler figured it out.

## What the Compiler Catches

```volt
pin motor: Output = 6        // ERROR: GPIO 6 is connected to SPI flash
pin sensor: Analog = 21      // ERROR: GPIO 21 has no ADC channel
pin led: Output = 34         // ERROR: GPIO 34-39 are input-only
pin a: Output = 2
pin b: Output = 2            // ERROR: GPIO 2 already used by 'a'

let x: int = "hello"         // ERROR: expected int, got string
led.read()                   // ERROR: Output pin has no method 'read'

// Inside a critical (ISR) task:
log("tick")                  // ERROR: log() not safe in ISR context
wifi.connect("a", "b")       // ERROR: wifi not safe in ISR context
```

Errors include source context, color highlighting, and "did you mean?" suggestions — inspired by Elm and Rust.

## Volt IDE

A desktop IDE in [`volt-ide/`](volt-ide/):

- **Editor** with live diagnostics, hover, completion and format on save
- **Wiring view** of the board and every pin in the `hardware` block
- **Diagrams** of state machines and task sequences, generated from the code
- **Build, flash and serial monitor** in one click; toolchains install themselves
- **Device library** with review and approval of every driver before it builds
- **Assistant** panel that can read, check and edit the open program, with per-action permissions

## Architecture

```
.volt source files
       │
       ▼
Volt Compiler (7-pass pipeline)
  ┌─ Parse ─────── Recursive-descent parser → AST
  ├─ Resolve ───── Name resolution, forward refs, "did you mean?"
  ├─ Check ─────── Bidirectional type checking, ErrorType poison
  ├─ Validate ──── Hardware: pins, ADC2/WiFi, ISR safety, flash pins
  ├─ Analyze ───── Task classification, yield analysis, shared state
  ├─ Transform ─── Variable lifting, function inlining, desugaring
  └─ Generate ──── Clean C with counter-based yield labels
       │
       ▼
Volt C Framework (8 modules)
  pin · task · wifi · mqtt · http · storage · log · error
       │
       ▼
ESP-IDF v5.4.1 → Target MCU
```

### Compiler passes

| Pass | Purpose | Key innovation |
|------|---------|---------------|
| Parse | Source → AST | Duration literals (`500ms`), state machine syntax |
| Resolve | Name binding | Two-pass for forward references, Levenshtein suggestions |
| Check | Type safety | Bidirectional inference, ErrorType poison prevents cascading |
| Validate | Hardware rules | Full ESP32 pin database — flash pins, strapping, ADC2/WiFi |
| Analyze | Task classification | Auto-detects blocking calls, `strict`, yield points |
| Transform | IR lowering | Auto-lifts variables across yields to context structs |
| Generate | AST → C | Three-tier code patterns, counter-based protothread labels |

### C Framework

| Module | Features |
|--------|----------|
| `pin` | GPIO with output state tracking, ISR handlers, pullup/pulldown |
| `task` | Three-tier scheduler: protothreads + FreeRTOS + hardware timers |
| `wifi` | Auto-reconnect with non-blocking timer, connection stats |
| `mqtt` | Pub/sub with auth, input validation, subscription table |
| `http` | GET/POST with TLS (certificate bundle) |
| `storage` | NVS with write coalescing, boot loop detection, factory reset |
| `log` | Colored timestamped output with module tags |
| `error` | 26 specific error codes across all modules |

## Project Structure

```
volt/
├── framework/              C runtime (GPL-3.0)
│   ├── include/volt/       Public headers
│   ├── esp32/              ESP32 (ESP-IDF) implementation
│   └── rp2040/             RP2040 (Pico SDK) implementation
├── devices/                Device drivers: sensors, displays, radios (GPL-3.0)
├── examples/               Example programs, beginner to advanced
├── volt-ide/               The desktop IDE (Electron)
└── docs/                   Guides and architecture notes
```

The compiler and the `volt` command line live in their own repositories:
[volt-compiler](https://github.com/PhilemonChiro/volt-compiler) and
[volt-cli](https://github.com/PhilemonChiro/volt-cli).

## Platform Layout

Volt installs to `~/.volt/` (like Cargo, Bun, Deno):

```
~/.volt/
├── bin/            CLI binary
├── sdk/            Framework headers + sources
├── toolchains/     ESP-IDF and cross-compilers
├── cache/          Build cache, downloads
└── config.toml     Global configuration
```

Works on Linux, macOS, and Windows.

## Comparison

| | Arduino | ESP-IDF | Zephyr | MicroPython | **Volt** |
|--|---------|---------|--------|-------------|----------|
| Language | C++ | C | C | Python | **Typed DSL** |
| Type safety | Partial | Minimal | Minimal | Runtime | **Compile-time** |
| Pin validation | None | None | None | None | **Compile-time** |
| ADC2/WiFi check | None | Runtime crash | None | Runtime crash | **Compile-time** |
| Task scheduling | Manual | Manual | Manual | Cooperative | **Automatic** |
| ISR safety | None | None | None | N/A | **Compile-time** |
| State machines | None | None | None | None | **Language feature** |
| Memory per task | 1KB+ | 4KB+ | 1KB+ | 4KB+ | **Automatic — see below** |
| Performance | Native | Native | Native | 10-100x slower | **Native** |

#### Volt task memory

| Task type | When the compiler picks it | Memory |
|-----------|---------------------------|--------|
| Background | No blocking calls | 12 bytes |
| Priority | Uses WiFi, MQTT, HTTP | 4KB |
| Critical | Marked `strict` (real-time) | Hardware timer |

## License

Volt is dual-licensed.

- The IDE and the rest of this repository: [GNU AGPL v3](LICENSE).
- The runtime framework ([`framework/`](framework/LICENSE)) and the device drivers ([`devices/`](devices/LICENSE)):
  [GNU GPL v3](framework/LICENSE). These are compiled into your firmware, so firmware you distribute is covered by the
  GPL too.
- A commercial licence is available for closed-source products: contact licensing@voltembedded.com.
- Windows builds are signed: see the [code signing policy](CODE_SIGNING.md).

Contributions are made under the [Contributor License Agreement](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md).
