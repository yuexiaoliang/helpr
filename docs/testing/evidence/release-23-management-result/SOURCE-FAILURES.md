# 原失败与未验

2026-11-07。6项新增用例连同既有用例，共41项发布定向检查及类型检查首次通过。完整检查与实包结果另见REPORT.md，不用局部检查代替整体验收。

CUA单次`await cua.getState()`在10000ms超时，返回`js execution timed out; kernel reset, rerun your request`，已收束。没有窗口、原生输入或真人新证据；21遗留IAB清理仍未知。脚本与SQLite检查不抵算这些条目。

旧构建、运行布局、类型／lint、格式断言、旧dist、许可证和性能失败继续保留，累计计数不重置。

完整369应用／18验证器／25旧回归和静态检查、候选89构建、实包234／235及独立核对均首次通过。独立交付预检退出2：artifactVerified=true，但既有4个依赖根许可证正文缺失，releaseAccepted=false；不能将本机运行成功写成完整交付通过。

234／235启动4540／1065ms不覆盖旧启动失败；缺原生切换、RSS和完整5分钟，性能仍未通过。原始COMPILE／BUILD中的gyp尾空格保留，不为diff检查清洗日志。
