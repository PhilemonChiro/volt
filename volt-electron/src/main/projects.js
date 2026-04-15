const fs = require("fs");
const path = require("path");
const os = require("os");
const { dialog } = require("electron");

const PROJECTS_DIR = path.join(os.homedir(), "Volt");

function createProject(name, chip) {
    if (!name) return null;
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });

    const projectDir = path.join(PROJECTS_DIR, name);
    if (fs.existsSync(projectDir)) {
        throw new Error(`Project '${name}' already exists`);
    }

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, "build"), { recursive: true });

    // Default LED pin per chip
    const ledPin = chip === "rp2040" ? "GP25" : chip === "stm32f103" ? "PC13" : "2";

    // v3 template — no chip in source
    const source = `hardware {
    pin led = ${ledPin}
}

every 500ms {
    led.toggle()
}
`;
    fs.writeFileSync(path.join(projectDir, "main.volt"), source);

    // volt.toml
    const toml = `[project]\nname = "${name}"\nchip = "${chip}"\n`;
    fs.writeFileSync(path.join(projectDir, "volt.toml"), toml);

    // .gitignore
    fs.writeFileSync(path.join(projectDir, ".gitignore"), "build/\n.volt/\n");

    return projectDir;
}

function listProjects() {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    return fs.readdirSync(PROJECTS_DIR)
        .filter((d) => {
            const voltFile = path.join(PROJECTS_DIR, d, "main.volt");
            return fs.existsSync(voltFile);
        })
        .map((d) => {
            const dir = path.join(PROJECTS_DIR, d);
            let chip = "esp32";
            const tomlPath = path.join(dir, "volt.toml");
            if (fs.existsSync(tomlPath)) {
                const m = fs.readFileSync(tomlPath, "utf-8").match(/chip\s*=\s*"([^"]+)"/);
                if (m) chip = m[1];
            }
            return {
                name: d,
                path: dir,
                chip,
                modified: fs.statSync(dir).mtimeMs / 1000,
            };
        })
        .sort((a, b) => b.modified - a.modified);
}

function readFile(filePath) {
    return fs.readFileSync(filePath, "utf-8");
}

function saveFile(filePath, content) {
    fs.writeFileSync(filePath, content);
}

async function browseVoltFile() {
    const result = await dialog.showOpenDialog({
        filters: [{ name: "Volt Files", extensions: ["volt"] }],
        properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    return {
        path: filePath,
        folder: path.dirname(filePath),
        content: fs.readFileSync(filePath, "utf-8"),
    };
}

module.exports = { createProject, listProjects, readFile, saveFile, browseVoltFile };
