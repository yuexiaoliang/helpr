# 原失败与未验

首轮37项定向通过，加入独立表单事件反例后38项通过。补充会话测试的TARGETED-SESSION.txt为40项38通过、2失败：新增variant已经列入，但测试调用没有传changedSession，也没有在beforeRecord注入session-invalidated，实际执行的仍是正例。失败原输出保留，修正测试接线后重新运行；不据该输出宣称产品已测试会话变化。

首次compile成功。SOURCE-INITIAL.txt在取得会话测试结果后误启动，未作为冻结结论；等待该次检查结束后再修改测试和运行完整检查，结果另记。该次在lint发现1处多余非空断言后退出，未运行完整测试；删除断言后重新compile。TARGETED-SESSION-FIXED.txt的40项全部通过，原注入缺失失败仍保留。

本轮CUA仅调用一次await cua.getState()，10000ms后返回“js execution timed out; kernel reset, rerun your request”，已收束。无窗口或真人新证据，21遗留IAB清理未知仍保持。旧性能、许可证、构建与运行失败全部保留，不重置累计。

SOURCE-FINAL.txt完整应用395项中393通过、2项原生启动失败：NATIVE_EXIT_RECEIPT_TIMEOUT（3000ms）和DISTINCT_HOST_NOT_STARTED。验证器／旧回归因前段失败没有执行。原生源码、本阶段启动逻辑与该测试未修改。STARTUP-ISOLATED.txt同一映像单独7项通过，耗时2.04秒；不能据此抹去原失败。

按diagnosing-bugs缩小对照，NATIVE-PROBE.mjs／JSON在3秒门槛内比较已有映像、新生成映像首次和第二次运行：110ms／3003ms超时（无回执）／143ms。新映像首次执行延迟得到局部复现；尚未定位操作系统执行检查或其它底层原因，也未证明DISTINCT_HOST_NOT_STARTED同源。探针未修改产品源码、未启动Electron，自有组清空，临时目录清理。保留原超时门槛，以“不重建、复用相同映像”的可验证假设运行完整SOURCE-FROZEN.txt；即使随后通过，也不把首次运行失败写成已修复。

SOURCE-FROZEN.txt最终395应用／20验证器／25旧回归与静态全通过。候选92构建、独立预检及238／239实包功能核对通过，但预检仍退出2（原四根许可证正文缺口）、238启动5023ms新增性能失败；239为1520ms。首次执行延迟、旧启动超标、原生／真人缺口全部保留；未因本轮功能通过关闭23整体验收。

提交前复查发现表单检查点反例使用带text／controls等额外字段的PageObservation作为严格pageSource，可能在进入目标守卫前就因对象形状被拒绝。修为已经合法保存的source，先断言合法检查点可解析，再逐项改变epoch／原因／代次／指纹／请求地址及缺目标。只修改tests/workspace/created-target.test.ts，保留候选92与原395全检；最终40定向和静态另跑，详见TARGETED-STRICT-BASELINE.txt与STATIC-AFTER-TEST.txt。构建后唯一测试差异及摘要见FINAL-INPUTS.json；产品和验证器脚本、整包未改，不把后改测试冒称构建时输入。
