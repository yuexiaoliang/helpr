# 原失败与未验

2026-11-07。初版检查点校验函数直接引用由自身schema推导的ActionFact／TaskExecution，形成TypeScript循环推导；保留TYPECHECK-INITIAL.txt（首次终端输出截断后，未修改源码再次运行保存完整输出）。改为独立结构输入后TYPECHECK-FIXED.txt通过。

TARGETED-INITIAL.txt：67项中44失败、23通过。41项发布夹具仍以无链接／无下载的普通resolve确认上传；另有素材用例两轮等待超过原10秒上限，以及两个歧义用例旧预期paused。按新契约补真实形状的测试证据，将两轮等待用例时限设20秒，未知保留为unknown；修后67项全通过。初轮测试启动后、进入素材文件之前，曾更新两个夹具文件；其报告仅作为失败原始记录，不用于冻结结论。

UPLOAD-INITIAL.txt和UPLOAD-FIXED.txt：新增12项各11通过、1会话变更失败。复制会话快照仍未解决：session-invalidated会建立新的恢复轮，该轮未经账号／权限重核就确认上传。补充coordination须ready且非refreshRequired，UPLOAD-SESSION-FIXED.txt 12项通过；新等待旧epoch已失效，不能用新恢复轮绕过。

SOURCE-INITIAL.txt在lint阶段停止：测试中1处多余非空断言、4处async没有await。均修正并保留输出；后续完整结果另记，不把这次未执行的测试写成通过。

CUA单次await cua.getState()在10000ms超时，返回js execution timed out; kernel reset, rerun your request，已收束。无窗口／真人新证据，21遗留IAB清理未知保持。旧dist、构建、运行布局、许可证和性能失败全部保留，累计用量不重置。

LINT-FIXED.txt仍有1处多余非空断言（backup返回archive），已删除。SOURCE-FIXED.txt完成382项：367通过、15失败；10个发布约定及4个Excel文章用例共用的旧上传夹具未补链接／下载／binding，1个修复用例仍预期进入修复前上传未知。新机制在修复前已经独立核对上传，故保留confirmed及uploadCheck，同时断言会话变更确已中断、没有保存草稿和采用修复。修前日志全部保留，产品守卫未放宽。最终另重新compile及完整检查。

SOURCE-FINAL.txt完整通过382应用／19验证器／25旧回归和类型、lint、格式检查。最终README仅将候选命令改为修后新名称，并独立格式核对，产品代码和测试未改变。

候选90 upload-ready-23未完成：内部宿主复制时报ENOSPC，磁盘仅剩441MiB。构建父进程退出0但manifest.prepared=false；独立预检artifact-90拒绝RELEASE_PROVENANCE_REQUIRED，未启动应用，不能凭命令退出0宣称构建成功。保留部分候选、BUILD-90.json、原始输出及预检。只清理可重新下载的npm包缓存（原约3.1GB），保留所有候选和验证资料；CACHE-CLEAN.txt确认可用空间3.5GiB。基于已恢复空间，用新名称upload-ready-space-23重建候选91，仍限10分钟；独立预检2分钟，原实包轮次和消费上限不变。缓存清理与实包自有进程清理分别记录。

候选91构建及独立产物核对通过；预检退出2仍有原4个许可证正文缺口。236／237实包首次运行及独立核验通过，但236启动5014ms超过5000ms，新增性能失败；237的1446ms不覆盖该失败或历史失败。无原生切换／RSS／完整5分钟，不能宣称性能通过。详细结果见REPORT.md。
