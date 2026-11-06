# Excel 内容解析选型与支持边界

2026-11-07，为[事项 18](../../.scratch/helpr-first-release-implementation/issues/18-excel-article-preview-and-publish.md)比较 ExcelJS 与 SheetJS CE。选择 **SheetJS CE 0.20.3**，从官方 CDN 的版本化 tarball 锁定依赖；采用成熟 ZIP 库做有界预检。首批产品输入限定为未加密的 `.xlsx` 工作簿，读取已固定的素材字节，解析不访问原文件路径、不刷新外部数据，也不重算公式。产品实现与验收记录另行保存；这里的库行为探针不代表文章生成或网页发布已经通过。

## 版本与选择依据

| 候选 | 本次核验版本、来源 | 与本项有关的取舍 |
| --- | --- | --- |
| SheetJS CE | 官方安装页指定 `0.20.3`；官方 tarball 的 `package.json` 自报 `0.20.3`、Apache-2.0、无运行依赖。npm 的 `xlsx` 最新仍是 `0.18.5`，不能用裸包名取得当前版本 | `t/v/z/w/f/F/D` 分开表示类型、原值、格式、显示文本与公式信息，默认保留日期序号，便于追溯。仍需处理缺缓存公式、数组子格与不支持内容，不能把读成功等同于事实可靠 |
| ExcelJS | npm 与 GitHub 发布均为 `4.4.0`，MIT，包含 XLSX/CSV 读写、样式与流式接口 | 对编辑工作簿很方便，但读取日期时自动转换成 JS `Date`；本项更需要原值与类型的稳定保留。公式只读取提供的结果，不负责求值 |

