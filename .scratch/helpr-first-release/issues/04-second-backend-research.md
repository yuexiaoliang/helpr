# 筛选第二套开源验证后台

Type: research
Label: wayfinder:research
Mode: AFK
Status: resolved
Blocked by: None
Map: [helpr 首版技术决策地图](../map.md)

## Question

哪些可自托管的开源项目适合作为 WordPress 之外、网页结构不同的第二套验证后台？给出依据充分的首选与备选，供后续实际部署和跨后台实验，不把资料调查当作路径已经通过。

阅读项目官方资料和源码，比较许可、自托管条件、真实网页上传附件或发布内容的路径、栏目或分类组织，以及如何从网页核对产出。优先使用原生后台能力；准备测试账号、内容结构与样本是允许的，产品源码仍不能新增站点业务实现。

调查需区分 Excel 附件发布与读取 Excel 后生成文章，指出候选分别适合哪种对照、有哪些原生能力缺口。第二套后台不必在所有功能上复制 WordPress，关键是能检验通用流程对不同网页结构的适应。

将带一手来源的报告保存在独立研究分支，记录推荐依据、限制与实测前要核对的事项。本事项不部署服务，不修改已有 WordPress 或其它服务。

## Answer

2026-10-10 完成官方文档、许可证与源码调查，推荐 **Drupal 为首选，Ghost 为备选**。排序以不同网页结构的对照价值为先，准备成本为次。

- Drupal 的原生字段表单、分类引用与附件字段提供更明显的结构差异。测试站点需配置内容类型、栏目词表和 File 字段，并明确允许 `xlsx`；这些属于站点准备，网页步骤和字段映射仍由运行时流程形成。
- Ghost 的原生 File card、文章发布与公开标签页适合准备较少的备选路径。需核对自托管上传限制和测试账号的邮件登录验证。
- 两者均有原生公开文章页面；Excel 附件发布和读取 Excel 后生成文章必须分别验证。当前 Directus 使用源码可用许可，且公开文章前台需要额外准备，本轮不作为开源候选。

完整依据、核查版本、来源与待实测路径见 [第二套验证后台调查](https://github.com/yuexiaoliang/helpr/blob/c52232537c9024955c1cf15d33f3ca1fd54bf560/docs/research/second-validation-backend.md)。报告原推送至独立分支 `research/helpr-second-backend`，提交 `c52232537c9024955c1cf15d33f3ca1fd54bf560`；2026-10-16 改以[归档标签](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/second-validation-backend)长期保存，原始提交不变。该独立来源只包含报告，按研究约定不合并到产品分支，处理记录见[分支归档索引](../../../docs/maintenance/branch-archive.md)。

本结论是资料调查结果，尚未部署或实际操作这两套后台。实际上传、发布、栏目归属、附件下载一致性，以及无需新增产品业务代码的对照证据，由 [取得第二后台的流程对照证据](11-second-backend-comparison.md)继续取得。
