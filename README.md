<p align="center">
  <img src="assets/logo.png" alt="Volt" width="120">
</p>

<h1 align="center">Volt</h1>

<p align="center">
  <strong>Arduino is too simple. ESP-IDF is too complex. Volt is neither.</strong><br>
  A typed embedded language with automatic task scheduling, compile-time pin validation (hardware-aware), and first-class state machines.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> · 
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

## Quick Start

```bash
# Install
pip install volt-lang

# Create a project
volt new my-sensor
cd my-sensor

# Check for errors
volt check

# Build and flash (requires ESP-IDF)
volt build
volt flash
volt monitor
```

## Examples

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

task cloud_sync() {
    every 30seconds {
        storage.save("soil", soil.read())
        storage.save("temp", temp.read())
        if wifi.is_connected() {
            mqtt.send_int("greenhouse/soil", storage.load("soil"))
            mqtt.send_int("greenhouse/temp", storage.load("temp"))
        }
    }
}

main {
    wifi.connect("FarmNet", "password")
    mqtt.connect("mqtt://broker.local")
    run(read_sensors, motor_control, cloud_sync)
}
```

You wrote `task` twice. The compiler generated **two different execution models**:

| Task | Compiler decision | Memory cost |
|------|-------------------|-------------|
| `read_sensors` | **Background** protothread — no blocking calls | 12 bytes |
| `cloud_sync` | **Priority** FreeRTOS task — uses `mqtt.*` and `http.*` | 4KB stack |

In Arduino, this is 150+ lines. In ESP-IDF, it's 300+. In Volt, you don't even think about it.

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
    pin motor_a: PWM = 4
    pin motor_b: PWM = 5
    pin encoder: Input = 34
    pin temp_sensor: Analog = 36
    pin fault_led: Output = 2
}

task pid_loop() {
    every 1ms strict {
        let speed = encoder.read()
        motor_a.set_pwm(speed)
    }
}

task thermal_monitor() {
    every 500ms {
        let temp = temp_sensor.read()
        if temp > 800 {
            fault_led.on()
            motor_a.set_pwm(0)
            motor_b.set_pwm(0)
        }
    }
}

task report() {
    every 10seconds {
        mqtt.send_int("motor/speed", encoder.read())
        mqtt.send_int("motor/temp", temp_sensor.read())
    }
}

main {
    wifi.connect("Factory", "password")
    mqtt.connect("mqtt://10.0.1.50")
    run(pid_loop, thermal_monitor, report)
}
```

The PID loop runs as a **hardware timer ISR** — 1ms precision, never interrupted. The thermal monitor runs as a **12-byte protothread**. Telemetry runs as a **FreeRTOS task** with its own stack. All from the same `task` keyword. The compiler figured it out.

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

## VS Code Extension

Full development environment with:

- **Syntax highlighting** — 15+ semantic token categories
- **LSP** — autocomplete (dot-triggered methods, pin modes, durations), hover (pin info with ASCII pin map), real-time diagnostics
- **Sidebar panel** — build & flash buttons, serial monitor, device management, file browser
- **Format on save**

## Architecture

```
.volt source files
       │
       ▼
Volt Compiler (7-pass pipeline)
  ┌─ Parse ─────── Lark LALR(1) grammar → AST
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
├── src/volt/               Compiler (Python)
│   ├── compiler/           7-pass transpiler pipeline
│   ├── cli/                CLI tool (click-based)
│   └── paths.py            Cross-platform path resolution
├── framework/              C runtime (ESP-IDF components)
│   ├── include/volt/       Public headers
│   └── src/                Implementation
├── volt-vscode/            VS Code extension
│   ├── extension.js        Sidebar, commands, device polling
│   ├── server/             LSP server (pygls)
│   └── syntaxes/           TextMate grammar
├── tests/                  Compiler test suite (500+ tests)
├── examples/               6 example programs
└── docs/                   Architecture documentation
```

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
| Memory per task | 1KB+ | 4KB+ | 1KB+ | 4KB+ | **12 bytes** (background) |
| Performance | Native | Native | Native | 10-100x slower | **Native** |

## License

MIT
