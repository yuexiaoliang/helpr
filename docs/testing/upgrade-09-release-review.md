# 09 可信下载的交付审阅

AC1已完成当前Mac自用例外范围。用户明确允许“本次自用预览例外公开发布，继续下载验收”后，已公开发布[v0.2.2](https://github.com/yuexiaoliang/helpr/releases/tag/v0.2.2)并更新08独立渠道。默认Gatekeeper首次运行被拒绝；用户另批准单包运行例外，实际下载包才在原隔离资料上完成启动／检查／正常退出，临时隔离属性已恢复。见[最终验收](evidence/upgrade-09/FINAL-ACCEPTANCE.md)及[发布事实](evidence/upgrade-09/PUBLISH-RUNTIME.json)。

| 项目 | 已固定内容 |
| --- | --- |
| 仓库 | `yuexiaoliang/helpr`，公开仓库 |
| 候选 | 41、0.2.2，产品来源 `3c8d986` |
| 包 | [helpr-0.2.2-macos-arm64-local-preview.zip](/Users/yuexiaoliang/projects/helpr/.local/workspace-validation/delivery09-41/helpr-0.2.2-macos-arm64-local-preview.zip)，311,712,836字节 |
| SHA-256 | `eab6218ba4e919ea3d969b29d9f74e7524a38d53d479879158e21d7df63f166d` |
| 说明 | [发布说明](/Users/yuexiaoliang/projects/helpr/.local/workspace-validation/delivery09-41/RELEASE-NOTES.md) |
| 渠道提案 | [macos-arm64.proposed.json](/Users/yuexiaoliang/projects/helpr/.local/workspace-validation/delivery09-41/macos-arm64.proposed.json)，0.2.2／格式6–7／状态模型1，已应用到codex/updates-stable的0d03f1b |
| 核对 | [结构化结果](evidence/upgrade-09/DELIVERY-LOCAL.json)：同包解包后签名、关键哈希、fuses及11个迁移资源一致，目录索引无运行资料文件 |

## 原发布前提案（历史）

以下保留审批前的提案。用户后续已明确批准本次公开自用预览及单包运行例外，没有改变正式对外签名／公证的长期约定。

此包只有当前Mac开发签名，没有Developer ID或公证。[跨事项约定](../../.scratch/helpr-first-release-implementation/README.md#跨事项完成约定)及[渠道约定](../maintenance/version-channel.md)要求首次对外测试或发布前办理正式签名／公证。当前实现和测试批准没有指定公开发布此包或推送来源提交，故未自行发布。

若用户明确为本次当前Mac自用下载验收开放公开预览资产，需要明确这项发布例外及公开可下载范围。具体提案：从 `3c8d986` 推送独立 `codex/preview-0.2.2`，创建 `v0.2.2` 预览Release，上传上述zip、校验和与说明；真实资产核对后仅更新 `codex/updates-stable` 元数据，不推送主分支。公开仓库意味着任何人都可能下载代码及包，不称私有交付。

若遵循正式对外发布要求，则先落实Developer ID／公证，形成新固定候选并复验受影响路径，再发布。当前资产保持本地，不提前计可信下载通过。

## 实际结果

来源分支和tag仅指向3c8d986，没有推送main。GitHub资产311,712,836字节及digest与真实浏览器下载一致。旧版128的实际08入口、用户下载报告、新版131原隔离资料迁移和CUA检查、正常退出与OS清空均分开取证，见[DOWNLOAD-RUNTIME.json](evidence/upgrade-09/DOWNLOAD-RUNTIME.json)。

129保留隔离的默认启动失败；130的定向代码哈希规则被静态接受，但实际运行仍被系统拒绝，两次都不计通过。用户批准单包例外后，仅临时解除已验证安装副本的隔离，测试后1,254项属性逐值恢复，原zip及原解包副本始终保留隔离，临时代码规则已移除，系统Gatekeeper保持启用。本包不具备默认首次运行或正式对外分发通过结论，Release说明已同步。
