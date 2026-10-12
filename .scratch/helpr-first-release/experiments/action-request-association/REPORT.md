# 网页动作、上传数据与写请求的关联边界

2026-10-12；一次性技术探路，未实现产品，也未确定浏览器选型。

## 结论

**现有“当前点击窗口 + 同源”及“所选文件摘要 + 请求文件名”不足以证明实际写入得到授权。** 本轮复现了额外写入、迟到请求误关联、同名同大小替换文件、GET 写入、重定向绕过第二次检查和 service worker 绕过页面级拦截。

完整 HTTP 实体检查取得了更窄但可用的证据：在受控本机 HTTP、夹具已提供精确请求约定的情况下，能在转发前拒绝不符的正文或文件，保留合法上传、fetch / XHR 提交及框架内原生表单。这不是任意网站的通用授权保证。旧动作的请求与新动作约定完全相同时，仍能抢先消费新许可；本轮候选因此不能作为完整解法。

关键观测机制已回答本事项，无需为补足上述因果和语义缺口继续消耗模型探索额度。对首版支持范围、首次学习遇到未知请求时的可用性，以及宿主方案的选择，交给“确定浏览器承载与流程执行组合”与用户决定。

## 实验对象与预算

- 运行环境：macOS、Node `v24.18.0`、Playwright `1.64.0`、Chromium `156.0.8078.4`，无界面真实 Chromium，不是模拟请求接口。
- 25 个浏览器场景，2 次浏览器启动，2 个实测源码版本。从首次启动到最后场景结束约 6.4 分钟，未超预算；无重复场景。首批 24 个场景后，独立核对发现“额外请求排第二”不能区分正文检查与次数限制，因而增加“错误请求先到”对照，第二批仅运行该 1 个场景。全部场景达到各次运行前设置的**观测判据**；这包含成功复现错误关联，并不等于 25 项授权保证通过。
- 服务器收到 17 个请求，其中 2 个是重定向入口、15 个在夹具中产生记录，3 个包含文件。候选代理拒绝 12 个请求，其对应未转发结果经服务器收件表核对。
- 模型调用、真实后台准备、上传、发布均为 0。使用本机临时服务器和虚构的 8,192 字节文件。所有监听端口和浏览器在结束时关闭。
- [计划](PLAN.md)、[预算账本](artifacts/budget.json)、[环境与源码版本](artifacts/run-1/environment.json)、[首批 24 个结果](artifacts/run-1/results.json)及[补充结果](artifacts/run-2/results.json)均保留。独立 Python 审计通过 165 个记录及实体一致性检查，见 [审计结果](artifacts/audit.json)；首批审计另存为 [初次审计](artifacts/audit-initial.json)。这些检查不构成另一次浏览器实验。

基线只抽取既有执行器的相关放行条件，不宣称重跑了完整发布流程。它不包含旧执行器所有就绪和版本检查；本轮反例发生在这些前提已经满足的假设下。候选约定、文件、场景角色和动作代次均由实验注入，没有冒充真人授权或 AI 自动学得的流程。

## 关键事实

### 同一动作和脚本栈不代表同一授权

[同次点击基线](artifacts/run-1/baseline-same-click/result.json)中，一个真实浏览器点击发出了两次 POST：预期 `value:1` 和额外 `value:999`。两次目标完全相同，CDP 同步调用栈完全相同，两次都抵达服务器。DOM 点击的 `isTrusted` 为 true；这是 Playwright 自动点击，不能算真人输入证据。事件可信性、当前动作以及调用栈均不能单独解释业务授权。

[迟到基线](artifacts/run-1/baseline-late/result.json)在动作窗口清空时拒绝了旧计时器请求；[下一窗口基线](artifacts/run-1/baseline-late-next/result.json)把宿主的当前动作改成另一个等待中的动作后，同一个旧计时器请求被放行。后一个“下一动作窗口”由夹具显式注入，不是另一套完整网页流程。

### 文件选择证据不等于传输字节

