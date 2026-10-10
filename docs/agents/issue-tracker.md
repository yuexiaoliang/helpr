# 事项管理：本地 Markdown

本仓库的事项和规格说明以 Markdown 文件保存在 `.scratch/`。

## 约定

- 每个功能使用一个目录：`.scratch/<feature-slug>/`。
- 规格说明保存在 `.scratch/<feature-slug>/spec.md`。
- 每个实现事项单独保存为 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号。
- 在事项文件顶部附近用 `Status:` 行记录分诊状态。状态名称见 [triage-labels.md](triage-labels.md)。
- 评论和交流记录追加到文件底部的 `## Comments` 标题下。

## 技能要求“发布到事项管理系统”时

按上述约定创建规格说明或事项文件，并按需创建目录。

## 技能要求“获取相关事项”时

读取所引用路径的文件。仅提供事项编号时，在相关功能目录中查找；若存在歧义，向用户确认。

## Wayfinding 操作

供 `/wayfinder` 使用。工作地图保存为一个文件，每个子事项单独保存为一个文件。

- **工作地图**：`.scratch/<effort>/map.md`，包含 Notes / Decisions-so-far / Fog。
- **子事项**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号，正文记录待解决的问题。`Type:` 行记录 `research`、`prototype`、`grilling` 或 `task`；`Status:` 行记录 `open`、`claimed` 或 `resolved`。
- **阻塞关系**：在文件顶部附近用 `Blocked by: NN, NN` 行列出依赖事项。只有所有依赖事项均为 `resolved`，该事项才解除阻塞。
- **下一项可推进工作**：扫描当前工作目录的事项，选择仍为 `open`、已解除阻塞且尚未领取的事项，按编号从小到大处理。
- **领取**：开始任何工作前，将状态设为 `Status: claimed` 并保存。
- **解决**：在 `## Answer` 标题下追加答案，将状态设为 `Status: resolved`，然后在工作地图的 Decisions-so-far 部分追加摘要和链接。
