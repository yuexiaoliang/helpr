# 原失败与修正

所有日志保留，最终通过不删除修前失败。

1. 类型检查发现修复提议的字段类型未贯通、补充后缺少Publication类型导入；后一错误保存在TYPECHECK.txt，早前缺fields错误仅有当时工具输出。已贯通类型。
2. LINT.txt记录未使用解构值及多余断言；改为显式提取字段ID、名字、frameUrl，删除多余断言。
3. TARGETED-INITIAL.txt：45项中3项失败。改稿将含revision／approvalId／origin的内部对象交给strict publication schema，造成合法改稿拒绝。只在内部校验处strip这些内部键，外部命令schema保持严格。
4. TARGETED-REPAIRED.txt：37项中2项失败。格式21被第二处迁移白名单遗漏，已补齐；界面测试将保存回复草稿IPC误当作确认，改为仅计数participation-decision，仍验证组字时不提交、结束后只一次。
5. TARGETED-FINAL.txt：新6项通过；FIXTURE-CHECK.txt：2项夹具检查通过，包括生成页面脚本语法和独立字段模型提议。SOURCE-CHECK.txt为最后完整回归。

没有为通过测试放宽原文／字段一致性、确认版本、原生控制或提交守卫。候选80只运行一轮，成功后未复跑。
