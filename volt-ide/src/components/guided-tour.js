// Guided Tour — sequential tooltips that highlight UI elements
// Appears after the first project is created from onboarding.

// Each step targets a CSS selector and shows a tooltip anchored nearby.
const STEPS = [
    {
        target: "#editorContainer",
        title: "Write your code",
        body: "This is the editor. Write Volt here — a typed, hardware-aware language that compiles to C for ESP32, RP2040, and ESP8266.",
        placement: "right",
        highlightPadding: 8,
    },
    {
        target: "#toggleHardware",
        title: "Hardware panel",
        body: "Open the hardware panel to see your board's pins. Configure GPIO, ADC, PWM, and more with one click.",
        placement: "left",
        highlightPadding: 8,
    },
    {
        target: "#runBtn",
        title: "Run on device",
        body: "Click Run to compile, flash, and monitor your code on the connected microcontroller.",
        placement: "bottom",
        highlightPadding: 6,
    },
    {
        target: "#deviceSelector",
        title: "Select your board",
        body: "Pick your connected device here. Volt supports ESP32, RP2040, ESP8266, and more.",
        placement: "bottom",
        highlightPadding: 6,
    },
];

let activeTour = null;

export function startTour(onComplete) {
    if (activeTour) return;
    activeTour = { step: 0 };
    showStep(0, onComplete);
}

export function stopTour() {
    if (!activeTour) return;
    document.querySelectorAll(".tour-overlay, .tour-tooltip, .tour-highlight").forEach(el => el.remove());
    activeTour = null;
}

function showStep(index, onComplete) {
    const step = STEPS[index];
    if (!step) {
        stopTour();
        if (onComplete) onComplete();
        return;
    }

    // Find target
    const target = document.querySelector(step.target);
    if (!target) {
        // Skip if target not found
        showStep(index + 1, onComplete);
        return;
    }

    // Remove old elements
    document.querySelectorAll(".tour-overlay, .tour-tooltip, .tour-highlight").forEach(el => el.remove());

    // Overlay
    const overlay = document.createElement("div");
    overlay.className = "tour-overlay";
    document.body.appendChild(overlay);

    // Highlight ring
    const rect = target.getBoundingClientRect();
    const pad = step.highlightPadding || 4;
    const highlight = document.createElement("div");
    highlight.className = "tour-highlight";
    highlight.style.cssText = `
        left:${rect.left - pad}px; top:${rect.top - pad}px;
        width:${rect.width + pad * 2}px; height:${rect.height + pad * 2}px;
        border-radius:${Math.min(rect.height * 0.3, 8)}px;
    `;
    document.body.appendChild(highlight);

    // Tooltip
    const tip = document.createElement("div");
    tip.className = `tour-tooltip tour-tooltip-${step.placement}`;
    const isLast = index === STEPS.length - 1;

    tip.innerHTML = `
        <div class="tour-tooltip-arrow"></div>
        <div class="tour-tooltip-header">
            <span class="tour-tooltip-step">${index + 1} / ${STEPS.length}</span>
            <button class="tour-tooltip-skip" id="tourSkip">Skip</button>
        </div>
        <div class="tour-tooltip-title">${step.title}</div>
        <div class="tour-tooltip-body">${step.body}</div>
        <div class="tour-tooltip-footer">
            ${index > 0 ? '<button class="tour-btn tour-btn-back" id="tourBack">Back</button>' : '<span></span>'}
            <button class="tour-btn tour-btn-next" id="tourNext">
                ${isLast ? "Done" : "Next"}
                ${!isLast ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 3 11 8 6 13"/></svg>' : ""}
            </button>
        </div>
    `;

    document.body.appendChild(tip);

    // Position tooltip relative to target
    positionTooltip(tip, rect, step.placement);

    // Wire events
    tip.querySelector("#tourNext").onclick = () => showStep(index + 1, onComplete);
    const backBtn = tip.querySelector("#tourBack");
    if (backBtn) backBtn.onclick = () => showStep(index - 1, onComplete);
    tip.querySelector("#tourSkip").onclick = () => {
        stopTour();
        if (onComplete) onComplete();
    };

    // Scroll target into view if needed
    target.scrollIntoView({ behavior: "smooth", block: "center" });

    // Entry animation
    requestAnimationFrame(() => {
        tip.style.opacity = "1";
        tip.style.transform = "translateY(0) scale(1)";
        highlight.style.opacity = "1";
        highlight.style.transform = "scale(1)";
    });
}

function positionTooltip(tip, targetRect, placement) {
    const gap = 12;
    let top, left;
    const tipRect = tip.getBoundingClientRect();
    const tipW = Math.min(tipRect.width || 280, 320);
    const tipH = tipRect.height || 180;

    switch (placement) {
        case "right":
            left = targetRect.right + gap;
            top = targetRect.top + targetRect.height / 2 - tipH / 2;
            break;
        case "left":
            left = targetRect.left - gap - tipW;
            top = targetRect.top + targetRect.height / 2 - tipH / 2;
            break;
        case "bottom":
            left = targetRect.left + targetRect.width / 2 - tipW / 2;
            top = targetRect.bottom + gap;
            break;
        case "top":
        default:
            left = targetRect.left + targetRect.width / 2 - tipW / 2;
            top = targetRect.top - gap - tipH;
            break;
    }

    // Clamp to viewport
    const maxX = window.innerWidth - tipW - 16;
    const maxY = window.innerHeight - tipH - 16;
    left = Math.max(16, Math.min(left, maxX));
    top = Math.max(16, Math.min(top, maxY));

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.width = `${tipW}px`;
}

// Expose for external wiring
export function isTourActive() {
    return activeTour !== null;
}
