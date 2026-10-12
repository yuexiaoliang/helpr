# 素材与内容版本实验

此目录仅用于[验证素材、内容预览与发布版本的关联](../../issues/13-material-preview-binding.md)。结论见 [REPORT.md](REPORT.md)，固定范围见 [PLAN.md](PLAN.md)。全部素材与发布均为虚构测试。

## 已完成记录

`artifacts/current/` 是本次固定实验目录，保留原始素材、解析结果、四次真实模型输入输出、确认事件、冻结参数及三次实际网页发布。不要删除它来重置预算。`source/` 与各 `publication-*/source/` 保存实际运行源码；后续入口增加的“已经准备完成则只读退出”保护不改变这些历史快照。

以下检查不会调用模型或发布文章：

```bash
node run.mjs status
/Users/yuexiaoliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 verify.py
/Users/yuexiaoliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 audit.py
node verify-public.mjs
```

最后一条需要后台在线，只读重新核对三篇既有文章。其余检查使用已有记录。相邻 `runtime-flow-replay/node_modules` 提供既有 Playwright；`node_modules` 是忽略提交的 bundled 依赖链接，只供 `build.mjs` 使用。

## 实验入口与职责

- `build.mjs` 通过 Artifact Tool 创建两版虚构表格并保存检查与渲染。`parse.py` 只读提取坐标、类型、公式和缓存值，不包含列的业务含义。
- `versions.mjs` 的版本 Module 校验来源引用值、当前内容、参与回复或约定，以及冻结参数。它不识别平台按钮、分类名或 Excel 列含义，也不声称完成自然语言事实审核。
- `run.mjs prepare` 建立素材与内容证据，执行已标记的确认及版本对照。模型读取相邻 `model-api` 的本机配置，原有调用预算控制会在请求前保留额度。已经准备完成时只读退出，失败请求不清零。
- `publish.mjs A`（或 B、C）在新进程中核对已保存的授权与参数，复用真实模型学得的步骤，经真实网页上传与发布。每项只接受一次尝试，发布尝试已经登记时拒绝重跑；不提供未经结果核对的自动重试。
- `verify.py` 独立从原始 Excel 与公开页面实际记录检验数量、合计、正文、分类及下载。`verify-public.mjs` 重新只读核对正文范围与附件块；`audit.py` 核对版本来源链和用量。

再次执行 `prepare` 或 `publish` 不是重新验收产品。需要新实验时，先明确新问题、授权范围和累计预算，并保留本次原始证据。本轮不会自动开始第二轮发布。
