# Volt — A Typed, Hardware-Aware Language for Embedded Systems

> **Write firmware in 15 lines. The compiler catches hardware bugs before you flash.**

Volt is a typed language that transpiles to C for embedded microcontrollers. It auto-classifies your tasks into three tiers (background/priority/critical), validates your pin assignments at compile time, catches type errors, and generates clean C with zero overhead. ESP32 is the first supported target, with more chips planned.

---

## Why Volt?

| | Arduino | ESP-IDF | Zephyr | ESPHome | **Volt** |
|--|---------|---------|--------|---------|----------|
| Language | C++ | C | C | YAML | **Volt (typed DSL)** |
| Type safety | Partial | Minimal | Minimal | None | **Full (hardware-aware)** |
| Pin conflict detection | No | No | No | Partial | **Compile-time** |
| ADC2/WiFi warning | No | Runtime | No | No | **Compile-time** |
| Task auto-classification | No | No | No | No | **Automatic** |
| ISR safety checking | No | No | No | No | **Compile-time** |
| State machines | No | No | No | No | **Language feature** |
| Performance | Native | Native | Native | Native | **Native (compiles to C)** |

## Quick Start

```bash
# Install
pip install lark

# Compile a Volt program to C
python compiler/voltc.py examples/01-blink/main.volt

# Build and flash (with ESP-IDF installed)
cd framework && idf.py build && idf.py flash
```

## What Volt Looks Like

```volt
chip esp32

hardware {
    pin led: Output = 2
    pin motor: PWM = 4
    pin battery: Analog = 36
}

task blink() {
    every 500ms {
        led.toggle()
    }
}

task motor_pid() {
    every 1ms strict {
        motor.set_pwm(0)
    }
}

task telemetry() {
    every 5seconds {
        mqtt.send_int("volt/battery", battery.read())
    }
}

main {
    wifi.connect("MyNet", "MyPass")
    mqtt.connect("mqtt://broker.local")
    run(blink, motor_pid, telemetry)
}
```

The compiler auto-classifies:
- `blink` → **Background** (protothread, 12 bytes, cooperative)
- `motor_pid` → **Critical** (hardware timer ISR, `IRAM_ATTR`, cannot be delayed)
- `telemetry` → **Priority** (FreeRTOS task, 4KB stack, uses MQTT)

All from **one keyword: `task`**. No manual scheduling configuration.

## What the Compiler Catches

```volt
pin motor: Output = 6        // ERROR: GPIO 6 is connected to SPI flash
pin sensor: Analog = 21      // ERROR: GPIO 21 has no ADC channel
pin led: Output = 34         // ERROR: GPIO 34 is input-only
pin a: Output = 2
pin b: Output = 2            // ERROR: GPIO 2 already used by pin 'a'
let x: int = "hello"         // ERROR: expected int, got string
led.read()                   // ERROR: Output pins have no method 'read'
// In critical task:
log("tick")                  // ERROR: log() not safe in ISR context
```

With source context, color, and "did you mean?" suggestions.

## Project Status

**Phase 1-3 complete:**
- C framework running on ESP32 DevKit V1 (WiFi, MQTT, GPIO, storage, three-tier scheduler)
- Volt transpiler: 7-pass pipeline, 441 tests, all passing
- End-to-end: `.volt` → C code → ESP32 binary

**Next:** Phase 4-7 (advanced language features, VS Code extension, drivers, public launch)

## Architecture

```
Developer writes .volt files
        ↓
Volt Transpiler (Python, 7 passes, ~2,600 LOC)
  Pass 1: Parse (Lark LALR grammar → AST)
  Pass 2: Resolve (name resolution, forward references)
  Pass 3: Check (bidirectional type checking)
  Pass 4: Validate (hardware: pins, ADC2/WiFi, ISR safety)
  Pass 5: Analyze (task classification, yield analysis, shared state)
  Pass 6: Transform (variable lifting, function inlining, desugar)
  Pass 7: Generate (C code with counter-based yield labels)
        ↓
Volt C Framework (8 modules on ESP-IDF)
  pin.h    — GPIO with validation
  task.h   — Three-tier scheduler (protothread + FreeRTOS + hardware timer)
  wifi.h   — WiFi with auto-reconnect + stats
  mqtt.h   — MQTT pub/sub
  http.h   — HTTP GET/POST
  storage.h — NVS with write coalescing + boot loop detection
  log.h    — Colored timestamped logging
  error.h  — Error codes
        ↓
ESP-IDF v5.4.1 → ESP32 DevKit V1 (WROOM-32)
```

## Test Suite

```
Grammar:      115 tests  (syntax parsing, edge cases, invalid input)
Parser:        88 tests  (AST construction from parse tree)
Resolver:      30 tests  (name resolution, scoping, suggestions)
Checker:       41 tests  (type checking, operator validation, poison types)
Hardware:      35 tests  (pin conflicts, ADC2/WiFi, strapping, JTAG, ISR)
Analyzer:      18 tests  (task classification, yield analysis, ISR safety)
End-to-End:   114 tests  (full pipeline: .volt → C code verification)
─────────────────────────
Total:        441 tests  — all passing
```

## Documentation

### Research (why this project exists)
- [Landscape Analysis](docs/research/01-landscape-analysis.md) — Every major embedded platform mapped
- [Hardware Landscape](docs/research/02-hardware-landscape.md) — MCU specs, pricing, power
- [Academic Research](docs/research/03-academic-research.md) — Papers on async embedded, WASM, TinyML
- [Commercial Landscape](docs/research/04-commercial-landscape.md) — Exits, pricing, business models
- [Gaps & Opportunities](docs/research/05-gaps-and-opportunities.md) — What nobody has built
- [GitHub Repos Catalog](docs/research/06-github-repos-catalog.md) — 100+ projects analyzed

### Architecture (how it's built)
- [Framework Design](docs/architecture/01-framework-design.md) — Module architecture, comparison table
- [Async Runtime](docs/architecture/02-async-runtime-deep-dive.md) — Advanced protothreads, three tiers
- [Chip Target Strategy](docs/architecture/03-chip-target-strategy.md) — ESP32 WROOM-32 first
- [ESP32 Technical Reference](docs/architecture/04-esp32-technical-reference.md) — Memory map, boot, registers, pins
- [Firmware Patterns](docs/architecture/05-firmware-patterns.md) — Coroutines, memory pools, HAL design
- [Volt Language Design](docs/architecture/06-volt-language-design.md) — Type system, syntax, state machines
- [Code Examples](docs/architecture/07-code-examples.md) — Three examples (beginner → advanced)
- [Transpiler Architecture](docs/architecture/08-transpiler-architecture.md) — 7-pass pipeline, AST, testing

### Project
- [Roadmap](ROADMAP.md) — 7-phase build plan with timeline
- [Conventions](CONVENTIONS.md) — Naming rules, code style, collaboration workflow
- [Launch Strategy](docs/community/01-launch-strategy.md) — Community growth plan

## License

MIT
