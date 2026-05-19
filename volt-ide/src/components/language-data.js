// Language data — extracted from Tauri app.js
// All tables that power autocomplete, hover, and signatures
// DO NOT EDIT MANUALLY — regenerate from the compiler's METHOD_TYPES/METHOD_MAP

export const SNIPPETS = [
    { label: "chip", detail: "Declare target chip", insert: "chip ${1|esp32,esp8266,rp2040,stm32f103|}", "_kind": "Keyword" },
    { label: "hardware", detail: "Hardware pin block", insert: "hardware {\n\tpin ${1:name}: ${2|Output,Input,PullUpInput,PullDownInput,Analog,PWM,Servo,DAC,Touch|} = ${3:pin_number}\n}", "_kind": "Keyword" },
    { label: "setup", detail: "Runs once at boot", insert: "setup {\n\t$0\n}", "_kind": "Keyword" },
    { label: "loop", detail: "Super-loop, runs forever", insert: "loop {\n\t$0\n}", "_kind": "Keyword" },
    { label: "include", detail: "Include another .volt file", insert: "include \"${0:file.volt}\"", "_kind": "Keyword" },
    { label: "func", detail: "Function definition", insert: "func ${1:name}(${2:params}) -> ${3:void} {\n\t$0\n}", "_kind": "Function" },
    { label: "task", detail: "Concurrent task (auto-starts)", insert: "task ${1:name} {\n\t$0\n}", "_kind": "Function" },
    { label: "machine", detail: "State machine", insert: "machine ${1:Name} {\n\tinitial state ${2:idle} {\n\t\tenter {\n\t\t\t$0\n\t\t}\n\t}\n}", "_kind": "Keyword" },
    { label: "struct", detail: "Custom data type", insert: "struct ${1:Name} {\n\t${2:field}: ${3:int}\n}", "_kind": "Keyword" },
    { label: "storage", detail: "Persistent variable", insert: "storage ${1:name}: ${2|int,float,bool,string|} = ${3:0}", "_kind": "Keyword" },
    { label: "raw", detail: "Inline C code block", insert: "raw {\n\t\"${0}\"\n}", "_kind": "Keyword" },

    // Control flow
    { label: "if", detail: "Conditional branch", insert: "if ${1:condition} {\n\t$0\n}", "_kind": "Keyword" },
    { label: "if else", detail: "If-else branch", insert: "if ${1:condition} {\n\t$2\n} else {\n\t$0\n}", "_kind": "Keyword" },
    { label: "while", detail: "While loop", insert: "while ${1:condition} {\n\t$0\n}", "_kind": "Keyword" },
    { label: "for", detail: "Range loop", insert: "for ${1:i} in ${2:0}..${3:10} {\n\t$0\n}", "_kind": "Keyword" },
    { label: "match", detail: "Pattern match", insert: "match(${1:expr}) {\n\t${2:value} -> {\n\t\t$0\n\t}\n}", "_kind": "Keyword" },
    { label: "every", detail: "Periodic block", insert: "every ${1|100ms,250ms,500ms,1s,5s,10s|} {\n\t$0\n}", "_kind": "Keyword" },
    { label: "every strict", detail: "Critical ISR periodic", insert: "every ${1|100us,500us,1ms,5ms,10ms|} strict {\n\t$0\n}", "_kind": "Keyword" },
    { label: "on", detail: "Event handler", insert: "on ${1:event} {\n\t$0\n}", "_kind": "Keyword" },
    { label: "on debounce", detail: "Debounced event handler", insert: "on ${1:event} debounce ${2:50ms} {\n\t$0\n}", "_kind": "Keyword" },
    { label: "timeout", detail: "Timeout block", insert: "timeout ${1:5s} {\n\t$2\n} else {\n\t$0\n}", "_kind": "Keyword" },

    // Variables
    { label: "let", detail: "Immutable variable", insert: "let ${1:name} = ${0}", "_kind": "Variable" },
    { label: "var", detail: "Mutable variable", insert: "var ${1:name}: ${2|int,float,bool,string|} = ${0}", "_kind": "Variable" },

    // State machine internals
    { label: "initial state", detail: "Starting state", insert: "initial state ${1:idle} {\n\tenter {\n\t\t$0\n\t}\n}", "_kind": "Keyword" },
    { label: "state", detail: "State declaration", insert: "state ${1:name} {\n\tenter {\n\t\t$0\n\t}\n}", "_kind": "Keyword" },
    { label: "enter", detail: "State enter action", insert: "enter {\n\t$0\n}", "_kind": "Keyword" },
    { label: "exit", detail: "State exit action", insert: "exit {\n\t$0\n}", "_kind": "Keyword" },
    { label: "after", detail: "Timed transition", insert: "after ${1:5s} -> ${0:target}", "_kind": "Keyword" },
    { label: "on ->", detail: "Event transition", insert: "on ${1:event} -> ${0:target}", "_kind": "Keyword" },
    { label: "on [] ->", detail: "Guarded transition", insert: "on ${1:event} [${2:guard}] -> ${0:target}", "_kind": "Keyword" },

    // Hardware
    { label: "pin Output", detail: "Digital output pin", insert: "pin ${1:led}: Output = ${0:2}", "_kind": "Property" },
    { label: "pin Input", detail: "Digital input pin", insert: "pin ${1:btn}: Input = ${0:0}", "_kind": "Property" },
    { label: "pin PullUpInput", detail: "Input with pull-up", insert: "pin ${1:btn}: PullUpInput = ${0:0}", "_kind": "Property" },
    { label: "pin Analog", detail: "Analog input (ADC)", insert: "pin ${1:sensor}: Analog = ${0:34}", "_kind": "Property" },
    { label: "pin PWM", detail: "PWM output", insert: "pin ${1:motor}: PWM = ${0:25}", "_kind": "Property" },
    { label: "pin Servo", detail: "Servo motor (0-180\u00B0)", insert: "pin ${1:arm}: Servo = ${0:13}", "_kind": "Property" },
    { label: "pin DAC", detail: "Analog output (ESP32: GPIO 25/26)", insert: "pin ${1:dac}: DAC = ${0:25}", "_kind": "Property" },
    { label: "pin Touch", detail: "Capacitive touch (ESP32 only)", insert: "pin ${1:pad}: Touch = ${0:4}", "_kind": "Property" },
    { label: "bus I2C", detail: "I2C bus declaration", insert: "bus ${1:sensors}: I2C(sda: ${2:21}, scl: ${3:22})", "_kind": "Property" },
    { label: "device BME280", detail: "Temp/humidity/pressure", insert: "device ${1:bme}: BME280 on ${2:sensors} at ${0:0x76}", "_kind": "Property" },
    { label: "device AHT20", detail: "Temp/humidity", insert: "device ${1:aht}: AHT20 on ${2:sensors} at ${0:0x38}", "_kind": "Property" },
    { label: "device SHT31", detail: "Precision temp/humidity", insert: "device ${1:sht}: SHT31 on ${2:sensors} at ${0:0x44}", "_kind": "Property" },
    { label: "device MPU6050", detail: "6-axis IMU (accel+gyro)", insert: "device ${1:imu}: MPU6050 on ${2:sensors} at ${0:0x68}", "_kind": "Property" },
    { label: "device INA219", detail: "Voltage/current/power monitor", insert: "device ${1:pwr}: INA219 on ${2:sensors} at ${0:0x40}", "_kind": "Property" },
    { label: "device DS3231", detail: "Real-time clock", insert: "device ${1:rtc}: DS3231 on ${2:sensors} at ${0:0x68}", "_kind": "Property" },
    { label: "device BH1750", detail: "Light sensor", insert: "device ${1:light}: BH1750 on ${2:sensors} at ${0:0x23}", "_kind": "Property" },
    { label: "device VEML7700", detail: "Precision light sensor", insert: "device ${1:als}: VEML7700 on ${2:sensors} at ${0:0x10}", "_kind": "Property" },
    { label: "device SSD1306", detail: "OLED display 128x64", insert: "device ${1:oled}: SSD1306 on ${2:sensors} at ${0:0x3C}", "_kind": "Property" },
    { label: "channel", detail: "Inter-task data channel", insert: "channel ${1:data}: ${2:int}[${0:8}]", "_kind": "Property" },

    // Builtin function calls
    { label: "log", detail: "Print log message", insert: "log(\"${1:tag}\", \"${0:message}\")", "_kind": "Function" },
    { label: "sleep", detail: "Suspend task for duration", insert: "sleep(${0:500ms})", "_kind": "Function" },
    { label: "deep_sleep", detail: "Deep sleep (timer wake)", insert: "deep_sleep(${0:60s})", "_kind": "Function" },
    { label: "light_sleep", detail: "Light sleep (fast wake)", insert: "light_sleep(${0:10s})", "_kind": "Function" },
];


