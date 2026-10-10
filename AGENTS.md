# 仓库协作约定

## 交流语言

默认使用中文与用户交流，并使用中文编写说明文档。命令、文件路径、代码标识符和固定状态值保留原文。

## 旧版参考边界

需要参考已有核心功能或 UI 设计时，可只读查看 `/Users/yuexiaoliang/projects/flowpolit`。新版需求、产品流程、领域模型和架构由本次规划独立确定，不默认继承旧版方案。引用旧版材料时，区分已实现代码、模拟演示和未实现的设计设想。

## 产品规划

讨论产品设计或开始实现前，先阅读 `docs/product/discovery.md` 中的已确认需求与未决项。

## Agent skills

### Issue tracker

事项和规格说明以本地 Markdown 文件保存在 `.scratch/<feature-slug>/`。读取或发布事项前，先阅读 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个标准分诊名称作为本地 `Status:` 值。设置分诊状态前，先阅读 `docs/agents/triage-labels.md`。

### Domain docs

采用单一上下文布局：根目录的 `GLOSSARY.md` 和 `docs/adr/`。探索代码库前，先阅读 `docs/agents/domain.md`。
