# 固定本机开发签名

2026-10-17，用户明确同意“先使用这个方案来做，后续如果还需要反复授权的话，我们再分析”：采用免费、本机自签名证书与私钥，长期复用并固定身份，缺失或变化时报错，不自动回退 ad-hoc。此项是构建和交付工具调整，沿用现有应用生命周期／版本检查入口；不改变已确认产品交互，不另开功能原型。正式 Developer ID 与公证仍安排在首次对外使用前；既有免费 Apple Development／Personal Team 和自动更新实验保持搁置。

## 使用与保护

首次显式运行 `node scripts/development-signing.mjs init`，在当前用户的 `~/Library/Application Support/helpr-development-signing/` 创建独立钥匙串及随机解锁口令文件。目录为 0700，文件为 0600；只授予 `/usr/bin/codesign` 使用这把新私钥，导入后不可导出，临时加密私钥和 PKCS#12 导入文件在成功导入后删除。随机口令用于本项目新钥匙串，与用户登录密码无关；为自动签名由本机受限文件保存。证书私钥和口令不进入 Git、日志、argv 或构建清单。不要删除这个目录；更换电脑或丢失私钥时须显式重新规划身份，构建不会自行补建证书。

仓库的 `development-signing.json` 只保存选定证书的公开指纹、用途及有效期。`init` 在已有策略时只检查，不重新生成；部分失败材料保留并拒绝覆盖。构建前检查公开证书、私有路径权限、有效期和私钥身份；不匹配时在消耗构建次数前失败。`node scripts/build-mac.mjs --check-signing` 只检查，不构建或解锁私钥。

`build:mac` 在复制全部内部宿主及设置 fuses 后，用 `@electron/osx-sign` 1.3.3 从内到外统一签名，关闭 builder 的自动身份选择。独立钥匙串仅在签名期间解锁并临时加入用户搜索列表，完成或正常错误退出后恢复列表并锁回；同一签名目录的排他锁防止本工具同时签名。签名父调用限定两分钟，失败保留候选；不把签名失败转换为 ad-hoc 或明文。此路线不修改系统证书信任、默认钥匙串、Cookie 加密或产品系统凭据保护，也不扩大旧受保护项目的 ACL。

包核对覆盖主程序、独立网页宿主、helper、framework 和其余 Mach-O：要求实际签名满足选定证书约束，指定要求含该证书且不以 `cdhash` 识别版本；主／宿主各自保持既有标识。每个构建清单保存逐组件指定要求，以便跨构建对照。相同证书和规则不代表 macOS 钥匙串以后绝不提示，旧实验的反例继续有效。

## 本轮范围与实际记录

本轮仅准备当前开发身份并离线核对，不安装／启动 Electron、不读取真实模型凭据或网站登录，不执行自动更新。两次真实产品候选构建上限为 26、27（原用量 25 保留），不增加 starts／installs／faults／cleanups，也没有模型或业务写入。两个候选的归档必须不同，实际组件身份规则应一致；任何产品包签名失败保存后停止本批，不追加构建。旧 04 的所有失败和剩余验收保持。

先从既定公开包核对入口取得红例：候选 25 的 ad-hoc 包原本返回成功；修正后应明确返回 `DEVELOPMENT_SIGNATURE_REQUIRED`。再核对新包、缺失策略及错误身份的拒绝，最后运行完整源码检查。不会把静态身份核对计作真人授权或跨升级登录通过。

材料准备中的失败均保留：第一次 PKCS#12 导出把同一个口令文件同时作输入和输出，第二次读取到 EOF，在导入前失败；初始未导入材料移到同级 `helpr-development-signing-failed-20261017/`。只追加一次生成，现已导入的证书保持不换。随后本地校验误用 `checkIssued` 判断非 CA 自签名叶证书，修正为自身签名／签发者／有效期核对；未因此重建身份。

离线最小包的初次签名和一次带诊断调用均因独立钥匙串不在搜索列表而失败；单变量加入搜索列表后同一私钥签名成功。随后检查器的 `codesign -R` 参数少了表达式前缀 `=`，已修正并取得首版真实签名验证。第二版最小包把变动资源误放 `Contents/` 根目录，被 codesign 拒绝，不能计作两版通过；不再重复这份错误夹具，改由本批两份标准实际包核对。原诊断仅签名，不运行可执行文件，材料位于忽略目录 `.local/development-signing-validation/`。

## 依据

Apple 明确允许用自签名证书作内部开发，并说明跨版本保留 identifier／designated requirement 的身份语义；签名证书由本机生成，无需购买会员：[Code Signing Tasks](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)。Electron 提醒 macOS 的 safeStorage 需一致有效签名：[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。这些资料不替代本机实际钥匙串与登录延续验收。
