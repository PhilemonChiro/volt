// device-card.js — the device in context, from its device.json: what it is,
// specs, wiring, the methods a Volt program gets, and how to declare it.
// Shared by the library review sheet and the Library view.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function paramList(ps) {
    return (Array.isArray(ps) ? ps : []).map(p => typeof p === "string" ? p
        : Array.isArray(p) ? `${p[0]}: ${p[1]}` : `${p.name}${p.type ? ": " + p.type : ""}`).join(", ");
}

export function usage(d) {
    const t = d.name || "Device", v = (d.c_prefix || "dev").replace(/\d+$/, "") || "dev";
    const iface = String(d.interface || "").toLowerCase();
    const addr = d.default_address ? ` at ${d.default_address}` : "";
    const bus = iface === "i2c" ? `\n    bus i2c0: I2C(sda: 21, scl: 22)\n    device ${v}: ${t} on i2c0${addr}`
        : iface === "spi" ? `\n    bus spi0: SPI(sck: 18, miso: 19, mosi: 23)\n    device ${v}: ${t} on spi0`
        : iface === "uart" ? `\n    bus uart1: UART(tx: 17, rx: 16)\n    device ${v}: ${t} on uart1`
        : `\n    device ${v}: ${t}(pin: 4)`;
    const m = Object.keys(d.methods || {})[0];
    return `hardware {${bus}\n}` + (m ? `\n\nevery 1s {\n    ${v}.${m}(${paramList(d.methods[m].params).replace(/: \w+/g, "")})\n}` : "");
}

export function deviceOverview(d, fallbackName, example) {
    d = d || {};
    const kv = (k, v) => v ? `<div class="lr-kv"><span>${k}</span><span>${v}</span></div>` : "";
    const methods = Object.entries(d.methods || {});
    const wiring = d.wiring && Array.isArray(d.wiring.pins) ? d.wiring.pins : [];
    const specs = Object.entries(d.specs || {});
    return `<div class="lr-ov">
      <div class="lr-ov-head">
        <div><h4>${esc(d.name || fallbackName || "")}</h4><p>${esc(d.description || "")}</p></div>
        ${d.datasheet ? `<a class="lr-ds" href="#" data-url="${esc(d.datasheet)}">Datasheet ↗</a>` : ""}
      </div>
      <div class="lr-ov-grid">
        <section><h5>Device</h5>
          ${kv("Manufacturer", esc(d.manufacturer))}${kv("Category", esc(d.category))}
          ${kv("Interface", esc(String(d.interface || "").toUpperCase()))}
          ${kv("Address", esc(d.default_address || (d.addresses || []).join(", ")))}
          ${kv("Max speed", esc(d.max_speed))}
          ${kv("Settings", esc(Object.entries(d.params || {}).map(([k, v]) => `${k}${v && v.default !== undefined ? ` = ${v.default}` : ""}`).join(", ")))}
          ${specs.length ? `<h5>Specs</h5>${specs.map(([k, v]) => kv(esc(k), esc(v))).join("")}` : ""}
        </section>
        <section><h5>What your program gets (${methods.length} method${methods.length === 1 ? "" : "s"})</h5>
          <ul class="lr-methods">${methods.map(([n, m]) => `<li><code>${esc(n)}(${esc(paramList(m.params))})${m.returns && m.returns !== "void" ? " → " + esc(m.returns) : ""}</code><span>${esc(m.description || "")}</span></li>`).join("") || "<li>None</li>"}</ul>
        </section>
        <section><h5>Wiring</h5>
          ${wiring.length ? `<ul class="lr-wiring">${wiring.map(p => `<li><b>${esc(p.label)}</b><span>${esc(p.note || p.type || "")}</span></li>`).join("")}</ul>` : `<p class="lr-muted">No wiring notes.</p>`}
          ${example ? `<h5>Example</h5><p><button type="button" class="lv-link" data-ex="goto">See the example program →</button></p>` : ""}
          ${(d.tips || []).length ? `<h5>Tips</h5><ul class="lr-tips">${d.tips.slice(0, 4).map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
        </section>
      </div></div>`;
}

