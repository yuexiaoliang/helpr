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
import { unlinkSync } from 'node:fs';
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
import { InputGate } from './input-gate';
import { executionPauseReasonSchema } from '../shared/execution';
import { ValidationBarriers } from './validation-barriers';
import { LocalFixture } from './local-fixture';
import { acquireRuntimeOwnership } from './runtime-ownership';

export async function startController(
  folder: string,
  validation: boolean,
  fixtureOrigin?: string,
): Promise<void> {
  if (fixtureOrigin && !validation) throw Error('STARTUP_NOT_AUTHORIZED');
  const fixture = fixtureOrigin ? new LocalFixture(fixtureOrigin) : undefined;
  const log = diagnostics(folder, 'controller');
  const barriers = validation ? new ValidationBarriers() : undefined;
  if (validation && process.env.HELPR_VALIDATION_HOLD_RECOVERY === '1')
    barriers!.control({ action: 'arm', point: 'recovery', taskId: '*' });
  let quitting = false;
  let state: WorkspaceSnapshot;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG'])
    if (process.env[key]) env[key] = process.env[key];
  const ownership = await acquireRuntimeOwnership(
    folder,
    path.join(
      runtimeImages(process.execPath, app.isPackaged).resources,
      'input-bridge.node',
    ),
  );
  const inputGateFile = path.join(folder, `.input-gate-${randomUUID()}`);
  const inputGate = new InputGate(
    app.isPackaged
      ? path.join(process.resourcesPath, 'input-bridge.node')
      : path.resolve('dist/native/input-bridge.node'),
    inputGateFile,
    true,
  );
  if (validation) inputGate.startValidationTrace();
  const args = [
    ...(!app.isPackaged ? [app.getAppPath()] : []),
    '--workspace-host',
    ...(fixture ? ['--workspace-fixture'] : []),
    '--remote-debugging-pipe',
    '--site-per-process',
  ];
  const watcher = app.isPackaged
    ? path.join(process.resourcesPath, 'watch-owner')
    : path.resolve('dist/native/watch-owner');
  const host = spawn(
    watcher,
    [
      '--runtime-owner',
      ...(validation && process.env.HELPR_VALIDATION_PAUSE_START === '1'
        ? ['--pause-before-exec']
        : []),
      runtimeImages(process.execPath, app.isPackaged).host,
      ...args,
    ],
    {
      env: {
        ...env,
        HELPR_WORKSPACE_DATA: folder,
        HELPR_INPUT_GATE: inputGateFile,
        ...(fixture ? { HELPR_FIXTURE_ORIGIN: fixture.origin } : {}),
      },
      detached: true,
      stdio: [
        'ignore',
        'ignore',
        'ignore',
        'pipe',
        'pipe',
        'ipc',
        'pipe',
        ownership.fd,
      ],
    },
  );
  const earlyHostMessages: unknown[] = [];
  const collectHostMessage = (input: unknown) => earlyHostMessages.push(input);
  host.on('message', collectHostMessage);
  let workspaceExited = false;
  let resolveWorkspaceExit: () => void = () => {};
  const workspaceExit = new Promise<void>((resolve) => {
    resolveWorkspaceExit = resolve;
  });
  async function openRecords() {
    const records = utilityProcess.fork(
      path.join(__dirname, 'records.cjs'),
      [
        folder,
        app.isPackaged
          ? path.join(process.resourcesPath, 'migrations')
          : path.resolve('app/records/migrations'),
        ...(validation ? ['--workspace-validation'] : []),
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
          else reject(new Error(msg.data.startupError));
        }
      });
      records.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('RECORDS_UNAVAILABLE'));
      });
    });
    if (!ownership.owns(records.pid)) {
      records.kill();
      throw Error('RUNTIME_GROUP_UNAVAILABLE');
    }
    return {
      records,
      recordClient,
      state: snapshotSchema.parse(
        await recordClient.request({ kind: 'snapshot' }),
      ),
    };
  }
  const initial = await openRecords();
  let records = initial.records;
  let recordClient = initial.recordClient;
  state = initial.state;
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
          workspaceExited = true;
          resolveWorkspaceExit();
          onWorkspaceExit();
        }
      }
    }
  });
  const broker = new ObservationBroker(
    host,
    inputGate,
    barriers ? (taskId) => barriers.pass('input', taskId) : undefined,
  );
  host.once('close', () => {
    try {
      unlinkSync(inputGateFile);
    } catch {
      /* 当前运行的临时门，不触及任务资料。 */
    }
  });
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
    protection: fixture ?? {
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
    (taskId, code) => log.event('failure', { taskId, code }),
    (pid) => ownership.owns(pid),
  );
  const saveExecution = (command: unknown) =>
    recordClient.request({ kind: 'execution', command });
  const executions = new ExecutionService({
    records: barriers
      ? async (command) => {
          const delayed = z
            .object({
              kind: z.literal('intent'),
              intent: z.literal('continue'),
              taskId: z.string(),
            })
            .safeParse(command);
          if (delayed.success)
            await barriers.pass('records-before', delayed.data.taskId);
          const result = await saveExecution(command);
          if (delayed.success)
            await barriers.pass('records-after', delayed.data.taskId);
          return result;
        }
      : saveExecution,
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
    beforeRecovery: barriers ? () => barriers.pass('recovery', '*') : undefined,
    input: {
      prepare: async (taskId) => {
        if (!broker.available(taskId)) throw Error('CONTROL_DISCONNECTED');
        const result = z
          .object({ epoch: z.number().int().nonnegative() })
          .parse(await hostClient.request({ kind: 'verify-input', taskId }));
        return result.epoch;
      },
      block: (taskId) => inputGate.block(taskId),
      allow: (taskId, epoch) => inputGate.allow(taskId, epoch),
      epoch: (taskId) => inputGate.state(taskId).epoch,
      valid: (taskId, epoch) => inputGate.valid(taskId, epoch),
      permit: (taskId, epoch, send) => inputGate.permit(taskId, epoch, send),
    },
  });

  broker.onDisconnect(() => {
    inputGate.available(false);
    for (const task of state.tasks)
      void executions
        .suspend(task.id, 'page-change', randomUUID())
        .catch(() => {});
  });
  let recordRestarts = 0;
  function restoreRecordConnection() {
    if (recordRestarts++ > 0) return;
    if (host.connected)
      host.send({
        notice:
          '本机记录连接中断，已阻断新操作并保留网页，正在重新核对可靠记录。',
      });
    void openRecords()
      .then(async (opened) => {
        if (quitting) {
          opened.records.kill();
          return;
        }
        records = opened.records;
        recordClient = opened.recordClient;
        watchRecords(records);
        recordsAvailable = true;
        await workspace.reconcileCommitted();
        models.recordsRestored();
        await executions.recordsRestored(
          snapshotSchema.parse(
            await recordClient.request({ kind: 'snapshot' }),
          ),
          workspace.unresolvedTasks(),
        );
        if (validation)
          process.send?.({ recordsRestored: true, recordsPid: records.pid });
        if (host.connected)
          host.send({
            notice:
              '可靠记录已重新读取。原停止与暂停保持，活动任务先核对实际进度。',
          });
      })
      .catch((error) => {
        log.event('failure', { code: errorCode(error) });
        if (host.connected)
          host.send({
            notice:
              '本机记录未能恢复。资料与网页仍保留，自动操作保持暂停；请保留现场后重新打开 helpr。',
          });
      });
  }
  function watchRecords(child: typeof records) {
    child.once('exit', () => {
      if (child !== records) return;
      recordsAvailable = false;
      models.disable();
      executions.disable();
      if (validation)
        process.send?.({ recordsUnavailable: true, duringExit: quitting });
      if (!quitting) restoreRecordConnection();
    });
  }
  watchRecords(records);
  async function execute(input: unknown): Promise<unknown> {
    const command = uiCommandSchema.parse(input);
    if (quitting) throw new Error('APPLICATION_EXITING');
    if (
      fixture &&
      (command.kind === 'model-save' || command.kind === 'model-test')
    ) {
      fixture.checkModel(command.endpoint);
      if (command.apiKey !== undefined) fixture.protect(command.apiKey);
    }
    if (command.kind === 'snapshot') return executions.decorate(state);
    if (command.kind === 'execution-intent') {
      if (
        command.intent !== 'stop' &&
        workspace.unresolvedTasks().includes(command.taskId)
      )
        throw Error('UNSAVED_CHANGES');
      return { state: await executions.intent(command) };
    }
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
      if (
        intent &&
        intent !== 'stop' &&
        workspace.unresolvedTasks().includes(command.taskId)
      )
        throw Error('UNSAVED_CHANGES');
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
    if (command.kind === 'navigate')
      await executions.suspend(command.taskId, 'page-change', randomUUID());
    const result = await saveWorkspace(command);
    if (command.kind === 'navigate')
      await hostClient.request({
        kind: 'navigate',
        taskId: command.taskId,
        url: command.url,
      });
    return result;
  }
  async function saveWorkspace(command: unknown) {
    const result = await workspace.save(command);
    executions.workspaceSaved(workspace.unresolvedTasks());
    return result;
  }
  const registration = z.object({
    registration: z.object({
      taskId: z.string(),
      targetId: z.string(),
      generation: z.number().int(),
    }),
  });
  const lastSuspensionSerial = new Map<string, number>();
  host.on('message', (input: unknown) => {
    const suspension = z
      .object({
        suspension: z.strictObject({
          taskId: z.string().nullable(),
          reason: executionPauseReasonSchema,
          requestId: z.string().min(1).max(60),
          serial: z.number().int().positive(),
        }),
      })
      .safeParse(input);
    if (suspension.success) {
      if (quitting) return;
      const event = suspension.data.suspension;
      const deliver = () => {
        for (const task of state.tasks)
          if (
            (!event.taskId || task.id === event.taskId) &&
            event.serial > (lastSuspensionSerial.get(task.id) ?? 0)
          ) {
            lastSuspensionSerial.set(task.id, event.serial);
            void executions
              .suspend(task.id, event.reason, `${event.requestId}:${task.id}`)
              .catch(() => {
                log.event('failure', {
                  taskId: task.id,
                  code: 'INPUT_PAUSE_NOT_SAVED',
                });
              });
          }
      };
      if (barriers)
        void barriers
          .pass('suspension', event.taskId ?? '*')
          .then(deliver)
          .catch(() => log.event('failure', { code: 'INPUT_PAUSE_NOT_SAVED' }));
      else deliver();
      return;
    }
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
      if (quitting) return;
      void saveWorkspace({
        kind: 'page',
        requestId: randomUUID(),
        ...page.data.page,
      })
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
  function onWorkspaceExit() {
    models.disable();
    executions.disable();
    webExecutor.dispose();
    broker.dispose();
    workers.forEach((worker) => worker.kill());
    if (!quitting) {
      records.kill();
      const timer = setTimeout(() => app.exit(1), 100);
      log.close(() => {
        clearTimeout(timer);
        app.exit(1);
      });
    }
  }
  host.once('exit', onWorkspaceExit);
  if (workspaceExited) onWorkspaceExit();
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
        worker.once('spawn', () => {
          if (!ownership.owns(worker.pid)) {
            worker.kill();
            reject(Error('RUNTIME_GROUP_UNAVAILABLE'));
            return;
          }
          worker.postMessage({
            job: {
              taskId: requestedTask ?? taskId,
              token: token ?? qualification.token,
              method,
            },
          });
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
    try {
      await executions.stopAll();
      await models.stopAll();
      await barriers?.pass('exit-checkpoint', '*');
      state = snapshotSchema.parse(
        await recordClient.request({ kind: 'checkpoint' }),
      );
    } catch (error) {
      quitting = false;
      executions.cancelExit();
      models.cancelExit();
      if (!recordsAvailable) restoreRecordConnection();
      if (host.connected)
        host.send({
          notice:
            '退出前的必要事实尚未可靠保存，已保留现场并阻止新操作。请恢复保存条件后重试退出。',
        });
      throw error;
    }
    broker.dispose();
    workers.forEach((worker) => worker.kill());
    try {
      await recordClient.request({ kind: 'close' });
    } catch {
      records.kill();
    }
    if (host.connected) host.send({ close: true });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        host.kill('SIGTERM');
        resolve();
      }, 5000);
      void workspaceExit.then(() => {
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
        fixture: z
          .object({ origin: z.string(), persistent: z.boolean() })
          .optional(),
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
        ...(fixture
          ? { fixture: true, fixtureSession: ready.data.fixture }
          : {}),
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
        if (command.success && command.data.kind === 'validation-barrier')
          return barriers!.control(
            z.object({ control: z.unknown() }).parse(req.data.command).control,
          );
        if (command.success && command.data.kind === 'validation-fault') {
          const fault = z
            .strictObject({
              kind: z.literal('validation-fault'),
              fault: z.enum([
                'mapping-gap',
                'mapping-restore',
                'destroy-view',
                'disconnect',
                'panel-anchor-gap',
                'panel-anchor-restore',
              ]),
              taskId: z.string().min(1).max(100),
            })
            .parse(req.data.command);
          if (fault.fault === 'disconnect') {
            host.stdio[3]?.destroy();
            host.stdio[4]?.destroy();
            return null;
          }
          return hostClient.request(fault);
        }
        if (command.success && command.data.kind === 'observe') {
          const job = task.parse(req.data.command);
          return observe(job.taskId, job.method, job.requestedTask, job.token);
        }
        if (
          command.success &&
          ['capture', 'inspect', 'show', 'resize', 'validation-move'].includes(
            command.data.kind,
          )
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
  host.removeListener('message', collectHostMessage);
  for (const input of earlyHostMessages) host.emit('message', input);
}
