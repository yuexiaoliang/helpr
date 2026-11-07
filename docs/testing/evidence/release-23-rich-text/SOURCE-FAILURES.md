# 失败与检查边界

TARGETED-INITIAL.txt：32项中2项失败。新测试把已reported的动作预期为dispatched，但现有行为是unknown；另一新测试误用不存在的app_meta表，真实版本字段在workspace表。均修正测试，未放宽产品守卫。后续TARGETED.txt的86项通过（22富文本、10空值、54创建目标）；新增工作者实际节点防绕过、备份review拒绝和空段落歧义后TARGETED-FINAL.txt的24项通过。

SOURCE.txt是第一轮完整检查，运行期间又补工作者输入前防绕过、备份review和空段落边界，不能作为最终冻结输入的全部验证。最终产品需重新compile并运行SOURCE-FINAL.txt，分别保留输出，不冒称早期检查覆盖后改代码。

旧首次原生映像就绪延迟、全部启动性能失败、4个许可证正文缺口、CUA不可用与21遗留IAB清理未知均保留。本阶段无真实模型费用、远程业务、正式安装和系统权限操作；不是完整首版交付。

SOURCE.txt最终472通过/1失败：该轮启动后继续编辑，Vitest加载的rich-text模块早于新增empty-dom反例，后读取测试已包含反例，因此得到混合版本结果。原错误保留，不将其计为冻结源码基线；单独TARGETED-FINAL的24项已通过当前版本。后续停止编辑，重新compile并直接运行完整pnpm check（总10分钟），避免无参数入口5分钟总截止不足以覆盖历史404.74秒的完整套件。此轮未发生截止超时，验证子进程已清空。

候选96/249实包在61.320秒超时，启动9239ms超过5000ms，1虚构填入/2规划，0发布。源`<p><br>`的AX值为换行，fill后网站实际收到两个段落、双换行。严守全文比较使动作unknown；但EXECUTION_RICH_TEXT_UNVERIFIED遗漏于ExecutionService.record的业务拒绝清单，触发disable而未保存paused。13PID/3组独立OS清空，租约释放，原result及空stdout/stderr在failed-249。CUA一次10秒超时已completion_summary收束，无窗口/真人新证据。

SERVICE-RED.txt用真实收件值在服务+真实记录层复现running（约2.81秒），SERVICE-GREEN.txt只增加该业务错误分类后转为paused（约2.35秒），动作仍unknown、一次输入。备选假设为事务回滚或不匹配未传入；单行修正和原样服务回放支持首项，不需额外运行或调试日志。实际采样保留tests/workspace/fixtures/rich-text-observation.json，含源AX/DOM、冻结源与收件正文。原生/会话/保存失败仍按原故障处理。

不把段落双换行强行归一成所需文本；修后保留该样本作为独立实包拒绝反例。真正空根正例与网站改写反例在另一轮，以隔离资料避免未明整站占用互相阻塞。新增两轮最多4启动/3填入/6规划，旧249消耗不重置。新的最终定向、静态与构建证据需单列，早期473全套不冒称已覆盖单行修正。

修后静态首轮LINT-CHECKED-INITIAL.txt在新服务回放测试发现4个无await的async stub；改为显式Promise.resolve后重跑类型/静态及定向检查。未改变产品逻辑或既有失败。

97的250–253已通过两轮实际正反例及冷开，第一轮26PID/6组、第二轮24PID/6组清空；证据保留candidate-97/，当时全部输入及整包未变。随后代码复查用实际占位BR样本仅移除AX.value构造明确缺值条件，BR-RED.txt暴露错误空值补充（0.664秒）。收紧空DOM证明：存在BR/P/DIV子节点时，缺AX值一律未知；实际AX换行继续原样保留。BR-GREEN包含富文本及旧原生空值回归。该修正不是把实际观察到的换行转为空，也不接受段落双换行。须重新冻结rich-text-empty-guard-23，再跑相同两轮，旧97成功不冒称包含此修正。
