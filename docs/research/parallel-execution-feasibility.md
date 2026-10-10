# 首版多任务并行的可行性

调查日期：2026-10-10（America/New_York）。本轮只读官方文档与源码，未运行实验、安装依赖或修改环境。后续产品决定：用户已确认首版最多两项独立任务并行，覆盖首次探索和流程复用；本记录保留技术依据与未知项，不替代[产品访谈](../product/discovery.md)中的决定。

## 结论

**工程判断：首版支持多个独立任务同时推进是可行方向，有明确的浏览器原语支持。** 建议让系统协调共享资源与实际冲突，保留必要的局部等待；不能把“支持并行”解释为任意任务都同时操作、永不排队。具体浏览器承载方式、人工接管和停止隔离仍需实验，不能据此承诺已具备产品能力。

Playwright 官方说明一个浏览器上下文可承载多个页面，各页按活跃页面工作，无需切到前台。因此，并行并不要求多个任务争用同一个系统鼠标。下文的依据来自页面与会话 API，而非测试 runner 的 workers。[Playwright 多页面](https://playwright.dev/docs/pages#multiple-pages)

## 页面操作与后台运行

| 已查明的事实 | 对 helpr 的含义与边界 |
| --- | --- |
| 每个 Playwright `Page` 有自己的 `Mouse`；Chromium 实现经对应的 CDP 会话发送 `Input.dispatchMouseEvent`。[Mouse API](https://playwright.dev/docs/api/class-mouse)、[v1.64.0 输入源码](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/src/server/chromium/crInput.ts) | **推论：**常规网页点击和输入可以定向到任务页面，不必移动操作系统指针或靠反复激活标签页完成。此结论不能外推到原生文件窗口、系统级快捷键、系统剪贴板等共享能力；这些需要单独协调。 |
| Playwright 明确无需 `bringToFront()`；但经 CDP 连接已有浏览器时，`noDefaults: true` 会取消默认焦点模拟等覆盖。[多页面](https://playwright.dev/docs/pages#multiple-pages)、[连接选项](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp-option-no-defaults) | **待验证：**最终采用的启动、连接和可见工作区方式下，后台观察、填表、上传、下载、截图是否正常；不能把 Playwright 默认行为直接视为所有连接方式的保证。 |
| Chrome 的隐藏页面可能冻结或被丢弃；冻结时定时器和部分回调不运行。Electron 默认会节流后台动画和定时器，且可见性还受窗口最小化、遮挡及配置影响。[Chrome 页面生命周期](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)、[Electron 页面可见性](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility)、[Electron webPreferences](https://www.electronjs.org/docs/latest/api/browser-window#new-browserwindowoptions) | **待验证：**标签页切走、窗口被覆盖或最小化时，任务仍正确推进，或被系统识别为暂不可执行。不能宣称任意网站后台运行完全等同前台，也不能据一般生命周期文档断言某个自动化配置一定会冻结。 |

## 隔离在哪一层成立

| 对象 | 官方保证或明确限制 | 不能由此推出 |
| --- | --- | --- |
| `Page` | 独立标签页或弹窗，动作可经具体页面对象发送。弹窗属于打开它的页面所在上下文。[页面](https://playwright.dev/docs/pages)、[BrowserContext](https://playwright.dev/docs/api/class-browsercontext) | 一个页面就是一个独立登录、独立账号或独立服务端事务。 |
| Playwright `BrowserContext` | 提供独立浏览器会话，隔离 cookies、local storage 等浏览器状态；同一上下文中的页面共享其 cookies。非持久上下文不把浏览数据写入磁盘。[会话 API](https://playwright.dev/docs/api/class-browsercontext)、[隔离说明](https://playwright.dev/docs/browser-contexts) | 同一真实账号在不同上下文中对服务器数据的修改互不影响。 |
| Electron `Session` / `partition` | 同一 partition 返回同一 session；`persist:` session 可由应用内同 partition 页面共享并持久化，不带此前缀则在内存中。[官方 session 文档](https://github.com/electron/electron/blob/main/docs/api/session.md#sessionfrompartitionpartition-options) | 新建 `WebContentsView` 就自动获得独立登录状态。 |
| `userDataDir` | 持久保存 cookies、local storage 等；同一目录不能同时供多个浏览器实例启动。`launchPersistentContext()` 返回该实例的唯一上下文。[持久上下文](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context) | 可以为每个任务启动一个浏览器，同时指向同一个目录来共享登录。一个已经运行的实例承载多个页面与此限制不同。 |

**推论：**登录复用与浏览器状态隔离之间需要明确选择。共享 session 可以直接复用用户登录，但退出、切换账号、cookie 变化可能波及依赖它的任务；把已保存登录状态载入多个独立上下文，也不会自动建立实时同步机制。首版必须实测所选站点的登录更新和失效行为，不能承诺一次重新登录就能修复任意复制出来的上下文。

## 为什么同一账号仍可能冲突

**事实：**Playwright 的认证指南直接提醒：共享账号并行修改服务端状态时，测试会相互干扰，例如一项工作检查设置、另一项修改设置。这里引用的是服务端共享状态边界，不以测试 worker 证明产品运行时能力。[认证指南的适用限制](https://playwright.dev/docs/auth#basic-shared-account-in-all-tests)

**推论：**即使页面或 browser context 隔离，两个任务仍可能编辑同一文章、改变同一账号的当前组织，或使用会影响其他会话的登录操作。不同账号也可能编辑同一共享业务对象。是否冲突应按实际资源与操作判断；“同网站”或“同账号”都不足以单独断言一定可并行或必须整项串行。

**工程建议，尚未验证：**各执行显式关联自己的网页、素材、目标与结果；对已知冲突的操作协调先后顺序，对不明确的影响范围保留等待或请求用户参与。冲突对象和任务规则来自运行时观察及约定，产品提供通用协调机制，不在源码中写死某网站的业务规则。一个任务等待内容确认时，其它无依赖任务继续；登录失效时，仅阻挡依赖相应登录状态的任务。

## Stagehand v4 的页面目标与未知项

- **事实：**`act()`、`observe()`、`extract()` 支持显式 `page`；省略时使用 active page。v4 使用自己的页面对象，不能直接传入 Playwright 的 `Page`。[Act](https://docs.stagehand.dev/v4/basics/act#using-with-custom-pages)、[Observe](https://docs.stagehand.dev/v4/basics/observe#using-with-custom-pages)、[Stagehand API](https://docs.stagehand.dev/v4/reference/stagehand)
- **事实：**`experimentalBatch()` 的固定页面不自动成为批次内所有 AI 操作的默认目标；这些操作仍遵循自己的 `page` 参数或调用时的 active page。超时不能保证正在执行的操作不再完成，批次不是原子事务。[批次页面与取消规则](https://docs.stagehand.dev/v4/reference/stagehand#experimentalbatch)
- **事实：**官方说明其它 CDP 客户端可连接同一浏览器，协议消息有各自会话；但导航、关闭页面、修改 cookies、拦截请求等仍会改动共享状态，CDP 不会替调用者协调。[Stagehand 官方组合边界](https://www.browserbase.com/blog/stagehand-v4)
- **未知：**本次查阅现行 v4 API、context 文档、三项基础操作文档和官方发布说明，未找到同一 Stagehand 实例同时处理多个页面调用的完整并发契约，包括重入、独立取消、共享指标归属及失败影响范围。文档还规定一个 browser handle 只能承载一个 Stagehand 实例。因此不能把“有 `page` 参数”写成“已保证所有多页并发行为正确”。[实例限制](https://docs.stagehand.dev/v4/reference/stagehand#create)

**工程建议：**每次观察、执行、重放与结果核对都绑定具体页面身份，不把“当前活动页”作为任务路由。一个页面在同一时刻只由一个执行者写入，人工接管后立即撤销该任务继续派发动作的资格。是否使用 Stagehand、如何与可见工作区结合，仍以前述未知项及[承载边界调查](visible-browser-workspace.md)中的实验为依据。

## 首版并行需要完成的交付实验

以下是建议的验收条件，**全部尚未执行**。测试用后台或故障注入可以控制条件；产品源码仍应使用通用能力和运行时流程。

| 实验 | 必须留下的证据 |
| --- | --- |
| 真正并行且不抢焦点 | 至少两项独立任务的网页操作存在实际交叠；用户在另一任务或其它应用输入时，后台任务不切走当前标签页、不移动系统指针、不把输入发到错误页面。分别覆盖程序重放、AI 探路和其中一项等待模型。 |
| 页面身份与资料隔离 | 两个相同 URL 页面、各自弹窗、导航及重连后仍关联原任务；不同素材、上传文件、截图、AI 输出、发布结果和全局提醒回复不会串到另一项执行。 |
| 人工接管与独立停止 | 接管或停止 A，B 仍继续；A 的已排队动作、迟到模型结果和自动重试不能继续发起操作；说“继续”后重新观察 A。覆盖中文输入、粘贴与自动化事件，不能只靠 `isTrusted` 判别人。 |
| 登录共享与冲突范围 | 同账号不同对象、不同账号、共享登录与隔离登录分别验证；登录失效、重新登录、切换账号影响范围可核对，不误停无依赖任务，不借登录恢复批准内容。 |
| 共享对象与系统资源 | 两项任务修改同一对象时不互相覆盖；同时选择“未处理素材”、保存同名下载、使用剪贴板、修复并更新同一流程时，不误领素材、覆盖结果或保存错误版本。允许共享同一素材的多平台任务不被误判为冲突。 |
| 后台与资源压力 | 标签页隐藏、窗口覆盖或最小化、长时间等待、页面失效后仍有明确处理；测量目标电脑上的内存、响应及 API 限流，据实确定运行上限，不预设无限并发或凭空承诺数量。 |
| 中断与恢复 | 两项运行中任务遭遇 app/浏览器退出后分别恢复；核对已经提交的结果，防止重复发布；原先停止或等待用户的执行不被自动继续。 |

并行增加的主要工程工作是上述隔离、协调与验证，用户无需配置“锁、线程、会话”。首版最多两项独立任务并行、按实际冲突局部等待的范围已确认；运行表现与具体工具组合仍须完成上述实测。
