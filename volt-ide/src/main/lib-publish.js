// lib-publish.js — publish a device library from this computer to the Grid.
//
// A library folder (device.json, driver.c, header.h) becomes a Grid submission:
// the header is converted to the structured spec the Grid installs from (it
// never ships raw header C), capabilities the driver needs are filled in from
// the Grid's own pre-screen, and AI-assisted libraries are labelled so the
// reviewer knows. Every public library is reviewed and signed by a Volt
// maintainer before anyone can install it.

const fs = require("fs");
const path = require("path");

// ── header.h → structured spec ────────────────────────────────────────────

function splitParams(s) {
    return String(s || "").split(",").map(x => x.trim()).filter(Boolean).map(p => {
        const m = p.match(/^(.*?)(\w+)\s*$/);
        return m ? [m[2], m[1].trim()] : [p, ""];
    });
}

// headerSpec reads the struct and prototypes from header.h; methods come from
// device.json (its names and return types), with parameters from header.h.
function headerSpec(prefix, headerC, device) {
    const errors = [];
    const strip = String(headerC || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // The struct body holds no braces, so match only this prefix's typedef.
    const sm = strip.match(new RegExp(`typedef\\s+struct\\s*\\w*\\s*\\{([^{}]*)\\}\\s*${prefix}_t\\s*;`));
    if (!sm) errors.push(`no "typedef struct { … } ${prefix}_t;" found for this library (add a header.h)`);
    const fields = [];
    for (const decl of (sm ? sm[1] : "").split(";").map(x => x.trim()).filter(Boolean)) {
        // "uint8_t bus_id, addr" / "int16_t buf[8]" → one field per name
        const parts = decl.split(",").map(x => x.trim());
        const first = parts[0].match(/^(.*?)(\w+)\s*(?:\[\s*(\d+)\s*\])?$/);
        if (!first || !first[1].trim()) { errors.push(`can't read struct field "${decl}"`); continue; }
        const type = first[1].trim();
        for (const [k, part] of parts.entries()) {
            const m = k === 0 ? first : part.match(/^(\w+)\s*(?:\[\s*(\d+)\s*\])?$/);
            if (!m) { errors.push(`can't read struct field "${part}"`); continue; }
            const name = k === 0 ? m[2] : m[1], size = k === 0 ? m[3] : m[2];
            fields.push(size ? [name, type, Number(size)] : [name, type]);
        }
    }
    const init = strip.match(new RegExp(`volt_error_t\\s+${prefix}_init\\s*\\(\\s*${prefix}_t\\s*\\*\\s*\\w+\\s*(?:,([^)]*))?\\)`));
    const protos = {};
    const re = new RegExp(`([\\w\\s\\*]+?)\\s*\\b${prefix}_(\\w+)\\s*\\(\\s*${prefix}_t\\s*\\*\\s*\\w+\\s*(?:,([^)]*))?\\)\\s*;`, "g");
    let m;
    while ((m = re.exec(strip))) if (m[2] !== "init") protos[m[2]] = { params: splitParams(m[3]), cRet: m[1].replace(/\s*\*\s*/g, " *").replace(/\s+/g, " ").trim() };
    // c_ret is the exact C return type of the prototype, so the header an
    // install regenerates matches the driver's definitions.
    const methods = Object.entries((device && device.methods) || {}).map(([name, d]) => ({
        name, ret: (d && d.returns) || "void",
        ...(protos[name] ? { c_ret: protos[name].cRet } : {}),
        params: protos[name] ? protos[name].params : (Array.isArray(d && d.params) ? d.params.map(p => Array.isArray(p) ? p : [p.name, p.type]) : []),
    }));
    return { spec: { struct_name: `${prefix}_t`, fields, init_params: init ? splitParams(init[1]) : [], methods }, errors };
}

// ── building + checking a submission ─────────────────────────────────────

function readLibrary(dir) {
    const read = (n) => { try { return fs.readFileSync(path.join(dir, n), "utf8"); } catch (_) { return null; } };
    let device = null;
    try { device = JSON.parse(read("device.json")); } catch (e) { throw new Error(`device.json isn't valid JSON: ${e.message}`); }
    if (!device) throw new Error("This library has no device.json.");
    let driver = read("driver.c");
    let header = read("header.h");
    // A variant (LCD16x2, DHT22) shares another library's driver: its c_prefix folder.
    const shared = String(device.c_prefix || "").toLowerCase();
    if (!driver && shared && shared !== path.basename(dir)) {
        const sib = (n) => { try { return fs.readFileSync(path.join(dir, "..", shared, n), "utf8"); } catch (_) { return null; } };
        driver = sib("driver.c");
        header = header || sib("header.h");
    }
    if (!driver) throw new Error("This library has no driver.c.");
    if (!header) {
        // Older libraries (and the library creator) declare themselves in the
        // shared framework headers: read the declarations from there.
        const inc = path.join(dir, "..", "..", "framework", "include", "volt");
        try { header = fs.readdirSync(inc).filter(n => n.endsWith(".h")).map(n => fs.readFileSync(path.join(inc, n), "utf8")).join("\n"); }
        catch (_) { header = ""; }
    }
    return { device, driver, header };
}

function build(dir, { version, description, aiAssisted, capabilities }) {
    const { device, driver, header } = readLibrary(dir);
    const prefix = String(device.c_prefix || path.basename(dir)).toLowerCase();
    const dev = { ...device, c_prefix: prefix, c_source: "driver.c", ...(description ? { description } : {}) };
    const { spec, errors } = headerSpec(prefix, header, dev);
    const caps = [...new Set([...(capabilities || []), dev.interface].filter(Boolean))];
    return {
        submission: {
            manifest: { prefix, name: dev.name || prefix, version, interface: dev.interface, trustTier: "community",
                capabilities: caps, ...(aiAssisted ? { aiAssisted: true } : {}) },
            device: dev, driver: { common: driver }, header: spec,
        },
        convertErrors: errors,
    };
}

// localCheck runs the Grid's pre-screen rules offline (vlib-import mirrors
// them), adding capabilities the driver needs, so a library that could never
// be published is caught when it is written, not when it is shared.
function localCheck(dir) {
    const { validate } = require("./vlib-import");
    let caps = [];
    for (let round = 0; ; round++) {
        let built;
        try { built = build(dir, { version: "1.0.0", capabilities: caps }); }
        catch (e) { return { errors: [e.message], warnings: [], capabilities: caps }; }
        const res = validate(built.submission);
        const errors = [...built.convertErrors, ...(res.errors || [])];
        const missing = errors.map(e => (e.match(/doesn't declare capability "(\w+)"/) || [])[1]).filter(Boolean);
        if (missing.length && round < 2) { caps = [...new Set([...caps, ...missing])]; continue; }
        return { errors, warnings: res.warnings || [], capabilities: built.submission.manifest.capabilities };
    }
}

// check runs the Grid's pre-screen, adding capabilities it says are missing.
async function check(gridUrl, dir, opts) {
    let caps = opts.capabilities || [];
    for (let round = 0; round < 3; round++) {
        const { submission, convertErrors } = build(dir, { ...opts, capabilities: caps });
        const r = await fetch(`${gridUrl}/api/v1/libraries/validate`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission),
        }).catch(() => null);
        if (!r) throw new Error("Couldn't reach the Grid — check your connection.");
        const j = await r.json().catch(() => ({}));
        const res = j.data || j;
        const errors = [...convertErrors, ...(res.errors || [])];
        const missing = errors.map(e => (e.match(/doesn't declare capability "(\w+)"/) || [])[1]).filter(Boolean);
        if (missing.length && round < 2) { caps = [...new Set([...caps, ...missing])]; continue; }
        return { submission, errors, warnings: res.warnings || [], capabilities: submission.manifest.capabilities };
    }
}

async function submit(gridUrl, token, submission) {
    const r = await fetch(`${gridUrl}/api/v1/libraries`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(submission),
    }).catch(() => null);
    if (!r) throw new Error("Couldn't reach the Grid — check your connection.");
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error("Sign in with GitHub to publish.");
    if (r.status === 403) throw new Error(`Someone else already publishes “${submission.manifest.prefix}”. Pick another name (prefix) for your library.`);
    if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || j.message || `Grid: HTTP ${r.status}`);
    return j.data || j;
}

async function mine(gridUrl, token) {
    const r = await fetch(`${gridUrl}/api/v1/libraries/mine`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (!r || !r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return j.data || j || [];
}

// nextVersion suggests the version after what the user already submitted.
function nextVersion(list, prefix, fallback) {
    const vs = list.filter(x => x.prefix === prefix).map(x => x.version)
        .filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => {
            const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
            return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
        });
    const local = fallback && /^\d+\.\d+\.\d+$/.test(fallback) ? fallback : null;
    if (!vs.length) return local || "1.0.0";
    const last = vs[vs.length - 1];
    const [a, b, c] = last.split(".").map(Number);
    // A version set in device.json that's ahead of the Grid wins over a patch bump.
    const [x, y, z] = local ? local.split(".").map(Number) : [];
    if (local && (x - a || y - b || z - c) > 0) return local;
    return `${a}.${b}.${c + 1}`;
}

module.exports = { build, check, localCheck, submit, mine, nextVersion, headerSpec, readLibrary };