export const PIN_METHODS = {
    Output: [
        { label: "on", detail: "() -> void — set HIGH", insert: "on()" },
        { label: "off", detail: "() -> void — set LOW", insert: "off()" },
        { label: "toggle", detail: "() -> void — flip HIGH/LOW", insert: "toggle()" },
        { label: "write", detail: "(level: int) -> void", insert: "write(${1:HIGH})" },
        { label: "is_on", detail: "() -> bool", insert: "is_on()" },
        { label: "blink", detail: "(interval: Duration) -> void", insert: "blink(${1:500ms})" },
        { label: "blink_once", detail: "(duration: Duration) -> void", insert: "blink_once(${1:200ms})" },
    ],
    Input: [
        { label: "read", detail: "() -> int (0 or 1)", insert: "read()" },
    ],
    "PullUpInput": [
        { label: "read", detail: "() -> int (0 or 1)", insert: "read()" },
        { label: "is_pressed", detail: "() -> bool (active LOW)", insert: "is_pressed()" },
        { label: "press", detail: "event source for on blocks", insert: "press" },
    ],
    "PullDownInput": [
        { label: "read", detail: "() -> int (0 or 1)", insert: "read()" },
        { label: "is_pressed", detail: "() -> bool", insert: "is_pressed()" },
        { label: "press", detail: "event source for on blocks", insert: "press" },
    ],
    Analog: [
        { label: "read", detail: "() -> int (0-4095)", insert: "read()" },
    ],
    PWM: [
        { label: "write", detail: "(value: int) -> void — duty cycle 0-255", insert: "write(${1:128})" },
        { label: "set_pwm", detail: "(value: int) -> void — duty cycle 0-255", insert: "set_pwm(${1:128})" },
        { label: "tone", detail: "(freq: int) -> void — play frequency", insert: "tone(${1:440})" },
        { label: "tone_ms", detail: "(freq: int, dur: int) -> void — play for duration", insert: "tone_ms(${1:440}, ${2:500})" },
        { label: "no_tone", detail: "() -> void — stop tone", insert: "no_tone()" },
        { label: "click", detail: "() -> void — short click feedback", insert: "click()" },
        { label: "beep_success", detail: "() -> void — two rising beeps", insert: "beep_success()" },
        { label: "beep_error", detail: "() -> void — three low buzzes", insert: "beep_error()" },
        { label: "beep_warning", detail: "() -> void — two-tone alert", insert: "beep_warning()" },
        { label: "beep_startup", detail: "() -> void — ascending chime", insert: "beep_startup()" },
        { label: "beep_shutdown", detail: "() -> void — descending notes", insert: "beep_shutdown()" },
        { label: "beep_notify", detail: "() -> void — gentle double beep", insert: "beep_notify()" },
        { label: "beep_alarm", detail: "() -> void — urgent siren pattern", insert: "beep_alarm()" },
        { label: "beep_keypad", detail: "(digit: int) -> void — DTMF beep 0-9", insert: "beep_keypad(${1:0})" },
    ],
    Servo: [
        { label: "move", detail: "(angle: int) -> void — instant move (0-180\u00B0)", insert: "move(${1:90})" },
        { label: "move_us", detail: "(us: int) -> void — raw pulse width", insert: "move_us(${1:1500})" },
        { label: "angle", detail: "() -> float — current angle", insert: "angle()" },
        { label: "ease_to", detail: "(angle, duration) -> void — smooth move", insert: "ease_to(${1:90}, ${2:500ms})" },
        { label: "ease_to_with", detail: "(angle, duration, easing) -> void", insert: "ease_to_with(${1:90}, ${2:500ms}, ${3:ease_out})" },
        { label: "sweep", detail: "(from, to, duration) -> void — linear sweep", insert: "sweep(${1:0}, ${2:180}, ${3:2s})" },
        { label: "sweep_ease", detail: "(from, to, duration, easing) -> void", insert: "sweep_ease(${1:0}, ${2:180}, ${3:2s}, ${4:ease_in_out})" },
        { label: "detach", detail: "() -> void — release servo (goes limp)", insert: "detach()" },
        { label: "set_max_angle", detail: "(angle: int) -> void — for 270\u00B0 servos", insert: "set_max_angle(${1:270})" },
    ],
    DAC: [
        { label: "write", detail: "(value: int) -> void — raw 0-255", insert: "write(${1:128})" },
        { label: "voltage", detail: "(volts: float) -> void — 0.0-3.3V", insert: "voltage(${1:1.65})" },
        { label: "read", detail: "() -> int — current DAC value 0-255", insert: "read()" },
    ],
    Touch: [
        { label: "read", detail: "() -> int — raw capacitance value", insert: "read()" },
        { label: "is_touched", detail: "() -> bool — below threshold?", insert: "is_touched()" },
        { label: "set_threshold", detail: "(threshold: int) -> void", insert: "set_threshold(${1:20})" },
        { label: "release", detail: "() -> void — release touch pin", insert: "release()" },
    ],
};


export const SENSOR_METHODS = {
    BME280: [
        { label: "temperature", detail: "() -> float (C)", insert: "temperature()" },
        { label: "humidity", detail: "() -> float (%)", insert: "humidity()" },
        { label: "pressure", detail: "() -> float (hPa)", insert: "pressure()" },
    ],
    AHT20: [
        { label: "temperature", detail: "() -> float (C)", insert: "temperature()" },
        { label: "humidity", detail: "() -> float (%)", insert: "humidity()" },
    ],
    SHT31: [
        { label: "temperature", detail: "() -> float (C)", insert: "temperature()" },
        { label: "humidity", detail: "() -> float (%)", insert: "humidity()" },
    ],
    DHT22: [
        { label: "temperature", detail: "() -> float (C)", insert: "temperature()" },
        { label: "humidity", detail: "() -> float (%)", insert: "humidity()" },
    ],
    MPU6050: [
        { label: "accel_x", detail: "() -> float (g)", insert: "accel_x()" },
        { label: "accel_y", detail: "() -> float (g)", insert: "accel_y()" },
        { label: "accel_z", detail: "() -> float (g)", insert: "accel_z()" },
        { label: "gyro_x", detail: "() -> float (deg/s)", insert: "gyro_x()" },
        { label: "gyro_y", detail: "() -> float (deg/s)", insert: "gyro_y()" },
        { label: "gyro_z", detail: "() -> float (deg/s)", insert: "gyro_z()" },
        { label: "temperature", detail: "() -> float (C)", insert: "temperature()" },
    ],
    INA219: [
        { label: "voltage", detail: "() -> float (V)", insert: "voltage()" },
        { label: "current", detail: "() -> float (A)", insert: "current()" },
        { label: "power", detail: "() -> float (W)", insert: "power()" },
        { label: "shunt_voltage", detail: "() -> float (V)", insert: "shunt_voltage()" },
    ],
    DS3231: [
        { label: "hours", detail: "() -> int", insert: "hours()" },
        { label: "minutes", detail: "() -> int", insert: "minutes()" },
        { label: "seconds", detail: "() -> int", insert: "seconds()" },
        { label: "year", detail: "() -> int", insert: "year()" },
        { label: "month", detail: "() -> int", insert: "month()" },
        { label: "date", detail: "() -> int", insert: "date()" },
        { label: "temperature", detail: "() -> float (C)", insert: "temperature()" },
    ],
    BH1750: [
        { label: "lux", detail: "() -> float", insert: "lux()" },
    ],
    VEML7700: [
        { label: "lux", detail: "() -> float", insert: "lux()" },
        { label: "white", detail: "() -> float", insert: "white()" },
    ],
    SSD1306: [
        { label: "clear", detail: "() -> void", insert: "clear()" },
        { label: "text", detail: "(x: int, y: int, text: string) -> void", insert: "text(${1:0}, ${2:0}, \"${3:hello}\")" },
        { label: "show", detail: "() -> void — flush to display", insert: "show()" },
    ],
};


export const TYPES = [
    { label: "int", detail: "32-bit signed integer" },
    { label: "float", detail: "32-bit floating point" },
    { label: "bool", detail: "Boolean true/false" },
    { label: "string", detail: "UTF-8 string" },
    { label: "void", detail: "No return value" },
    { label: "Duration", detail: "Time duration" },
    { label: "Output", detail: "Digital output pin mode" },
    { label: "Input", detail: "Digital input pin mode" },
    { label: "PullUpInput", detail: "Input with pull-up resistor" },
    { label: "PullDownInput", detail: "Input with pull-down resistor" },
    { label: "Analog", detail: "ADC analog input" },
    { label: "PWM", detail: "PWM output" },
    { label: "Servo", detail: "Servo motor control (0-180\u00B0, 50Hz PWM)" },
    { label: "DAC", detail: "Analog voltage output (ESP32: GPIO 25/26 only)" },
    { label: "Touch", detail: "Capacitive touch sensing (ESP32 only)" },
];


