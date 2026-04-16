// Project Picker — shows recent projects in a dialog with search

import { listProjects, browseVoltFile } from "../services/projects.js";

export async function show(onOpen) {
    const old = document.getElementById("pickerOverlay");
    if (old) old.remove();

    let projects = [];
    try { projects = await listProjects(); } catch (_) {}

    const overlay = document.createElement("div");
    overlay.id = "pickerOverlay";
    overlay.className = "overlay";
    document.body.appendChild(overlay);

    function render(filter) {
        const filtered = filter
            ? projects.filter(p => p.name.toLowerCase().includes(filter.toLowerCase()))
            : projects;

        const list = filtered.length
            ? filtered.map(p => `
                <div class="picker-item" data-path="${p.path}">
                    <div class="picker-item-name">${highlight(p.name, filter)}</div>
                    <div class="picker-item-meta">
                        <span class="picker-chip">${p.chip.toUpperCase()}</span>
                        <span class="picker-path">${p.path}</span>
                    </div>
                </div>
            `).join("")
            : '<div class="picker-empty">No projects found</div>';

        overlay.innerHTML = `
            <div class="picker-dialog">
                <div class="picker-header">
                    <span class="picker-title">Open Project</span>
                    <button class="picker-close" id="pickerClose">&times;</button>
                </div>
                <div class="picker-search-wrap">
                    <svg class="picker-search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input type="text" class="picker-search" id="pickerSearch" placeholder="Search projects..." value="${filter || ""}" autofocus>
                </div>
                <div class="picker-list" id="pickerList">${list}</div>
                <div class="picker-footer">
                    <button class="picker-browse" id="pickerBrowse">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                        Browse for .volt file...
                    </button>
                </div>
            </div>
        `;

        // Events
        overlay.querySelector("#pickerClose").onclick = close;
        overlay.onclick = (e) => { if (e.target === overlay) close(); };

        const search = overlay.querySelector("#pickerSearch");
        search.oninput = () => render(search.value);
        search.onkeydown = (e) => {
            if (e.key === "Escape") close();
            if (e.key === "Enter") {
                const first = overlay.querySelector(".picker-item");
                if (first) { close(); onOpen(first.dataset.path); }
            }
        };
        setTimeout(() => search.focus(), 50);

        overlay.querySelectorAll(".picker-item").forEach(item => {
            item.onclick = () => { close(); onOpen(item.dataset.path); };
        });

        overlay.querySelector("#pickerBrowse").onclick = async () => {
            close();
            try {
                const result = await browseVoltFile();
                if (result && result.folder) onOpen(result.folder);
            } catch (_) {}
        };
    }

    function close() { overlay.remove(); }

    function highlight(text, query) {
        if (!query) return text;
        const idx = text.toLowerCase().indexOf(query.toLowerCase());
        if (idx < 0) return text;
        return text.substring(0, idx) +
            '<mark style="background:var(--volt-dim);color:var(--t1)">' +
            text.substring(idx, idx + query.length) + '</mark>' +
            text.substring(idx + query.length);
    }

    render("");
}
