# 20 源码与工具失败记录

- 首次专项13项中1项失败：恰好在轮次时刻接受计划，cursor=acceptedAt-1 使本轮被领取，与“接受之后”不符。修正为 acceptedAt，再验通过。
- 备份格式断言仍固定18，新增格式19后失败；同步期望19，旧格式18仍在恢复兼容范围。
- UI测试把 WorkspaceStore 初始化的 snapshot 只读请求误算为中文组字提交；改为检查没有 schedule-prepare 写入。没有放宽产品检查。
- 初稿类型及lint发现 token返回类型、sleeping固定值、render中Date.now和测试类型标注问题，已修正。一次命令脚本字符解码失败未执行修改。格式检查的失败也保留在本地日志历史；最终结果以报告为准。
- CUA `await cua.getState()` 限时10000ms，返回 `js execution timed out; kernel reset, rerun your request`。没有原生截图或点击证据；不重复连接，无浏览器／应用启动消耗。

候选74／启动201：三轮均保存，新字节已创建独立任务，但验证器期待第二次网页创建并超时 `VALIDATION_TIMEOUT`。独立 SQLite 显示旧任务创建动作 `unknown/possible`，新任务 `queued` 且 `coordination.waitFor` 指向旧任务；网站仅1次创建、0上传发布。原站点占用守卫正确生效，不能通过定时解除。记录进程正常退出，17个PID／3组独立OS检查清空。`RUNTIME-201.json` 保留原失败。

后续仅修正限定验证器，观察并断言上述已取得的等待依据，继续取消及冷开；不修改产品、不新增构建，不将这次等待通过解释为第二次网页创建或完整无人值守发布通过。
