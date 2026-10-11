globalThis.identities=async()=>({tabs:await chrome.tabs.query({}),targets:await chrome.debugger.getTargets()});
