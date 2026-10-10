# 用户自行配置模型服务的实践

调查日期：2026-10-10（America/New_York）。本轮只读调查 OpenCode、Cline 的官方文档与公开源码，未运行这两个产品、读取本机凭据或发送真实模型请求。DeepSeek 文档事实由同轮主调查补充；本轮没有 API Key。

**结论与建议：**helpr 可以采用“提供方预设 + 可编辑连接配置 + 独立凭据引用”的方式，让用户配置一次后正常委托任务。DeepSeek 可作为首轮预设候选。配置保存、连接可用、所需能力通过验证应分别记录；它们不能合并成一个未经实测的“支持该模型”结论。这是工程建议，尚未选择 SDK、密钥存储实现或最终设置界面。

本文沿用[产品访谈](../product/discovery.md)中的本机执行、最多两项独立任务并行与流程不绑定提供方要求。现有 agent 的实现用于回答配置边界，不成为 helpr 必须照搬的产品流程。

## 官方资料能支持什么

文中“事实”有直接来源；“建议”是对 helpr 的工程判断；“待验证”没有本项目运行证据。源码固定到调查时的提交，不宣称这些代码已在某个正式发行包中发布：OpenCode `055d95bb7e278c94baf06235a52cac79dd13ba67`，Cline `bf71bf7cd9fe6816972d7ae5ca5ff0e04e63f87d`。

