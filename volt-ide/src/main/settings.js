// Settings store — persists to ~/.volt/settings.json.
//
// Single source of truth for editable IDE preferences. Defaults live here,
// values are loaded once at startup and rewritten on every change.
//
// Each setting has: type, default, options (for enums), label, hint, category.

const path = require("path");
const fs = require("fs");
const os = require("os");

const SETTINGS_FILE = path.join(os.homedir(), ".volt", "settings.json");

// --- Schema: defines every setting the IDE knows about ---------------------
// type: bool | int | float | string | enum | path
// options: only for enum types (array of {value,label})
// min/max/step: only for int/float (slider hints)
const SCHEMA = {
    editor: {
        label: "Editor",
        items: {
            fontSize:       { type: "int",    default: 14,    min: 10, max: 24, step: 1,
                              label: "Font size", hint: "Editor text size in pixels." },
            lineHeight:     { type: "int",    default: 24,    min: 16, max: 36, step: 1,
                              label: "Line height", hint: "Vertical space per line." },
            tabSize:        { type: "enum",   default: 4,
                              options: [{value: 2, label: "2 spaces"}, {value: 4, label: "4 spaces"}, {value: 8, label: "8 spaces"}],
                              label: "Tab size" },
            fontLigatures:  { type: "bool",   default: true,
                              label: "Font ligatures", hint: "Replace ≠ != etc. with combined glyphs." },
            smoothCursor:   { type: "bool",   default: true,
                              label: "Smooth cursor animation" },
            bracketPairs:   { type: "bool",   default: true,
                              label: "Bracket pair colorization" },
            renderWhitespace: { type: "enum", default: "none",
                              options: [{value: "none", label: "None"}, {value: "boundary", label: "Boundary"}, {value: "all", label: "All"}],
                              label: "Render whitespace" },
            formatOnSave:   { type: "bool",   default: false,
                              label: "Format on save", hint: "Run the Volt formatter when you save." },
        },
    },
    build: {
        label: "Build & Toolchain",
        items: {
            defaultChip:    { type: "enum",   default: "esp32",
                              options: [
                                  {value: "esp32",     label: "ESP32"},
                                  {value: "esp8266",   label: "ESP8266"},
                                  {value: "rp2040",    label: "RP2040 / Pico"},
                                  {value: "stm32f103", label: "STM32 Blue Pill"},
                              ],
                              label: "Default chip for new projects" },
            verboseBuild:   { type: "bool",   default: false,
                              label: "Verbose build output", hint: "Show every compiler/linker line." },
            autoFlash:      { type: "bool",   default: true,
                              label: "Flash automatically after build" },
            espIdfPath:     { type: "path",   default: "",
                              label: "ESP-IDF path", hint: "Empty = auto-detect (~/esp/esp-idf or $IDF_PATH)." },
            picoSdkPath:    { type: "path",   default: "",
                              label: "Pico SDK path", hint: "Empty = auto-detect (~/pico/pico-sdk or $PICO_SDK_PATH)." },
        },
    },
    serial: {
        label: "Serial Monitor",
        items: {
            defaultBaud:    { type: "enum",   default: 115200,
                              options: [9600,19200,38400,57600,74880,115200,230400,460800,921600].map(b => ({value: b, label: String(b)})),
                              label: "Default baud rate" },
            lineEnding:     { type: "enum",   default: "lf",
                              options: [{value: "lf", label: "LF (\\n)"}, {value: "cr", label: "CR (\\r)"}, {value: "crlf", label: "CRLF (\\r\\n)"}],
                              label: "Line ending" },
            autoScroll:     { type: "bool",   default: true,
                              label: "Auto-scroll" },
            showTimestamps: { type: "bool",   default: true,
                              label: "Show timestamps" },
        },
    },
    diagnostics: {
        label: "Diagnostics",
        items: {
            debounceMs:     { type: "int",    default: 250,    min: 100, max: 1000, step: 50,
                              label: "Debounce delay (ms)",
                              hint: "How long to wait after you stop typing before re-checking." },
            showWarnings:   { type: "bool",   default: true,   label: "Show warnings" },
            showInfo:       { type: "bool",   default: true,   label: "Show info diagnostics" },
        },
    },
    projects: {
        label: "Projects",
        items: {
            projectsDir:    { type: "path",   default: "",
                              label: "Default projects folder",
                              hint: "Empty = ~/Volt. Used by New Project and Open Project." },
            recentMax:      { type: "int",    default: 20,    min: 5, max: 100, step: 5,
                              label: "Recent projects to remember" },
        },
    },
    appearance: {
        label: "Appearance",
        items: {
            reduceMotion:   { type: "bool",   default: false,
                              label: "Reduce motion",
                              hint: "Disable transitions and animations (overrides OS setting too)." },
        },
    },
};

// Flatten schema into a defaults object: { "editor.fontSize": 14, ... }
function flattenDefaults() {
    const out = {};
    for (const [cat, group] of Object.entries(SCHEMA)) {
        for (const [name, def] of Object.entries(group.items)) {
            out[`${cat}.${name}`] = def.default;
        }
    }
    return out;
}

const DEFAULTS = flattenDefaults();
let cached = null;

function load() {
    if (cached) return cached;
    let stored = {};
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
        }
    } catch (_) {
        stored = {};
    }
    // Merge defaults with stored values; ignore unknown keys
    cached = {};
    for (const key of Object.keys(DEFAULTS)) {
        cached[key] = (stored && key in stored) ? stored[key] : DEFAULTS[key];
    }
    return cached;
}

function save() {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cached, null, 2));
}

function get(key) {
    return load()[key];
}

function set(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
    load()[key] = value;
    save();
    return cached[key];
}

function all() {
    return { ...load() };
}

function reset() {
    cached = { ...DEFAULTS };
    save();
    return all();
}

function file() {
    return SETTINGS_FILE;
}

module.exports = { SCHEMA, DEFAULTS, load, save, get, set, all, reset, file };
