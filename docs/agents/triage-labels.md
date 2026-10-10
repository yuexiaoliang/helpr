# 分诊状态

将标准分诊角色映射到本地事项文件使用的 `Status:` 值。

| 标准角色 | Status 值 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 等待维护者评估 |
| `needs-info` | `needs-info` | 等待提出者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 规格完整，可交由智能体自主实现 |
| `ready-for-human` | `ready-for-human` | 需要人工实现 |
| `wontfix` | `wontfix` | 不予处理 |

当技能要求添加某个分诊标签时，在事项文件顶部附近设置对应的 `Status:` 值。

如需更换名称，编辑表格的 Status 值列。
