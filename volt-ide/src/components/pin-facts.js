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
    return info.safety === "risky" ? info.reason + " ⚠" : info.reason;
}
