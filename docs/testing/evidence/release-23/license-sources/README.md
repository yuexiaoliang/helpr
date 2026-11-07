# 缺失正文的上游来源核对

2026-11-07。在候选79冻结后进行了只读来源调查；这些文件仅为后续补齐材料，**没有改写已签名候选79，也没有将其预检缺失改成通过**。

- `drizzle-orm-0.45.4.LICENSE`：来自上游已发布的[0.45.4标签](https://github.com/drizzle-team/drizzle-orm/releases/tag/0.45.4)的[LICENSE](https://github.com/drizzle-team/drizzle-orm/blob/0.45.4/LICENSE)，GitHub内容blob为`261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64`。
- `saxes-6.0.0.LICENSE`：[npm精确版本元数据](https://registry.npmjs.org/saxes/6.0.0)给出`gitHead=211fa0ebec9b628affc09219199639887174bfc3`，按该提交读取[上游LICENSE](https://github.com/lddubeau/saxes/blob/211fa0ebec9b628affc09219199639887174bfc3/LICENSE)，blob为`187f3ba399862022f4e670b2a3a1dbc6d7e6a800`；保留其fork来源和附带声明。
- `@ai-sdk/provider-utils@5.0.60`：已读安装内容与[npm精确版本元数据](https://registry.npmjs.org/@ai-sdk/provider-utils/5.0.60)，未包含gitHead。调查时[上游main的package.json](https://github.com/vercel/ai/blob/main/packages/provider-utils/package.json)是5.0.75，不能将该分支默认为当前5.0.60来源；尚待精确标签／发布证明。
- `client-only@0.0.1`：已读[npm精确版本元数据](https://registry.npmjs.org/client-only/0.0.1)，声明MIT，但没有仓库、gitHead和发布包内正文；仍待确切来源与版权归属材料，未从不相关包复制模板。

后续将核对后的外部补充正文绑定精确包名／版本、lock完整性和来源摘要，再纳入新候选；不得修改79的清单或把来源调查计作真实产品业务验收。
