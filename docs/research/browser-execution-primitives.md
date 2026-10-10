# 浏览器执行基础能力调查

调查日期：2026-10-10（America/New_York）。范围：原生 Playwright 与 Stagehand；只调查官方文档、项目发布信息和官方包元数据，未安装依赖、登录网站或运行实验。

本记录承接 [产品访谈](../product/discovery.md)、[本机执行决定](../adr/0001-local-execution.md)和[运行时流程决定](../adr/0002-runtime-workflows.md)。下文区分库已提供的能力、由这些能力推导的设计责任，以及尚未验证的行为；不据此确定最终技术组合。

## 结论

现有原语支持验证“首次由 AI 定位操作，保存操作数据，后续直接执行”的方向。Stagehand 的 `Action` 可以交回 `act()` 重放并跳过模型推理；原生 Playwright 提供页面操作、文件传输和浏览器状态控制。[Stagehand Action 重放](https://docs.stagehand.dev/v4/basics/act)、[Playwright 操作](https://playwright.dev/docs/input)、[下载](https://playwright.dev/docs/downloads)

但 **Stagehand 的本机自然语言调用不会自动变成无模型的重复执行**。当前 v4 的托管缓存需要 Browserbase 浏览器，本机不适用；要满足 helpr 的目标，仍需形成、保存并选择直接重放的流程，而不能只重复调用相同自然语言指令。[缓存适用范围](https://docs.stagehand.dev/v4/best-practices/caching)

## 版本基线

调查时直接读取 npm Registry 的 `latest` 元数据：`playwright` 为 **1.64.0**，`@browserbasehq/stagehand` 为 **4.2.0**。Stagehand 文档首页跳转至 v4。版本号是本次查询快照，后续实验需固定实际安装版本。[Playwright 包元数据](https://registry.npmjs.org/playwright/latest)、[Stagehand 包元数据](https://registry.npmjs.org/@browserbasehq%2fstagehand/latest)、[Stagehand 当前文档入口](https://docs.stagehand.dev/v4/first-steps/introduction)

Stagehand 的 GitHub `releases/latest` 本次仍指向 `3.7.3`，不能用该入口替代 npm 发布版本判断。v4 迁移文档明确：内置 `agent()` 被移除；本地 `enableCaching`、`cacheDir` 没有对应项；控制循环由调用方管理。这些 v3 能力不应混入当前方案。[本次 GitHub 指向的发布页](https://github.com/browserbase/stagehand/releases/tag/@browserbasehq/stagehand@3.7.3)、[v3 → v4 迁移说明](https://docs.stagehand.dev/v4/migrations/v3)

## 真实网页、文件与登录

| 能力 | 原生 Playwright | Stagehand v4 |
| --- | --- | --- |
| 观察当前页面 | 可读取 HTML、元素文本和 ARIA 快照，也可截图。这些是读取页面的原语；如何由观察结果判断任务进度仍由调用方决定。[页面内容](https://playwright.dev/docs/api/class-page#page-content)、[ARIA 快照](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot)、[截图](https://playwright.dev/docs/screenshots) | `page.snapshot()` 返回面向可访问性的页面树及定位映射，`screenshot()` 提供图像；`observe()` 返回候选操作，`extract()` 提取结构化信息。[页面参考](https://docs.stagehand.dev/v4/reference/page)、[Observe](https://docs.stagehand.dev/v4/basics/observe)、[基础能力](https://docs.stagehand.dev/v4/first-steps/introduction) |
| 上传本地文件 | `locator.setInputFiles()` 接受文件路径或内存内容；动态文件选择控件可通过 `filechooser` 事件取得。这不自动证明网站已接收并完成业务提交。[上传文档](https://playwright.dev/docs/input#upload-files) | `locator.setInputFiles()` 支持路径或内存内容，路径在 SDK 调用方机器解析；当前文档规定每个文件在内存中序列化，上限为 50 MiB。目标网站自身的限制仍需另测。[文件上传参考](https://docs.stagehand.dev/v4/reference/locator) |
| 下载文件 | 提供 `download` 事件、`saveAs()`、文件名和失败信息；上下文关闭会删除其临时下载文件，应在关闭前保存结果。[下载文档](https://playwright.dev/docs/downloads) | 本机启动可设置 `acceptDownloads` 和 `downloadsPath`；启用前者必须提供后者。当前不提供 Playwright 式下载事件和 `download.saveAs()`，文档建议监视下载目录。[迁移文档：文件传输](https://docs.stagehand.dev/v4/migrations/playwright) |
| 跨次执行保留登录 | `storageState` 可保存和恢复身份相关状态；文档覆盖 cookies、localStorage、IndexedDB 等，sessionStorage 需要额外处理。也可用 `launchPersistentContext(userDataDir)` 保留浏览器配置目录。[身份状态](https://playwright.dev/docs/auth)、[持久上下文](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context) | `localBrowser.launch({ userDataDir })` 可跨次保留浏览器数据；未设置时使用临时目录，默认关闭后删除。[用户数据说明](https://docs.stagehand.dev/v4/best-practices/user-data) |
| 人工操作同一个页面 | headed 模式下，`page.pause()` 允许暂停脚本、执行人工步骤，再从暂停点继续。这是调试原语，不是完整的产品接管机制。[暂停文档](https://playwright.dev/docs/api/class-page#page-pause) | 可启动可见浏览器，也可通过 CDP 连接已有浏览器。`keepAlive` 可保留本机浏览器进程。这些允许人查看和操作窗口，但没有据此证明自动执行与人工操作之间存在互斥保护。[浏览器配置](https://docs.stagehand.dev/v4/configuration/browser) |

登录持久化不保证网站永久接受会话；失效与重新登录仍须实际验证。不能默认借用用户日常 Chrome 配置目录：Playwright 明确指出默认 Chrome 用户目录不支持自动化，并且同一用户目录不能由多个浏览器实例同时启动。[浏览器目录限制](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)

上述观察能力也不能证明任意页面都能被正确理解；复杂编辑器、嵌套框架和只靠图像表达的控件仍需样本验证。这是能力覆盖判断，不是官方成功率承诺。

## 首次探索之后，能保存什么

Stagehand `observe()` 返回 `Action[]`，每个操作包含 `selector`、`method`、`arguments`、`description`；`act()` 的结果也暴露实际执行的操作列表。文档演示了自行缓存观察结果。[操作结构与结果](https://docs.stagehand.dev/v4/reference/stagehand)、[观察结果缓存示例](https://docs.stagehand.dev/v4/basics/observe)

这些字段提供可持久化操作记录的基础；**跨进程保存、格式版本、参数绑定、步骤顺序和失效条件仍需 helpr 自行设计**。这是根据返回结构作出的工程推论，不代表库已经提供符合本项目术语定义的完整“流程”。

| 再次执行的路径 | 是否仍调用模型 |
| --- | --- |
| 直接调用 Playwright 操作，或 Stagehand 的确定性 `page` / `locator` 方法 | 这些浏览器操作本身不要求模型推理。[Playwright 操作](https://playwright.dev/docs/input)、[Stagehand 确定性控制](https://docs.stagehand.dev/v4/first-steps/introduction) |
| 在本机再次调用自然语言 `act()`、`observe()` 或 `extract()` | 仍运行推理；本机的 `cache` 选项不生效。[缓存文档](https://docs.stagehand.dev/v4/best-practices/caching) |
| 将已保存的 `Action` 传给 `act()` | 正常重放跳过推理、页面快照和 DOM 稳定等待；若选择器失效且启用 `selfHeal`，会重新推理并重试一次。[Action 重放语义](https://docs.stagehand.dev/v4/basics/act) |
| 使用 Browserbase 托管缓存 | 合格缓存命中时不推理；页面或请求条件变化、缓存不可用等情况会回到推理。此能力不属于已确认的本机浏览器路径。[缓存条件](https://docs.stagehand.dev/v4/best-practices/caching) |

Playwright 的 codegen 可以把人工网页操作录为测试代码，但它不是“理解自然语言任务、执行后自动提炼业务流程”的证明；该差距仍由 helpr 的探索与流程形成机制填补。[官方录制说明](https://playwright.dev/docs/codegen)

## 参数变化、网页变化与两层配合

**参数变化。** Playwright 的填写、选择和上传方法接受运行时值；Stagehand 支持 `%变量名%` 与 `variables`。这提供传入新标题、新文件等数据的接口，不能自动判定哪些值该变、哪些规则应保留。把一次执行中的具体值提炼为流程参数，属于 helpr 的设计工作。[Playwright 输入原语](https://playwright.dev/docs/input)、[Stagehand 变量](https://docs.stagehand.dev/v4/basics/act)

**网页变化。** Playwright locator 会在使用时重新定位元素，并提供自动等待和重试行为；这不意味着它能理解网站改版后的业务含义。[定位器行为](https://playwright.dev/docs/locators) Stagehand 的 `selfHeal` 针对已记录选择器无法解析的情况重新推理；“旧选择器仍匹配、但指向了错误业务对象”不在这条触发条件的保证内，必须另外核对操作目标和结果。[selfHeal 定义](https://docs.stagehand.dev/v4/reference/stagehand)

**等待条件。** 不能因为方法名接近就继承 Playwright 的全部语义。Stagehand 的迁移文档要求补充显式等待；Action 直接重放也会跳过 DOM 稳定等待。具体版本在异步渲染、弹窗和导航中的行为需要实验确认。[迁移差异](https://docs.stagehand.dev/v4/migrations/playwright)、[Action 重放](https://docs.stagehand.dev/v4/basics/act)

**组合关系。** 两者可以处在同一执行方案的不同层。Stagehand 官方确认其他 Playwright/CDP 客户端可以连接同一浏览器，但会共享页面、cookies 和网络拦截等状态，彼此仍可能干扰；v4 当前不能直接把原生 Playwright `Page` 作为 Stagehand 的 `page` 参数。[共享浏览器说明](https://www.browserbase.com/blog/stagehand-v4)、[页面互操作限制](https://docs.stagehand.dev/v4/basics/observe)

此外，Playwright 的 CDP 连接仅限 Chromium，官方指出其功能保真度低于原生 Playwright 协议。Stagehand 本机连接会发现或加载其浏览器扩展，加载需要共享文件系统及相应浏览器启动支持。因此“双客户端操作同一实例”可作为候选实验，不能当作已经完成的集成。[Playwright CDP 限制](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)、[Stagehand 连接要求](https://docs.stagehand.dev/v4/configuration/browser)

## 停止与接管的已知边界

- 当前 Playwright 多数操作和断言支持 `AbortSignal`，包括长时间动作、导航和等待；官方从 1.62 起记录该能力。不能沿用旧资料中“只能等待超时或关闭浏览器”的结论。[1.62 取消能力](https://playwright.dev/docs/release-notes#version-162)
- Playwright 还提供取消下载、终止被拦截请求以及关闭浏览器的原语。关闭自行启动的浏览器会关闭其页面，文档将其类比强制退出；这与保留页面供人工接管的目的不同。[取消下载](https://playwright.dev/docs/api/class-download#download-cancel)、[请求中止](https://playwright.dev/docs/api/class-route#route-abort)、[浏览器关闭](https://playwright.dev/docs/api/class-browser#browser-close)
- Stagehand v4 没有旧 `agent()` 的统一终止信号对应项，迁移指南要求调用方在自己的步骤循环中实现取消。`stagehand.close()` 关闭运行时，但保留浏览器句柄，需要单独关闭浏览器。[控制循环迁移](https://docs.stagehand.dev/v4/migrations/v3)、[关闭语义](https://docs.stagehand.dev/v4/reference/stagehand)
- Stagehand 的 Go locator 参考尤其说明：取消客户端等待不会取消已经发往浏览器的工作。TypeScript 当前 `act` 参考列出超时但未列出通用 `AbortSignal`；因此本次未确认其中途硬取消保障，应按具体调用实验，不能仅用结束等待来声称动作已经停住。[Go 取消边界](https://docs.stagehand.dev/v4/reference/locator)、[当前操作参数](https://docs.stagehand.dev/v4/reference/stagehand)

**设计推论：** 上述 API 的取消对象是浏览器操作、等待、传输或连接，没有提供目标网站业务事务的回滚保证。已经发送的发布请求可能已被网站接受；取消 API 调用或关闭浏览器不能据此证明文章未发布。helpr 需要自己管理停止后不再派发动作、迟到的模型结果不继续执行、人工接管时的控制权，以及恢复前的页面状态核对。这些都应在系统内部完成，不要求用户选择技术上的停止类别。

## 仍属于 helpr 的通用能力

根据前述 API 范围，本轮尚未找到可以直接替代下列产品机制的库契约：

- 将自然语言目标转换为探索步骤，并判断何时已完成任务。
- 将网页动作、素材来源、字段对应关系和任务规则形成独立流程，保存版本及适用条件。
- 选择可复用流程，绑定本次参数，判断变化是否需要 AI 重新探索。
- 核对实际业务结果，处理部分完成与重复执行，避免把动作成功等同于任务完成。
- 统一停止、人工接管、恢复、目标修正和定时触发的执行状态。

这是本次能力边界分析，不是新的架构决定。尤其不能为了绕过这些通用机制，把 WordPress 栏目或某项 Excel 发布逻辑写死到产品源码中；该约束来自本仓库 [ADR-0002](../adr/0002-runtime-workflows.md)。

## 需要的小型实验

以下均未执行。实验应固定库版本与浏览器版本，并保留实际请求、模型调用和页面结果证据；通过一个网页不能推出跨站通用性。

| 实验 | 要得到的证据 |
| --- | --- |
| 冷启动探索与跨进程重放 | 首次得到操作记录，保存后重启执行器；在稳定页面与固定操作参数下，网页动作重放成功，执行这些动作的模型调用计数确实为零。产品访谈允许理解新委托、处理新素材时按需使用 AI，因此这些调用应单独记录。Stagehand 元数据提供推理用量；应与实际模型调用记录相互核对。[用量字段](https://docs.stagehand.dev/v4/reference/stagehand) |
| 新素材与新参数 | 保持流程，换标题、文件和目标数据；确认没有重用旧值，并核实含变量的 Action 在持久化后如何绑定新输入。该组合行为目前未运行确认。 |
| 网页变化 | 分别改变元素位置、定位属性和业务对象；测出何时可以直接重放、何时触发修复，以及“仍能点击但点错对象”如何被结果检查发现。 |
| 文件传输 | 测试动态文件输入、上传完成判据、重复文件名与下载完成判据；比较 Playwright 下载事件和 Stagehand 目录监视实际能提供的证据。 |
| 持久登录和人工接管 | 首次人工登录后重启，模拟失效；接管时人工修改表单或切换页面，再恢复，确认系统不会从旧位置盲目继续。 |
| 停止竞态 | 分别在等待模型、等待元素、上传中和提交请求发出后停止；核对停止后的新动作数、迟到回调、网页真实结果与保留下来的人工操作窗口。不能仅检查调用是否抛错。 |
| Playwright 与 Stagehand 共用浏览器 | 在本机同一 Chromium 实例中交替观察与操作，核实页面对应关系、扩展加载、文件事件、导航与关闭行为；明确由谁拥有浏览器及每一时刻的操作权。 |

本轮没有安装包、运行产品代码、创建测试站点或编写特定网站适配器。跨进程重放可靠性、真实网站成功率、接管后的恢复正确性，以及停止竞态结果目前均未知。