版本来源：[SheetJS NodeJS 安装说明](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)、[SheetJS 0.20.3 tarball](https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz)、[ExcelJS npm 元数据](https://registry.npmjs.org/exceljs/4.4.0)、[ExcelJS 4.4.0 包元数据](https://raw.githubusercontent.com/exceljs/exceljs/v4.4.0/package.json)、[ExcelJS 4.4.0 文档](https://github.com/exceljs/exceljs/tree/v4.4.0#readme)。

本次实际下载的 SheetJS tarball 为 2,409,319 字节，摘要如下。依赖管理器应保存原 URL 与 integrity，不回退到 npm 旧版或第三方重打包。Python 默认请求首次得到 HTTP 403，改用 `curl` 后得到 HTTP 200 并完成下载；这不是库解析失败。

```text
sha256: 8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8
integrity: sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==
```

## 事实、显示和公式必须分开

SheetJS 单元格对象保留 `t` 类型、`v` 原值、`z` 数字格式、`w` 格式化文本。`w` 是库根据格式产生的显示，不是另一份独立原始事实；例如百分比必须同时保留原值和格式。空单元格、空字符串、数值零、布尔 `false`、错误均不互换。`t:'e'` 的数值是错误代码，不能当业务数字；错误名在 `w`。`t:'z'` 为无值占位，不能只检查 `typeof v === 'number'`。[单元格对象](https://docs.sheetjs.com/docs/csf/cell/)

建议显式设置以下读取参数，并把实际参数及 helpr 支持策略版本写入解析记录。`raw:true` 只影响纯文本格式，不能作为 XLSX 的“保持原始值”开关。`WTF:true` 使部分解析异常向外抛出，但不是完整 OOXML 校验器。不要用 `sheetRows` 截断后冒充完整解析；超限应明确拒绝。`nodim:true` 可按实际单元格重建范围，仍需单独限制尺寸与单元格数。[解析选项](https://docs.sheetjs.com/docs/api/parse-options/)

```ts
{
  type: 'buffer',
  cellDates: false,
  cellFormula: true,
  cellNF: true,
  cellText: true,
  cellStyles: true,
  cellHTML: false,
  sheetStubs: true,
  xlfn: true,
  nodim: true,
  WTF: true,
}
```

SheetJS CE 不计算公式。`f` 为公式文本；数组范围内的子格可能只有 `F`，动态数组还可能有 `D`，均须按公式处理。首批策略是：**全部公式结果标为未重算、不可作为确定事实**；缓存存在也不证明它与当前输入、外链或计算设置一致。需要这些值时，先在电子表格应用中核对、重新计算，将确认的结果转为普通值另存，再明确选取新的素材版本；仅重算并保存仍然含公式的工作簿不会解除本策略；不能由模型猜算后伪称源表事实。[公式说明](https://docs.sheetjs.com/docs/csf/features/formulae/)

本次直接检查锁定 tarball 的 `xlsx.mjs`，发现须保留的细节：

- `parse_ws_xml_data` 在无类型、无缓存的公式中先合成 `v:0`，最终读出的占位格可带 `t:'z', f:'1+1', v:0`。零不是文件缓存；产品须优先按类型归一为空，而不是展示或引用为零。
- 正常共享公式的子格会按主格公式展开 `f`；缺少共享主格时可能不设置 `f`，不会因 `WTF:true` 自动报错。有限支持检查需确认公式元数据没有丢失；不能把这种子格的缓存升为普通确定事实。
- 数组子格可仅有 `F`，不能只以 `f` 判断是否为公式。
- `parse_xlink_xml` 在该版本是空实现；读取成功不能证明已理解或更新外链工作簿。预检发现外链、数据连接或查询表时，按不支持输入反馈，或保留明确的不确定状态。

以上是锁定发行源码的观察，来源为[官方 tarball](https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz)中的 `xlsx.mjs` 和 `types/index.d.ts`，不是对其它版本的保证。检查 `<f>` 等有限支持元数据可使用成熟 XML 解析器；不在 helpr 内实现第二套 Excel 求值或通用表格解析器。

## 日期、结构与格式范围

| 输入 | 首批处理原则 |
| --- | --- |
| 1900 / 1904 日期系统 | 保存 `Workbook.WBProps.date1904`、数值序号和数字格式；用库的日期格式能力解释，保留日期系统。`true` 是 1904。普通 Excel 日期没有时区，不自动宣称 UTC 时刻 |
| 1900 序号 60 | 保留原序号并提示 Excel 历史兼容日期，不把不存在的 1900-02-29 改成另一实际日期；日期事实保持不确定 |
| 纯时间、累计时长 | 保留原值与格式，如 `[hh]:mm` 不等同于日历日期。模糊字符串日期保留字符串，不按机器区域设置猜日期 |
| 空白 / 空串 / 零 / 错误 | 分别保存；未列出的空白位置不填零。错误不可成为数值事实 |
| 合并单元格 | 保存合并范围及左上主格；覆盖格不复制成重复事实，不据合并布局猜业务表头 |
| 隐藏工作表、行和列 | 保存隐藏标记并在来源中说明；默认不把隐藏内容作为文章依据。是否需要这些数据属于处理要求，不能悄悄遗漏后声称全文已解释 |
| 超链接、富文本与注释 | 仅作为来源元数据或纯文本，链接不自动访问，单元格 HTML 不注入预览 |
| `.xls`、`.xlsb`、`.xlsm`、CSV、ODS、加密文件 | 本项首批均明确反馈不支持，附件原样上传能力与内容读取能力分开。不能因改扩展名就接受 |
| 宏、外链、数据连接、查询表、图表、图片、数据透视及复杂计算 | 不执行、不刷新。不能把图像或布局中未解析的信息补为事实；依赖这些结构的委托应请求可读数据或说明未覆盖范围 |

日期依据：[日期与时间](https://docs.sheetjs.com/docs/csf/features/dates/)。结构依据：[合并单元格](https://docs.sheetjs.com/docs/csf/features/merges/)、[工作表隐藏](https://docs.sheetjs.com/docs/csf/features/visibility/)、[行属性](https://docs.sheetjs.com/docs/csf/features/rowprops/)、[列属性](https://docs.sheetjs.com/docs/csf/features/colprops/)。格式及宏依据：[文件格式能力](https://docs.sheetjs.com/docs/miscellany/formats/)、[VBA 与宏](https://docs.sheetjs.com/docs/csf/features/vba/)。这些来源说明库能力，上表的产品支持范围是本项的工程选择。

`cellStyles:true` 是提取隐藏行列元数据所需选项。合并范围可以覆盖含值单元格，库不会自动替调用方判断其业务含义。SheetJS 日期文档当前示例有一处 `date1904` 条件分支的注释写反；此处以包内类型、源码和下述实际读取结果相互核对。

## 解压与执行资源

建议锁定 **yauzl 3.4.0**（MIT）作为 ZIP 预检库。它提供中央目录元数据、按条目读取和实际解压长度校验；`lazyEntries:true` 避免并发展开整个归档。启用 `validateEntrySizes:true` 后仍需由 helpr 限制总文件字节、条目数、各条目及总解压字节，并把每个流读到结束、处理错误。只检查中央目录声明尺寸、不读取流，不能证明真实展开尺寸符合声明。[yauzl 3.4.0 文档](https://raw.githubusercontent.com/thejoshwolfe/yauzl/3.4.0/README.md)、[发布元数据](https://registry.npmjs.org/yauzl/3.4.0)

比较过 **fflate 0.8.3**（MIT）。它也有流式与异步解压，适合多种运行环境；这里更看重 yauzl 的中央目录及长度校验接口。不要先 `unzipSync` 整包展开，再检查是否超限。[fflate 官方文档](https://github.com/101arrowz/fflate)、[0.8.3 元数据](https://registry.npmjs.org/fflate/0.8.3)

以上为资源处理选择，不表示 ZIP 库完成所有内容验证。还应拒绝重名或不安全条目、异常 OOXML 包结构、伪装格式和超限单元格/字符串；同步工作簿解析放入可终止的受管工作单元，设置单次总时限，不能阻塞主窗口与停止指令。解析失败不得保存“可发布事实”，更不能将素材处理记为完成。具体数值限制、终止与清理证据由实现测试固定。

## 两库代表性字节探针

本次未安装依赖或启动浏览器/Electron。以 Python 标准 ZIP 工具生成两个仅日期系统不同的最小 XLSX，从官方 tarball 提取 SheetJS 的 `xlsx.mjs`、ExcelJS 的 `dist/exceljs.min.js`，在临时 Node 进程中读取相同字节。工作表同时含公式、有无缓存、错误、零、空白、空串、共享公式、数组子格、隐藏行列和合并单元格。该步骤验证库行为，不包含产品的来源绑定、内容确认、模型或网页发布。

| 探针 | SheetJS CE 0.20.3 | ExcelJS 4.4.0 |
| --- | --- | --- |
| `1+1` 无缓存 | `t:'z',f:'1+1',v:0`；零需归一为缺失 | `{formula:'1+1'}`，无 `result` |
| `1+1` 缓存 2 | `t:'n',v:2,f:'1+1'` | `{formula:'1+1',result:2}` |
| 空白 / 显式空串 / 零 / false | 分别为 `z` / `s:''` / `n:0` / `b:false` | 该样本的空白和空串均为 `null`；零和 false 保留 |
| `#DIV/0!` | `t:'e',v:7,w:'#DIV/0!'` | `{error:'#DIV/0!'}` |
| 共享公式子格 | 展开对应 `f` | 保留 `sharedFormula`，`cell.formula` 展开 |
| 数组范围的非主格 | 含 `F` | 该样本只显示普通数值，需另查主格范围 |
| 1900 序号 1 / 60 / 61 | 原值保留；显示 `1/1/00` / `2/29/00` / `3/1/00` | 转为 `1899-12-31` / `1900-02-28` / `1900-03-01` 的 Date |
| 1904 序号 1 / 60 / 61 | 原值保留；显示 `1/2/04` / `3/1/04` / `3/2/04` | 对应 `1904-01-02` / `1904-03-01` / `1904-03-02` 的 Date |
| 隐藏行列 / 合并范围 | 元数据保留；合并覆盖格不自动复制主格值 | 元数据保留；访问覆盖格可返回主格值 |

ExcelJS 的早期日期行为与其固定偏移转换源码一致：[4.4.0 日期转换](https://raw.githubusercontent.com/exceljs/exceljs/v4.4.0/lib/utils/utils.js)、[4.4.0 单元格转换](https://raw.githubusercontent.com/exceljs/exceljs/v4.4.0/lib/xlsx/xform/sheet/cell-xform.js)。项目还收到过日期格式配字符串公式结果产生 Invalid Date 的报告；这是报告与源码边界依据，本次未把该具体报告作为已复现缺陷。[上游问题 2966](https://github.com/exceljs/exceljs/issues/2966)

正式实现需把这些边界转为可重复测试，并至少增加：另一套内容与不同表头、公式真缓存零和错误缓存、共享主格缺失、1904/日期序号边界、隐藏数据与合并覆盖格、损坏/加密/伪扩展名、资源超限。事实来源应引用素材摘要、解析版本、工作表和单元格；处理要求、模型输入输出与编辑形成独立版本。最终文章仍须逐项核对来源，并另行验证所属任务的预览、确认、网页正文、附件和目标，不由解析成功推定后续成功。
