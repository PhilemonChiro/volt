// Hardened .vlib importer — the containment layer. Even a validly-signed library
// is treated as untrusted content: it can only ever become device.json + driver.c
// under devices/<name>/, its header is REGENERATED from a structured spec (never
// pasted as raw C), its capabilities are declared + scanned, and its init_args
// template is placeholder-allowlisted. A review miss cannot escape this box.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { verify } = require("./vlib-verify");

const NAME_RE = /^[a-z0-9_]{1,32}$/;
const IFACES = new Set(["i2c", "gpio", "spi", "uart"]);
const CAPS = new Set(["i2c", "spi", "gpio", "uart", "network", "storage"]);
const RET_TYPES = new Set(["float", "int", "int32_t", "bool", "void", "const char *"]);
const FIELD_TYPES = new Set(["uint8_t", "uint16_t", "uint32_t", "int8_t", "int16_t", "int32_t", "int", "float", "bool"]);
const RET_MAP = { float: "float", int: "int32_t", bool: "bool", void: "void", string: "const char *" };

// Framework HAL symbols a driver may call. Anything a driver references beyond
// these + C stdlib basics is flagged for review (or blocked). Capability-gated
// families (network/storage) must be DECLARED to be allowed.
const API_ALLOW = [
    /^volt_i2c_/, /^volt_spi_/, /^volt_uart_/, /^pin_/, /^log_/, /^volt_delay/, /^volt_tick_/,
    /^hd44780_/, /^gpio_/, /^adc_/, /^dac_/, /^VOLT_/, /^GPIO_/, /^HIGH$/, /^LOW$/,
];
const CAP_SYMS = {
    network: [/^volt_wifi_/, /^volt_mqtt_/, /^volt_http_/, /^esp_wifi_/, /^socket/, /^connect\(/],
    storage: [/^volt_storage_/, /^nvs_/, /^fopen/, /^fwrite/],
};
// Outright-forbidden — no legitimate device driver needs these.
const FORBIDDEN = [
    /\bsystem\s*\(/, /\bexec[lv]/, /\bpopen\s*\(/, /\bfork\s*\(/, /\bdlopen\s*\(/,
    /#\s*include\s*<\s*(stdlib|unistd|sys\/)/, /\b__asm__?\b/, /\bmmap\s*\(/,
];

function ident(s) { return String(s || "").trim().toLowerCase(); }

// devices/ roots to write into (repo, bundled, runtime — whichever exist).
function deviceRoots(repoRoot) {
    return [
        path.join(repoRoot, "devices"),
        path.join(repoRoot, "volt-ide", "sdk", "devices"),
        path.join(os.homedir(), ".volt", "sdk", "devices"),
    ].filter((r, i, a) => a.indexOf(r) === i && fs.existsSync(r));
}
function includeRoots(repoRoot) {
    // Must mirror deviceRoots one-for-one: the generated struct header has to
    // land in the SAME tree as the driver, or the build compiles the driver
    // (from devices/) against a sensor.h that lacks its <prefix>_t struct.
    return [
        path.join(repoRoot, "framework", "include", "volt"),
        path.join(repoRoot, "volt-ide", "sdk", "framework", "include", "volt"),
        path.join(os.homedir(), ".volt", "sdk", "framework", "include", "volt"),
    ].filter((r, i, a) => a.indexOf(r) === i && fs.existsSync(r));
}
const HEADER_BY_IFACE = { i2c: "sensor.h", uart: "sensor.h", gpio: "gpio_devices.h", spi: "spi_devices.h" };
const HEADER_FILES = ["sensor.h", "gpio_devices.h", "spi_devices.h"];

// Lockfile lives OUTSIDE any devices/ dir (so the registry never parses it).
function lockPath() { return path.join(os.homedir(), ".volt", "installed-libs.json"); }
function readLock() { try { return JSON.parse(fs.readFileSync(lockPath(), "utf-8")); } catch (_) { return {}; } }
function installedInfo(prefix) { const db = readLock(); return db[prefix] || null; }

// ---- validation ----------------------------------------------------------
// Returns { errors: [], warnings: [], prefix, name, driverC } (driverC = chosen source).
function validate(envelope) {
    const errors = [], warnings = [];
    const m = envelope.manifest || {}, d = envelope.device || {}, h = envelope.header || {};

    const prefix = ident(d.c_prefix);
    if (!NAME_RE.test(prefix)) errors.push(`invalid c_prefix "${d.c_prefix}"`);
    if (m.prefix && ident(m.prefix) !== prefix) errors.push("manifest/device prefix mismatch");
    if (!IFACES.has(d.interface)) errors.push(`invalid interface "${d.interface}"`);
    if (d.c_source && d.c_source !== "driver.c") errors.push("c_source must be driver.c");

    // capabilities declared, all known
    const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
    for (const c of caps) if (!CAPS.has(c)) errors.push(`unknown capability "${c}"`);

    // init_args: only bare {identifier} placeholders
    const tmpl = String(d.init_args || "");
    const badTok = tmpl.replace(/\{[a-z_][a-z0-9_]*\}/gi, "").match(/[{}]/);
    if (badTok) errors.push("init_args has a non-placeholder brace (possible injection)");

    // methods: names identifiers, returns in the allowed set
    for (const [mn, mv] of Object.entries(d.methods || {})) {
        if (!/^[a-z_][a-z0-9_]*$/i.test(mn)) errors.push(`bad method name "${mn}"`);
        if (mv && mv.returns && !["float", "int", "bool", "void", "string"].includes(mv.returns))
            errors.push(`method "${mn}" has bad return "${mv.returns}"`);
    }

    // header spec: struct name + field/param/method types allowlisted
    if (h.struct_name && h.struct_name !== `${prefix}_t`) errors.push("header struct name mismatch");
    const checkTypes = (arr, kind, allowArray) => (arr || []).forEach(([n, t, size]) => {
        if (!/^[a-z_][a-z0-9_]*$/i.test(n || "")) errors.push(`bad ${kind} name "${n}"`);
        if (!FIELD_TYPES.has(t)) errors.push(`disallowed ${kind} type "${t}"`);
        // optional 3rd element = fixed array size (fields only); bounded so a
        // crafted spec can't emit an absurd static allocation into the header.
        if (size !== undefined) {
            if (!allowArray) errors.push(`${kind} "${n}" may not be an array`);
            else if (!Number.isInteger(size) || size < 1 || size > 65536) errors.push(`${kind} "${n}" has invalid array size`);
        }
    });
    checkTypes(h.fields, "field", true);
    checkTypes(h.init_params, "init param", false);

    // driver source (per-chip or common)
    const driver = envelope.driver || {};
    const driverC = driver.common || driver.esp32 || driver.rp2040 || "";
    if (!driverC.trim()) errors.push("empty driver source");
    if (driverC.length > 200 * 1024) errors.push("driver source too large");

    // static scan
    for (const re of FORBIDDEN) if (re.test(driverC)) errors.push(`driver uses forbidden construct: ${re}`);
    // extract called symbols once — capability + HAL checks both run against these
    const calls = new Set((driverC.match(/\b[a-z_][a-z0-9_]{2,}\s*\(/gi) || []).map(s => s.replace(/\s*\($/, "")));
    // capability enforcement: a cap-gated symbol used but not declared → error
    for (const [cap, syms] of Object.entries(CAP_SYMS)) {
        const used = [...calls].some(c => syms.some(re => re.test(c)));
        if (used && !caps.includes(cap)) errors.push(`driver uses ${cap} APIs but doesn't declare capability "${cap}"`);
    }
    // symbols not on the HAL allowlist → warn (reviewer/user sees them)
    const CSTD = /^(if|for|while|switch|return|sizeof|memcpy|memset|snprintf|strlen|strcmp|uint8_t|int|float)$/i;
    for (const c of calls) {
        if (CSTD.test(c)) continue;
        if (API_ALLOW.some(re => re.test(c))) continue;
        if (Object.values(CAP_SYMS).some(arr => arr.some(re => re.test(c)))) continue;
        warnings.push(`driver calls non-HAL symbol: ${c}()`);
    }

    return { errors, warnings, prefix, name: d.name || prefix, driverC, caps };
}

// Normalize a field/param entry to { name, type, size }. Envelopes carry these
// in two shapes: array tuples [name, type, size?] (public/signed libs) and
// objects { name, type } (private-collection libs). Accept both so install
// never throws "object is not iterable" destructuring one as the other.
function nt(x) {
    if (Array.isArray(x)) return { name: x[0], type: x[1], size: x[2] };
    if (x && typeof x === "object") return { name: x.name, type: x.type, size: x.size };
    return { name: "", type: "" };
}

// The HAL header for each interface (where volt_i2c_*/volt_spi_*/volt_uart_*/
// pin_* live). gpio devices talk to pins via volt/pin.h.
const BUS_HEADER = { i2c: "i2c", spi: "spi", uart: "uart", gpio: "pin" };

// Prepend the framework includes a standalone driver.c needs to compile in a
// real build: its struct header (which also chains in volt_error_t via
// error.h), the interface HAL, task/log, and the C stdlib bits drivers use.
// Existing quoted / <volt/...> includes in the body are dropped first so the
// canonical set is authoritative and never doubled with a stale path.
function withFrameworkIncludes(driverC, prefix, iface, headerFile) {
    const bus = BUS_HEADER[iface];
    const preamble = [
        `// ${prefix} driver — framework includes added on install`,
        `#include <stdint.h>`,
        `#include <stdbool.h>`,
        `#include <stddef.h>`,
        `#include <string.h>`,
        `#include <stdio.h>`,
        `#include "volt/${headerFile}"`,
        bus ? `#include "volt/${bus}.h"` : null,
        `#include "volt/task.h"`,
        `#include "volt/log.h"`,
    ].filter(Boolean).join("\n") + "\n\n";
    const body = (driverC || "")
        .replace(/^[ \t]*#\s*include\s+"[^"]*".*\n?/gm, "")        // quoted includes
        .replace(/^[ \t]*#\s*include\s+<volt\/[^>]*>.*\n?/gm, "")  // <volt/...>
        .replace(/^\n+/, "");
    return preamble + body;
}

// Regenerate the header block from the STRUCTURED spec — never trust raw C.
function buildHeader(prefix, h) {
    const fields = (h.fields || []).map(nt).map(({ name, type, size }) => size ? `${type} ${name}[${size}];` : `${type} ${name};`).join(" ");
    const initP = (h.init_params || []).map(nt).map(({ name, type }) => `${type} ${name}`).join(", ");
    const methodDecls = (h.methods || []).map(mm => {
        const ret = RET_MAP[mm.ret] || RET_TYPES.has(mm.ret) ? (RET_MAP[mm.ret] || mm.ret) : "int32_t";
        const ps = (mm.params || []).map(nt).map(({ name, type }) => `${type} ${name}`);
        return `${ret} ${prefix}_${mm.name}(${[`${prefix}_t *dev`, ...ps].join(", ")});`;
    });
    return [
        "",
        `// ${prefix} (installed library — generated header)`,
        `typedef struct { ${fields} } ${prefix}_t;`,
        `volt_error_t ${prefix}_init(${prefix}_t *dev${initP ? ", " + initP : ""});`,
        ...methodDecls,
    ].join("\n") + "\n";
}

// ---- public API ----------------------------------------------------------

// Verify + validate WITHOUT writing. Powers the consent UI.
function inspect(envelope, opts = {}) {
    const v = verify(envelope, opts);
    if (!v.ok) return { ok: false, stage: "verify", reason: v.reason };
    const val = validate(envelope);

    // Update awareness — the poisoned-update defense. If this prefix is already
    // installed at a DIFFERENT content hash, surface it as an explicit update
    // (with a capability diff) so the consent UI can require re-approval. Same
    // hash → already installed (no-op).
    const cur = installedInfo(val.prefix);
    let update = null, alreadyInstalled = false;
    if (cur) {
        if (cur.hash === v.hash) alreadyInstalled = true;
        else update = {
            fromVersion: cur.version, toVersion: envelope.manifest.version,
            fromTier: cur.tier, toTier: envelope.manifest.trustTier,
            capsAdded: (val.caps || []).filter(c => !(cur.capabilities || []).includes(c)),
        };
    }

    return {
        ok: val.errors.length === 0,
        stage: "validate",
        errors: val.errors,
        warnings: val.warnings,
        manifest: envelope.manifest,
        device: envelope.device,   // full spec sheet: specs, wiring, tips, alternatives, methods
        capabilities: val.caps,
        driver: val.driverC,
        keyId: v.keyId,
        hash: v.hash,
        update,
        alreadyInstalled,
    };
}

// Verify + validate + write. Re-verifies in the main process (never trusts a
// renderer's "it's fine"). Writes ONLY devices/<prefix>/ + the header block.
function install(envelope, repoRoot, opts = {}) {
    // opts.local: a PRIVATE library from the user's own authenticated collection.
    // Trust is the authenticated session (fetched over TLS from /me/collection),
    // not the registry signature — so we skip signature verification. The SAME
    // hardened static validation still runs (a private lib still can't use
    // forbidden constructs), and it's marked "private" so the UI flags it.
    let v, tier;
    if (opts.local) {
        v = { hash: "", keyId: "local" };
        tier = "private";
    } else {
        v = verify(envelope, opts);
        if (!v.ok) throw new Error(`signature: ${v.reason}`);
        tier = envelope.manifest.trustTier;
    }
    const val = validate(envelope);
    if (val.errors.length) throw new Error(`validation: ${val.errors[0]}`);

    const prefix = val.prefix;
    if (!NAME_RE.test(prefix)) throw new Error("unsafe device name");
    const deviceJson = JSON.stringify(envelope.device, null, 2) + "\n";
    const headerBlock = buildHeader(prefix, envelope.header || {});
    const headerFile = HEADER_BY_IFACE[envelope.device.interface] || "gpio_devices.h";
    // The studio stores drivers with framework includes stripped (its syntax
    // check re-adds them via a preamble). For a real firmware build each
    // driver.c is its own translation unit, so it must include the framework
    // headers that declare its <prefix>_t struct, volt_error_t, and the HAL it
    // calls — otherwise the ESP-IDF build fails with "unknown type name".
    const driverC = withFrameworkIncludes(val.driverC, prefix, envelope.device.interface, headerFile);

    const written = [];
    // path safety: join + confirm the resolved dir stays under the root
    for (const root of deviceRoots(repoRoot)) {
        const dir = path.join(root, prefix);
        if (path.relative(root, dir).includes("..") || path.isAbsolute(path.relative(root, dir)))
            throw new Error("path traversal blocked");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "device.json"), deviceJson);
        fs.writeFileSync(path.join(dir, "driver.c"), driverC);
        written.push(path.join(dir, "device.json"), path.join(dir, "driver.c"));
    }
    for (const inc of includeRoots(repoRoot)) {
        const hp = path.join(inc, headerFile);
        if (!fs.existsSync(hp)) continue;
        const cur = fs.readFileSync(hp, "utf-8");
        if (cur.includes(`${prefix}_t;`)) continue;
        const idx = cur.lastIndexOf("#endif");
        fs.writeFileSync(hp, idx >= 0 ? cur.slice(0, idx) + headerBlock + "\n" + cur.slice(idx) : cur + headerBlock);
        written.push(hp);
    }

    // lockfile: pin version + content hash + capabilities so updates are explicit.
    const db = readLock();
    db[prefix] = {
        name: envelope.manifest.name, version: envelope.manifest.version,
        hash: v.hash, keyId: v.keyId, tier,
        interface: envelope.device.interface, capabilities: val.caps,
        installedAt: new Date().toISOString(),
    };
    try {
        fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
        fs.writeFileSync(lockPath(), JSON.stringify(db, null, 2) + "\n");
    } catch (_) {}

    return { installed: envelope.manifest.name, prefix, version: envelope.manifest.version, written };
}

// List installed libraries (from the lockfile).
function list() {
    const db = readLock();
    return Object.entries(db).map(([prefix, v]) => ({ prefix, ...v }));
}

// Remove an installed library: delete its devices/<prefix>/ from every copy,
// strip its generated header block, and drop the lockfile entry.
function uninstall(prefix, repoRoot) {
    if (!NAME_RE.test(prefix)) throw new Error("invalid device name");
    const removed = [];
    for (const root of deviceRoots(repoRoot)) {
        const dir = path.join(root, prefix);
        // path safety: never delete outside the devices root
        if (path.relative(root, dir).startsWith("..")) continue;
        if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removed.push(dir); }
    }
    const blockRe = new RegExp(`\\b${prefix}_`);
    for (const inc of includeRoots(repoRoot)) {
        for (const hf of HEADER_FILES) {
            const hp = path.join(inc, hf);
            if (!fs.existsSync(hp)) continue;
            const cur = fs.readFileSync(hp, "utf-8");
            if (!cur.includes(`${prefix}_t;`)) continue;
            const lines = cur.split("\n");
            const out = [];
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(`// ${prefix} (installed library`)) {
                    // drop the comment + all consecutive lines that reference the prefix
                    let j = i + 1;
                    while (j < lines.length && blockRe.test(lines[j])) j++;
                    i = j - 1;
                    continue;
                }
                out.push(lines[i]);
            }
            fs.writeFileSync(hp, out.join("\n"));
            removed.push(hp);
        }
    }
    const db = readLock();
    delete db[prefix];
    try { fs.writeFileSync(lockPath(), JSON.stringify(db, null, 2) + "\n"); } catch (_) {}
    return { uninstalled: prefix, removed };
}

module.exports = { inspect, install, validate, buildHeader, list, uninstall, installedInfo };
