const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hostLab', {
  command: (name, value) => ipcRenderer.invoke('lab-command', name, value),
  status: () => ipcRenderer.invoke('lab-status')
});
