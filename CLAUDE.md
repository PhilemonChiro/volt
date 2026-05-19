# Volt Development Conventions

## ⚠️ CRITICAL RULE — Sole Authorship

**NEVER mention Claude, AI, or any co-authorship in commits, messages, PRs, comments, or any project content.**
- No `Co-Authored-By` lines in commits
- No references to AI assistance anywhere in the project
- pchiro29@gmail.com (Philemon Chiro) is the **sole author and contributor**
- This rule applies to ALL git operations, PR descriptions, issue comments, and documentation

---

## Distillation Protocol

When asked to "brutally distill" or audit the platform, follow this process. Repeat until quality converges (3+ consecutive clean rounds).

### 1. Identify (be extremely critical)
- **Bugs**: logic errors, wrong output, crash paths, silent failures
- **Edge cases**: empty inputs, overflow, boundary values, adversarial usage
- **Performance**: O(n^2) where O(n) is possible, unnecessary allocations, redundant passes
- **Security**: injection vulnerabilities, race conditions, memory issues, input validation flaws
- **Bad patterns**: dead code, copy-paste duplication, leaky abstractions, inconsistent naming

### 2. Fix (never break existing functionality)
- Rewrite the code fixing all issues identified
- Keep the codebase well-structured and clean
- Run existing tests BEFORE and AFTER every change
- If a fix touches shared code, verify all callers still work

### 3. Test (comprehensive coverage)
- Write unit tests for every fix
- Write edge case tests (empty, null, overflow, wrong types)
- Write failure scenario tests (error messages are clear and helpful)
- Write integration tests (multiple features combined in one program)
- Compile example programs as regression tests

### 4. Audit (multi-angle review)
- Injection: can user input reach unsafe operations?
- Race conditions: are shared variables protected? Atomics correct?
- Memory: buffer overflows, stack usage on embedded, flash wear
- Validation: does every public API reject invalid input with a clear error?

### 5. Optimize (explain trade-offs)
- Time complexity: is the algorithm appropriate for the data size?
- Memory usage: embedded devices have 20KB-520KB RAM
- Scalability: will this work with 100 devices? 50 tasks?
- Robustness: what happens on power failure mid-operation?
- Clean code: can a new contributor read this in 5 minutes?
- DSL developer-friendly: does the error message help the developer fix their code?
- Simple but powerful: fewer concepts, more capability

### 6. Maintain
- Modular structure: each file has one responsibility
- Separation of concerns: parser doesn't know about C, codegen doesn't validate types
- Production readiness: every code path has been exercised by a test

### 7. Parallel agents
When the audit is large, spin up concurrent agents as:
- **Researcher**: investigate how other platforms solve this
- **Developer**: implement the fix
- **Code reviewer**: audit the fix for correctness and style
- **Security engineer**: check for vulnerabilities in the change
- **Performance engineer**: measure impact on compile time and output size
- **End user**: write a Volt program that exercises the new code — does it feel natural?

### 9. Update docs and ide
 - keep uptodate  the  documentation and readme accordingly
 - update  the ide accordingly too

### 8. Test requirements for new features

Every new feature MUST have tests at all applicable levels:

#### A. Compiler tests (Python — `tests/test_*.py`)
| Test file | What it covers | When to add |
|-----------|---------------|-------------|
| `test_parser.py` | Grammar rules, AST construction | New syntax, operators, blocks |
| `test_resolver.py` | Name resolution, scope chains, duplicate detection | New declarations, scope rules |
| `test_checker.py` | Type checking, operator rules, method signatures | New types, operators, builtins |
| `test_analyzer.py` | Yield detection, shared state, task validation, ISR safety | New yield points, task tiers, concurrency |
| `test_transformer.py` | Function inlining, yield labels, multi-every split, match desugar, variable renaming | New transform passes, inlining edge cases |
| `test_hardware.py` | Pin validation, chip constraints, strapping pins, ADC/WiFi conflicts | New chips, pin modes, peripherals |
| `test_codegen / test_coverage.py` | C output patterns, atomics, storage dispatch, channels, enums | New codegen paths, builtins, type dispatch |
| `test_errors.py` | Error message content and hints | New error messages |
| `test_security.py` | Format string safety, injection prevention, input validation | New string handling, user-facing output |

#### B. Target-specific tests
| Test file | What it covers | When to add |
|-----------|---------------|-------------|
| `test_rp2040.py` | `int main`, `stdio_init_all`, Pico pin ranges, no WiFi/BLE | Any RP2040-specific codegen |
| `test_esp8266.py` | ESP8266 pin constraints, limited GPIO | Any ESP8266-specific behavior |
| `test_programs.py` | Cross-chip compilation, chip-specific output | New chip targets |

#### C. Integration tests
| Test file | What it covers | When to add |
|-----------|---------------|-------------|
| `test_endtoend.py` | Full pipeline: parse → resolve → check → analyze → transform → codegen | Any pipeline change |
| `test_multifeature.py` | Complex programs combining 3+ features (state machines + sensors + storage, channels + shared vars + tasks) | New feature interactions |
| `test_framework.py` | Generated C compiles against framework headers with gcc | New framework functions, API changes, new device drivers |

#### D. Test patterns
- **Positive test**: Program compiles, C output contains expected pattern
- **Negative test**: Program fails with expected error message
- **Regression test**: Exact C output matches expected string (for bugs that were fixed)
- **Framework test**: Generated C passes `gcc -Wall -Werror` against stub headers

