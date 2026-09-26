const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("launcher", {
  state: () => ipcRenderer.invoke("server:state"),
  start: () => ipcRenderer.invoke("server:start"),
  stop: () => ipcRenderer.invoke("server:stop"),
  open: () => ipcRenderer.invoke("server:open"),
  browser: () => ipcRenderer.invoke("server:browser"),
  directory: () => ipcRenderer.invoke("server:directory"),
  configure: (value) => ipcRenderer.invoke("server:configure", value),
  copy: () => ipcRenderer.invoke("server:copy"),
  subscribe: (callback) =>
    ipcRenderer.on("server:state", (_event, value) => callback(value)),
});
