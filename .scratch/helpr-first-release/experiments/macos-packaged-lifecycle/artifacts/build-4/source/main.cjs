const {app}=require('electron');
const path=require('node:path');
app.setName('helpr Lifecycle Lab');
const data=path.join(app.getPath('appData'),'helpr Lifecycle Lab');
app.setPath('userData',process.argv.includes('--lab-host')?path.join(data,'profile'):data);
app.enableSandbox();
if(process.argv.includes('--lab-update-helper'))import('./update-helper.mjs').catch(error=>{console.error(error);app.exit(1);});
else if(process.argv.includes('--lab-host'))require('./host.cjs');
else if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('window-all-closed',()=>{});
  app.whenReady().then(()=>import('./controller.mjs')).catch(error=>{console.error(error);app.exit(1);});
}