#### E. Running tests
```bash
# All tests (must be 100% green before commit)
for f in tests/test_*.py; do python3 "$f"; done

# Single file
python3 tests/test_transformer.py

# Count total
for f in tests/test_*.py; do python3 "$f" 2>&1 | grep RESULTS; done
```

### 9. Commit and repeat
- Run full test suite (must be 100% green)
- Commit with descriptive message listing what was fixed
- Push to create a recoverable point
- Start the next round immediately
- Stop when 3+ consecutive rounds find zero issues

---

## How We Build This

### The Rule: No Mystery Code

Every line of code in this project exists because both of us understand WHY it's there.

### Workflow

1. **Discuss first** — Before writing any module, we discuss:
   - What problem does this solve?
   - What are the options?
   - Why this approach over alternatives?

2. **Small chunks** — Code is written in pieces of 10-30 lines max. Each piece is explained, reviewed, and approved before moving on.

3. **No black boxes** — If a line of code isn't obvious, it gets a comment explaining the WHY (not the what). If the developer (Philemon) doesn't understand a section, we stop and clarify before continuing.

4. **Question everything** — "Why not do it this way?" is always a valid question. The answer should never be "just because."

5. **Name things for humans** — Every function, variable, type, and constant should be readable by someone who has never seen the codebase. If you need a comment to explain what a name means, the name is wrong.

---

## Naming Conventions

### Philosophy: Read Like English

Code should read like instructions to a human, not like abbreviations for a compiler.

### Functions: verb_noun()

```c
// Good — reads like an action
led_on()
led_off()
led_toggle()
led_blink(500)

wifi_connect("ssid", "password")
wifi_disconnect()
wifi_is_connected()

sensor_read_temperature()
sensor_read_humidity()

message_send("topic", "hello")
message_on_receive(handler)

storage_save("key", value)
storage_load("key", &value)

sleep_ms(1000)
sleep_seconds(5)

pin_set_output(2)
pin_set_input(4)
pin_write(2, HIGH)
pin_read(4)

// Bad — cryptic, abbreviated, or unclear
gpio_set_direction_output()   // too verbose, mirrors register names
wifi_sta_connect()            // what is "sta"? (station mode jargon)
nvs_set_i32()                 // what is "nvs"? what is "i32"?
xTaskCreate()                 // FreeRTOS style — unreadable
esp_wifi_set_ps()             // what is "ps"?
```

### Types: thing_t

```c
// Good — clear what they represent
led_t
wifi_config_t
sensor_data_t
message_t
task_t
pin_mode_t
error_t

// Bad
gpio_config_t          // jargon
wifi_sta_config_t      // jargon within jargon
esp_err_t              // vendor prefix
QEvt                   // no suffix, unclear
```

### Constants: UPPER_CASE

```c
// Good — obvious meaning
HIGH        1
LOW         0
ON          1
OFF         0

PIN_LED     2
PIN_BUTTON  0

WIFI_CONNECTED      1
WIFI_DISCONNECTED   0

// Bad
GPIO_MODE_DEF_OUTPUT    // verbose, unclear
WIFI_MODE_STA           // jargon
ESP_OK                  // vendor prefix
```

### Modules: grouped by domain

```c
// Each module has a clear prefix matching its domain:
led_*         // LED control
pin_*         // GPIO pin control
wifi_*        // WiFi networking
message_*     // MQTT / messaging
sensor_*      // Sensor reading
storage_*     // Persistent storage
display_*     // Screen/display output
serial_*      // UART communication
timer_*       // Timing and delays
task_*        // Async task management
system_*      // System info, reboot, etc.
ota_*         // Over-the-air updates
log_*         // Logging
```

### File names: match the module

```
volt/
  led.h, led.c
  pin.h, pin.c
  wifi.h, wifi.c
  message.h, message.c
  sensor.h, sensor.c
  storage.h, storage.c
  task.h, task.c
  ...
```

### Rules

1. **No abbreviations** unless universally known (LED, WiFi, USB, SPI, I2C, MQTT, HTTP, OTA, ADC, PWM)
2. **No vendor prefixes** (no `esp_`, no `gpio_`, no `nvs_`)
3. **No type encoding in names** (no `i32`, `u8`, `sz`)
4. **Boolean functions start with `is_` or `has_`** (`wifi_is_connected()`, `button_is_pressed()`)
5. **Callbacks use `on_`** (`message_on_receive()`, `button_on_press()`)
6. **Max 3 words** in a function name. If you need more, the function does too much.
7. **Consistent verb vocabulary:**
   - `connect` / `disconnect` (networking)
   - `send` / `receive` (data)
   - `save` / `load` (storage)
   - `read` / `write` (hardware)
   - `start` / `stop` (processes)
   - `on` / `off` / `toggle` (switches)
   - `create` / `destroy` (resources)
   - `init` (one-time setup — only when truly needed)

---

## Error Handling

```c
// Every function that can fail returns an error_t
// VOLT_OK (0) = success, negative = error
error_t result = wifi_connect("ssid", "pass");
if (result != VOLT_OK) {
    log_error("wifi", "connection failed: %d", result);
}
```

---

## Code Style

- **4 spaces** for indentation (no tabs)
- **Opening brace** on same line: `if (x) {`
- **One blank line** between functions
- **No line longer than 100 characters**
- **Comments explain WHY, not WHAT**
- **Every public function** has a one-line doc comment in the header

```c
// Good comment:
// Wake the WiFi radio before sending — modem sleep disables it
esp_wifi_set_ps(WIFI_PS_NONE);

// Bad comment:
// Set power save to none
esp_wifi_set_ps(WIFI_PS_NONE);
```
