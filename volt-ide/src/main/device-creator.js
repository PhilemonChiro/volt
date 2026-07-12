// Device-library creator — scaffolds a new Volt device from a spec collected by
// the UI wizard. A library is three coordinated pieces:
//   1. devices/<name>/device.json  — catalog metadata (registry scans devices/)
//   2. devices/<name>/driver.c     — the C: <prefix>_init + one fn per method
//   3. a <prefix>_t struct + prototypes appended to the interface's header
//      (i2c → sensor.h, gpio → gpio_devices.h, spi → spi_devices.h)
// Everything is written to every copy that exists (repo, bundled, runtime) so
// the catalog can't drift — the same class of divergence we just reconciled.

const fs = require("fs");
const path = require("path");
const os = require("os");

// interface → { header it lives in, the driver's primary include }
const IFACE = {
    i2c:  { header: "sensor.h",        include: "volt/i2c.h" },
    gpio: { header: "gpio_devices.h",  include: "volt/pin.h" },
    spi:  { header: "spi_devices.h",   include: "volt/spi.h" },
    uart: { header: "sensor.h",        include: "volt/uart.h" },
};

const C_RET = { float: "float", int: "int32_t", bool: "bool", void: "void", string: "const char *" };

function ident(s) {
    return String(s || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

// Resolve the init signature, struct fields, and device.json init_args template
// for an interface — these MUST agree with how codegen.py emits <prefix>_init(...).
function initShape(spec) {
    const named = Array.isArray(spec.pins) && spec.pins.length > 0
        ? spec.pins.map(p => ident(p.name || p)).filter(Boolean) : [];
    // assigns = [[structField, initParam], …] — drives both the struct fields
    // and the `dev->field = param;` seeding, which can differ (gpio named pins:
    // field "trig_pin", param "trig").
    const shape = (assigns, initArgs) => ({
        assigns,
        fields: `uint8_t ${assigns.map(a => a[0]).join(", ")};`,
        params: assigns.map(a => `uint8_t ${a[1]}`).join(", "),
        initArgs,
    });
    switch (spec.interface) {
        case "i2c":  return shape([["bus_id", "bus_id"], ["addr", "addr"]], "{bus_id}, {addr}");
        case "spi":  return shape([["bus", "bus"], ["cs", "cs"]], "");
        case "uart": return shape([["bus", "bus"]], "");
        case "gpio":
        default:
            return named.length
                ? shape(named.map(n => [`${n}_pin`, n]), named.map(n => `{${n}}`).join(", "))
                : shape([["pin", "pin"]], "{pin}");
    }
}

function methodSig(prefix, m) {
    const ret = C_RET[m.returns] || "int32_t";
    const params = (m.params || []).map(p => {
        const t = C_RET[p.type] || "int32_t";
        return `${t} ${ident(p.name)}`;
    });
    const args = [`${prefix}_t *dev`, ...params].join(", ");
    return { ret, decl: `${ret} ${prefix}_${ident(m.name)}(${args});`, defnHead: `${ret} ${prefix}_${ident(m.name)}(${args})` };
}

function buildDeviceJson(spec, shape) {
    const methods = {};
    for (const m of spec.methods || []) {
        methods[ident(m.name)] = {
            returns: m.returns || "int",
            params: (m.params || []).map(p => ({ name: ident(p.name), type: p.type || "int" })),
            description: m.description || "",
        };
    }
    const json = {
        name: spec.name,
        category: spec.category || "sensor",
        interface: spec.interface,
        default_address: spec.interface === "i2c" ? (spec.address || "") : "",
        description: spec.description || "",
        c_prefix: spec.prefix,
        c_source: "driver.c",
        init_args: shape.initArgs,
        methods,
    };
    if (spec.datasheet) json.datasheet = spec.datasheet;
    return JSON.stringify(json, null, 2) + "\n";
}

function buildDriverC(spec, shape) {
    const inc = IFACE[spec.interface] || IFACE.gpio;
    const header = inc.header;
    const lines = [];
    lines.push(`#include "volt/${header}"`);
    lines.push(`/* ${spec.name} — ${spec.description || spec.interface + " device"} */`);
    lines.push("");
    lines.push(`#include "${inc.include}"`);
    lines.push(`#include "volt/log.h"`);
    lines.push(`#include <stdint.h>`);
    lines.push("");
    lines.push(`volt_error_t ${spec.prefix}_init(${spec.prefix}_t *dev, ${shape.params})`);
    lines.push(`{`);
    // seed the struct fields from the init params so `dev` is usable
    for (const [field, param] of shape.assigns) lines.push(`    dev->${field} = ${param};`);
    lines.push(`    // TODO: probe / configure the ${spec.name}`);
    lines.push(`    log_info("${spec.prefix}", "${spec.name} ready");`);
    lines.push(`    return VOLT_OK;`);
    lines.push(`}`);
    for (const m of spec.methods || []) {
        const sig = methodSig(spec.prefix, m);
        lines.push("");
        lines.push(sig.defnHead);
        lines.push(`{`);
        lines.push(`    // TODO: implement ${m.name}`);
        if (sig.ret !== "void") lines.push(`    return ${sig.ret === "const char *" ? '""' : "0"};`);
        lines.push(`}`);
    }
    return lines.join("\n") + "\n";
}

function buildHeaderBlock(spec, shape) {
    const decls = (spec.methods || []).map(m => methodSig(spec.prefix, m).decl);
    return [
        "",
        `// ${spec.name} — ${spec.description || spec.interface + " device"} (generated)`,
        `typedef struct { ${shape.fields} } ${spec.prefix}_t;`,
        `volt_error_t ${spec.prefix}_init(${spec.prefix}_t *dev, ${shape.params});`,
        ...decls,
    ].join("\n") + "\n";
}

// All devices/ roots that exist (repo, bundled, runtime).
function deviceRoots(repoRoot) {
    const roots = [
        path.join(repoRoot, "devices"),
        path.join(repoRoot, "volt-ide", "sdk", "devices"),
        path.join(os.homedir(), ".volt", "sdk", "devices"),
    ];
    return [...new Set(roots)].filter(r => fs.existsSync(r));
}

// All framework include/ dirs that exist (for the header struct block).
function includeRoots(repoRoot) {
    const roots = [
        path.join(repoRoot, "volt-ide", "sdk", "framework", "include", "volt"),
        path.join(os.homedir(), ".volt", "sdk", "framework", "include", "volt"),
    ];
    return [...new Set(roots)].filter(r => fs.existsSync(r));
}

// Create the library. Returns { created: [paths], device: name }.
function createDevice(spec, repoRoot) {
    spec.prefix = ident(spec.prefix || spec.name);
    if (!spec.name || !spec.prefix) throw new Error("Device needs a name.");
    if (!IFACE[spec.interface]) throw new Error(`Unknown interface: ${spec.interface}`);
    const dirName = ident(spec.name);

    const shape = initShape(spec);
    const deviceJson = buildDeviceJson(spec, shape);
    const driverC = buildDriverC(spec, shape);
    const headerBlock = buildHeaderBlock(spec, shape);
    const headerFile = (IFACE[spec.interface] || IFACE.gpio).header;

    const created = [];

    // 1 + 2: device.json + driver.c into every devices/<name>/
    for (const root of deviceRoots(repoRoot)) {
        const dir = path.join(root, dirName);
        if (fs.existsSync(path.join(dir, "device.json"))) {
            throw new Error(`A device named "${dirName}" already exists (${dir}).`);
        }
    }
    for (const root of deviceRoots(repoRoot)) {
        const dir = path.join(root, dirName);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "device.json"), deviceJson);
        fs.writeFileSync(path.join(dir, "driver.c"), driverC);
        created.push(path.join(dir, "device.json"), path.join(dir, "driver.c"));
    }

    // 3: struct + prototypes appended to the interface header (skip if already there)
    for (const inc of includeRoots(repoRoot)) {
        const hp = path.join(inc, headerFile);
        if (!fs.existsSync(hp)) continue;
        const cur = fs.readFileSync(hp, "utf-8");
        if (cur.includes(`${spec.prefix}_t;`)) continue;
        // insert before the final #endif if present, else append
        const idx = cur.lastIndexOf("#endif");
        const next = idx >= 0
            ? cur.slice(0, idx) + headerBlock + "\n" + cur.slice(idx)
            : cur + headerBlock;
        fs.writeFileSync(hp, next);
        created.push(hp);
    }

    return { created, device: spec.name, dir: dirName };
}

module.exports = { createDevice, initShape, buildDeviceJson, buildDriverC, buildHeaderBlock };
