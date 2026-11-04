# 09 重复授权与取消授权丢失登录的定位

2026-11-04，承接用户要求查清重复授权并完成09剩余验收，计划见[剩余验收](upgrade-09-remaining-plan.md)。本次不读取钥匙串密码、不操作安全窗口、不修改ACL或系统信任。

## 重复提示的已知原因

用户确认上一轮点击“允许（仅本次）”。只读查询精确服务 `helpr Safe Storage`：登录钥匙串状态7、未设自动锁定时限；38–40控制及网页宿主各自的指定要求相同。当前40控制进程的代码分区已记录，网页宿主的代码分区未记录。Electron 44.7.2按应用名选择该服务，两个独立签名的进程都需要访问它；单次许可不等于两者已获持久许可。[Electron固定版本实现](https://github.com/electron/electron/blob/v44.7.2/shell/browser/electron_browser_main_parts.cc)、[Apple ACL说明](https://developer.apple.com/documentation/security/secaclcopycontents(_:_:_:_:))。

本机该项现有分区均为cdhash，没有团队身份分区；因此不把稳定指定要求等同于每份新开发候选都已有系统许可。缺少40网页宿主持久分区的只读断言得到 `HOST_KEYCHAIN_AUTHORIZATION_NOT_PERSISTED`。是否持久授权由用户在实际系统窗口决定，不能通过加入“所有应用”或禁用加密来消除提示。

## 111实际取消发现的数据缺陷

复用40及原profile，先在应用关闭时保留APFS资料副本、Cookie密文摘要、唯一模型配置摘要，原有效会话未重新创建。111实际窗口244ms可读；用户在系统窗口拒绝／取消。任务、中文草稿和停止仍在，但原Cookie从1行变成0行，本机服务收到A、B未认证请求。此次取消验收失败，不能因界面没卡住就计通过。

停止后退出0，独立进程清空。失败profile完整改名保留，原profile位置从预备副本恢复；原Cookie摘要逐字匹配。原私有服务身份、端口、到期、登录次数及所有计数不变。恢复只用于修正复验，不能充抵“取消未丢数据”的证据。

## 具体修正及回归

Electron 44.7.2的 `OnOsCryptReady` 将异步可用性标记为true；该结果不保证底层密钥已取得。Chromium在没有可用加密密钥时实际加密返回失败。原代码只看初始化可用值，取消授权后仍加载网站，随后浏览器清理了无法解密的Cookie。[safeStorage固定版本](https://github.com/electron/electron/blob/v44.7.2/shell/browser/api/electron_api_safe_storage.cc)、[Chromium固定版本Encryptor](https://chromium.googlesource.com/chromium/src/+/152.0.7977.149/components/os_crypt/async/common/encryptor.cc)。

`verifyPageProtection` 在异步接口可用后，对临时随机值实际加密、解密并核对；失败保持原网页未加载，并暂停受影响任务。升级会话摘要也必须先通过该保护核对，才查询原Cookie；重新打开及inspect沿用同一核对。自检值仅在内存中，不是模型密钥、不持久化，不返回网页或日志，也不替代原密钥和原登录的独立核对。

新边界先保留原“只看可用值”实现，定向回归得到2红／4绿；修正后加入有效保护成功例，专项7项通过。类型、lint、格式通过；首次全套执行中的独立宿主启动用例触及原10秒测试截止，143其它测试通过。该用例与保护专项单独运行14/14通过；降低文件并发后完整144项通过，未提高单测超时；25旧回归与6验证器专项通过。原lint及启动超时日志保留。修正须进入新的固定候选41，经实际取消、持久授权、同包冷开复验后才讨论AC6关闭。
