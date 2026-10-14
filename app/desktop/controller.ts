import { app, utilityProcess, Menu, Tray, nativeImage } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ProcessClient } from '../shared/rpc';
import {
  snapshotSchema,
  uiCommandSchema,
  rpcRequestSchema,
  errorCode,
  type WorkspaceSnapshot,
} from '../shared/contracts';
import { diagnostics } from '../shared/diagnostics';
import { WorkspaceSession } from './workspace-session';
import { ObservationBroker } from './observation-broker';

export async function startController(
  folder: string,
  validation: boolean,
): Promise<void> {
  const log = diagnostics(folder, 'controller');
  let quitting = false;
  let state: WorkspaceSnapshot;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG'])
    if (process.env[key]) env[key] = process.env[key];
  const records = utilityProcess.fork(
    path.join(__dirname, 'records.cjs'),
    [
      folder,
      app.isPackaged
        ? path.join(process.resourcesPath, 'migrations')
        : path.resolve('app/records/migrations'),
    ],
    { env, stdio: 'ignore', serviceName: 'helpr 记录' },
  );
  const recordClient = new ProcessClient({
    send: (message) => records.postMessage(message),
    listen: (listener) => records.on('message', listener),
    onExit: (listener) => records.once('exit', listener),
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('RECORDS_UNAVAILABLE')),
      10000,
    );
    records.on('message', (input: unknown) => {
      const msg = z
        .object({
          ready: z.boolean().optional(),
          startupError: z.string().optional(),
        })
        .safeParse(input);
      if (msg.success && (msg.data.ready || msg.data.startupError)) {
        clearTimeout(timer);
        if (msg.data.ready) resolve();
        else reject(new Error('RECORDS_UNAVAILABLE'));
      }
    });
    records.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('RECORDS_UNAVAILABLE'));
    });
  });
  state = snapshotSchema.parse(
    await recordClient.request({ kind: 'snapshot' }),
  );
  const args = [
    ...(!app.isPackaged ? [app.getAppPath()] : []),
    '--workspace-host',
    '--remote-debugging-pipe',
    '--site-per-process',
  ];
  const watcher = app.isPackaged
    ? path.join(process.resourcesPath, 'watch-owner')
    : path.resolve('dist/native/watch-owner');
  const host = spawn(
    watcher,
    [
      ...(validation && process.env.HELPR_VALIDATION_PAUSE_START === '1'
        ? ['--pause-before-exec']
        : []),
      process.execPath,
      ...args,
    ],
    {
      env: { ...env, HELPR_WORKSPACE_DATA: folder },
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
    },
  );
  let childPidText = '';
  host.stdio.at(6)?.on('data', (data: Buffer) => {
    childPidText += data.toString();
    if (/^\d+\n$/.test(childPidText) && validation)
      process.send?.({
        launching: true,
        hostPid: Number(childPidText.trim()),
        launcherPid: host.pid,
      });
  });
  const broker = new ObservationBroker(host);
  const hostClient = new ProcessClient({
    send: (message) => {
      host.send(message as object);
    },
    listen: (listener) => host.on('message', listener),
    onExit: (listener) => host.once('exit', listener),
  });
  const workers = new Set<ReturnType<typeof utilityProcess.fork>>();
  const publish = () => {
    if (host.connected) host.send({ state });
  };
  let recordsAvailable = true;
  const workspace = new WorkspaceSession(
    state,
    (command) => recordClient.request(command),
    (next) => {
      state = next;
      publish();
    },
  );
  records.once('exit', () => {
    recordsAvailable = false;
    if (!quitting && host.connected)
      host.send({
        notice:
          '本机记录暂不可用。已保留的网页可继续查看，请保持窗口打开并重新启动 helpr 后重试。',
      });
  });
  async function execute(input: unknown): Promise<unknown> {
    const command = uiCommandSchema.parse(input);
    if (quitting) throw new Error('APPLICATION_EXITING');
    if (command.kind === 'snapshot') return state;
    if (command.kind === 'quit') {
      if (!recordsAvailable || !workspace.canExit())
        throw new Error('UNSAVED_CHANGES');
      await quit();
      return null;
    }
    if (
      command.kind === 'panel' ||
      command.kind === 'hide' ||
      command.kind === 'dismiss-notice' ||
      command.kind === 'reload'
    )
      return hostClient.request(command);
    if (!recordsAvailable) throw new Error('RECORDS_UNAVAILABLE');
    if (command.kind === 'cancel-create')
      return workspace.cancelCreation(command.requestId);
    const result = await workspace.save(command);
    if (command.kind === 'navigate')
      await hostClient.request({
        kind: 'navigate',
        taskId: command.taskId,
        url: command.url,
      });
    return result;
  }
  const registration = z.object({
    registration: z.object({
      taskId: z.string(),
      targetId: z.string(),
      generation: z.number().int(),
    }),
  });
  host.on('message', (input: unknown) => {
    const reg = registration.safeParse(input);
    if (
      reg.success &&
      state.tasks.some((t) => t.id === reg.data.registration.taskId)
    ) {
      const r = reg.data.registration;
      broker.register(r.taskId, r.targetId, r.generation);
      return;
    }
    const page = z
      .object({
        page: z.object({
          taskId: z.string(),
          url: z.string(),
          phase: z.enum(['loading', 'manual', 'error']),
          error: z.string().optional(),
        }),
      })
      .safeParse(input);
    if (page.success) {
      void workspace
        .save({ kind: 'page', requestId: randomUUID(), ...page.data.page })
        .catch((error) => {
          log.event('failure', { code: errorCode(error) });
          if (host.connected)
            host.send({
              notice:
                '网页地址暂未保存。请保持窗口打开后重试；已有任务与对话仍保留。',
            });
        });
      return;
    }
    const request = rpcRequestSchema.safeParse(input);
    if (request.success)
      void execute(request.data.command)
        .then((value) => {
          if (host.connected) host.send({ id: request.data.id, value });
        })
        .catch((error) => {
          if (host.connected)
            host.send({ id: request.data.id, error: errorCode(error) });
        });
  });
  host.once('exit', () => {
    broker.dispose();
    workers.forEach((worker) => worker.kill());
    if (!quitting) {
      records.kill();
      log.close();
      app.exit(1);
    }
  });
  async function observe(
    taskId: string,
    method: string,
    requestedTask?: string,
    token?: string,
  ): Promise<unknown> {
    const qualification = broker.client(taskId);
    const worker = utilityProcess.fork(
      path.join(__dirname, 'observer.cjs'),
      [],
      { env, stdio: 'ignore', serviceName: 'helpr 网页观察' },
    );
    workers.add(worker);
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('OBSERVATION_TIMEOUT')),
          10000,
        );
        worker.on('message', (input: unknown) => {
          const read = rpcRequestSchema.safeParse(input);
          if (read.success) {
            void broker
              .observe(qualification, read.data.command)
              .then((value) => worker.postMessage({ id: read.data.id, value }))
              .catch((error) =>
                worker.postMessage({
                  id: read.data.id,
                  error: errorCode(error),
                }),
              );
            return;
          }
          const result = z
            .object({
              result: z.unknown().optional(),
              error: z.string().optional(),
            })
            .safeParse(input);
          if (result.success) {
            clearTimeout(timer);
            if (result.data.error) reject(new Error(result.data.error));
            else resolve(result.data.result);
          }
        });
        worker.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('WORKER_EXITED'));
        });
        worker.postMessage({
          job: {
            taskId: requestedTask ?? taskId,
            token: token ?? qualification.token,
            method,
          },
        });
      });
    } finally {
      await broker.close(qualification);
      worker.kill();
      workers.delete(worker);
    }
  }
  async function quit(): Promise<void> {
    if (quitting) return;
    quitting = true;
    broker.dispose();
    workers.forEach((worker) => worker.kill());
    try {
      await recordClient.request({ kind: 'close' });
    } catch {
      records.kill();
    }
    if (host.connected) host.send({ close: true });
    await new Promise<void>((resolve) => {
      if (host.exitCode !== null || host.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        host.kill('SIGTERM');
        resolve();
      }, 5000);
      host.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    log.event('exit');
    log.close();
    app.exit(0);
  }
  app.on('before-quit', (event) => {
    if (!quitting) {
      event.preventDefault();
      void hostClient.request({ kind: 'panel', panel: 'quit' }).catch(() => {});
    }
  });
  app.on('second-instance', () => {
    void hostClient.request({ kind: 'show' }).catch(() => {});
  });
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  );
  const tray = new Tray(icon);
  tray.setTitle('helpr');
  tray.setToolTip('打开 helpr');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开 helpr',
        click: () => {
          void hostClient.request({ kind: 'show' }).catch(() => {});
        },
      },
      {
        label: '退出 helpr',
        click: () => {
          void hostClient
            .request({ kind: 'panel', panel: 'quit' })
            .catch(() => {});
        },
      },
    ]),
  );
  tray.on('click', () => {
    void hostClient.request({ kind: 'show' }).catch(() => {});
  });
  host.on('message', (input: unknown) => {
    const ready = z
      .object({
        ready: z.record(z.string(), z.unknown()),
        hostPid: z.number().int().positive(),
      })
      .safeParse(input);
    if (!ready.success) return;
    publish();
    log.event('ready');
    if (validation)
      process.send?.({
        ready: true,
        controllerPid: process.pid,
        hostPid: ready.data.hostPid,
        recordsPid: records.pid,
        versions: ready.data.ready,
      });
  });
  // 仅继承父进程的验证通道；不创建服务器、端口或任意代码执行入口。
  if (validation)
    process.on('message', (input: unknown) => {
      const req = rpcRequestSchema.safeParse(input);
      if (!req.success) return;
      const command = z
        .object({ kind: z.string() })
        .safeParse(req.data.command);
      const task = z.object({
        taskId: z.string(),
        method: z.string().default('Page.getFrameTree'),
        requestedTask: z.string().optional(),
        token: z.string().optional(),
      });
      const perform = async () => {
        if (command.success && command.data.kind === 'observe') {
          const job = task.parse(req.data.command);
          return observe(job.taskId, job.method, job.requestedTask, job.token);
        }
        if (
          command.success &&
          ['capture', 'inspect', 'show', 'resize'].includes(command.data.kind)
        )
          return hostClient.request(req.data.command);
        return execute(req.data.command);
      };
      void perform()
        .then((value) => process.send?.({ id: req.data.id, value }))
        .catch((error) =>
          process.send?.({ id: req.data.id, error: errorCode(error) }),
        );
    });
}
