/**
 * Volt code completions for CodeMirror 6
 * Context-aware autocomplete based on cursor position and language structure
 */

import { autocompletion, completeFromList, snippetCompletion } from "@codemirror/autocomplete";

// ---- Chip names ----
const CHIPS = ["esp32", "esp8266", "rp2040", "stm32f103"];

// ---- Pin modes ----
const PIN_MODES = ["Output", "Input", "Input.PullUp", "Input.PullDown", "Analog", "PWM", "Touch"];

// ---- Pin methods by mode ----
const PIN_METHODS = {
    Output: [
        { label: "on()", type: "method", info: "Set pin HIGH" },
        { label: "off()", type: "method", info: "Set pin LOW" },
        { label: "toggle()", type: "method", info: "Toggle pin state" },
        { label: "write(value)", type: "method", info: "Write 0 or 1" },
    ],
    Input: [
        { label: "read()", type: "method", info: "Read pin state → int (0 or 1)" },
    ],
    Analog: [
        { label: "read()", type: "method", info: "Read analog value → int (0-4095)" },
    ],
    PWM: [
        { label: "set_pwm(duty)", type: "method", info: "Set PWM duty cycle (0-255)" },
    ],
};

// ---- Builtin objects and their methods ----
const BUILTINS = {
    wifi: [
        { label: "connect(ssid, password)", type: "method", info: "Connect to WiFi network" },
        { label: "disconnect()", type: "method", info: "Disconnect from WiFi" },
        { label: "is_connected()", type: "method", info: "Check WiFi connection → bool" },
    ],
    mqtt: [
        { label: "connect(url)", type: "method", info: "Connect to MQTT broker" },
        { label: "send_int(topic, value)", type: "method", info: "Publish integer to topic" },
        { label: "send(topic, payload)", type: "method", info: "Publish string to topic" },
        { label: "is_connected()", type: "method", info: "Check MQTT connection → bool" },
    ],
    http: [
        { label: "get(url)", type: "method", info: "HTTP GET request → string" },
        { label: "post(url, body)", type: "method", info: "HTTP POST request → string" },
    ],
    storage: [
        { label: "save(key, value)", type: "method", info: "Save to persistent storage" },
        { label: "load(key)", type: "method", info: "Load from storage → string" },
        { label: "push(list, value)", type: "method", info: "Push to store-and-forward list" },
        { label: "drain(list)", type: "method", info: "Drain all entries from list → data" },
        { label: "list_count(list)", type: "method", info: "Count entries in list → int" },
        { label: "list_clear(list)", type: "method", info: "Clear a list" },
    ],
    system: [
        { label: "restart()", type: "method", info: "Reboot the device" },
        { label: "free_heap()", type: "method", info: "Free heap memory → int (bytes)" },
        { label: "uptime()", type: "method", info: "Seconds since boot → int" },
    ],
    log: [
        { label: 'log(tag, message)', type: "function", info: "Print log message" },
    ],
};

// ---- Top-level keywords ----
const TOP_LEVEL = [
    snippetCompletion("chip ${1:esp32}\n", { label: "chip", type: "keyword", info: "Declare target chip" }),
    snippetCompletion("hardware {\n    pin ${1:led}: ${2:Output} = ${3:2}\n}\n", { label: "hardware", type: "keyword", info: "Hardware pin declarations" }),
    snippetCompletion("task ${1:name}() {\n    every ${2:500ms} {\n        ${3}\n    }\n}\n", { label: "task", type: "keyword", info: "Background/priority/critical task" }),
    snippetCompletion("func ${1:name}(${2}) -> ${3:int} {\n    ${4}\n}\n", { label: "func", type: "keyword", info: "Function declaration" }),
    snippetCompletion("machine ${1:Name} {\n    initial state ${2:idle} {\n        enter {\n            ${3}\n        }\n        on ${4:event} -> ${5:next}\n    }\n}\n", { label: "machine", type: "keyword", info: "State machine declaration" }),
    snippetCompletion("struct ${1:Name} {\n    ${2:field}: ${3:int}\n}\n", { label: "struct", type: "keyword", info: "Struct type declaration" }),
    snippetCompletion("main {\n    ${1}\n}\n", { label: "main", type: "keyword", info: "Program entry point" }),
    snippetCompletion("var ${1:name}: ${2:int} = ${3:0}\n", { label: "var", type: "keyword", info: "Mutable variable" }),
    snippetCompletion("let ${1:name}: ${2:int} = ${3:0}\n", { label: "let", type: "keyword", info: "Immutable variable" }),
];

