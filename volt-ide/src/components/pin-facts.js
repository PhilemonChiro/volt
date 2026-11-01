// Pin facts shared by the editor (completion / hover) and the Hardware
// panel: which modes a GPIO can do, how safe it is to wire, and which free
// pins to suggest first. The facts come from the compiler (pin_table op).

import * as chipSelector from "./chip-selector.js";

export const MODES = [
    { mode: "Output",        needs: "output",   doc: "Digital output (on/off)" },
    { mode: "Input",         needs: null,       doc: "Digital input, floating" },
    { mode: "PullUpInput",   needs: "pullup",   doc: "Input with internal pull-up (buttons to GND)" },
    { mode: "PullDownInput", needs: "pulldown", doc: "Input with internal pull-down" },
    { mode: "Analog",        needs: "analog",   doc: "ADC input (0-4095)" },
    { mode: "PWM",           needs: "pwm",      doc: "PWM output (dimming, motor speed)" },
    { mode: "Servo",         needs: "pwm",      doc: "Hobby servo (50 Hz PWM)" },
    { mode: "DAC",           needs: "dac",      doc: "True analog output" },
    { mode: "Touch",         needs: "touch",    doc: "Capacitive touch sensor" },
];

const _tables = {};
export function chip() {
    return (chipSelector.getChip() || "esp32").toLowerCase();
}
// [{ gpio, caps, safety: safe|caution|risky|unavailable, reason, notes }]
export function pinTable() {
    const c = chip();
    if (!_tables[c]) _tables[c] = window.volt.pinTable(c).then(t => t || []).catch(() => []);
    return _tables[c];
}

export function supportsMode(info, mode) {
    const has = c => info.caps.includes(c);
    if (info.safety === "unavailable") return false;
    switch (mode) {
        case "": case "Output": return has("output");
        case "PWM": case "Servo": return has("pwm");
        case "DAC": return has("dac");
        case "Analog": return has("analog");
        case "Touch": return has("touch");
        case "PullUpInput": case "InputPullUp": return has("pullup");
        case "PullDownInput": case "InputPullDown": return has("pulldown");
    }
    return true;
}

// GPIOs claimed by the hardware block, except on line `skip`.
export function takenGpios(hw, skip) {
    const taken = new Set();
    for (const p of hw.pins) if (p.line !== skip) taken.add(p.gpio);
    for (const a of Object.values(hw.pinByGpio)) if (a.line !== skip) taken.add(a.gpio);
    return taken;
}

// Free pins that can do `mode`: safe, then caution, then risky; for input
// modes input-only pins first so output-capable pins stay free (the same
// order the compiler's quick fixes use).
export function rankFreePins(table, mode, taken) {
    const inputish = mode === "Input" || mode === "Analog";
    const tier = i => i.safety === "safe" ? (inputish && !i.caps.includes("output") ? 0 : 1)
        : i.safety === "caution" ? 2 : 3;
    return table
        .filter(i => !taken.has(String(i.gpio)) && supportsMode(i, mode))
        .sort((a, b) => tier(a) - tier(b) || a.gpio - b.gpio);
}

export function tagFor(info) {
    if (info.safety === "safe") return "free";
    return info.safety === "risky" ? info.reason + " (risky)" : info.reason;
}

// Suggested pins for a new bus: { i2c: { sda, scl }, spi: {...}, uart: {...} }.
const _busPins = {}, _busPinsNow = {};
export function busPins() {
    const c = chip();
    if (!_busPins[c]) _busPins[c] = window.volt.busPins(c).then(t => t || {}).catch(() => ({}))
        .then(t => (_busPinsNow[c] = t));
    return _busPins[c];
}
// Synchronous view for the source parser (implicit buses use these pins);
// null until busPins() has resolved for the current chip.
export function busPinsNow() {
    return _busPinsNow[chip()] || null;
}

// Device facts by lower-cased type: { iface, pins, params, addr }. The
// parser needs them to tell pins from params and to place implicit buses.
let _devFacts = null, _devFactsNow = null;
export function deviceFacts() {
    if (!_devFacts) _devFacts = window.volt.devicesList().catch(() => []).then(list => {
        const m = {};
        for (const d of list || []) {
            if (!d || !d.name) continue;
            m[d.name.toLowerCase()] = { iface: (d.interface || "i2c").toLowerCase(), pins: d.pins || {},
                params: d.params || {}, addr: d.default_address || "" };
        }
        return (_devFactsNow = m);
    });
    return _devFacts;
}
export function deviceFactsNow() {
    return _devFactsNow;
}

// Signals per bus type; `out` = the signal drives the line (needs an output).
export const BUS_SIGNALS = {
    i2c:  [{ role: "sda", out: true }, { role: "scl", out: true }],
    spi:  [{ role: "mosi", out: true }, { role: "miso", out: false }, { role: "clk", out: true }],
    uart: [{ role: "tx", out: true }, { role: "rx", out: false }],
};
export const SIGNAL_NAMES = ["sda", "scl", "mosi", "miso", "clk", "sck", "cs", "tx", "rx"];
