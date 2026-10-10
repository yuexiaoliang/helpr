# 模型 API 接入实验

用于 [确认现有模型 API 的接入条件](../../issues/03-model-api-access.md)。这是可编辑配置与协议能力的实验入口，不是 helpr 的最终设置界面或模型 SDK。

## 配置

`config.example.json` 提供首轮 DeepSeek 配置。可以复制为本机忽略提交的 `config.local.json`，再修改服务地址、模型或请求选项；也可以用 `--config <路径>` 指定另一份配置。配置中只保存凭据环境变量名。

本次由用户指定 `deepseek-flash`。模板采用 `https://api.deepseek.com` 与 Chat Completions 协议；官方接口文档见 [首次调用](https://api-docs.deepseek.com/)。客户端不写死该服务地址或模型，但目前只实现这一种协议，不能把填入其它协议的名称当作支持证明。

密钥从配置指定的环境变量读取，也可在本机 `.env.local` 中填写 `DEEPSEEK_API_KEY`；环境变量优先。`.env.example` 是空白模板，`.env.local` 被根目录 `.gitignore` 忽略。本次密钥文件权限为 `0600`，实验报告不含密钥和请求头。这只是本机实验保存方式，正式产品的凭据存储仍待实现方案确定。

产品中的常规用户将在设置里配置服务、模型和凭据；无需使用这些实验命令或修改流程代码。

## 运行

在本目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium
npm run check
npm test
npm run run
```

- `check` 只校验本地配置与凭据是否存在，不发送模型请求。
- `test` 运行本机 HTTP 实验桩，检查客户端的请求、SSE 分块、取消、错误脱敏与重定向处理，不读取真实密钥。
- `run` 会发送真实请求：正常完整运行是 10 次请求、8 项检查，全部使用合成文本、工具结果或合成网页截图；无自动重试。首个连接检查失败时停止后续请求。

例如指定其它本机配置：

```sh
npm run run -- --config ./config.local.json --env ./.env.local
```

本轮使用非思考模式、每次最多 512 个输出 token，目的是以小请求核对协议；这不是产品推理模式或后续浏览器任务的固定上限。更换提供方时，提供方专属选项也需要调整，并重新验证。当前客户端取消只中断本地请求与输出消费，不能据此判断提供方已停止计算或计费。

## 证据与复用

`artifacts/<时间>/results.json` 保存配置快照、逐项检查、请求状态、耗时和实际返回的用量；不保存完整模型回复或原始 HTTP 正文。`vision.png` 是实际提交给模型的合成截图，校验码在运行时生成。`artifacts/latest.txt` 是本机指针，不进入 Git。

本轮结果见 [实验记录](REPORT.md)。后续实验可以读取同一份本机配置和凭据；任何实际执行器都仍需验证工具、页面、取消与重放的组合，不能仅凭本探针通过就标记兼容。此实验没有实现多提供方切换界面、密钥加密、质量评估或网站自动操作。
