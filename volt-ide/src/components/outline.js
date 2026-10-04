// Outline of a Volt file, read from the live source (follows keystrokes,
// even on broken syntax): what runs, what data it keeps, its functions.
// Pins and devices live in the Hardware panel, so they're left out.
//
// { runs: [{ kind, name, detail, line, children: [{ name, line }] }],
//   data: [{ kind, name, detail, line }], funcs: [{ name, detail, line }] }

// Comments and string contents blanked out (same length, newlines kept)
// so braces and keywords inside them don't count.
function clean(src) {
    let out = "";
    for (let i = 0; i < src.length; i++) {
        const c = src[i], n = src[i + 1];
        if (c === "/" && n === "/") {
            while (i < src.length && src[i] !== "\n") { out += " "; i++; }
            i--;
        } else if (c === "/" && n === "*") {
            const end = src.indexOf("*/", i + 2);
            const stop = end < 0 ? src.length : end + 2;
            for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " ";
            i--;
        } else if (c === '"' || c === "'") {
            out += c;
            for (i++; i < src.length && src[i] !== c && src[i] !== "\n"; i++) {
                if (src[i] === "\\") { out += " "; i++; }
                out += " ";
            }
            if (i < src.length) out += src[i];
        } else out += c;
    }
    return out;
}

export function outline(source) {
    const runs = [], data = [], funcs = [];
    if (typeof source !== "string") return { runs, data, funcs };
    const lines = clean(source).split("\n");
    let depth = 0;
    let parent = null;          // the depth-0 run block we're inside
    lines.forEach((raw, idx) => {
        const line = idx + 1;
        const t = raw.trim();
        if (depth === 0 && t) {
            parent = null;
            let m;
            if (/^setup\s*\{/.test(t)) runs.push(parent = { kind: "setup", name: "setup", detail: "once at boot", line, children: [] });
            else if (/^loop\s*\{/.test(t)) runs.push(parent = { kind: "loop", name: "loop", detail: "forever", line, children: [] });
            else if ((m = t.match(/^every\s+(\S+)(\s+strict)?(?:\s+when\s+(.+?))?\s*\{/)))
                runs.push(parent = { kind: "every", name: `every ${m[1]}`, detail: [m[2] && "strict", m[3] && `when ${m[3]}`].filter(Boolean).join(" · "), line, children: [] });
            else if ((m = t.match(/^(?:@\w+(?:\([^)]*\))?\s+)*task\s+(\w+)/)))
                runs.push(parent = { kind: "task", name: m[1], detail: "", line, children: [] });
            else if ((m = t.match(/^on\s+(.+?)\s*\{/)))
                runs.push(parent = { kind: "on", name: `on ${m[1]}`, detail: "", line, children: [] });
            else if ((m = t.match(/^machine\s+(\w+)/)))
                runs.push(parent = { kind: "machine", name: m[1], detail: "", line, children: [] });
            else if ((m = t.match(/^func\s+(\w+)\s*(\([^)]*\))?\s*(->\s*[^{]+)?/)))
                funcs.push({ name: m[1], detail: `${m[2] || "()"}${m[3] ? " " + m[3].trim() : ""}`, line });
            else if ((m = t.match(/^(shared\s+)?(?:var|let|const)\s+(\w+)\s*(?::\s*([^=]+?))?\s*=/)))
                data.push({ kind: m[1] ? "shared" : "var", name: m[2], detail: [m[1] && "shared", m[3]].filter(Boolean).join(" "), line });
            else if ((m = t.match(/^storage\s+(\w+)\s*:\s*([^=]+?)\s*=/)))
                data.push({ kind: "storage", name: m[1], detail: `${m[2]} · kept across reboots`, line });
            else if ((m = t.match(/^channel\s+(\w+)\s*:\s*(\w+)(?:\[(\d+)\])?/)))
                data.push({ kind: "channel", name: m[1], detail: `channel ${m[2]}${m[3] ? ` × ${m[3]}` : ""}`, line });
            else if ((m = t.match(/^struct\s+(\w+)/))) data.push({ kind: "struct", name: m[1], detail: "struct", line });
            else if ((m = t.match(/^enum\s+(\w+)\s*\{([^}]*)\}?/)))
                data.push({ kind: "enum", name: m[1], detail: m[2] ? m[2].split(",").map(s => s.trim()).filter(Boolean).join(" · ") : "enum", line });
        } else if (depth === 1 && parent && t) {
            let m;
            // A task's schedule, a machine's states.
            if (parent.kind === "task" && (m = t.match(/^(every\s+\S+|on\s+.+?)\s*\{/)))
                parent.children.push({ name: m[1], line });
            else if (parent.kind === "machine" && (m = t.match(/^(initial\s+)?state\s+(\w+)/)))
                parent.children.push({ name: m[2] + (m[1] ? " (start)" : ""), line });
        }
        for (const c of raw) {
            if (c === "{") depth++;
            else if (c === "}") depth = Math.max(0, depth - 1);
        }
    });
    for (const r of runs) {
        if (r.kind === "machine") r.detail = `${r.children.length} state${r.children.length === 1 ? "" : "s"}`;
        if (r.kind === "task" && r.children.length === 1) { r.detail = r.children[0].name; r.children = []; }
    }
    return { runs, data, funcs };
}
