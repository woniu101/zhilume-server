const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("zhilumeAdmin", {
  session: () => ipcRenderer.invoke("admin:session"),
});
