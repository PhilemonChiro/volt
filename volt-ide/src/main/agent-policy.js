// Agent permissions — how far an AI agent may go without the user.
//
// Each kind of action has a level: allow (just do it), ask (the user says yes
// each time) or never. Defaults come from Settings → AI agent permissions; a
// project can only make them stricter, in volt.toml:
//   [agent]
//   flash = "never"
// Every agent's Volt tools reach the IDE through the agent bridge, which
// enforces this; the built-in chat hosts use it to decide their approval cards.

const fs = require("fs");
const path = require("path");

const LEVELS = ["allow", "ask", "never"];

// key → label (shown in Settings and in refusals) and default level.
const ACTIONS = {
    edit:           { label: "Edit this project's code", default: "allow",
                      hint: "Every change is one undo step in the editor." },
    libraryProject: { label: "Write this project's libraries", default: "allow",
                      hint: "You still review and approve each library before it builds." },
    libraryShared:  { label: "Write shared libraries", default: "ask",
                      hint: "Libraries every project on this computer uses. You still approve each one." },
    flash:          { label: "Flash a board", default: "ask" },
    serial:         { label: "Read the serial monitor", default: "allow" },
    projects:       { label: "Open, create or list other projects", default: "ask",
                      hint: "Also file changes outside the open project (those always ask at least)." },
};

// The settings group (merged into settings.js SCHEMA).
const SETTINGS = {
    label: "AI agent permissions",
    items: Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, {
        type: "enum", default: a.default, label: a.label, hint: a.hint,
        options: [{ value: "allow", label: "Allow" }, { value: "ask", label: "Ask" }, { value: "never", label: "Never" }],
    }])),
};

const inside = (dir, file) => !!dir && !path.relative(dir, file).startsWith("..") && !path.isAbsolute(path.relative(dir, file));

/** action(tool, input, project) → the ACTIONS key a tool call falls under, or null. */
function action(tool, input = {}, project = "") {
    switch (tool) {
        case "ide_edit": case "ide_save": case "edit": case "save": return "edit";
        case "library_write": return input.scope === "project" ? "libraryProject" : "libraryShared";
        case "ide_run": case "run": return "flash";
        case "ide_serial": case "serial": return "serial";
        case "ide_open": case "ide_new_project": case "ide_projects":
        case "open": case "new_project": case "projects": return "projects";
        case "Edit": case "Write": {
            const file = String(input.file_path || "");
            return !file || !path.isAbsolute(file) || inside(project, file) ? "projectFile" : "outside";
        }
        default: return null;
    }
}

// [agent] keys from <project>/volt.toml (a flat section of key = "level").
function projectLevels(project) {
    const out = {};
    if (!project) return out;
    let text;
    try { text = fs.readFileSync(path.join(project, "volt.toml"), "utf8"); } catch (_) { return out; }
    let inAgent = false;
    for (const raw of text.split("\n")) {
        const line = raw.replace(/#.*/, "").trim();
        if (/^\[.*\]$/.test(line)) { inAgent = line === "[agent]"; continue; }
        const m = inAgent && /^([A-Za-z_]+)\s*=\s*"(allow|ask|never)"$/.exec(line);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

const stricter = (a, b) => LEVELS[Math.max(LEVELS.indexOf(a), LEVELS.indexOf(b))];

/** level(key, project, settings) → "allow" | "ask" | "never". */
function level(key, project, settings) {
    // Plain file changes aren't undo steps in the editor, so they ask at least.
    if (key === "projectFile") return stricter(level("edit", project, settings), "ask");
    if (key === "outside") return stricter(level("projects", project, settings), "ask");
    const a = ACTIONS[key];
    if (!a) return "allow";
    const set = settings && settings.get(`agentPermissions.${key}`);
    let lvl = LEVELS.includes(set) ? set : a.default;
    const proj = projectLevels(project)[key];
    if (proj) lvl = stricter(lvl, proj);
    return lvl;
}

function label(key) {
    if (key === "outside") return "Change files outside the open project";
    if (key === "projectFile") return "Change this project's files";
    return (ACTIONS[key] || {}).label || key;
}

/** refusal(key) → what the agent is told when a level is never. */
function refusal(key) {
    return `The user doesn't allow AI agents to ${label(key).toLowerCase()} (Settings → AI agent permissions, or [agent] in volt.toml). Don't try another way; tell the user if it is needed.`;
}

/** forCall(tool, input, project, getSetting) → { key, level } (key null: not covered, the host decides). */
function forCall(tool, input, project, getSetting) {
    const key = action(tool, input, project);
    return { key, level: key ? level(key, project, { get: getSetting }) : null };
}

module.exports = { LEVELS, ACTIONS, SETTINGS, action, level, label, refusal, forCall };
