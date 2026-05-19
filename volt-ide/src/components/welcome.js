// Welcome screen — shown when no project is open

import { listProjects } from "../services/projects.js";

export function init(container, { onNew, onOpen, onOpenRecent }) {
    container.innerHTML = `
        <div class="welcome-stage">
            <img src="assets/volt-logo.svg" class="welcome-logo" alt="">
            <h1 class="welcome-title">Volt</h1>
            <p class="welcome-subtitle">Embedded development that reads like English</p>

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

            <div class="welcome-hints">
                <span><kbd>⌃N</kbd>New</span>
                <span><kbd>⌃O</kbd>Open</span>
                <span><kbd>⌃R</kbd>Run</span>
            </div>
        </div>
    `;

    document.getElementById("welcomeNewBtn").onclick = onNew;
    document.getElementById("welcomeOpenBtn").onclick = onOpen;

    loadRecent(onOpenRecent);
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
