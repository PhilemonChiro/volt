// Themed confirm / alert dialogs — replace the native Electron dialogs, which
// render with the generic Electron chrome and don't match the app. Built on the
// existing .dialog-overlay / .dialog design system.

function esc(t) {
    return String(t == null ? "" : t)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mount(html, { onKey } = {}) {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    let done = false;
    function close(result, resolve) {
        if (done) return;
        done = true;
        overlay.classList.add("is-closing");
        setTimeout(() => overlay.remove(), 220);
        document.removeEventListener("keydown", keyHandler);
        resolve(result);
    }
    let keyHandler;
    return { overlay, close, setKeyHandler: (h) => { keyHandler = h; document.addEventListener("keydown", keyHandler); } };
}

// Returns Promise<boolean> — true on confirm, false on cancel/escape/backdrop.
export function confirm(title, opts = {}) {
    const {
        detail = "",
        okLabel = "OK",
        cancelLabel = "Cancel",
        danger = false,
    } = opts;

    return new Promise((resolve) => {
        const okClass = danger ? "dialog-btn-danger" : "dialog-btn-primary";
        const { overlay, close, setKeyHandler } = mount(`
            <div class="dialog dialog-confirm" role="dialog" aria-modal="true">
                <h2 class="dialog-title">${esc(title)}</h2>
                ${detail ? `<p class="dialog-subtitle">${esc(detail)}</p>` : ""}
                <div class="dialog-actions">
                    <button class="dialog-btn" data-act="cancel">${esc(cancelLabel)}</button>
                    <button class="dialog-btn ${okClass}" data-act="ok">${esc(okLabel)}</button>
                </div>
            </div>`);

        const finish = (v) => close(v, resolve);
        overlay.querySelector('[data-act="ok"]').onclick = () => finish(true);
        overlay.querySelector('[data-act="cancel"]').onclick = () => finish(false);
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(false); });
        setKeyHandler((e) => {
            if (e.key === "Escape") { e.preventDefault(); finish(false); }
            else if (e.key === "Enter") { e.preventDefault(); finish(true); }
        });
        // Focus the safe default: Cancel for destructive actions, OK otherwise.
        setTimeout(() => overlay.querySelector(danger ? '[data-act="cancel"]' : '[data-act="ok"]')?.focus(), 40);
    });
}

// Returns Promise<void> — resolves when dismissed.
// askSave(fileName, what) — the file has unsaved changes and something is about
// to replace it (opening or creating a project, closing). Resolves to
// "save" | "discard" | "cancel". Enter saves, Escape cancels.
export function askSave(fileName, what = "") {
    return new Promise((resolve) => {
        const { overlay, close, setKeyHandler } = mount(`
            <div class="dialog dialog-confirm" role="dialog" aria-modal="true">
                <h2 class="dialog-title">Save changes to ${esc(fileName)}${what ? " " + esc(what) : ""}?</h2>
                <p class="dialog-subtitle">Your changes will be lost if you don't save them.</p>
                <div class="dialog-actions">
                    <button class="dialog-btn dialog-btn-left" data-act="discard">Don't Save</button>
                    <button class="dialog-btn" data-act="cancel">Cancel</button>
                    <button class="dialog-btn dialog-btn-primary" data-act="save">Save</button>
                </div>
            </div>`);
        const finish = (v) => close(v, resolve);
        overlay.querySelectorAll("[data-act]").forEach(b => b.onclick = () => finish(b.dataset.act));
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish("cancel"); });
        setKeyHandler((e) => {
            if (e.key === "Escape") { e.preventDefault(); finish("cancel"); }
            else if (e.key === "Enter" && !e.target.closest?.("[data-act]")) { e.preventDefault(); finish("save"); }
        });
        setTimeout(() => overlay.querySelector('[data-act="save"]')?.focus(), 40);
    });
}

export function alert(title, opts = {}) {
    const { detail = "", okLabel = "OK" } = opts;
    return new Promise((resolve) => {
        const { overlay, close, setKeyHandler } = mount(`
            <div class="dialog dialog-confirm" role="dialog" aria-modal="true">
                <h2 class="dialog-title">${esc(title)}</h2>
                ${detail ? `<p class="dialog-subtitle">${esc(detail)}</p>` : ""}
                <div class="dialog-actions">
                    <button class="dialog-btn dialog-btn-primary" data-act="ok">${esc(okLabel)}</button>
                </div>
            </div>`);
        const finish = () => close(undefined, resolve);
        overlay.querySelector('[data-act="ok"]').onclick = finish;
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(); });
        setKeyHandler((e) => {
            if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); finish(); }
        });
        setTimeout(() => overlay.querySelector('[data-act="ok"]')?.focus(), 40);
    });
}
