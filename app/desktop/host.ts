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
  { view: WebContentsView; generation: number; chat: WebContentsView }
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
function emit(event: WorkspaceEvent): void {
  if (event.notice && toast) {
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
  for (const { contents } of trusted.values())
    if (!contents.isDestroyed()) contents.send('workspace-event', event);
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
}
function pageState(
  taskId: string,
  phase: 'loading' | 'manual' | 'error',
  error = '',
): void {
  const page = pages.get(taskId);
  if (!page) return;
  const url = page.view.webContents.getURL();
  try {
    notify({ page: { taskId, url: websiteURL(url), phase, error } });
  } catch {
    /* 空白初始化不成为网站记录。 */
  }
}
function bindPage(task: Task): void {
  const remote = session.fromPartition('persist:helpr-web');
  const local = session.fromPartition('helpr-ui');
  const view = new WebContentsView({
    webPreferences: { ...prefs, session: remote, focusOnNavigation: false },
  });
  const chat = new WebContentsView({
    webPreferences: { ...prefs, session: local, preload },
  });
  const page = { view, chat, generation: 0 };
  pages.set(task.id, page);
  win.contentView.addChildView(view);
  win.contentView.addChildView(chat);
  void loadUI(chat.webContents, 'chat', task.id).catch(() =>
    emit({ notice: '对话暂未打开。你的记录仍保留，请重新打开 helpr 后重试。' }),
  );
  const wc = view.webContents;
  const register = () =>
    notify({
      registration: {
        taskId: task.id,
        targetId: wc.getOrCreateDevToolsTargetId(),
        generation: page.generation,
      },
    });
  wc.on('did-start-navigation', (_event, _url, _inPlace, main) => {
    if (main) {
      page.generation++;
      register();
    }
  });
  wc.on('did-navigate', () => pageState(task.id, 'manual'));
  wc.on('did-navigate-in-page', (_event, _url, main) => {
    if (main) pageState(task.id, 'manual');
  });
  wc.on('did-fail-load', (_event, code, _description, url, main) => {
    if (main && code !== -3) {
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
  wc.setWindowOpenHandler(() => {
    emit({
      notice: '网站希望另开窗口。当前版本请在此标签中手动打开目标网站。',
    });
    return { action: 'deny' };
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
  if (task.url && safeStorage.isEncryptionAvailable())
    void wc.loadURL(websiteURL(task.url)).catch(() => {});
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
  if (command.kind === 'show') {
    win.show();
    win.focus();
    return null;
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
    if (!page || !task || !safeStorage.isEncryptionAvailable())
      throw new Error('PAGE_NOT_AVAILABLE');
    try {
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
        pid: p.view.webContents.getOSProcessId(),
        bounds: p.view.getBounds(),
      })),
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      window: {
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
    !(command.kind === 'panel' && command.panel === 'settings')
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
    ['model-save', 'model-test'].includes(command.kind) &&
    binding.role !== 'panel'
  )
    throw new Error('HOST_REQUEST_DENIED');
  if (command.kind === 'snapshot') return state;
  return controller.request(command);
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
            notice: `已找回 ${state.tasks.length} 项原任务和对话。网站会重新打开，没有自动开始执行。`,
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
  for (const { view, chat } of pages.values()) {
    if (!view.webContents.isDestroyed())
      view.webContents.close({ waitForBeforeUnload: false });
    if (!chat.webContents.isDestroyed()) chat.webContents.close();
  }
  log.close();
});
void app
  .whenReady()
  .then(async () => {
    const local = session.fromPartition('helpr-ui'),
      remote = session.fromPartition('persist:helpr-web');
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
        { role: 'editMenu' },
      ]),
    );
    await Promise.all([chromeLoaded, panelLoaded, toastLoaded, painted]);
    win.show();
    app.on('activate', () => {
      win.show();
      win.focus();
    });
    notify({
      hostPid: process.pid,
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
