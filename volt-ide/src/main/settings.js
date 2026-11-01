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
            askOnSelect:    { type: "bool",   default: true,
                              label: "Show Ask AI when selecting code", hint: "A small ✦ Ask button appears beside code you select (or press ⌘I / Ctrl+I)." },
        },
    },
    registry: {
        label: "Registry (Grid)",
        items: {
            gridUrl: { type: "string", default: "http://127.0.0.1:8080",
                       label: "Grid URL", hint: "Base URL of the Volt library registry (Grid) that Fuse installs signed Cells from." },
        },
    },
    // Drawn by components/ai-settings.js (one card per agent), not as rows.
    assistant: {
        label: "AI agents",
        custom: true,
        items: {
            provider:   { type: "enum", default: "claude", options: [{value: "claude"}, {value: "codex"}] },
            model:      { type: "enum", default: "sonnet", options: [{value: "sonnet"}, {value: "opus"}] },
            claudePath: { type: "path", default: "" },
            codexModel: { type: "string", default: "" },
            codexPath:  { type: "path", default: "" },
        },
    },
    agentPermissions: require("./agent-policy").SETTINGS,
    // The GitHub panel's OAuth app (device flow); set until it is built in.
    github: {
        label: "GitHub",
        items: {
            clientId: { type: "string", default: "", hidden: true },
        },
    },
    build: {
        label: "Build & Toolchain",
        items: {
            defaultChip:    { type: "enum",   default: "esp32",
                              options: [
                                  {value: "esp32",     label: "ESP32"},
                              ],
                              label: "Default chip for new projects" },
            verboseBuild:   { type: "bool",   default: false,
                              label: "Verbose build output", hint: "Show every compiler/linker line." },
            toolchainSource:{ type: "enum",   default: "auto",
                              options: [
                                  {value: "auto",     label: "Auto (Volt mirror, fall back to upstream)"},
                                  {value: "mirror",   label: "Volt mirror only"},
                                  {value: "upstream", label: "Upstream only (Arm, Espressif)"},
                              ],
                              label: "Toolchain download source",
                              hint: "Mirror = pinned, controlled versions from the Volt GitHub release. Upstream = official vendor sites." },
        },
    },
    serial: {
        label: "Serial Monitor",
        items: {
            defaultBaud:    { type: "enum",   default: 115200,
                              options: [9600,19200,38400,57600,74880,115200,230400,460800,921600].map(b => ({value: b, label: String(b)})),
                              label: "Default baud rate" },
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
            // Internal flag — tracks whether the first-run onboarding has been
            // seen. Hidden from the Settings UI; persisted so the wizard shows
            // once only. Must live in the schema or set()/get() reject it.
            onboardingDone: { type: "bool",   default: false, hidden: true,
                              label: "Onboarding completed" },
        },
    },
    advanced: {
        label: "Advanced",
        items: {
            showGeneratedC: { type: "bool",   default: false,
                              label: "Show Generated C tab",
                              hint: "Show the transpiled C output tab in the bottom panel." },
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
