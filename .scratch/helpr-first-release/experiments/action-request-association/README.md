# 网页动作与请求关联边界实验

一次性本机浏览器探路，已结束。入口是 [报告](REPORT.md)、[计划和预算](PLAN.md)、[证据索引](evidence-index.json)与[对应事项](../../issues/18-action-request-association.md#answer)。本轮没有模型调用或远端后台操作。

只读复核：在本目录运行 `python3 audit.py`。它用 Python 标准库独立解析原始 HTTP 实体，不导入 JavaScript 夹具的 multipart 解析器；只重新生成 `artifacts/audit.json`，不启动浏览器、不写网站。

`run.mjs` 是实验运行入口；`fixture.mjs` 负责虚构网页、服务器和业务预期；`wire.mjs` 负责完整实体观测及候选请求约定检查。所有业务字段和期望均来自测试夹具，不是产品业务代码。本轮运行使用既有 `../runtime-flow-replay/node_modules/playwright/`，没有安装新依赖。

`artifacts/run-1/source/` 是首批 24 个场景的实测源码快照；`artifacts/run-2/source/` 是补充“错误请求先到”对照的实测快照，并加入“实验已关闭”入口保护。校验值在各自同级的 `source-hashes.json`。第二批只跑新增的 1 个场景，没有重跑首批。账本 `artifacts/budget.json` 累计全部 25 次尝试并已关闭。任何新实验需要单独明确范围，不能删除账本后继续计算本轮通过率。

每个场景目录均保存浏览器请求、CDP initiator / 正文观测、DOM 事件、服务器收件和结果。候选代理场景另有 `proxy.json` 和代理接收的完整实体；实际抵达服务器的实体是 `server-body-*.bin`，收到的文件是 `server-file-*.bin`。所有二进制均为本机虚构样本，不含账号或凭据。`server.json` 的空数组也是证据：浏览器有请求尝试，但服务器未收到。

场景名称中的 `strict` 只表示候选的字节和一次性许可检查更严格，**不表示它已经严格证明动作来源或业务授权**。`strict-matching-timer` 就是该候选仍会误关联的反例。
