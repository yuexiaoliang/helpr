import { app, dialog } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startController } from './controller';
import { resolveStartup, debuggingSwitches } from './startup';

process.umask(0o077);
app.setName('helpr');
try {
  const { role, root, validation } = resolveStartup({
    argv: process.argv,
    runtimeSwitches: debuggingSwitches.filter((name) =>
      app.commandLine.hasSwitch(name),
    ),
    connected: Boolean(process.connected),
    executable: process.execPath,
    parentPid: process.ppid,
    production: path.join(app.getPath('appData'), 'helpr'),
    env: process.env,
    probe: app.isPackaged
      ? path.join(process.resourcesPath, 'process-path')
      : path.resolve('dist/native/process-path'),
    watcher: app.isPackaged
      ? path.join(process.resourcesPath, 'watch-owner')
      : path.resolve('dist/native/watch-owner'),
  });
  const host = role === 'host';
  app.setActivationPolicy(host ? 'regular' : 'accessory');
  app.setPath('userData', host ? path.join(root, 'browser') : root);
  app.enableSandbox();
  if (host) {
    createRequire(__filename)(path.join(__dirname, 'host.cjs'));
  } else if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on('window-all-closed', () => {});
    void app
      .whenReady()
      .then(() => startController(root, validation))
      .catch(() => {
        dialog.showErrorBox(
          'helpr 暂时无法打开',
          '本机记录暂不可用。你的资料仍保留，请重新打开应用后重试。',
        );
        app.exit(1);
      });
  }
} catch {
  app.exit(1);
}
