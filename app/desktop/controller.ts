import { agreementUICommandSchema } from '../shared/agreement';
import { scheduleUICommandSchema } from '../shared/schedule';
import {
  app,
  utilityProcess,
  Menu,
  Tray,
  dialog,
  nativeImage,
  safeStorage,
  powerMonitor,
  shell,
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
import { materialObservation } from './material-observation';
import { ExecutionService, type BoundObservation } from './execution-service';
import { ExecutionProtocol } from './execution-protocol';
import { WebExecutor } from './web-executor';
import { InputGate } from './input-gate';
import { sessionContextSchema } from '../shared/coordination';
import { StorageMonitor } from './storage-monitor';
import {
  executionPauseReasonSchema,
  type SystemCondition,
} from '../shared/execution';
import { ValidationBarriers } from './validation-barriers';
import { LocalFixture } from './local-fixture';
import { acquireRuntimeOwnership } from './runtime-ownership';
import { BackupService } from './backup-service';
import { VersionService } from './version-service';
import { UpgradeService } from './upgrade-service';
import { verifyPackageIdentity } from './package-identity';
import { upgradeProofSchema, upgradeSiteSchema } from '../shared/upgrade';
import { backupArchiveSchema } from '../shared/backup';
import { versionFixture } from './version-fixture';
import {
  CURRENT_DATA_FORMAT,
  CURRENT_STATE_MODEL,
} from '../shared/record-format';

export async function requestApplicationQuit(ports: {
  upgrades: Pick<UpgradeService, 'canExit'>;
  canExit: () => boolean;
  quit: () => Promise<void>;
}): Promise<null> {
  if (!ports.upgrades.canExit()) throw Error('UPGRADE_PENDING');
  if (!ports.canExit()) throw Error('UNSAVED_CHANGES');
  await ports.quit();
  return null;
}

export async function startController(
  folder: string,
  validation: boolean,
  fixtureOrigin?: string,
): Promise<void> {
  if (fixtureOrigin && !validation) throw Error('STARTUP_NOT_AUTHORIZED');
  const fixture = fixtureOrigin ? new LocalFixture(fixtureOrigin) : undefined;
  const log = diagnostics(folder, 'controller');
  // 在异步启动前收集事件；执行入口建立后再交付当前条件。
  const systemConditions = new Set<SystemCondition>();
  const systemSink: {
    notify?: (condition: SystemCondition, blocked: boolean) => void;
  } = {};
  const systemChanged = (condition: SystemCondition, blocked: boolean) => {
    if (blocked) systemConditions.add(condition);
    else systemConditions.delete(condition);
    systemSink.notify?.(condition, blocked);
  };
  const readScreen = () => {
    const idle = powerMonitor.getSystemIdleState(1);
    if (idle === 'unknown') systemChanged('session-unavailable', true);
    else {
      // 唤醒取样不解除已收到的锁屏；只有明确解锁事件才解除它。
      if (idle === 'locked') systemChanged('screen-locked', true);
      systemChanged('session-unavailable', false);
    }
  };
  powerMonitor.on('lock-screen', () => systemChanged('screen-locked', true));
  powerMonitor.on('unlock-screen', () => {
    systemChanged('screen-locked', false);
    systemChanged('session-unavailable', false);
  });
  powerMonitor.on('suspend', () => systemChanged('sleeping', true));
  powerMonitor.on('resume', () => {
    readScreen();
    systemChanged('sleeping', false);
  });
  powerMonitor.on('user-did-resign-active', () =>
    systemChanged('session-unavailable', true),
  );
  powerMonitor.on('user-did-become-active', readScreen);
  readScreen();
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
  const trayUpdates: { refresh?: () => void } = {};
  const publish = () => {
    trayUpdates.refresh?.();
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
  const models: ModelService = new ModelService({
    systemReady: () => executions.systemReady(),
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
    const sessionBefore = sessionContextSchema.parse(
      await hostClient.request({ kind: 'session-context', taskId }),
    );
    await storageMonitor.ensure(taskId, sessionBefore.origin);
    const qualification = broker.client(taskId);
    try {
      const read = (method: string, frameId?: string) =>
        broker.observe(qualification, {
          taskId,
          token: qualification.token,
          method,
          ...(frameId ? { frameId } : {}),
        });
      // 首次观察会建立这份资格独占的会话，先完成连接再读取第二项。
      const frame = await read('Page.getFrameTree');
      const tree = await read('Accessibility.getFullAXTree');
      const document = await read('DOMSnapshot.captureSnapshot');
      const supplements = [materialObservation(document)];
      const childObservations: ReturnType<typeof pageObservation>[] = [];
      const childFrames: { id: string; url: string }[] = [];
      const collectFrames = (value: unknown, root = false) => {
        const item = z
          .object({
            frame: z.object({ id: z.string(), url: z.string() }),
            childFrames: z.array(z.unknown()).optional(),
          })
          .parse(value);
        if (!root) childFrames.push(item.frame);
        item.childFrames?.forEach((child) => collectFrames(child));
      };
      collectFrames(frame.frameTree, true);
      for (const child of childFrames.slice(0, 8)) {
        // 无法读取的跨进程 frame 明示缺口；不以维护者脚本补写内容。
        try {
          const ax = await read('Accessibility.getFullAXTree', child.id);
          const observation = pageObservation(
            { frameTree: { frame: child } },
            ax,
            qualification.generation,
          );
          childObservations.push(observation);
          supplements.push(`[frame] ${child.url}\n` + observation.text);
        } catch {
          supplements.push(`[frame-unavailable] ${child.url}`);
        }
      }
      if (signal.aborted) throw new Error('MODEL_CANCELLED');
      const sessionAfter = sessionContextSchema.parse(
        await hostClient.request({ kind: 'session-context', taskId }),
      );
      if (JSON.stringify(sessionBefore) !== JSON.stringify(sessionAfter))
        throw Error('COORDINATION_STALE');
      const observation = pageObservation(
        frame,
        tree,
        qualification.generation,
        supplements.join('\n'),
      );
      const controls = [observation, ...childObservations].flatMap(
        (o) => o.controls ?? [],
      );
      const links = [observation, ...childObservations].flatMap(
        (o) => o.links ?? [],
      );
      observation.controls = controls.slice(0, 500);
      observation.links = links.slice(0, 300);
      observation.truncated ||=
        controls.length > 500 ||
        links.length > 300 ||
        childFrames.length > 8 ||
        childObservations.some((o) => o.truncated);
      return {
        session: sessionAfter,
        observation,
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
    (command) => recordClient.request({ kind: 'material', command }),
  );
  const saveExecution = (command: unknown) =>
    recordClient.request({ kind: 'execution', command });
  const executions: ExecutionService = new ExecutionService({
    initialUpgradeHold: true,
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
          const publication = z
            .object({
              kind: z.string(),
              taskId: z.string(),
              effect: z.string().optional(),
            })
            .parse(command);
          if (publication.kind === 'publication-result')
            await barriers.pass(
              'publication-result-before',
              publication.taskId,
            );
          const result = await saveExecution(command);
          if (
            publication.kind === 'reserve' &&
            publication.effect === 'publication'
          )
            await barriers.pass('publication-reserved', publication.taskId);
          if (publication.kind === 'publication-result')
            await barriers.pass('publication-result-after', publication.taskId);
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
    session: async (taskId) =>
      sessionContextSchema.parse(
        await hostClient.request({ kind: 'session-context', taskId }),
      ),
    refreshPage: async (taskId) => {
      await hostClient.request({ kind: 'coordination-refresh', taskId });
    },
    propose: (input) => models.propose(input),
    perform: (job) => webExecutor.perform(job),
    material: (command) => recordClient.request({ kind: 'material', command }),
    scheduled: (command) => recordClient.request({ kind: 'schedule', command }),
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
  const storageMonitor = new StorageMonitor(broker, (origin) => {
    for (const task of state.tasks) {
      if (
        task.execution?.coordination?.session.origin !== origin &&
        (!task.url || new URL(task.url).origin !== origin)
      )
        continue;
      inputGate.block(task.id);
      webExecutor.revoke(task.id);
      models.cancelTask(task.id);
    }
    void hostClient
      .request({ kind: 'storage-session-change', origin })
      .catch(() => executions.disable());
  });
  const backups = new BackupService({
    choose: async (kind) => {
      const result = z
        .strictObject({ file: z.string().nullable() })
        .parse(
          await hostClient.request(
            { kind: 'choose-backup', mode: kind },
            180000,
          ),
        );
      return result.file;
    },
    records: (command) => recordClient.request({ kind: 'backup', command }),
    current: () => state,
    publish: (next) => {
      if (next.revision >= state.revision) {
        state = next;
        publish();
      }
    },
    ready: () =>
      recordsAvailable && workspace.canExit() && executions.canExit(),
    hold: async () => {
      await executions.beginRestore();
      await models.stopAll();
    },
    release: async (next) => {
      models.cancelExit();
      await executions.endRestore(next);
    },
  });

  const versions = new VersionService({
    current: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      osVersion: process.getSystemVersion(),
      dataFormat: CURRENT_DATA_FORMAT,
      stateModel: CURRENT_STATE_MODEL,
    },
    ...versionFixture(validation, folder),
    publish: (version) => {
      if (host.connected) host.send({ version });
    },
    open: async (url) => {
      await shell.openExternal(url, { activate: false });
      if (validation) process.send?.({ versionExternalOpen: url });
    },
  });

  const upgrades = new UpgradeService({
    version: app.getVersion(),
    records: (command) => recordClient.request({ kind: 'upgrade', command }),
    versions: () => versions.get(),
    hold: async () => {
      await executions.holdUpgrade();
      await models.stopAll();
    },
    release: () => {
      models.cancelExit();
      executions.releaseUpgrade();
      return Promise.resolve();
    },
    ready: () =>
      recordsAvailable &&
      workspace.canExit() &&
      executions.canExit() &&
      backups.canExit(),
    capture: async () => {
      if (!app.isPackaged) throw Error('UPGRADE_PACKAGE_UNVERIFIED');
      const application = await verifyPackageIdentity(
        path.resolve(process.execPath, '../../..'),
      );
      const credential = await models.credentialProof();
      const site = upgradeProofSchema
        .omit({ credential: true, application: true })
        .parse(await hostClient.request({ kind: 'upgrade-site-state' }));
      return { ...site, credential, application };
    },
    pages: async () =>
      z
        .array(upgradeSiteSchema)
        .parse(await hostClient.request({ kind: 'upgrade-page-state' })),
    acknowledge: async (taskId, generation, epoch) => {
      await hostClient.request({
        kind: 'upgrade-ack-page',
        taskId,
        generation,
        epoch,
      });
    },
    choose: async () =>
      z
        .object({ file: z.string().nullable() })
        .parse(
          await hostClient.request(
            { kind: 'choose-backup', mode: 'directory' },
            180000,
          ),
        ).file,
    backup: async (requestId, file) =>
      backupArchiveSchema.parse(
        z
          .object({ archive: backupArchiveSchema })
          .parse(
            await recordClient.request(
              { kind: 'backup', command: { kind: 'create', requestId, file } },
              30000,
            ),
          ).archive,
      ),
    publish: (upgrade) => {
      if (host.connected) host.send({ upgrade });
    },
    closePages: async (proof) => {
      await hostClient.request({ kind: 'upgrade-close-pages', proof }, 45000);
    },
    checkpoint: () => checkpointExit(),
    cancelExit: () => {
      cancelExit();
      return Promise.resolve();
    },
    quit: () => quit(true),
  });
  await upgrades.initialize();

  systemSink.notify = (condition, blocked) => {
    void executions.setSystemCondition(condition, blocked).catch((error) => {
      log.event('failure', { code: errorCode(error) });
    });
  };
  for (const condition of systemConditions) systemSink.notify(condition, true);

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
    const result = await executeCommand(input);
    const direct = snapshotSchema.safeParse(result);
    if (direct.success) return executions.decorate(direct.data);
    const nested = z
      .object({ state: snapshotSchema })
      .passthrough()
      .safeParse(result);
    return nested.success
      ? { ...nested.data, state: executions.decorate(nested.data.state) }
      : result;
  }
  async function executeCommand(input: unknown): Promise<unknown> {
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
    if (command.kind.startsWith('upgrade-')) return upgrades.handle(command);
    if (command.kind.startsWith('version-')) return versions.handle(command);
    if (
      command.kind === 'backup-review' &&
      (!recordsAvailable || !workspace.canExit())
    )
      throw Error('UNSAVED_CHANGES');
    if (command.kind === 'backup-review')
      return { state: await executions.reviewRestored(command.taskId) };
    if (command.kind.startsWith('backup-')) return backups.handle(command);
    if (command.kind === 'participation-open') {
      const task = state.tasks.find((t) => t.id === command.taskId);
      if (task?.execution?.question?.id !== command.questionId)
        throw Error('PARTICIPATION_EXPIRED');
      await saveWorkspace({
        kind: 'select',
        taskId: task.id,
        requestId: randomUUID(),
      });
      if (task.minimized)
        await saveWorkspace({
          kind: 'minimize',
          taskId: task.id,
          requestId: randomUUID(),
        });
      await hostClient.request({ kind: 'show-task' });
      return { state: executions.decorate(state) };
    }
    if (
      command.kind === 'participation-reply' ||
      command.kind === 'participation-decision'
    ) {
      if (
        command.kind === 'participation-decision' &&
        command.operation === 'login-check' &&
        state.active !== command.taskId
      )
        throw Error('TASK_NOT_OWNED');
      if (workspace.unresolvedTasks().includes(command.taskId))
        throw Error('UNSAVED_CHANGES');
      return { state: await executions.reply(command) };
    }
    if (command.kind === 'stop-and-close') {
      return {
        state: await executions.intent(
          {
            kind: 'execution-intent',
            intent: 'stop',
            requestId: command.requestId,
            taskId: command.taskId,
          },
          undefined,
          command.executionVersion,
        ),
      };
    }
    if (command.kind === 'execution-intent') {
      if (
        command.intent !== 'stop' &&
        workspace.unresolvedTasks().includes(command.taskId)
      )
        throw Error('UNSAVED_CHANGES');
      return { state: await executions.intent(command) };
    }
    if (command.kind.startsWith('schedule-'))
      return {
        state: await executions.scheduled(
          scheduleUICommandSchema.parse(command),
        ),
      };
    if (command.kind.startsWith('agreement-'))
      return {
        state: await executions.agreement(
          agreementUICommandSchema.parse(command),
        ),
      };
    if (command.kind === 'model-save') return models.configure(command);
    if (command.kind === 'model-cancel')
      return models.cancel(command.taskId, command.callId);
    if (command.kind === 'model-test') return models.testConnection(command);
    if (command.kind === 'message') {
      const text = command.text.trim();
      const task = state.tasks.find((t) => t.id === command.taskId);
      const agreement = task?.execution?.agreements?.at(-1);
      const base = { taskId: command.taskId, requestId: command.requestId };
      const plan = task?.execution?.schedule?.versions.at(-1);
      if (/^(取消|撤销)(这个)?定时计划[。！!]?$/u.test(text) && plan)
        return {
          state: await executions.scheduled({
            ...base,
            kind: 'schedule-cancel',
            versionId: plan.versionId,
          }),
        };
      if (/^接受(这个)?定时计划[。！!]?$/u.test(text) && plan)
        return {
          state: await executions.scheduled({
            ...base,
            kind: 'schedule-accept',
            versionId: plan.versionId,
          }),
        };
      if (
        /^(定时计划|修改定时计划|定时|每天|每周|每隔)[：:\s]?/u.test(text) &&
        task?.execution
      )
        return {
          state: await executions.scheduled({
            ...base,
            kind: 'schedule-prepare',
            expectedRevision: task.execution.schedule?.revision ?? 0,
            text,
          }),
        };
      if (/^(明确)?再(发|发布)一次[。！!]?$/u.test(text)) {
        const work = task?.execution?.materialWorks?.findLast(
          (w) =>
            w.binding.goalVersion === task.execution?.goalVersion &&
            w.status === 'complete',
        );
        if (!work) throw Error('MATERIAL_WORK_UNSETTLED');
        return {
          state: await executions.agreement({
            kind: 'agreement-use',
            taskId: work.binding.ownerTaskId,
            requestId: command.requestId,
            versionId: work.binding.versionId,
            periodKey: work.binding.periodKey,
            repeatOf: work.id,
          }),
        };
      }
      if (/^(撤销|取消)(这个)?发布约定[。！!]?$/u.test(text) && agreement)
        return {
          state: await executions.agreement({
            ...base,
            kind: 'agreement-revoke',
            versionId: agreement.versionId,
          }),
        };
      if (/^接受(这个)?发布约定[。！!]?$/u.test(text) && agreement)
        return {
          state: await executions.agreement({
            ...base,
            kind: 'agreement-accept',
            versionId: agreement.versionId,
          }),
        };
      if (
        /^(发布约定|修改发布约定|以后按)[：:\s]?/u.test(text) &&
        task?.execution
      )
        return {
          state: await executions.agreement({
            ...base,
            kind: 'agreement-prepare',
            expectedVersion: task.execution.version,
            text,
          }),
        };
      if (
        /^按(这个)?约定(处理|发布)(新素材)?[。！!]?$/u.test(text) &&
        agreement
      )
        return {
          state: await executions.agreement({
            ...base,
            kind: 'agreement-use',
            versionId: agreement.versionId,
            periodKey: '',
            repeatOf: null,
          }),
        };

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
      if (!executions.systemReady()) throw Error('SYSTEM_SUSPENDED');
      return { state: await models.ask(command) };
    }
    if (command.kind === 'quit') {
      return requestApplicationQuit({
        upgrades,
        canExit: () =>
          recordsAvailable &&
          workspace.canExit() &&
          executions.canExit() &&
          backups.canExit(),
        quit,
      });
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
    const sessionChange = z
      .object({
        websiteSessionChanged: z.object({
          session: sessionContextSchema,
          taskIds: z.array(z.string()),
        }),
      })
      .safeParse(input);
    if (sessionChange.success) {
      const { session, taskIds } = sessionChange.data.websiteSessionChanged;
      void executions
        .sessionChanged(
          session,
          taskIds.filter((id) => state.tasks.some((t) => t.id === id)),
        )
        .catch(() =>
          log.event('failure', { code: 'SESSION_CHANGE_NOT_SAVED' }),
        );
      return;
    }
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
    versions.dispose();
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
  function cancelExit() {
    quitting = false;
    executions.cancelExit();
    models.cancelExit();
  }
  async function checkpointExit(): Promise<void> {
    if (quitting) throw Error('APPLICATION_EXITING');
    if (
      !recordsAvailable ||
      !workspace.canExit() ||
      !executions.canExit() ||
      !backups.canExit()
    )
      throw Error('UNSAVED_CHANGES');
    quitting = true;
    try {
      await executions.stopAll();
      await models.stopAll();
      await barriers?.pass('exit-checkpoint', '*');
      state = snapshotSchema.parse(
        await recordClient.request({ kind: 'checkpoint' }),
      );
    } catch (error) {
      cancelExit();
      if (!recordsAvailable) restoreRecordConnection();
      if (host.connected)
        host.send({
          notice:
            '退出前的必要事实尚未可靠保存，已保留现场并阻止新操作。请恢复保存条件后重试退出。',
        });
      throw error;
    }
  }
  async function quit(checkpointSaved = false): Promise<void> {
    if (!checkpointSaved) {
      if (quitting) return;
      await checkpointExit();
    }
    versions.dispose();
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
  let lastCount = -1;
  const openInbox = () => {
    void hostClient.request({ kind: 'show-inbox' }).catch(() => {
      log.event('failure', { code: 'INBOX_UNAVAILABLE' });
      void dialog
        .showMessageBox({
          type: 'warning',
          message: '待办窗口暂时打不开',
          detail: '待办仍然保留。可以重试，或从主窗口的“待回复”处理。',
          buttons: ['知道了'],
        })
        .catch(() => {});
    });
  };
  trayUpdates.refresh = () => {
    const count = state.tasks.filter(
      (t) =>
        t.execution?.question ||
        t.execution?.schedule?.rounds.some((r) => r.status === 'waiting'),
    ).length;
    if (count === lastCount) return;
    lastCount = count;
    tray.setTitle(count ? 'helpr · 待办 ' + count : 'helpr');
    tray.setToolTip('打开 helpr');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...(count ? [{ label: '待办 ' + count, click: openInbox }] : []),
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
  };
  trayUpdates.refresh();
  const planTimer = setInterval(() => {
    void executions
      .tickPlans()
      .catch((error: unknown) =>
        log.event('failure', { code: errorCode(error) }),
      );
  }, 1000);
  planTimer.unref();
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
    versions.start();
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
          [
            'capture',
            'inspect',
            'show-inbox',
            'show',
            'resize',
            'validation-move',
          ].includes(command.data.kind)
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
