import {
  app,
  utilityProcess,
  Menu,
  Tray,
  nativeImage,
  safeStorage,
} from 'electron';
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
  startupFailureSchema,
} from '../shared/contracts';
import { diagnostics } from '../shared/diagnostics';
import { WorkspaceSession } from './workspace-session';
import { ObservationBroker } from './observation-broker';
import { runtimeImages } from './startup';
import { ModelService } from './model-service';
import { pageObservation } from './page-observation';
import { ExecutionService, type BoundObservation } from './execution-service';
import { ExecutionProtocol } from './execution-protocol';
import { WebExecutor } from './web-executor';

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
      runtimeImages(process.execPath, app.isPackaged).host,
      ...args,
    ],
    {
      env: { ...env, HELPR_WORKSPACE_DATA: folder },
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
    },
  );
  let launcherText = '';
  host.stdio.at(6)?.on('data', (data: Buffer) => {
    launcherText = (launcherText + data.toString()).slice(-256);
    let end: number;
    while ((end = launcherText.indexOf('\n')) >= 0) {
      const line = launcherText.slice(0, end);
      launcherText = launcherText.slice(end + 1);
      if (/^\d+$/.test(line) && validation)
        process.send?.({
          launching: true,
          hostPid: Number(line),
          launcherPid: host.pid,
        });
      const status = /^exit:(-1|\d{1,3}):(\d{1,3})$/.exec(line);
      if (status) {
        const exitCode = Number(status[1]),
          signal = Number(status[2]);
        if (exitCode <= 255 && signal <= 255) {
          if (!quitting)
            log.event('failure', {
              code: 'HOST_PROCESS_EXITED',
              exitCode,
              signal,
            });
          if (validation) process.send?.({ nativeExit: { exitCode, signal } });
        }
      }
    }
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
    if (host.connected) host.send({ state: executions.decorate(state) });
  };
  let recordsAvailable = true;
  const workspace = new WorkspaceSession(
    state,
    (command) => recordClient.request(command),
    (next) => {
      if (next.revision >= state.revision) {
        state = next;
        publish();
      }
    },
  );
  const models = new ModelService({
    records: (command) => recordClient.request({ kind: 'model', command }),
    current: () => state,
    publish: (next) => {
      if (next.revision >= state.revision) {
        state = next;
        publish();
      }
    },
    protection: {
      protect: async (key) => {
        if (
          process.platform !== 'darwin' ||
          !(await safeStorage.isAsyncEncryptionAvailable())
        )
          throw new Error('MODEL_CREDENTIAL_UNAVAILABLE');
        return (await safeStorage.encryptStringAsync(key)).toString('base64');
      },
      reveal: async (ciphertext) => {
        if (
          process.platform !== 'darwin' ||
          !(await safeStorage.isAsyncEncryptionAvailable())
        )
          throw new Error('MODEL_CREDENTIAL_UNAVAILABLE');
        return (
          await safeStorage.decryptStringAsync(
            Buffer.from(ciphertext, 'base64'),
          )
        ).result;
      },
    },
    observe: async (taskId, signal) =>
      (await observePage(taskId, signal)).observation,
  });
  async function observePage(
    taskId: string,
    signal: AbortSignal,
  ): Promise<BoundObservation> {
    if (signal.aborted) throw new Error('MODEL_CANCELLED');
    const qualification = broker.client(taskId);
    try {
      const read = (method: string) =>
        broker.observe(qualification, {
          taskId,
          token: qualification.token,
          method,
        });
      // 首次观察会建立这份资格独占的会话，先完成连接再读取第二项。
      const frame = await read('Page.getFrameTree');
      const tree = await read('Accessibility.getFullAXTree');
      if (signal.aborted) throw new Error('MODEL_CANCELLED');
      return {
        observation: pageObservation(frame, tree, qualification.generation),
        binding: {
          targetId: qualification.targetId,
          generation: qualification.generation,
        },
      };
    } catch {
      throw new Error('MODEL_PAGE_UNAVAILABLE');
    } finally {
      await broker.close(qualification);
    }
  }
  const webExecutor = new WebExecutor(
    new ExecutionProtocol(broker),
    observePage,
    env,
  );
  const executions = new ExecutionService({
    records: (command) => recordClient.request({ kind: 'execution', command }),
    current: () => state,
    publish: (next) => {
      if (next.revision >= state.revision) {
        state = next;
        publish();
      }
    },
    observe: observePage,
    propose: (input) => models.propose(input),
    perform: (job) => webExecutor.perform(job),
    revoke: (taskId) => webExecutor.revoke(taskId),
    stopModels: (taskId) => models.cancelTask(taskId),
  });

  records.once('exit', () => {
    recordsAvailable = false;
    models.disable();
    executions.disable();
    if (!quitting && host.connected)
      host.send({
        notice:
          '本机记录暂不可用。已保留的网页可继续查看，请保持窗口打开并重新启动 helpr 后重试。',
      });
  });
  async function execute(input: unknown): Promise<unknown> {
    const command = uiCommandSchema.parse(input);
    if (quitting) throw new Error('APPLICATION_EXITING');
    if (command.kind === 'snapshot') return executions.decorate(state);
    if (command.kind === 'execution-intent')
      return { state: await executions.intent(command) };
    if (command.kind === 'model-save') return models.configure(command);
    if (command.kind === 'model-cancel')
      return models.cancel(command.taskId, command.callId);
    if (command.kind === 'model-test') return models.testConnection(command);
    if (command.kind === 'message') {
      const text = command.text.trim();
      const intent = /^(停止|停下|暂停)[。！!]?$/u.test(text)
        ? 'stop'
        : /^继续[。！!]?$/u.test(text)
          ? 'continue'
          : /^(开始|开始执行|执行)[。！!]?$/u.test(text)
            ? 'start'
            : /^改为[：:\s]?/u.test(text)
              ? 'revise'
              : null;
      if (/^查看结果[。！!]?$/u.test(text))
        return { state: executions.decorate(state) };
      if (intent)
        return {
          state: await executions.intent({
            kind: 'execution-intent',
            taskId: command.taskId,
            requestId: command.requestId,
            intent,
            ...(intent === 'revise'
              ? { text: text.replace(/^改为[：:\s]?/u, '').trim() }
              : { text }),
          }),
        };
      return { state: await models.ask(command) };
    }
    if (command.kind === 'quit') {
      if (!recordsAvailable || !workspace.canExit() || !executions.canExit())
        throw new Error('UNSAVED_CHANGES');
      await executions.stopAll();
      await models.stopAll();
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
    const startupFailure = startupFailureSchema.safeParse(input);
    if (startupFailure.success) {
      log.event('failure', startupFailure.data.startupFailure);
      if (validation) process.send?.(startupFailure.data);
      return;
    }
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
        .then(() => executions.refresh())
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
    models.disable();
    executions.disable();
    webExecutor.dispose();
    broker.dispose();
    workers.forEach((worker) => worker.kill());
    if (!quitting) {
      records.kill();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        app.exit(1);
      };
      // exit 不能证明 fd6/IPC 已排空；收尾总共最多等 100ms。
      const timer = setTimeout(finish, 100);
      host.once('close', () =>
        log.close(() => {
          try {
            if (validation && process.connected && process.send)
              process.send({ hostExited: true }, finish);
            else finish();
          } catch {
            finish();
          }
        }),
      );
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
