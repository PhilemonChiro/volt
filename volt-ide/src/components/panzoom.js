// Lightweight pan / zoom / fit for rendered SVG diagrams (Mermaid output).
// Framework-free; attaches to a host element that contains exactly one <svg>.
// Re-attaching to the same host tears down the previous instance first, so it
// is safe to call on every re-render.

const MIN = 0.15, MAX = 8, FIT_MAX = 2;

export function attachPanZoom(host) {
    if (!host) return;
    if (host._panzoom) host._panzoom.destroy();

    const svg = host.querySelector("svg");
    if (!svg) return;

    // The host clips; the svg is transformed inside it.
    host.style.overflow = "hidden";
    // Only establish a positioning context if the host doesn't already have one.
    // The diagram hosts fill their panel via `position: absolute; inset: 0`, so
    // forcing `relative` here would collapse them to content height (clipping the
    // diagram). `absolute` is already a positioning context for the controls.
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.style.padding = "0";
    host.style.touchAction = "none";
    svg.style.transformOrigin = "0 0";
    svg.style.maxWidth = "none";
    svg.style.cursor = "grab";

    // Mermaid sizes the viewBox from its layout, but edge labels and titles
    // can overhang it and get cut at the svg edge. Grow it to the drawn bounds.
    try {
        const bb = svg.getBBox(), vb = svg.viewBox.baseVal, m = 8;
        if (bb.width && vb && vb.width) {
            const x0 = Math.min(vb.x, bb.x - m), y0 = Math.min(vb.y, bb.y - m);
            const x1 = Math.max(vb.x + vb.width, bb.x + bb.width + m), y1 = Math.max(vb.y + vb.height, bb.y + bb.height + m);
            if (x0 < vb.x || y0 < vb.y || x1 > vb.x + vb.width || y1 > vb.y + vb.height) {
                const k = svg.width.baseVal.value / vb.width || 1;
                svg.setAttribute("viewBox", `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
                svg.setAttribute("width", (x1 - x0) * k);
                svg.setAttribute("height", (y1 - y0) * k);
            }
        }
    } catch (_) {}

    let scale = 1, tx = 0, ty = 0;
    const apply = () => { svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };

    function fit() {
        scale = 1; tx = 0; ty = 0; apply();
        const cr = host.getBoundingClientRect();
        const sr = svg.getBoundingClientRect();
        if (!sr.width || !sr.height || !cr.width || !cr.height) { apply(); return; }
        const pad = 48;
        // Fit both ways: shrink a big diagram, and enlarge a small one to fill
        // the view (capped, so three states don't become huge boxes).
        let s = Math.min((cr.width - pad) / sr.width, (cr.height - pad) / sr.height, FIT_MAX);
        if (!(s > 0) || !isFinite(s)) s = 1;
        scale = s;
        tx = (cr.width - sr.width * s) / 2;
        ty = (cr.height - sr.height * s) / 2;
        apply();
    }

    function zoomAt(cx, cy, factor) {
        const ns = Math.min(MAX, Math.max(MIN, scale * factor));
        tx = cx - (cx - tx) * (ns / scale);
        ty = cy - (cy - ty) * (ns / scale);
        scale = ns;
        apply();
    }

    const onWheel = (e) => {
        e.preventDefault();
        const r = host.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    host.addEventListener("wheel", onWheel, { passive: false });

    let drag = false, sx = 0, sy = 0, stx = 0, sty = 0, pid = null;
    const onDown = (e) => {
        if (e.button !== 0) return;
        drag = true; pid = e.pointerId;
        try { svg.setPointerCapture(pid); } catch (_) {}
        sx = e.clientX; sy = e.clientY; stx = tx; sty = ty;
        svg.style.cursor = "grabbing";
    };
    const onMove = (e) => {
        if (!drag) return;
        tx = stx + (e.clientX - sx);
        ty = sty + (e.clientY - sy);
        apply();
    };
    const onUp = () => { drag = false; svg.style.cursor = "grab"; };
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);

    const onDbl = () => fit();
    host.addEventListener("dblclick", onDbl);

    // On-screen controls: zoom in / fit / zoom out
    const ctrls = document.createElement("div");
    ctrls.className = "pz-controls";
    ctrls.innerHTML = `
        <button class="pz-btn" data-a="in" title="Zoom in">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="pz-btn" data-a="fit" title="Fit to view (double-click)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
        </button>
        <button class="pz-btn" data-a="out" title="Zoom out">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>`;
    ctrls.onclick = (e) => {
        const a = e.target.closest(".pz-btn")?.dataset.a;
        if (!a) return;
        const r = host.getBoundingClientRect();
        if (a === "in") zoomAt(r.width / 2, r.height / 2, 1.25);
        else if (a === "out") zoomAt(r.width / 2, r.height / 2, 0.8);
        else fit();
    };
    host.appendChild(ctrls);

    // Fit once the SVG has laid out.
    requestAnimationFrame(fit);

    // Re-fit whenever the host changes size. This covers the common case where
    // the diagram is rendered while its panel is still 0-height (just switched
    // into view) — the initial fit() bails on the zero-size guard, and this
    // re-fits the moment the panel expands to its real size. Also handles window
    // and bottom-panel resizes. Guarded against fit-induced feedback (fit only
    // transforms the svg, never resizes the host).
    let roScheduled = false;
    const ro = new ResizeObserver(() => {
        if (roScheduled) return;
        roScheduled = true;
        requestAnimationFrame(() => { roScheduled = false; fit(); });
    });
    ro.observe(host);

    host._panzoom = {
        fit,
        destroy() {
            host.removeEventListener("wheel", onWheel);
            host.removeEventListener("dblclick", onDbl);
            try { ro.disconnect(); } catch (_) {}
            ctrls.remove();
            host._panzoom = null;
        },
    };
}
