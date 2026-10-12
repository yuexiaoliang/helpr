const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('helpr',{status:()=>ipcRenderer.invoke('helpr:request',{kind:'status'}),invalid:()=>ipcRenderer.invoke('helpr:request',{kind:'readFile',path:'/not-a-real-secret'})});
