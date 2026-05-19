// New Project Wizard — 3-step: Board → Template → Name

import { createProject } from "../services/projects.js";

const BOARDS = [
    { id: "esp32", label: "ESP32", desc: "WiFi + BLE, 520KB RAM" },
    { id: "rp2040", label: "RP2040 Pico", desc: "Dual-core ARM, 264KB" },
    { id: "esp8266", label: "ESP8266", desc: "WiFi, 80KB RAM" },
    { id: "stm32f103", label: "STM32 Blue Pill", desc: "Cortex-M3, 20KB" },
];

const TEMPLATES = [
    { id: "blink", label: "Blink", desc: "LED toggle every 500ms" },
    { id: "iot-sensor", label: "IoT Sensor", desc: "WiFi + MQTT + sensor" },
    { id: "door-lock", label: "Door Lock", desc: "State machine + keypad" },
    { id: "empty", label: "Empty", desc: "Blank project" },
];

export function show(onCreated) {
    // Remove existing wizard
    const old = document.getElementById("wizardOverlay");
    if (old) old.remove();

    const state = { step: 1, chip: "esp32", template: "blink" };

    const overlay = document.createElement("div");
    overlay.id = "wizardOverlay";
    overlay.className = "overlay";
    document.body.appendChild(overlay);

    function render() {
        const titles = { 1: "Select Board", 2: "Choose Template", 3: "Name Your Project" };
        const nextLabel = state.step === 3 ? "Create" : "Next";

        let cards = "";
        if (state.step === 1) {
            cards = BOARDS.map(b =>
                `<button class="wiz-card ${b.id === state.chip ? 'active' : ''}" data-val="${b.id}">
                    <strong>${b.label}</strong><small>${b.desc}</small>
                </button>`
            ).join("");
        } else if (state.step === 2) {
            cards = TEMPLATES.map(t =>
                `<button class="wiz-card ${t.id === state.template ? 'active' : ''}" data-val="${t.id}">
                    <strong>${t.label}</strong><small>${t.desc}</small>
                </button>`
            ).join("");
        }

        const body = state.step <= 2
            ? `<div class="wiz-grid">${cards}</div>`
            : `<input type="text" class="wiz-input" id="wizNameInput" placeholder="my-project" autofocus>`;

        overlay.innerHTML = `
            <div class="wizard-dialog">
                <div class="wizard-header">
                    <span>${titles[state.step]}</span>
                    <button class="wizard-close" id="wizClose">&times;</button>
                </div>
                <div class="wizard-body">${body}</div>
                <div class="wizard-footer">
                    ${state.step > 1 ? '<button class="wiz-btn" id="wizBack">Back</button>' : '<div></div>'}
                    <button class="wiz-btn wiz-btn-primary" id="wizNext">${nextLabel}</button>
                </div>
            </div>
        `;

        // Events
        overlay.querySelector("#wizClose").onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        // Card selection
        overlay.querySelectorAll(".wiz-card").forEach(card => {
            card.onclick = () => {
                overlay.querySelectorAll(".wiz-card").forEach(c => c.classList.remove("active"));
                card.classList.add("active");
                if (state.step === 1) state.chip = card.dataset.val;
                else state.template = card.dataset.val;
            };
        });

        // Back
        const backBtn = overlay.querySelector("#wizBack");
        if (backBtn) backBtn.onclick = () => { state.step--; render(); };

        // Next / Create
        overlay.querySelector("#wizNext").onclick = async () => {
            if (state.step < 3) {
                state.step++;
                render();
            } else {
                const input = overlay.querySelector("#wizNameInput");
                const name = input ? input.value.trim() : "";
                if (!name) { if (input) input.focus(); return; }
                try {
                    const path = await createProject(name, state.chip);
                    overlay.remove();
                    if (path && onCreated) onCreated(path, state.chip);
                } catch (e) {
                    console.error("[wizard] create failed:", e);
                }
            }
        };

        // Enter key on name input
        if (state.step === 3) {
            setTimeout(() => {
                const input = overlay.querySelector("#wizNameInput");
                if (input) {
                    input.focus();
                    input.onkeydown = (e) => {
                        if (e.key === "Enter") overlay.querySelector("#wizNext").click();
                        if (e.key === "Escape") overlay.remove();
                    };
                }
            }, 50);
        }
    }

    render();
}
