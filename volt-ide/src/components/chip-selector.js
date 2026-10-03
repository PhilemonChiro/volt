// Chip badge — shows target board from volt.toml (read-only)

import { readFile, saveFile } from "../services/projects.js";

let currentChip = "esp32";
let currentBoard = "";      // volt.toml `board` — which dev board drawing to show ("" = chip default)
let tomlPathCur = "";
let onChipChange = null;

const LABELS = {
    esp32: "ESP32", rp2040: "RP2040", esp8266: "ESP8266",
    stm32f103: "STM32", stm32: "STM32", pico: "RP2040",
};

export function init(callback) {
    onChipChange = callback || null;
}

export async function loadFromProject(projectPath) {
    const sep = projectPath.includes("\\") && !projectPath.includes("/") ? "\\" : "/";
    const tomlPath = projectPath.replace(/[/\\]$/, "") + sep + "volt.toml";
    const prev = currentChip;
    tomlPathCur = tomlPath;
    currentBoard = "";
    try {
        const toml = await readFile(tomlPath);
        const m = toml.match(/chip\s*=\s*"([^"]+)"/);
        if (m) currentChip = m[1];
        const b = toml.match(/^\s*board\s*=\s*"([^"]*)"/m);
        if (b) currentBoard = b[1];
    } catch (_) {
        currentChip = "esp32";
    }
    updateLabel();
    // Fire callback if chip actually changed
    if (onChipChange && prev !== currentChip) onChipChange(currentChip);
}

export function getChip() {
    return currentChip;
}

export function getBoard() {
    return currentBoard;
}

// Persist the board choice as `board = "…"` in volt.toml (the CLI ignores it;
// it only picks the pinout drawing).
export async function setBoard(id) {
    currentBoard = id || "";
    if (!tomlPathCur) return;
    let toml = "";
    try { toml = await readFile(tomlPathCur); } catch (_) { return; }
    const line = `board = "${currentBoard}"`;
    toml = /^\s*board\s*=.*$/m.test(toml)
        ? toml.replace(/^\s*board\s*=.*$/m, line)
        : toml.replace(/^(\s*chip\s*=.*)$/m, `$1\n${line}`);
    await saveFile(tomlPathCur, toml);
}

export function reset() {
    currentChip = "esp32";
    updateLabel();
}

function updateLabel() {
    const el = document.getElementById("chipLabel");
    if (el) el.textContent = LABELS[currentChip.toLowerCase()] || currentChip.toUpperCase();
}