| 问题 | OpenCode 的事实 | Cline 的事实 |
| --- | --- | --- |
| 提供方与模型如何区分 | 默认模型使用 `provider_id/model_id`；自定义提供方的 ID 与模型 ID 分别对应配置键。[Models](https://opencode.ai/docs/models/#set-a-default) | 配置类型分别保存 `provider`、`model`、`protocol` 与 `baseUrl`，协议枚举包含 `openai-chat`、`openai-responses`、`anthropic` 等。[固定源码](https://github.com/cline/cline/blob/bf71bf7cd9fe6816972d7ae5ca5ff0e04e63f87d/sdk/packages/core/src/services/llms/provider-settings.ts#L34-L39)、[配置字段](https://github.com/cline/cline/blob/bf71bf7cd9fe6816972d7ae5ca5ff0e04e63f87d/sdk/packages/core/src/services/llms/provider-settings.ts#L142-L155) |
| 自定义服务如何接入 | 文档允许自定义 `baseURL`、模型表和请求头，并区分 `/chat/completions` 与 `/responses` 所用的适配包。[Providers](https://opencode.ai/docs/providers/#custom-provider) | 设置文档提供 Base URL、API Key 和 Model ID；所核查界面源码允许从模型列表选择，也保留手动输入 ID。[配置文档](https://docs.cline.bot/provider-config/openai-compatible#general-configuration)、[界面源码](https://github.com/cline/cline/blob/bf71bf7cd9fe6816972d7ae5ca5ff0e04e63f87d/apps/vscode/webview-ui/src/components/settings/providers/OpenAICompatible.tsx) |
| 模型能力在哪里描述 | 自定义模型可设置上下文与输出上限；标准提供方使用模型目录的信息。[Providers](https://opencode.ai/docs/providers/#example) | 自定义模型设置可调整图片支持、上下文与输出上限等；字段声明本身不是服务实测。[配置文档](https://docs.cline.bot/provider-config/openai-compatible#general-configuration)、[当前界面源码](https://github.com/cline/cline/blob/bf71bf7cd9fe6816972d7ae5ca5ff0e04e63f87d/apps/vscode/webview-ui/src/components/settings/providers/OpenAICompatible.tsx) |

**建议：**提供方名称不能代替协议，模型 ID 不能代替能力。helpr 应保存明确的服务地址、协议和模型 ID；预设负责填写常见值，而非让每位用户研究协议。自定义入口允许编辑这些值，但只展示实际已实现的协议，不因配置中出现一个名称就宣称已经兼容。

## 凭据与可分享配置

**事实：**OpenCode 的 `/connect` 把凭据保存到独立的 `auth.json`；所核查源码将 API Key 作为 JSON 字段写入，并指定 POSIX `0600` 权限。这是独立凭据文件，不能称为系统钥匙串或加密存储。[凭据文档](https://opencode.ai/docs/providers/#credentials)、[Auth 源码](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/opencode/src/auth/index.ts)

**事实：**OpenCode 的普通配置支持 `{env:NAME}` 和 `{file:path}`，可引用外部凭据；缺失的环境变量被替换为空字符串。它也支持多层配置合并，而不要求把所有设置放在项目仓库。[变量与合并规则](https://opencode.ai/docs/config/)

**事实：**本轮 Cline 源码中的 `ProviderSettingsManager` 把通过 schema 校验、包含 `apiKey` 等字段的 provider settings 写入 JSON。写入使用临时文件后 `rename`，并尽力把文件权限设为 `0600`；存储代码未在这条路径实施密钥与普通字段的物理分离或加密。不能沿用旧文章中“Cline 的所有 API Key 都在 VS Code SecretStorage”的概括。[存储实现](https://github.com/cline/cline/blob/bf71bf7cd9fe6816972d7ae5ca5ff0e04e63f87d/sdk/packages/core/src/services/storage/provider-settings-manager.ts)、[包含凭据的配置类型](https://github.com/cline/cline/blob/bf71bf7cd9fe6816972d7ae5ca5ff0e04e63f87d/sdk/packages/core/src/services/llms/provider-settings.ts#L142-L155)

**事实：**Cline 设置控件可以根据服务端提供的 `apiKeyLength` 显示已保存凭据的掩码，并把用户新输入的 key 交给写入方法；显示掩码与底层加密是不同问题。[凭据控件逻辑](https://github.com/cline/cline/blob/bf71bf7cd9fe6816972d7ae5ca5ff0e04e63f87d/apps/vscode/webview-ui/src/components/settings/utils/useProviderApiKeyField.ts)

**建议：**helpr 的可分享配置只保存凭据引用，任务、流程、执行记录不携带 key。设置界面显示“已配置／未配置”并提供替换、清除操作；底层只在发送请求时解析引用。首轮实验可引用环境变量或仓库外文件；正式本机产品的凭据存储方式另行验证。不要把实验 `.env` 文件自动升级为最终产品方案。

**建议：**从这些产品中借鉴原子保存、可编辑预设和凭据状态展示即可，不必在首版复制组织配置、项目覆盖、远程策略等所有层级。helpr 首版可以只有用户设置和一个当前默认连接，内部保留稳定连接 ID，为未来多连接留空间。

## 模型列表与连接验证的边界

**事实：**Cline 文档的服务接入示例包含 Verify 操作，并分别列出凭据、模型名与网络错误。[官方文档](https://docs.cline.bot/provider-config/openai-compatible#quickstart)

**事实：**所核查 Cline `refreshOpenAiModels` 的实际操作是请求 `<baseUrl>/models`，读取 `data[].id`；错误时返回空数组。它没有在这个方法中进行对话或工具调用。模型列表加载只能证明该请求取得了列表，不能证明该模型能完成 agent 交互。[模型列表实现](https://github.com/cline/cline/blob/bf71bf7cd9fe6816972d7ae5ca5ff0e04e63f87d/apps/vscode/src/core/controller/models/refreshOpenAiModels.ts)

**建议：**helpr 连接验证按实际执行器的需求分层，失败时给出对应层的简短反馈；不让用户自行解释 HTTP 响应或能力字段。

| 层次 | 最小验证 | 通过后仅能说明 |
| --- | --- | --- |
| 本地配置 | 配置可解析，地址、协议、模型和凭据引用完整；缺失 key 时停在“待填写” | 可以准备请求，尚未连通服务 |
| 连接与模型 | 对指定模型发送很短的文本请求并取得完整响应；模型列表可辅助选择，也允许手填 | 该连接与模型在当时可响应 |
| 工具回合 | 在无副作用的本地样例中取得工具名与参数，验证参数，再回传工具结果并取得下一轮响应 | 所选协议、模型和客户端组合可以完成该工具回合 |
| 内容结构 | 若执行器依赖 JSON 或 schema，分别检测实际需要的模式并检查返回值 | 该模式在该样例通过；JSON 模式与严格 schema 不混为一谈 |
| 图片输入 | 仅当执行器需要看截图时，用合成图片验证输入与识别 | 当前模型及适配链路可处理该图片样例 |
| 并发与停止 | 两项独立的短请求能重叠；取消一项后，另一项继续；迟到输出不可恢复旧执行 | 该组合的客户端控制符合此样例，不证明服务端停止计费或回滚 |

这些是待执行的验证建议。本轮没有将任何一层记为真实 API 已通过。[既有停止实验](../../.scratch/helpr-first-release/issues/02-independent-stop.md)只验证浏览器原语与模拟的迟到回复，不能代替真实模型请求的验证。

## 可供 helpr 使用的配置边界

以下是建议的数据职责，不是已经定稿的文件格式；常规用户只需在设置中选择预设、填写凭据、必要时改地址或模型并运行验证。

| 配置职责 | 建议保留的信息 | 边界 |
| --- | --- | --- |
| 连接身份 | 稳定 ID、显示名、提供方预设 ID | 允许用户改名或换模型，任务与流程不写死提供方 |
| 实际请求目标 | 协议、Base URL、模型 ID | 新协议需要已实现的适配器；预设和自定义地址走同一验证路径 |
| 凭据引用 | 引用种类与标识，或无认证 | 可导出配置没有实际 key；修改目标地址后重新验证该连接 |
| 请求选项 | 明确受支持的超时、输出上限及提供方选项 | 不把某个提供方的推理参数无条件发给其它服务 |
| 能力依据 | 文档或目录声明、用户覆盖、实际验证结果及时间 | “未知”“声明支持”“已测通过”分别保存；不默认把未知当成支持 |
| 验证归属 | 地址、协议、模型、相关选项和凭据版本所对应的配置版本 | 配置变化后，旧的成功结果不能给新配置背书；记录不包含 key |

**建议：**每次执行启动时取得一份固定连接配置，设置修改影响后续执行；是否迁移正在运行的执行由系统另行处理，避免两项并行任务在半个工具回合中使用不同协议或地址。这是执行一致性的工程建议，不新增用户操作步骤。

**建议：**运行时形成的流程只表达网页操作、素材和参数要求，模型访问通过通用接口提供。这样改服务配置不会要求重写“Excel 发布”流程，也符合[通用能力与运行时流程分离的决定](../adr/0002-runtime-workflows.md)。

## DeepSeek 首轮候选的文档事实

以下由同轮主调查在 2026-10-10 核实后汇入。它们是官方文档声明，没有本项目的真实请求证据。

- **事实：**官方入口列出的 OpenAI 兼容 Base URL 为 `https://api.deepseek.com`，模型包括 `deepseek-flash` 和 `deepseek-v4-pro`。[API 入口](https://api-docs.deepseek.com/)
- **事实：**模型表将 `deepseek-flash` 对应为 V4.1-Flash，列出它支持视觉、`deepseek-v4-pro` 不支持视觉；两者均列 JSON Output、Tool Calls、Responses 与 Anthropic API 支持。视觉指南给出 `user` 消息使用 `image_url` 和 data URL 的格式。[模型表](https://api-docs.deepseek.com/quick_start/pricing/)、[视觉指南](https://api-docs.deepseek.com/guides/vision/)
- **事实：**工具指南描述普通工具结果回传，并将严格工具 schema 放在 `/beta`；Chat Completion 不能任意插入客户端伪造的工具调用。并发说明涉及账户级并发、`429` 和 SSE keep-alive。[工具指南](https://api-docs.deepseek.com/guides/tool_calls/)、[并发说明](https://api-docs.deepseek.com/quick_start/rate_limit/)

**建议：**首轮模板可采用 `deepseek-flash` 与明确的 Chat Completions 协议，地址和模型保持可编辑；这是根据当前文档为后续实验选择候选，不是模型质量或完整兼容性结论。凭据先留空，待实际验证时由用户提供。正式协议选择、思考模式、视觉输入、结构化输出、双请求重叠和取消仍须由执行器组合实验确认。

## 本轮没有确定的内容

没有选择 helpr 最终模型 SDK、凭据存储后端、完整 UI、任务中途换模型策略或多提供方自动切换策略；没有推断“OpenAI 兼容”就自动满足所选浏览器 agent 的所有要求。本报告可支持准备本地可编辑模板、连接验证工具与后续实现规格；真实模型接入事项仍应等待实际凭据与通过记录。