export const CHIPS = [
    { label: "esp32", detail: "ESP32 WROOM-32 — dual-core, WiFi+BT, 520KB" },
    { label: "esp8266", detail: "ESP8266 — single-core, WiFi, 80KB" },
    { label: "rp2040", detail: "RP2040 Pico — dual-core ARM, 264KB, no WiFi" },
    { label: "stm32f103", detail: "STM32 Blue Pill — Cortex-M3, 20KB" },
];


export const DURATIONS = [
    "100us", "500us", "1ms", "5ms", "10ms", "50ms", "100ms", "250ms",
    "500ms", "1s", "2s", "5s", "10s", "30s",
    "1min", "5min", "10min", "1hr"
];


export const CONSTANTS = [
    { label: "true", detail: "Boolean true", "_kind": "Constant" },
    { label: "false", detail: "Boolean false", "_kind": "Constant" },
    { label: "HIGH", detail: "Pin level 1", "_kind": "Constant" },
    { label: "LOW", detail: "Pin level 0", "_kind": "Constant" },
    { label: "ON", detail: "Pin level 1", "_kind": "Constant" },
    { label: "OFF", detail: "Pin level 0", "_kind": "Constant" },
    // Servo easing curves — use case hints in detail
    { label: "linear", detail: "Constant speed \u2014 conveyors, wipers, scanning", "_kind": "Constant" },
    { label: "ease_in", detail: "Slow start, fast end \u2014 lifting from rest", "_kind": "Constant" },
    { label: "ease_out", detail: "Fast start, gentle stop \u2014 grippers, gauges", "_kind": "Constant" },
    { label: "ease_in_out", detail: "Smooth start + stop \u2014 default, most natural", "_kind": "Constant" },
    { label: "ease_in_cubic", detail: "Very slow start \u2014 heavy machinery, cranes", "_kind": "Constant" },
    { label: "ease_out_cubic", detail: "Extra gentle stop \u2014 precision positioning", "_kind": "Constant" },
    { label: "ease_in_out_cubic", detail: "Dramatic S-curve \u2014 animatronics, stage props", "_kind": "Constant" },
    { label: "ease_in_sine", detail: "Subtlest slow start \u2014 organic, breathing", "_kind": "Constant" },
    { label: "ease_out_sine", detail: "Natural deceleration \u2014 doors, pendulums", "_kind": "Constant" },
    { label: "ease_in_out_sine", detail: "Smoothest motion \u2014 gimbals, cameras", "_kind": "Constant" },
    { label: "ease_bounce", detail: "Bouncy landing \u2014 toys, indicators, playful", "_kind": "Constant" },
    { label: "ease_back", detail: "Overshoots then settles \u2014 latches, switches", "_kind": "Constant" },
    { label: "ease_elastic", detail: "Springy wobble \u2014 bobbleheads, novelty", "_kind": "Constant" },
];


export const KEYWORD_DOCS = {
    chip:     { sig: "chip <target>", desc: "Declare the target microcontroller for this program.", detail: "The chip declaration tells the compiler which hardware to validate against. Pin numbers, capabilities (WiFi, Bluetooth, touch), and memory limits are all checked at compile time.\n\nSupported chips: esp32, esp8266, rp2040, stm32f103", cat: "Declaration" },
    hardware: { sig: "hardware { ... }", desc: "Define all physical pin connections.", detail: "The hardware block declares every pin and device your project uses. The compiler validates pin numbers against the chip datasheet, checks for conflicts (duplicate pins), and warns about strapping pins or other hardware gotchas.", cat: "Declaration" },
    setup:    { sig: "setup { ... }", desc: "Runs once at boot before tasks start.", detail: "Use setup for initialization: WiFi/MQTT connections, initial pin states, configuration loading. After setup completes, all declared tasks auto-start.", cat: "Declaration" },
    loop:     { sig: "loop { ... }", desc: "Super-loop — runs forever.", detail: "Alternative to tasks for simple programs. Cannot be used with `task` declarations. Code runs in an infinite loop, use `sleep()` for timing.", cat: "Declaration" },
    include:  { sig: "include \"file.volt\"", desc: "Include another Volt source file.", cat: "Declaration" },
    break:    { sig: "break", desc: "Exit the current loop.", cat: "Control Flow" },
    continue: { sig: "continue", desc: "Skip to next loop iteration.", cat: "Control Flow" },
    func:     { sig: "func name(params) -> type { ... }", desc: "Define a reusable function.", detail: "Functions can take typed parameters and return a value. They are inlined into tasks by the compiler when possible.", cat: "Declaration" },
    task:     { sig: "task name { ... }", desc: "Concurrent task — auto-starts after setup.", detail: "Tasks run concurrently using one of three tiers:\n- **Background** (default): cooperative protothread, 12 bytes overhead\n- **Priority**: FreeRTOS task with own stack, for WiFi/MQTT/HTTP\n- **Critical**: hardware timer ISR, for real-time GPIO\n\nThe compiler auto-classifies based on what APIs you use. Multiple `every`/`on` blocks in one task auto-split into concurrent sub-tasks.", cat: "Declaration" },
    machine:  { sig: "machine Name { ... }", desc: "Define a finite state machine.", detail: "State machines are verified at compile time:\n- Reachability: every state must be reachable from `initial`\n- Dead states: warns if a state has no outgoing transitions\n- Determinism: flags ambiguous transitions for the same event\n\nUse `var` inside machine for shared state across all states.", cat: "Declaration" },
    struct:   { sig: "struct Name { field: type, ... }", desc: "Define a custom data type with named fields.", cat: "Declaration" },
    storage:  { sig: "storage name: type = default", desc: "Persistent variable saved to flash (NVS).", detail: "Storage variables survive reboots. Values are buffered in RAM and flushed to flash every 30 seconds to reduce wear. Use for counters, settings, or calibration data.", cat: "Declaration" },
    raw:      { sig: "raw { \"C code\" }", desc: "Inline C code escape hatch.", detail: "Use sparingly for hardware-specific operations not yet supported by Volt. The string is inserted directly into generated C code.", cat: "Declaration" },
    let:      { sig: "let name = value", desc: "Immutable variable. Cannot be reassigned after declaration.", detail: "Use `let` by default. Switch to `var` only when you need to change the value later.", cat: "Variable" },
    var:      { sig: "var name: type = value", desc: "Mutable variable. Can be reassigned.", cat: "Variable" },
    if:       { sig: "if condition { ... } else { ... }", desc: "Conditional branch. Condition must be a `bool`.", detail: "Use comparisons (`x > 0`), boolean functions (`wifi.is_connected()`), or boolean variables. The compiler will error if you pass an `int` instead of `bool`.", cat: "Control Flow" },
    else:     { sig: "else { ... } or else if condition { ... }", desc: "Alternative branch after `if`.", cat: "Control Flow" },
    while:    { sig: "while condition { ... }", desc: "Repeat while condition is true.", cat: "Control Flow" },
    for:      { sig: "for i in start..end { ... }", desc: "Loop over an integer range.", detail: "Both start and end must be `int`. The loop variable `i` is scoped to the for block.", cat: "Control Flow" },
    match:    { sig: "match(expr) { value -> { ... } }", desc: "Pattern matching on a value.", cat: "Control Flow" },
    every:    { sig: "every <duration> { ... }", desc: "Run code periodically inside a task.", detail: "This is a yield point — the task suspends and resumes after the interval. Use inside `task` blocks.\n\nExamples: `every 500ms`, `every 1s`, `every 5min`", cat: "Control Flow" },
    strict:   { sig: "every <duration> strict { ... }", desc: "Critical ISR block — runs as hardware timer interrupt.", detail: "**Restrictions inside strict blocks:**\n- No WiFi, MQTT, HTTP, storage, or sensor calls\n- No log() or sleep()\n- Only GPIO read/write/toggle and arithmetic\n- Budget: ~20 microseconds (5000 cycles at 240MHz)\n\nUse for precise timing: motor control, signal generation, fast sampling.", cat: "Modifier" },
    on:       { sig: "on event { ... } or on event -> state", desc: "React to an event (button press, message, etc.).", detail: "In tasks: `on button.press() debounce 50ms { ... }`\nIn state machines: `on event -> target_state`\nWith guards: `on event [condition] -> target`", cat: "Control Flow" },
    timeout:  { sig: "timeout <duration> { ... } { fallback }", desc: "Try a block with a time limit. Runs fallback if it times out.", cat: "Control Flow" },
    state:    { sig: "state name { enter { } exit { } on ... -> ... }", desc: "A state in a state machine.", detail: "States can have:\n- `enter { }` — code run when entering\n- `exit { }` — code run when leaving\n- `on event -> target` — event transitions\n- `after 5s -> target` — timed transitions\n- `every 1s { }` — periodic code while in state", cat: "State Machine" },
    initial:  { sig: "initial state name { ... }", desc: "The starting state of a state machine. Exactly one required.", cat: "State Machine" },
    enter:    { sig: "enter { ... }", desc: "Code that runs when entering this state.", cat: "State Machine" },
    exit:     { sig: "exit { ... }", desc: "Code that runs when leaving this state.", cat: "State Machine" },
    after:    { sig: "after <duration> -> target", desc: "Auto-transition after a time delay.", detail: "The timer starts when the state is entered. Can be guarded: `after 5s [retries < 3] -> retry`", cat: "State Machine" },
    return:   { sig: "return value", desc: "Return a value from the current function.", cat: "Control Flow" },
    debounce: { sig: "on event debounce <duration> { ... }", desc: "Ignore rapid repeated events. Only fire after the event stops for the given duration.", cat: "Modifier" },
    throttle: { sig: "on event throttle <duration> { ... }", desc: "Limit event firing rate. At most once per duration.", cat: "Modifier" },
    run:      { sig: "run(task1, task2, ...)", desc: "Explicitly start specific tasks (optional).", detail: "In v2, tasks auto-start after setup. Use `run()` only if you want to start specific tasks manually.", cat: "Builtin Function" },
    log:      { sig: "log(tag: string, message: string)", desc: "Print a log message to serial monitor.", detail: "Supports string interpolation: `log(\"sensor\", \"temp={reading}C\")`\nNot allowed in `strict` blocks (ISR context).", cat: "Builtin Function" },
    sleep:    { sig: "sleep(duration)", desc: "Suspend the current task for a duration.", detail: "This is a yield point — other tasks run while this one sleeps. Only works in tasks, not in main.\n\nExamples: `sleep(500ms)`, `sleep(2s)`", cat: "Builtin Function" },
    deep_sleep: { sig: "deep_sleep(duration)", desc: "Put the entire chip into deep sleep.", detail: "Wakes via timer. All RAM is lost — execution restarts from main. Use `storage` to persist data across deep sleep cycles.", cat: "Builtin Function" },
    light_sleep: { sig: "light_sleep(duration)", desc: "Light sleep — faster wake, RAM preserved.", cat: "Builtin Function" },
};


