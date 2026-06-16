# Volt Language Quick Reference

One-page syntax reference. See [Language Design](architecture/06-volt-language-design.md) for the full spec.

---

## Program Structure

```
volt.toml              Project config (chip, name)
main.volt              Source code
├── hardware { ... }   Pin declarations
├── setup { ... }      Boot sequence (runs once)
├── task name { ... }  Concurrent tasks
├── machine name { ... }  State machines
├── func name() { ... }   Reusable functions
├── every ... { ... }  Anonymous periodic tasks (no task keyword needed)
├── let x = ...        Global immutable variable
├── var x = ...        Global mutable variable
└── storage x: type = default   Persistent variable
```

---

## Types

| Type | Description | Literal |
|------|-------------|---------|
| `int` | 32-bit signed integer | `42`, `-5`, `0xFF` |
| `float` | 32-bit IEEE 754 | `3.14`, `1.0e6` |
| `bool` | Boolean | `true`, `false` |
| `string` | Text (null-terminated) | `"hello"`, `"temp: {val}"` |
| `byte` | 8-bit unsigned | `0xAB` |

### Pin types

| Type | Methods |
|------|---------|
| `Output` | `.on()`, `.off()`, `.toggle()`, `.write(n)`, `.is_on()`, `.blink(ms)`, `.blink_once(ms)` |
| `Input` | `.read()` → int |
| `PullUpInput` | `.read()` → int |
| `PullDownInput` | `.read()` → int |
| `Analog` | `.read()` → int |
| `PWM` | `.set_pwm(n)`, `.on()`, `.off()`, `.tone(freq, dur)` |
| `Servo` | `.set_angle(n)` |

---

## Variables

```volt
let x = 10              // immutable (inferred: int)
let y: float = 10       // explicit type, value converts

var counter = 0          // mutable
counter = counter + 1

storage boot_count: int = 0   // persistent across reboot
```

---

## Hardware Declarations

```volt
hardware {
    pin led: Output = 2
    pin button: PullUpInput = 0
    pin sensor: Analog = 36
    pin motor: PWM = 4
    pin led = 2               // mode auto-inferred from usage

    bus i2c0: I2C(sda: 21, scl: 22)
    device weather: BME280 on i2c0 at 0x76
}
```

---

## Control Flow

```volt
// If / else
if x > 10 {
    led.on()
} else if x > 5 {
    led.blink(500ms)
} else {
    led.off()
}

// Match (exhaustive, no fallthrough)
match(state) {
    .idle      -> led.off()
    .active    -> led.on()
    .error     -> led.blink(100ms)
}

// While
while !wifi.is_connected() {
    led.blink(200ms)
    sleep(1second)
}

// For (range)
for i in 0..10 {
    log("count: {i}")
}
```

---

## Tasks

```volt
// Anonymous periodic (simplest form)
every 500ms {
    led.toggle()
}

// Named task
task monitor() {
    every 5seconds {
        let temp = bme.temperature()
        mqtt.send("temp", temp)
    }
}

// Event-driven (button press)
task buttons() {
    on button.press() debounce 50ms {
        led.toggle()
    }
}

// Real-time (strict = hardware timer ISR)
every 1ms strict {
    motor.set_pwm(output)
}

// Conditional execution
every 5s when wifi.is_connected() {
    mqtt.send("data", value)
}

// Run tasks at startup
setup {
    wifi.connect("SSID", "pass") or retry(10)
    mqtt.connect("broker.local") or retry(5)
    run(monitor, buttons)
}
```

Task tier auto-classification:

| Usage | Tier | Memory |
|-------|------|--------|
| No blocking calls | Background (protothread) | 12 bytes |
| Uses wifi/mqtt/http/storage | Priority (FreeRTOS) | 4KB stack |
| Marked `strict` | Critical (timer ISR) | Hardware timer |

---

## Functions

```volt
func add(a: int, b: int) -> int {
    return a + b
}

func greet(name: string) {
    log("Hello, {name}")
}
```

---

## State Machines

```volt
machine DoorLock {
    let attempts: int = 0

    state locked {
        enter { lock.off() }
        exit  { log("leaving locked") }
        on valid_code -> unlocked          // event transition
        on wrong_code -> alarming when attempts > 3  // guarded
        on wrong_code -> locked
        after 10seconds -> unlocked        // timed transition
    }
}
```

Compiler verifications:
- All states reachable
- All transition targets exist
- Guards are deterministic
- No dead-end states (unless `terminal`)

---

## Duration Literals

```volt
100us            // microseconds
500ms            // milliseconds
1second          // 1 second (use singular)
5seconds         // 5 seconds
10minutes        // 10 minutes
1hour            // 1 hour
```

---

## Error Handling

```volt
// Retry on failure (in setup)
wifi.connect("SSID", "pass") or retry(10)

// Skip on failure (in periodic tasks)
try {
    let t = weather.temperature()
    mqtt.send("temp", t)
} or skip

// Reboot on persistent failure
try {
    wifi.connect("SSID", "pass")
} or retry 5 times else restart

// Must succeed
storage.load("key") or crash
```

---

## Built-in Singletons

| Name | Key methods |
|------|-------------|
| `wifi` | `.connect(ssid, pass)`, `.disconnect()`, `.is_connected()` |
| `mqtt` | `.connect(url)`, `.send(topic, payload)`, `.send_int()`, `.send_float()`, `.on_receive()`, `.is_connected()` |
| `serial` | `.write(data)`, `.read()`, `.available()` |
| `storage` | `.save(key, val)`, `.load(key)`, `.delete(key)`, `.push(list, val)`, `.drain(list)` |
| `system` | `.restart()`, `.id`, `.uptime()`, `.free_heap()`, `.watchdog_enable(ms)`, `.watchdog_feed()` |
| `ota` | `.enable()`, `.check()` |
| `log` | `log(module, message)` — function, not method |

---

## Operators

```volt
// Arithmetic
+  -  *  /  %

// Comparison
==  !=  <  >  <=  >=

// Logical
&&  ||  !

// Assignment
=  +=  -=  *=  /=
```

String interpolation: `"Hello, {name}"` — use `{expr}` inside strings.

---

## Channels (for task communication)

```volt
channel events: int          // unbuffered
channel data: int[16]        // bounded buffer

task sender {
    every 100ms {
        events.send(42)
    }
}

task receiver {
    on events.has_data() {
        let val = events.receive()
        log("got: {val}")
    }
}
```

---

## Enums

```volt
enum DoorState { locked, unlocked, alert }

var state: DoorState = DoorState.locked
```

---

## Raw C (escape hatch)

```volt
raw {
    #include "driver/mcpwm.h"

    void IRAM_ATTR motor_isr(void *arg) {
        GPIO.out_w1ts = (1 << 4);
    }
}
```

Raw blocks pass through to generated C verbatim — not validated by the compiler.

---

## Include

```volt
include "config.volt"
include "pins.volt"
```

Max 10 levels of nesting. Absolute paths and path traversal (`../`) are rejected.

---

## Comments

```volt
// Single line

/* Multi
   line */
```

---

## Example: Minimal Program

```volt
hardware {
    pin led = 2
}

every 500ms {
    led.toggle()
}
```

No `chip` declaration → put `chip = "esp32"` in `volt.toml`:

```toml
[project]
name = "blink"
chip = "esp32"
```

---

## Compiler Invocation

```bash
# Compile to stdout
voltc main.volt

# Compile to file
voltc main.volt -o main.c

# From Python
python3 -m volt.compiler.voltc main.volt -o main.c
```

Exit code: 0 on success, 1 on errors. Warnings go to stderr, C code to stdout or `-o`.
