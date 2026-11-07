# 失败与验证边界

TYPECHECK.txt：新快照测试将两个空attributes数组推断为never[][]，无法添加sandbox反例。修正测试为number[][]；未放宽产品守卫。TARGETED.txt初版69项通过，后续增补子文档焦点和回执测试及父文档祖先保护，完整检查另列。

旧全部启动性能失败、首次原生新映像就绪延迟、4根许可证正文缺口、真人/输入法/真正休眠及21旧IAB清理未知保持。真实业务已授权批次消费0。脚本模拟焦点和frame替换不抵算本人接管。

SOURCE-FINAL.txt完整521/26/25与静态通过后，只更新模型提示和README；随后64项定向及格式通过。COMPILE.txt早于最终祖先保护与提示更新，最终签名构建会重新编译所有输入，不能将早期编译称作最终包。

101/267：原命令 `pnpm validate:workspace --fixture --candidate=rich-text-frame-23 --rich-text-lines=frame-success` 在APPLICATION_NOT_READY失败，16.925秒收束。记录ready约13.27秒、host约15.06秒、controller约15.09秒，尚无任务/模型/输入。原输出、诊断及11PID/3组OS清空见failed-267；资料run-IE22xS保留。CUA getState同轮10秒超时并收束，无窗口新证据。

假设按优先级：新映像首次初始化（同包复跑应缩短）；持续启动阻塞（新资料复跑仍慢）；CUA同时调用干扰（无CUA复跑缩短但不能与首次初始化单独区分）。原失败发生在正文能力前，不以它否定/确认frame输入。沿既有同映像首次延迟证据，仅一次同包/不变15秒截止的新资料复跑，不并发CUA。此观察不能确定底层根因或宣称性能修复；不扩成压力重试。

独立VERIFY.py首次核对replace时错误沿用旧样本约定“只有E是空DOM来源”，R实际也是完整空DIV，导致第24行AssertionError。按已保存valueSource区分AX值与empty-dom，仍要求缺AX值+空串，不改产品、夹具或包；原实包成功结果保持。修后重查同一原始资料，不重新运行应用。

VERIFY.py第二次仍沿用主文档反例的“无navigation”断言；真实R首段后同URL替换iframe触发既有宿主撤权，保存mainFrame=false/during-action、generation恰好+1及page-change暂停。核验改为强制检查这些实际归属与状态，仍要求1输入、unknown、无richTextResult、新AX frameId和冷开不重发。该修正只在独立核验脚本，不修改产品或原实包证据。

VERIFY.py首次focus核验将DOMSnapshot的显式空值索引-1误当Python负索引，导致第41行失败；实际唯一外层INPUT的inputValue={index:[9],value:[-1]}。修正独立核验先确认唯一INPUT及对应唯一条目，再接受Chromium明确空值-1或真实空字符串；缺条目仍拒绝。只重查已保存资料，没有重跑应用或修改候选。
