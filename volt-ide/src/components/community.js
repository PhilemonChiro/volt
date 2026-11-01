// Community & feedback: the Send Feedback dialog, "Join our Discord", the
// one-time privacy notice, and forwarding of uncaught renderer errors to the
// crash reporter in main (the renderer has no SDK of its own).

const api = window.volt;

export async function openDiscord() {
    api.telemetry.feature("discord");
    const { discordUrl } = await api.community.config();
    api.openExternal(discordUrl);
}

const KINDS = [
    { value: "bug", label: "Bug" },
    { value: "idea", label: "Idea" },
    { value: "praise", label: "Praise" },
    { value: "other", label: "Other" },
];

export function showFeedback(kind = "bug") {
    if (document.querySelector(".fb-dialog")) return;
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
        <div class="dialog fb-dialog" role="dialog" aria-modal="true" aria-labelledby="fbTitle">
            <h2 class="dialog-title" id="fbTitle">Send feedback</h2>
            <p class="dialog-subtitle">Goes straight to the Volt team. For a quick chat, <a href="#" data-act="discord">join our Discord</a>.</p>
            <div class="fb-kinds" role="radiogroup" aria-label="Type">
                ${KINDS.map(k => `<button type="button" role="radio" class="fb-kind" data-kind="${k.value}" aria-checked="${k.value === kind}">${k.label}</button>`).join("")}
            </div>
            <textarea class="fb-input fb-message" rows="6" maxlength="10000" placeholder="What happened, or what would you like to see?"></textarea>
            <input class="fb-input fb-email" type="email" maxlength="200" placeholder="Email (optional — if you'd like a reply)">
            <label class="fb-check"><input type="checkbox" class="fb-logs" checked> Attach the IDE log (home folder and user name removed)</label>
            <p class="fb-status" aria-live="polite"></p>
            <div class="dialog-actions">
                <button class="dialog-btn" data-act="cancel">Cancel</button>
                <button class="dialog-btn dialog-btn-primary" data-act="send">Send</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const $ = (s) => overlay.querySelector(s);
    let current = kind;
    const close = () => {
        overlay.classList.add("is-closing");
        setTimeout(() => overlay.remove(), 220);
        document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey);

    overlay.querySelectorAll(".fb-kind").forEach(b => b.onclick = () => {
        current = b.dataset.kind;
        overlay.querySelectorAll(".fb-kind").forEach(x => x.setAttribute("aria-checked", String(x === b)));
    });
    $('[data-act="discord"]').onclick = (e) => { e.preventDefault(); openDiscord(); };
    $('[data-act="cancel"]').onclick = close;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

    const send = $('[data-act="send"]');
    send.onclick = async () => {
        const message = $(".fb-message").value.trim();
        const status = $(".fb-status");
        if (!message) { status.textContent = "Write a message first."; $(".fb-message").focus(); return; }
        send.disabled = true;
        status.textContent = "Sending…";
        const res = await api.feedback.send({
            kind: current, message, email: $(".fb-email").value, includeLogs: $(".fb-logs").checked,
        }).catch(() => ({ ok: false, error: "Couldn't send feedback." }));
        if (res.ok) {
            status.textContent = "Thanks — feedback sent.";
            setTimeout(close, 900);
        } else {
            status.textContent = res.error || "Couldn't send feedback.";
            send.disabled = false;
        }
    };
    setTimeout(() => $(".fb-message").focus(), 40);
}

// The first-launch notice: telemetry is on by default, so say so once, plainly,
// with the switches right there.
export async function maybeShowPrivacyNotice() {
    const s = await api.settingsAll();
    if (s["privacy.noticeShown"]) return;
    const card = document.createElement("div");
    card.className = "privacy-notice";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Privacy");
    card.innerHTML = `
        <strong>Help improve Volt IDE</strong>
        <p>Volt IDE sends crash reports and anonymous usage statistics (IDE version, OS, chip, features used, build results) under a random ID. Never your code, files or project names.</p>
        <label><input type="checkbox" data-key="privacy.crashReports" ${s["privacy.crashReports"] !== false ? "checked" : ""}> Send crash reports</label>
        <label><input type="checkbox" data-key="privacy.usageStats" ${s["privacy.usageStats"] !== false ? "checked" : ""}> Send usage statistics</label>
        <div class="privacy-actions"><span class="privacy-hint">Change any time in Settings › Privacy</span><button class="dialog-btn dialog-btn-primary">OK</button></div>`;
    document.body.appendChild(card);
    card.querySelectorAll("input[data-key]").forEach(i => i.onchange = () => api.settingsSet(i.dataset.key, i.checked));
    card.querySelector("button").onclick = () => {
        api.settingsSet("privacy.noticeShown", true);
        card.remove();
    };
}

// Uncaught renderer errors → main → crash reporter (if the user allows it).
export function forwardErrors() {
    const sendErr = (err, kind) => {
        if (!err) return;
        api.telemetry.rendererError({
            name: err.name || "Error",
            message: err.message || String(err),
            stack: err.stack || "",
            kind,
        });
    };
    window.addEventListener("error", (e) => sendErr(e.error || { message: e.message }, "error"));
    window.addEventListener("unhandledrejection", (e) => sendErr(e.reason instanceof Error ? e.reason : { message: String(e.reason) }, "unhandledrejection"));
}
