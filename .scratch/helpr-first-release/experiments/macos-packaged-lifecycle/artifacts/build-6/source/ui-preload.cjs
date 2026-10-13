const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('lab',{send:request=>ipcRenderer.invoke('lab-request',request),onStatus:fn=>ipcRenderer.on('lab-status',(_e,s)=>fn(s)),onNotice:fn=>ipcRenderer.on('lab-notice',(_e,s)=>fn(s))});
