// Project service — create, open, save, list
const api = window.volt;

export async function createProject(name, chip) {
    return api.createProject(name, chip);
}

export async function listProjects() {
    return api.listProjects();
}

export async function readFile(path) {
    return api.readFile(path);
}

export async function saveFile(path, content) {
    return api.saveFile(path, content);
}

export async function browseVoltFile() {
    return api.browseVoltFile();
}
