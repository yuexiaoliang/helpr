# helpr 正式应用

当前落实[实现事项 01](../.scratch/helpr-first-release-implementation/issues/01-installable-task-workspace.md)已经确认的 `foundation-v2` 交互与 `foundation-v3` 第 4 款标签栏。真实网页占主要区域；每项任务有独立宿主对话和草稿。新建只输入目标，明确 URL 可以打开；未给网站时可在原任务的地址栏补充。模型理解、网页自主执行、停止与人工接管在后续事项实现，当前不会模拟 AI 回答或自动完成。

## 开发入口

使用 `.node-version` 中的 Node 24.18.0 和 `packageManager` 中的 pnpm 11.7.0。

```sh
pnpm install --frozen-lockfile
node node_modules/electron/install.js
pnpm compile
pnpm check
pnpm dev
```

pnpm 原生构建许可保存在 `pnpm-workspace.yaml`。Electron 二进制单独准备；没有全局展开依赖。`compile` 先构建 macOS 只读进程映像检查器，再编译控制、网页宿主、记录、观察工作者、独立 CJS preload 与 React 静态界面。当前 Mac 需要已有的 Command Line Tools；用户打开打包应用无需这些开发工具。Linux CI 只编译和测试可运行的记录、契约及 UI，不抵算 macOS 原生和安装验收。

```sh
pnpm build:mac
```

产物位于 `dist/packages/mac-arm64/helpr.app`，仅供当前 Apple Silicon Mac 自用，使用 ad-hoc 签名；对外分发仍按已有规格准备 Developer ID 签名和公证。当前安装候选和验收状态见[核对报告](../docs/testing/evidence/workspace-01/REPORT.md)。应用图标仍为 Electron 默认图标，品牌图标等待对应设计确认。

## 资料与运行职责

正式资料固定在 `~/Library/Application Support/helpr`，独立于安装包；SQLite、浏览器持久会话及诊断分别存放。业务记录只有独立记录进程写入，使用 Zod 契约、XState 纯转换、Drizzle 和 `better-sqlite3`。关键命令采用请求身份、版本检查和事务；回执不明时保留原命令，取消只读核对，避免制造另一份任务。保存未完成或结果未明时阻止退出。

长期控制进程持有私有调试 pipe；每次观察通过独立受管工作者和限定能力转接，只允许所属页面的读取。没有 TCP 调试监听或任意脚本执行入口。启动时拒绝单／双横线的裸调试参数，macOS `proc_pidpath` 核对宿主实际父映像；宿主无法仅凭外部 IPC 或参数取得角色。

真实网页没有 preload，禁用 Node、webview 和任意宿主接口，启用 sandbox、context isolation 与 web security。宿主对话使用独立受信视图，校验发送方、主 frame 和角色。同一网站的持久登录在任务间共享，任务身份、对话和草稿独立；这不证明后续同一业务目标的写入协调已经实现。Cookie 保护从新资料区启用，不能推定整个浏览器目录都加密。

关闭主窗口收起到菜单栏；明确退出先提示可能丢失尚未保存的网页编辑。网站自己的未保存编辑不能由 helpr 代为保存，退出按钮明确表示放弃网页编辑。当前没有后台自动网页动作或定时任务。

Pino／pino-roll 每个角色独占诊断文件，仅保存限定事件、错误码、标识和耗时；按 2 MB、每日和 4 份轮转，不记录目标、URL、消息或凭据。诊断失败不代替或改变业务事实；任务历史不按日志规则清理。

## 验证入口

沿用[本轮验证方案](../docs/testing/workspace-01-plan.md)和累计额度。

```sh
node scripts/validate-startup.mjs
pnpm validate:workspace --install --interactive --fault
```

这不是可以无限重复的日常检查。脚本先记累计次数，再正常启动最终应用；验证资料必须在固定 OS 临时根 `helpr-workspace-validation-<uid>` 内，拒绝指向正式资料的符号链接。安装脚本拒绝覆盖已存在的应用；替换本轮自己的候选前须结束其自有进程并保留构建身份。网页夹具只在本机提供虚构会话；不使用模型或远程业务写入。最终浏览器和数据库资料、构建包及日志均忽略，只提交脱敏结论。

源码测试与旧实验检查分别保留。真实 macOS 中文输入、网页手动登录、焦点和安装后视觉需要实际包证据，不能由 React 模拟输入或旧实验通过替代。具体依赖来自精确版本与锁文件，升级单独核对受影响能力。
