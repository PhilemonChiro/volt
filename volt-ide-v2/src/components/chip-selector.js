// Chip badge — shows target board from volt.toml (read-only)

import { readFile } from "../services/projects.js";

let currentChip = "esp32";

const LABELS = {
    esp32: "ESP32", rp2040: "RP2040", esp8266: "ESP8266",
    stm32f103: "STM32", stm32: "STM32", pico: "RP2040",
};

export function init() {}

export async function loadFromProject(projectPath) {
    const tomlPath = projectPath + "/volt.toml";
    try {
        const toml = await readFile(tomlPath);
        const m = toml.match(/chip\s*=\s*"([^"]+)"/);
        if (m) currentChip = m[1];
    } catch (_) {
        currentChip = "esp32";
    }
    updateLabel();
}

export function getChip() {
    return currentChip;
}

export function reset() {
    currentChip = "esp32";
    updateLabel();
}

function updateLabel() {
    const el = document.getElementById("chipLabel");
    if (el) el.textContent = LABELS[currentChip.toLowerCase()] || currentChip.toUpperCase();
}
