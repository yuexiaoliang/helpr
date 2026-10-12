# 准备次数修订：6 → 8

2026-10-12，第四次准备结束后、第五次开始前记录。原计划和全部消耗保留，不重置额度。

四次准备分别停在登录过期、跳转后的过早检查、首页冷加载超时、嵌入编辑器点击所需的 `DOM.getFrameOwner` 未开放。累计上传、发布、真实模型调用均为 0；失败任务及可能已建立的空草稿仍保留，不能宣称它们从未产生作用。

原有四个有效样本仍需四次准备，因此只将准备上限从 6 改为 **8**，补足两次无上传／发布的启动失败。不新增有效样本或业务目标。上传 6、发布 3、外部修改 1、浏览器启动 24、程序修订 4、模型调用 12／140,000 token、90 分钟总时间等上限保持。此为原 AFK 事项内的有界工程修订，不借用旧研究额度，也不解释为用户逐条确认过的产品任务。

先在已有测试文章上只读验证新增协议能力：允许查找已归属 frame 的宿主元素，仅从该协议的类型化返回登记 backend node；伪造 frame / backend node 仍拒绝。现有失败任务不补写地址、不重置为新任务。新的学习尝试使用新的执行身份；其后才冻结并执行保留集。

接口依据：[Chrome DevTools Protocol DOM 定义](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/DOM.pdl)中的 `getFrameOwner` 接收 frameId，返回 backendNodeId。实际 Playwright 1.64.0 的 `coreBundle.js:38886` 在取得 iframe 元素时使用该方法。文档仅用于确定能力边界，运行是否通过仍以本轮证据为准。
