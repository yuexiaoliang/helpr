globalThis.labTargets = async () => ({
  tabs: await chrome.tabs.query({}),
  targets: await chrome.debugger.getTargets()
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.kind === 'identify') { reply({tabId:sender.tab?.id,windowId:sender.tab?.windowId}); return; }
  if (message.kind === 'event') {
    const url = new URL(sender.url);
    if (!['127.0.0.1','localhost'].includes(url.hostname)) return;
    fetch(url.origin+'/api/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'extension-event',tabId:sender.tab?.id,windowId:sender.tab?.windowId,frameId:sender.frameId,...message.data})}).catch(()=>{});
  }
});
