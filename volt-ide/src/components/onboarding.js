// Onboarding — full-screen first-run wizard with micro-interactions
// Shows when the IDE is opened for the first time with no projects.

import { createProject } from "../services/projects.js";
import * as settings from "../services/settings.js";

const api = window.volt;

const CHIPS = [
    { id: "esp32",    label: "ESP32",       desc: "WiFi + BLE",          ram: "520KB", flash: "4MB" },
    { id: "rp2040",   label: "RP2040 Pico", desc: "Dual-core ARM",       ram: "264KB", flash: "2MB" },
    { id: "esp8266",  label: "ESP8266",     desc: "WiFi only",           ram: "80KB",  flash: "4MB" },
    { id: "stm32f103",label: "STM32 Blue Pill", desc: "Cortex-M3",       ram: "20KB",  flash: "64KB" },
];

const TEMPLATES = [
    { id: "blink",      label: "Blink",        desc: "Toggle an LED every 500ms",          icon: "blink" },
    { id: "iot-sensor", label: "IoT Sensor",   desc: "WiFi + MQTT + ADC sensor reading",  icon: "iot" },
    { id: "door-lock",  label: "Door Lock",    desc: "State machine + button + relay",     icon: "lock" },
    { id: "empty",      label: "Blank",        desc: "Start from scratch",                icon: "empty" },
];

