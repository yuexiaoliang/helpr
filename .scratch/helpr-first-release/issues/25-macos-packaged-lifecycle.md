# 验证 macOS 自用应用的封装、更新与运行恢复

Type: task
Label: wayfinder:task
Mode: HITL
Status: resolved
Blocked by: 20, 22, 24
Map: [helpr 首版技术决策地图](../map.md)

## Question

在当前用户的 Apple Silicon / macOS 14.8.3 环境中，选定的本机应用能否脱离开发命令启动，保留真实网页与原生输入识别，并按已确认的关闭、退出、休眠、备份和更新规则运行？

前提为[确定本机交付、权限与更新约定](20-local-delivery-and-updates.md#answer)、[验证持久记录与执行资格的中断一致性](22-durable-record-consistency.md)和[验证浏览器控制连接与宿主隔离](24-private-browser-control.md)。

制作明确标记的最小实验应用，使用虚构任务、素材、模型密钥样本和本机网页，不交付完整产品。分别记录本机签名、系统安装检查与面向他人分发的证据，不能把开发目录启动成功等同于独立应用可用。

运行前固定签名候选、Bundle 身份、版本及原生扩展构建方式，核对有效签名和更新包的身份连续性。当前未检出可用 Developer ID Application 身份，不代表用户没有会员；稳定本机签名只是候选，不预先宣称可以完成安装、更新或 Keychain 延续。需要额外发布配置时先准备具体要求交给用户，不自动注册、购买、导出私钥、信任新根证书或降低系统安全设置。

覆盖以下有限路径：

- 从独立应用首次启动与再次启动，原生扩展正常载入；真实点击、中文输入或粘贴按所需最小真人样本核对，工具输入单列。打包后的视图身份及页面恢复不能只靠开发版证据。
- 关闭主窗口后，原页面和任务仍保留，两个合格任务可继续；菜单栏可返回。明确退出阻止新派发、保存记录并清理自有工作者，不把每项任务标成用户停止，也不留下仍操作网页的进程。
- 重开后按原意图核对恢复；真实休眠／唤醒以及锁屏／解锁分开观察，新停止、待参与与结果未知保持。不会自动更改电源或启动项设置。
- 自动检测仅查版本资料，不下载或登记待安装包；用户手动触发或已开启闲时自动更新才进入安装。等待确认、人工现场和结果不明不能被判作可更新空闲；安装准备与新计划触发不能竞争派发。
- 两个实际签名的实验版本完成一次升级；签名／架构／数据兼容不符、更新中断和备份失败分别有明确处理。更新器缓存的下次启动安装行为不能绕过 helpr 的资格检查。
- 本机备份覆盖业务记录及其引用文件，排除模型密钥和浏览器登录；恢复旧备份先暂停自动工作，不能回滚网站效果或按旧记录盲目重发。
- 虚构密钥经受保护的凭据路径保存，更新后可读取或给出真实授权需求；不可用时不降级明文。浏览器 profile、cookie 加密、业务数据和可删缓存的界限分别核对。

更新检测与下载使用受控版本元数据和测试安装包；记录可信来源与签名验证，不把 HTTP 本机故障服务器当作正式更新源的 HTTPS 或发布链证据。正式更新源的地址、维护方式和发布身份在交付前固定并验证，本事项没有授权创建公开发布或上传用户数据。

先完成可自动核对的部分，再给用户最小而明确的系统弹窗、真人输入或休眠动作说明。每轮预算、源版本、实际安装与升级次数、失败保留和停止条件在执行前确定。模型调用与业务后台上传／发布均为零。

输出哪些交付约定已具备运行依据、哪些需新的配置或修订；保留未知，不以不支持自动更新、清空数据或放弃原生接管来暗中缩小用户已确认范围。

## Comments

2026-10-12，[持久记录与执行资格验证](22-durable-record-consistency.md#answer)已在 Node v24.18.0 / SQLite 3.53.1 及本机接收端上取得限定证据，修订了事务内两项容量和启动锁等待。该绑定并非已经选定的 Electron 打包绑定，后者须重新核查版本与同步行为。未可靠保存的停止意图、文件 `fsync` 的断电限制、进程拥有权与真实浏览器控制资格分别保留；不能将强杀实验当作本事项的退出、休眠或升级已通过。

2026-10-12，[私有浏览器控制实验](24-private-browser-control.md#answer)已完成：控制拥有者持有 pipe，独立工作者经受管进程转接连接 Playwright；控制进程强杀后，宿主必须显式关闭自己持有的 WebContentsView 才能完全退出。打包时复验同一能力范围与无裸端口，明确如何独立启动长期控制拥有者，不依赖开发目录的 Node 命令。正常退出前保存、紧急退出后的未知结果、原生接管、锁屏／休眠及更新仍由本事项验证，不从 pipe 故障试验推定。

2026-10-12，[恢复依据自动形成](23-autonomous-recovery-evidence.md#answer)已在私有路径验证真实上传、发布及新进程核对，并补齐受归属约束的 `DOM.getFrameOwner` 能力。目标关联、已上传事实、暂停意图及未知结果须跨打包生命周期保持；不把测试账号的脚本登录算作产品凭据恢复，也不把开发环境的 SQLite／Playwright 组合直接当作打包版本已经验证。

2026-10-12，本轮领取并开始[有界封装实验](../experiments/macos-packaged-lifecycle/PLAN.md)。独立应用、原生编译和自签名指定要求已有初步事实；签名钥匙串的查找／访问配置经对照后可用，没有修改系统信任，先前的信任授权问题已撤回。首次真实点击仍因可见性／稳定性超时未通过，computer use 也超时；等待用户核对可能遗留的系统授权框后再复验。失败、打包名称修正和自有进程清理见[进度记录](../experiments/macos-packaged-lifecycle/PROGRESS.md)，不将其计作最终完成。

2026-10-12，用户取消旧签名弹窗后继续[封装实验](../experiments/macos-packaged-lifecycle/PROGRESS.md)。取得打包版双页操作、停止／等待跨重开、虚构密钥和 Cookie 持久化、更新资格与备份失败隔离的限定证据；实际替换到 0.0.2 并在更新成功记账前中断，重开保持维护暂停。两版指定要求相同，但系统重新要求 Keychain 授权；当前等待用户完成同名 Safe Storage 授权，不能记作无人工参与升级通过。新工作连接期间过早派发已复现修订，修后对照、旧备份恢复、结果未知以及真人与系统生命周期尚待核对；构建 6 / 6、安装 4 / 4，保留全部失败，本事项仍未解决。

2026-10-12 17:35（America/New_York），收到上次授权回复时第 8 次运行已超时，重开同一已安装新版后第 9 次运行仍等待授权并再次到达启动等待上限。任务已保存、派发关闭；当时宿主与控制进程尚未退出，保留这一退出限制。只读核对 Safe Storage 访问规则，旧版与新版的磁盘身份均符合存储规则，未读取密码、未改访问权限或证书信任。重复弹窗原因仍未确定，等待当前系统授权结束后继续核对；没有新增构建或安装。[现场和证据](../experiments/macos-packaged-lifecycle/PROGRESS.md)。

2026-10-12 18:38（America/New_York），用户确认本次授权完成；原进程结束后，第 10 次启动核对已安装新版、原加密样本密钥和任务，并解除维护暂停。旧 Cookie 的一小时有效期早于本次检查结束，跨升级保留断言失败，不能用夹具重新创建的 Cookie 补作成功。随后连接竞争修后对照、旧备份恢复以及第 11 次同版重开的原密钥、新 Cookie 和任务意图保留分别通过；正常退出清理了 12 个自有进程。第一轮打包版真人输入已就绪，真实锁屏／休眠及未知结果跨重开仍待完成。[限定结论与原始证据](../experiments/macos-packaged-lifecycle/PROGRESS.md)。

2026-10-12 22:00（America/New_York），用户找不到窗口。确认第 11 次运行在等待期间达到 90 分钟上限正常退出，真人步骤尚未发生；重新打开同一现有构建为第 12 次启动，保留原停止状态、计数和失败记录，第一轮重新就绪。没有新增构建或安装，不把窗口准备计作真人核对通过。[现场记录](../experiments/macos-packaged-lifecycle/PROGRESS.md)。

2026-10-12 22:06（America/New_York），第一轮打包版真人接管核对完成。用户实际点击 A 并输入中文，A 停在 43，B 在这期间独立推进 15 次；明确继续后 A 核对并完成到目标 44，文字保留，再次继续也未重做。记录完成提示应清楚解释本轮目标这一体验问题，不要求用户重新测试。第二轮已准备真实锁屏／解锁，再单独观察休眠／唤醒；未知结果跨重开仍待执行。[真人证据与范围](../experiments/macos-packaged-lifecycle/artifacts/packaged-human-input-assessment.json)。

2026-10-12 22:20 之后（America/New_York），完成真实睡眠／唤醒和未知结果跨重开样本。休眠后的唤醒先于解锁，旧暂停标记被过早清除，A 在仍锁屏时推进一次；控制进程意外退出后另有六个自有进程残留。两处均保留实际失败，已准备源码修正并取得六项电源事件回放、四项宿主退出检查通过。重开时 A 停止、B 未知保持，继续与闲时更新拒绝且无重做；正常关闭后全部自有进程已结束。当前构建 6 / 6、安装 4 / 4、真人 2 / 2 已用完，[具体复验提议](../experiments/macos-packaged-lifecycle/LIFECYCLE-REVALIDATION.md)尚未执行；本事项保持 claimed，不能以源码检查代替新包实测。[诊断与证据](../experiments/macos-packaged-lifecycle/LIFECYCLE-DIAGNOSIS.md)。

2026-10-13 10:50（Asia/Shanghai），用户批准有界复验，新增额度已用于 build-7 的构建和受控安装。第 14 次启动核对原 A 停止、B 未知及中文保留，继续及闲时更新未绕过未知结果。第 3 轮真实休眠窗口已就绪，等待用户操作，随后核对意外退出后的自有进程清理。本事项仍 claimed；[执行进度](../experiments/macos-packaged-lifecycle/PROGRESS.md)。

2026-10-13 10:58（Asia/Shanghai），新增一轮按约定结束。build-7 在真实休眠／锁屏重叠时保持零次新派发，解锁后才核对，原过早派发反例已消除。A 的一次已送出效果完成到 109 但回执丢失，A 保持未知，B 等待且未知；未新建工作绕过该状态。随后在这个未知现场结束控制进程，仍残留六个自有进程，新增 IPC 断开监听没有实际关闭记录，进程清理修正未通过。第 15 次重开读回真实计数且不重做，最终正常退出清理全部 12 个自有进程。构建 7 / 7、安装 5 / 5、故障 12 / 12、真人 3 / 3，本机 HTTP 401，模型及远程业务写入 0；按获批停止条件不追加本轮实验。事项保持 claimed，退出机制仍需修订并取得真实打包证据。[最终事实与限制](../experiments/macos-packaged-lifecycle/artifacts/lifecycle-revalidation-outcome.json)、[诊断更新](../experiments/macos-packaged-lifecycle/LIFECYCLE-DIAGNOSIS.md#新安装包的实际复验)。

2026-10-13（Asia/Shanghai）续查：用户要求继续定位。固定版本 Electron 的私有 pipe 断开会发起原生退出，原宿主的保存协调可能在 IPC 通知前阻止该退出；历史日志不足以确定实际先后顺序。已补齐完整宿主源码的顺序回放（旧版 5 失败、候选 8 通过）、父进程身份检查及真实打包复验脚本；没有清除 A/B 未知，没有启动或安装新包。新增运行额度详见[意外退出专项复验提议](../experiments/macos-packaged-lifecycle/OWNER-EXIT-REVALIDATION.md)，尚待确认，事项保持 claimed。

2026-10-13 11:24（Asia/Shanghai），用户批准的意外退出专项复验已结束。build-8 收到 IPC 断开并执行关闭及 Electron 退出事件，3.617 秒后仍有四个实际进程存活；原“漏收通知”解释不足，底层退出位置尚未取得线程栈证据。已精确清理，原两项未知、B 等待及网站效果账本保留，未使用剩余一次启动补做。总构建 8 / 8、安装 6 / 6、故障 14 / 14、启动 16 / 17，模型和远程业务写入 0；本轮约 64 秒，按获批失败条件停止，事项保持 claimed。下一步应先采同一构建的原生退出现场，区分延迟与持续阻塞，不直接再加候选构建。[专项结果](../experiments/macos-packaged-lifecycle/artifacts/owner-exit-revalidation-outcome.json)、[方案与实际范围](../experiments/macos-packaged-lifecycle/OWNER-EXIT-REVALIDATION.md#本轮实际结果失败已停止)。

2026-10-13 11:35（Asia/Shanghai），用户要求继续采集原生退出现场，沿用 build-8 完成第 17 次启动和一次中断。宿主采样处于系统错误弹窗，用户截图定位 `will-quit` 诊断统计访问已销毁网页对象的异常；用户确认点击过“好”，故 15 秒后进程消失属于人工确认后退出，不计自动清理通过。该新诊断错误已删去一行统计，回归检查准确复现截图错误、修后九项通过。源码候选尚未打包；当前无实验进程、原未知及网站保持。构建 8、安装 6、启动 17、故障 15，HTTP 405；[原生诊断](../experiments/macos-packaged-lifecycle/NATIVE-EXIT-DIAGNOSIS.md)、[修后实际核对提议](../experiments/macos-packaged-lifecycle/OWNER-EXIT-REPAIR.md)。事项仍 claimed。

2026-10-13 11:54（Asia/Shanghai），用户批准安装修正并完成核对。build-9 仅移除上述诊断统计，以同一证书签名并受控安装；第 18 次启动中断控制进程后，约 186 毫秒内观察到全部 12 个自有进程结束，无人工确认和清理。第 19 次重开保留两项未知、B 等待及中文；继续与闲时更新拒绝，网站不重做，正常退出先保存再关闭。四项实际检查通过，SQLite 完整性为 `ok`，当前无实验进程。累计构建 9 / 9、安装 7 / 7、启动 19 / 19、故障 16 / 17、HTTP 409 / 1,000；真人仍 3 / 3，模型及远程业务写入 0。按本轮约定结束运行，证据收集结论如下；[实测结果](../experiments/macos-packaged-lifecycle/artifacts/owner-exit-repair-outcome.json)。

## Answer

在当前 Apple Silicon / macOS 14.8.3 上，独立 Electron 实验包取得了本机启动、私有网页控制、原生接管、保存与恢复、更新资格及实际版本替换的限定依据。休眠与锁屏重叠、控制拥有者退出的失败已分别取得修后实包证据。可以据此继续[确定首版组合验证与验收安排](21-integrated-validation-and-acceptance.md)，不能据此宣布完整产品可交付。

本事项完成的是有界证据收集：以下未证实项仍是明确的检查条件。下一项须区分实现前必须补验与交付前必须通过的条件；这里不替用户接受缺口、不取消自动更新或其它既有要求。

### 已取得的运行依据

| 范围 | 实际事实与限制 | 证据 |
| --- | --- | --- |
| 独立应用与私有控制 | `.app` 自带 Electron 44.7.0、Playwright 1.64.0、原生扩展及工作者运行环境；从 `/` 和系统 PATH 启动，实际 Node 24.21.0／SQLite 3.53.4。打包标记和原生载入成立，真实双页经私有 pipe 推进，不开放裸调试端口。 | [运行记录](../experiments/macos-packaged-lifecycle/artifacts/run-03/events.jsonl)、[当前冻结包](../experiments/macos-packaged-lifecycle/artifacts/build-9/manifest.json) |
| 本机签名 | 同一短期实验证书与 Bundle 身份完成完整性验证，未修改系统信任；搜索路径恢复。自签名未通过公开分发评估，不是 Developer ID／公证或正式发布身份。 | [最新签名](../experiments/macos-packaged-lifecycle/artifacts/signed-build-9.json) |
| 收起、退出与重开 | 程序通过与关闭窗口共用的入口收起，保留 A 停止与 B 继续，返回保留现场。正常退出先关闭派发、保存，再关闭自有进程；原停止／等待、计数及明确继续可跨重开保持。隐藏时两个合格任务同时推进、真人点击菜单栏未在本实验分别证明。 | [收起核对](../experiments/macos-packaged-lifecycle/artifacts/baseline-checks-2.jsonl)、[重开](../experiments/macos-packaged-lifecycle/artifacts/reopen-checks.jsonl) |
| 真人接管 | 用户点击 A 并输入中文，A 让出期间 B 独立完成 15 次推进；明确继续后 A 核对并完成剩余一步，文字保留，再继续不重复已完成工作。此轮先点击输入框，不能充当打包版仅键盘或粘贴接管的证据。 | [真人核对](../experiments/macos-packaged-lifecycle/artifacts/packaged-human-input-assessment.json) |
| 真实休眠／锁屏 | 旧版在已唤醒但未解锁时错误派发。分开保存睡眠与锁屏原因后，真实重叠区间内零次新浏览器输入，解锁后才核对。A 已送出效果完成但回执丢失，保持未知；B 等待且未知。未证明结果明确的活动任务自动续做。 | [修后电源记录](../experiments/macos-packaged-lifecycle/artifacts/power-fixed-assessment.json) |
| 拥有者异常退出与未知恢复 | build-9 的原两项未知现场中断控制进程，约 186 毫秒内全部 12 个自有进程消失，无人工或清理。重开保持 A `running / uncertain` 109、B `waiting / uncertain` 150；继续及闲时更新拒绝，网站无新增效果，正常退出仍先保存。这个新包样本没有另加一次派发中的中断。 | [四项实际核对](../experiments/macos-packaged-lifecycle/artifacts/owner-exit-repair-outcome.json) |
| 更新资格与实际替换 | 版本检测仅查本机元数据、不下载；默认闲时模式关闭。活动、等待、临近计划、未知及备份失败拒绝安装准备，新计划与更新准备争用同一资格。两版实际签名包完成 0.0.1 → 0.0.2 替换；替换后记账前中断，重开先保持维护暂停，核对后才解除。错误签名、架构声明和数据兼容声明被拒绝；没有运行真正 x64 包或验证正式 HTTPS 源。 | [资格与备份失败](../experiments/macos-packaged-lifecycle/artifacts/update-gate-checks-2.jsonl)、[候选拒绝](../experiments/macos-packaged-lifecycle/artifacts/update-helper-6.jsonl)、[替换中断](../experiments/macos-packaged-lifecycle/artifacts/update-helper-7.jsonl) |
| 备份及旧记录恢复 | 业务备份包含数据库与引用文件，排除密钥和 profile。恢复旧备份不回退网站、不覆盖较新的停止；核对读回实际结果，未选继续的 A 仍停止。 | [旧备份核对](../experiments/macos-packaged-lifecycle/artifacts/old-backup-recovery.jsonl) |
| 凭据与网站状态 | 虚构密钥通过受保护路径保存、重开与升级后能读回；未降级明文。真实升级需要用户再次完成系统授权。新 Cookie 在同版重开后保留；旧 Cookie 在升级核对前已过期，跨升级登录保留没有取得有效结论。 | [升级核对与失败保留](../experiments/macos-packaged-lifecycle/artifacts/upgrade-recovery-after-authorization.jsonl)、[过期边界](../experiments/macos-packaged-lifecycle/artifacts/upgrade-protected-state-scope.json)、[同版重开](../experiments/macos-packaged-lifecycle/artifacts/protected-reopen-after-authorization.jsonl) |

### 失败如何影响实现与验收

- 连接尚未准备好时派发、睡眠／锁屏共用暂停标记、退出时等候已消失的控制拥有者，均暴露了必须通过统一执行资格与生命周期入口处理的条件。自动检查只验证其到达的边界，必须另有真实浏览器和 OS 进程观察。
- 本次新增诊断统计本身也造成退出弹窗。精确回归先复现同一 `TypeError`，删除访问后九项通过，再以实际包的进程消失验证；用户点击“好”后的退出不计自动通过。旧构建失败和全部计数保留，不倒推它们都出于同一个原因。
- 正式发布身份、可信更新源及维护方式尚未固定；同一指定签名要求也没有避免升级后的系统授权提示。跨升级登录、凭据授权失败的处理，以及用户开启闲时自动更新后的完整体验必须取得证据；当前结果不允许宣称无须用户参与的升级已经成立。
- 打包版独立键盘／粘贴、隐藏时两项推进、结果明确的活动任务唤醒续做、派发中异常退出及完整两项业务并行，须纳入后续同一产品组合的检查。不能拿不同实验各自通过拼成完整验收，也不能删除五项业务场景、两项并行或直接接管要求。

### 最终保存与运行边界

本轮使用虚构任务、素材、密钥和本机网页；模型调用与远程业务写入均为 0。最终构建 9、安装 7、启动 19、故障 16、真人 3、本机 HTTP 409，未追加试验。当前无实验进程，SQLite 完整性为 `ok`，两项未知和 B 等待保留，网站及效果账本与运行前后快照逐字节一致。

实验资料位于 [macOS 封装实验](../experiments/macos-packaged-lifecycle/README.md)，详细历史见[进度](../experiments/macos-packaged-lifecycle/PROGRESS.md)。应用数据和闭合业务快照保留在 `~/Library/Application Support/helpr Lifecycle Lab/`；应用包、profile、私钥及钥匙串由忽略规则排除。源码、冻结版本、脱敏失败与结果证据可审阅。此目录包括诊断用途代码，明确属于一次性实验，不是待交付产品实现。
