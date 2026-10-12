const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('takeoverLab',{
 command:(name,value)=>ipcRenderer.invoke('lab-command',name,value),
 onState:callback=>ipcRenderer.on('lab-state',(_event,state)=>callback(state))
});
