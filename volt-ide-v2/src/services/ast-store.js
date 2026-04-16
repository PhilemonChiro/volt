// ASTStore — single source of truth for all panels
// Compiles on keystroke, notifies subscribers

import { compileFull } from "./compiler.js";

let ast = null;
let cCode = "";
let errors = [];
let listeners = [];
let timer = null;

export function subscribe(callback) {
    listeners.push(callback);
    // Return unsubscribe function
    return () => { listeners = listeners.filter(fn => fn !== callback); };
}

export function scheduleCompile(source) {
    clearTimeout(timer);
    timer = setTimeout(() => compile(source), 300);
}

export async function compile(source) {
    try {
        const result = await compileFull(source);
        ast = {
            pins: result.pins || [],
            devices: result.devices || [],
            buses: result.buses || [],
            tasks: result.tasks || [],
            machines: result.machines || [],
            channels: result.channels || [],
            enums: result.enums || [],
            chip: result.chip || "esp32",
        };
        cCode = result.c_code || "";
        errors = result.diagnostics || [];
        listeners.forEach(fn => fn(ast, cCode, errors));
    } catch (e) {
        console.warn("[ast-store] compile failed:", e);
    }
}

export function getAST() { return ast; }
export function getCCode() { return cCode; }
export function getErrors() { return errors; }
