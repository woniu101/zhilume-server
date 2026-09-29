const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("zhilumeAdmin", {
  openStorage: () => ipcRenderer.invoke("admin:open-storage"),
  session: () => ipcRenderer.invoke("admin:session"),
});
