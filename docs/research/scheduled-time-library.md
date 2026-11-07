# 定时计划的时间库与歧义处理

2026-11-07，为[事项 20](../../.scratch/helpr-first-release-implementation/issues/20-scheduled-material-work-and-missed-runs.md)核对时间库。建议仅增加并精确锁定 **`@js-temporal/polyfill` 0.5.1**，用它计算时区、日历日期和候选时刻；计划确认、版本、轮次领取、素材工作去重、错过策略及恢复仍属于 helpr 的持久业务记录。本次调研只读取官方文档、固定版本源码和 npm 元数据，没有安装依赖、启动浏览器或 Electron，也没有把下文预期表当作产品测试通过。

## 候选与版本

本次 `npm view <package> version engines dependencies --json` 返回以下版本，固定标签的官方包元数据与之相符。工程依赖应使用精确版本并提交锁文件；本笔记不擅自修改依赖。

| 候选 | 核验版本 | 相关能力与取舍 |
| --- | --- | --- |
| `@js-temporal/polyfill` | `0.5.1`；运行依赖 `jsbi ^4.3.0` | 分开表示日期、本地时刻和绝对时刻；转换时有显式 `earlier`、`later`、`reject`。适合让产品先识别歧义，再应用用户约定。包含 TS 类型与 CJS/ESM 入口 |
| `cron-parser` | `5.10.4`；运行依赖 `luxon ^3.7.2` | 适合 cron 表达式和迭代；支持 `tz`，但该版公开 `CronExpressionOptions` 没有独立的重复／缺失时刻策略。不能把内部 DST 处理当成用户选择；当前每日与固定间隔范围不需要增加 cron 语法 |
| `luxon` | `3.7.2` | 支持 IANA 时区、日历与时长运算，`getPossibleOffsets()` 能列出重复本地时刻的候选；缺失时刻会向后平移。直接构造的默认结果仍需产品辨认，不能只检查 `isValid` |