export const TYPE_DOCS = {
    Output:        { desc: "Digital output pin", detail: "Methods: `on()`, `off()`, `toggle()`, `write(level)`, `is_on()`, `blink(interval)`, `blink_once(duration)`" },
    Input:         { desc: "Digital input pin (floating)", detail: "Methods: `read()` returns 0 or 1\n\nFor buttons, use `PullUpInput` or `PullDownInput` instead \u2014 they have `is_pressed()` and reliable logic levels." },
    "PullUpInput":{ desc: "Input with internal pull-up resistor", detail: "Button convention: pressed = LOW. Methods: `read()`, `is_pressed()`, `press` (event for `on` blocks)" },
    "PullDownInput":{ desc: "Input with internal pull-down resistor", detail: "Methods: `read()`, `is_pressed()`, `press` (event for `on` blocks)" },
    Analog:        { desc: "ADC analog input", detail: "Returns 0-4095 (12-bit). On ESP32: ADC2 pins are blocked during WiFi — use ADC1 (GPIO 32-39)." },
    PWM:           { desc: "Pulse-width modulation output", detail: "Methods: `write(value)`, `set_pwm(value)` — duty cycle 0-255\nTone: `tone(freq)`, `tone_ms(freq, dur)`, `no_tone()`\nPatterns: `click()`, `beep_success()`, `beep_error()`, `beep_warning()`, `beep_startup()`, `beep_shutdown()`, `beep_notify()`, `beep_alarm()`, `beep_keypad(digit)`" },
    Touch:         { desc: "Capacitive touch sensing (ESP32 only)", detail: "10 touch pins: GPIO 4,0,2,15,13,12,14,27,33,32.\nDetects finger proximity via capacitance \u2014 no external parts.\nAuto-calibrates on init (70% of untouched baseline).\n\nMethods:\n- `read()` \u2014 raw capacitance (lower = touched)\n- `is_touched()` \u2014 bool based on threshold\n- `set_threshold(value)` \u2014 manual tuning\n- `release()` \u2014 free the pin\n\nRP2040/STM32: no touch hardware." },
    DAC:           { desc: "Digital-to-Analog Converter — true analog voltage output", detail: "ESP32 only: GPIO 25 (ch0) and GPIO 26 (ch1). 8-bit resolution (0-255 = 0-3.3V).\nOutputs a real analog voltage, not PWM. No filtering needed.\n\nMethods:\n- `write(value)` \u2014 raw 0-255\n- `voltage(volts)` \u2014 set exact voltage (0.0-3.3V)\n- `read()` \u2014 current DAC value\n\nRP2040/STM32: no internal DAC. Use MCP4725 (I2C) instead." },
    Servo:         { desc: "Servo motor control (50Hz PWM)", detail: "Works with SG90, MG90S, MG996R, DS3218, and any hobby servo.\n\nMethods:\n- `move(angle)` — instant position (0-180\u00B0)\n- `ease_to(angle, duration)` — smooth movement\n- `ease_to_with(angle, duration, easing)` — with curve\n- `sweep(from, to, duration)` — linear sweep\n- `sweep_ease(from, to, duration, easing)` — eased sweep\n- `angle()` — read current position\n- `detach()` — release (servo goes limp)\n- `set_max_angle(270)` — for 270\u00B0 servos\n\nEasing: `linear`, `ease_in`, `ease_out`, `ease_in_out`, `ease_bounce`, `ease_back`, `ease_elastic`" },
    int:           { desc: "32-bit signed integer (-2B to +2B)", detail: "Arithmetic: `+`, `-`, `*`, `/`, `%`\nConvert to float: `float(x)`" },
    float:         { desc: "32-bit floating point", detail: "Arithmetic: `+`, `-`, `*`, `/`\nConvert to int: `int(x)`\nNote: no `%` for floats" },
    bool:          { desc: "Boolean — `true` or `false`", detail: "Operators: `&&` (and), `||` (or), `!` (not)\nRequired for `if`/`while` conditions" },
    string:        { desc: "UTF-8 string", detail: "Interpolation: `\"temp is {value}C\"`\nConcatenation: `\"hello\" + name`" },
    Duration:      { desc: "Time duration", detail: "Literal forms: `100us`, `500ms`, `5s`, `10min`, `1hr`\nUsed in: `every`, `sleep`, `after`, `timeout`, `debounce`, `throttle`" },
};


export const CHIP_DOCS = {
    esp32:     { desc: "ESP32 WROOM-32", detail: "**Specs:** Xtensa LX6 dual-core @ 240MHz, 520KB RAM, 4MB flash\n**Features:** WiFi, Bluetooth, BLE, touch sensing, DAC, ADC, PWM\n**GPIO:** 0-39 (skip 6-11 flash, 20/24/28-31 unavailable)\n**Safe output pins:** 2, 4, 5, 13-19, 21-23, 25-27, 32-33\n**Input-only:** 34-39 (no pull resistors)\n**ADC1 (WiFi-safe):** 32-39\n**ADC2 (blocked by WiFi):** 0, 2, 4, 12-15, 25-27\n**I2C default:** SDA=21, SCL=22" },
    esp8266:   { desc: "ESP8266", detail: "**Specs:** Xtensa LX106 single-core @ 80MHz, 80KB RAM\n**Features:** WiFi, PWM (software), ADC (A0 only, not GPIO)\n**GPIO:** 0-16 (skip 6-11 flash)\n**No:** Bluetooth, touch, DAC, hardware PWM\n**GPIO 16:** RTC domain — no PWM, no interrupts, pull-down only\n**I2C default:** SDA=4, SCL=5\n**Note:** Only A0/TOUT pin has analog — GPIO analog reads will error" },
    rp2040:    { desc: "RP2040 Raspberry Pi Pico", detail: "**Specs:** ARM Cortex-M0+ dual-core @ 133MHz, 264KB RAM\n**Features:** PWM, ADC, PIO, USB\n**GPIO:** GP0-GP28 (GP29 internal voltage)\n**ADC:** GP26, GP27, GP28 only (12-bit)\n**No:** WiFi (use Pico W), Bluetooth, touch, DAC\n**GP25:** Onboard LED (Pico) / WiFi SPI (Pico W)\n**I2C0:** SDA=GP0, SCL=GP1" },
    stm32f103: { desc: "STM32F103 Blue Pill", detail: "**Specs:** ARM Cortex-M3 @ 72MHz, 20KB RAM, 64KB flash\n**No:** WiFi, Bluetooth" },
};


