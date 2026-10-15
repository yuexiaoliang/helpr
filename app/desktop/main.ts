import { app, dialog } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { startController } from './controller';
import { resolveStartup, debuggingSwitches, runtimeImages } from './startup';
import {
  startupFailureCodeSchema,
  type StartupStage,
} from '../shared/contracts';

let startupStage: StartupStage = 'image';
function failStartup(error: unknown): void {
  const message = startupFailureCodeSchema.safeParse(
    error instanceof Error ? error.message : null,
  );
  const systemCode = startupFailureCodeSchema.safeParse(
    error instanceof Error && 'code' in error ? error.code : null,
  );
  const failure = {
    startupFailure: {
      stage: startupStage,
      code: message.success
        ? message.data
        : systemCode.success
          ? systemCode.data
          : 'STARTUP_FAILED',
    },
  };
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    app.exit(1);
  };
  const timer = setTimeout(finish, 100);
  try {
    if (process.connected && process.send) process.send(failure, finish);
    else process.stderr.write(JSON.stringify(failure) + '\n', finish);
  } catch {
    finish();
  }
}

process.umask(0o077);
app.setName('helpr');
try {
  const images = runtimeImages(process.execPath, app.isPackaged);
  startupStage = 'ownership';
  const { role, root, validation } = resolveStartup({
    argv: process.argv,
    runtimeSwitches: debuggingSwitches.filter((name) =>
      app.commandLine.hasSwitch(name),
    ),
    connected: Boolean(process.connected),
    executable: process.execPath,
    controllerExecutable: images.controller,
    hostExecutable: images.host,
    parentPid: process.ppid,
    production: path.join(app.getPath('appData'), 'helpr'),
    env: process.env,
    probe: path.join(images.resources, 'process-path'),
    watcher: path.join(images.resources, 'watch-owner'),
  });
  if (role === 'reopen') {
    startupStage = 'reopen';
    // Dock 保存的是可见宿主。普通打开只转交固定外层入口，不授予网页控制能力。
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG'])
      if (process.env[key]) env[key] = process.env[key];
    const controller = spawn(images.controller, [], {
      env,
      detached: true,
      stdio: 'ignore',
    });
    controller.once('error', failStartup);
    controller.once('spawn', () => {
      controller.unref();
      app.exit(0);
    });
  } else {
    startupStage = 'application';
    const host = role === 'host';
    app.setActivationPolicy(host ? 'regular' : 'accessory');
    app.setPath('userData', host ? path.join(root, 'browser') : root);
    app.enableSandbox();
    if (host) {
      startupStage = 'host-module';
      createRequire(__filename)(path.join(__dirname, 'host.cjs'));
    } else if (!app.requestSingleInstanceLock()) app.quit();
    else {
      app.on('window-all-closed', () => {});
      void app
        .whenReady()
        .then(() => {
          startupStage = 'controller-init';
          return startController(root, validation);
        })
        .catch((error: unknown) => {
          dialog.showErrorBox(
            'helpr 暂时无法打开',
            '本机记录暂不可用。你的资料仍保留，请重新打开应用后重试。',
          );
          failStartup(error);
        });
    }
  }
} catch (error) {
  failStartup(error);
}
