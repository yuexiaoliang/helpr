const {ipcRenderer}=require('electron');
window.addEventListener('DOMContentLoaded',()=>{
 for(const type of ['pointerdown','keydown','input','beforeinput','compositionstart','compositionend','paste'])document.addEventListener(type,event=>{
  const target=event.target?.id;if(!['manualClick','ime','paste','autoTyping'].includes(target))return;
  ipcRenderer.send('lab-dom',{type,target,isTrusted:event.isTrusted,inputType:event.inputType,data:event.data,isComposing:event.isComposing,value:event.target.value});
 },true);
});
