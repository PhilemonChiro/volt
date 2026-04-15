/**
 * Volt IDE — Main Application
 * Uses window.monaco (loaded via AMD) and window.__TAURI__ (global Tauri API)
 *
 * CONTENTS:
 *   [L011]  Tauri helpers
 *   [L031]  Volt language definition (Monarch tokenizer + theme)
 *   [L216]  Autocomplete provider (snippets, dot-completion, types, durations)
 *   [L596]  Editor creation (lazy, with cursor tracking + diagnostics)
 *   [L618]  Welcome / Editor toggle
 *   [L638]  Serial Monitor (ESP-IDF log stripping, timestamps)
 *   [L691]  Output panel (structured messages, build progress bar)
 *   [L777]  Project state + Run/Monitor/Check/Format/Save buttons
 *   [L914]  Document formatting provider
 *   [L977]  Hover documentation (keywords, types, builtins, chips, pins, methods)
 *   [L1186] Hover provider (Monaco registration)
 *   [L1352] Signature help provider
 *   [L1392] Go-to-definition, Find references, Rename, Document outline
 *   [L1498] Real-time diagnostics (800ms debounce)
 *   [L1572] Tauri event listeners (serial, build progress)
 *   [L1618] Project picker + New project + Load project
 *   [L1720] Window controls + drag
 *   [L1760] Device detection + dropdown
 *   [L1860] Panel tabs + keyboard shortcuts
 *   [L1945] Welcome buttons + recent projects + Init
 */
