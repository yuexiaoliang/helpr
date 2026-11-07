# 原失败与未验

2026-11-07。

- TYPE-INITIAL.txt：新增动作schema校验函数使用反向ActionFact类型，导致循环推导及连带类型错误。改用独立字段类型，TYPE-FINAL.txt通过。
- TYPE-WITH-TESTS.txt：新测试spy未声明参数，读取mock参数时类型错误。为spy补明确接口。
- SOURCE-INITIAL.txt：新测试含无await的async回调及未使用参数，lint拒绝。改为显式Promise和函数接口；未启动应用。
- SOURCE-SYNTAX.txt：修整测试Promise回调时多一个右括号，类型检查拒绝；修正括号。原记录保留，不记为通过。

实包、CUA、性能与整体交付状态在REPORT.md另记；旧失败、累计及21遗留IAB清理未知不得重置。

- SOURCE-STALE-DIST.txt：363项完整回归362通过，记录进程清理回执丢失用例报RECORDS_EXITED。该用例用新源码写格式26资料，再启动旧dist/main/records.cjs；旧编译产物来自格式25阶段。先用pnpm compile重新编译，不改产品或测试判定，再跑完整检查。COMPILE.txt保留原生及打包器输出。
- CUA单次 `await cua.getState()` 10秒超时（js execution timed out; kernel reset）。未取得窗口或真人输入新证据；21遗留IAB清理仍未知。

- 候选88启动228在57.295秒收束：A动态目标只读通过，B共享同站且没有独立账号／权限证据，按既有整个网站占用规则排队，50秒等不到POST而VALIDATION_TIMEOUT。SQLite明确B actions=[]、waitFor=A，不能记为B身份反例已跑。保留failed-228原result、两份执行记录、profile和stdout/stderr；独立OS确认15PID／3组清空、租约释放。
- 修正验证布局：正反例采用两个独立本机origin，仍在同一个受管应用内；每个夹具最多接受1次创建，总最多2次。没有放宽资源守卫、不代答继续。仅created-target-validation.mjs、created-target-fixture.mjs和对应测试改变，候选88产品及包未变，按README复用；原构建来源不改写。修后再次检查验证器，再执行一个有界轮次（最多2启动、2创建、8虚构规划，总2分钟）。失败228的1次创建、2次虚构规划和全部启动累计保留。

- 第二轮启动229在18.205秒收束：A再次通过，B的第二origin被LocalFixture.allowsRequest固定单origin限制拒绝，15秒未加载；没有B规划或POST。保留failed-229原result、执行记录、profile与日志；独立OS确认15PID／3组清空、租约释放。此轮1创建／1虚构规划，不把访问被拒当身份反例。
- 修正为两个串行独立资料轮次，各只跑A或B及其冷开；不修改LocalFixture、不扩大允许站点、不放松占用规则，不称为同站或产品并行通过。每轮最多2启动／1创建／4虚构规划、2分钟。`--created-target-mismatch`选择B。追加validate-workspace.mjs成为构建后第4份验证器差异，产品包仍未改变。仅在这项明确布局修正后复跑，所有旧用量继续累计。

- 最终辅助独立核验脚本误在逐文件filter里重复调用captureReleaseInputs（只读Git／摘要／工具链），发现后主动终止本轮自有node PID37712（ps已运行14秒，退出143）；没有启动应用、修改包或资料。改为一次捕获后复用缓存，INDEPENDENT.json已完成完整包未变、4份验证器差异及两轮SQLite／OS核对。此辅助脚本中断不写成首次通过。
- 最终A／B均独立通过，详见REPORT.md。旧CUA、许可证、性能和真实业务待验保持。
- Git暂存检查对原始BUILD-88.txt／COMPILE.txt的`gyp info ok `尾空格及TARGETED-INITIAL.txt末尾空行给出提示；为保留原始命令输出未清洗。产品、验证器、测试和说明文档的差异检查通过。
