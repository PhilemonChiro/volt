# Getting Started with Volt

A step-by-step guide from zero to blinking an LED on real hardware.

---

## Prerequisites

- **Python 3.10+** — the compiler runs on any OS (Linux, macOS, Windows)
- **ESP32 board** — any ESP32 dev board with a built-in LED (GPIO 2)
- **USB cable** — data, not charge-only
- **ESP-IDF v5.4.1** — required for building/flashing (skip if you just want to try the compiler)

Volt supports ESP32 boards today. RP2040 and STM32 are on the roadmap ([Multi-Chip](architecture/09-multi-chip-support.md) has the design).

---

## 1. Install the Compiler

```bash
pip install volt-lang
```

Or run from source:

```bash
git clone https://github.com/your-org/volt
cd volt
pip install -e .
```

Verify it works:

```bash
echo 'chip esp32\nhardware { pin led = 2 }\nevery 500ms { led.toggle() }' > test.volt
voltc test.volt
```

You should see C code printed to stdout. No errors = the compiler is happy.

---

## 2. Your First Project

Create a project directory:

```bash
mkdir my-blink
cd my-blink
```

Create `volt.toml` — this tells Volt what chip you're targeting:

```toml
[project]
name = "my-blink"
chip = "esp32"
```

Create `main.volt` — the source file:

```volt
hardware {
    pin led = 2
}

every 500ms {
    led.toggle()
}
```

---

## 3. Compile

```bash
voltc main.volt -o main.c
```

If there are errors, the compiler prints them with source context:

```
error[E001]: Invalid pin assignment
  --> main.volt:5:19
   |
 5 |     pin led = 6
   |              ^
   | GPIO 6 is connected to the SPI flash chip and cannot be used.
   | Available output pins: 2, 4, 5, 12-19, 21-23, 25-27, 32-33
```

Fix the errors and recompile until it succeeds. You'll get a `main.c` file.

---

## 4. What the Compiler Generated

Open `main.c` — it should look like this:

```c
#line 1 "main.volt"
#include "volt.h"

#line 3 "main.volt"
#define PIN_LED 2

#line 5 "main.volt"
static void _every_0_task(task_t *_t) {
    switch (_t->_line) { case 0:
    while (1) {
#line 6 "main.volt"
        pin_toggle(PIN_LED);
        _t->wake_at = volt_tick_ms() + 500;
        _t->_line = __LINE__; return; case __LINE__:
        if (volt_tick_ms() < _t->wake_at) return;
    }
    }
}

#line 9 "main.volt"
void app_main(void) {
    volt_init();
    pin_set_output(PIN_LED);
    volt_run(_every_0_task, NULL);
}
```

Key things to notice:

- **`#line` directives** map generated C back to `.volt` line numbers — errors point to your source, not the generated file
- **`pin_set_output`** is called automatically — the compiler inferred the pin mode from `led.toggle()`
- **`volt_run`** registers the task with the scheduler
- **The task body** is a protothread with counter-based yield labels — it returns after each iteration and resumes at `case __LINE__:` on the next tick

---

## 5. Build and Flash

You need ESP-IDF installed. If you don't have it yet:

```bash
# Clone ESP-IDF
git clone --branch v5.4.1 --depth 1 https://github.com/espressif/esp-idf.git
cd esp-idf
./install.sh
source export.sh
cd ..
```

Create an ESP-IDF project:

```bash
mkdir build
cd build
cp ../main.c .
# Or use volt build (if you have the Volt CLI set up)
idf.py set-target esp32
idf.py build
idf.py flash monitor
```

Press the reset button on your ESP32. The LED should blink every 500ms.

---

## 6. Common First Steps

Once you have the blink working, try these in order:

| Example | What it teaches |
|---------|-----------------|
| [01-blink](../examples/01-blink/) | Multiple pins, different rates |
| [03-state-blink](../examples/03-state-blink/) | State machines for blinking |
| [02-iot-sensor](../examples/02-iot-sensor/) | WiFi + MQTT + ADC |
| [07-safe-boot](../examples/07-safe-boot/) | Try blocks, error recovery |
| [door-lock](../examples/door-lock/) | Full project: state machine + MQTT + storage |
| [smart-led](../examples/smart-led/) | PWM + channels + shared vars + button input |
| [weather-station](../examples/weather-station/) | ADC + storage + deep sleep |
| [04-multi-state](../examples/04-multi-state/) | Multiple state machines + tasks |
| [06-combined-all](../examples/06-combined-all/) | Functions + state machines + storage + ADC |

---

## 7. Next Steps

- **Language Quick Reference** — one-page cheat sheet of all syntax
- **Troubleshooting Guide** — common errors and how to fix them
- **Language Design** — full language specification
- **Architecture Docs** — how the compiler and runtime work under the hood

---

## Installation Troubleshooting

### `pip install volt-lang` fails

Make sure you have Python 3.10+ and pip:

```bash
python3 --version
pip3 --version
```

### `voltc: command not found`

The CLI script may not be in your PATH. Run it directly:

```bash
python3 -m volt.compiler.voltc main.volt
```

### Compilation succeeds but LED doesn't blink

1. Check the LED pin on your board — many ESP32 dev boards use GPIO 2, but some use GPIO 1 or GPIO 5
2. Make sure the USB cable is data-capable (red charging cables won't work)
3. Check the serial monitor for boot errors
