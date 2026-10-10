import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

// 实验输入，不属于 helpr 的任务执行能力。
const dir = fileURLToPath(new URL('./', import.meta.url));
for (const [index, name] of ['learn', 'replay', 'repair', 'updated'].entries()) {
  const wb = Workbook.create(), sheet = wb.worksheets.add('虚构测试数据');
  sheet.showGridLines = false;
  sheet.getRange('A1:C3').values = [
    ['样本编号', '数量', '批次'],
    [`TEST-${index + 1}-001`, 3 + index * 10, name],
    [`TEST-${index + 1}-002`, 7 + index * 10, name]
  ];
  sheet.getRange('A1:C3').format.font = { name: 'Arial', size: 11 };
  sheet.getRange('A1:C1').format = { fill: '#1E3A5F', font: { name: 'Arial', bold: true, color: '#FFFFFF' } };
  sheet.getRange('A1:C3').format.columnWidth = 22;
  sheet.getRange('A1:C3').format.rowHeight = 26;
  sheet.getRange('B2:B3').setNumberFormat('0');
  wb.recalculate();
  const errors = await wb.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!', options: { useRegex: true, maxResults: 20 } });
  const preview = await wb.render({ sheetName: sheet.name, range: 'A1:C3', scale: 2 });
  await fs.writeFile(dir + name + '.png', new Uint8Array(await preview.arrayBuffer()));
  await (await SpreadsheetFile.exportXlsx(wb)).save(dir + name + '.xlsx');
  console.log(JSON.stringify({ name, values: sheet.getRange('A1:C3').values, errors: errors.ndjson }));
}
