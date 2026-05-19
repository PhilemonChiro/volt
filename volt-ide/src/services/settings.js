// Settings service — renderer-side cache + subscription layer.
//
// Components import `get(key)` to read settings synchronously, and
// `onChange((key, value) => ...)` to react when a setting is updated.
// The cache is hydrated once at startup; `settings:changed` events from
// the main process keep it in sync.

const api = window.volt;

let cache = {};
let schema = {};
let listeners = [];
let ready = false;
let readyPromise = null;

export function init() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
        try {
            schema = await api.settingsSchema();
            cache = await api.settingsAll();
            ready = true;
        } catch (e) {
            console.warn("[settings] init failed:", e);
            schema = {};
            cache = {};
        }
        api.onSettingsChanged?.(({ key, value }) => {
            if (key === "*") {
                cache = { ...value };
                listeners.forEach(fn => fn("*", cache));
            } else {
                cache[key] = value;
                listeners.forEach(fn => fn(key, value));
            }
        });
    })();
    return readyPromise;
}

export function isReady() { return ready; }
export function getSchema() { return schema; }
export function getAll() { return { ...cache }; }

export function get(key, fallback = undefined) {
    if (key in cache) return cache[key];
    return fallback;
}

export async function set(key, value) {
    try {
        const updated = await api.settingsSet(key, value);
        cache[key] = updated;
        return updated;
    } catch (e) {
        console.warn("[settings] set failed:", key, e);
        return cache[key];
    }
}

export async function reset() {
    try {
        cache = await api.settingsReset();
        return cache;
    } catch (e) {
        console.warn("[settings] reset failed:", e);
        return cache;
    }
}

export function openFile() {
    return api.settingsOpenFile?.();
}

export function onChange(callback) {
    listeners.push(callback);
    return () => { listeners = listeners.filter(fn => fn !== callback); };
}
