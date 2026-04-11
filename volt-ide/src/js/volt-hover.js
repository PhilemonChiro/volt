/**
 * Volt hover tooltips for CodeMirror 6
 */

import { hoverTooltip } from "@codemirror/view";
import { HOVER_DOCS } from "./volt-completions.js";

export const voltHover = hoverTooltip((view, pos) => {
    const { from, to, text, number: lineNumber } = view.state.doc.lineAt(pos);
    const lineText = text;

    // Decide positioning: show below if near the top of the editor
    const coords = view.coordsAtPos(pos);
    const editorTop = view.dom.getBoundingClientRect().top;
    const showAbove = coords ? (coords.top - editorTop > 80) : false;

    // Find the word under cursor
    let start = pos - from;
    let end = pos - from;

    while (start > 0 && /\w/.test(lineText[start - 1])) start--;
    while (end < lineText.length && /\w/.test(lineText[end])) end++;

    const word = lineText.slice(start, end);
    if (!word) return null;

    // Check if it's a known keyword/builtin
    const doc = HOVER_DOCS[word];
    if (doc) {
        return {
            pos: from + start,
            end: from + end,
            above: showAbove,
            create() {
                const dom = document.createElement("div");
                dom.className = "volt-tooltip";
                dom.textContent = doc;
                return { dom };
            },
        };
    }

    // Check for GPIO numbers (show pin info)
    if (/^\d+$/.test(word)) {
        const gpio = parseInt(word);
        const pinMatch = lineText.match(/pin\s+\w+:\s*\w+\s*=\s*/);
        if (pinMatch) {
            // It's a pin assignment — show GPIO info
            const info = getPinInfo(gpio);
            if (info) {
                return {
                    pos: from + start,
                    end: from + end,
                    above: showAbove,
                    create() {
                        const dom = document.createElement("div");
                        dom.className = "volt-tooltip";
                        dom.textContent = info;
                        return { dom };
                    },
                };
            }
        }
    }

    // Check for GP-prefixed pins (RP2040)
    if (/^GP\d+$/i.test(word)) {
        const gpio = parseInt(word.slice(2));
        const info = `RP2040 GPIO ${gpio}`;
        return {
            pos: from + start,
            end: from + end,
            above: showAbove,
            create() {
                const dom = document.createElement("div");
                dom.className = "volt-tooltip";
                dom.textContent = info;
                return { dom };
            },
        };
    }

    // Duration literals
    const durMatch = lineText.slice(start).match(/^(\d+)(ms|seconds|s)\b/);
    if (durMatch) {
        const val = parseInt(durMatch[1]);
        const unit = durMatch[2];
        const ms = unit === "ms" ? val : val * 1000;
        const hz = ms > 0 ? (1000 / ms).toFixed(1) : "∞";
        return {
            pos: from + start,
            end: from + start + durMatch[0].length,
            above: showAbove,
            create() {
                const dom = document.createElement("div");
                dom.className = "volt-tooltip";
                dom.textContent = `${ms}ms = ${hz} Hz`;
                return { dom };
            },
        };
    }

    return null;
});

// Basic ESP32 pin info (extend for other chips)
function getPinInfo(gpio) {
    const esp32 = {
        0: "Strapping pin — must be HIGH at boot. ADC2_CH1.",
        1: "UART0 TX — used for serial output.",
        2: "Strapping pin, onboard LED on many boards. ADC2_CH2.",
        3: "UART0 RX — used for serial input.",
        4: "General purpose. ADC2_CH0, Touch T0.",
        5: "Strapping pin. SPI CS.",
        6: "⚠ FLASH — connected to SPI flash, DO NOT USE.",
        7: "⚠ FLASH — connected to SPI flash, DO NOT USE.",
        8: "⚠ FLASH — connected to SPI flash, DO NOT USE.",
        9: "⚠ FLASH — connected to SPI flash, DO NOT USE.",
        10: "⚠ FLASH — connected to SPI flash, DO NOT USE.",
        11: "⚠ FLASH — connected to SPI flash, DO NOT USE.",
        12: "Strapping pin — controls flash voltage. JTAG TDI.",
        13: "JTAG TCK. ADC2_CH4.",
        14: "JTAG TMS. HSPI CLK. ADC2_CH6.",
        15: "Strapping pin. JTAG TDO. HSPI CS.",
        21: "I2C SDA (default).",
        22: "I2C SCL (default).",
        23: "VSPI MOSI.",
        25: "DAC channel 1. ADC2_CH8.",
        26: "DAC channel 2. ADC2_CH9.",
        32: "ADC1_CH4. Touch T9. 32kHz crystal.",
        33: "ADC1_CH5. Touch T8. 32kHz crystal.",
        34: "Input only — no output, no pull-up. ADC1_CH6.",
        35: "Input only — no output, no pull-up. ADC1_CH7.",
        36: "Input only. ADC1_CH0. ⚠ Interrupt errata.",
        39: "Input only. ADC1_CH3. ⚠ Interrupt errata.",
    };
    return esp32[gpio] ? `GPIO ${gpio}: ${esp32[gpio]}` : null;
}