export const ESP32_PIN_NOTES = {
    0: "Strapping: must be HIGH at boot. LOW = bootloader mode.",
    1: "UART0 TX — using this breaks serial monitor/flashing.",
    2: "Strapping: must be LOW for flash programming. Often onboard LED.",
    3: "UART0 RX — using this breaks serial input.",
    4: "General purpose. Safe for most uses. ADC2 channel, touch T0.",
    5: "Strapping: controls boot debug output. VSPI CS0. Usually safe.",
    12: "CRITICAL: if HIGH at boot, sets flash to 1.8V — chip may not boot.",
    13: "JTAG pin. HSPI MOSI. Safe for general use.",
    14: "JTAG pin. HSPI CLK. Safe for general use.",
    15: "Strapping: if LOW, boot messages suppressed. HSPI CS.",
    16: "PSRAM on WROVER modules. Safe on WROOM.",
    17: "PSRAM on WROVER modules. Safe on WROOM.",
    21: "Default I2C SDA.",
    22: "Default I2C SCL.",
    25: "DAC channel 1.",
    26: "DAC channel 2.",
    34: "Input only. No pull resistors. ADC1.",
    35: "Input only. No pull resistors. ADC1.",
    36: "Input only. ADC1. ISR errata with WiFi sleep.",
    39: "Input only. ADC1. ISR errata with WiFi sleep.",
};


export const METHOD_SIGS = {
    // wifi
    "wifi.connect":      { label: "wifi.connect(ssid: string, password: string)", params: [{ label: "ssid: string", doc: "WiFi network name" }, { label: "password: string", doc: "WiFi password" }] },
    "wifi.disconnect":   { label: "wifi.disconnect()", params: [] },
    "wifi.is_connected": { label: "wifi.is_connected() -> bool", params: [] },
    "wifi.get_ip":       { label: "wifi.get_ip() -> string", params: [] },
    "wifi.get_rssi":     { label: "wifi.get_rssi() -> int", params: [] },
    // mqtt
    "mqtt.connect":      { label: "mqtt.connect(url: string)", params: [{ label: "url: string", doc: "Broker URL: mqtt://host, mqtts://host, mqtt://user:pass@host" }] },
    "mqtt.disconnect":   { label: "mqtt.disconnect()", params: [] },
    "mqtt.is_connected": { label: "mqtt.is_connected() -> bool", params: [] },
    "mqtt.send":         { label: "mqtt.send(topic: string, data: string)", params: [{ label: "topic: string", doc: "MQTT topic path" }, { label: "data: string", doc: "Message payload" }] },
    "mqtt.send_int":     { label: "mqtt.send_int(topic: string, value: int)", params: [{ label: "topic: string", doc: "MQTT topic path" }, { label: "value: int", doc: "Integer value to publish" }] },
    "mqtt.send_float":   { label: "mqtt.send_float(topic: string, value: float)", params: [{ label: "topic: string", doc: "MQTT topic path" }, { label: "value: float", doc: "Float value (2 decimal places)" }] },
    "mqtt.on_receive":   { label: "mqtt.on_receive(topic: string)", params: [{ label: "topic: string", doc: "Topic to subscribe (supports # wildcard)" }] },
    // http
    "http.get":          { label: "http.get(url: string) -> string", params: [{ label: "url: string", doc: "Full URL to fetch" }] },
    "http.post":         { label: "http.post(url: string, body: string) -> string", params: [{ label: "url: string", doc: "Full URL to post to" }, { label: "body: string", doc: "Request body" }] },
    // storage
    "storage.save":       { label: "storage.save(key: string, value)", params: [{ label: "key: string", doc: "Storage key name" }, { label: "value", doc: "Value to persist" }] },
    "storage.load":       { label: "storage.load(key: string) -> value", params: [{ label: "key: string", doc: "Storage key name" }] },
    "storage.push":       { label: "storage.push(list: string, value: int)", params: [{ label: "list: string", doc: "Named list for store-and-forward" }, { label: "value: int", doc: "Value to append" }] },
    "storage.drain":      { label: "storage.drain(list: string) -> string", params: [{ label: "list: string", doc: "Read and clear all entries" }] },
    "storage.list_count": { label: "storage.list_count(list: string) -> int", params: [{ label: "list: string", doc: "Named list" }] },
    "storage.list_clear": { label: "storage.list_clear(list: string)", params: [{ label: "list: string", doc: "Named list to clear" }] },
    // system
    "system.restart":    { label: "system.restart()", params: [] },
    "system.free_heap":  { label: "system.free_heap() -> int", params: [] },
    "system.uptime":     { label: "system.uptime() -> int", params: [] },
    "system.id":         { label: "system.id() -> int", params: [] },
    // ota
    "ota.enable":        { label: "ota.enable()", params: [] },
    "ota.check":         { label: "ota.check()", params: [] },
    // builtins
    "log":               { label: "log(tag: string, message: string)", params: [{ label: "tag: string", doc: "Log category tag" }, { label: "message: string", doc: "Message (supports interpolation: \"temp={val}\")" }] },
    "run":               { label: "run(task1, task2, ...)", params: [{ label: "tasks...", doc: "Task names to start concurrently" }] },
    "sleep":             { label: "sleep(duration: Duration)", params: [{ label: "duration: Duration", doc: "e.g. 500ms, 2s" }] },
    "deep_sleep":        { label: "deep_sleep(duration: Duration)", params: [{ label: "duration: Duration", doc: "All RAM lost. Restarts from main on wake." }] },
    "light_sleep":       { label: "light_sleep(duration: Duration)", params: [{ label: "duration: Duration", doc: "RAM preserved. Faster wake than deep_sleep." }] },
    // pin methods
    "write":    { label: "write(level: int)", params: [{ label: "level: int", doc: "HIGH (1) or LOW (0)" }] },
    "blink":    { label: "blink(interval: Duration)", params: [{ label: "interval: Duration", doc: "e.g. 500ms" }] },
    "blink_once": { label: "blink_once(duration: Duration)", params: [{ label: "duration: Duration", doc: "ON time before turning off" }] },
    "set_pwm":  { label: "set_pwm(value: int)", params: [{ label: "value: int", doc: "Duty cycle 0-255" }] },
    // PWM tone methods
    "tone":          { label: "tone(frequency: int)", params: [{ label: "frequency: int", doc: "Frequency in Hz (e.g. 440 for A4). 0 = silence." }] },
    "tone_ms":       { label: "tone_ms(frequency: int, duration: int)", params: [{ label: "frequency: int", doc: "Frequency in Hz" }, { label: "duration: int", doc: "Duration in ms" }] },
    "beep_keypad":   { label: "beep_keypad(digit: int)", params: [{ label: "digit: int", doc: "Digit 0-9 for DTMF-like beep" }] },
    // Servo methods
    // DAC methods (shared names — context-dependent)
    "dac_write":     { label: "write(value: int)", params: [{ label: "value: int", doc: "DAC value 0-255 (0V to 3.3V)" }] },
    "voltage":       { label: "voltage(volts: float)", params: [{ label: "volts: float", doc: "Output voltage 0.0 to 3.3V" }] },
    // Servo methods
    "move":          { label: "move(angle: int)", params: [{ label: "angle: int", doc: "Target angle 0-180 degrees" }] },
    "move_us":       { label: "move_us(microseconds: int)", params: [{ label: "microseconds: int", doc: "Pulse width in \u00B5s (500-2500)" }] },
    "ease_to":       { label: "ease_to(angle: int, duration: Duration)", params: [{ label: "angle: int", doc: "Target angle 0-180\u00B0" }, { label: "duration: Duration", doc: "Move time (e.g. 500ms, 1s)" }] },
    "ease_to_with":  { label: "ease_to_with(angle: int, duration: Duration, easing: int)", params: [{ label: "angle: int", doc: "Target angle 0-180\u00B0" }, { label: "duration: Duration", doc: "Move time" }, { label: "easing: int", doc: "Curve: linear, ease_out, ease_bounce, etc." }] },
    "sweep":         { label: "sweep(from: int, to: int, duration: Duration)", params: [{ label: "from: int", doc: "Start angle" }, { label: "to: int", doc: "End angle" }, { label: "duration: Duration", doc: "Sweep time" }] },
    "sweep_ease":    { label: "sweep_ease(from: int, to: int, duration: Duration, easing: int)", params: [{ label: "from: int", doc: "Start angle" }, { label: "to: int", doc: "End angle" }, { label: "duration: Duration", doc: "Sweep time" }, { label: "easing: int", doc: "Easing curve" }] },
    "set_max_angle": { label: "set_max_angle(angle: int)", params: [{ label: "angle: int", doc: "Max degrees (default 180, use 270 for 270\u00B0 servos)" }] },
    // sensor methods
    "text":     { label: "text(x: int, y: int, text: string)", params: [{ label: "x: int", doc: "X pixel position" }, { label: "y: int", doc: "Y pixel position" }, { label: "text: string", doc: "Text to display" }] },
    "send":     { label: "send(data: string) -> bool", params: [{ label: "data: string", doc: "Payload to transmit" }] },
};