| 样本 | 选择的文件 | 浏览器正文观测 | 实际传输与服务器结果 |
| --- | --- | --- | --- |
| [基线磁盘文件](artifacts/run-1/baseline-disk-upload/result.json) | 原始 8,192 字节 | 路由内 Playwright 与 CDP `getRequestPostData` 都只有 306 字节 | 完整实体 8,498 字节，文件与原始样本一致 |
| [基线替换文件](artifacts/run-1/baseline-replaced-upload/result.json) | 仍是同一个正确的 FileList | 同名的内存 File 请求暴露了完整 8,505 字节 | 文件名和长度不变，内容已替换；错误字节被接收并可下载 |
| [候选合法上传](artifacts/run-1/strict-disk-upload/result.json) | 原始 8,192 字节 | CDP 正文 304 字节；未启用路由的 Playwright 事件正文为 null | 代理完整实体 8,496 字节；与服务器实体摘要相同，下载文件正确 |
| [候选替换上传](artifacts/run-1/strict-replaced-upload/result.json) | 仍是正确的 FileList | 代理完整实体包含替换后的文件 | `multipart-mismatch`，服务器收件为零 |

原始文件 SHA-256 为 `4c523fce4c9f80e7983de670c104a621701987861ceffa6238eca6563d26db16`；替换文件为 `7d2c7ac4888bfd75cd5f56e8d61f69595121183afc81556c876732fd3782c62f`。独立审计使用 Python 邮件解析器从原始 multipart 再提取文件，核对服务器保存字节与实际下载结果，没有复用 JS 解析器。

磁盘文件样本的 `postDataEntries` 没有提供缺失字节，不能仅改读另一属性便声称问题消失。内存 File 样本有完整正文，也不能倒推所有上传均完整可见。该观测与 CDP 对 multipart 文件内容省略的接口说明一致。[官方协议定义](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Network.pdl)

### 已测请求通道

| 通道 / 场景 | 实测结果 | 证据 |
| --- | --- | --- |
| 同次点击的 fetch / XHR | 候选各接收 1 个正确正文，额外请求因许可已消费被拒绝。拒绝原因是次数约束，不能单凭此样本声称语义识别。 | [fetch](artifacts/run-1/strict-same-click/result.json)、[XHR](artifacts/run-1/strict-xhr/result.json) |
| 同次点击，错误请求先到 | 第一个请求在许可仍未使用时因 `body-mismatch` 被拒绝；随后正确正文通过，服务器仅收到正确内容。证明正文摘要检查独立于一次性计数工作，仍不等于理解业务语义。 | [反序对照](artifacts/run-2/strict-extra-first/result.json) |
| GET 写入 | 基线直接放行并产生记录；候选没有匹配的约定，服务器零收件。HTTP 方法不能定义有无副作用。 | [基线](artifacts/run-1/baseline-get/result.json)、[候选](artifacts/run-1/strict-get/result.json) |
| 原生表单、同源 iframe 内导航 | 合法字段完整抵达；请求标为 navigation，CDP initiator 为 `other`，没有脚本调用栈。该样本 `getRequestPostData` 报找不到资源，事件自带的正文仍可用。 | [表单](artifacts/run-1/strict-frame-form/result.json)、[CDP 原始记录](artifacts/run-1/strict-frame-form/cdp.json) |
| 307 重定向 | 基线只收到一次 route 回调，服务器收到初始与重定向后的两次请求。候选代理可见两跳，放行第一跳后拒绝第二跳，最终目标零写入；它也因此阻断了完整重定向流程。 | [基线](artifacts/run-1/baseline-redirect/result.json)、[候选](artifacts/run-1/strict-redirect/result.json) |
| dedicated worker | 页面级 route 可见并拒绝本例；单独附着主页面的 CDP 会话没有记录此请求。候选无约定时拒绝，服务器零收件。 | [页面拦截](artifacts/run-1/page-route-worker/result.json)、[代理](artifacts/run-1/strict-worker-unknown/result.json) |
| service worker 发起的 fetch | page.route 未收到回调，服务器却收到 1 次请求；context.route 可见并拒绝，`request.frame()` 抛错。代理也可见并拒绝无约定请求。 | [页面拦截](artifacts/run-1/page-route-service-worker/result.json)、[上下文拦截](artifacts/run-1/context-route-service-worker/result.json)、[代理](artifacts/run-1/strict-service-worker-unknown/result.json) |
| 延迟 fetch、sendBeacon | 许可撤销后请求确实到达代理，再被拒绝；对应服务器收件为零。 | [fetch](artifacts/run-1/strict-late/result.json)、[beacon](artifacts/run-1/strict-beacon-late/result.json) |

