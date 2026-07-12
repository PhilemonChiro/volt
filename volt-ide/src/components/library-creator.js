// Library Creator — a wizard that scaffolds a new device library (device.json +
// driver.c + a <prefix>_t struct/prototypes block). Mirrors wizard.js styling.
// Collects a spec and hands it to main via window.volt.createDevice.

import * as dialog from "./dialog.js";

const api = window.volt;

const INTERFACES = [
    { id: "i2c",  label: "I²C",  desc: "Two-wire bus (SDA/SCL) + address" },
    { id: "gpio", label: "GPIO", desc: "Direct pin(s) — single-wire, sensors" },
    { id: "spi",  label: "SPI",  desc: "Four-wire bus + chip-select" },
    { id: "uart", label: "UART", desc: "Serial TX / RX" },
];
const RETURNS = ["float", "int", "bool", "void", "string"];
const TOTAL = 4;

function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function prefixOf(name) {
    return String(name || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

export function show(onCreated) {
    document.getElementById("libCreatorOverlay")?.remove();

    const state = {
        step: 1, name: "", interface: "i2c", description: "", category: "sensor",
        address: "0x00", pinMode: "single", pins: [{ name: "" }],
        methods: [{ name: "read", returns: "float", description: "" }],
    };
    let dir = "forward";

    const overlay = document.createElement("div");
    overlay.id = "libCreatorOverlay";
    overlay.className = "overlay";
    document.body.appendChild(overlay);

    const close = () => { overlay.classList.add("is-closing"); setTimeout(() => overlay.remove(), 180); };
    const dots = () => `<div class="wizard-dots">${[1, 2, 3, 4].map(i =>
        `<span class="wizard-dot ${i === state.step ? "is-current" : i < state.step ? "is-done" : ""}"></span>`).join("")}</div>`;

    // ---- step bodies ----
    function basicsBody() {
        const cards = INTERFACES.map(it =>
            `<button class="wiz-card ${it.id === state.interface ? "active" : ""}" data-iface="${it.id}">
                <strong>${it.label}</strong><small>${it.desc}</small></button>`).join("");
        return `
            <label class="lc-label">Device name</label>
            <input type="text" class="wiz-input" id="lcName" placeholder="BMP280" value="${esc(state.name)}">
            <div class="lc-hint">C prefix: <code id="lcPrefix">${esc(prefixOf(state.name) || "—")}</code></div>
            <label class="lc-label">Interface</label>
            <div class="wiz-grid lc-grid2">${cards}</div>
            <label class="lc-label">Description</label>
            <input type="text" class="wiz-input" id="lcDesc" placeholder="What the device does" value="${esc(state.description)}">`;
    }

    function connectionBody() {
        if (state.interface === "i2c") {
            return `<label class="lc-label">Default I²C address</label>
                <input type="text" class="wiz-input" id="lcAddr" placeholder="0x76" value="${esc(state.address)}">
                <div class="lc-hint">The bus is chosen in the user's <code>hardware {}</code>; this is just the default address.</div>`;
        }
        if (state.interface === "spi") {
            return `<div class="lc-hint">SPI devices are initialized with the bus + chip-select pin from the user's <code>hardware {}</code>. No extra config needed here.</div>`;
        }
        if (state.interface === "uart") {
            return `<div class="lc-hint">UART devices bind to the serial port in the user's <code>hardware {}</code>. Nothing to configure here.</div>`;
        }
        // gpio
        const rows = state.pins.map((p, i) =>
            `<div class="lc-row"><input type="text" class="wiz-input" data-pin="${i}" placeholder="trig" value="${esc(p.name)}">
             <button class="lc-x" data-delpin="${i}" title="Remove">×</button></div>`).join("");
        return `
            <label class="lc-label">Pin style</label>
            <div class="lc-seg">
                <button class="lc-seg-btn ${state.pinMode === "single" ? "active" : ""}" data-pinmode="single">Single pin</button>
                <button class="lc-seg-btn ${state.pinMode === "named" ? "active" : ""}" data-pinmode="named">Named pins</button>
            </div>
            ${state.pinMode === "single"
                ? `<div class="lc-hint">Declared as <code>DeviceName(pin: N)</code> — one data pin.</div>`
                : `<label class="lc-label">Named pins (e.g. trig, echo)</label>${rows}
                   <button class="wiz-btn lc-add" id="lcAddPin">+ Add pin</button>`}`;
    }

    function methodsBody() {
        const rows = state.methods.map((m, i) => `
            <div class="lc-method">
                <input type="text" class="wiz-input lc-mname" data-mname="${i}" placeholder="temperature" value="${esc(m.name)}">
                <select class="wiz-input lc-mret" data-mret="${i}">
                    ${RETURNS.map(r => `<option value="${r}" ${r === m.returns ? "selected" : ""}>${r}</option>`).join("")}
                </select>
                <input type="text" class="wiz-input lc-mdesc" data-mdesc="${i}" placeholder="description" value="${esc(m.description)}">
                <button class="lc-x" data-delm="${i}" title="Remove">×</button>
            </div>`).join("");
        return `<label class="lc-label">Methods the device exposes</label>${rows}
            <button class="wiz-btn lc-add" id="lcAddM">+ Add method</button>`;
    }

    function reviewBody() {
        const p = prefixOf(state.name);
        const conn = state.interface === "i2c" ? `addr ${esc(state.address)}`
            : state.interface === "gpio" ? (state.pinMode === "named"
                ? state.pins.map(x => x.name).filter(Boolean).join(", ") || "—" : "single pin")
            : state.interface;
        const ms = state.methods.filter(m => m.name.trim())
            .map(m => `<li><code>${esc(m.returns)} ${esc(p)}.${esc(m.name)}()</code></li>`).join("");
        return `
            <div class="lc-review">
                <div class="lc-rrow"><span>Name</span><b>${esc(state.name || "—")}</b></div>
                <div class="lc-rrow"><span>Interface</span><b>${esc(state.interface)} (${conn})</b></div>
                <div class="lc-rrow"><span>Prefix</span><b><code>${esc(p || "—")}</code></b></div>
                <div class="lc-rrow lc-rrow-top"><span>Methods</span><ul class="lc-mlist">${ms || "<li>—</li>"}</ul></div>
            </div>
            <div class="lc-hint">Creates <code>devices/${esc(prefixOf(state.name))}/</code> (device.json + driver.c) and a <code>${esc(p)}_t</code> struct with <code>TODO</code> stubs. Fill in the driver's C after.</div>`;
    }

    function render() {
        const titles = { 1: "Device Basics", 2: "Connection", 3: "Methods", 4: "Review & Create" };
        const nextLabel = state.step === TOTAL ? "Create Library" : "Continue";
        const body = state.step === 1 ? basicsBody() : state.step === 2 ? connectionBody()
            : state.step === 3 ? methodsBody() : reviewBody();
        overlay.innerHTML = `
            <div class="wizard-dialog lc-dialog">
                <div class="wizard-header"><span>${titles[state.step]}</span>
                    <button class="wizard-close" id="lcClose" aria-label="Close">&times;</button></div>
                <div class="wizard-body" data-dir="${dir}" data-step="${state.step}">${body}</div>
                <div class="wizard-footer">
                    ${state.step > 1 ? '<button class="wiz-btn" id="lcBack">Back</button>' : "<div></div>"}
                    ${dots()}
                    <button class="wiz-btn wiz-btn-primary" id="lcNext">${nextLabel}</button>
                </div>
            </div>`;
        wire();
    }

    function wire() {
        overlay.querySelector("#lcClose").onclick = close;
        overlay.onclick = (e) => { if (e.target === overlay) close(); };

        const nameEl = overlay.querySelector("#lcName");
        if (nameEl) nameEl.oninput = () => {
            state.name = nameEl.value;
            const pf = overlay.querySelector("#lcPrefix");
            if (pf) pf.textContent = prefixOf(state.name) || "—";
        };
        const descEl = overlay.querySelector("#lcDesc");
        if (descEl) descEl.oninput = () => { state.description = descEl.value; };
        const addrEl = overlay.querySelector("#lcAddr");
        if (addrEl) addrEl.oninput = () => { state.address = addrEl.value; };

        overlay.querySelectorAll("[data-iface]").forEach(c => c.onclick = () => { state.interface = c.dataset.iface; render(); });
        overlay.querySelectorAll("[data-pinmode]").forEach(b => b.onclick = () => { state.pinMode = b.dataset.pinmode; render(); });
        overlay.querySelectorAll("[data-pin]").forEach(inp => inp.oninput = () => { state.pins[+inp.dataset.pin].name = inp.value; });
        overlay.querySelectorAll("[data-delpin]").forEach(b => b.onclick = () => { state.pins.splice(+b.dataset.delpin, 1); if (!state.pins.length) state.pins.push({ name: "" }); render(); });
        const addPin = overlay.querySelector("#lcAddPin");
        if (addPin) addPin.onclick = () => { state.pins.push({ name: "" }); render(); };

        overlay.querySelectorAll("[data-mname]").forEach(inp => inp.oninput = () => { state.methods[+inp.dataset.mname].name = inp.value; });
        overlay.querySelectorAll("[data-mret]").forEach(sel => sel.onchange = () => { state.methods[+sel.dataset.mret].returns = sel.value; });
        overlay.querySelectorAll("[data-mdesc]").forEach(inp => inp.oninput = () => { state.methods[+inp.dataset.mdesc].description = inp.value; });
        overlay.querySelectorAll("[data-delm]").forEach(b => b.onclick = () => { state.methods.splice(+b.dataset.delm, 1); if (!state.methods.length) state.methods.push({ name: "", returns: "float", description: "" }); render(); });
        const addM = overlay.querySelector("#lcAddM");
        if (addM) addM.onclick = () => { state.methods.push({ name: "", returns: "float", description: "" }); render(); };

        const back = overlay.querySelector("#lcBack");
        if (back) back.onclick = () => { dir = "back"; state.step--; render(); };
        overlay.querySelector("#lcNext").onclick = onNext;
    }

    async function onNext() {
        if (state.step === 1) {
            if (!prefixOf(state.name)) { await dialog.alert("Name required", { detail: "Give the device a name (letters/numbers)." }); return; }
        }
        if (state.step < TOTAL) { dir = "forward"; state.step++; render(); return; }

        // Build spec + create
        const spec = {
            name: state.name.trim(),
            prefix: prefixOf(state.name),
            interface: state.interface,
            category: state.category,
            description: state.description.trim(),
            address: state.interface === "i2c" ? state.address.trim() : "",
            pins: state.interface === "gpio" && state.pinMode === "named"
                ? state.pins.map(p => ({ name: p.name })).filter(p => prefixOf(p.name)) : [],
            methods: state.methods.filter(m => m.name.trim())
                .map(m => ({ name: m.name.trim(), returns: m.returns, params: [], description: m.description.trim() })),
        };
        if (!spec.methods.length) { await dialog.alert("Add a method", { detail: "A device needs at least one method." }); state.step = 3; render(); return; }
        try {
            const res = await api.createDevice(spec);
            close();
            await dialog.alert("Library created", { detail: `${spec.name} — wrote ${res.created.length} files. Fill in the TODOs in devices/${res.dir}/driver.c.` });
            if (onCreated) onCreated(spec.name);
        } catch (e) {
            await dialog.alert("Couldn't create device", { detail: String((e && e.message) || e) });
        }
    }

    render();
}