export const METHOD_DOCS = {
    // wifi
    "wifi.connect":      { sig: "wifi.connect(ssid: string, password: string) -> void", desc: "Connect to a WiFi access point. Auto-reconnects with backoff on disconnect.", detail: "Forces task to Priority tier. Blocking call." },
    "wifi.disconnect":   { sig: "wifi.disconnect() -> void", desc: "Disconnect from WiFi and stop auto-reconnecting." },
    "wifi.is_connected": { sig: "wifi.is_connected() -> bool", desc: "Returns true if connected with an IP address." },
    "wifi.get_ip":       { sig: "wifi.get_ip() -> string", desc: "Returns current IP address. \"0.0.0.0\" if not connected." },
    "wifi.get_rssi":     { sig: "wifi.get_rssi() -> int", desc: "WiFi signal strength in dBm. 0 if disconnected. Typical: -30 (excellent) to -90 (poor)." },
    // mqtt
    "mqtt.connect":      { sig: "mqtt.connect(url: string) -> void", desc: "Connect to MQTT broker.", detail: "URL formats: `mqtt://host`, `mqtts://host`, `mqtt://user:pass@host`" },
    "mqtt.disconnect":   { sig: "mqtt.disconnect() -> void", desc: "Disconnect from MQTT broker." },
    "mqtt.is_connected": { sig: "mqtt.is_connected() -> bool", desc: "Returns true if connected to broker." },
    "mqtt.send":         { sig: "mqtt.send(topic: string, data: string) -> void", desc: "Publish a string message to an MQTT topic." },
    "mqtt.send_int":     { sig: "mqtt.send_int(topic: string, value: int) -> void", desc: "Publish an integer value to an MQTT topic." },
    "mqtt.send_float":   { sig: "mqtt.send_float(topic: string, value: float) -> void", desc: "Publish a float value (2 decimal places) to an MQTT topic." },
    "mqtt.on_receive":   { sig: "mqtt.on_receive(topic: string) -> void", desc: "Subscribe to an MQTT topic. Supports `#` wildcard.", detail: "Max 16 subscriptions per device." },
    // http
    "http.get":          { sig: "http.get(url: string) -> string", desc: "HTTP GET request. Returns the response body as a string." },
    "http.post":         { sig: "http.post(url: string, body: string) -> string", desc: "HTTP POST request. Returns the response body." },
    // storage
    "storage.save":       { sig: "storage.save(key: string, value) -> void", desc: "Save a value to persistent flash storage.", detail: "Buffered in RAM, flushed to flash every 30 seconds to reduce wear." },
    "storage.load":       { sig: "storage.load(key: string) -> value", desc: "Load a value from flash storage. Returns default if key not found." },
    "storage.push":       { sig: "storage.push(list: string, value: int) -> void", desc: "Append a value to a named list (store-and-forward pattern).", detail: "Use with `drain()` to batch-send data when connectivity returns." },
    "storage.drain":      { sig: "storage.drain(list: string) -> string", desc: "Read and clear all entries from a named list." },
    "storage.list_count": { sig: "storage.list_count(list: string) -> int", desc: "Count of entries in a named list." },
    "storage.list_clear": { sig: "storage.list_clear(list: string) -> void", desc: "Clear a named list without reading it." },
    // system
    "system.restart":    { sig: "system.restart() -> void", desc: "Reboot the device immediately." },
    "system.free_heap":  { sig: "system.free_heap() -> int", desc: "Available heap RAM in bytes." },
    "system.uptime":     { sig: "system.uptime() -> int", desc: "Seconds since last boot." },
    "system.id":         { sig: "system.id() -> int", desc: "Chip/device unique ID." },
    // ota
    "ota.enable":        { sig: "ota.enable() -> void", desc: "Enable over-the-air firmware update server." },
    "ota.check":         { sig: "ota.check() -> void", desc: "Check for available firmware update." },
    // Output pin methods
    "Output.on":         { sig: ".on() -> void", desc: "Set pin HIGH." },
    "Output.off":        { sig: ".off() -> void", desc: "Set pin LOW." },
    "Output.toggle":     { sig: ".toggle() -> void", desc: "Flip pin: HIGH becomes LOW, LOW becomes HIGH." },
    "Output.write":      { sig: ".write(level: int) -> void", desc: "Write HIGH (1) or LOW (0) to pin." },
    "Output.is_on":      { sig: ".is_on() -> bool", desc: "Returns true if pin is HIGH." },
    "Output.blink":      { sig: ".blink(interval: Duration) -> void", desc: "Blink the pin at the given interval." },
    "Output.blink_once": { sig: ".blink_once(duration: Duration) -> void", desc: "Turn on for duration, then turn off." },
    // Input pin methods
    "Input.read":        { sig: ".read() -> int", desc: "Read pin level: 0 (LOW) or 1 (HIGH)." },
    "Input.is_pressed":  { sig: ".is_pressed() -> bool", desc: "Returns true when button is pressed.", detail: "PullUp: pressed = LOW. PullDown: pressed = HIGH." },
    "Input.press":       { sig: ".press", desc: "Event source for `on` blocks. Use: `on button.press debounce 50ms { ... }`" },
    // Analog
    "Analog.read":       { sig: ".read() -> int", desc: "Read analog value: 0-4095 (12-bit ADC).", detail: "ESP32 ADC2 pins are blocked during WiFi. Use ADC1 (GPIO 32-39) with WiFi." },
    // PWM
    "PWM.write":         { sig: ".write(value: int) -> void", desc: "Set PWM duty cycle (0-255)." },
    "PWM.set_pwm":       { sig: ".set_pwm(value: int) -> void", desc: "Set PWM duty cycle (0-255). Alias for write()." },
    "PWM.tone":          { sig: ".tone(freq: int) -> void", desc: "Play a tone at the given frequency in Hz.", detail: "Sets 50% duty cycle square wave. Pass 0 to silence." },
    "PWM.tone_ms":       { sig: ".tone_ms(freq: int, duration: int) -> void", desc: "Play a tone for a duration (ms) then stop." },
    "PWM.no_tone":       { sig: ".no_tone() -> void", desc: "Stop any tone playing on this pin." },
    "PWM.click":         { sig: ".click() -> void", desc: "Short 2kHz tick for button press feedback.", detail: "Use case: Confirm a button was registered. Quick and unobtrusive." },
    "PWM.beep_success":  { sig: ".beep_success() -> void", desc: "Two rising beeps for confirmation.", detail: "Use case: Save completed, connection established, calibration done." },
    "PWM.beep_error":    { sig: ".beep_error() -> void", desc: "Three low buzzes for error/denied.", detail: "Use case: Invalid input, failed operation, access denied." },
    "PWM.beep_warning":  { sig: ".beep_warning() -> void", desc: "Two-tone alert for caution.", detail: "Use case: Low battery, timeout approaching, sensor out of range." },
    "PWM.beep_startup":  { sig: ".beep_startup() -> void", desc: "Ascending three-note chime.", detail: "Use case: Device powered on, system ready, boot complete." },
    "PWM.beep_shutdown": { sig: ".beep_shutdown() -> void", desc: "Descending two-note melody.", detail: "Use case: Power off, entering sleep mode, session ended." },
    "PWM.beep_notify":   { sig: ".beep_notify() -> void", desc: "Gentle double beep for notifications.", detail: "Use case: New message, event fired, threshold reached." },
    "PWM.beep_alarm":    { sig: ".beep_alarm() -> void", desc: "Urgent siren pattern (repeats 3x).", detail: "Use case: Intrusion detected, critical temperature, emergency stop." },
    "PWM.beep_keypad":   { sig: ".beep_keypad(digit: int) -> void", desc: "DTMF-like beep for digits 0-9.", detail: "Use case: Keypad input feedback, phone dialing simulation." },
    // Servo
    // Touch
    "Touch.read":           { sig: ".read() -> int", desc: "Read raw capacitance value.", detail: "Lower value = more capacitance = finger closer.\nTypical untouched: 50-100. Touched: 5-20." },
    "Touch.is_touched":     { sig: ".is_touched() -> bool", desc: "Returns true when finger is detected.", detail: "Uses auto-calibrated threshold (70% of baseline). Adjust with `set_threshold()` if needed." },
    "Touch.set_threshold":  { sig: ".set_threshold(threshold: int) -> void", desc: "Set custom touch detection threshold.", detail: "Values below this threshold = touched. Lower = less sensitive." },
    "Touch.release":        { sig: ".release() -> void", desc: "Release the touch pin back to unused state." },
    // DAC
    "DAC.write":          { sig: ".write(value: int) -> void", desc: "Set DAC output (0-255).", detail: "0 = 0V, 128 = ~1.65V, 255 = 3.3V.\n\nUse case: Audio waveform generation, analog control signals, bias voltage for sensors.\n\nExample: `dac.write(128)` \u2014 output ~1.65V" },
    "DAC.voltage":        { sig: ".voltage(volts: float) -> void", desc: "Set DAC to an exact voltage (0.0-3.3V).", detail: "Internally mapped to 0-255 range.\n\nUse case: Precision voltage reference, sensor calibration, threshold setting.\n\nExample: `dac.voltage(1.5)` \u2014 output exactly 1.5V" },
    "DAC.read":           { sig: ".read() -> int", desc: "Read the current DAC value (0-255).", detail: "Returns the last value written, not a hardware readback.\n\nExample: `var level: int = dac.read()`" },
    // Servo
    "Servo.move":         { sig: ".move(angle: int) -> void", desc: "Move to angle instantly (0-180\u00B0).", detail: "Use case: Set a position immediately. No interpolation \u2014 the servo jumps.\n\nExample: `arm.move(90)` \u2014 center position" },
    "Servo.move_us":      { sig: ".move_us(microseconds: int) -> void", desc: "Set exact pulse width in microseconds.", detail: "Bypasses angle mapping. Standard range: 500-2500\u00B5s.\n\nUse case: Fine-tuning when you know your servo's exact pulse range.\n\nExample: `arm.move_us(1500)` \u2014 center for most servos" },
    "Servo.angle":        { sig: ".angle() -> float", desc: "Read the last written angle.", detail: "Returns the most recently set angle, not a hardware readback.\n\nUse case: Track position for relative movements.\n\nExample: `var pos: float = arm.angle()`" },
    "Servo.ease_to":      { sig: ".ease_to(angle: int, duration: Duration) -> void", desc: "Smooth move to target angle over time.", detail: "Uses `ease_in_out` (quadratic) by default \u2014 slow start, smooth stop.\nBlocks for the full duration.\n\nUse case: Any movement that should look natural \u2014 robot arms, pan/tilt, door openers.\n\nExample: `arm.ease_to(180, 1s)`" },
    "Servo.ease_to_with": { sig: ".ease_to_with(angle: int, duration: Duration, easing: int) -> void", desc: "Smooth move with a specific easing curve.", detail: "Choose a curve to match the motion feel:\n- `linear` \u2014 constant speed\n- `ease_out` \u2014 fast start, gentle stop\n- `ease_bounce` \u2014 bouncy landing\n- `ease_elastic` \u2014 springy overshoot\n\nExample: `arm.ease_to_with(0, 500ms, ease_bounce)`" },
    "Servo.sweep":        { sig: ".sweep(from: int, to: int, duration: Duration) -> void", desc: "Linear sweep between two angles.", detail: "Moves to `from` first, then sweeps to `to` at constant speed.\nBlocks for the duration.\n\nUse case: Radar scanning, wipers, sensor panning.\n\nExample: `arm.sweep(0, 180, 2s)`" },
    "Servo.sweep_ease":   { sig: ".sweep_ease(from: int, to: int, duration: Duration, easing: int) -> void", desc: "Sweep with an easing curve applied.", detail: "Same as sweep but with shaped motion.\n\nUse case: Smooth camera pan (ease_in_out_sine), dramatic reveal (ease_out_cubic).\n\nExample: `arm.sweep_ease(0, 180, 2s, ease_in_out_sine)`" },
    "Servo.detach":       { sig: ".detach() -> void", desc: "Release the servo \u2014 stops PWM signal.", detail: "The servo goes limp (no holding torque). Reduces power consumption and prevents buzzing.\n\nUse case: Save power when position doesn't need to be held.\n\nExample: `arm.detach()`" },
    "Servo.set_max_angle":{ sig: ".set_max_angle(angle: int) -> void", desc: "Set maximum angle (default 180).", detail: "Use 270 for 270-degree servos like DS3218.\n\nExample: `arm.set_max_angle(270)`" },
    // BME280
    "BME280.temperature": { sig: ".temperature() -> float", desc: "Read temperature in degrees Celsius." },
    "BME280.humidity":    { sig: ".humidity() -> float", desc: "Read relative humidity as percentage." },
    "BME280.pressure":    { sig: ".pressure() -> float", desc: "Read atmospheric pressure in hPa." },
    // AHT20
    "AHT20.temperature":  { sig: ".temperature() -> float", desc: "Read temperature in degrees Celsius." },
    "AHT20.humidity":     { sig: ".humidity() -> float", desc: "Read relative humidity as percentage." },
    // SHT31
    "SHT31.temperature":  { sig: ".temperature() -> float", desc: "High-accuracy temperature in degrees Celsius." },
    "SHT31.humidity":     { sig: ".humidity() -> float", desc: "High-accuracy relative humidity as percentage." },
    // DHT22
    "DHT22.temperature":  { sig: ".temperature() -> float", desc: "Read temperature in degrees Celsius." },
    "DHT22.humidity":     { sig: ".humidity() -> float", desc: "Read relative humidity as percentage." },
    // MPU6050
    "MPU6050.accel_x":    { sig: ".accel_x() -> float", desc: "X-axis acceleration in g (earth gravity units)." },
    "MPU6050.accel_y":    { sig: ".accel_y() -> float", desc: "Y-axis acceleration in g." },
    "MPU6050.accel_z":    { sig: ".accel_z() -> float", desc: "Z-axis acceleration in g (1.0 = stationary upright)." },
    "MPU6050.gyro_x":     { sig: ".gyro_x() -> float", desc: "X-axis rotation rate in degrees per second." },
    "MPU6050.gyro_y":     { sig: ".gyro_y() -> float", desc: "Y-axis rotation rate in degrees per second." },
    "MPU6050.gyro_z":     { sig: ".gyro_z() -> float", desc: "Z-axis rotation rate in degrees per second." },
    "MPU6050.temperature":{ sig: ".temperature() -> float", desc: "IMU die temperature in degrees Celsius." },
    // INA219
    "INA219.voltage":       { sig: ".voltage() -> float", desc: "Bus voltage in volts." },
    "INA219.current":       { sig: ".current() -> float", desc: "Current in amps (0.1 ohm shunt)." },
    "INA219.power":         { sig: ".power() -> float", desc: "Power in watts." },
    "INA219.shunt_voltage": { sig: ".shunt_voltage() -> float", desc: "Shunt voltage drop in volts." },
    // DS3231
    "DS3231.hours":       { sig: ".hours() -> int", desc: "Current hour (0-23)." },
    "DS3231.minutes":     { sig: ".minutes() -> int", desc: "Current minute (0-59)." },
    "DS3231.seconds":     { sig: ".seconds() -> int", desc: "Current second (0-59)." },
    "DS3231.year":        { sig: ".year() -> int", desc: "Current year (2000-2099)." },
    "DS3231.month":       { sig: ".month() -> int", desc: "Current month (1-12)." },
    "DS3231.date":        { sig: ".date() -> int", desc: "Current day of month (1-31)." },
    "DS3231.temperature": { sig: ".temperature() -> float", desc: "RTC die temperature (0.25C resolution)." },
    // BH1750
    "BH1750.lux":         { sig: ".lux() -> float", desc: "Ambient light intensity in lux." },
    // VEML7700
    "VEML7700.lux":       { sig: ".lux() -> float", desc: "High-accuracy ambient light in lux (corrected)." },
    "VEML7700.white":     { sig: ".white() -> float", desc: "White channel light reading." },
    // SSD1306
    "SSD1306.clear":      { sig: ".clear() -> void", desc: "Clear the OLED display buffer." },
    "SSD1306.text":       { sig: ".text(x: int, y: int, text: string) -> void", desc: "Draw text at pixel position." },
    "SSD1306.show":       { sig: ".show() -> void", desc: "Flush the buffer to the display." },
    // BH1750
    "BH1750.lux":         { sig: ".lux() -> float", desc: "Read ambient light level in lux." },
};


