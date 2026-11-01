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
                <div class="welcome-drop">
                    <button class="welcome-btn" id="welcomeExamplesBtn" aria-haspopup="menu" aria-expanded="false">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>
                        Examples
                        <svg class="welcome-caret" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                    <div class="welcome-examples-menu" id="welcomeExamples" role="menu" hidden>
                        <div class="welcome-section-label">Example projects</div>
                        <div class="welcome-examples-list" id="exampleList"></div>
                    </div>
                </div>
            </div>

            <div class="welcome-lists" id="welcomeLists">
                <div class="welcome-col welcome-col-recent">
                    <div id="recentProjects" class="welcome-recents"></div>
                </div>
            </div>
        </div>
        <a class="welcome-credit" href="#" data-href="https://dl.espressif.com/dl/schematics/esp32_devkitc_v4-sch.pdf" title="Background: the ESP32-DevKitC V4 schematic">Schematic © Espressif Systems</a>
    `;

    document.getElementById("welcomeNewBtn").onclick = onNew;
    document.getElementById("welcomeOpenBtn").onclick = onOpen;
    container.querySelector(".welcome-credit").onclick = (e) => { e.preventDefault(); api.openExternal?.(e.currentTarget.dataset.href); };

    // Examples dropdown
    const exBtn = document.getElementById("welcomeExamplesBtn");
    const exMenu = document.getElementById("welcomeExamples");
    const items = () => [...exMenu.querySelectorAll(".example-item")];
    const setOpen = (on) => {
        exMenu.hidden = !on;
        exBtn.setAttribute("aria-expanded", String(on));
        exBtn.classList.toggle("is-open", on);
        if (on) items()[0]?.focus();
    };
    exBtn.onclick = (e) => { e.stopPropagation(); setOpen(exMenu.hidden); };
    exMenu.addEventListener("keydown", (e) => {
        const list = items(), i = list.indexOf(document.activeElement);
        if (e.key === "Escape") { e.preventDefault(); setOpen(false); exBtn.focus(); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            list[(i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus();
        }
    });
    document.addEventListener("mousedown", (e) => {
        if (!exMenu.hidden && !exMenu.contains(e.target) && !exBtn.contains(e.target)) setOpen(false);
    });

    loadRecent(onOpenRecent);
    loadExamples(onOpenRecent);
}

const RECENT_SHOWN = 6;

async function loadRecent(onOpenRecent) {
    try {
        const projects = await listProjects();
        const el = document.getElementById("recentProjects");
        if (!el) return;
        if (!projects.length) {
            // No recent projects yet — drop the empty left column so the
            // Examples list isn't stranded beside a blank half.
            document.getElementById("welcomeLists")?.classList.add("welcome-lists--solo");
            return;
        }

        el.innerHTML = `
            <div class="welcome-recents-label">Recent</div>
            <div class="welcome-recents-list">
                ${projects.map((p, i) => {
                    const shortPath = p.path
                        .replace(/^\/home\/[^/]+/, "~")
                        .replace(/^\/Users\/[^/]+/, "~")
                        .replace(/^C:\\Users\\[^\\]+/i, "~");
                    return `
                    <div class="recent-item${i >= RECENT_SHOWN ? " is-extra" : ""}" data-path="${p.path}" tabindex="0" role="button"${i >= RECENT_SHOWN ? " hidden" : ""}>
                        <div class="recent-item-main">
                            <span class="recent-item-name">${p.name}</span>
                            <span class="recent-item-path">${shortPath}</span>
                        </div>
                        <span class="recent-item-chip">${p.chip.toUpperCase()}</span>
                    </div>`;
                }).join("")}
            </div>
            ${projects.length > RECENT_SHOWN ? `<button type="button" class="welcome-more" aria-expanded="false">Show ${projects.length - RECENT_SHOWN} more</button>` : ""}
        `;

        const more = el.querySelector(".welcome-more");
        if (more) more.onclick = () => {
            const open = more.getAttribute("aria-expanded") !== "true";
            el.querySelectorAll(".recent-item.is-extra").forEach(it => { it.hidden = !open; });
            more.setAttribute("aria-expanded", String(open));
            more.textContent = open ? "Show less" : `Show ${projects.length - RECENT_SHOWN} more`;
            if (open) el.querySelector(".recent-item.is-extra")?.focus();
        };

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
            { name: "Blink", chip: "esp32", desc: "Three LEDs at different rates", dir: "01-blink" },
            { name: "IoT Sensor", chip: "esp32", desc: "WiFi + MQTT + battery monitor", dir: "02-iot-sensor" },
            { name: "State Blink", chip: "esp32", desc: "LED blink via state machine", dir: "03-state-blink" },
            { name: "Multi State", chip: "esp32", desc: "Multiple state machines + tasks", dir: "04-multi-state" },
            { name: "Door Lock", chip: "esp32", desc: "State machine + MQTT + storage", dir: "door-lock" },
            { name: "Safe Boot", chip: "esp32", desc: "Try blocks, error recovery", dir: "07-safe-boot" },
            { name: "Smart LED", chip: "rp2040", desc: "PWM + channels + shared vars", dir: "smart-led" },
            { name: "Weather Station", chip: "esp32", desc: "ADC + storage + deep sleep", dir: "weather-station" },
        ];

        const el = document.getElementById("exampleList");
        if (!el) return;

        el.innerHTML = examples.map(ex => `
            <div class="example-item" data-dir="${ex.dir}" tabindex="-1" role="menuitem">
                <div class="example-item-main">
                    <span class="example-item-name">${ex.name}</span>
                    <span class="example-item-desc">${ex.desc}</span>
                </div>
                <span class="example-item-chip">${ex.chip.toUpperCase()}</span>
            </div>
        `).join("");

        el.querySelectorAll(".example-item").forEach(item => {
            const open = async () => {
                try {
                    // Resolve the bundled example to its absolute project dir, then
                    // open it the same way as any project — each example dir has its
                    // own main.volt + volt.toml. (Relative "examples/..." paths fail
                    // because the process cwd is the volt-ide dir, not the repo root.)
                    const dir = await api.resolveExample(item.dataset.dir);
                    onOpenExample(dir);
                } catch (e) {
                    console.warn("[welcome] failed to load example:", e);
                }
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
