// Parts catalogue — one list of everything you can add to the hardware
// block: basic parts wired to one GPIO (assets/parts/basic.json, declared as
// `pin`) and library devices (device.json, declared as `device`). Adding is
// one action: placePart() picks pins, bus, address and a name, so nothing is
// asked up front; everything stays editable afterwards.

import { pinTable, supportsMode, takenGpios, rankFreePins, busPins, BUS_SIGNALS } from "./pin-facts.js";

const GROUPS = {
    sensor: "Sensors", temperature: "Sensors", light: "Sensors", analog: "Sensors", health: "Sensors",
    distance: "Sensors", motion: "Sensors", power: "Sensors", time: "Sensors",
    display: "Displays", control: "Motors & control", rf: "Wireless & comms",
    communication: "Wireless & comms", storage: "Storage",
};
export const GROUP_ORDER = ["Basic", "Sensors", "Displays", "Motors & control", "Wireless & comms", "Storage", "Other"];
const BUILTIN_KEYS = new Set(["addr", "bus_id", "uart_id"]);

let _cat = null;
export function catalogue() {
    if (!_cat) _cat = Promise.all([
        fetch("assets/parts/basic.json").then(r => r.json()).catch(() => ({ parts: [] })),
        window.volt.devicesList().catch(() => []),
    ]).then(([basic, devices]) => [
        ...basic.parts.map(p => ({ ...p, kind: "pin", group: "Basic", iface: "pin" })),
        ...(devices || []).filter(d => d && d.name).map(deviceEntry),
    ]);
    return _cat;
}

function deviceEntry(d) {
    const iface = (d.interface || "i2c").toLowerCase();
    // The device's own GPIOs: device.json `pins` ({role: {dir}}); older
    // files: the init_args placeholders.
    let roles = d.pins ? Object.keys(d.pins)
        : [...new Set([...String(d.init_args || "").matchAll(/\{([a-z_][a-z0-9_]*)\}/gi)]
            .map(m => m[1]).filter(k => !BUILTIN_KEYS.has(k) && !(d.params && k in d.params)))];
    if (iface === "gpio" && !roles.length) roles = ["pin"];
    const inputs = new Set(Object.entries(d.pins || {}).filter(([, p]) => p && p.dir === "in").map(([r]) => r));
    const pins = (d.wiring && d.wiring.pins) || [];
    // device.json `addresses` (datasheet list, default first); older files:
    // the default plus any 0xNN mentioned in the wiring notes.
    const addresses = (d.addresses && d.addresses.length ? d.addresses
        : [d.default_address, ...pins.flatMap(p => (p.note || "").match(/0x[0-9a-f]{2}/gi) || [])])
        .filter(Boolean).map(a => "0x" + a.slice(2).toUpperCase());
    return {
        id: "dev:" + d.name, kind: "device", type: d.name, label: d.name,
        sub: d.description || "", group: GROUPS[d.category] || "Other", iface, roles, inputs,
        name: String(d.c_prefix || d.name).toLowerCase().replace(/[^a-z0-9_]/g, "_"),
        addresses: [...new Set(addresses)],
        keywords: [d.category, d.manufacturer, d.description, iface].filter(Boolean).join(" ").toLowerCase(),
        wiringPins: pins, tips: d.tips || [], dev: d,
    };
}

// Parts that can go on one specific free GPIO (pin card / picker opened
// from a pin): basic parts the pin supports, single-pin GPIO devices, and
// SPI devices (the pin becomes chip-select).
export function fitsPin(entry, info) {
    if (!info) return true;
    if (entry.kind === "pin") return supportsMode(info, entry.mode);
    if (entry.iface === "gpio") return entry.roles.length === 1 && supportsMode(info, "Output");
    if (entry.iface === "spi") return supportsMode(info, "Output");
    return false;
}