版本及接口依据：[Temporal 0.5.1 包元数据](https://raw.githubusercontent.com/js-temporal/temporal-polyfill/v0.5.1/package.json)、[Temporal 0.5.1 类型](https://raw.githubusercontent.com/js-temporal/temporal-polyfill/v0.5.1/index.d.ts)、[cron-parser 5.10.4 包元数据](https://raw.githubusercontent.com/harrisiirak/cron-parser/v5.10.4/package.json)、[该版公开选项](https://raw.githubusercontent.com/harrisiirak/cron-parser/v5.10.4/src/CronExpression.ts)、[Luxon 3.7.2 包元数据](https://raw.githubusercontent.com/moment/luxon/3.7.2/package.json)、[Luxon `getPossibleOffsets` 源码](https://raw.githubusercontent.com/moment/luxon/3.7.2/src/datetime.js)、[Luxon 时区说明](https://raw.githubusercontent.com/moment/luxon/3.7.2/docs/zones.md)。

这是按本项接口需要作出的工程选择，不是所有日期库的排名。Temporal polyfill 官方仓库仍标注建设中，不能据标准提案或已有测试宣称实现没有风险；0.5.1 的固定 API、明确歧义选项和上游 test262 检查为本次采用提供依据，实际支持边界须由 helpr 检查固定。[项目说明](https://github.com/js-temporal/temporal-polyfill)、[0.5.1 检查脚本](https://raw.githubusercontent.com/js-temporal/temporal-polyfill/v0.5.1/package.json)

## 时间表达必须保留区别

“每天 09:00，Asia/Shanghai”保存本地时刻和时区，以日历日期逐日组合候选。“每隔 24 小时”保存绝对起点和固定秒数，以 `Instant` 运算。前者跨夏令时可能相隔 23 或 25 小时，后者始终相隔 86,400 秒，显示的本地钟点可能改变。`PlainDate.add({ days: 1 })` 负责历法，helpr 不计算月份长度或自行维护夏令时规则。[PlainDate](https://tc39.es/proposal-temporal/docs/plaindate.html)、[Instant](https://tc39.es/proposal-temporal/docs/instant.html)

每日候选应从每个原始日历日期重新组合约定时刻，不从前一日被调整过的 `ZonedDateTime` 反复加天，否则一次缺失时刻的平移容易成为以后日期的错误基准。固定间隔只接受明确的正数时间单位；“每隔一天”若不能确定是日历每日还是 24 小时，应补问并用相邻两次的具体时间复述。自然语言理解形成提案，不直接授予定时执行资格。

```ts
import { Temporal } from '@js-temporal/polyfill';

const date = Temporal.PlainDate.from('2026-03-07');
const time = Temporal.PlainTime.from('09:00');
const zone = 'America/New_York';
const firstDaily = date.toPlainDateTime(time)
  .toZonedDateTime(zone, { disambiguation: 'reject' }).toInstant();
const nextDaily = date.add({ days: 1 }).toPlainDateTime(time)
  .toZonedDateTime(zone, { disambiguation: 'reject' }).toInstant();
const nextInterval = firstDaily.add({ hours: 24 });
// 预期：nextDaily 为 2026-03-08T13:00:00Z；nextInterval 为 14:00:00Z。
```

方案保存 `Asia/Shanghai`、`America/New_York` 等明确时区，计算时显式传入；机器当前时区只可作为创建时的建议，不能在后续触发时重新读取并替换约定。不要把 `CST` 等多义缩写自行解释为唯一地区，也不要用当天固定偏移代替地区时区。Temporal 支持 IANA 时区，时区规则本身会因政策改变而更新。[时区概念](https://tc39.es/proposal-temporal/docs/timezone.html)

锁定 polyfill 不等于锁定时区数据库：0.5.1 的地区时间计算调用运行时 `Intl.DateTimeFormat`。正式证据需同时记录 Node/Electron、ICU/tz 版本。已领取轮次的绝对时刻及名义本地时间应持久保存；升级后未来候选有变化时须重新核对，不能移动已领取的轮次或重发。[固定版本的时间转换实现](https://raw.githubusercontent.com/js-temporal/temporal-polyfill/v0.5.1/lib/ecmascript.ts)

## 重复与不存在时刻

`PlainDateTime.toZonedDateTime(zone, { disambiguation: 'reject' })` 遇到重复或不存在的时刻都会抛出 `RangeError`。产品不使用默认 `compatible`。需要展示选择时，可用 `earlier`、`later` 各算一个候选：两者相同则唯一；不同且都能转回原本地时间则重复；转回不同时间则原本地时间不存在。这里组合库结果，不自行推算偏移变更。[转换 API 与往返行为](https://tc39.es/proposal-temporal/docs/plaindatetime.html#toZonedDateTime)

```ts
const wall = Temporal.PlainDateTime.from('2026-11-01T01:30');
const earlier = wall.toZonedDateTime('America/New_York', {
  disambiguation: 'earlier',
});
const later = wall.toZonedDateTime('America/New_York', {
  disambiguation: 'later',
});
const sameInstant = earlier.epochNanoseconds === later.epochNanoseconds;
const bothMatchWall = earlier.toPlainDateTime().equals(wall)
  && later.toPlainDateTime().equals(wall);
// 预期：sameInstant 为 false，bothMatchWall 为 true。
```

重复时刻可明确选择第一次、第二次或届时询问；不存在时刻可明确选择跳过、按偏移变化向后平移或询问。具体产品支持项由实现固定并复述，未选择不生效。不要笼统把 `later` 描述成“下一个有效时刻”：纽约 02:30 缺失时，`later` 为 03:30，并非 03:00。DST 处理与错过策略是两个独立约定；“错过就跳过”不自动说明不存在的时刻怎么办。

对象输入需要显式 `overflow: 'reject'`，避免非法日期被库约束到月末后接受；无效时区、空日期和不支持频率要形成清晰补问或错误。只有已验证且明确接受的提案才能进入计划版本。

## 公开行为检查表

下表是根据固定接口和 IANA 规则形成的**预期断言**，不是本次调研已经运行的证据。正式实现应从导出的时间函数或计划入口执行，记录实际结果；不只模拟库返回值。

| 输入／操作 | 应核对的公开结果 |
| --- | --- |
| 上海每日 09:00，2026-11-07 | `2026-11-07T01:00:00Z`；本地日期仍为 11-07 |
| 同一绝对时刻分别显示上海、纽约 | 可不同本地日期，绝对轮次身份不变 |
| 纽约每日 09:00，2026-03-07 → 03-08 | `14:00Z` → `13:00Z`，相隔 23 小时 |
| 上例从首时刻固定增加 24 小时 | 次日 `14:00Z`，纽约 10:00，不能声称仍为每日 09:00 |
| 纽约每日 09:00，2026-10-31 → 11-01 | `13:00Z` → `14:00Z`，相隔 25 小时 |
| 纽约 2026-11-01 01:30 | `earlier=05:30Z`、`later=06:30Z`；`reject` 抛错；两个都回到 01:30 |
| 纽约 2026-03-08 02:30 | `earlier=06:30Z`（01:30 -05:00）、`later=07:30Z`（03:30 -04:00）；`reject` 抛错；两个都不能回到 02:30 |
| 当天对缺失 02:30 按约定平移，次日仍设 02:30 | 次日回到 02:30，不沿用 03:30 |
| `Australia/Lord_Howe` 的偏移变化 | 不假定所有 DST 变化均为 60 分钟；由库计算并往返比较 |
| `Pacific/Apia` 2011-12-30 | 覆盖整日缺失；不以手写小时扫描猜测有效日期 |
| 2028-02-28 加两日 | 2028-03-01；2026-02-30、25:00、未知时区明确拒绝 |
| 将宿主 `TZ` 从 UTC 改为 America/Los_Angeles | 显式 Shanghai 计划候选完全相同 |

年份、时区与输入值是可复现检查样本；转换机制依据上述官方 API。Lord Howe、Apia 的检查应比较库结果和 IANA 当期数据，并记录实际运行时版本，避免把现在的库元数据当成永远不变的政策保证。

## 计划职责及独立验证

时间库仅回答候选时刻，不保存任何执行意图。helpr 必须逐计划明确保存“补最近一次”“跳过”“先询问”；字段缺失保持待确认，不能由库、定时器或全局配置静默补齐。补最近一次只作用于错过且未开始的轮次；此前已领取但停止、等待或结果不明的任务保持原归属。恢复旧备份仍先暂停，再由用户选择继续哪些计划。

计划版本应保存时间表达、时区、歧义策略、错过策略、取材规则和生效边界。确认时至少复述下一次具体本地时间和偏移；修改只按明确范围影响未来轮次。独立记录进程原子提交轮次领取、选材／等待决定和任务关联；控制入口在派发时再次核对暂停、停止、撤销、登录及容量资格。当前网站导航要求明确继续的边界不由定时触发解除。以上是[已确认需求](../product/discovery.md#定时取材)、[ADR-0004](../adr/0004-local-durable-records.md)和[ADR-0005](../adr/0005-record-process-and-state-transitions.md)对库集成的约束。

正式验证还需覆盖重复通知、计划修改后同轮次、时钟倒退／前跳、唤醒与升级暂停竞争、事务回滚、冷开以及旧备份恢复。确定性时间检查可证明候选和领取决策，不能代替实际素材及网页效果核对，也不能证明设备休眠或应用未运行时能够按时执行。