(function () {
    "use strict";

    var monaco = window.monaco;
    var __TAURI__ = window.__TAURI_INTERNALS__;

    // --- Tauri helpers (safe when not in Tauri) ---
    function invoke(cmd, args) {
        if (__TAURI__) return __TAURI__.invoke(cmd, args);
        return Promise.reject("Not in Tauri");
    }

    function tauriListen(event, handler) {
        if (window.__TAURI__ && window.__TAURI__.event) {
            return window.__TAURI__.event.listen(event, handler);
        }
        return Promise.resolve(function () {});
    }

    function getTauriWindow() {
        if (window.__TAURI__ && window.__TAURI__.window) {
            return window.__TAURI__.window.getCurrentWindow();
        }
        return null;
    }

    // ----------------------------------------------------------------
    // ASTStore — single source of truth for all panels
    // Compiles on keystroke, notifies subscribers with AST + C + errors
    // ----------------------------------------------------------------
    var ASTStore = {
        _ast: null,     // { pins, tasks, machines, channels, enums, chip }
        _cCode: "",
        _errors: [],
        _listeners: [],
        _compileTimer: null,

        compile: function(source, filename) {
            var self = this;
            return invoke("compile_full", { source: source }).then(function(result) {
                self._ast = {
                    pins: result.pins || [],
                    tasks: result.tasks || [],
                    machines: result.machines || [],
                    channels: result.channels || [],
                    enums: result.enums || [],
                    chip: result.chip || "esp32",
                };
                self._cCode = result.c_code || "";
                self._errors = result.diagnostics || [];
                self._listeners.forEach(function(fn) { fn(self._ast, self._cCode, self._errors); });
            }).catch(function() {});
        },

        scheduleCompile: function(source) {
            var self = this;
            clearTimeout(self._compileTimer);
            self._compileTimer = setTimeout(function() {
                self.compile(source, "main.volt");
            }, 300); // 300ms debounce
        },

        subscribe: function(callback) {
            this._listeners.push(callback);
            // Return unsubscribe function
            var listeners = this._listeners;
            return function() {
                var idx = listeners.indexOf(callback);
                if (idx >= 0) listeners.splice(idx, 1);
            };
        },

        getAST: function() { return this._ast; },
        getCCode: function() { return this._cCode; },
        getErrors: function() { return this._errors; },
    };

    // ----------------------------------------------------------------
    // Volt language definition (Monarch tokenizer)
    // ----------------------------------------------------------------
    monaco.languages.register({ id: "volt" });

    monaco.languages.setLanguageConfiguration("volt", {
        wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
        comments: { lineComment: "//" },
        brackets: [["{", "}"], ["(", ")"], ["[", "]"]],
        autoClosingPairs: [
            { open: "{", close: "}" },
            { open: "(", close: ")" },
            { open: "[", close: "]" },
            { open: "\"", close: "\"", notIn: ["string"] },
        ],
        surroundingPairs: [
            { open: "{", close: "}" },
            { open: "(", close: ")" },
            { open: "[", close: "]" },
            { open: "\"", close: "\"" },
        ],
        indentationRules: {
            increaseIndentPattern: /.*\{\s*$/,
            decreaseIndentPattern: /^\s*\}/,
        },
    });

    monaco.languages.setMonarchTokensProvider("volt", {
        decl_keywords: ["chip", "func", "task", "machine", "struct", "setup", "loop", "hardware", "power", "pin", "device", "include", "channel", "shared"],
        control_keywords: ["if", "else", "while", "for", "in", "return", "match", "on", "every", "timeout", "break", "continue"],
        var_keywords: ["let", "var", "storage"],
        modifiers: ["strict", "initial", "debounce", "throttle"],
        lifecycle: ["enter", "exit", "after"],
        pin_modes: ["Output", "Input", "PullUpInput", "PullDownInput", "Analog", "PWM", "Servo", "DAC", "Touch"],
        primitives: ["int", "float", "bool", "string", "void", "Duration", "u8", "u16", "u32", "i8", "i16"],
        builtins: ["wifi", "mqtt", "http", "system", "ota", "ble", "storage"],
        builtin_fns: ["log", "sleep", "deep_sleep", "light_sleep", "float", "int"],
        constants: ["true", "false", "HIGH", "LOW", "ON", "OFF",
            "linear", "ease_in", "ease_out", "ease_in_out",
            "ease_in_cubic", "ease_out_cubic", "ease_in_out_cubic",
            "ease_in_sine", "ease_out_sine", "ease_in_out_sine",
            "ease_bounce", "ease_back", "ease_elastic"],
        chips: ["esp32", "esp8266", "rp2040", "stm32f103"],
        operators: ["==", "!=", "<=", ">=", "<", ">", "&&", "||", "!", "=", "+", "-", "*", "/", "%", "->", ".."],
        symbols: /[=><!~?:&|+\-*\/\^%.]+/,

        tokenizer: {
            root: [
                // Comments
                [/\/\/.*$/, "comment"],
                [/\/\*/, "comment", "@blockComment"],

                // Strings with interpolation
                [/"/, "string", "@string"],

                // Duration literals (before numbers)
                [/\b[0-9]+(us|ms|seconds|second|minutes|minute|hours|hour)\b/, "number.duration"],

                // Hex numbers
                [/\b0x[0-9a-fA-F]+\b/, "number.hex"],

                // Float numbers
                [/\b[0-9]+\.[0-9]+\b/, "number.float"],

                // Integer numbers
                [/\b[0-9]+\b/, "number"],

                // Raw block
                [/\b(raw)\b/, "keyword.other"],

                // State keyword + name
                [/\b(state)\s+([a-zA-Z_]\w*)/, ["keyword.declaration", "tag.state"]],

                // Identifiers
                [/[a-zA-Z_]\w*/, {
                    cases: {
                        "@decl_keywords": "keyword.declaration",
                        "@control_keywords": "keyword.control",
                        "@var_keywords": "keyword.var",
                        "@modifiers": "keyword.modifier",
                        "@lifecycle": "keyword.lifecycle",
                        "@pin_modes": "type.pin",
                        "@primitives": "type.primitive",
                        "@builtins": "type.builtin",
                        "@builtin_fns": "function.builtin",
                        "@constants": "constant",
                        "@chips": "constant.chip",
                        "@default": "identifier"
                    }
                }],

                // Operators
                [/@symbols/, {
                    cases: {
                        "@operators": "operator",
                        "@default": ""
                    }
                }],

                // Brackets
                [/[{}()\[\]]/, "delimiter.bracket"],

                // Whitespace
                [/[ \t\r\n]+/, "white"],
            ],

            blockComment: [
                [/\*\//, "comment", "@pop"],
                [/./, "comment"]
            ],

            string: [
                [/\\./, "string.escape"],
                [/\{/, "delimiter.interpolation", "@interpolation"],
                [/[^\\"{]+/, "string"],
                [/"/, "string", "@pop"]
            ],

            interpolation: [
                [/\}/, "delimiter.interpolation", "@pop"],
                { include: "root" }
            ]
        }
    });

    // ----------------------------------------------------------------
    // Volt theme — colors matching VS Code Dark+ for Volt scopes
    // ----------------------------------------------------------------
    monaco.editor.defineTheme("volt-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [
            // Keywords — purple (C586C0) like VS Code Dark+
            { token: "keyword.declaration",   foreground: "C586C0", fontStyle: "bold" },
            { token: "keyword.control",       foreground: "C586C0" },
            { token: "keyword.var",           foreground: "569CD6" },
            { token: "keyword.modifier",      foreground: "D16969" },
            { token: "keyword.lifecycle",     foreground: "C586C0" },
            { token: "keyword.other",         foreground: "808080" },

            // Types — teal/green
            { token: "type.pin",              foreground: "4EC9B0" },
            { token: "type.primitive",        foreground: "4EC9B0" },
            { token: "type.builtin",          foreground: "4EC9B0" },

            // Functions — light yellow
            { token: "function.builtin",      foreground: "DCDCAA" },

            // Constants
            { token: "constant",              foreground: "569CD6" },
            { token: "constant.chip",         foreground: "CE9178", fontStyle: "bold" },

            // State machine
            { token: "tag.state",             foreground: "D7BA7D" },

            // Strings
            { token: "string",                foreground: "CE9178" },
            { token: "string.escape",         foreground: "D7BA7D" },
            { token: "delimiter.interpolation", foreground: "569CD6" },

            // Numbers
            { token: "number",                foreground: "B5CEA8" },
            { token: "number.duration",       foreground: "B5CEA8", fontStyle: "bold" },
            { token: "number.hex",            foreground: "B5CEA8" },
            { token: "number.float",          foreground: "B5CEA8" },

            // Comments
            { token: "comment",               foreground: "6A9955", fontStyle: "italic" },

            // Operators
            { token: "operator",              foreground: "D4D4D4" },

            // Identifiers
            { token: "identifier",            foreground: "9CDCFE" },
        ],
        colors: {
            "editor.background":                "#0f1114",
            "editor.foreground":                "#D4D4D4",
            "editorCursor.foreground":          "#2B7CB3",
            "editor.lineHighlightBackground":   "#151820",
            "editor.selectionBackground":       "#2B7CB333",
            "editorLineNumber.foreground":      "#3E4452",
            "editorLineNumber.activeForeground":"#8090A0",
            "editorGutter.background":          "#0f1114",
            "editorWidget.background":          "#1a1d24",
            "editorWidget.border":              "#2a2d35",
            "input.background":                 "#1a1d24",
            "dropdown.background":              "#1a1d24",
            "list.activeSelectionBackground":   "#2B7CB333",
            "list.hoverBackground":             "#1f2230",
            "scrollbarSlider.background":       "#2a2d3566",
            "scrollbarSlider.hoverBackground":  "#3a3d4566",
        }
    });

    // ----------------------------------------------------------------
    // Autocomplete provider
    // ----------------------------------------------------------------
    var Kind = monaco.languages.CompletionItemKind;
    var Insert = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

    // -- Snippet templates for top-level declarations --
    var SNIPPETS = [
        { label: "chip", detail: "Declare target chip", insert: "chip ${1|esp32,esp8266,rp2040,stm32f103|}", kind: Kind.Keyword },
        { label: "hardware", detail: "Hardware pin block", insert: "hardware {\n\tpin ${1:name}: ${2|Output,Input,PullUpInput,PullDownInput,Analog,PWM,Servo,DAC,Touch|} = ${3:pin_number}\n}", kind: Kind.Keyword },
        { label: "setup", detail: "Runs once at boot", insert: "setup {\n\t$0\n}", kind: Kind.Keyword },
        { label: "loop", detail: "Super-loop, runs forever", insert: "loop {\n\t$0\n}", kind: Kind.Keyword },
        { label: "include", detail: "Include another .volt file", insert: "include \"${0:file.volt}\"", kind: Kind.Keyword },
        { label: "func", detail: "Function definition", insert: "func ${1:name}(${2:params}) -> ${3:void} {\n\t$0\n}", kind: Kind.Function },
        { label: "task", detail: "Concurrent task (auto-starts)", insert: "task ${1:name} {\n\t$0\n}", kind: Kind.Function },
        { label: "machine", detail: "State machine", insert: "machine ${1:Name} {\n\tinitial state ${2:idle} {\n\t\tenter {\n\t\t\t$0\n\t\t}\n\t}\n}", kind: Kind.Keyword },
        { label: "struct", detail: "Custom data type", insert: "struct ${1:Name} {\n\t${2:field}: ${3:int}\n}", kind: Kind.Keyword },
        { label: "storage", detail: "Persistent variable", insert: "storage ${1:name}: ${2|int,float,bool,string|} = ${3:0}", kind: Kind.Keyword },
        { label: "raw", detail: "Inline C code block", insert: "raw {\n\t\"${0}\"\n}", kind: Kind.Keyword },

        // Control flow
        { label: "if", detail: "Conditional branch", insert: "if ${1:condition} {\n\t$0\n}", kind: Kind.Keyword },
        { label: "if else", detail: "If-else branch", insert: "if ${1:condition} {\n\t$2\n} else {\n\t$0\n}", kind: Kind.Keyword },
        { label: "while", detail: "While loop", insert: "while ${1:condition} {\n\t$0\n}", kind: Kind.Keyword },
        { label: "for", detail: "Range loop", insert: "for ${1:i} in ${2:0}..${3:10} {\n\t$0\n}", kind: Kind.Keyword },
        { label: "match", detail: "Pattern match", insert: "match(${1:expr}) {\n\t${2:value} -> {\n\t\t$0\n\t}\n}", kind: Kind.Keyword },
        { label: "every", detail: "Periodic block", insert: "every ${1|100ms,250ms,500ms,1s,5s,10s|} {\n\t$0\n}", kind: Kind.Keyword },
        { label: "every strict", detail: "Critical ISR periodic", insert: "every ${1|100us,500us,1ms,5ms,10ms|} strict {\n\t$0\n}", kind: Kind.Keyword },
        { label: "on", detail: "Event handler", insert: "on ${1:event} {\n\t$0\n}", kind: Kind.Keyword },
        { label: "on debounce", detail: "Debounced event handler", insert: "on ${1:event} debounce ${2:50ms} {\n\t$0\n}", kind: Kind.Keyword },
        { label: "timeout", detail: "Timeout block", insert: "timeout ${1:5s} {\n\t$2\n} else {\n\t$0\n}", kind: Kind.Keyword },

        // Variables
        { label: "let", detail: "Immutable variable", insert: "let ${1:name} = ${0}", kind: Kind.Variable },
        { label: "var", detail: "Mutable variable", insert: "var ${1:name}: ${2|int,float,bool,string|} = ${0}", kind: Kind.Variable },

        // State machine internals
        { label: "initial state", detail: "Starting state", insert: "initial state ${1:idle} {\n\tenter {\n\t\t$0\n\t}\n}", kind: Kind.Keyword },
        { label: "state", detail: "State declaration", insert: "state ${1:name} {\n\tenter {\n\t\t$0\n\t}\n}", kind: Kind.Keyword },
        { label: "enter", detail: "State enter action", insert: "enter {\n\t$0\n}", kind: Kind.Keyword },
        { label: "exit", detail: "State exit action", insert: "exit {\n\t$0\n}", kind: Kind.Keyword },
        { label: "after", detail: "Timed transition", insert: "after ${1:5s} -> ${0:target}", kind: Kind.Keyword },
        { label: "on ->", detail: "Event transition", insert: "on ${1:event} -> ${0:target}", kind: Kind.Keyword },
        { label: "on [] ->", detail: "Guarded transition", insert: "on ${1:event} [${2:guard}] -> ${0:target}", kind: Kind.Keyword },

        // Hardware
        { label: "pin Output", detail: "Digital output pin", insert: "pin ${1:led}: Output = ${0:2}", kind: Kind.Property },
        { label: "pin Input", detail: "Digital input pin", insert: "pin ${1:btn}: Input = ${0:0}", kind: Kind.Property },
        { label: "pin PullUpInput", detail: "Input with pull-up", insert: "pin ${1:btn}: PullUpInput = ${0:0}", kind: Kind.Property },
        { label: "pin Analog", detail: "Analog input (ADC)", insert: "pin ${1:sensor}: Analog = ${0:34}", kind: Kind.Property },
        { label: "pin PWM", detail: "PWM output", insert: "pin ${1:motor}: PWM = ${0:25}", kind: Kind.Property },
        { label: "pin Servo", detail: "Servo motor (0-180\u00B0)", insert: "pin ${1:arm}: Servo = ${0:13}", kind: Kind.Property },
        { label: "pin DAC", detail: "Analog output (ESP32: GPIO 25/26)", insert: "pin ${1:dac}: DAC = ${0:25}", kind: Kind.Property },
        { label: "pin Touch", detail: "Capacitive touch (ESP32 only)", insert: "pin ${1:pad}: Touch = ${0:4}", kind: Kind.Property },
        { label: "bus I2C", detail: "I2C bus declaration", insert: "bus ${1:sensors}: I2C(sda: ${2:21}, scl: ${3:22})", kind: Kind.Property },
        { label: "device BME280", detail: "Temp/humidity/pressure", insert: "device ${1:bme}: BME280 on ${2:sensors} at ${0:0x76}", kind: Kind.Property },
        { label: "device AHT20", detail: "Temp/humidity", insert: "device ${1:aht}: AHT20 on ${2:sensors} at ${0:0x38}", kind: Kind.Property },
        { label: "device SHT31", detail: "Precision temp/humidity", insert: "device ${1:sht}: SHT31 on ${2:sensors} at ${0:0x44}", kind: Kind.Property },
        { label: "device MPU6050", detail: "6-axis IMU (accel+gyro)", insert: "device ${1:imu}: MPU6050 on ${2:sensors} at ${0:0x68}", kind: Kind.Property },
        { label: "device INA219", detail: "Voltage/current/power monitor", insert: "device ${1:pwr}: INA219 on ${2:sensors} at ${0:0x40}", kind: Kind.Property },
        { label: "device DS3231", detail: "Real-time clock", insert: "device ${1:rtc}: DS3231 on ${2:sensors} at ${0:0x68}", kind: Kind.Property },
        { label: "device BH1750", detail: "Light sensor", insert: "device ${1:light}: BH1750 on ${2:sensors} at ${0:0x23}", kind: Kind.Property },
        { label: "device VEML7700", detail: "Precision light sensor", insert: "device ${1:als}: VEML7700 on ${2:sensors} at ${0:0x10}", kind: Kind.Property },
        { label: "device SSD1306", detail: "OLED display 128x64", insert: "device ${1:oled}: SSD1306 on ${2:sensors} at ${0:0x3C}", kind: Kind.Property },
        { label: "channel", detail: "Inter-task data channel", insert: "channel ${1:data}: ${2:int}[${0:8}]", kind: Kind.Property },

        // Builtin function calls
        { label: "log", detail: "Print log message", insert: "log(\"${1:tag}\", \"${0:message}\")", kind: Kind.Function },
        { label: "sleep", detail: "Suspend task for duration", insert: "sleep(${0:500ms})", kind: Kind.Function },
        { label: "deep_sleep", detail: "Deep sleep (timer wake)", insert: "deep_sleep(${0:60s})", kind: Kind.Function },
        { label: "light_sleep", detail: "Light sleep (fast wake)", insert: "light_sleep(${0:10s})", kind: Kind.Function },
    ];

    // -- Methods on builtin objects (triggered after dot) --
    var DOT_METHODS = {
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

    // -- Methods on pin modes (resolved from document context) --
    var PIN_METHODS = {
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

    // -- Methods on device types --
    var SENSOR_METHODS = {
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

    // -- Types for type annotations --
    var TYPES = [
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

    // -- Chip names (after "chip ") --
    var CHIPS = [
        { label: "esp32", detail: "ESP32 WROOM-32 — dual-core, WiFi+BT, 520KB" },
        { label: "esp8266", detail: "ESP8266 — single-core, WiFi, 80KB" },
        { label: "rp2040", detail: "RP2040 Pico — dual-core ARM, 264KB, no WiFi" },
        { label: "stm32f103", detail: "STM32 Blue Pill — Cortex-M3, 20KB" },
    ];

    // -- Duration presets --
    var DURATIONS = [
        "100us", "500us", "1ms", "5ms", "10ms", "50ms", "100ms", "250ms",
        "500ms", "1s", "2s", "5s", "10s", "30s",
        "1min", "5min", "10min", "1hr"
    ];

    // -- Constants --
    var CONSTANTS = [
        { label: "true", detail: "Boolean true", kind: Kind.Constant },
        { label: "false", detail: "Boolean false", kind: Kind.Constant },
        { label: "HIGH", detail: "Pin level 1", kind: Kind.Constant },
        { label: "LOW", detail: "Pin level 0", kind: Kind.Constant },
        { label: "ON", detail: "Pin level 1", kind: Kind.Constant },
        { label: "OFF", detail: "Pin level 0", kind: Kind.Constant },
        // Servo easing curves — use case hints in detail
        { label: "linear", detail: "Constant speed \u2014 conveyors, wipers, scanning", kind: Kind.Constant },
        { label: "ease_in", detail: "Slow start, fast end \u2014 lifting from rest", kind: Kind.Constant },
        { label: "ease_out", detail: "Fast start, gentle stop \u2014 grippers, gauges", kind: Kind.Constant },
        { label: "ease_in_out", detail: "Smooth start + stop \u2014 default, most natural", kind: Kind.Constant },
        { label: "ease_in_cubic", detail: "Very slow start \u2014 heavy machinery, cranes", kind: Kind.Constant },
        { label: "ease_out_cubic", detail: "Extra gentle stop \u2014 precision positioning", kind: Kind.Constant },
        { label: "ease_in_out_cubic", detail: "Dramatic S-curve \u2014 animatronics, stage props", kind: Kind.Constant },
        { label: "ease_in_sine", detail: "Subtlest slow start \u2014 organic, breathing", kind: Kind.Constant },
        { label: "ease_out_sine", detail: "Natural deceleration \u2014 doors, pendulums", kind: Kind.Constant },
        { label: "ease_in_out_sine", detail: "Smoothest motion \u2014 gimbals, cameras", kind: Kind.Constant },
        { label: "ease_bounce", detail: "Bouncy landing \u2014 toys, indicators, playful", kind: Kind.Constant },
        { label: "ease_back", detail: "Overshoots then settles \u2014 latches, switches", kind: Kind.Constant },
        { label: "ease_elastic", detail: "Springy wobble \u2014 bobbleheads, novelty", kind: Kind.Constant },
    ];

    // Scan document for pin and sensor declarations to resolve dot-completions
    function scanDeclarations(model) {
        var pins = {};    // name -> mode
        var sensors = {}; // name -> type
        var lines = model.getLineCount();
        for (var i = 1; i <= lines; i++) {
            var line = model.getLineContent(i);
            var pm = line.match(/\bpin\s+(\w+)\s*:\s*(Output|PullUpInput|PullDownInput|Input|Analog|PWM|Servo|DAC|Touch)/);
            if (pm) pins[pm[1]] = pm[2];
            var sm = line.match(/\bdevice\s+(\w+)\s*:\s*(BME280|AHT20|SHT31|DHT22|MPU6050|INA219|DS3231|BH1750|VEML7700|SSD1306)/);
            if (sm) sensors[sm[1]] = sm[2];
        }
        return { pins: pins, sensors: sensors };
    }

    monaco.languages.registerCompletionItemProvider("volt", {
        triggerCharacters: [".", " ", ":"],
        provideCompletionItems: function (model, position) {
            var line = model.getLineContent(position.lineNumber);
            var textBefore = line.substring(0, position.column - 1);
            var word = model.getWordUntilPosition(position);
            var range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };

            var suggestions = [];

            // --- Dot completions: object.method ---
            var dotMatch = textBefore.match(/\b(\w+)\.\s*$/);
            if (dotMatch) {
                var obj = dotMatch[1];
                var methods = null;

                // Check builtins first
                if (DOT_METHODS[obj]) {
                    methods = DOT_METHODS[obj];
                } else {
                    // Check document pins and sensors
                    var decls = scanDeclarations(model);
                    if (decls.pins[obj]) {
                        methods = PIN_METHODS[decls.pins[obj]] || [];
                    } else if (decls.sensors[obj]) {
                        methods = SENSOR_METHODS[decls.sensors[obj]] || [];
                    }
                }

                if (methods) {
                    methods.forEach(function (m) {
                        suggestions.push({
                            label: m.label,
                            kind: Kind.Method,
                            detail: m.detail,
                            insertText: m.insert,
                            insertTextRules: Insert,
                            range: range,
                        });
                    });
                    return { suggestions: suggestions };
                }
            }

            // --- After "chip " — suggest chip names ---
            if (/\bchip\s+$/.test(textBefore)) {
                CHIPS.forEach(function (c) {
                    suggestions.push({
                        label: c.label,
                        kind: Kind.EnumMember,
                        detail: c.detail,
                        insertText: c.label,
                        range: range,
                    });
                });
                return { suggestions: suggestions };
            }

            // --- After colon — suggest types ---
            if (/:\s*$/.test(textBefore)) {
                TYPES.forEach(function (t) {
                    suggestions.push({
                        label: t.label,
                        kind: Kind.TypeParameter,
                        detail: t.detail,
                        insertText: t.label,
                        range: range,
                    });
                });
                return { suggestions: suggestions };
            }

            // --- After number — suggest duration units ---
            if (/\b\d+$/.test(textBefore)) {
                DURATIONS.forEach(function (d) {
                    var unit = d.replace(/^\d+/, "");
                    suggestions.push({
                        label: d,
                        kind: Kind.Unit,
                        detail: "Duration",
                        insertText: unit,
                        range: range,
                    });
                });
                return { suggestions: suggestions };
            }

            // --- General completions: snippets + constants + document symbols ---
            SNIPPETS.forEach(function (s) {
                suggestions.push({
                    label: s.label,
                    kind: s.kind,
                    detail: s.detail,
                    insertText: s.insert,
                    insertTextRules: Insert,
                    range: range,
                });
            });

            CONSTANTS.forEach(function (c) {
                suggestions.push({
                    label: c.label,
                    kind: c.kind,
                    detail: c.detail,
                    insertText: c.label,
                    range: range,
                });
            });

            // Add declared pin/sensor names as variables
            var decls = scanDeclarations(model);
            Object.keys(decls.pins).forEach(function (name) {
                suggestions.push({
                    label: name,
                    kind: Kind.Variable,
                    detail: "Pin: " + decls.pins[name],
                    insertText: name,
                    range: range,
                });
            });
            Object.keys(decls.sensors).forEach(function (name) {
                suggestions.push({
                    label: name,
                    kind: Kind.Variable,
                    detail: "Device: " + decls.sensors[name],
                    insertText: name,
                    range: range,
                });
            });

            // Add builtin objects
            ["wifi", "mqtt", "http", "storage", "system", "ota"].forEach(function (b) {
                suggestions.push({
                    label: b,
                    kind: Kind.Module,
                    detail: "Builtin: " + b,
                    insertText: b,
                    range: range,
                });
            });

            return { suggestions: suggestions };
        }
    });

    var editor = null;
    var editorContainer = document.getElementById("editorContainer");

    function ensureEditor() {
        if (editor) return;
        editor = monaco.editor.create(editorContainer, {
            value: "",
            language: "volt",
            theme: "volt-dark",
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
            fontSize: 14,
            lineHeight: 24,
            automaticLayout: true,
            minimap: { enabled: false },
            padding: { top: 8 },
            scrollBeyondLastLine: false,
            renderLineHighlight: "all",
            cursorBlinking: "smooth",
            smoothScrolling: true,
        });
        editor.onDidChangeCursorPosition(function (e) {
            document.getElementById("statusLine").textContent =
                "Ln " + e.position.lineNumber + ", Col " + e.position.column;
        });

        // Real-time diagnostics as you type (800ms debounce)
        editor.onDidChangeModelContent(function () {
            scheduleDiagnostics();
            checkUnsaved();
        });
    }

    // ----------------------------------------------------------------
    // Welcome / Editor toggle
    // ----------------------------------------------------------------
    function showWelcome() {
        document.getElementById("welcomeScreen").style.display = "flex";
        editorContainer.style.display = "none";
    }

    function showEditor() {
        document.getElementById("welcomeScreen").style.display = "none";
        editorContainer.style.display = "block";
        ensureEditor();
        setTimeout(function () {
            if (editor) { editor.layout(); editor.focus(); }
        }, 50);
    }

    // ----------------------------------------------------------------
    // Monitor output
    // ----------------------------------------------------------------
    // ----------------------------------------------------------------
    // Serial monitor — clean chip output, strip ESP-IDF log formatting
    // ----------------------------------------------------------------
    var showSerialTimestamps = false;

    document.getElementById("monitorTimestampBtn").addEventListener("click", function () {
        showSerialTimestamps = !showSerialTimestamps;
        this.classList.toggle("active", showSerialTimestamps);
        // Toggle timestamps on existing lines
        document.querySelectorAll(".serial-ts").forEach(function (el) {
            el.style.display = showSerialTimestamps ? "" : "none";
        });
    });

    function appendMonitor(text) {
        var output = document.getElementById("monitorOutput");
        var line = document.createElement("div");

        // Strip ANSI codes
        var clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (!clean) return;

        // Parse ESP-IDF log format: "00:10:41.050 [INFO ] volt: actual message"
        // or: "I (12345) volt: actual message"
        var espMatch = clean.match(/^[\d:.]+\s*\[(\w+)\s*\]\s*\w+:\s*(.+)$/);
        var idfMatch = clean.match(/^([IWEDV])\s*\(\d+\)\s*\w+:\s*(.+)$/);
        var msg = clean;
        var lvl = "";

        if (espMatch) {
            lvl = espMatch[1].toLowerCase();
            msg = espMatch[2];
        } else if (idfMatch) {
            var lvlMap = { I: "info", W: "warn", E: "error", D: "debug", V: "debug" };
            lvl = lvlMap[idfMatch[1]] || "info";
            msg = idfMatch[2];
        }

        line.className = "serial-line" + (lvl ? " serial-" + lvl : "");

        // Timestamp
        var now = new Date();
        var ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map(function (n) { return String(n).padStart(2, "0"); }).join(":")
            + "." + String(now.getMilliseconds()).padStart(3, "0");

        line.innerHTML = '<span class="serial-ts" style="' + (showSerialTimestamps ? "" : "display:none") + '">' + ts + ' </span>' + msg.replace(/</g, "&lt;");

        output.appendChild(line);
        output.scrollTop = output.scrollHeight;
        while (output.children.length > 5000) output.removeChild(output.firstChild);
    }

    // ----------------------------------------------------------------
    // Output panel — structured IDE messages + build progress
    // ----------------------------------------------------------------
    var buildProgressEl = null;

    function ensureProgressBar() {
        if (buildProgressEl) return;
        var output = document.getElementById("outputContent");
        buildProgressEl = document.createElement("div");
        buildProgressEl.className = "build-progress";
        buildProgressEl.innerHTML =
            '<div class="build-progress-header">' +
                '<span class="build-progress-stage"></span>' +
                '<span class="build-progress-pct"></span>' +
            '</div>' +
            '<div class="build-progress-track"><div class="build-progress-bar"></div></div>';
        output.appendChild(buildProgressEl);
    }

    function updateProgress(stage, message, percent) {
        ensureProgressBar();
        var stageEl = buildProgressEl.querySelector(".build-progress-stage");
        var pctEl = buildProgressEl.querySelector(".build-progress-pct");
        var barEl = buildProgressEl.querySelector(".build-progress-bar");

        stageEl.textContent = message;
        pctEl.textContent = percent + "%";
        barEl.style.width = percent + "%";

        if (stage === "done") {
            barEl.className = "build-progress-bar done";
        } else if (stage === "error") {
            barEl.className = "build-progress-bar error";
        } else {
            barEl.className = "build-progress-bar";
        }
    }

    function clearProgress() {
        if (buildProgressEl) {
            buildProgressEl.remove();
            buildProgressEl = null;
        }
    }

    function appendOutput(text, level) {
        var output = document.getElementById("outputContent");

        var clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (!clean) return;

        var entry = document.createElement("div");
        entry.className = "output-entry output-" + (level || "info");

        var now = new Date();
        var ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map(function (n) { return String(n).padStart(2, "0"); }).join(":");

        entry.innerHTML =
            '<span class="output-time">' + ts + '</span>' +
            '<span class="output-dot output-dot-' + (level || "info") + '"></span>' +
            '<span class="output-msg">' + clean.replace(/</g, "&lt;") + '</span>';

        output.appendChild(entry);
        output.scrollTop = output.scrollHeight;
        while (output.children.length > 2000) output.removeChild(output.firstChild);
    }

    document.getElementById("monitorClearBtn").addEventListener("click", function () {
        var activePanel = document.querySelector(".panel-content.active");
        if (activePanel) activePanel.innerHTML = "";
        clearProgress();
    });

    document.getElementById("panelCopyBtn").addEventListener("click", function () {
        var activePanel = document.querySelector(".panel-content.active");
        if (!activePanel) return;
        var text = activePanel.innerText;
        navigator.clipboard.writeText(text).then(function () {
            var btn = document.getElementById("panelCopyBtn");
            var label = btn.querySelector("span");
            label.textContent = "Copied";
            setTimeout(function () { label.textContent = "Copy"; }, 1500);
        });
    });

    // ----------------------------------------------------------------
    // Project state
    // ----------------------------------------------------------------
    var currentProjectPath = null;
    var currentVoltFile = null;
    var currentDevices = [];
    var selectedDeviceIndex = 0;

    // ----------------------------------------------------------------
    // Run button
    // ----------------------------------------------------------------
    document.getElementById("runBtn").addEventListener("click", function () {
        if (currentDevices.length === 0) {
            appendOutput("No device connected. Plug in a board to run.", "error"); return;
        }
        if (!currentProjectPath || !currentVoltFile) {
            appendOutput("No file open. Click Open or New first.", "warn"); return;
        }
        var device = currentDevices[selectedDeviceIndex];
        var statusBuild = document.getElementById("statusBuild");
        statusBuild.textContent = "Running...";
        clearProgress();
        updateProgress("compile", "Compiling...", 5);

        saveFile(true).then(function () {
                return invoke("run_project", {
                    projectPath: currentProjectPath,
                    voltFile: currentVoltFile,
                    port: device.port,
                    chip: device.chip,
                });
            })
            .catch(function (e) {
                appendOutput("Run failed: " + e, "error");
                statusBuild.textContent = "Failed";
            });
    });

    // ----------------------------------------------------------------
    // Monitor button
    // ----------------------------------------------------------------
    document.getElementById("monitorBtn").addEventListener("click", function () {
        if (currentDevices.length === 0) {
            appendOutput("No device connected.", "error"); return;
        }
        invoke("is_monitoring").then(function (monitoring) {
            if (monitoring) {
                invoke("stop_monitor");
                var dot = document.querySelector(".panel-dot");
                if (dot) dot.classList.remove("live");
            } else {
                var device = currentDevices[selectedDeviceIndex];
                var baud = device.chip.indexOf("8266") >= 0 ? 74880 : 115200;
                invoke("start_monitor", { port: device.port, baud: baud });
                var dot2 = document.querySelector(".panel-dot");
                if (dot2) dot2.classList.add("live");
            }
        }).catch(function (e) { appendOutput("Monitor error: " + e, "error"); });
    });

    document.getElementById("checkBtn").addEventListener("click", function () {
        saveFile(true).then(function () { runDiagnostics(); });
    });
    document.getElementById("formatBtn").addEventListener("click", function () {
        if (editor) editor.getAction("editor.action.formatDocument").run();
    });

    // Save tracking — compare against last saved content
    var lastSavedContent = "";

    function markUnsaved(dirty) {
        var btn = document.getElementById("saveBtn");
        if (dirty) {
            btn.classList.add("unsaved");
        } else {
            btn.classList.remove("unsaved");
        }
    }

    function checkUnsaved() {
        if (!editor) return;
        var current = editor.getValue();
        markUnsaved(current !== lastSavedContent);
    }

    function saveFile(silent) {
        if (!editor || !currentVoltFile) {
            if (!silent) appendOutput("No file open.", "warn");
            return Promise.resolve();
        }
        var content = editor.getValue();
        return invoke("save_file", { path: currentVoltFile, content: content }).then(function () {
            lastSavedContent = content;
            markUnsaved(false);
            if (!silent) appendOutput("Saved: " + currentVoltFile.split("/").pop(), "success");
        }).catch(function (e) {
            appendOutput("Save failed: " + e, "error");
        });
    }
    document.getElementById("saveBtn").addEventListener("click", saveFile);

    // Volt document formatting provider
    monaco.languages.registerDocumentFormattingEditProvider("volt", {
        provideDocumentFormattingEdits: function (model) {
            var lines = model.getLinesContent();
            var result = [];
            var indent = 0;
            var formatted = [];

            for (var i = 0; i < lines.length; i++) {
                var raw = lines[i];
                var trimmed = raw.trim();

                // Skip empty lines — preserve them
                if (trimmed === "") { formatted.push(""); continue; }

                // Closing brace decreases indent before this line
                if (trimmed.startsWith("}")) indent = Math.max(0, indent - 1);

                // Build indented line
                var spaces = "";
                for (var s = 0; s < indent; s++) spaces += "    ";
                formatted.push(spaces + trimmed);

                // Opening brace increases indent for next line
                if (trimmed.endsWith("{")) indent++;
            }

            var fullRange = model.getFullModelRange();
            result.push({
                range: fullRange,
                text: formatted.join("\n"),
            });
            return result;
        }
    });

    // ----------------------------------------------------------------
    // Hover provider — rich documentation on mouse hover
    // ----------------------------------------------------------------

    // Keyword documentation
    var KEYWORD_DOCS = {
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

    // Type documentation
    var TYPE_DOCS = {
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

    // Builtin object documentation
    var BUILTIN_DOCS = {
        wifi:    { desc: "WiFi networking module", detail: "**Methods:**\n- `connect(ssid, password)` — connect to access point (auto-reconnects)\n- `disconnect()` — disconnect and stop reconnecting\n- `is_connected()` — returns bool\n- `get_ip()` — returns IP address string\n- `get_rssi()` — signal strength in dBm\n\nRequires WiFi-capable chip (ESP32, ESP8266). Forces task to Priority tier." },
        mqtt:    { desc: "MQTT messaging module", detail: "**Methods:**\n- `connect(url)` — connect to broker (`mqtt://host` or `mqtts://host`)\n- `disconnect()`\n- `is_connected()` — returns bool\n- `send(topic, data)` — publish string\n- `send_int(topic, value)` — publish integer\n- `send_float(topic, value)` — publish float\n- `on_receive(topic)` — subscribe to topic\n\nRequires WiFi. Max 16 subscriptions." },
        http:    { desc: "HTTP client module", detail: "**Methods:**\n- `get(url)` — HTTP GET, returns response body\n- `post(url, body)` — HTTP POST, returns response body\n\nRequires WiFi. Forces task to Priority tier." },
        storage: { desc: "Persistent flash storage (NVS)", detail: "**Methods:**\n- `save(key, value)` — save to flash (buffered, flushed every 30s)\n- `load(key)` — load from flash\n- `push(list, value)` — append to named list (store-and-forward)\n- `drain(list)` — read and clear all entries\n- `list_count(list)` — count entries\n- `list_clear(list)` — clear without reading\n\nSurvives reboots and power loss." },
        system:  { desc: "System information and control", detail: "**Methods:**\n- `restart()` — reboot the device\n- `free_heap()` — available RAM in bytes\n- `uptime()` — seconds since boot\n- `id()` — chip/device ID" },
        ota:     { desc: "Over-the-air firmware updates", detail: "**Methods:**\n- `enable()` — start OTA update server" },
        ble:     { desc: "Bluetooth Low Energy", detail: "**Peripheral:**\n- `advertise(name)` — start advertising\n- `expose_int/float/string(name, val)` — expose a value\n- `update_int/float/string(id, val)` — update exposed value\n- `is_connected()` — check if a device is connected\n- `stop()` — stop advertising\n\n**Central (scanning):**\n- `scan(duration)` — scan for nearby devices\n- `scan_name(index)` — get device name\n- `scan_rssi(index)` — get signal strength" },
    };

    // Chip documentation
    var CHIP_DOCS = {
        esp32:     { desc: "ESP32 WROOM-32", detail: "**Specs:** Xtensa LX6 dual-core @ 240MHz, 520KB RAM, 4MB flash\n**Features:** WiFi, Bluetooth, BLE, touch sensing, DAC, ADC, PWM\n**GPIO:** 0-39 (skip 6-11 flash, 20/24/28-31 unavailable)\n**Safe output pins:** 2, 4, 5, 13-19, 21-23, 25-27, 32-33\n**Input-only:** 34-39 (no pull resistors)\n**ADC1 (WiFi-safe):** 32-39\n**ADC2 (blocked by WiFi):** 0, 2, 4, 12-15, 25-27\n**I2C default:** SDA=21, SCL=22" },
        esp8266:   { desc: "ESP8266", detail: "**Specs:** Xtensa LX106 single-core @ 80MHz, 80KB RAM\n**Features:** WiFi, PWM (software), ADC (A0 only, not GPIO)\n**GPIO:** 0-16 (skip 6-11 flash)\n**No:** Bluetooth, touch, DAC, hardware PWM\n**GPIO 16:** RTC domain — no PWM, no interrupts, pull-down only\n**I2C default:** SDA=4, SCL=5\n**Note:** Only A0/TOUT pin has analog — GPIO analog reads will error" },
        rp2040:    { desc: "RP2040 Raspberry Pi Pico", detail: "**Specs:** ARM Cortex-M0+ dual-core @ 133MHz, 264KB RAM\n**Features:** PWM, ADC, PIO, USB\n**GPIO:** GP0-GP28 (GP29 internal voltage)\n**ADC:** GP26, GP27, GP28 only (12-bit)\n**No:** WiFi (use Pico W), Bluetooth, touch, DAC\n**GP25:** Onboard LED (Pico) / WiFi SPI (Pico W)\n**I2C0:** SDA=GP0, SCL=GP1" },
        stm32f103: { desc: "STM32F103 Blue Pill", detail: "**Specs:** ARM Cortex-M3 @ 72MHz, 20KB RAM, 64KB flash\n**No:** WiFi, Bluetooth" },
    };

    // Pin number docs per chip
    var ESP32_PIN_NOTES = {
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

    // Easing curve documentation — real-world use cases for each curve
    var EASING_DOCS = {
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

    // Method signatures for signature help
    var METHOD_SIGS = {
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

    // Method documentation for hover (obj.method)
    var METHOD_DOCS = {
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

    // ESP8266 pin notes
    var ESP8266_PIN_NOTES = {
        0: "Strapping: must be HIGH at boot. LOW = flash mode. FLASH button on dev boards.",
        1: "UART0 TX — using this breaks serial monitor/flashing.",
        2: "Strapping: must be HIGH at boot. Often onboard LED (active LOW).",
        3: "UART0 RX — using this breaks serial input.",
        4: "General purpose. Default I2C SDA. Safe for most uses.",
        5: "General purpose. Default I2C SCL. Safe for most uses.",
        12: "HSPI MISO. Safe for general use.",
        13: "HSPI MOSI. Safe for general use.",
        14: "HSPI CLK. Safe for general use.",
        15: "Strapping: must be LOW at boot. HIGH = boot from SD card.",
        16: "RTC domain. No PWM, no interrupts, pull-down only. Can wake from deep sleep.",
    };

    // RP2040 pin notes
    var RP2040_PIN_NOTES = {
        0:  "I2C0 SDA / UART0 TX.",
        1:  "I2C0 SCL / UART0 RX.",
        25: "Onboard LED (Pico). WiFi SPI on Pico W — not available as GPIO.",
        23: "SMPS power save control on Pico board.",
        24: "VBUS sense — HIGH when USB connected.",
        26: "ADC channel 0. 12-bit analog input.",
        27: "ADC channel 1. 12-bit analog input.",
        28: "ADC channel 2. 12-bit analog input.",
        29: "Internal VSYS/3 voltage divider. Not for user GPIO.",
    };

    // Detect which chip the document uses
    function detectChip(model) {
        var matches = model.findMatches("\\bchip\\s+(\\w+)", false, true, false, null, true);
        return matches.length > 0 ? matches[0].matches[1] : "esp32";
    }

    // Get pin notes for any chip
    function getPinNote(chip, num) {
        if (chip === "esp32") {
            if (ESP32_PIN_NOTES[num]) return "**ESP32 GPIO " + num + "**\n\n" + ESP32_PIN_NOTES[num];
            if (num >= 6 && num <= 11) return "**ESP32 GPIO " + num + "** — Connected to SPI flash. **Using this will crash the chip.**";
            if (num === 20 || num === 24 || (num >= 28 && num <= 31)) return "**GPIO " + num + "** — Not available on ESP32-WROOM-32.";
            if (num >= 34 && num <= 39) return "**ESP32 GPIO " + num + "** — Input only. No internal pull resistors. ADC1 (safe with WiFi).";
            if (num >= 0 && num <= 39) return "**ESP32 GPIO " + num + "** — Available for general use.";
        } else if (chip === "esp8266") {
            if (ESP8266_PIN_NOTES[num]) return "**ESP8266 GPIO " + num + "**\n\n" + ESP8266_PIN_NOTES[num];
            if (num >= 6 && num <= 11) return "**ESP8266 GPIO " + num + "** — SPI flash. **Using this will crash the chip.**";
            if (num >= 0 && num <= 16) return "**ESP8266 GPIO " + num + "** — Available for general use.";
        } else if (chip === "rp2040") {
            if (RP2040_PIN_NOTES[num]) return "**RP2040 GP" + num + "**\n\n" + RP2040_PIN_NOTES[num];
            if (num >= 0 && num <= 28) return "**RP2040 GP" + num + "** — Available for general use. PWM capable.";
        }
        return null;
    }

    // ---- Hover provider ----
    monaco.languages.registerHoverProvider("volt", {
        provideHover: function (model, position) {
            var word = model.getWordAtPosition(position);
            var line = model.getLineContent(position.lineNumber);
            var col = position.column - 1;
            var contents = [];
            var hoverRange = null;

            // -- Try to detect obj.method pattern --
            if (word) {
                var beforeDot = line.substring(0, word.startColumn - 1);
                var dotMatch = beforeDot.match(/(\w+)\.\s*$/);

                if (dotMatch) {
                    var obj = dotMatch[1];
                    var method = word.word;
                    var fullKey = obj + "." + method;
                    hoverRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);

                    // Check builtin object methods
                    if (METHOD_DOCS[fullKey]) {
                        var md = METHOD_DOCS[fullKey];
                        contents.push({ value: "```volt\n" + md.sig + "\n```" });
                        contents.push({ value: md.desc });
                        if (md.detail) contents.push({ value: md.detail });
                    } else {
                        // Check if obj is a declared pin/sensor — look up by type
                        var decls = scanDeclarations(model);
                        var pinMode = decls.pins[obj];
                        var sensorType = decls.sensors[obj];

                        if (pinMode) {
                            // Normalize: PullUpInput -> Input for method lookup
                            var baseMode = pinMode.split(".")[0];
                            var typeKey = baseMode + "." + method;
                            if (METHOD_DOCS[typeKey]) {
                                var pmd = METHOD_DOCS[typeKey];
                                contents.push({ value: "**" + obj + "** (" + pinMode + " pin)" });
                                contents.push({ value: "```volt\n" + pmd.sig + "\n```" });
                                contents.push({ value: pmd.desc });
                                if (pmd.detail) contents.push({ value: pmd.detail });
                            }
                        } else if (sensorType) {
                            var stKey = sensorType + "." + method;
                            if (METHOD_DOCS[stKey]) {
                                var smd = METHOD_DOCS[stKey];
                                contents.push({ value: "**" + obj + "** (" + sensorType + " sensor)" });
                                contents.push({ value: "```volt\n" + smd.sig + "\n```" });
                                contents.push({ value: smd.desc });
                                if (smd.detail) contents.push({ value: smd.detail });
                            }
                        }
                    }

                    if (contents.length > 0) return { range: hoverRange, contents: contents };
                }
            }

            // -- Standard word hover --
            if (!word) return null;
            var w = word.word;
            hoverRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);

            // Keywords
            if (KEYWORD_DOCS[w]) {
                var kd = KEYWORD_DOCS[w];
                contents.push({ value: "**" + kd.cat + "**" });
                contents.push({ value: "```volt\n" + kd.sig + "\n```" });
                contents.push({ value: kd.desc });
                if (kd.detail) contents.push({ value: kd.detail });
            }
            // Types
            else if (TYPE_DOCS[w]) {
                var td = TYPE_DOCS[w];
                contents.push({ value: "**Type**" });
                contents.push({ value: "`" + w + "` — " + td.desc });
                if (td.detail) contents.push({ value: td.detail });
            }
            // Builtin objects
            else if (BUILTIN_DOCS[w]) {
                var bd = BUILTIN_DOCS[w];
                contents.push({ value: "**Builtin Module**" });
                contents.push({ value: "`" + w + "` — " + bd.desc });
                if (bd.detail) contents.push({ value: bd.detail });
            }
            // Chip names
            else if (CHIP_DOCS[w]) {
                var chd = CHIP_DOCS[w];
                contents.push({ value: "**Chip**" });
                contents.push({ value: "`" + w + "` — " + chd.desc });
                if (chd.detail) contents.push({ value: chd.detail });
            }
            // Pin numbers (in any numeric context — hardware block or assignment)
            else if (/^\d+$/.test(w)) {
                var num = parseInt(w);
                var chip = detectChip(model);
                var note = getPinNote(chip, num);
                if (note) contents.push({ value: note });
            }
            // Constants
            else if (w === "true" || w === "false") {
                contents.push({ value: "**Constant** — Boolean literal `" + w + "`" });
            }
            else if (w === "HIGH" || w === "LOW" || w === "ON" || w === "OFF") {
                contents.push({ value: "**Constant** — Pin level `" + w + "` (" + (w === "HIGH" || w === "ON" ? "1" : "0") + ")" });
            }
            else if (EASING_DOCS[w]) {
                var ed = EASING_DOCS[w];
                contents.push({ value: "**Easing** \u2014 `" + w + "`" });
                contents.push({ value: ed.desc });
                contents.push({ value: "**When to use:** " + ed.use_case });
                if (ed.examples) contents.push({ value: "**Examples:** " + ed.examples });
            }
            // Declared pins — show pin info when hovering the variable name
            else {
                var decls = scanDeclarations(model);
                if (decls.pins[w]) {
                    var mode = decls.pins[w];
                    contents.push({ value: "**Pin** `" + w + "` : " + mode });
                    if (TYPE_DOCS[mode]) contents.push({ value: TYPE_DOCS[mode].detail || TYPE_DOCS[mode].desc });
                    // Try to find the GPIO number
                    var pinLine = model.findMatches("\\bpin\\s+" + w + "\\s*:.*=\\s*(\\d+)", false, true, false, null, true);
                    if (pinLine.length > 0) {
                        var gpio = parseInt(pinLine[0].matches[1]);
                        var pnote = getPinNote(detectChip(model), gpio);
                        if (pnote) contents.push({ value: pnote });
                    }
                } else if (decls.sensors[w]) {
                    var stype = decls.sensors[w];
                    contents.push({ value: "**Sensor** `" + w + "` : " + stype });
                    // Show available methods
                    var smethods = SENSOR_METHODS[stype];
                    if (smethods) {
                        contents.push({ value: "**Methods:** " + smethods.map(function(m) { return "`." + m.label + "()` " + m.detail; }).join("\n\n") });
                    }
                }
            }

            // Duration literals — show human-readable conversion
            var durRegex = /\b(\d+)(us|ms|s|sec|seconds?|min|minutes?|hr|hours?)\b/g;
            var durMatch;
            while ((durMatch = durRegex.exec(line)) !== null) {
                var dStart = durMatch.index + 1;
                var dEnd = dStart + durMatch[0].length;
                if (position.column >= dStart && position.column <= dEnd) {
                    var amount = parseInt(durMatch[1]);
                    var unit = durMatch[2];
                    var us = amount;
                    if (unit === "us") us = amount;
                    else if (unit === "ms") us = amount * 1000;
                    else if (unit === "s" || unit === "sec" || unit === "second" || unit === "seconds") us = amount * 1000000;
                    else if (unit === "min" || unit === "minute" || unit === "minutes") us = amount * 60000000;
                    else if (unit === "hr" || unit === "hour" || unit === "hours") us = amount * 3600000000;

                    // Show human-readable conversions
                    var parts = [];
                    if (us < 1000) parts.push(us + " microseconds");
                    else if (us < 1000000) parts.push((us / 1000) + "ms");
                    else if (us < 60000000) parts.push((us / 1000000) + " seconds");
                    else if (us < 3600000000) parts.push((us / 60000000) + " minutes");
                    else parts.push((us / 3600000000) + " hours");

                    contents.push({ value: "**" + parts.join(" = ") + "**" });
                    break;
                }
            }

            if (contents.length === 0) return null;
            return { range: hoverRange, contents: contents };
        }
    });

    // ----------------------------------------------------------------
    // Signature help — parameter hints while typing function calls
    // ----------------------------------------------------------------
    monaco.languages.registerSignatureHelpProvider("volt", {
        signatureHelpTriggerCharacters: ["(", ","],
        provideSignatureHelp: function (model, position) {
            var line = model.getLineContent(position.lineNumber);
            var textBefore = line.substring(0, position.column - 1);

            // Find the function call context
            // Match: word( or word.word(
            var callMatch = textBefore.match(/\b(\w+(?:\.\w+)?)\s*\(([^)]*)$/);
            if (!callMatch) return null;

            var funcName = callMatch[1];
            var argsText = callMatch[2];

            // Count commas to determine active parameter
            var activeParam = (argsText.match(/,/g) || []).length;

            var sig = METHOD_SIGS[funcName];
            if (!sig) return null;

            return {
                value: {
                    signatures: [{
                        label: sig.label,
                        parameters: sig.params.map(function (p) {
                            return { label: p.label, documentation: p.doc };
                        }),
                    }],
                    activeSignature: 0,
                    activeParameter: activeParam,
                },
                dispose: function () {},
            };
        }
    });

    // ----------------------------------------------------------------
    // ----------------------------------------------------------------
    // Go-to-definition, Find references, Rename symbol
    // ----------------------------------------------------------------
    var cachedSymbols = null;
    var symbolCacheVersion = -1;

    function getSymbols() {
        if (!editor) return Promise.resolve([]);
        var model = editor.getModel();
        if (!model) return Promise.resolve([]);
        var version = model.getVersionId();
        if (cachedSymbols && symbolCacheVersion === version) {
            return Promise.resolve(cachedSymbols);
        }
        return invoke("find_symbols", { source: editor.getValue() }).then(function (syms) {
            cachedSymbols = syms;
            symbolCacheVersion = version;
            return syms;
        }).catch(function () { return []; });
    }

    function findSymbolAt(syms, line, col) {
        // Find a symbol whose definition or reference is at this position
        for (var i = 0; i < syms.length; i++) {
            var s = syms[i];
            if (s.def_line === line) {
                // Check if cursor is on the symbol name at definition
                return s;
            }
            for (var j = 0; j < s.refs.length; j++) {
                if (s.refs[j].line === line) {
                    return s;
                }
            }
        }
        // Fallback: match by word at position
        return null;
    }

    function findSymbolByWord(syms, word) {
        for (var i = 0; i < syms.length; i++) {
            if (syms[i].name === word) return syms[i];
        }
        return null;
    }

    // Go-to-definition: Ctrl+Click or F12
    monaco.languages.registerDefinitionProvider("volt", {
        provideDefinition: function (model, position) {
            var word = model.getWordAtPosition(position);
            if (!word) return null;
            return getSymbols().then(function (syms) {
                var sym = findSymbolByWord(syms, word.word);
                if (!sym || !sym.def_line) return null;
                return {
                    uri: model.uri,
                    range: new monaco.Range(sym.def_line, sym.def_col, sym.def_line, sym.def_col + sym.name.length),
                };
            });
        }
    });

    // Find references: Shift+F12
    monaco.languages.registerReferenceProvider("volt", {
        provideReferences: function (model, position) {
            var word = model.getWordAtPosition(position);
            if (!word) return null;
            return getSymbols().then(function (syms) {
                var sym = findSymbolByWord(syms, word.word);
                if (!sym) return [];
                var results = [];
                // Include definition
                results.push({
                    uri: model.uri,
                    range: new monaco.Range(sym.def_line, sym.def_col, sym.def_line, sym.def_col + sym.name.length),
                });
                // Include all references
                for (var j = 0; j < sym.refs.length; j++) {
                    var ref = sym.refs[j];
                    results.push({
                        uri: model.uri,
                        range: new monaco.Range(ref.line, ref.col, ref.line, ref.col + sym.name.length),
                    });
                }
                return results;
            });
        }
    });

    // Rename symbol: F2
    monaco.languages.registerRenameProvider("volt", {
        provideRenameEdits: function (model, position, newName) {
            var word = model.getWordAtPosition(position);
            if (!word) return null;
            return getSymbols().then(function (syms) {
                var sym = findSymbolByWord(syms, word.word);
                if (!sym) return null;
                var edits = [];
                // Rename at definition
                edits.push({
                    resource: model.uri,
                    textEdit: {
                        range: new monaco.Range(sym.def_line, sym.def_col, sym.def_line, sym.def_col + sym.name.length),
                        text: newName,
                    },
                    versionId: model.getVersionId(),
                });
                // Rename all references
                for (var j = 0; j < sym.refs.length; j++) {
                    var ref = sym.refs[j];
                    edits.push({
                        resource: model.uri,
                        textEdit: {
                            range: new monaco.Range(ref.line, ref.col, ref.line, ref.col + sym.name.length),
                            text: newName,
                        },
                        versionId: model.getVersionId(),
                    });
                }
                return { edits: edits };
            });
        },
        resolveRenameLocation: function (model, position) {
            var word = model.getWordAtPosition(position);
            if (!word) return { rejectReason: "Not a renamable symbol" };
            return getSymbols().then(function (syms) {
                var sym = findSymbolByWord(syms, word.word);
                if (!sym) return { rejectReason: "Symbol not found" };
                return {
                    range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
                    text: sym.name,
                };
            });
        }
    });

    // Document symbol outline: Ctrl+Shift+O
    monaco.languages.registerDocumentSymbolProvider("volt", {
        provideDocumentSymbols: function (model) {
            return getSymbols().then(function (syms) {
                var kindMap = {
                    pin: monaco.languages.SymbolKind.Field,
                    sensor: monaco.languages.SymbolKind.Field,
                    bus: monaco.languages.SymbolKind.Interface,
                    var: monaco.languages.SymbolKind.Variable,
                    storage: monaco.languages.SymbolKind.Variable,
                    func: monaco.languages.SymbolKind.Function,
                    task: monaco.languages.SymbolKind.Function,
                    machine: monaco.languages.SymbolKind.Class,
                    state: monaco.languages.SymbolKind.Enum,
                    param: monaco.languages.SymbolKind.Variable,
                };
                return syms.map(function (s) {
                    return {
                        name: s.name,
                        kind: kindMap[s.kind] || monaco.languages.SymbolKind.Variable,
                        range: new monaco.Range(s.def_line, s.def_col, s.def_line, s.def_col + s.name.length),
                        selectionRange: new monaco.Range(s.def_line, s.def_col, s.def_line, s.def_col + s.name.length),
                        detail: s.kind,
                    };
                });
            });
        }
    });

    // ----------------------------------------------------------------
    // Real-time diagnostics — check as you type
    // ----------------------------------------------------------------
    var diagnosticTimer = null;

    function runDiagnostics() {
        if (!editor) return;
        var model = editor.getModel();
        if (!model) return;

        var source = editor.getValue();
        if (!source.trim()) {
            monaco.editor.setModelMarkers(model, "volt", []);
            updateProblemBadge(0);
            return;
        }

        // Call backend compiler checker
        invoke("check_code", { source: source }).then(function (diags) {
            if (!editor) return;
            var m = editor.getModel();
            if (!m) return;

            var markers = diags.map(function (d) {
                var sev = d.severity === "error" ? monaco.MarkerSeverity.Error
                        : d.severity === "warning" ? monaco.MarkerSeverity.Warning
                        : monaco.MarkerSeverity.Info;

                // Build a helpful message
                var msg = d.message;
                if (d.hint) msg += "\n\nHint: " + d.hint;

                // Try to determine error span length from the line content
                var endCol = (d.col || 1) + 1;
                try {
                    var errLine = m.getLineContent(d.line || 1);
                    var startCol = (d.col || 1) - 1;
                    // Expand to full word
                    var wStart = startCol;
                    var wEnd = startCol;
                    while (wStart > 0 && /\w/.test(errLine[wStart - 1])) wStart--;
                    while (wEnd < errLine.length && /\w/.test(errLine[wEnd])) wEnd++;
                    if (wEnd > wStart) {
                        endCol = wEnd + 1;
                        d.col = wStart + 1;
                    }
                } catch(e) {}

                return {
                    severity: sev,
                    startLineNumber: d.line || 1,
                    startColumn: d.col || 1,
                    endLineNumber: d.line || 1,
                    endColumn: endCol,
                    message: msg,
                };
            });

            monaco.editor.setModelMarkers(m, "volt", markers);
            updateProblemsPanel(diags);
        }).catch(function () {
            // Silently ignore — checker not available
        });
    }

    function updateProblemsPanel(diags) {
        var badge = document.getElementById("problemCount");
        var panel = document.getElementById("problemsContent");

        if (diags.length > 0) {
            badge.textContent = String(diags.length);
            badge.style.display = "inline";
        } else {
            badge.style.display = "none";
        }

        if (diags.length === 0) {
            panel.innerHTML = '<div style="color:var(--t3);padding:16px">No problems detected.</div>';
            return;
        }

        panel.innerHTML = diags.map(function (d) {
            var icon = d.severity === "error" ? "x" : "!";
            var sevClass = d.severity === "error" ? "output-error" : "output-warn";
            var hint = d.hint ? '<div class="output-msg" style="color:var(--t3);margin-top:2px;font-size:11px">Hint: ' + d.hint + '</div>' : '';
            return '<div class="problem-item ' + sevClass + '" data-line="' + (d.line || 1) + '">' +
                '<span class="output-icon">' + icon + '</span>' +
                '<span class="output-time">Ln ' + (d.line || 1) + '</span>' +
                '<span class="output-msg">' + d.message + '</span>' +
                hint +
            '</div>';
        }).join("");

        // Click to jump to line
        panel.querySelectorAll(".problem-item").forEach(function (item) {
            item.addEventListener("click", function () {
                if (!editor) return;
                var ln = parseInt(item.dataset.line);
                editor.revealLineInCenter(ln);
                editor.setPosition({ lineNumber: ln, column: 1 });
                editor.focus();
            });
        });
    }

    function scheduleDiagnostics() {
        clearTimeout(diagnosticTimer);
        diagnosticTimer = setTimeout(runDiagnostics, 800);
        // Also trigger ASTStore compile for panel updates
        if (editor) {
            ASTStore.scheduleCompile(editor.getValue());
        }
    }

    // ----------------------------------------------------------------
    // Tauri event listeners
    // ----------------------------------------------------------------
    // Serial data — chip output only, goes to Serial Monitor tab
    tauriListen("serial:data", function (ev) { appendMonitor(ev.payload.line); });
    tauriListen("serial:connected", function (ev) {
        appendOutput("Serial connected: " + ev.payload, "success");
        var d = document.querySelector(".panel-dot"); if (d) d.classList.add("live");
    });
    tauriListen("serial:disconnected", function (ev) {
        appendOutput("Serial disconnected: " + ev.payload, "warn");
        var d = document.querySelector(".panel-dot"); if (d) d.classList.remove("live");
    });
    tauriListen("serial:error", function (ev) { appendOutput("Serial error: " + ev.payload, "error"); });

    // Build/flash progress — progress bar + structured output
    tauriListen("run:progress", function (ev) {
        var s = ev.payload.stage;
        var m = ev.payload.message;
        var p = ev.payload.percent || 0;
        var sb = document.getElementById("statusBuild");

        if (s === "error") {
            sb.textContent = "Failed";
            updateProgress(s, m, p);
            appendOutput(m, "error");
        } else if (s === "done") {
            sb.textContent = "";
            updateProgress(s, m, 100);
            appendOutput(m, "success");
            // Clear progress bar after 3 seconds on success
            setTimeout(clearProgress, 3000);
        } else {
            sb.textContent = m;
            updateProgress(s, m, p);
        }
    });
    tauriListen("run:output", function (ev) { appendOutput(ev.payload, "debug"); });

    // ----------------------------------------------------------------
    // Project picker
    // ----------------------------------------------------------------
    var pickerOverlay = document.getElementById("projectPickerOverlay");
    var projectListEl = document.getElementById("projectList");

    document.getElementById("openProjectBtn").addEventListener("click", function () {
        invoke("list_projects").then(function (projects) {
            if (projects.length === 0) {
                projectListEl.innerHTML = '<div class="picker-empty">No projects in ~/Volt/. Click New to create one.</div>';
            } else {
                projectListEl.innerHTML = projects.map(function (p) {
                    var ago = timeAgo(p.modified);
                    return '<div class="picker-item" data-path="' + p.path + '">' +
                        '<div class="picker-item-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div>' +
                        '<div class="picker-item-info"><div class="picker-item-name">' + p.name + '</div>' +
                        '<div class="picker-item-meta"><span class="picker-item-chip">' + p.chip.toUpperCase() + '</span><span>' + ago + '</span></div></div></div>';
                }).join("");
                projectListEl.querySelectorAll(".picker-item").forEach(function (item) {
                    item.addEventListener("click", function () {
                        pickerOverlay.classList.remove("open");
                        loadProject(item.dataset.path);
                    });
                });
            }
            pickerOverlay.classList.add("open");
        }).catch(function (e) { appendOutput("Cannot list projects: " + e, "error"); });
    });

    document.getElementById("pickerCloseBtn").addEventListener("click", function () {
        pickerOverlay.classList.remove("open");
    });

    document.getElementById("pickerBrowseBtn").addEventListener("click", function () {
        invoke("browse_volt_file").then(function (result) {
            if (result) {
                pickerOverlay.classList.remove("open");
                loadProjectFile(result.folder, result.file, result.name);
            }
        }).catch(function (e) { appendOutput("Browse failed: " + e, "error"); });
    });

    pickerOverlay.addEventListener("click", function (e) {
        if (e.target === pickerOverlay) pickerOverlay.classList.remove("open");
    });

    function timeAgo(ts) {
        if (!ts) return "";
        var diff = Math.floor(Date.now() / 1000) - ts;
        if (diff < 60) return "just now";
        if (diff < 3600) return Math.floor(diff / 60) + "m ago";
        if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
        if (diff < 604800) return Math.floor(diff / 86400) + "d ago";
        return new Date(ts * 1000).toLocaleDateString();
    }

    // ----------------------------------------------------------------
    // New Project
    // ----------------------------------------------------------------
    // ----------------------------------------------------------------
    // New Project Wizard (3-step)
    // ----------------------------------------------------------------
    var wizardState = { step: 1, chip: "esp32", template: "blink" };

    function showWizard() {
        wizardState = { step: 1, chip: "esp32", template: "blink" };
        document.getElementById("wizardOverlay").style.display = "";
        updateWizardStep();
        // Auto-select detected board
        if (currentDevices.length > 0) {
            var detected = currentDevices[selectedDeviceIndex].chip.toLowerCase();
            if (detected.indexOf("rp2040") >= 0 || detected.indexOf("pico") >= 0) wizardState.chip = "rp2040";
            else if (detected.indexOf("8266") >= 0) wizardState.chip = "esp8266";
            else wizardState.chip = "esp32";
            // Highlight the detected board
            var cards = document.querySelectorAll("#wizardBoards .wizard-card");
            cards.forEach(function(c) {
                c.classList.toggle("active", c.getAttribute("data-chip") === wizardState.chip);
            });
        }
    }

    function hideWizard() {
        document.getElementById("wizardOverlay").style.display = "none";
    }

    function updateWizardStep() {
        document.getElementById("wizardStep1").style.display = wizardState.step === 1 ? "" : "none";
        document.getElementById("wizardStep2").style.display = wizardState.step === 2 ? "" : "none";
        document.getElementById("wizardStep3").style.display = wizardState.step === 3 ? "" : "none";
        document.getElementById("wizardBackBtn").style.display = wizardState.step > 1 ? "" : "none";
        document.getElementById("wizardNextBtn").textContent = wizardState.step === 3 ? "Create" : "Next";
        var titles = { 1: "Select Board", 2: "Choose Template", 3: "Name Project" };
        document.getElementById("wizardTitle").textContent = titles[wizardState.step];
        if (wizardState.step === 3) {
            setTimeout(function() { document.getElementById("wizardName").focus(); }, 50);
        }
    }

    // Board card clicks
    document.getElementById("wizardBoards").addEventListener("click", function(e) {
        var card = e.target.closest(".wizard-card");
        if (!card) return;
        document.querySelectorAll("#wizardBoards .wizard-card").forEach(function(c) { c.classList.remove("active"); });
        card.classList.add("active");
        wizardState.chip = card.getAttribute("data-chip");
    });

    // Template card clicks
    document.getElementById("wizardTemplates").addEventListener("click", function(e) {
        var card = e.target.closest(".wizard-card");
        if (!card) return;
        document.querySelectorAll("#wizardTemplates .wizard-card").forEach(function(c) { c.classList.remove("active"); });
        card.classList.add("active");
        wizardState.template = card.getAttribute("data-template");
    });

    document.getElementById("wizardNextBtn").addEventListener("click", function() {
        if (wizardState.step < 3) {
            wizardState.step++;
            updateWizardStep();
        } else {
            // Create project
            var name = document.getElementById("wizardName").value.trim();
            if (!name) { document.getElementById("wizardName").focus(); return; }
            invoke("create_project", { name: name, chip: wizardState.chip }).then(function(path) {
                if (path) {
                    hideWizard();
                    loadProject(path);
                    appendOutput("Created project: " + path + " (" + wizardState.chip + ")", "success");
                }
            }).catch(function(e) { appendOutput("New project failed: " + e, "error"); });
        }
    });

    document.getElementById("wizardBackBtn").addEventListener("click", function() {
        if (wizardState.step > 1) { wizardState.step--; updateWizardStep(); }
    });

    document.getElementById("wizardCloseBtn").addEventListener("click", hideWizard);
    document.getElementById("wizardOverlay").addEventListener("click", function(e) {
        if (e.target === this) hideWizard();
    });

    // Enter key in name field
    document.getElementById("wizardName").addEventListener("keydown", function(e) {
        if (e.key === "Enter") document.getElementById("wizardNextBtn").click();
    });

    // Wire both New buttons to the wizard
    document.getElementById("newProjectBtn").addEventListener("click", showWizard);

    // ----------------------------------------------------------------
    // Load project
    // ----------------------------------------------------------------
    function loadProject(folder) {
        loadProjectFile(folder, folder + "/main.volt", "main.volt");
    }

    function loadProjectFile(folder, filePath, fileName) {
        invoke("read_file", { path: filePath }).then(function (content) {
            currentProjectPath = folder;
            currentVoltFile = filePath;
            showEditor();
            setTimeout(function () {
                if (editor) { editor.setValue(content); editor.setPosition({ lineNumber: 1, column: 1 }); }
                lastSavedContent = content;
                markUnsaved(false);
            }, 100);
            document.title = fileName + " -- " + folder.split("/").pop() + " -- Volt IDE";
            appendOutput("Opened: " + filePath, "success");
        }).catch(function (e) { appendOutput("Cannot read " + filePath + ": " + e, "error"); });
    }

    // ----------------------------------------------------------------
    // Window controls + drag
    // ----------------------------------------------------------------
    var win = getTauriWindow();
    if (win) {
        var minBtn = document.getElementById("winMinimize");
        var maxBtn = document.getElementById("winMaximize");
        var closeBtn = document.getElementById("winClose");
        if (minBtn) minBtn.addEventListener("click", function () { win.minimize(); });
        if (maxBtn) maxBtn.addEventListener("click", function () { win.toggleMaximize(); });
        if (closeBtn) closeBtn.addEventListener("click", function () { win.close(); });

        var toolbar = document.getElementById("toolbar");
        toolbar.addEventListener("mousedown", function (e) {
            if (e.target === toolbar || e.target.classList.contains("toolbar-brand") ||
                e.target.classList.contains("brand-name") || e.target.classList.contains("brand-logo") ||
                e.target.classList.contains("toolbar-divider")) {
                win.startDragging();
            }
        });
        toolbar.addEventListener("dblclick", function (e) {
            if (e.target === toolbar || e.target.classList.contains("brand-name")) {
                win.toggleMaximize();
            }
        });
    }

    // ----------------------------------------------------------------
    // Device detection
    // ----------------------------------------------------------------
    function scanDevices() {
        invoke("scan_devices").then(function (devices) {
            currentDevices = devices;
            updateDeviceUI(devices);
        }).catch(function () { updateDeviceUI([]); });
    }

    function updateDeviceUI(devices) {
        var label = document.getElementById("deviceLabel");
        var dot = document.getElementById("deviceDot");
        var statusChip = document.getElementById("statusChip");
        var statusPort = document.getElementById("statusPort");
        var dropdownList = document.getElementById("dropdownList");
        var dropdownEmpty = document.getElementById("dropdownEmpty");

        if (devices.length === 0) {
            label.textContent = "No device";
            dot.className = "device-dot";
            statusChip.innerHTML = '<span class="status-dot"></span> No device';
            statusPort.textContent = "";
            dropdownEmpty.style.display = "block";
            dropdownList.innerHTML = "";
        } else {
            if (selectedDeviceIndex >= devices.length) selectedDeviceIndex = 0;
            var d = devices[selectedDeviceIndex];
            label.textContent = d.chip;
            dot.className = "device-dot connected";
            statusChip.innerHTML = '<span class="status-dot on"></span> ' + d.chip;
            statusPort.textContent = d.port;
            dropdownEmpty.style.display = "none";
            dropdownList.innerHTML = devices.map(function (dev, i) {
                return '<div class="dropdown-item ' + (i === selectedDeviceIndex ? "selected" : "") + '" data-index="' + i + '">' +
                    '<span class="device-dot ' + (dev.chip !== "unknown" ? "connected" : "") + '"></span>' +
                    '<div><div class="dropdown-chip">' + dev.chip + '</div><div class="dropdown-desc">' + dev.desc + '</div></div>' +
                    '<span class="dropdown-port">' + dev.port + '</span></div>';
            }).join("");
            dropdownList.querySelectorAll(".dropdown-item").forEach(function (item) {
                item.addEventListener("click", function () {
                    selectedDeviceIndex = parseInt(item.dataset.index);
                    updateDeviceUI(currentDevices);
                    closeDropdown();
                });
            });
        }
    }

    var dropdown = document.getElementById("deviceDropdown");
    function toggleDropdown() {
        dropdown.classList.toggle("open");
        if (dropdown.classList.contains("open")) scanDevices();
    }
    function closeDropdown() { dropdown.classList.remove("open"); }

    var devSel = document.getElementById("deviceSelector");
    if (devSel) devSel.addEventListener("click", function (e) { e.stopPropagation(); toggleDropdown(); });
    document.addEventListener("click", function (e) {
        if (!e.target.closest(".device-selector-wrap")) closeDropdown();
    });

    // ----------------------------------------------------------------
    // Panel tabs
    // ----------------------------------------------------------------
    var panelMap = { monitor: "monitorOutput", output: "outputContent", problems: "problemsContent" };

    function updatePanelActions(activePanel) {
        document.querySelectorAll(".panel-action-btn[data-for]").forEach(function (btn) {
            var forPanels = btn.dataset.for;
            btn.style.display = (forPanels === "all" || forPanels.indexOf(activePanel) >= 0) ? "" : "none";
        });
    }

    document.querySelectorAll(".panel-tab").forEach(function (tab) {
        tab.addEventListener("click", function () {
            document.querySelectorAll(".panel-tab").forEach(function (t) { t.classList.remove("active"); });
            document.querySelectorAll(".panel-content").forEach(function (c) { c.classList.remove("active"); });
            tab.classList.add("active");
            var panel = tab.dataset.panel;
            var target = panelMap[panel];
            if (target) document.getElementById(target).classList.add("active");
            updatePanelActions(panel);
        });
    });

    // Init — show actions for default tab
    updatePanelActions("output");

    // ----------------------------------------------------------------
    // Keyboard shortcuts
    // ----------------------------------------------------------------
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { pickerOverlay.classList.remove("open"); closeDropdown(); }
        if (e.ctrlKey && e.key === "r") { e.preventDefault(); document.getElementById("runBtn").click(); }
        if (e.ctrlKey && e.key === "m") { e.preventDefault(); document.getElementById("monitorBtn").click(); }
        if (e.ctrlKey && e.key === "b") { e.preventDefault(); document.getElementById("checkBtn").click(); }
        if (e.ctrlKey && e.key === "n") { e.preventDefault(); document.getElementById("newProjectBtn").click(); }
        if (e.ctrlKey && e.key === "o") { e.preventDefault(); document.getElementById("openProjectBtn").click(); }
        if (e.ctrlKey && e.key === "s") { e.preventDefault(); saveFile(); }
    });

    // ----------------------------------------------------------------
    // Welcome buttons + recent projects
    // ----------------------------------------------------------------
    var wNew = document.getElementById("welcomeNewBtn");
    var wOpen = document.getElementById("welcomeOpenBtn");
    if (wNew) wNew.addEventListener("click", function () { document.getElementById("newProjectBtn").click(); });
    if (wOpen) wOpen.addEventListener("click", function () { document.getElementById("openProjectBtn").click(); });

    function loadWelcomeRecent() {
        invoke("list_projects").then(function (projects) {
            var c = document.getElementById("welcomeRecent");
            if (!projects.length) { c.innerHTML = ""; return; }
            c.innerHTML = '<div class="welcome-recent-title">Recent Projects</div>' +
                projects.slice(0, 5).map(function (p) {
                    return '<div class="welcome-recent-item" data-path="' + p.path + '">' + p.name +
                        '<span class="welcome-recent-chip">' + p.chip.toUpperCase() + '</span></div>';
                }).join("");
            c.querySelectorAll(".welcome-recent-item").forEach(function (item) {
                item.addEventListener("click", function () { loadProject(item.dataset.path); });
            });
        }).catch(function () {});
    }

    // Settings placeholder
    document.getElementById("settingsBtn").addEventListener("click", function () {
        appendOutput("Settings coming soon.", "info");
    });

    // ----------------------------------------------------------------
    // Init
    // ----------------------------------------------------------------
    showWelcome();
    loadWelcomeRecent();
    scanDevices();
    setInterval(scanDevices, 3000);

})();
