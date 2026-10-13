# 自动更新后无需再次系统授权的凭据延续

调查日期：2026-10-13（Asia/Shanghai）。范围是本人当前 Apple Silicon / macOS 14.8.3 的 Mac，Electron 44.7.0；保留模型凭据加密和 cookie 加密，在自动更新后继续读取原模型密文、使用仍有效的网站登录并按原意图核对恢复。本报告回答技术条件与待验证候选，不表示完整交付已经通过。

本研究执行了公开一手资料阅读和本机普通元数据读取，没有启动应用、访问密码内容、修改 Keychain ACL / 信任设置、申请证书或购买会员。文中的本机实验结果来自主代理已完成的检查，本研究只读复核其结果文件。用户已说明没有 Apple Developer Program 会员或 Apple 签名证书。

研究以 main 的 c401e09 为基线，独立分支为 `codex/research-unattended-update-credentials`。地图原约定为 `research/*`；本次按明确委托采用当前 `codex/` 前缀。只提交本文件，不带入主目录的未提交事项、地图、产品文件或实验产物，也不修改 `participation-state-prototype`。

## 结论与证据等级

1. **当前自签名方案不满足无需再次授权的要求。** 本机同证书、同 identifier、相同 designated requirement（DR）的原生两版最小对照，旧版创建并读取虚构项成功，新版在同一路径、禁止系统交互时读取返回 `-25293`。这直接否定了“保持证书和 DR 相同就足够”的假设；它不等于 Electron 正式更新方案已经验证。观察来源见下文“本机证据”。
2. **最受支持的原因是额外的 Keychain partition 检查。** Apple 公开源码先检查普通 ACL，随后另外检查 partition；不能识别为指定 Apple 证书类别的已签名代码使用 `cdhash:`，受支持的开发签名和 Developer ID 则使用 `teamid:`。本机实验项恰有六个 `cdhash:`、没有 `teamid:`。这是“版本源码事实 + 本机证据支持的因果解释”；尚无失败瞬间的 securityd 分支日志，不能声称已直接跟踪此机每一次提示。[Apple ACL 实现](https://github.com/apple-oss-distributions/Security/blob/b4bd4fda62af1ebf469ee97f0112fb49363fb482/securityd/src/acls.cpp#L111-L203)、[Apple 客户端分区实现](https://github.com/apple-oss-distributions/Security/blob/b4bd4fda62af1ebf469ee97f0112fb49363fb482/securityd/src/clientid.cpp#L170-L270)
3. **仍有合理的零付费候选，不能直接要求买会员。** Xcode Personal Team 支持免费开发证书；Apple 的分区实现也接纳特定 Mac Development 证书链。当前 Electron 的 file-based Keychain 路径不要求改用受限的 keychain access group；不使用受限 entitlement 的 Mac app 无需 provisioning profile。因此“免费账户所有 Mac app 都每七天失效”并非这些官方材料的结论。免费证书取得、实际分区、续证和真实更新后的静默访问，均尚未验证。[Apple 账户与 Personal Team](https://developer.apple.com/help/account/basics/about-your-developer-account)、[macOS provisioning 规则](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles#Entitlements-on-macOS)、[分区源码](https://github.com/apple-oss-distributions/Security/blob/b4bd4fda62af1ebf469ee97f0112fb49363fb482/securityd/src/clientid.cpp#L190-L270)
4. **Developer ID 是另一候选，提供正式分发条件，不是“买了就通过”的保证。** 两版的 Team、DR、Keychain 名称、持久数据路径和实际更新链仍须共同验证。签名/公证、Squirrel 更新包校验、Keychain 授权和服务器端登录有效性是不同的检查。[Electron 签名说明](https://github.com/electron/electron/blob/v44.7.0/docs/tutorial/code-signing.md#macos-apis-that-require-code-signing)、[Apple Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)、[Squirrel 签名校验](https://github.com/Squirrel/Squirrel.Mac/blob/fffea30e4a339a7f7d69a3391314b72548d209bd/Squirrel/SQRLCodeSignature.m#L78-L145)

以下明确区分：**官方说明**是文档承诺或规则；**版本源码事实**只对标出的实现版本成立；**本机观察**来自指定结果文件；**推断/候选**需要实验取得证据。公开实现细节用于诊断，不应写死成产品依赖；Apple 同样要求通过代码签名工具/API 验证身份。[TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)

## 本机证据与版本边界

| 证据 | 实际观察 | 可以与不可以得出的结论 |
| --- | --- | --- |
| 既有 Electron 实验 | 两版实验自签名与 DR 一致；更新后仍请求访问 `helpr Lifecycle Lab Safe Storage`；用户允许后原虚构值可读。 | 加密数据未必丢失，授权延续失败；不能把用户点击后的读取成功计为无人参与通过。该事实由本次委托提供。 |
| 既有项只读 ACL 检查 | `passwordDataRequested=false`、`mutations=[]`；decrypt/export ACL 内同一 requirement 接受已安装新版和保留旧版，均 `status=0`；另有 `ACLAuthorizationPartitionID`，内含六个 `cdhash:`，没有 `teamid:`。两个签名的 TeamIdentifier 均 `not set`，其不同 CDHash 都已在列表中。 | 普通 DR 匹配与 partition 是两项证据。当前两个构建都已获准，不能用它们再次读取来证明第三个构建会自动获准。来源：[existing-keychain-access.json](/Users/yuexiaoliang/projects/helpr/.scratch/helpr-first-release/experiments/unattended-update-credentials/artifacts/existing-keychain-access.json)。 |
| 原生最小对照 | 同证书、相同 identifier/DR，仅编译常量不同；CDHash 分别为 `2c449c…` / `9256d6…`。旧版创建并读取新虚构项 `status=0, matches=true`；同一安装路径替换新版后，禁止交互读取 `status=-25293, matches=false`；旧版清理成功，随后确认项不存在。2 次编译、2 次签名、4 次探测，共 2.351 秒；无 Electron 启动、模型调用或信任修改。 | 已取得“稳定 DR 仍不足”的真实反例。对照没有记录该新项完整 partition 元数据，故不把 `-25293` 单独解释为唯一特定内部错误分支。来源：[native-differential.json](/Users/yuexiaoliang/projects/helpr/.scratch/helpr-first-release/experiments/unattended-update-credentials/artifacts/native-differential.json)。 |
| Apple Security 版本 | 本研究只读 `Security.framework/Versions/A/Resources/Info.plist`，CFBundleVersion 为 `61123.141.1.705.1`；公开核查固定于 `Security-61123.140.15` / `b4bd4fda…`，并交叉核查 `61901.0.87.0.1` / `db15acbe…`。 | 两个公开版本都有下述分类与额外检查，但不能声称公开 tag 与当前系统二进制逐字对应。[61123 源码](https://github.com/apple-oss-distributions/Security/tree/b4bd4fda62af1ebf469ee97f0112fb49363fb482)、[61901 源码](https://github.com/apple-oss-distributions/Security/tree/db15acbe6a7f257a859ad9a3bb86097bfe0679d9)。 |
| Electron 依赖 | `v44.7.0` 对应提交 `61f55c4ce540416b3e43f75f6c0f125d22e5e908`，DEPS 指定 Chromium `152.0.7977.130` 与 Squirrel.Mac `fffea30e4a339a7f7d69a3391314b72548d209bd`。 | 后面的 Electron/Chromium/Squirrel 源码结论按此版本对齐，不由当前网站的 latest 文档推定实验版本。[Electron DEPS](https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/DEPS#L1-L17)。 |

上述本机结果保存在主工作目录，未夹带到此研究分支。默认搜索范围内可用 Apple 代码签名身份数量为零只是本地准备情况；用户随后明确“没有会员/证书”，两者不应互相替代为推论。

## 为什么 DR 通过，Keychain 仍可再次要求授权

**官方说明：**file-based Keychain 的 ACL 按操作和 trusted applications 进行授权；请求应用不在可信列表时可以要求用户确认。trusted application 数据携带身份信息，显示出的路径文本不是完整授权判断。DR 的作用是跨版本识别代码；自签名身份与 ad-hoc 签名也不能混为一谈，后者的默认 DR 绑定具体代码版本。[ACL 文档](https://developer.apple.com/documentation/security/access-control-lists)、[SecTrustedApplicationCopyData](https://developer.apple.com/documentation/security/sectrustedapplicationcopydata(_:_:))、[TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)

**版本源码事实：**`SecurityServerAcl::validate` 先执行 `ObjectAcl::validate`，再执行 `validatePartition`。后者在条目存在分区列表时，检查调用进程分区是否是列表成员；不匹配时，只有允许 UI 且属于相应操作才尝试 `extendPartition`，否则拒绝。用户批准的扩展路径可以把当前进程分区加入列表。旧数据库、特权 Apple 迁移器等有明确例外，不能用于普通 helpr 应用。[检查与扩展源码](https://github.com/apple-oss-distributions/Security/blob/b4bd4fda62af1ebf469ee97f0112fb49363fb482/securityd/src/acls.cpp#L111-L245)

**版本源码事实：**`partitionIdForProcess` 的分类关键是证书链和 Apple 特定扩展，并非只看证书名称、Bundle ID 或是否有人点过“信任”。[分类源码](https://github.com/apple-oss-distributions/Security/blob/b4bd4fda62af1ebf469ee97f0112fb49363fb482/securityd/src/clientid.cpp#L170-L270)

| 分类条件（省略不相关分支） | 使用的 partition |
| --- | --- |
| Apple 自己签署的代码 | `apple:`，其中 security 工具单列为 `apple-tool:`。 |
| 受支持的 Mac App Store / TestFlight 代码 | Apple 验证的嵌入 Team ID，形成 `teamid:`。 |
| `anchor apple generic`，并符合 Developer ID CA / leaf 扩展，或 WWDR CA + Mac Development / Mac Distribution leaf 扩展 | 从 leaf 证书 OU 读取 Team ID，形成 `teamid:`。Mac Development 分支检查 CA OID `1.2.840.113635.100.6.2.1` 与 leaf OID `1.2.840.113635.100.6.1.12`。 |
| 已签名，但不能归入上述类别 | 使用代码唯一哈希，形成 `cdhash:`。 |

**推断：**实验自签名不具备 Apple 证书链，所以保持 leaf、identifier 与 DR 一致仍可能随构建进入新的 `cdhash:` 分区。六个已存在的哈希与多次授权后的现象一致；新原生对照进一步排除了“必须由 Electron 或 Squirrel 才会发生”这一假设。修改自签名的信任设置、增加 OU 字段或自定义更宽 DR，不会由这些源码条件自然变成 Apple 的 Team 分区；本报告不建议修改这些设置。

**历史材料边界：**TN2206 说过 Keychain 等可用稳定 DR 识别自签名代码。这解释了本机普通 ACL 为何能接受两版，不应升级为“现代 Keychain 只检查 DR”的保证。Apple DTS 已把 TN2206 定位为大部分被新资料替代的历史参考。[TN2206](https://developer.apple.com/library/archive/technotes/tn2206/)、[Apple Code Signing Resources](https://developer.apple.com/forums/thread/707080)

## Electron 44.7.0 的模型密文与 cookie 路径

**官方说明：**safeStorage 在 macOS 使用 Keychain 保护应用的加密密钥，调用可能为系统授权而阻塞；Electron 要求有效且一致的签名，并建议异步 API。此建议没有承诺仅切换 async 即可消除更新后的授权提示。[版本文档](https://github.com/electron/electron/blob/v44.7.0/docs/api/safe-storage.md)

**版本源码事实：**主进程把 Keychain service 设为 `app_name + " Safe Storage"`、account 设为 `app_name`。同步 safeStorage 调用 OSCrypt；Chromium 152 已移除 sync 后端，Electron 的 `revert_oscrypt_remove_sync_backend.patch` 把它恢复。该后端与异步 KeychainKeyProvider 都读取 `KeychainPassword`，不能只搜索原版 Chromium 的 sync 目录来判断 Electron 行为。[名称设置](https://github.com/electron/electron/blob/v44.7.0/shell/browser/electron_browser_main_parts.cc#L691-L694)、[safeStorage 调用](https://github.com/electron/electron/blob/v44.7.0/shell/browser/api/electron_api_safe_storage.cc#L147-L278)、[恢复同步后端的补丁](https://github.com/electron/electron/blob/v44.7.0/patches/chromium/revert_oscrypt_remove_sync_backend.patch#L4854-L5121)、[异步 Keychain provider](https://github.com/chromium/chromium/blob/152.0.7977.130/components/os_crypt/async/browser/keychain_key_provider.mm)

**版本源码事实：**`KeychainPassword` 查已有项；只有 `errSecItemNotFound` 才生成随机密码并新增，其它错误返回失败。`KeychainV2` 虽然调用 `SecItemCopyMatching` / `SecItemAdd`，其 macOS generic-password 查询未设置 `kSecUseDataProtectionKeychain` 或同步属性。结合 Apple 对默认目标的说明，这是 file-based Keychain 路径，不能因 API 名字改成 SecItem 就当作 data-protection Keychain。[KeychainPassword](https://github.com/chromium/chromium/blob/152.0.7977.130/components/os_crypt/common/keychain_password_mac.mm)、[KeychainV2](https://github.com/chromium/chromium/blob/152.0.7977.130/crypto/apple/keychain_v2.mm#L106-L227)、[TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)

**版本源码事实：**cookieEncryption 默认关闭；启用后持久 cookie 存储通过 `CookieEncryptionProviderImpl` 接入 OSCryptAsync，macOS 的 KeychainKeyProvider 功能默认开启。Electron 文档也明确 cookieEncryption 与 safeStorage 使用相同系统 Keychain 访问条件。因此模型密文与 cookie 都要验证，不是一次模型解密成功就代表登录延续已完成。启用 cookieEncryption 后再关闭，会损坏已有 cookie 存储。[fuse 文档](https://github.com/electron/electron/blob/v44.7.0/docs/tutorial/fuses.md#cookieencryption)、[网络上下文](https://github.com/electron/electron/blob/v44.7.0/shell/browser/net/network_context_service.cc#L82-L128)、[provider 注册](https://github.com/electron/electron/blob/v44.7.0/shell/browser/browser_process_impl.cc#L522-L531)、[Chromium 默认功能](https://github.com/chromium/chromium/blob/152.0.7977.130/chrome/common/chrome_features.cc#L68-L72)

**推断与验收要求：**先固定实际 app name、service/account、Bundle/signing identifier、Team 与 DR，再固定 `userData` / `sessionData` 和持久 session partition。Electron 默认 userData 含应用名，sessionData 默认指向 userData；`persist:` 才是命名持久 session。更名或误换路径可能创建另一套密钥/数据，看起来像凭据丢失。[app 路径](https://github.com/electron/electron/blob/v44.7.0/docs/api/app.md#appgetpathname)、[session 持久性](https://github.com/electron/electron/blob/v44.7.0/docs/api/session.md#sessionfrompartitionpartition-options)

**仍须单独验证登录语义：**该版本默认 `restore_old_session_cookies=false`、`persist_session_cookies=false`；会话 cookie 并不自动获得跨进程保留。验收应同时记录“有持久到期时间的测试 cookie 跨更新可用”和“真实验证网站服务器仍认可会话”。如果目标网站依赖 session-only cookie 或其它浏览器状态，需另证恢复机制；不能在通过 Keychain 检查后把所有未手工退出的网站登录都宣称保留。[网络上下文默认值](https://github.com/electron/electron/blob/v44.7.0/shell/browser/net/network_context_service.cc#L102-L116)

## 免费候选与正式 Developer ID 的条件

| 候选 | 一手依据与可行性判断 | 当前缺口 |
| --- | --- | --- |
| Xcode Personal Team 的 Apple Development，继续使用 file-based Keychain | **合理零付费候选。** Apple 允许免费 Personal Team 在 Xcode 管理开发证书；Apple Development 的用途覆盖 macOS 开发，Mac Development 这一证书种类也用于 Mac 开发测试。分区源码具有开发证书的 `teamid:` 路径。[账户说明](https://developer.apple.com/help/account/basics/about-your-developer-account)、[证书种类](https://developer.apple.com/help/account/certificates/certificates-overview/)、[分区实现](https://github.com/apple-oss-distributions/Security/blob/b4bd4fda62af1ebf469ee97f0112fb49363fb482/securityd/src/clientid.cpp#L190-L270) | 用户尚未取得该证书。必须核查实际链/OID 和有效 Team；不能只看显示名。只能作为当前 Mac 本人开发自用候选，仍须证明真实更新来源、启动和凭据恢复均不再提示。 |
| 同一 Team 的 Developer ID Application | **正式分发候选。** Apple 为 Mac App Store 外分发提供该证书及公证流程；源码支持其 `teamid:` 分类。[Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)、[分区实现](https://github.com/apple-oss-distributions/Security/blob/b4bd4fda62af1ebf469ee97f0112fb49363fb482/securityd/src/clientid.cpp#L190-L270) | 需要会员与有效签名身份；完整 Electron 路径尚未跑过。不因付费、证书有效或公证成功就免去 Keychain/登录/恢复验收。 |
| 本实验自签名 + 相同 DR | 当前对照已否定它足以保证静默延续。 | 再点“始终允许”、保持安装路径、重试旧构建，都不能证明新 CDHash 自动获准；没有支持以此直接交付的证据。 |
| 原生 data-protection Keychain 接口 | Apple 推荐的新存储方向，但需要受 profile 授权的 access-group entitlement；可独立研究模型凭据存储。[TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains) | 不是 safeStorage 的公开切换开关，也不会自动迁移 cookieEncryption 的密钥路径；迁移、权限、更新和 Chromium 集成都成为新工作。不是当前最小解决方案。 |

**证书类型的具体依据：**Apple 的 WWDR CPS v1.24（2021-06-02）§4.11.25 明确 Apple Development 证书同时含 iPhone Software Development OID `1.2.840.113635.100.6.1.2` 和 Mac Application Software Development OID `1.2.840.113635.100.6.1.12`。后一个正是上述 securityd 开发证书分支检查的 leaf 扩展。因此不能因当前名称是 Apple Development、源码注释是 Mac Development 就排除它；也不能据历史证书格式文档断言当前 Personal Team 实际签出的证书一定满足条件，仍须检查实物和完整链。[Apple WWDR CPS §4.11.25，第 36 页](https://images.apple.com/certificateauthority/pdf/Apple_WWDR_CPS_v1.24.pdf#page=42)

**七天限制必须按对象理解。** Apple 的免费 Personal Team 页面列出 App ID、设备注册和安装用 provisioning profile 的七天限制；TN3125 同时明确，不使用 restricted entitlement 的 Mac app 不需要 profile（TestFlight 除外），Hardened Runtime 和 App Sandbox 配置属于 unrestricted。当前 file-based Keychain 调用不等同于声明 `keychain-access-groups`。因此可以设计无受限 entitlement/profile 的本机自用候选，但必须检查最终主进程、helper 和签名工具是否真的生成了这样的包。不要通过删除产品必要的受限能力来制造通过。[Personal Team 限制](https://developer.apple.com/help/account/basics/about-your-developer-account#enable-a-personal-team-in-xcode)、[TN3125 macOS entitlement](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles#Entitlements-on-macOS)

**可持续性仍待证。** “不依赖七天 profile”不等于开发证书永不过期。本次未找到可保证当前所有免费 Personal Team 开发证书精确有效期的公开承诺，不把历史示例的一年或 profile 的七天写成实物有效期。Apple 说明 codesign 查找身份时检查证书有效期和信任链；应取得实际 `NotBefore` / `NotAfter`、记录续发方式，并验证续发后的同 Team、旧 DR 接受新包、旧 Keychain 项可读。开发证书不是公证用证书；从真实 HTTPS 更新源下载并安装后的 Gatekeeper 行为也必须独立验证。免费路线若必须靠每次点系统允许或降低系统保护，便不满足本任务。[TN3161](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates)、[公证要求](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

**准备工具不必先升级 macOS。** Apple 当前列出的 Xcode 16.2 支持 macOS Sonoma 14.5 至 Sequoia 15.x，可以作为当前 14.8.3 的兼容候选；实际下载、登录免费账户和证书签发没有在本研究执行，也未假定旧 Xcode 在当前服务端一定能完成所有操作。[Apple Xcode 系统要求](https://developer.apple.com/xcode/system-requirements)、[Xcode 16.2 发布说明](https://developer.apple.com/documentation/xcode-release-notes/xcode-16_2-release-notes)

**具体下一步：**取得兼容的 Xcode 16.2 后，由本人登录 Apple Account，在 `Xcode > Settings > Accounts` 选择 Personal Team，进入 `Manage Certificates`，尝试创建 `Apple Development`。这是 Apple 文档支持的签名身份管理入口，可供外部构建系统使用，不要求先把 Electron 项目改成 Xcode 工程。得到身份后先做下表步骤 2 的只读预检，再重新签署两版原生虚构项探针；只有原生正反对照通过才投入三版 Electron 更新实验。此步骤会创建签名密钥/证书，不是本报告已完成的操作，也不涉及购买会员、导出私钥或更改信任设置。[Xcode 签名身份管理](https://developer.apple.com/documentation/xcode/sharing-your-teams-signing-certificates)、[Personal Team](https://developer.apple.com/help/account/basics/about-your-developer-account)

**费用事实（2026-10-13 查核）：**Apple Developer Program 官方价格为每会员年 99 USD，或可用的本地货币价格；不据此自行换算人民币或承诺税费。Developer ID 证书需要相应账户权限，官方页面列 Account Holder，云托管身份另有授权角色。此研究没有购买或注册；免费 Personal Team 候选未被付费方案取代。[会员价格](https://developer.apple.com/programs/whats-included/)、[Developer ID 角色条件](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)

## Squirrel 更新成功与凭据延续是不同的证明

**官方说明与源码事实：**Electron macOS autoUpdater 使用 Squirrel.Mac，要求应用签名，更新请求受 ATS 约束。该 Squirrel 版本保存当前应用的 DR，并按该 requirement 严格验证下载包及嵌套代码/所有架构；这证明更新包符合代码身份与完整性规则，不检查它能否静默读取旧 Keychain 项。[Electron autoUpdater](https://github.com/electron/electron/blob/v44.7.0/docs/api/auto-updater.md#macos)、[SQRLCodeSignature](https://github.com/Squirrel/Squirrel.Mac/blob/fffea30e4a339a7f7d69a3391314b72548d209bd/Squirrel/SQRLCodeSignature.m#L78-L145)、[SQRLUpdater](https://github.com/Squirrel/Squirrel.Mac/blob/fffea30e4a339a7f7d69a3391314b72548d209bd/Squirrel/SQRLUpdater.m#L1013-L1022)

**推断：**现有实验 DR 钉住实验自签名 leaf。直接把下一包改成 Apple Development 或 Developer ID，不会天然满足旧 requirement；旧 Keychain 项又有旧 DR 与 CDHash 分区。因此“换证书后重新安装/创建新项成功”不能冒充旧身份迁移成功。最小实验应先在新的虚构数据命名空间建立目标身份基线，再做两次真实更新；若正式产品已有真实凭据，须另行设计并验证身份迁移，不能靠清空密钥或要求重输来宣称连续。

**发布条件建议：**固定可信 HTTPS metadata/包来源、签名身份与更新规则，完整验证签名后才安装；保留真实 ZIP/版本和哈希证据。Squirrel 服务器模式只要收到更新响应就会下载，可安装相同版本；静态 JSON 模式有不同版本选择逻辑，不能混用。helpr 已确认“检测只查版本、不提前下载”，因此应先使用自身版本检查，只有允许安装时才进入会下载的更新步骤。[Squirrel README](https://github.com/Squirrel/Squirrel.Mac/blob/fffea30e4a339a7f7d69a3391314b72548d209bd/README.md#server-support)、[静态 feed](https://github.com/Squirrel/Squirrel.Mac/blob/fffea30e4a339a7f7d69a3391314b72548d209bd/README.md#update-file-json-format)、[产品更新约定](../product/discovery.md#更新方式)

**正式 Developer ID 分发条件：**有效签名覆盖全部可执行文件，采用适当的 Hardened Runtime 权限、secure timestamp、正确 entitlement，并按 Apple 要求完成公证；这些是发行与启动的要求，不是此 Keychain 假设的替代证据。当前仅自用时，不能把 Squirrel 的“必须签名”改写成“必须公证才可能更新”；其 DR 校验没有直接要求 Developer ID。[Apple 公证要求](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)、[Squirrel DR 校验](https://github.com/Squirrel/Squirrel.Mac/blob/fffea30e4a339a7f7d69a3391314b72548d209bd/Squirrel/SQRLCodeSignature.m#L78-L145)

## 最小验证顺序与通过条件

以下是可证伪计划，除表中标明的原生反例外均未执行；不允许从计划文字推定已通过。

| 步骤 | 最小操作与必须留下的证据 | 失败或停止条件 |
| --- | --- | --- |
| 1. 完成自签名反例 | **已完成。**同路径、同证书/DR、不同 CDHash 的虚构项对照，新版无 UI 读取失败，清理后项不存在。 | 已足以停止把“只保持自签名 DR”作为交付方案；没有必要不断生成更多同类实验。 |
| 2. 免费身份预检 | 在用户完成免费账户/Xcode证书准备后，只检查新签名的链、OID、Team、互相接受的 DR、证书日期、实际 entitlements/profile。使用公开 Security requirement/API 判断它是否符合开发证书分支。 | 身份无法取得、仍是 ad-hoc/self-signed、缺必要 Apple 链，或产品必须依赖短期 profile；如有失败先定位，不默认购买或改信任。 |
| 3. 原生正反对照 | 同一开发身份签两版，为新虚构项保留受限的 trusted-app ACL；预期新项形成 `teamid:`，两版禁止 UI 的读写校验通过。再以同 Team 不同 identifier、另一个签名身份作拒绝对照，证明 Team 分区没有替代普通 ACL。 | 新版无 UI 读失败、凭据实际重建、或非授权身份能读，任一即失败；不得扩大 trusted list / partition 来让测试通过。 |
| 4. 真实 Electron N→N+1→N+2 | 三个不同签名后 CDHash，固定身份、app name、数据路径和 partition，cookieEncryption 从基线即启用。N 写入虚构模型值与有限期测试登录；经选定真实更新源及 Squirrel 两次安装、冷启动。逐次核对原密文可解、cookie 对应同一会话、实际页面仍登录、持久资料完整、按原意图恢复；记录零系统授权操作。 | 任何授权提示、重输凭据、重新登录、换新密钥假装恢复、取消 cookie 加密，均不通过。仅进程内缓存读取不算跨更新证据。 |
| 5. 延续与故障条件 | 记录退出/冷启动后读取、证书续发的静态兼容性与实际更新、未获密钥时停止自动派发且保留原密文。核对真实用户登录会话、系统 Keychain 可用性及数据错误。 | 不承诺机器尚未解锁、用户主动锁住/撤销 Keychain 权限或服务器已撤销登录时仍绕过系统继续执行；不得将真正失效的登录伪装为更新故障修复。 |
| 6. 必要时比较 Developer ID | 如果免费候选取得了明确失败证据且原因确与身份类别/分发条件有关，再用同一实验矩阵验证 Developer ID；用户另行决定会员，不自动购买。 | 不能以会员已付费、能启动、Squirrel更新成功代替步骤3–5。 |

禁止交互是实验的“失败即停止”设置，不是让系统无条件放行。同步 safeStorage 的 `isEncryptionAvailable()` 本身会进入派生密钥路径，不能把调用它描述成只读签名元数据预检；测试应限制在自己的虚构项/命名空间，不碰真实用户秘密。[safeStorage](https://github.com/electron/electron/blob/v44.7.0/shell/browser/api/electron_api_safe_storage.cc#L147-L156)、[同步派生逻辑](https://github.com/electron/electron/blob/v44.7.0/patches/chromium/revert_oscrypt_remove_sync_backend.patch#L4978-L5121)

## data-protection Keychain 的适用边界

**官方说明：**macOS 同时有 file-based 与 data-protection 两种实现。SecKeychain 始终访问前者；SecItem 默认也访问前者，需显式选择后者。data-protection Keychain 使用签名 entitlement 中的 access groups，并要求 provisioning profile 授权，只在用户登录上下文中可用；同一用户并不意味着所有应用都有该组访问权。[TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)、[Access groups](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps)

**推断：**它可以是未来独立原生凭据 Module 的选择，但当前研究不能推荐“换一个 Node Keychain 库”作为完整修复。库若仍走默认 file-based 路径，partition 问题可能不变；仅迁移模型凭据又遗漏了 Chromium cookie 密钥。真正采用该路线必须一并验证签名/profile、原项授权迁移、Electron/Chromium 使用同一受保护密钥及更新恢复，工作量明显大于先验证现成签名路径。

本报告不提出明文保存、硬编码密钥、关闭 cookieEncryption、允许所有应用访问、扩大 Keychain 分区、禁用 Gatekeeper/SIP 或改信任设置。当前可推进结论是：自签名仅靠稳定 DR 的路线已被反例否定；免费 Apple 开发身份仍值得做有边界的验证，Developer ID 保留为有正式分发条件的候选；两条路线都尚未取得 helpr 自动更新后的完整凭据延续通过证据。
