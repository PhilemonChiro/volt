// Bridge: the renderer can only reach these vetted channels — never fs/crypto
// or the private key directly.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("signer", {
    getConfig:   ()          => ipcRenderer.invoke("config:get"),
    setConfig:   (cfg)       => ipcRenderer.invoke("config:set", cfg),
    listPending: ()          => ipcRenderer.invoke("pending:list"),
    getContent:  (p, v)      => ipcRenderer.invoke("content:get", p, v),
    signPublish: (p, v)      => ipcRenderer.invoke("sign:publish", p, v),
    reject:      (p, v, r)   => ipcRenderer.invoke("library:reject", p, v, r),
});