// Search: label / keywords / group, best matches first.
export function search(cat, q) {
    q = q.trim().toLowerCase();
    if (!q) return cat;
    const score = e => {
        const l = e.label.toLowerCase();
        if (l === q) return 0;
        if (l.startsWith(q)) return 1;
        if (l.includes(q)) return 2;
        if ((e.keywords || "").includes(q) || e.sub.toLowerCase().includes(q)) return 3;
        if (e.group.toLowerCase().includes(q)) return 4;
        return 9;
    };
    return cat.map(e => [score(e), e]).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0]).map(([, e]) => e);
}

// Decide everything needed to add `entry` — no questions. Returns
// { texts: [decl lines], name, note } or { error }. Devices use the short
// forms: I2C / SPI devices ride the chip's default bus (no bus line, `at`
// only when the address isn't the default), a serial module names its own
// tx / rx. An explicit bus is only written when the default pins are taken.
export async function placePart(entry, hw, opts = {}) {
    const table = await pinTable();
    const taken = takenGpios(hw);
    const names = new Set([...hw.pins, ...hw.buses, ...hw.devices].map(x => x.name));
    const unique = base => {
        let n = base;
        for (let i = 2; names.has(n); i++) n = base + "_" + i;
        names.add(n);
        return n;
    };
    const info = g => table.find(i => String(i.gpio) === String(g));
    const claim = (mode, preferred) => {
        if (preferred != null && !taken.has(String(preferred)) && info(preferred) && supportsMode(info(preferred), mode)) {
            taken.add(String(preferred));
            return String(preferred);
        }
        const best = rankFreePins(table, mode, taken)[0];
        if (!best) return null;
        taken.add(String(best.gpio));
        return String(best.gpio);
    };
    const claimRoles = (roles, firstPreferred) => {
        const out = [];
        for (const [i, r] of roles.entries()) {
            const g = claim(entry.inputs && entry.inputs.has(r) ? "Input" : "Output", i === 0 ? firstPreferred : null);
            if (!g) return null;
            out.push(`${r}: ${g}`);
        }
        return out;
    };
    // The bus an I2C / SPI device goes on: { on: "" } for the default bus
    // (exists already, or its native pins are free), else an explicit one.
    const busFor = async (type) => {
        const T = type.toUpperCase();
        if (hw.buses.some(b => b.implicit && b.busType === T)) return { on: "" };
        const native = (await busPins())[type] || {};
        const sigs = BUS_SIGNALS[type].map(s => native[s.role]);
        if (sigs.every(g => g != null && !taken.has(String(g)))) {
            for (const g of sigs) taken.add(String(g));
            return { on: "" };
        }
        const bus = hw.buses.find(b => b.busType === T);
        if (bus) return { on: bus.name };
        const roles = {};
        for (const sig of BUS_SIGNALS[type]) {
            const g = claim(sig.out ? "Output" : "Input", native[sig.role]);
            if (!g) return null;
            roles[sig.role] = g;
        }
        const name = unique(type + "0");
        return { on: name, text: `${type} ${name}(${Object.entries(roles).map(([r, g]) => `${r}: ${g}`).join(", ")})` };
    };

    if (entry.kind === "pin") {
        const g = claim(entry.mode, opts.gpio);
        if (!g) return { error: `No free pin can be a ${entry.label}.` };
        const name = unique(entry.name);
        return { texts: [`pin ${name}: ${entry.mode} = ${g}`], name };
    }

    const name = unique(entry.name);
    const T = entry.type;
    const args = a => a.length ? `(${a.join(", ")})` : "";
    switch (entry.iface) {
        case "gpio": {
            const pins = claimRoles(entry.roles, opts.gpio);
            if (!pins) return { error: `Not enough free pins for ${T}.` };
            return { texts: [`device ${name}: ${T}${args(pins)}`], name };
        }
        case "i2c": {
            const bus = await busFor("i2c");
            if (!bus) return { error: "No free pins for an I2C bus." };
            const busName = bus.on || (hw.buses.find(b => b.implicit && b.busType === "I2C") || {}).name;
            const used = new Set(hw.devices.filter(d => bus.on ? d.bus === bus.on : d.iface === "i2c" && !d.hasBus && d.bus === busName)
                .map(d => parseInt(d.address)));
            const free = entry.addresses.find(a => !used.has(parseInt(a)));
            const addr = free || entry.addresses[0] || "";
            const at = addr && addr !== entry.addresses[0] ? ` at ${addr}` : "";
            return { texts: [bus.text, `device ${name}: ${T}${bus.on ? " on " + bus.on : ""}${at}`].filter(Boolean), name,
                note: free ? "" : `Address ${addr} is already used on ${bus.on || "the default I2C bus"} — change one device's address.` };
        }
        case "spi": {
            const bus = await busFor("spi");
            if (!bus) return { error: "No free pins for an SPI bus." };
            const pins = claimRoles(entry.roles.length ? entry.roles : ["cs"], opts.gpio);
            if (!pins) return { error: `Not enough free pins for ${T}.` };
            return { texts: [bus.text, `device ${name}: ${T}${args(pins)}${bus.on ? " on " + bus.on : ""}`].filter(Boolean), name };
        }
        case "uart": {
            // Each serial module gets its own UART: tx / rx are the board's.
            const native = (await busPins()).uart || {};
            const tx = claim("Output", native.tx), rx = tx && claim("Input", native.rx);
            if (!rx) return { error: "No free pins for a UART." };
            return { texts: [`device ${name}: ${T}(tx: ${tx}, rx: ${rx})`], name };
        }
    }
    return { error: `Don't know how to add a ${entry.iface} device yet.` };
}

