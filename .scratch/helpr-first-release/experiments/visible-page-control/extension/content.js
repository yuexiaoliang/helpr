(() => {
  if (!document.querySelector('#identity')) return;
  chrome.runtime.sendMessage({kind:'identify'}, ids=>{
    document.documentElement.dataset.labTabId=String(ids.tabId);
    const panel=document.createElement('aside');panel.dataset.labOverlay='true';
    panel.style.cssText='position:fixed;right:16px;bottom:16px;width:235px;padding:12px;border:1px solid #9ab9e9;background:#edf4ff;z-index:2147483647;border-radius:10px;font:13px system-ui;box-shadow:0 4px 18px #0002';
    const title=document.createElement('strong');title.textContent=`实验浮窗 · 标签页 ${ids.tabId}`;
    const input=document.createElement('textarea');input.id='extension-chat';input.placeholder='对话输入样本';input.style.cssText='width:100%;height:48px;font:inherit;box-sizing:border-box;margin-top:8px';
    panel.append(title,input);document.body.append(panel);
  });
  for(const type of ['pointerdown','click','keydown','beforeinput','input','compositionstart','compositionend','paste','wheel']) document.addEventListener(type,event=>{
    const target=event.target;
    chrome.runtime.sendMessage({kind:'event',data:{at:Date.now(),type,isTrusted:event.isTrusted,task:document.documentElement.dataset.labTask,docId:document.documentElement.dataset.labDoc,stage:document.documentElement.dataset.labStage,target:target.id||target.tagName,key:event.key,code:event.code,inputType:event.inputType,data:event.data,inOverlay:!!target.closest?.('[data-lab-overlay]')}});
  },true);
})();