// SVG sprites for template icons
const TEMPLATE_ICONS = {
    blink: `<svg viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="16" stroke="currentColor" stroke-width="1.5"/><path d="M20 8v24M8 20h24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="20" cy="20" r="4" fill="var(--volt)" opacity="0.6"/></svg>`,
    iot: `<svg viewBox="0 0 40 40" fill="none"><path d="M4 20a16 16 0 0 1 32 0" stroke="currentColor" stroke-width="1.5"/><circle cx="20" cy="20" r="8" stroke="currentColor" stroke-width="1.5"/><circle cx="20" cy="20" r="3" fill="var(--volt)" opacity="0.6"/><line x1="4" y1="24" x2="36" y2="24" stroke="currentColor" stroke-width="1" opacity="0.3"/></svg>`,
    lock: `<svg viewBox="0 0 40 40" fill="none"><rect x="10" y="18" width="20" height="16" rx="3" stroke="currentColor" stroke-width="1.5"/><path d="M14 18v-4a6 6 0 0 1 12 0v4" stroke="currentColor" stroke-width="1.5"/><circle cx="20" cy="26" r="3" fill="var(--volt)" opacity="0.6"/></svg>`,
    empty: `<svg viewBox="0 0 40 40" fill="none"><rect x="8" y="8" width="24" height="24" rx="3" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2"/><line x1="14" y1="16" x2="26" y2="16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="14" y1="21" x2="22" y2="21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="14" y1="26" x2="26" y2="26" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
};

const TOTAL_STEPS = 3;

let activeOverlay = null;

export function isFirstRun() {
    return !settings.get("appearance.onboardingDone", false);
}

export async function markComplete() {
    await settings.set("appearance.onboardingDone", true);
}

export function show(onComplete) {
    if (activeOverlay) return;
    const overlay = document.createElement("div");
    overlay.id = "onboardingOverlay";
    overlay.className = "onboarding-overlay";
    document.body.appendChild(overlay);
    activeOverlay = overlay;

    const state = {
        step: 1,
        chip: "esp32",
        template: "blink",
        name: "",
        dir: "forward",
        creating: false,
    };

    // Dismiss the overlay. Pass completeArgs (e.g. [path, chip]) to invoke
    // onComplete after the exit animation; omit it for a plain dismiss so we
    // never call onComplete with an undefined project path.
    function close(completeArgs) {
        overlay.classList.add("is-closing");
        setTimeout(() => {
            overlay.remove();
            activeOverlay = null;
            if (onComplete && completeArgs) onComplete(...completeArgs);
        }, 400);
    }

    function animateOut(cb) {
        const body = overlay.querySelector(".onboarding-body");
        if (body) {
            body.style.transition = "opacity 180ms ease, transform 180ms ease";
            body.style.opacity = "0";
            body.style.transform = "translateY(12px) scale(0.97)";
        }
        setTimeout(cb, 200);
    }

    function render() {
        const step = state.step;
        let content = "";

        if (step === 1) {
            content = renderStep1(state);
        } else if (step === 2) {
            content = renderStep2(state);
        } else {
            content = renderStep3(state);
        }

        overlay.innerHTML = `
            <div class="onboarding-backdrop"></div>
            <div class="onboarding-body" style="animation: onboarding-enter 400ms cubic-bezier(0.22,1,0.36,1) both">
                <div class="onboarding-progress">
                    ${renderDots(step)}
                </div>
                ${content}
            </div>
        `;

        // Wire events after DOM is built
        requestAnimationFrame(() => wireEvents(step, state, close, render, overlay, animateOut));
    }

    render();
}

function renderDots(step) {
    let html = "";
    for (let i = 1; i <= TOTAL_STEPS; i++) {
        const cls = i === step ? "is-current"
            : i < step ? "is-done" : "";
        html += `<span class="onboarding-dot ${cls}">
            ${i < step
                ? `<svg class="onboarding-dot-check" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><polyline points="2 6 5 9 10 3"/></svg>`
                : `<span class="onboarding-dot-num">${i}</span>`}
        </span>`;
    }
    return `<div class="onboarding-dots">${html}</div>
        <div class="onboarding-progress-track"><div class="onboarding-progress-fill" style="width:${((step-1)/(TOTAL_STEPS-1))*100}%"></div></div>`;
}

function renderStep1(state) {
    const chips = CHIPS.map(c => `
        <button class="onboarding-chip ${c.id === state.chip ? "active" : ""}" data-value="${c.id}">
            <div class="onboarding-chip-visual">
                <svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.2">
                    <rect x="6" y="6" width="20" height="20" rx="2"/>
                    <line x1="10" y1="2" x2="10" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="22" y1="2" x2="22" y2="6"/>
                    <line x1="10" y1="26" x2="10" y2="28"/><line x1="16" y1="26" x2="16" y2="28"/><line x1="22" y1="26" x2="22" y2="28"/>
                    <line x1="2" y1="10" x2="6" y2="10"/><line x1="2" y1="16" x2="6" y2="16"/><line x1="2" y1="22" x2="6" y2="22"/>
                    <line x1="26" y1="10" x2="30" y2="10"/><line x1="26" y1="16" x2="30" y2="16"/><line x1="26" y1="22" x2="30" y2="22"/>
                </svg>
            </div>
            <div class="onboarding-chip-info">
                <span class="onboarding-chip-label">${c.label}</span>
                <span class="onboarding-chip-desc">${c.desc}</span>
            </div>
            <div class="onboarding-chip-specs">
                <span class="onboarding-chip-spec">${c.ram}</span>
                <span class="onboarding-chip-spec">${c.flash}</span>
            </div>
            ${c.id === state.chip ? `<span class="onboarding-chip-check"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 8 6 11 13 4"/></svg></span>` : ""}
        </button>
    `).join("");

    return `
        <div class="onboarding-content">
            <div class="onboarding-header">
                <div class="onboarding-icon">🪄</div>
                <h1 class="onboarding-title">Let's build something.</h1>
                <p class="onboarding-subtitle">First, what chip are you targeting?</p>
            </div>
            <div class="onboarding-chip-grid">${chips}</div>
            <div class="onboarding-footer">
                <button class="onboarding-btn onboarding-btn-primary" id="onbNext">Continue</button>
            </div>
        </div>
    `;
}

function renderStep2(state) {
    const tpl = TEMPLATES.map(t => {
        const active = t.id === state.template;
        return `
        <button class="onboarding-template ${active ? "active" : ""}" data-value="${t.id}">
            <div class="onboarding-template-icon">${TEMPLATE_ICONS[t.icon] || TEMPLATE_ICONS.empty}</div>
            <div class="onboarding-template-info">
                <span class="onboarding-template-label">${t.label}</span>
                <span class="onboarding-template-desc">${t.desc}</span>
            </div>
            ${active ? `<span class="onboarding-chip-check"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 8 6 11 13 4"/></svg></span>` : ""}
        </button>`;
    }).join("");

    return `
        <div class="onboarding-content">
            <div class="onboarding-header">
                <div class="onboarding-icon">📦</div>
                <h1 class="onboarding-title">Pick a starting point.</h1>
                <p class="onboarding-subtitle">We'll generate boilerplate for you.</p>
            </div>
            <div class="onboarding-template-grid">${tpl}</div>
            <div class="onboarding-footer">
                <button class="onboarding-btn" id="onbBack">Back</button>
                <button class="onboarding-btn onboarding-btn-primary" id="onbNext">Continue</button>
            </div>
        </div>
    `;
}

function renderStep3(state) {
    return `
        <div class="onboarding-content">
            <div class="onboarding-header">
                <div class="onboarding-icon">🚀</div>
                <h1 class="onboarding-title">Name your project.</h1>
                <p class="onboarding-subtitle">It will be created in <strong>~/Volt/<span id="onbNamePreview">my-project</span></strong></p>
            </div>
            <div class="onboarding-name-wrap">
                <input type="text" class="onboarding-input" id="onbNameInput"
                    placeholder="my-project" value="${state.name}" autofocus
                    autocomplete="off" spellcheck="false">
                <div class="onboarding-summary">
                    <div class="onboarding-summary-row">
                        <span class="onboarding-summary-label">Board</span>
                        <span class="onboarding-summary-value">${CHIPS.find(c => c.id === state.chip)?.label || state.chip}</span>
                    </div>
                    <div class="onboarding-summary-row">
                        <span class="onboarding-summary-label">Template</span>
                        <span class="onboarding-summary-value">${TEMPLATES.find(t => t.id === state.template)?.label || state.template}</span>
                    </div>
                </div>
            </div>
            <div class="onboarding-footer">
                <button class="onboarding-btn" id="onbBack">Back</button>
                <button class="onboarding-btn onboarding-btn-primary" id="onbCreate">
                    <span class="onb-btn-text">Create Project</span>
                    <span class="onb-btn-spinner" style="display:none">
                        <svg viewBox="0 0 16 16" width="16" height="16" class="onboarding-spinner"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="30" stroke-linecap="round"/></svg>
                    </span>
                </button>
            </div>
        </div>
    `;
}

function wireEvents(step, state, close, render, overlay, animateOut) {
    // Chip selection
    if (step === 1) {
        overlay.querySelectorAll(".onboarding-chip").forEach(el => {
            el.onclick = () => {
                overlay.querySelectorAll(".onboarding-chip").forEach(c => c.classList.remove("active"));
                overlay.querySelectorAll(".onboarding-chip .onboarding-chip-check").forEach(c => c.remove());
                el.classList.add("active");
                state.chip = el.dataset.value;
                // Animate checkmark
                const check = document.createElement("span");
                check.className = "onboarding-chip-check";
                check.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 8 6 11 13 4"/></svg>';
                el.appendChild(check);
                // Subtle scale feedback
                el.style.transform = "scale(0.97)";
                setTimeout(() => el.style.transform = "", 120);
            };
        });
    }

    // Template selection
    if (step === 2) {
        overlay.querySelectorAll(".onboarding-template").forEach(el => {
            el.onclick = () => {
                overlay.querySelectorAll(".onboarding-template").forEach(c => c.classList.remove("active"));
                overlay.querySelectorAll(".onboarding-template .onboarding-chip-check").forEach(c => c.remove());
                el.classList.add("active");
                state.template = el.dataset.value;
                const check = document.createElement("span");
                check.className = "onboarding-chip-check";
                check.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 8 6 11 13 4"/></svg>';
                el.appendChild(check);
                el.style.transform = "scale(0.97)";
                setTimeout(() => el.style.transform = "", 120);
            };
        });
    }

    // Name input
    if (step === 3) {
        const input = overlay.querySelector("#onbNameInput");
        const preview = overlay.querySelector("#onbNamePreview");
        if (input && preview) {
            setTimeout(() => input.focus(), 100);
            input.oninput = () => {
                state.name = input.value.trim();
                preview.textContent = input.value.trim() || "my-project";
                preview.style.transition = "opacity 120ms ease";
                preview.style.opacity = "0.5";
                setTimeout(() => preview.style.opacity = "1", 120);
            };
            input.onkeydown = (e) => {
                if (e.key === "Enter") overlay.querySelector("#onbCreate").click();
                if (e.key === "Escape") close();
            };
        }
    }

    // Navigation
    const nextBtn = overlay.querySelector("#onbNext");
    if (nextBtn) {
        nextBtn.onclick = () => {
            state.step++;
            animateOut(render);
        };
    }

    const backBtn = overlay.querySelector("#onbBack");
    if (backBtn) {
        backBtn.onclick = () => {
            state.step--;
            animateOut(render);
        };
    }

    const createBtn = overlay.querySelector("#onbCreate");
    if (createBtn) {
        createBtn.onclick = async () => {
            const name = state.name || "my-project";
            const btnText = createBtn.querySelector(".onb-btn-text");
            const spinner = createBtn.querySelector(".onb-btn-spinner");
            if (btnText) btnText.textContent = "Creating...";
            if (spinner) spinner.style.display = "";
            createBtn.disabled = true;

            try {
                const path = await createProject(name, state.chip, state.template);
                // Celebration
                overlay.querySelector(".onboarding-content").innerHTML = `
                    <div class="onboarding-header" style="text-align:center;padding:40px 0">
                        <div style="font-size:48px;margin-bottom:16px;animation: onboarding-bounce 600ms cubic-bezier(0.34,1.4,0.64,1) both">🎉</div>
                        <h1 class="onboarding-title">Ready to go!</h1>
                        <p class="onboarding-subtitle">Project <strong>${name}</strong> created for ${CHIPS.find(c => c.id === state.chip)?.label || state.chip}.</p>
                        <div style="margin-top:24px;display:flex;gap:12px;justify-content:center">
                            <button class="onboarding-btn onboarding-btn-primary" id="onbFinish">
                                Open Project
                                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="margin-left:4px"><polyline points="6 3 11 8 6 13"/></svg>
                            </button>
                        </div>
                    </div>
                `;
                overlay.querySelector("#onbFinish").onclick = () => {
                    markComplete();
                    close([path, state.chip]);
                };
                // Confetti-like sparkles
                launchSparkles(overlay);
            } catch (e) {
                console.error("[onboarding] create failed:", e);
                if (btnText) btnText.textContent = "Create Project";
                if (spinner) spinner.style.display = "none";
                createBtn.disabled = false;
            }
        };
    }

    // Keyboard: Enter to advance
    overlay.onkeydown = (e) => {
        if (e.key === "Enter" && nextBtn && !createBtn) nextBtn.click();
    };
}

function launchSparkles(overlay) {
    const colors = ["var(--volt)", "#FFD700", "#FF6B6B", "#4ECDC4", "#A78BFA", "#F97316"];
    const body = overlay.querySelector(".onboarding-body");
    if (!body) return;
    const rect = body.getBoundingClientRect();
    for (let i = 0; i < 24; i++) {
        const sparkle = document.createElement("div");
        sparkle.className = "onboarding-sparkle";
        const x = rect.left + (rect.width * (0.1 + Math.random() * 0.8));
        const y = rect.top + rect.height * 0.3 + Math.random() * rect.height * 0.4;
        const color = colors[Math.floor(Math.random() * colors.length)];
        const size = 3 + Math.random() * 4;
        sparkle.style.cssText = `
            left:${x}px; top:${y}px; width:${size}px; height:${size}px;
            background:${color};
            --dx:${(Math.random() - 0.5) * 200}px;
            --dy:${-100 - Math.random() * 150}px;
            --dr:${Math.random() * 720}deg;
            animation: sparkle-fly 800ms cubic-bezier(0.22,1,0.36,1) ${i * 30}ms both;
        `;
        document.body.appendChild(sparkle);
        setTimeout(() => sparkle.remove(), 2000);
    }
}
