// Exposes a narrow, safe API to the renderer. The renderer gets no direct access
// to node, the filesystem, the signing key, or the admin secret — only these
// typed IPC calls, all handled in the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("signer", {
    getConfig: () => ipcRenderer.invoke("config:get"),
    setConfig: (patch) => ipcRenderer.invoke("config:set", patch),
    listPending: () => ipcRenderer.invoke("pending:list"),
    getContent: (prefix, version) => ipcRenderer.invoke("content:get", prefix, version),
    sign: (prefix, version) => ipcRenderer.invoke("sign", prefix, version),
    reject: (prefix, version, reason) => ipcRenderer.invoke("reject", prefix, version, reason),
});
