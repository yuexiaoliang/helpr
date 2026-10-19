# 05 实现与验收记录

2026-10-19，最后 C 的正常退出/冷恢复实包补验已通过；九条验收已逐项关闭，最终 Standards/Spec 复核各 0 项待修问题。详见 [逐条验收依据](FINAL-ACCEPTANCE.md)。

产品实现基线 `968fc72`，原型 `recovery-v1`（`5a75723`）已获用户确认。最终产品修正 `80b75c2` 保留退出前活动意图，恢复仍先核对现场与实际结果；停止、接管与未知不自行解除。

| 案例 | 实际结果 |
| --- | --- |
| A 效果已发生，本机未记完成，冻结记录后强退拥有者 | 自有进程树清空；冷重开只核对补记，网页总写入仍 1 |
| B 原停止与同资料竞争启动 | B 保持 stopped/效果 0；竞争启动无新拥有者并正常退出 |
| 退出检查点期间记录进程死亡 | 退出被拒、保留应用；新记录进程重连后可正常退出 |
| C 未派发时正常退出与冷重开 | 76/77 无开始/继续自动恢复；恰好写入 1，完成后正常退出，两个进程树均清空 |

A/B 与记录失联/竞争依据 [72–75 结果](PACKAGED-PARTIAL-RESULT.json)及[快照](PACKAGED-PARTIAL-SNAPSHOTS.json)。该轮旧 C 失败保留；修正后的 C 采用用户批准的新虚构任务，依据 [76/77 结果](PACKAGED-C-RESULT.json)及[快照](PACKAGED-C-SNAPSHOTS.json)，不伪称新轮验证旧 A/B 跨轮保留。

候选 31 的 [包清单](BUILD.json)与候选 32 的[副本签名续办](BUILD32-SIGNING-FOLLOWUP.json)分别保存。候选 32 归档 `35445bb6e438f95ecd3d51f15bea562f010115e23c915cb7668022212b3fe9eb`，固定证书及 54 个组件、宿主布局、同归档/fuses、deep/strict 通过。初始 32 签名失败仍保持 prepared:false；续办没有重新编译/封装或覆盖失败原件。

[源码最终检查](FINAL-SOURCE-CHECK.json)：`pnpm check` 类型、lint、格式、69 项正式测试、25 项旧回归和事实检查全部通过。原始输出在忽略的 `.local/workspace-validation/recovery-05-final-source-check.log`。实际包与源码检查分别取证。

全部失败保留：[70 取证断言](STARTUP-EVIDENCE-FAILURE.json)、[71 契约错误](CONFIGURATION-CONTRACT-FAILURE.json)、原 75 的 C 暂停、[32 签名超时](BUILD32-SIGNING-FAILURE.json)、[隔离临时目录缺失](PROFILE-LOSS-PREPARATION-FAILURE.json)。目录缺失原因未确定，发生在启动前，不能认定为产品正式资料丢失。方案、确认和修正见 [检查计划](../../recovery-05-plan.md)及 [审阅记录](REVIEW.md)。

05 用量：3 构建尝试、另 1 签名准备、8 启动、3 故障、1 必要清理，0 安装；累计 7/10 本机模型、2/2 效果、4/4 虚构任务。全局 32 构建/8 安装/77 启动/37 故障/16 清理，清理 17 预留未用。真实模型及远程业务均 0，正式安装未替换。

范围仍为 01–04 的窄网页操作。06 真人输入法/⌘V/锁屏/真实休眠、09 原密钥与有效登录、12–14 素材/上传/发布恢复继续各自验收。受控模型不证明真实业务判断，强杀不代表物理断电。
