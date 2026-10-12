import fs from 'node:fs/promises';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

// 实验的已知输入：用于检验来源关系，不是产品的表格格式。
await fs.mkdir('fixtures', { recursive: true });
for (const [version, count] of [['v1', 3], ['v2', 9]]) {
  const wb = Workbook.create(), sheet = wb.worksheets.add('虚构台账');
  sheet.showGridLines = false;
  sheet.getRange('A1:D5').values = [
    ['样本编号', '数量', '单位', '说明'],
    ['NORTH-001', count, '份', '全部为虚构测试数据'],
    ['SOUTH-002', 7, '份', null],
    ['ZERO-003', 0, '份', '尚未发出'],
    ['合计', null, '份', '数量相加'],
  ];
  sheet.getRange('B5').formulas = [['=SUM(B2:B4)']];
  sheet.getRange('A1:D5').format.font = { name: 'Arial', size: 11 };
  sheet.getRange('A1:D5').format.rowHeight = 27;
  sheet.getRange('A1:D5').format.columnWidth = 20;
  sheet.getRange('D1:D5').format.columnWidth = 31;
  sheet.getRange('A1:D1').format = { fill: '#223B54', font: { name: 'Arial', bold: true, color: '#FFFFFF' } };
  sheet.getRange('B2:B5').setNumberFormat('0');
  wb.recalculate();
  const checks = await wb.inspect({ kind: 'table', range: '虚构台账!A1:D5', include: 'values,formulas', tableMaxRows: 5, tableMaxCols: 4 });
  const errors = await wb.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!', options: { useRegex: true, maxResults: 20 } });
  const preview = await wb.render({ sheetName: sheet.name, range: 'A1:D5', scale: 2 });
  await fs.writeFile(`fixtures/${version}.png`, new Uint8Array(await preview.arrayBuffer()));
  await fs.writeFile(`fixtures/${version}.inspect.json`, JSON.stringify({ checks: checks.ndjson, errors: errors.ndjson }, null, 2));
  await (await SpreadsheetFile.exportXlsx(wb)).save(`fixtures/${version}.xlsx`);
}