export const EASING_DOCS = {
    linear: {
        desc: "Constant speed from start to finish. No acceleration or deceleration.",
        use_case: "Conveyor belts, windshield wipers, radar scanning, linear actuators, or any mechanical motion where constant speed matters. Also good for LED dimming ramps.",
        examples: "`arm.sweep(0, 180, 2s)` \u2014 steady pan across 180\u00B0"
    },
    ease_in: {
        desc: "Starts slow, accelerates toward the end (quadratic curve).",
        use_case: "Objects starting from rest \u2014 a door beginning to swing open, a robotic arm lifting from a dead stop, a camera starting a pan. Feels natural for movements that 'build up' energy.",
        examples: "`arm.ease_to_with(90, 1s, ease_in)` \u2014 gentle start, fast finish"
    },
    ease_out: {
        desc: "Starts fast, decelerates to a gentle stop (quadratic curve).",
        use_case: "The most commonly useful easing. Perfect for: servo arriving at a target position, a gripper closing gently on an object, a pan/tilt camera settling on a point, a needle gauge landing on a value. Prevents mechanical shock on arrival.",
        examples: "`gripper.ease_to_with(45, 500ms, ease_out)` \u2014 close gently"
    },
    ease_in_out: {
        desc: "Slow start AND slow end, fast in the middle (quadratic S-curve).",
        use_case: "The default for `ease_to()`. Best all-around choice for natural-looking movement. Robot arm repositioning, pan/tilt camera tracking, animatronic gestures, automated door openers. Feels human-like.",
        examples: "`arm.ease_to(90, 1s)` \u2014 uses this by default"
    },
    ease_in_cubic: {
        desc: "Very slow start, dramatic acceleration (cubic curve \u2014 sharper than quadratic).",
        use_case: "Heavy machinery starting up \u2014 a crane beginning to rotate, a large servo overcoming inertia. When you want the 'building momentum' feeling to be more dramatic than ease_in.",
        examples: "`crane.ease_to_with(180, 3s, ease_in_cubic)`"
    },
    ease_out_cubic: {
        desc: "Fast start, very gradual stop (cubic curve \u2014 softer landing than quadratic).",
        use_case: "Precision positioning where the last few degrees must be very gentle. Needle instruments, micro-adjustment tools, focus motors, 3D printer bed leveling. Gives extra 'cushion' at the end.",
        examples: "`focus.ease_to_with(42, 200ms, ease_out_cubic)`"
    },
    ease_in_out_cubic: {
        desc: "Pronounced S-curve \u2014 very slow start/end, very fast middle.",
        use_case: "Theatrical or dramatic movements. Animatronic head turns, stage props, robotic dance moves. The exaggerated acceleration/deceleration creates visual impact.",
        examples: "`head.ease_to_with(90, 1s, ease_in_out_cubic)` \u2014 dramatic look"
    },
    ease_in_sine: {
        desc: "Gentle, natural slow start (sine curve \u2014 subtler than quadratic).",
        use_case: "Subtle organic motion. Breathing LED effects, slow sunrise dimmers, plant-watering tilt mechanisms. The gentlest 'ease in' option \u2014 almost imperceptible start.",
        examples: "`tilt.ease_to_with(30, 2s, ease_in_sine)` \u2014 barely noticeable start"
    },
    ease_out_sine: {
        desc: "Gentle, natural deceleration (sine curve \u2014 subtler than quadratic).",
        use_case: "Smooth natural stops. Pendulum-like deceleration, gentle door closing, analog gauge settling. More organic than ease_out \u2014 mimics friction.",
        examples: "`door.ease_to_with(0, 1s, ease_out_sine)` \u2014 soft close"
    },
    ease_in_out_sine: {
        desc: "Smoothest possible S-curve \u2014 like a pendulum's motion.",
        use_case: "The most natural-feeling motion. Perfect for camera gimbals, smooth panning, robotic arms that should move 'elegantly'. Less dramatic than cubic, more natural than quadratic. Best choice when movement should be invisible/seamless.",
        examples: "`gimbal.sweep_ease(0, 180, 3s, ease_in_out_sine)` \u2014 buttery smooth"
    },
    ease_bounce: {
        desc: "The servo bounces at the target like a ball hitting the floor.",
        use_case: "Playful or attention-grabbing movements. Toy robots, interactive displays, vending machine indicators, game props. Also useful for simulating mechanical bounce (spring-loaded mechanisms).",
        examples: "`indicator.ease_to_with(90, 800ms, ease_bounce)` \u2014 bouncy landing"
    },
    ease_back: {
        desc: "Overshoots the target by ~10%, then settles back.",
        use_case: "Snappy, satisfying 'click into place' motion. Toggle switches, latching mechanisms, menu selection feedback, retractable arms. Creates a sense of decisiveness.",
        examples: "`latch.ease_to_with(180, 400ms, ease_back)` \u2014 snap into place"
    },
    ease_elastic: {
        desc: "Spring-like oscillation \u2014 wobbles past the target then settles.",
        use_case: "Springy, whimsical motion. Bobblehead toys, antenna wobble, jelly-like feedback, novelty displays. Most dramatic easing \u2014 use sparingly. Multiple oscillations before settling.",
        examples: "`bobble.ease_to_with(90, 1s, ease_elastic)` \u2014 springy wobble"
    },
};


