# Troubleshooting Guide

Common errors, warnings, and runtime issues — with clear fixes.

---

## Table of Contents

- [Compile Errors](#compile-errors)
  - [HARDWARE ERROR](#hardware-error)
  - [TYPE MISMATCH](#type-mismatch)
  - [NAME ERROR](#name-error)
  - [SYNTAX ERROR](#syntax-error)
  - [STATE MACHINE ERROR](#state-machine-error)
  - [TASK ERROR](#task-error)
  - [CHANNEL ERROR](#channel-error)
  - [INCLUDE ERROR](#include-error)
  - [DEVICE PIN ERROR](#device-pin-error)
  - [PROGRAM ERROR](#program-error)
- [Warnings](#warnings)
- [Runtime Issues](#runtime-issues)

---

## Compile Errors

### HARDWARE ERROR

**"GPIO N does not exist on ESP32 (valid: 0-39)"**

The pin number is out of range.

```
pin led: Output = 99
                 ^^ GPIO 99 does not exist on ESP32 (valid: 0-39)
```

Fix: Use a valid pin for your chip.

---

**"GPIO N is connected to the SPI flash chip"**

Pins 6-11 on ESP32 are reserved for the external SPI flash. You can't use them.

```
pin motor: Output = 6
                   ^ GPIO 6 is connected to the SPI flash chip
```

Fix: Use GPIO 2, 4, 5, 12-19, 21-23, 25-27, 32-33 instead.

---

**"GPIO N is input-only"**

Pins 34-39 on ESP32 can only be used as Input, PullUpInput, PullDownInput, or Analog. You can't use them as Output or PWM.

```
pin led: Output = 34
                 ^^ GPIO 34 is input-only — cannot be used as Output
```

Fix: Use a different pin, or change the mode to Input/Analog.

---

**"Pin N is already used by X"**

Two pins share the same GPIO number.

```
pin led: Output = 2
pin motor: Output = 2
                   ^ GPIO 2 is already used by `led` (line 3)
```

Fix: Change one pin to a different GPIO.

---

**"Pin N is on ADC2, which is blocked while WiFi is active"**

ADC2 (GPIO 12, 13, 14, 15, 25, 26, 27) conflicts with the WiFi radio. Analog reads will return errors when WiFi is connected.

```
let val = sensor.read()
           ^^^^^^^^^^^^ Pin 15 is on ADC2, blocked while WiFi is active
```

Fix: Use ADC1 pins (GPIO 32-39) instead, or use digital sensors.

---

**"N does not have WiFi hardware"**

Your chip doesn't have WiFi, but your code uses `wifi.*` or `mqtt.*`.

Fix: Use a chip with WiFi (esp32, esp8266) or remove the WiFi/MQTT calls.

---

**"Bus N uses invalid pins"**

I2C/SPI pins can't be input-only (34-39) or flash pins (6-11).

Fix: Choose valid pins for the bus.

---

**"I2C address conflict: two devices share address 0xNN on bus N"**

Two I2C devices have the same address on the same bus.

```
device a: BME280 on i2c0 at 0x76
device b: BH1750 on i2c0 at 0x76
                                  ^ address 0x76 already used by `a`
```

Fix: Change one device's address, or use a different bus.

---

### TYPE MISMATCH

**"Variable X declared as TypeA but assigned TypeB"**

The value doesn't match the declared type.

```
let name: string = 42
                   ^^ expected string, got int
```

Fix: Change the type or the value.

```
let name: string = 42       // wrong
let name: string = "hello"  // right
let count: int = 42         // also right
```

---

**"Cannot assign TypeB to TypeA"**

Assignment target and source types don't match.

```
x = "hello"   // x is int, "hello" is string
  ^^^^^^^^^ cannot assign string to int
```

Fix: Ensure both sides have the same type.

---

**"Pin X uses method Y() which could be Input, PullUp, Analog, or PullDown"**

The compiler couldn't determine the pin mode from usage alone, and the pin method is ambiguous.

```
pin sensor: Analog = 36    // explicit — works
pin sensor = 36             // implicit — compiler tries to infer
sensor.read()               // ambiguous: Input? Analog? PullUp?
```

Fix: Add an explicit pin mode:

```
pin sensor: Analog = 36
```

---

### NAME ERROR

**"X is not defined"**

You used a name that hasn't been declared.

```
led.on()
^^^ 'led' is not defined
```

Fix: Check the spelling, or declare the variable/pin first.

```
hardware {
    pin led = 2
}
```

---

**"Did you mean Y?"**

The compiler found a similar name. This uses Levenshtein distance for fuzzy matching.

```
hardware {
    pin led = 2
}
ledd.toggle()     // did you mean `led`?
```

Fix: Correct the typo.

---

**"X is not defined in this scope"**

The name exists but isn't accessible from the current scope. Variables declared inside a task are local to that task.

```
task blink() {
    var x = 10
}

every 500ms {
    x = 5        // ERROR: x is not defined here
}
```

Fix: Declare the variable at the top level (global scope).

---

### SYNTAX ERROR

**"Unexpected token"**

The parser found something it didn't expect. This usually means a missing brace, parenthesis, or keyword.

```
hardware {
    pin led = 2
// missing closing brace!
```

Fix: Check braces, parentheses, and statement structure.

---

**"Invalid initializer for X"**

You used assignment-as-expression, which isn't valid.

```
var x = y = 5     // wrong
var x = 5          // right
```

Fix: Use simple values in initializers.

---

**"Cannot assign to this expression"**

The left side of `=` isn't a variable.

```
42 = x     // nonsense
5 + 3 = x  // nonsense
```

Fix: Only assign to variables.

---

### STATE MACHINE ERROR

**"Machine X has no states"**

A state machine must have at least one state.

```
machine Empty {
    // no states!
}
```

Fix: Add at least one state.

---

**"Machine X has N initial states. Only one allowed."**

Multiple states are marked `initial`.

```
machine Door {
    initial state locked { ... }
    initial state unlocked { ... }   // second initial!
}
```

Fix: Only one state should be initial. Remove `initial` from the rest.

---

**"Transition target X does not exist"**

A transition points to a state that doesn't exist.

```
state locked {
    after 5s -> unlockd     // typo: should be 'unlocked'
}
```

Fix: Check the target state name. Available states are listed in the error.

---

**"Multiple unguarded transitions for event X"**

Two transitions for the same event, both without guards — the compiler can't tell which to take.

```
state locked {
    on button_press -> unlocked
    on button_press -> alarming    // same event, no guard!
}
```

Fix: Add guards with `when` to distinguish them:

```
state locked {
    on button_press -> unlocked when attempts < 3
    on button_press -> alarming   when attempts >= 3
}
```

---

### TASK ERROR

**"Critical task X calls Y() which is not safe in ISR context"**

A `strict` task uses functions that block (WiFi, MQTT, log, I2C, SPI). Strict tasks run as hardware timer ISRs and must never block.

```
every 1ms strict {
    wifi.connect("SSID", "pass")    // ERROR: not ISR-safe
}
```

Fix: Remove `strict` (making it a background task) or move the blocking call to a different task.

---

**"Function X contains a yield and calls itself recursively"**

Yielding functions can't be recursive because they need to be inlined into protothreads.

```
func blink() {
    led.toggle()
    sleep(500ms)     // yield
    blink()          // self-call — ERROR
}
```

Fix: Rewrite as a loop instead of recursion.

---

**"Task X has no yield points"**

A background task with `every`, `on`, or `sleep` will run exactly once and finish. This is usually a mistake.

```
task once() {
    led.on()     // no every/on/sleep — runs once
    led.off()
}
```

Fix: Add an `every` block if you want it to repeat, or use a function instead of a task.

---

### CHANNEL ERROR

**"Channel X capacity must be at least 1"**

Channels need at least 1 slot.

```
channel data: int[0]     // 0 capacity!
```

Fix: Use `channel data: int` (unbuffered) or `channel data: int[8]` (buffered).

---

**"Channel X capacity N exceeds maximum (1024)"**

Embedded devices have limited RAM.

```
channel data: int[9999]   // too big
```

Fix: Use capacity 1-1024.

---

### INCLUDE ERROR

**"Absolute include paths are not allowed"**

```
include "/etc/passwd"       // absolute path — rejected
include "../secrets.volt"   // traversal — rejected
```

Fix: Only include files within the project directory.

---

**"File not found"**

The included file doesn't exist.

```
include "config.volt"    // file doesn't exist
```

Fix: Create the file or correct the path.

---

### DEVICE PIN ERROR

**"SENSOR needs N pins but the declaration only provides one"**

Multi-pin sensors (like HCSR04 with trig+echo) need named-pin syntax.

```
device hc: HCSR04 on 5         // wrong — needs both trig and echo
device hc: HCSR04(trig: 5, echo: 18)   // right
```

Fix: Use the named-pins syntax. The error shows the required parameters.

---

### PROGRAM ERROR

**"Cannot use loop and task in the same program"**

`loop { ... }` and `task ... { ... }` are mutually exclusive.

Fix: Use `task` for concurrent programs. `loop` is only for the simplest single-thread programs.

---

## Warnings

### HARDWARE WARNING

**"Pin N is a strapping pin"**

GPIO 0, 2, 5, 12, 15 on ESP32 affect boot mode. Using them can cause intermittent boot failures depending on external circuitry.

Fix: Use a different pin unless you understand the strapping behavior.

---

### STATE MACHINE WARNING

**"State X is unreachable from initial state Y"**

A state can never be entered because no transition leads to it.

Fix: Add a transition to the unreachable state, or remove it.

---

**"State X has no outgoing transitions (dead-end state)"**

Once entered, this state can never be left.

Fix: Add a transition, or mark as `terminal` if intentional.

---

### TASK WARNING

**"Task X has no yield points"**

A background task without `every`, `on`, or `sleep` runs once.

Fix: Add an `every` block if periodic behavior is intended, or use `func` instead of `task`.

---

### MISSING RETURN

**"Function X declares return type Y but may not return a value on all paths"**

Not all code paths in the function have a `return` statement.

```
func div(a: int, b: int) -> int {
    if b != 0 {
        return a / b
    }
    // no return when b == 0!
}
```

Fix: Add a return for all paths.

---

## Runtime Issues

### LED doesn't blink

1. **Wrong pin** — Many ESP32 dev boards use GPIO 2 for the built-in LED, but some use GPIO 1 or 5. Check your board's schematic.
2. **USB cable** — Charge-only cables won't transmit data. Use a data cable.
3. **Boot mode** — If using strapping pins (GPIO 0, 2, 5, 12, 15), the chip may not boot at all. Use non-strapping pins for development.
4. **Flash failed** — Check the serial monitor for ESP-IDF log output. Common issues: wrong baud rate, wrong serial port, bootloader not running.

### WiFi won't connect

1. **SSID/password wrong** — Double-check for typos. The compiler doesn't validate credentials.
2. **2.4GHz only** — ESP32 only supports 2.4GHz WiFi. 5GHz networks are invisible.
3. **ADC2 pins active** — If you're reading analog pins on ADC2 (GPIO 12, 13, 14, 15, 25, 26, 27) while WiFi is connected, analog reads will fail. Move to ADC1 (GPIO 32-39).
4. **Power** — WiFi needs bursts of current (~300mA). A weak USB port or long cable can cause brownouts.

### MQTT connection fails

1. **Broker URL** — Make sure the URL format is correct: `mqtt://broker.local` or `mqtts://broker.local`.
2. **Network** — Can the ESP32 ping the broker? Test with `ping` from the same network.
3. **Authentication** — If the broker requires a username/password, check the credentials.

### Device resets or crashes

1. **Watchdog timeout** — If a task blocks for too long, the hardware watchdog may reset the chip. Feed the watchdog: `system.watchdog_feed()`.
2. **Stack overflow** — Priority tasks have 4KB stacks. Deep call chains or large local variables can overflow. Move data to globals or increase the stack.
3. **ISR overrun** — Critical (`strict`) tasks run as hardware timer ISRs. Keep them short — under 100 microseconds.

### Storage values lost after reboot

1. **NVS initialized?** — First boot may have default values. The second boot will show saved values.
2. **Key name too long** — NVS key names are limited to 15 characters.
3. **Flash wear** — After ~100,000 writes, flash cells wear out. Use `storage.push()` with batching (automatic flush every 30s) instead of writing every cycle.

### Serial monitor shows garbage

1. **Baud rate mismatch** — ESP32 defaults to 115200 baud. Make sure your monitor is set correctly.
2. **Bootloader output** — Early boot messages may use a different baud rate depending on the ESP32 variant.

### Program compiles but nothing runs

1. **app_main()** — Volt generates `app_main()` as the entry point. Make sure ESP-IDF is configured to find it.
2. **volt_init()** — This must be called before any Volt functions. The code generator adds it automatically.
3. **voltage regulator** — Some ESP32 boards need the right voltage regulator setting. Check if your board needs 3.3V logic.
