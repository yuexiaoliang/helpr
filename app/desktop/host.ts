import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  safeStorage,
  Menu,
  protocol,
  webContents,
  dialog,
  screen,
  type WebContents,
} from 'electron';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ProcessClient } from '../shared/rpc';
import {
  rpcRequestSchema,
  snapshotSchema,
  uiCommandSchema,
  panelSchema,
  errorCode,
  type WorkspaceSnapshot,
  type WorkspaceEvent,
  type Task,
} from '../shared/contracts';
import { websiteURL } from '../shared/url-policy';
import { diagnostics } from '../shared/diagnostics';
import { resolveStartup, debuggingSwitches, runtimeImages } from './startup';
import { InputGate } from './input-gate';
import type { ExecutionPauseReason } from '../shared/execution';
import { LocalFixture } from './local-fixture';

const images = runtimeImages(process.execPath, app.isPackaged);
const startup = resolveStartup({
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
if (startup.role !== 'host') throw new Error('HOST_OWNER_REQUIRED');
const fixture = startup.fixtureOrigin
  ? new LocalFixture(startup.fixtureOrigin)
  : undefined;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'helpr',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
const folder = startup.root;
const inputGateFile = process.env.HELPR_INPUT_GATE;
const inputGate = new InputGate(
  app.isPackaged
    ? path.join(process.resourcesPath, 'input-bridge.node')
    : path.resolve('dist/native/input-bridge.node'),
  inputGateFile && path.dirname(inputGateFile) === folder
    ? inputGateFile
    : path.join(folder, '.unavailable-input-gate'),
  false,
);
let nativeInstalled = false;
let nativeAvailable = false;
let nativeRecoveryPending = false;
let panelAnchorGap = false;
const nativeRestoredNotice =
  '本机输入识别已恢复。任务不会自动续做，需要时请明确继续。';
let taggedTask: string | null = null;
let suspensionSerial = 0;
const mappingGaps = new Set<string>();
process.umask(0o077);
const log = diagnostics(folder, 'host');
const notify = (message: object) => {
  if (process.connected) process.send?.(message);
};
const controller = new ProcessClient({
  send: (message) => notify(message as object),
  listen: (listener) => process.on('message', listener),
  onExit: (listener) => process.on('disconnect', listener),
});
let state: WorkspaceSnapshot = { revision: 0, active: null, tasks: [] };
let panel: z.infer<typeof panelSchema> = { kind: 'panel', panel: 'none' };
let win: BrowserWindow;
let overlay: WebContentsView;
let toast: WebContentsView;
let noticeTimer: ReturnType<typeof setTimeout>;
let panelTimer: ReturnType<typeof setTimeout>;
let recovered = false;
let closing = false;
const trusted = new Map<
  number,
  {
    contents: WebContents;
    role: 'chrome' | 'chat' | 'panel' | 'toast';
    taskId?: string;
  }
>();
const pages = new Map<
  string,
  {
    view: WebContentsView;
    generation: number;
    chat: WebContentsView;
    stack: WebContentsView[];
    rebuild: () => void;
  }
>();
const prefs = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  backgroundThrottling: false,
};
const renderer = path.join(__dirname, '../renderer');
const preload = path.join(__dirname, '../preload/preload.cjs');
function suspend(taskId: string | null, reason: ExecutionPauseReason) {
  inputGate.block(taskId ?? '*');
  notify({
    suspension: {
      taskId,
      reason,
      requestId: randomUUID(),
      serial: ++suspensionSerial,
    },
  });
}
function editFocused(command: 'undo' | 'redo' | 'cut' | 'paste' | 'selectAll') {
  const target = webContents.getFocusedWebContents();
  const owner = inputGate.focused();
  const task = [...pages].find(([, page]) => page.view.webContents === target);
  if (task && owner === 'web:' + task[0]) suspend(task[0], 'takeover');
  else if (task || !owner.startsWith('ui:')) suspend(null, 'ownership-unknown');
  target?.[command]();
}
function nativeBindings() {
  if (!nativeInstalled || !win || win.isDestroyed()) return;
  // 收起后 AppKit 命中测试可能不再命中子视图；保留已安装的识别与资格。
  // 隐藏窗口不接收人工输入，重新显示时同步核对现有视图，失败仍先阻断。
  if (!win.isVisible()) return;
  const [width = 800, height = 600] = win.getContentSize();
  let step = 'CHROME';
  let restoring = false;
  try {
    const fullPanel = panel.panel !== 'none' && panel.panel !== 'preview';
    if (!fullPanel)
      inputGate.bind(
        'ui:chrome',
        { x: 0, y: 0, width, height },
        // 顶栏左侧是 app-region:drag；从始终可见的退出按钮内部取样，仍核对完整子树边界。
        { x: width - 36, y: 28 },
      );
    if (taggedTask && taggedTask !== state.active) {
      inputGate.unbind('web:' + taggedTask);
      inputGate.unbind('ui:chat:' + taggedTask);
      taggedTask = null;
    }
    const page = state.active ? pages.get(state.active) : undefined;
    if (page && !fullPanel) {
      step = 'WEB';
      if (page.view.getVisible() && !mappingGaps.has(state.active!))
        inputGate.bind('web:' + state.active, page.view.getBounds(), {
          x: 30,
          y: 120,
        });
      const chat = page.chat.getBounds();
      step = 'CHAT';
      inputGate.bind('ui:chat:' + state.active, chat, {
        x: chat.x + 20,
        y: chat.y + 20,
      });
      taggedTask = state.active;
    }
    if (panel.panel !== 'none') {
      step = 'PANEL';
      const bounds = overlay.getBounds();
      inputGate.bind('ui:panel', bounds, {
        // 全屏面板的左上角可能命中 macOS 窗口按钮；内部中心仍须通过完整原生子树核对。
        x: bounds.x + (panelAnchorGap ? 20 : bounds.width / 2),
        y: bounds.y + (panelAnchorGap ? 20 : bounds.height / 2),
      });
    }
    if (nativeRecoveryPending) {
      stageNotice();
      restoring = true;
    }
    if (toast.getVisible()) {
      step = 'TOAST';
      const bounds = toast.getBounds();
      inputGate.bind('ui:toast', bounds, {
        x: bounds.x + 20,
        y: bounds.y + 20,
      });
    }
    inputGate.available(true);
    nativeAvailable = true;
    if (restoring) {
      nativeRecoveryPending = false;
      log.event('command', { code: 'NATIVE_INPUT_RESTORED' });
      broadcast({ notice: nativeRestoredNotice });
    }
  } catch (error) {
    if (restoring) toast.setVisible(false);
    const code =
      error instanceof Error && /^NATIVE_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'NATIVE_INPUT_UNAVAILABLE';
    log.event('failure', { code: step + '_' + code });
    if (nativeAvailable) suspend(null, 'native-unavailable');
    inputGate.available(false);
    nativeAvailable = false;
    nativeRecoveryPending = true;
  }
}
function stageNotice(): void {
  clearTimeout(noticeTimer);
  toast.setVisible(true);
  const [w = 800] = win.getContentSize();
  toast.setBounds({
    x: Math.round((w - 460) / 2),
    y: 98,
    width: 460,
    height: 74,
  });
  noticeTimer = setTimeout(() => toast.setVisible(false), 5500);
}
function broadcast(event: WorkspaceEvent): void {
  for (const { contents } of trusted.values())
    if (!contents.isDestroyed()) contents.send('workspace-event', event);
}
function emit(event: WorkspaceEvent): void {
  if (event.notice && toast) {
    stageNotice();
    nativeBindings();
  }
  broadcast(event);
}
function loadUI(
  contents: WebContents,
  role: 'chrome' | 'chat' | 'panel' | 'toast',
  taskId?: string,
): Promise<void> {
  trusted.set(contents.id, { contents, role, taskId });
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('did-finish-load', () =>
    contents.send('workspace-event', { state, panel }),
  );
  contents.on('destroyed', () => trusted.delete(contents.id));
  const query = new URLSearchParams({
    surface: role,
    ...(taskId ? { taskId } : {}),
  });
  return contents.loadURL('helpr://workspace/index.html?' + query.toString());
}
function layout(): void {
  if (!win || win.isDestroyed()) return;
  const [width = 800, height = 600] = win.getContentSize();
  for (const [taskId, { view, chat }] of pages) {
    const task = state.tasks.find((t) => t.id === taskId);
    const active = taskId === state.active && !task?.hidden;
    view.setVisible(active && Boolean(task?.url));
    chat.setVisible(active);
    view.setBounds({ x: 0, y: 88, width, height: Math.max(1, height - 88) });
    const cw = Math.min(340, width - 32),
      ch = task?.minimized ? 48 : Math.min(410, height - 130);
    chat.setBounds({
      x: width - cw - 18,
      y: height - ch - 18,
      width: cw,
      height: ch,
    });
  }
  const visible = panel.panel !== 'none';
  overlay.setVisible(visible);
  if (panel.panel === 'preview')
    overlay.setBounds({
      x: Math.min(Math.max(8, panel.x ?? 130), width - 344),
      y: 52,
      width: 336,
      height: 260,
    });
  else overlay.setBounds({ x: 0, y: 0, width, height });
  nativeBindings();
}
function pageState(
  taskId: string,
  phase: 'loading' | 'manual' | 'error',
  error = '',
): void {
  const page = pages.get(taskId);
  if (!page?.view.webContents) return;
  const url = page.view.webContents.getURL();
  try {
    notify({ page: { taskId, url: websiteURL(url), phase, error } });
  } catch {
    /* 空白初始化不成为网站记录。 */
  }
}
function bindPage(task: Task): void {
  const remote = session.fromPartition(
    fixture?.partition ?? 'persist:helpr-web',
  );
  const local = session.fromPartition('helpr-ui');
  const view = new WebContentsView({
    webPreferences: { ...prefs, session: remote, focusOnNavigation: false },
  });
  const chat = new WebContentsView({
    webPreferences: { ...prefs, session: local, preload },
  });
  const page = {
    view,
    chat,
    generation: 0,
    stack: [] as WebContentsView[],
    rebuild: () => {},
  };
  pages.set(task.id, page);
  win.contentView.addChildView(view);
  win.contentView.addChildView(chat);
  void loadUI(chat.webContents, 'chat', task.id).catch(() =>
    emit({ notice: '对话暂未打开。你的记录仍保留，请重新打开 helpr 后重试。' }),
  );
  const watch = (view: WebContentsView) => {
    const wc = view.webContents;
    let initialLoad = true;
    wc.once('did-finish-load', () => {
      initialLoad = false;
    });
    if (startup.validation)
      wc.on('before-input-event', (_event, input) => {
        if (input.type === 'keyDown') inputGate.tracePageInput(task.id);
      });
    const register = () =>
      page.view === view &&
      notify({
        registration: {
          taskId: task.id,
          targetId: wc.getOrCreateDevToolsTargetId(),
          generation: page.generation,
        },
      });
    wc.on('did-start-navigation', (_event, _url, _inPlace, main) => {
      if (page.view === view) {
        // 首次重建页面仍在阻断门内；其加载不能覆盖从记录恢复的原暂停原因。
        if (!initialLoad) suspend(task.id, 'page-change');
        page.generation++;
        register();
        if (main) pageState(task.id, 'loading');
      }
    });
    wc.on('did-navigate', () => {
      if (page.view === view) {
        pageState(task.id, 'manual');
        nativeBindings();
      }
    });
    wc.on('did-navigate-in-page', (_event, _url, main) => {
      if (main && page.view === view) pageState(task.id, 'manual');
    });
    wc.on('did-fail-load', (_event, code, _description, url, main) => {
      if (main && code !== -3 && page.view === view) {
        notify({
          page: {
            taskId: task.id,
            url,
            phase: 'error',
            error: 'PAGE_LOAD_FAILED',
          },
        });
        emit({
          notice:
            '网页暂未打开。可以检查地址后在地址栏重新打开；任务与对话仍保留。',
        });
      }
    });
    const guard = (event: { preventDefault: () => void }, url: string) => {
      try {
        websiteURL(url);
      } catch {
        event.preventDefault();
        emit({
          notice: '这个地址无法在网页工作区打开。请使用网站的 HTTPS 地址。',
        });
      }
    };
    wc.on('will-frame-navigate', (event) => guard(event, event.url));
    wc.on('will-redirect', (event, url) => guard(event, url));
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('render-process-gone', () => {
      if (page.view === view) suspend(task.id, 'page-change');
    });
    wc.on('destroyed', () => {
      if (page.view === view && !closing) suspend(task.id, 'page-change');
    });
    wc.setWindowOpenHandler((details) => {
      try {
        websiteURL(details.url);
      } catch {
        suspend(task.id, 'page-change');
        emit({
          notice: '这个弹窗地址暂不能打开，已保留原网页与文字并暂停本任务。',
        });
        return { action: 'deny' };
      }
      if (page.view !== view || page.stack.length >= 4) {
        suspend(task.id, 'page-change');
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            ...prefs,
            session: remote,
            focusOnNavigation: false,
          },
        },
        createWindow: (options) => {
          suspend(task.id, 'page-change');
          page.generation++;
          inputGate.unbind('web:' + task.id);
          const popup = new WebContentsView({
            ...options,
            webPreferences: {
              ...options.webPreferences,
              ...prefs,
              session: remote,
              focusOnNavigation: false,
            },
          });
          page.stack.push(view);
          view.setVisible(false);
          page.view = popup;
          win.contentView.addChildView(popup);
          win.contentView.addChildView(chat);
          win.contentView.addChildView(overlay);
          win.contentView.addChildView(toast);
          watch(popup);
          popup.webContents.once('destroyed', () => {
            if (page.view !== popup || closing) return;
            suspend(task.id, 'page-change');
            page.generation++;
            const parent = page.stack.pop();
            if (parent?.webContents && !parent.webContents.isDestroyed()) {
              page.view = parent;
              notify({
                registration: {
                  taskId: task.id,
                  targetId: parent.webContents.getOrCreateDevToolsTargetId(),
                  generation: page.generation,
                },
              });
              layout();
              pageState(task.id, 'manual');
            }
          });
          layout();
          if (details.disposition === 'background-tab')
            void popup.webContents
              .loadURL(details.url, {
                httpReferrer: details.referrer,
                ...(details.postBody
                  ? {
                      postData: details.postBody.data,
                      extraHeaders:
                        'Content-Type: ' +
                        details.postBody.contentType +
                        (details.postBody.boundary
                          ? '; boundary=' + details.postBody.boundary
                          : ''),
                    }
                  : {}),
              })
              .catch(() => {});
          return popup.webContents;
        },
      };
    });
    wc.on('will-prevent-unload', (event) => {
      const result = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['保留网页', '放弃网页编辑'],
        defaultId: 0,
        cancelId: 0,
        message: '网页有尚未保存的内容',
        detail: '保存到网站后再退出，可以保留这些网页编辑。',
      });
      if (result === 1) event.preventDefault();
    });
    register();
  };
  watch(view);
  page.rebuild = () => {
    suspend(task.id, 'page-change');
    page.generation++;
    inputGate.unbind('web:' + task.id);
    win.contentView.removeChildView(page.view);
    page.view = new WebContentsView({
      webPreferences: { ...prefs, session: remote, focusOnNavigation: false },
    });
    win.contentView.addChildView(page.view);
    win.contentView.addChildView(chat);
    win.contentView.addChildView(overlay);
    win.contentView.addChildView(toast);
    watch(page.view);
    layout();
  };
  if (task.url && (fixture || safeStorage.isEncryptionAvailable()))
    void view.webContents.loadURL(websiteURL(task.url)).catch(() => {});
  else if (task.url)
    emit({
      notice:
        '系统凭据保护尚不可用。请完成 macOS 授权后重新打开；任务与对话仍保留。',
    });
}
function reconcile(): void {
  let added = false;
  for (const task of state.tasks)
    if (!pages.has(task.id)) {
      bindPage(task);
      added = true;
    }
  // 仅新视图改变层级；普通记录回执不能移除正在接收键盘的原生浮层。
  if (added) {
    win.contentView.addChildView(overlay);
    win.contentView.addChildView(toast);
  }
  layout();
  emit({ state });
}
async function perform(input: unknown): Promise<unknown> {
  const command = z.object({ kind: z.string() }).parse(input);
  if (startup.validation && command.kind === 'validation-move') {
    const job = z
      .strictObject({
        kind: z.literal('validation-move'),
        taskId: z.string().min(1).max(100),
        x: z.number().min(1),
        y: z.number().min(1),
      })
      .parse(input);
    const page = pages.get(job.taskId);
    if (!page || state.active !== job.taskId) throw Error('PAGE_NOT_AVAILABLE');
    const bounds = page.view.getBounds();
    if (job.x >= bounds.width || job.y >= bounds.height)
      throw Error('INVALID_MOVE');
    inputGate.validationMove(bounds.x + job.x, bounds.y + job.y);
    return null;
  }
  if (startup.validation && command.kind === 'validation-fault') {
    const { fault, taskId } = z
      .strictObject({
        kind: z.literal('validation-fault'),
        fault: z.enum([
          'mapping-gap',
          'mapping-restore',
          'destroy-view',
          'panel-anchor-gap',
          'panel-anchor-restore',
        ]),
        taskId: z.string().min(1).max(100),
      })
      .parse(input);
    const page = pages.get(taskId);
    if (!page) throw Error('PAGE_NOT_AVAILABLE');
    if (fault === 'panel-anchor-gap' || fault === 'panel-anchor-restore') {
      if (panel.panel === 'none' || panel.panel === 'preview')
        throw Error('FULL_PANEL_REQUIRED');
      // 只由继承的验证父通道改变取样点，实际失败和恢复仍走原生绑定及暂停路径。
      panelAnchorGap = fault === 'panel-anchor-gap';
      nativeBindings();
      return null;
    }
    if (fault === 'destroy-view') page.view.webContents.close();
    else {
      if (fault === 'mapping-gap') {
        mappingGaps.add(taskId);
        inputGate.unbind('web:' + taskId);
      } else {
        mappingGaps.delete(taskId);
        nativeBindings();
      }
    }
    return null;
  }
  if (command.kind === 'show') {
    win.show();
    win.focus();
    return null;
  }
  if (command.kind === 'choose-backup') {
    const { mode } = z
      .strictObject({
        kind: z.literal('choose-backup'),
        mode: z.enum(['directory', 'file']),
      })
      .parse(input);
    const result = await dialog.showOpenDialog(
      win,
      mode === 'directory'
        ? {
            title: '选择本机备份位置',
            properties: ['openDirectory', 'createDirectory'],
          }
        : {
            title: '选择 helpr 备份',
            properties: ['openFile'],
            filters: [{ name: 'helpr 备份', extensions: ['helpr-backup'] }],
          },
    );
    return { file: result.canceled ? null : (result.filePaths[0] ?? null) };
  }
  if (command.kind === 'verify-input') {
    const { taskId } = z.object({ taskId: z.string() }).parse(input);
    nativeBindings();
    const page = pages.get(taskId);
    if (
      !page?.view.webContents ||
      page.view.webContents.isDestroyed() ||
      !nativeAvailable
    )
      throw Error('NATIVE_INPUT_UNAVAILABLE');
    const ticket = inputGate.state(taskId);
    if (!ticket.available) throw Error('NATIVE_INPUT_UNAVAILABLE');
    return { epoch: ticket.epoch };
  }
  if (command.kind === 'dismiss-notice') {
    toast.setVisible(false);
    return null;
  }
  if (command.kind === 'hide') {
    win.hide();
    return null;
  }
  if (command.kind === 'panel') {
    const next = panelSchema.parse(input);
    clearTimeout(panelTimer);
    const apply = () => {
      const overlayHadFocus =
        webContents.getFocusedWebContents() === overlay.webContents;
      panel = next;
      layout();
      emit({ panel });
      if (panel.panel !== 'none' && (panel.focus || panel.panel !== 'preview'))
        overlay.webContents.focus();
      else if (panel.panel === 'none' && overlayHadFocus)
        win.webContents.focus();
    };
    if (next.panel === 'none' && next.delayed)
      panelTimer = setTimeout(apply, 240);
    else apply();
    return null;
  }
  if (command.kind === 'reload' || command.kind === 'navigate') {
    const job = z
      .object({ taskId: z.string(), url: z.string().optional() })
      .parse(input);
    const page = pages.get(job.taskId),
      task = state.tasks.find((t) => t.id === job.taskId);
    if (!page || !task || !(fixture || safeStorage.isEncryptionAvailable()))
      throw new Error('PAGE_NOT_AVAILABLE');
    try {
      // Electron 在销毁后清空此 getter，未必还能调用 isDestroyed()。
      if (!page.view.webContents || page.view.webContents.isDestroyed())
        page.rebuild();
      await page.view.webContents.loadURL(websiteURL(job.url ?? task.url));
    } catch {
      throw new Error('PAGE_LOAD_FAILED');
    }
    return null;
  }
  if (command.kind === 'capture') {
    try {
      return (await win.capturePage()).toPNG().toString('base64');
    } catch {
      throw new Error('WINDOW_CAPTURE_FAILED');
    }
  }
  if (command.kind === 'resize') {
    const size = z
      .object({
        width: z.number().int().min(800).max(1800),
        height: z.number().int().min(600).max(1200),
      })
      .parse(input);
    win.setContentSize(size.width, size.height);
    layout();
    return null;
  }
  if (command.kind === 'inspect')
    return {
      pids: app.getAppMetrics().map((p) => ({
        pid: p.pid,
        type: p.type,
        memory: p.memory.workingSetSize,
      })),
      pages: [...pages.values()].map((p) => ({
        pid: p.view.webContents?.getOSProcessId() ?? null,
        bounds: p.view.getBounds(),
      })),
      encryptionAvailable: fixture ? null : safeStorage.isEncryptionAvailable(),
      window: {
        visible: win.isVisible(),
        bounds: win.getBounds(),
        contentBounds: win.getContentBounds(),
        workArea: screen.getDisplayMatching(win.getBounds()).workArea,
        fullScreen: win.isFullScreen(),
        buttonPosition: win.getWindowButtonPosition(),
      },
      switches: {
        port: app.commandLine.hasSwitch('remote-debugging-port'),
        pipe: app.commandLine.hasSwitch('remote-debugging-pipe'),
        inspect: app.commandLine.hasSwitch('inspect'),
      },
    };
  throw new Error('UNKNOWN_COMMAND');
}
ipcMain.handle('workspace-request', (event, input: unknown) => {
  const binding = trusted.get(event.sender.id);
  if (
    !binding ||
    event.sender !== binding.contents ||
    event.senderFrame !== binding.contents.mainFrame ||
    event.senderFrame.url !== binding.contents.getURL()
  )
    throw new Error('HOST_REQUEST_DENIED');
  const command = uiCommandSchema.parse(input);
  if (
    binding.role === 'toast' &&
    !['snapshot', 'dismiss-notice'].includes(command.kind)
  )
    throw new Error('HOST_REQUEST_DENIED');
  if (
    binding.role === 'chat' &&
    command.kind !== 'snapshot' &&
    !(
      command.kind === 'panel' && ['settings', 'backup'].includes(command.panel)
    )
  ) {
    if (
      ![
        'draft',
        'message',
        'minimize',
        'model-cancel',
        'execution-intent',
      ].includes(command.kind) ||
      !('taskId' in command) ||
      command.taskId !== binding.taskId
    )
      throw new Error('TASK_NOT_OWNED');
  }
  if (
    (['model-save', 'model-test'].includes(command.kind) ||
      (command.kind.startsWith('backup-') &&
        command.kind !== 'backup-status')) &&
    binding.role !== 'panel'
  )
    throw new Error('HOST_REQUEST_DENIED');
  if (command.kind === 'snapshot') return state;
  return controller.request(
    command,
    ['backup-location', 'backup-open'].includes(command.kind)
      ? 180000
      : command.kind === 'backup-review'
        ? 70000
        : 10000,
  );
});
process.on('message', (input: unknown) => {
  const update = z.object({ state: snapshotSchema }).safeParse(input);
  if (update.success && update.data.state.revision >= state.revision) {
    state = update.data.state;
    if (win) {
      reconcile();
      if (!recovered) {
        recovered = true;
        if (state.tasks.length)
          emit({
            notice: `已找回 ${state.tasks.length} 项原任务和对话。原活动任务先核对进度，停止和等待状态保留。`,
          });
      }
    }
    return;
  }
  const notice = z.object({ notice: z.string() }).safeParse(input);
  if (notice.success) {
    emit({ notice: notice.data.notice });
    return;
  }
  if (z.object({ close: z.literal(true) }).safeParse(input).success) {
    closing = true;
    app.quit();
    return;
  }
  const req = rpcRequestSchema.safeParse(input);
  if (req.success)
    void perform(req.data.command)
      .then((value) => notify({ id: req.data.id, value }))
      .catch((error) => notify({ id: req.data.id, error: errorCode(error) }));
});
process.on('disconnect', () => {
  closing = true;
  app.quit();
});
app.on('before-quit', (event) => {
  if (!closing) {
    event.preventDefault();
    void controller.request({ kind: 'panel', panel: 'quit' }).catch(() => {});
    return;
  }
  for (const { view, chat, stack } of pages.values()) {
    for (const owned of [...stack, view])
      if (owned.webContents && !owned.webContents.isDestroyed())
        owned.webContents.close({ waitForBeforeUnload: false });
    if (chat.webContents && !chat.webContents.isDestroyed())
      chat.webContents.close();
  }
  log.close();
});
void app
  .whenReady()
  .then(async () => {
    const local = session.fromPartition('helpr-ui'),
      remote = session.fromPartition(fixture?.partition ?? 'persist:helpr-web');
    if (fixture)
      remote.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !fixture.allowsRequest(details.url) });
      });
    local.protocol.handle('helpr', async (request) => {
      const url = new URL(request.url);
      if (
        url.hostname !== 'workspace' ||
        !/^\/(?:index\.html|assets\/[A-Za-z0-9_-]+\.(?:js|css|svg))$/.test(
          url.pathname,
        )
      )
        return new Response('Not found', { status: 404 });
      const mime = url.pathname.endsWith('.html')
        ? 'text/html'
        : url.pathname.endsWith('.js')
          ? 'application/javascript'
          : url.pathname.endsWith('.css')
            ? 'text/css'
            : 'image/svg+xml';
      try {
        return new Response(
          await readFile(path.join(renderer, url.pathname.slice(1))),
          { headers: { 'Content-Type': mime + '; charset=utf-8' } },
        );
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    for (const s of [local, remote]) {
      s.setPermissionRequestHandler((_wc, _permission, callback) => {
        callback(false);
        emit({ notice: '网站请求的系统权限未开放；已有任务与对话仍保留。' });
      });
      s.setPermissionCheckHandler(() => false);
    }
    remote.on('will-download', (event) => {
      event.preventDefault();
      emit({ notice: '当前工作区尚未接入下载保存。可以继续查看网页。' });
    });
    win = new BrowserWindow({
      width: 1280,
      height: 880,
      minWidth: 800,
      minHeight: 600,
      title: 'helpr',
      show: false,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 18 },
      backgroundColor: '#ffffff',
      webPreferences: { ...prefs, session: local, preload },
    });
    const painted = new Promise<void>((resolve) =>
      win.once('ready-to-show', () => resolve()),
    );
    const chromeLoaded = loadUI(win.webContents, 'chrome');
    overlay = new WebContentsView({
      webPreferences: { ...prefs, session: local, preload },
    });
    win.contentView.addChildView(overlay);
    const panelLoaded = loadUI(overlay.webContents, 'panel');
    overlay.setVisible(false);
    toast = new WebContentsView({
      webPreferences: { ...prefs, session: local, preload },
    });
    toast.setBackgroundColor('#00000000');
    win.contentView.addChildView(toast);
    const toastLoaded = loadUI(toast.webContents, 'toast');
    toast.setVisible(false);
    win.on('resize', layout);
    win.on('show', () => {
      if (!win.isFullScreen()) win.setWindowButtonVisibility(true);
      nativeBindings();
    });
    win.on('close', (event) => {
      if (!closing) {
        event.preventDefault();
        win.hide();
      }
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'helpr',
          submenu: [
            {
              label: '收起 helpr',
              accelerator: 'Command+W',
              click: () => win.hide(),
            },
            {
              label: '退出 helpr',
              accelerator: 'Command+Q',
              click: () => {
                void perform({ kind: 'panel', panel: 'quit' });
              },
            },
          ],
        },
        {
          label: '编辑',
          submenu: [
            {
              label: '撤销',
              accelerator: 'Command+Z',
              click: () => editFocused('undo'),
            },
            {
              label: '重做',
              accelerator: 'Command+Shift+Z',
              click: () => editFocused('redo'),
            },
            { type: 'separator' },
            {
              label: '剪切',
              accelerator: 'Command+X',
              click: () => editFocused('cut'),
            },
            { role: 'copy' },
            {
              label: '粘贴',
              accelerator: 'Command+V',
              click: () => editFocused('paste'),
            },
            {
              label: '全选',
              accelerator: 'Command+A',
              click: () => editFocused('selectAll'),
            },
          ],
        },
      ]),
    );
    await Promise.all([chromeLoaded, panelLoaded, toastLoaded, painted]);
    win.show();
    try {
      inputGate.install(win.getNativeWindowHandle(), (event) => {
        const taskId = event.owner.startsWith('web:')
          ? event.owner.slice(4)
          : null;
        if (!taskId || pages.has(taskId)) {
          notify({
            suspension: {
              taskId,
              reason: taskId ? 'takeover' : 'ownership-unknown',
              requestId: randomUUID(),
              serial: ++suspensionSerial,
            },
          });
        }
      });
      nativeInstalled = true;
      nativeBindings();
    } catch (error) {
      log.event('failure', {
        code:
          'INSTALL_' +
          (inputGate.failureCode ??
            (error instanceof Error && /^NATIVE_[A-Z_]+$/.test(error.message)
              ? error.message
              : 'NATIVE_INPUT_UNAVAILABLE')),
      });
      inputGate.available(false);
      suspend(null, 'native-unavailable');
      emit({
        notice:
          '本机输入识别暂不可用，自动操作已暂停。网页与对话仍可使用，无需关闭系统安全设置。',
      });
    }
    app.on('activate', () => {
      win.show();
      win.focus();
    });
    notify({
      hostPid: process.pid,
      ...(fixture
        ? {
            fixture: {
              origin: fixture.origin,
              persistent: remote.isPersistent(),
            },
          }
        : {}),
      ready: {
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
      },
    });
    log.event('ready');
  })
  .catch(() => {
    closing = true;
    app.exit(1);
  });
