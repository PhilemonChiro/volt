// New Project Wizard — 3-step: Board → Template → Name

import { createProject } from "../services/projects.js";
import * as settings from "../services/settings.js";

const BOARDS = [
    { id: "esp32", label: "ESP32", desc: "WiFi + BLE, 520KB RAM" },
    { id: "rp2040", label: "RP2040 Pico", desc: "Dual-core ARM, 264KB" },
    { id: "esp8266", label: "ESP8266", desc: "WiFi, 80KB RAM" },
    { id: "stm32f103", label: "STM32 Blue Pill", desc: "Cortex-M3, 20KB" },
];

const TEMPLATES = [
    { id: "blink", label: "Blink", desc: "LED toggle every 500ms", code: "every 500ms { led.toggle() }" },
    { id: "iot-sensor", label: "IoT Sensor", desc: "WiFi + MQTT + sensor", code: "wifi.connect() / mqtt.send()" },
    { id: "door-lock", label: "Door Lock", desc: "State machine + keypad", code: "machine door_lock { ... }" },
    { id: "empty", label: "Empty", desc: "Blank project", code: "// start from scratch" },
];

const TOTAL_STEPS = 3;

export function show(onCreated) {
    const old = document.getElementById("wizardOverlay");
    if (old) old.remove();

    const defChip = settings.get("build.defaultChip", "esp32");
    const state = { step: 1, chip: BOARDS.some(c => c.id === defChip) ? defChip : "esp32", template: "blink" };
    let dir = "forward";

    const overlay = document.createElement("div");
    overlay.id = "wizardOverlay";
    overlay.className = "overlay";
    document.body.appendChild(overlay);

    function close() {
        overlay.classList.add("is-closing");
        setTimeout(() => overlay.remove(), 180);
    }

    function dots() {
        let html = `<div class="wizard-dots">`;
        for (let i = 1; i <= TOTAL_STEPS; i++) {
            const cls = i === state.step ? "is-current"
                : i < state.step ? "is-done" : "";
            html += `<span class="wizard-dot ${cls}"></span>`;
        }
        return html + `</div>`;
    }

    function render() {
        const titles = { 1: "Select Board", 2: "Choose Template", 3: "Name Your Project" };
        const nextLabel = state.step === TOTAL_STEPS ? "Create Project" : "Continue";

        let body = "";
        if (state.step === 1) {
            const cards = BOARDS.map(b =>
                `<button class="wiz-card ${b.id === state.chip ? 'active' : ''}" data-val="${b.id}">
                    <strong>${b.label}</strong><small>${b.desc}</small>
                </button>`
            ).join("");
            body = `<div class="wiz-grid">${cards}</div>`;
        } else if (state.step === 2) {
            const cards = TEMPLATES.map(t =>
                `<button class="wiz-card ${t.id === state.template ? 'active' : ''}" data-val="${t.id}">
                    <strong>${t.label}</strong><small>${t.desc}</small>
                    <code class="wiz-card-preview">${t.code}</code>
                </button>`
            ).join("");
            body = `<div class="wiz-grid">${cards}</div>`;
        } else {
            body = `
                <div class="wiz-name-info">
                    Will be created in ~/Volt/<strong>${esc(state.name || "my-project")}</strong>
                </div>
                <input type="text" class="wiz-input" id="wizNameInput" placeholder="my-project" autofocus>
            `;
        }

        overlay.innerHTML = `
            <div class="wizard-dialog">
                <div class="wizard-header">
                    <span>${titles[state.step]}</span>
                    <button class="wizard-close" id="wizClose" aria-label="Close">&times;</button>
                </div>
                <div class="wizard-body" data-dir="${dir}" data-step="${state.step}">${body}</div>
                <div class="wizard-footer">
                    ${state.step > 1
                        ? '<button class="wiz-btn" id="wizBack">Back</button>'
                        : '<div></div>'}
                    ${dots()}
                    <button class="wiz-btn wiz-btn-primary" id="wizNext">${nextLabel}</button>
                </div>
            </div>
        `;

        overlay.querySelector("#wizClose").onclick = close;
        overlay.onclick = (e) => { if (e.target === overlay) close(); };

        overlay.querySelectorAll(".wiz-card").forEach(card => {
            card.onclick = () => {
                overlay.querySelectorAll(".wiz-card").forEach(c => c.classList.remove("active"));
                card.classList.add("active");
                if (state.step === 1) state.chip = card.dataset.val;
                else state.template = card.dataset.val;
            };
        });

        const backBtn = overlay.querySelector("#wizBack");
        if (backBtn) backBtn.onclick = () => { dir = "back"; state.step--; render(); };

        overlay.querySelector("#wizNext").onclick = async () => {
            if (state.step < TOTAL_STEPS) {
                dir = "forward";
                state.step++;
                render();
            } else {
                const input = overlay.querySelector("#wizNameInput");
                const name = input ? input.value.trim() : "";
                if (!name) { if (input) input.focus(); return; }
                state.name = name;
                try {
                    const path = await createProject(name, state.chip, state.template);
                    close();
                    if (path && onCreated) onCreated(path, state.chip);
                } catch (e) {
                    console.error("[wizard] create failed:", e);
                }
            }
        };

        if (state.step === TOTAL_STEPS) {
            setTimeout(() => {
                const input = overlay.querySelector("#wizNameInput");
                if (input) {
                    input.focus();
                    input.onkeydown = (e) => {
                        if (e.key === "Enter") overlay.querySelector("#wizNext").click();
                        if (e.key === "Escape") close();
                    };
                }
            }, 50);
        }
    }

    render();
}

function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
