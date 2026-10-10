const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('node:path');
app.setPath('userData', path.join(process.env.STOP_LAB_DIR, 'profiles', 'electron'));
app.commandLine.appendSwitch('remote-debugging-port', process.env.STOP_LAB_PORT);
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1180, height: 800, title: 'helpr 独立停止实验' });
  await window.loadURL('data:text/html,<body style="font:16px system-ui;background:%231a2940;color:white">helpr 独立停止自动实验</body>');
  const views = [];
  for (const task of ['A', 'B']) {
    const view = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    window.contentView.addChildView(view); views.push(view);
    await view.webContents.loadURL(process.env.STOP_LAB_BASE + '/fixture?scope=boot&task=' + task);
  }
  const arrange = () => {
    const [width, height] = window.getContentSize();
    views.forEach((view, index) => view.setBounds({ x: Math.floor(width / 2) * index, y: 32, width: Math.floor(width / 2), height: height - 32 }));
  };
  window.on('resize', arrange); arrange();
  window.on('closed', () => { for (const view of views) if (!view.webContents.isDestroyed()) view.webContents.close(); app.quit(); });
  global.stopLab = { ready: true, views, window };
});
app.on('window-all-closed', () => app.quit());