export const DOT_METHODS = {
    wifi: [
        { label: "connect", detail: "(ssid: string, password: string) -> void", insert: "connect(\"${1:ssid}\", \"${2:password}\")" },
        { label: "disconnect", detail: "() -> void", insert: "disconnect()" },
        { label: "is_connected", detail: "() -> bool", insert: "is_connected()" },
        { label: "get_ip", detail: "() -> string", insert: "get_ip()" },
        { label: "get_rssi", detail: "() -> int (dBm)", insert: "get_rssi()" },
    ],
    mqtt: [
        { label: "connect", detail: "(url: string) -> void", insert: "connect(\"${1:mqtt://host}\")" },
        { label: "disconnect", detail: "() -> void", insert: "disconnect()" },
        { label: "is_connected", detail: "() -> bool", insert: "is_connected()" },
        { label: "send", detail: "(topic: string, data: string) -> void", insert: "send(\"${1:topic}\", \"${2:data}\")" },
        { label: "send_int", detail: "(topic: string, value: int) -> void", insert: "send_int(\"${1:topic}\", ${2:value})" },
        { label: "send_float", detail: "(topic: string, value: float) -> void", insert: "send_float(\"${1:topic}\", ${2:value})" },
        { label: "on_receive", detail: "(topic: string) -> void", insert: "on_receive(\"${1:topic}\")" },
    ],
    http: [
        { label: "get", detail: "(url: string) -> string", insert: "get(\"${1:url}\")" },
        { label: "post", detail: "(url: string, body: string) -> string", insert: "post(\"${1:url}\", \"${2:body}\")" },
    ],
    storage: [
        { label: "save", detail: "(key: string, value) -> void", insert: "save(\"${1:key}\", ${2:value})" },
        { label: "load", detail: "(key: string) -> value", insert: "load(\"${1:key}\")" },
        { label: "push", detail: "(list: string, value: int) -> void", insert: "push(\"${1:list}\", ${2:value})" },
        { label: "drain", detail: "(list: string) -> string", insert: "drain(\"${1:list}\")" },
        { label: "list_count", detail: "(list: string) -> int", insert: "list_count(\"${1:list}\")" },
        { label: "list_clear", detail: "(list: string) -> void", insert: "list_clear(\"${1:list}\")" },
    ],
    system: [
        { label: "restart", detail: "() -> void", insert: "restart()" },
        { label: "free_heap", detail: "() -> int (bytes)", insert: "free_heap()" },
        { label: "uptime", detail: "() -> int (seconds)", insert: "uptime()" },
        { label: "id", detail: "() -> int", insert: "id()" },
    ],
    ota: [
        { label: "enable", detail: "() -> void", insert: "enable()" },
        { label: "check", detail: "() -> void", insert: "check()" },
    ],
};


export const BUILTIN_DOCS = {
    wifi:    { desc: "WiFi networking module", detail: "**Methods:**\n- `connect(ssid, password)` — connect to access point (auto-reconnects)\n- `disconnect()` — disconnect and stop reconnecting\n- `is_connected()` — returns bool\n- `get_ip()` — returns IP address string\n- `get_rssi()` — signal strength in dBm\n\nRequires WiFi-capable chip (ESP32, ESP8266). Forces task to Priority tier." },
    mqtt:    { desc: "MQTT messaging module", detail: "**Methods:**\n- `connect(url)` — connect to broker (`mqtt://host` or `mqtts://host`)\n- `disconnect()`\n- `is_connected()` — returns bool\n- `send(topic, data)` — publish string\n- `send_int(topic, value)` — publish integer\n- `send_float(topic, value)` — publish float\n- `on_receive(topic)` — subscribe to topic\n\nRequires WiFi. Max 16 subscriptions." },
    http:    { desc: "HTTP client module", detail: "**Methods:**\n- `get(url)` — HTTP GET, returns response body\n- `post(url, body)` — HTTP POST, returns response body\n\nRequires WiFi. Forces task to Priority tier." },
    storage: { desc: "Persistent flash storage (NVS)", detail: "**Methods:**\n- `save(key, value)` — save to flash (buffered, flushed every 30s)\n- `load(key)` — load from flash\n- `push(list, value)` — append to named list (store-and-forward)\n- `drain(list)` — read and clear all entries\n- `list_count(list)` — count entries\n- `list_clear(list)` — clear without reading\n\nSurvives reboots and power loss." },
    system:  { desc: "System information and control", detail: "**Methods:**\n- `restart()` — reboot the device\n- `free_heap()` — available RAM in bytes\n- `uptime()` — seconds since boot\n- `id()` — chip/device ID" },
    ota:     { desc: "Over-the-air firmware updates", detail: "**Methods:**\n- `enable()` — start OTA update server" },
    ble:     { desc: "Bluetooth Low Energy", detail: "**Peripheral:**\n- `advertise(name)` — start advertising\n- `expose_int/float/string(name, val)` — expose a value\n- `update_int/float/string(id, val)` — update exposed value\n- `is_connected()` — check if a device is connected\n- `stop()` — stop advertising\n\n**Central (scanning):**\n- `scan(duration)` — scan for nearby devices\n- `scan_name(index)` — get device name\n- `scan_rssi(index)` — get signal strength" },
};