// ---- Control flow ----
const CONTROL = [
    snippetCompletion("if ${1:condition} {\n    ${2}\n}\n", { label: "if", type: "keyword" }),
    snippetCompletion("if ${1:condition} {\n    ${2}\n} else {\n    ${3}\n}\n", { label: "if...else", type: "keyword" }),
    snippetCompletion("while ${1:condition} {\n    ${2}\n}\n", { label: "while", type: "keyword" }),
    snippetCompletion("for ${1:i} in ${2:range} {\n    ${3}\n}\n", { label: "for", type: "keyword" }),
    snippetCompletion("every ${1:500ms} {\n    ${2}\n}\n", { label: "every", type: "keyword", info: "Periodic execution block" }),
    snippetCompletion("every ${1:1ms} strict {\n    ${2}\n}\n", { label: "every...strict", type: "keyword", info: "Critical ISR task (hardware timer)" }),
    snippetCompletion("match(${1:expr}) {\n    ${2}\n}\n", { label: "match", type: "keyword" }),
    { label: "return", type: "keyword" },
    { label: "run()", type: "function", info: "Start all tasks" },
    { label: "sleep()", type: "function", info: "Delay execution" },
];

// ---- State machine keywords ----
const STATE_KW = [
    snippetCompletion("initial state ${1:name} {\n    enter {\n        ${2}\n    }\n    on ${3:event} -> ${4:target}\n}\n", { label: "initial state", type: "keyword" }),
    snippetCompletion("state ${1:name} {\n    enter {\n        ${2}\n    }\n    on ${3:event} -> ${4:target}\n}\n", { label: "state", type: "keyword" }),
    snippetCompletion("enter {\n    ${1}\n}\n", { label: "enter", type: "keyword", info: "Code to run when entering state" }),
    snippetCompletion("exit {\n    ${1}\n}\n", { label: "exit", type: "keyword", info: "Code to run when leaving state" }),
    snippetCompletion("on ${1:event} -> ${2:target}\n", { label: "on...->", type: "keyword", info: "Event transition" }),
    snippetCompletion("after ${1:5seconds} -> ${2:target}\n", { label: "after...->", type: "keyword", info: "Timed transition" }),
];

// ---- Types ----
const TYPES = [
    { label: "int", type: "type" },
    { label: "float", type: "type" },
    { label: "bool", type: "type" },
    { label: "string", type: "type" },
    { label: "void", type: "type" },
];

// ---- Duration suggestions ----
const DURATIONS = [
    { label: "1ms", type: "constant", info: "1 millisecond" },
    { label: "10ms", type: "constant", info: "10 milliseconds" },
    { label: "50ms", type: "constant", info: "50 milliseconds" },
    { label: "100ms", type: "constant", info: "100 milliseconds" },
    { label: "250ms", type: "constant", info: "250 milliseconds" },
    { label: "500ms", type: "constant", info: "500 milliseconds" },
    { label: "1seconds", type: "constant", info: "1 second" },
    { label: "2seconds", type: "constant", info: "2 seconds" },
    { label: "5seconds", type: "constant", info: "5 seconds" },
    { label: "10seconds", type: "constant", info: "10 seconds" },
    { label: "30seconds", type: "constant", info: "30 seconds" },
    { label: "60seconds", type: "constant", info: "60 seconds" },
];

