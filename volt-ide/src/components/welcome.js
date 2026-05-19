// Welcome screen — shown when no project is open

import { listProjects } from "../services/projects.js";

export function init(container, { onNew, onOpen, onOpenRecent }) {
    container.innerHTML = `
        <img src="assets/volt-logo.svg" width="48" height="48" style="margin-bottom:16px;opacity:0.8">
        <h1 style="font-size:22px;font-weight:600;color:var(--t1)">Volt IDE</h1>
        <p style="color:var(--t3);margin:6px 0 24px">Embedded development that reads like English</p>
        <div style="display:flex;gap:10px">
            <button class="welcome-btn primary" id="welcomeNewBtn">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                New Project
            </button>
            <button class="welcome-btn" id="welcomeOpenBtn">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                Open Project
            </button>
        </div>
        <div id="recentProjects" style="margin-top:24px;width:300px"></div>
        <div style="margin-top:24px;font-size:11px;color:var(--t3)">
            <kbd>Ctrl+N</kbd> New &nbsp;&nbsp; <kbd>Ctrl+O</kbd> Open &nbsp;&nbsp; <kbd>Ctrl+R</kbd> Run
        </div>
    `;

    document.getElementById("welcomeNewBtn").onclick = onNew;
    document.getElementById("welcomeOpenBtn").onclick = onOpen;

    // Load recent projects
    loadRecent(onOpenRecent);
}

async function loadRecent(onOpenRecent) {
    try {
        const projects = await listProjects();
        const el = document.getElementById("recentProjects");
        if (!el || !projects.length) return;

        el.innerHTML = `
            <div style="font-size:11px;color:var(--t3);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px">Recent Projects</div>
            ${projects.slice(0, 8).map(p => {
                const shortPath = p.path
                    .replace(/^\/home\/[^/]+/, "~")        // Linux
                    .replace(/^\/Users\/[^/]+/, "~")       // macOS
                    .replace(/^C:\\Users\\[^\\]+/i, "~");  // Windows
                return `
                <div class="recent-item" data-path="${p.path}" style="
                    padding:8px 12px;border-radius:5px;cursor:pointer;
                    transition:background 80ms;
                ">
                    <div style="display:flex;justify-content:space-between;align-items:center">
                        <span style="color:var(--t1);font-size:13px">${p.name}</span>
                        <span style="color:var(--t3);font-size:11px;font-family:var(--mono)">${p.chip.toUpperCase()}</span>
                    </div>
                    <div style="color:var(--t3);font-size:10px;font-family:var(--mono);margin-top:2px;opacity:0.6">${shortPath}</div>
                </div>`;
            }).join("")}
        `;

        el.querySelectorAll(".recent-item").forEach(item => {
            item.onmouseenter = () => item.style.background = "var(--bg-3)";
            item.onmouseleave = () => item.style.background = "";
            item.onclick = () => onOpenRecent(item.dataset.path);
        });
    } catch (e) {
        console.warn("[welcome] failed to load recent:", e);
    }
}
