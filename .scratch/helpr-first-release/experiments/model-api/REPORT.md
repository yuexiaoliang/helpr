# DeepSeek 测试接入记录

2026-10-10 已使用用户提供的测试凭据，对 `deepseek-flash` 完成 8 项真实接口检查，均通过。它具备继续进行首轮网页探索与流程实验的接入条件；当前证据只覆盖下表样本，不证明候选浏览器 agent 已兼容或任务成功率已经达标。

## 环境与配置

| 项目 | 本轮实际值 |
| --- | --- |
| 时间 | 2026-10-10 06:02:25–06:02:33，America/New_York |
| 接口地址 | `https://api.deepseek.com/chat/completions` |
| 协议 | Chat Completions，Bearer 认证 |
| 请求与返回模型 ID | `deepseek-flash` |
| 请求选项 | `thinking.type=disabled`，`max_tokens=512` |
| 客户端 | Node.js 24.18.0，原生 fetch；本实验未使用模型 SDK |
| 截图生成 | Playwright 1.64.0，本机 headless Chromium，仅渲染合成页面 |
| 本机凭据位置 | 本实验目录 `.env.local` 中的 `DEEPSEEK_API_KEY`；文件已忽略提交且权限为 `0600` |

地址、模型、协议和请求选项保存在 [可编辑模板](config.example.json)，实际请求代码不固定 DeepSeek 地址或模型。重跑方法见 [README](README.md)。用户希望正式产品允许自行配置模型服务；这里的测试配置不会成为业务流程中的固定依赖。

## 真实请求结果

原始结果见 [results.json](artifacts/2026-10-10T10-02-25-690Z/results.json)，图像输入见 [实际截图](artifacts/2026-10-10T10-02-25-690Z/vision.png)。

| 检查 | 实际观察 | 结论范围 |
| --- | --- | --- |
| 文本响应 | 返回预期的完整短标记 | 此地址、模型与凭据当时可用 |
| JSON 输出 | `json_object` 返回指定字段与类型，客户端核对通过 | JSON 模式通过；未测试服务端强制 JSON Schema |
| 工具回合 | 返回 `inspect_fixture({task: "task-A"})`；校验参数后回传随机工具结果，下一轮正确回复该结果 | 无副作用的完整工具回合通过；没有执行模型生成的任意代码 |
| 页面文本理解 | 从合成可访问性快照区分“保存草稿”和禁用的“提交发布” | 本次文本样例理解正确 |
| 图片输入 | 只根据截图读出运行时生成的 `IMG-243BF5` 与可用按钮“保存草稿” | 本次中文网页截图读取正确；未覆盖复杂编辑器或定位点击 |
| 两个请求并发 | A/B 返回各自的随机标记，客户端请求生命周期重叠 547 ms | 两个同时发起的请求均得到正确响应；服务器内部排程不可见 |
| 流式输出 | 收到正确文本和 `[DONE]` | 本次 SSE 响应解析完成 |
| 客户端取消 | 收到首个内容增量后取消，约 1.57 ms 后调用结束，不再消费后续内容 | 证明客户端取消；提供方是否结束计算、是否继续计费未知 |

共发出 10 次请求，均取得 HTTP 200，没有遇到 429。9 个完整响应返回的用量合计为输入 1,116、输出 116、总计 1,232 token；取消的请求没有取得最终用量，因此上述数字不是全部消耗。短样本没有测出账户配额或可持续吞吐量，不据此作限流或耗时保证。

实际服务的返回模型 ID 为 `deepseek-flash`。官方当前模型表将该名称指向 V4.1-Flash；本轮没有独立识别服务端权重版本。[官方模型说明](https://api-docs.deepseek.com/quick_start/pricing/)

## 客户端检查

另有 6 项本机检查通过：配置约束和缺失凭据、自定义地址路径与模型传递、SSE keep-alive/CRLF/UTF-8 跨块、取消 A 后 B 继续、错误正文不泄露认证值、拒绝自动跟随重定向。它们只验证探针客户端，使用虚构认证值，不计入上面的真实模型证据。

真实取消检查与真实双请求检查分别执行。真实模型请求中“取消 A 时 B 仍在推进”，以及与网页动作的控制组合，仍由 [AI 双页操作归属实验](../../issues/06-ai-parallel-binding.md)验证；不能用本机实验桩代替该结果。

## 已确认的接入条件与未验证项

本轮使用明确的 Chat Completions 协议及非思考模式。DeepSeek 的工具指南与 API 参考给出这种工具调用方式，并将严格工具 schema 作为 Beta 功能；本轮未使用 Beta 地址，没有将 JSON 输出的通过解释为严格 schema 已可用。[工具指南](https://api-docs.deepseek.com/guides/tool_calls/)、[API 参考](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)

以下保留未验证：思考模式及其多轮字段处理、Responses/Anthropic 协议、真实账号限流恢复、长上下文、模型判断质量、Stagehand 等具体执行器兼容性、两个真实网页任务并行、服务端取消与计费。后续应针对所选组合验证，而非为全部接口做无关测试。

配置实践的资料比较保存在独立研究分支的 [固定提交报告](https://github.com/yuexiaoliang/helpr/blob/4fab6200cc1f0477a3c7189ae473ea7852c2d5c8/docs/research/model-configuration-patterns.md)，参考 OpenCode、Cline 的官方文档及源码，未合并进产品分支。产品约定、后续采用方式与事项结论见 [接入事项的 Answer](../../issues/03-model-api-access.md#answer)。
