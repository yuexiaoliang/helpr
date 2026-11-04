# 自用版本渠道

08固定读取 `https://raw.githubusercontent.com/yuexiaoliang/helpr/refs/heads/codex/updates-stable/macos-arm64.json`。仓库为公开仓库，渠道分支只放版本元数据，不随本机未发布产品代码一起推送，也不包含任务、素材、凭据或安装包。`releases/macos-arm64.json`保存主分支上的维护副本。

2026-11-04，经用户明确批准本次公开自用预览例外，渠道已更新为0.2.2，固定提交 `0d03f1b3b4d712259f5cc43881ea739ee2f7cba9`，仅正常前进渠道分支。独立生产HTTPS读取200，下载页为[v0.2.2](https://github.com/yuexiaoliang/helpr/releases/tag/v0.2.2)，实际资产为 `helpr-0.2.2-macos-arm64-local-preview.zip`，311,712,836字节，SHA-256 `eab6218ba4e919ea3d969b29d9f74e7524a38d53d479879158e21d7df63f166d`。来源分支／tag固定3c8d986，主分支未推送。

本包只有当前Mac开发签名，未公证；实际下载后的默认Gatekeeper启动被拒绝。用户另批准单包临时运行例外后完成旧版0.1.0→实际下载0.2.2的隔离资料迁移与运行，随后恢复全部隔离属性，系统Gatekeeper保持启用。该例外只覆盖本次自用预览，不改变正式对外签名、公证的约定。详见[发布与下载事实](../testing/evidence/upgrade-09/PUBLISH-RUNTIME.json)和[09最终验收](../testing/evidence/upgrade-09/FINAL-ACCEPTANCE.md)。

2026-10-23已仅推送元数据渠道，固定提交 `3d3b97a4508f206f6fd99eca32945069ec27afc1`；独立Node HTTPS读取固定来源返回200并核对0.1.0／格式6／状态模型1／下载页null。主分支产品代码没有随渠道推送。实际候选36使用隔离TLS服务验证10种返回，当前验收范围和失败见[08报告](../testing/evidence/version-08/REPORT.md)；夹具0.2.0外链404仅是链接派发核对，不是实际发布。

## 维护格式

`schema: 1`；版本、最低macOS使用不带前导零的三段数字。`platform`、`arch`必须适用于当前环境；`dataFormats`与`stateModels`分别列出新版真正能迁移或接续的格式。当前公开0.2.2渠道仅声明资料格式6–7、状态模型1；旧候选36实际为6和1，新41为7和1。源码声明能迁移1–7，但本次渠道没有把未全部实测的其它旧格式扩大为支持范围。完整引用资料仍随后续功能扩充，不因“新版”自动推定兼容。

`notes`只放简短纯文本。发布实际新版包后，下载页必须是同一仓库、同一版本的 `https://github.com/yuexiaoliang/helpr/releases/tag/v<version>`；先核对该Release确有当前Mac适用的手动安装资产，再更新版本文件。其它源、协议、仓库、版本、查询参数或重定向链接一律不开放。渠道信息中的较早版本不提供降级入口。程序降级不能保证资料可回退。

更新时在独立渠道分支核对JSON与实际Release，提交并仅推送该分支；保留原提交供回看，不强推覆盖历史。渠道维护不会触发用户机器自动下载或安装。首次正式对外使用仍须Developer ID与公证，不由版本文件代替。

## 网络与打开边界

控制拥有者使用Node HTTPS GET读取固定渠道文件，不使用Electron自动更新器，不使用网页会话、代理自动凭据、模型配置、Cookie或认证头。不发送本地版本或资料格式；所有兼容比较在本机进行。请求只有标准Host／连接头及Accept，不跟随重定向，无重试、无压缩解码，8秒整段截止，响应最多32KiB。TLS正常校验，失败不当已是最新。

只有当前检查成功、版本适用、链接精确匹配且UI引用仍是当前投影时，用户才可打开下载页。打开通过受限业务命令到主进程的 `shell.openExternal`；不会暂停任务、准备退出或登记安装包。浏览器是否实际下载由用户决定。新的检查失败时，旧成功只作为历史显示，旧入口不继续开放。

启动后及持续运行每24小时检查。失败等待下一次或手动再查，不立即循环重试。同一会话“稍后”抑制同版本的重复提醒，设置入口仍保留。主进程只保存会话内的检查状态，不新增业务数据库或备份格式。退出取消在途请求并清理间隔任务。

独立本机HTTPS夹具仅能由已经通过验证资料隔离的启动入口启用；文件限定127.0.0.1的 `/stable.json` 和明确测试CA。生产不读取该配置，不关闭TLS检查、不改系统证书信任。受控可用新版只用于边界验收，不是实际Release发布。

依据：[Node HTTPS](https://nodejs.org/docs/latest-v24.x/api/https.html)、[Electron shell](https://www.electronjs.org/docs/latest/api/shell)、[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)。具体保证以正式入口、独立请求与实际包证据为准。
