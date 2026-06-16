// Welcome screen — shown when no project is open

import { listProjects } from "../services/projects.js";

const api = window.volt;

export function init(container, { onNew, onOpen, onOpenRecent }) {
    container.innerHTML = `
        <div class="welcome-stage">
            <img src="assets/volt-logo.svg" class="welcome-logo" alt="">
            <h1 class="welcome-title">Volt</h1>
            <p class="welcome-subtitle">Declare hardware. Write logic. Flash.</p>

            <div class="welcome-actions">
                <button class="welcome-btn primary" id="welcomeNewBtn">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    New Project
                </button>
                <button class="welcome-btn" id="welcomeOpenBtn">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                    Open Project
                </button>
            </div>

            <div id="recentProjects" class="welcome-recents"></div>

            <div class="welcome-quickstart" id="welcomeQuickstart">
                <div class="welcome-section-label">Quick Start</div>
                <div class="welcome-onboarding-cards">
                    <a class="onboarding-card" href="#" data-doc="GETTING_STARTED.md">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        <span class="onboarding-card-title">Getting Started</span>
                        <span class="onboarding-card-desc">Blink an LED from scratch — 5 minutes</span>
                    </a>
                    <a class="onboarding-card" href="#" data-doc="LANGUAGE_QUICK_REFERENCE.md">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                        <span class="onboarding-card-title">Quick Reference</span>
                        <span class="onboarding-card-desc">All syntax in one page</span>
                    </a>
                    <a class="onboarding-card" href="#" data-doc="TROUBLESHOOTING.md">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        <span class="onboarding-card-title">Troubleshooting</span>
                        <span class="onboarding-card-desc">Fix common errors fast</span>
                    </a>
                </div>
            </div>

            <div class="welcome-examples" id="welcomeExamples">
                <div class="welcome-section-label">Example Projects</div>
                <div class="welcome-examples-list" id="exampleList"></div>
            </div>

            <div class="welcome-hints">
                <span><kbd>⌃N</kbd>New</span>
                <span><kbd>⌃O</kbd>Open</span>
                <span><kbd>⌃R</kbd>Run</span>
            </div>
        </div>
    `;

    document.getElementById("welcomeNewBtn").onclick = onNew;
    document.getElementById("welcomeOpenBtn").onclick = onOpen;

    // Wire doc links to open in browser
    document.querySelectorAll(".onboarding-card").forEach(card => {
        card.onclick = (e) => {
            e.preventDefault();
            const doc = card.dataset.doc;
            if (api && api.openExternal) {
                api.openExternal("https://volt.dev/docs/" + doc);
            }
        };
    });

    loadRecent(onOpenRecent);
    loadExamples(onOpenRecent);
}

async function loadRecent(onOpenRecent) {
    try {
        const projects = await listProjects();
        const el = document.getElementById("recentProjects");
        if (!el || !projects.length) return;

        el.innerHTML = `
            <div class="welcome-recents-label">Recent</div>
            <div class="welcome-recents-list">
                ${projects.slice(0, 6).map(p => {
                    const shortPath = p.path
                        .replace(/^\/home\/[^/]+/, "~")
                        .replace(/^\/Users\/[^/]+/, "~")
                        .replace(/^C:\\Users\\[^\\]+/i, "~");
                    return `
                    <div class="recent-item" data-path="${p.path}" tabindex="0" role="button">
                        <div class="recent-item-main">
                            <span class="recent-item-name">${p.name}</span>
                            <span class="recent-item-path">${shortPath}</span>
                        </div>
                        <span class="recent-item-chip">${p.chip.toUpperCase()}</span>
                    </div>`;
                }).join("")}
            </div>
        `;

        el.querySelectorAll(".recent-item").forEach(item => {
            const open = () => onOpenRecent(item.dataset.path);
            item.onclick = open;
            item.onkeydown = (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
            };
        });
    } catch (e) {
        console.warn("[welcome] failed to load recent:", e);
    }
}

async function loadExamples(onOpenExample) {
    try {
        const examples = [
            { name: "Blink", chip: "esp32", desc: "Three LEDs at different rates", file: "examples/01-blink/main.volt" },
            { name: "IoT Sensor", chip: "esp32", desc: "WiFi + MQTT + battery monitor", file: "examples/02-iot-sensor/main.volt" },
            { name: "State Blink", chip: "esp32", desc: "LED blink via state machine", file: "examples/03-state-blink/main.volt" },
            { name: "Multi State", chip: "esp32", desc: "Multiple state machines + tasks", file: "examples/04-multi-state/main.volt" },
            { name: "Door Lock", chip: "esp32", desc: "State machine + MQTT + storage", file: "examples/door-lock/main.volt" },
            { name: "Safe Boot", chip: "esp32", desc: "Try blocks, error recovery", file: "examples/07-safe-boot/main.volt" },
            { name: "Smart LED", chip: "rp2040", desc: "PWM + channels + shared vars", file: "examples/smart-led/main.volt" },
            { name: "Weather Station", chip: "esp32", desc: "ADC + storage + deep sleep", file: "examples/weather-station/main.volt" },
        ];

        const el = document.getElementById("exampleList");
        if (!el) return;

        el.innerHTML = examples.map(ex => `
            <div class="example-item" data-file="${ex.file}" tabindex="0" role="button">
                <div class="example-item-main">
                    <span class="example-item-name">${ex.name}</span>
                    <span class="example-item-desc">${ex.desc}</span>
                </div>
                <span class="example-item-chip">${ex.chip.toUpperCase()}</span>
            </div>
        `).join("");

        el.querySelectorAll(".example-item").forEach(item => {
            const open = () => {
                const file = item.dataset.file;
                // Read the example file and create a temp project
                import("../services/projects.js").then(async (proj) => {
                    try {
                        const content = await api.readFile(file);
                        if (content) {
                            // Show in editor as unsaved scratch
                            const editor = await import("./editor.js");
                            // Use a virtual path to display in editor
                            onOpenExample(file);
                        }
                    } catch (e) {
                        console.warn("[welcome] failed to load example:", e);
                    }
                });
            };
            item.onclick = open;
            item.onkeydown = (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
            };
        });
    } catch (e) {
        console.warn("[welcome] failed to load examples:", e);
    }
}