// Concrete wiring for a placed device: [{ text, note }].
export function deviceWiring(entry, decl, hw) {
    const bus = hw.buses.find(b => b.name === decl.bus);
    const roles = decl.roles || {};
    const g = n => n == null ? null : `GPIO ${n}`;
    const target = (label, type, note) => {
        const L = label.toUpperCase();
        if (type === "power") return /5\s*v/i.test(note) && !/3\.3|3v3/i.test(note) ? "5V" : "3V3";
        if (type === "ground" || L === "GND") return "GND";
        // A UART device's tx / rx are the board's pins: wired crossed below.
        const own = entry.iface !== "uart" && Object.keys(roles).find(r => r.toUpperCase() === L);
        if (own) return g(roles[own]);
        if (entry.iface === "gpio" && Object.keys(roles).length === 1 && /^(DATA|DIN|DI|SIG|S|OUT|IN|DQ)$/.test(L))
            return g(Object.values(roles)[0]);
        if (!bus) return null;
        const r = bus.roles;
        if (entry.iface === "i2c") return L === "SDA" ? g(r.sda) : L === "SCL" ? g(r.scl) : null;
        if (entry.iface === "spi") {
            if (/^(MOSI|DIN|SDI|SI)$/.test(L)) return g(r.mosi);
            if (/^(MISO|DOUT|SDO|SO)$/.test(L)) return g(r.miso);
            if (/^(SCK|CLK|SCLK)$/.test(L)) return g(r.clk ?? r.sck);
            if (/^(CS|SS|NSS|CE|SDA)$/.test(L)) return g(roles.cs ?? parseInt(decl.address));
        }
        if (entry.iface === "uart") {
            if (/^(TX|TXD)$/.test(L)) return r.rx != null ? `GPIO ${r.rx} (board RX)` : null;
            if (/^(RX|RXD)$/.test(L)) return r.tx != null ? `GPIO ${r.tx} (board TX)` : null;
        }
        return null;
    };
    return (entry.wiringPins || []).map(p => {
        const t = target(p.label, p.type, p.note || "");
        return t ? { text: `${p.label} → ${t}`, note: p.note || "" } : { text: p.label, note: p.note || "leave unconnected unless needed" };
    });
}
