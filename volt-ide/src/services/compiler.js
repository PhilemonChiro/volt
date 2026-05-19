// Compiler service — calls Python compiler via IPC
const api = window.volt;

export async function compileFull(source) {
    return api.compileFull(source);
}

export async function checkCode(source) {
    return api.checkCode(source);
}

export async function findSymbols(source) {
    return api.findSymbols(source);
}
