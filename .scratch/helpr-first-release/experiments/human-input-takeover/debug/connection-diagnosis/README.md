# computer use 与控制连接故障诊断

用户要求“你看看为什么没成功”后，单独诊断上一轮的两种失败。原 11 次组合计数保留，本次没有重开实验或调用模型。结构化结果见 [diagnosis.json](diagnosis.json)。

## computer use：诊断时明确阻塞是屏幕捕获权限

原调用 `await cua.getApp('/Users/yuexiaoliang/projects/helpr/.scratch/helpr-first-release/experiments/visible-page-control/node_modules/electron/dist/Electron.app')` 在 120 秒后超时。应用列表仍能在 1.7 秒内返回；对 Codex 窗口的读取也没有在 20 秒内返回，随后该工具内核超时重置。这不能证明所有应用都具有同一种完整超时，但表明问题不限于实验表单逻辑。

对 computer use 辅助服务进行 3 秒只读栈采样，记录了 ScreenCaptureKit 的 `serverDidDisconnect` 和 ReplayKit 的 `recordingDidStopWithError` 路径，见 [采样](sky-service.sample.txt)。采样本身不能确定权限拒绝造成了此前所有超时。

确认可执行文件后，只向 `SkyComputerUseService` 发送 SIGTERM；没有退出 Codex 主程序、实验窗口或修改权限。见 [重启记录](service-restart.json)。随后原样复测同一公开工具调用两次，分别在 1.3082 秒和 0.1174 秒明确返回：

```text
Computer Use server error -10005
com.apple.ScreenCaptureKit.SCStreamErrorDomain Code=-3801
用户拒绝了应用程序、窗口、显示器捕捉的TCC
```

这提供了快速、稳定的当前失败信号：屏幕捕获授权被 macOS 拒绝。它不能反推最初超时前的权限开关状态，也不能判断权限从未授予、被撤销还是更新后失效。只读查询 TCC 数据库同样被系统拒绝，未尝试提升权限或绕过保护。

本机辅助应用的 Info.plist 标识为 `com.openai.sky.CUAService`，`CFBundleDisplayName` 为 **ChatGPT Computer Use**，`CFBundleName` 为 **Codex Computer Use**。需用户在 macOS 的“系统设置 → 隐私与安全性 → 录屏与系统录音”中允许对应应用。此权限属于 computer use 的窗口读取能力；不能据此声称本实验的应用内 NSEvent monitor 也需要录屏授权。[Apple 对 macOS 14 的说明](https://support.apple.com/zh-cn/guide/mac-help/mchld6aa7d23/14.0/mac/14.0)给出了该设置路径。

## 控制页面句柄：两次自然失败均对应系统电源切换

| 本机时间（2026-10-11，America/New_York） | 系统记录 | 实验记录 |
| --- | --- | --- |
| 23:20:14 起 | 屏幕关闭；23:20:18 进入 DarkWake，23:20:23 进入 Sleep | 第 10 次运行约 23:20:15 的 B 循环报告目标页面关闭，早于用户首次“继续”。 |
| 23:44:31 起 | 屏幕关闭；23:44:36 明确记录 `Clamshell Sleep` | 第 11 次运行 23:44:31.291 的 A 句柄关闭，监测处理器随后停止 B。 |

[电源事件摘录](power-events.txt)及[网络 I/O 暂停记录](network-suspension.json)保留来源。两次失败均在相应电源切换时段出现；23:44 同一时段 Codex 另报告 `net::ERR_NETWORK_IO_SUSPENDED`，证据指向系统休眠期间控制连接失效。读取 CDP 目标列表时，A/B、shell、chat 页面仍存在，因此并非实验窗口已经退出。

没有为了复现而强制让用户电脑休眠；以上是两次自然发生的对照。尚未取得这次实际休眠后通过 computer use 恢复的证据，也不将同时发生的 computer use 超时当成控制句柄关闭的原因。

旧版在页面句柄失效后继续使用旧对象，且没有把指令错误显示给用户，导致“继续”无法进入聚焦步骤。第 11 次已增加失效监测、明确“继续”后的重新绑定与读取，以及表单失败提示；19 项自动检查包含人工断连后的公开 IPC 恢复。这些检查尚不能代替真实唤醒恢复和真人键盘、粘贴核对。

## 当前处理与边界

- 用户随后确认“设置过了。”；同一个 `cua.getApp` 调用已恢复可用，权限阻塞解除。
- 原实验进程后来已退出。第 12 次组合明确使用工具操作标记，实测了表单进入、自动聚焦、键盘及粘贴接管、B 继续和重试保留内容。没有新增真人样本，中文输入法完整转换仍未完成，详见[后续自测](../../REPORT.md#授权后工具自测)。
- 工具自测结束后已关闭本轮窗口，原始诊断与各轮失败记录均保留。真实休眠后的恢复尚未通过 computer use 验证。
- 本轮没有改动安装的 Codex 文件、系统权限数据库或共享电源设置。

诊断先分离服务器、客户端与组件边界，参考 [OpenAI 插件故障排查](https://developers.openai.com/plugins/deploy/troubleshooting)；具体结论依据上述本机记录，官方页面未提供这次 native 错误的专门解释。
