# 私有浏览器控制与宿主隔离实验

2026-10-12。本机受控实验，结论用于[验证浏览器控制连接与宿主隔离](../../issues/24-private-browser-control.md)。

## 结论

在当前 Mac 上，**长期控制进程独占 Electron 私有调试 pipe，Playwright 工作者通过受管进程通道和受限转接操作所属网页**的路径成立。没有另开调试 HTTP／WebSocket 端口；无需转用 `webContents.debugger` 或放弃 Playwright。最终冻结版本的 **43 项检查全部通过**，其中包括真实两页操作重叠、过期及撤销资格拒绝、跨任务／宿主 target 拒绝、iframe 与 popup 归属、文件能力限制及控制进程退出。

这是指定版本、有限协议能力和本机夹具下的证据。没有把全部 CDP、任意网站、真实业务恢复或已打包应用判为通过。所有前期失败均保留。

## 实际路径与信任关系

`run.mjs` 是独立测试驱动及本机网站接收端；`controller.mjs` 拥有 Electron 子进程与 fd 3/4；`broker.mjs` 根据宿主登记的 target、通道身份和当前资格转接协议；`worker.mjs` 是分别运行 Playwright 或原始协议攻击的独立 Node 进程；`host.cjs` 承载真实 WebContentsView 与独立来源的宿主对话。测试入口允许明确授予新资格和注入停止，它不冒充产品已经理解用户意图。

工作者的 CDP 消息必须带当前随机资格，并且来自发放资格的实际进程通道；不能靠消息中的任务名切换归属。每条命令和迟到响应都检查撤销与期限。浏览器级命令显式允许；其他命令必须使用属于当前客户端的 session，iframe 自动附着从实际父 session 继承归属。未登记目标、其他任务、宿主页面、其他客户端 session 及未覆盖能力拒绝。

控制资格只经进程通信发放，没有放到启动参数、环境变量或网页。最终审计在控制进程仍持有原凭据时扫描本轮文件（包括源码、日志、图片及 profile 的普通文件），没有找到其字节。控制进程及 Node 工作者仍是可信程序，未对 Node 工作者实施操作系统沙箱；不声称抵御已控制当前用户账号、篡改这些程序或控制操作系统的攻击者。

Electron 开启 renderer sandbox、context isolation 和 web security，关闭 Node integration、子 frame 的 Node integration、webview。远程视图没有宿主 preload；对话单独使用 `helpr://ui/` 来源和会话。宿主命令核对发送页面、main frame、来源和具体操作。导航、弹窗、权限与下载由宿主处理。两项网页本轮共用虚构网站会话，以保留共享登录这一实际条件；**页面控制归属不等于 cookie、网站服务端数据或同源存储互不影响**。

## 固定版本、监听面与预算

- macOS 14.8.3 / arm64；外部 Node v24.18.0；Electron 44.7.0，Chromium 152.0.7977.130，Electron 内 Node 24.21.0；Playwright 1.64.0。
- 实际启动参数保存在每轮 `control-events.jsonl` 的 `launch` 和 `host-events.jsonl` 的 `ready`。关键参数是 `--remote-debugging-pipe --site-per-process`；没有 `remote-debugging-port` 或 Node inspector。
- [最终进程清单](artifacts/run-5/owned-processes.json)及[监听检查](artifacts/run-5/listeners.txt)覆盖本轮控制进程、Electron、工作者及当时枚举到的子进程，没有 TCP 监听。只有测试驱动自己创建的回环 HTTP 夹具提供页面；它不接收控制凭据或控制命令。未扫描其他应用或端口。
- [执行前方案](PLAN.md)限定最多 8 次启动、每次 100 场景／20,000 转接命令／1,000 本机 HTTP 请求／240 秒，总证据 400 MiB。本轮用了 **5 次启动、169 个场景实例、73 次本机 HTTP 请求**。模型调用、远程上传与发布均为 **0**。
- 每轮在启动前冻结候选、夹具、测试和方案。最终依赖包版本及关键类型／实现文件的 SHA-256 在 [manifest](artifacts/run-5/manifest.json)；完整文件索引见 [evidence-index.json](evidence-index.json)。五轮约 30.8 MB，未超过预算。

## 运行经过与保留的反例

| 运行 | 已记录检查 | 结果及修订 |
| --- | --- | --- |
| [run-1](artifacts/run-1/checks.json) | 3，2 通过 | 私有 pipe 与 Playwright 连接成功；隐藏窗口的点击稳定性等待超时。随后用不抢焦点的真实可见窗口核对。没有把隐藏状态当作可见工作区已通过。 |
| [run-2](artifacts/run-2/checks.json) | 37，25 通过 | 多项主页面求值等待超时；协议循环同步处理同一批 pipe 消息，异步响应转接却落在后续事件之后，Playwright 丢失初始化上下文。测试本身还有错误的跨客户端 session 参数、超时断言和未处理 Promise 拒绝；最后驱动异常退出，无 summary，不能算完整运行。 |
| [run-3](artifacts/run-3/checks.json) | 43，40 通过 | 按独立事件轮次投递 pipe 消息后，真实操作、重叠和停止成立。两处观察断言不准确：Chromium 自带 `credentialless` 属性不是凭据；文件 popup 在到达宿主 handler 前已经被浏览器拒绝。另发现控制进程退出时 Electron 未完全退出。 |
| [run-4](artifacts/run-4/checks.json) | 43，42 通过 | 修正观察断言并扩展监听清单；记录到 Electron 已进入 `before-quit`，但独立 WebContentsView 仍存活，[进程记录](artifacts/run-4/death-processes.txt)显示宿主仍在。 |
| [run-5](artifacts/run-5/checks.json) | 43，43 通过 | 宿主在退出时显式关闭所拥有的网页视图，并妥善处理断开的 IPC；控制进程强杀后记录到 `will-quit` 与 `process-exit: 0`，宿主及受管工作者全部退出。 |