重定向没有第二次 route 回调与 Playwright 的[拦截说明](https://playwright.dev/docs/network#redirects)一致。service worker 请求属于上下文、没有页面 frame 的行为也符合[官方文档](https://playwright.dev/docs/service-workers#network-events-and-routing)。只观察一个页面或直接对所有请求读取 frame 都不是完整策略；关闭 service worker 会改变网站行为，不能用这种改变宣称原网站已获支持。

### 一次性许可仍会认错动作

[同内容旧计时器](artifacts/run-1/strict-matching-timer/result.json)先注入一个旧阶段安排的计时器，再为新动作设置精确约定。旧请求在新点击之前抵达并被放行；真实新点击产生完全相同的 63 字节正文，反而因 `contract-consumed` 被拒绝。

顺序由浏览器事件和独立收件共同确认：设置新许可 → 旧计时器发起 → 服务器接收 → 新点击。两个请求的目标、方法和正文摘要完全相同。CDP 的异步栈在这个小夹具中可以帮助解释计时器来源，但候选代理没有把这类信息可靠绑定为浏览器执行身份；本轮也没有验证任意异步链上的完整因果追踪。即使因果关系追对，同次点击的两次写入仍可能具有不同的业务含义。

因此不能把候选的字节检查升级成“请求属于获准动作”。它仅证明收到的实体符合某份约定，以及一次性计数被执行；约定从哪里来、是否仍适用、对应哪个实际动作，是另外的必要证据。

### 停止必须区分转发之前和之后

[暂停在代理处再撤销](artifacts/run-1/strict-held-revoke/result.json)：完整正文已到代理，转发前再读许可发现失效，服务器没有收到。[转发后停止](artifacts/run-1/strict-forward-stop/result.json)：服务器已收到，停止发生在响应返回之前；服务器仍完成并返回。本例在停止时标记 `dispatched-result-unknown`，随后由收件结果核对为已产生记录。不得把后者报告成“已阻止”，也不能依据停止重新提交。

## 候选能提供的 Interface 与尚未取得的保证

候选 Module 的输入为夹具提供的请求约定、独立场景的代理实例和可撤销许可。约定包括目标、方法、媒体类型、正文摘要或有序 multipart 字段 / 文件摘要，许可限制一次转发。完整实体先保存在代理，再检查许可并转发；未知格式或不匹配不转发。静态资源也由本场景明确列举，不是放行所有 GET。

这只能作为实现规格的一部分候选，不能直接采用为最终架构：

- **已证明**：本轮 HTTP 样本的完整实体可在服务器收到前取得并核对；合法正文和附件可通过；特定未知请求可在转发前拒绝；已转发和未转发可以记录为不同事实。
- **未证明**：首次探索能自动取得正确的请求约定、动态 nonce / 编码的可复用方式、页面 / 动作 / worker 的完整因果归属、两个并行任务共享上下文时的隔离，以及请求造成的全部服务端副作用。
- **明确反例**：只用当前动作或相同请求内容仍会认错来源；同一个可信事件和同一调用栈仍能触发额外行为；原始文件选对仍可上传另一份内容。
- **通道限制**：没有 TLS 解密、HTTPS 发布、QUIC、WebSocket / WebTransport、扩展、跨域框架、popup 或任意页面卸载路径的运行证据。受控 beacon 不等于已测所有卸载情况；本轮代理不是浏览器网络通道的完整封锁装置。复杂 multipart、流式或加密正文也未覆盖。
- **部署限制**：本机 HTTP 代理只是实验装置。它不证明 Electron 或最终执行器具有相同覆盖，也不构成要求用户安装代理证书或关闭网站功能的产品决定。

需要进入组合选择的能力声明是：支持范围内必须能说明观察了什么、核对了什么、是否已转发、实际结果是什么；不能归属或读取完整内容时应明确给出未知并停止进一步自动派发，已经可能送出的保留待核对状态。是否采用该限制、怎样支持首次学习与既有后台，以及如何满足已确认的自主执行体验，需要正式取舍，不能从本实验的 HTTP 夹具直接推广。

## 证据入口

- [证据索引](evidence-index.json)包含原始文件摘要和场景定位；[README](README.md)说明只读复核及实测源码版本。
- 历史来源：[分阶段上传与完整流程](../staged-workflow-checks/REPORT.md)、[第二后台对照](../second-backend-comparison/REPORT.md)。本轮没有补写这些既有真实网页样本的请求授权证明。