// ---- Context-aware completion function ----
function voltCompletions(context) {
    // Get text before cursor
    const line = context.state.doc.lineAt(context.pos);
    const textBefore = line.text.slice(0, context.pos - line.from);

    // After "chip " → suggest chip names
    if (/chip\s+$/.test(textBefore)) {
        return {
            from: context.pos,
            options: CHIPS.map(c => ({ label: c, type: "constant" })),
        };
    }

    // After "pin name: " → suggest pin modes
    if (/pin\s+\w+:\s*$/.test(textBefore)) {
        return {
            from: context.pos,
            options: PIN_MODES.map(m => ({ label: m, type: "type" })),
        };
    }

    // After "every " → suggest durations
    if (/every\s+$/.test(textBefore)) {
        return { from: context.pos, options: DURATIONS };
    }

    // After "-> " inside machine → could suggest state names (would need AST)
    // For now, skip

    // After "object." → suggest methods
    const dotMatch = textBefore.match(/(\w+)\.\s*$/);
    if (dotMatch) {
        const obj = dotMatch[1];
        if (BUILTINS[obj]) {
            return {
                from: context.pos,
                options: BUILTINS[obj],
            };
        }
        // Could be a pin variable — would need to track declarations
        // For now, suggest all pin methods
        const allPinMethods = Object.values(PIN_METHODS).flat();
        return {
            from: context.pos,
            options: allPinMethods,
        };
    }

    // After ": " in variable declaration → suggest types
    if (/(?:let|var)\s+\w+:\s*$/.test(textBefore)) {
        return { from: context.pos, options: TYPES };
    }

    // Inside machine block → suggest state machine keywords
    // Rough heuristic: check if we're inside a machine { }
    const fullText = context.state.doc.toString();
    const beforeCursor = fullText.slice(0, context.pos);
    const machineDepth = (beforeCursor.match(/machine\s+\w+\s*\{/g) || []).length;
    const closingBraces = (beforeCursor.match(/\}/g) || []).length;
    if (machineDepth > 0) {
        // Could be inside a machine
        const word = context.matchBefore(/\w*/);
        if (word && word.from < word.to) {
            return {
                from: word.from,
                options: [...STATE_KW, ...CONTROL],
                validFor: /^\w*$/,
            };
        }
    }

    // Default: suggest top-level keywords + control flow + builtins
    const word = context.matchBefore(/\w+/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    const allOptions = [
        ...TOP_LEVEL,
        ...CONTROL,
        ...TYPES,
        { label: "wifi", type: "variable", info: "WiFi module" },
        { label: "mqtt", type: "variable", info: "MQTT module" },
        { label: "http", type: "variable", info: "HTTP module" },
        { label: "storage", type: "variable", info: "Persistent storage module" },
        { label: "system", type: "variable", info: "System functions" },
        { label: "true", type: "constant" },
        { label: "false", type: "constant" },
    ];

    return {
        from: word.from,
        options: allOptions,
        validFor: /^\w*$/,
    };
}

// ---- Hover tooltips ----
const HOVER_DOCS = {
    chip: "Declare the target microcontroller.\nSupported: esp32, esp8266, rp2040, stm32f103",
    hardware: "Define pin assignments and hardware peripherals.\nPins are validated against the chip's datasheet at compile time.",
    task: "Declare a concurrent task.\nAuto-classified: background (protothread, 12 bytes), priority (FreeRTOS, 4KB), or critical (hardware timer ISR).",
    func: "Declare a function. Functions can return values and take parameters.",
    machine: "Declare a state machine with compile-time verification.\nThe compiler checks: reachability, dead states, deterministic transitions.",
    struct: "Declare a custom data type with named fields.",
    main: "Program entry point. WiFi/MQTT connections and run() go here.",
    every: "Execute a block periodically. Duration: 100ms, 500ms, 1seconds, etc.",
    strict: "Mark a task as critical — runs as hardware timer ISR.\nCannot call WiFi, MQTT, log, or any blocking function.",
    state: "Declare a state in a state machine. Has enter/exit actions and transitions.",
    initial: "Mark a state as the starting state of the machine.",
    enter: "Code executed when entering a state.",
    exit: "Code executed when leaving a state.",
    var: "Declare a mutable variable. Can be reassigned.",
    let: "Declare an immutable variable. Cannot be reassigned after initialization.",
    Output: "Pin mode: digital output. Methods: on(), off(), toggle(), write()",
    Input: "Pin mode: digital input. Methods: read() → 0 or 1",
    Analog: "Pin mode: analog input (ADC). Methods: read() → 0-4095",
    PWM: "Pin mode: pulse-width modulation. Methods: set_pwm(0-255)",
    Touch: "Pin mode: capacitive touch sensor. ESP32 only.",
    wifi: "WiFi module.\nMethods: connect(ssid, pass), disconnect(), is_connected()",
    mqtt: "MQTT module.\nMethods: connect(url), send_int(topic, value), is_connected()",
    storage: "Persistent storage (survives reboots).\nMethods: save(), load(), push(), drain()",
    system: "System functions.\nMethods: restart(), free_heap(), uptime()",
    run: "Start all declared tasks. Called in main block.",
    log: "Print a log message to serial output.\nUsage: log(tag, message)",
};

export { voltCompletions, HOVER_DOCS };
export const voltAutocompletion = autocompletion({
    override: [voltCompletions],
    activateOnTyping: true,
    maxRenderedOptions: 12,
});