修订均在下一轮前冻结，未修改旧证据。初始化问题修正在消息投递机制，未通过取消 Playwright 等待、直接改 DOM 或模拟成功掩盖。文件拒绝测试同时要求实际转接拒绝记录与已选文件未变，不能仅凭一次操作超时判为隔离成功。

## 最终能力覆盖

| 检查面 | 实际证据 | 不能据此推定 |
| --- | --- | --- |
| 连接和资格 | 当前资格连接；缺少、伪造、无任务资格、跨进程借用、过期和撤销均拒绝；撤销后重连及新资格使用旧 session 拒绝 | 不是任意本机恶意程序的 OS 隔离，也未验证全部重连竞态 |
| 页面与子目标 | A/B 分别填写、点击；A 不能附着 B／宿主页面，不能用 B 的 session 或 frame；同源 iframe、实际跨站 iframe、宿主登记的 popup 可用且保留归属 | 不是浏览器全部 target 类型的覆盖；共享 worker、service worker、未登记子目标等不自动开放 |
| 协议能力 | 过滤目标枚举；根级与页面级显式允许列表；拒绝嵌套旧协议隧道、创建 context、全局下载设置、全局 cookie 读取及任意文件路径 | 不是仅依靠入口认证的全权 CDP 转发；未验证的方法与参数组合不得默认放行 |
| 素材输入 | Playwright 选入本轮登记的虚构文件；未登记文件被拒绝，原选择未变 | 未向网站上传文件，也没有验证生产素材授权；产品须把素材版本映射到受管文件，不能信任工作者任意路径 |
| 双任务及停止 | 独立网站账本中 A、B 请求均已接收且都未完成，再分别完成；停止 A 后新命令拒绝，B 又实际点击两次，宿主仍在 | 停止不能撤回已接受的请求；不保证网站脚本随后不会自主写入 |
| 迟到效果 | A 请求在停止前已被网站接收，停止后才完成；不接收新的 `forbiddenAfterStop` 请求 | 不可将无成功回执当成从未执行；尚未接入持久记录或恢复判断 |
| 宿主隔离 | 远程页面与同源子 frame 无 `require`／`process`／宿主桥；合法宿主命令成功，非法命令拒绝；文件读取、宿主来源 iframe、外部协议 popup、下载和通知请求受阻 | sender/frame 的各种生命周期组合、任意跨站攻击与引擎漏洞仍未穷尽 |
| 控制进程故障 | 真实 SIGKILL 后 pipe 断开触发应用退出，退出钩子关闭网页，任务工作者也退出；[最终进程观察为空](artifacts/run-5/death-processes.txt) | 不代表正常退出前已保存资料、真实休眠、崩溃恢复或打包更新通过 |

本轮实际观察页面截图：[A](artifacts/run-5/pwA.png)、[B](artifacts/run-5/pwB.png)。它们只辅助说明页面现场，自动断言和独立 [网站请求账本](artifacts/run-5/website-events.jsonl)才是动作及结果依据；导航后输入和文件选择发生正常重置，不把截图当作全部先前步骤仍保留的证明。

## 对既有路线的影响

旧的页面归属与停止实验验证了正常执行机制，但裸 CDP 可被第二客户端绕过。本轮补上控制入口的身份与范围限制，同时增加了一项必须承担的退出职责：**整个控制拥有者丢失时关闭自有网页视图；单项任务停止只撤销它的资格和 session**。正常退出前保存记录、紧急退出后的未知结果仍遵循已确定的持久记录与恢复约定。

实际支持的进程通信重载已见 [Playwright v1.64.0 发布类型](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/types/types.d.ts)。此前网页 API 文档只列 HTTP／WS，并不代表发布包没有该重载；当前实测已验证此路径，不需要绕过认证再暴露端口。依赖升级时仍须重新核对兼容。[Electron v44.7.0 的 pipe 断开处理](https://github.com/electron/electron/blob/v44.7.0/shell/browser/electron_browser_main_parts.cc#L561-L573)请求应用退出，本轮证明还必须清理应用自己持有的 WebContentsView。

宿主策略遵循 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。测试夹具额外禁止向外部网站请求，以守住实验预算；**此围栏不是任意网站宿主隔离已通过的证据**。本轮没有尝试执行下载或打开外部程序，也没有接触真实模型密钥或网站登录。

后续[恢复核对依据自动形成](../../issues/23-autonomous-recovery-evidence.md)应在这条私有路径上组合持久记录和真实流程，不恢复裸端口；所需额外协议能力经通用 Adapter 核对后加入。后续[macOS 封装与运行恢复](../../issues/25-macos-packaged-lifecycle.md)须验证进程启动和退出、协议能力、自用签名、凭据与更新。当前实验依赖开发目录的 Node 和 Electron，不是可独立安装的产品。未改变已确认的五项业务验收、两项并行、直接接管及更新范围。

## 复核

运行 `node .scratch/helpr-first-release/experiments/private-browser-control/verify.mjs` 只读核对源码、依赖与证据哈希、预算、最终检查、独立请求账本、停止后的 B 操作及退出记录；不启动浏览器、不调用模型、不新增网站请求。

整理完成后，仓库检查通过：120 个源码文件语法检查、25 项现有自动测试及既有留存证据核对；15 份相关 Markdown 的 215 个本地链接和 25 个事项的依赖关系通过核对。所有本轮登记的实验进程及枚举子进程均已退出。检查输出中的历史模型次数属于旧实验，未产生本轮模型调用。
