import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { SaxesParser } from 'saxes';
import { fromBuffer, type Entry } from 'yauzl';
import { utils, SSF, type WorkBook, type CellObject } from 'xlsx';
import {
  EXCEL_PARSER,
  excelDataSchema,
  type ExcelData,
} from '../shared/article';
import { MATERIAL_LIMIT } from '../shared/material';
const formats = SSF as {
  is_date: (format: string) => boolean;
  parse_date_code: (
    value: number,
    options: { date1904: boolean },
  ) => object | null;
};

/** ZIP 交给成熟库；逐项真实解压计数，不能只相信中央目录声明的长度。 */
async function inspectArchive(bytes: Buffer) {
  const worksheets = new Map<string, Map<string, string>>();
  const sheetIds = new Map<string, string>();
  const relations = new Map<string, string>();
  await new Promise<void>((resolve, reject) => {
    fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) return reject(Error('EXCEL_INVALID'));
        let total = 0;
        const names = new Set<string>();
        const fail = (code: string) => {
          zip.close();
          reject(Error(code));
        };
        zip.on('error', () => fail('EXCEL_INVALID'));
        if (zip.entryCount > 1000) return fail('EXCEL_LIMIT');
        zip.on('entry', (entry: Entry) => {
          if (names.has(entry.fileName) || entry.generalPurposeBitFlag & 1)
            return fail('EXCEL_UNSUPPORTED');
          names.add(entry.fileName);
          if (
            /^xl\/(externalLinks|connections|queryTables|vbaProject)/i.test(
              entry.fileName,
            )
          )
            return fail('EXCEL_UNSUPPORTED');
          if (entry.uncompressedSize > 16 * 1024 * 1024)
            return fail('EXCEL_LIMIT');
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) return fail('EXCEL_INVALID');
            const worksheet = /^xl\/worksheets\/[^/]+\.xml$/.test(
              entry.fileName,
            );
            const metadata =
              worksheet ||
              ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels'].includes(
                entry.fileName,
              );
            const parser = metadata ? new SaxesParser() : null;
            const decoder = new StringDecoder('utf8');
            let cell = '';
            const formulas = new Map<string, string>();
            if (worksheet) worksheets.set(entry.fileName, formulas);
            parser?.on('doctype', () => {
              throw Error('EXCEL_UNSUPPORTED');
            });
            parser?.on('opentag', (tag) => {
              const local = tag.name.split(':').at(-1);
              if (entry.fileName === 'xl/workbook.xml' && local === 'sheet')
                sheetIds.set(
                  String(tag.attributes.name),
                  String(tag.attributes['r:id']),
                );
              if (
                entry.fileName === 'xl/_rels/workbook.xml.rels' &&
                local === 'Relationship'
              ) {
                const target = String(tag.attributes.Target);
                relations.set(
                  String(tag.attributes.Id),
                  target.startsWith('/')
                    ? target.slice(1)
                    : path.posix.normalize('xl/' + target),
                );
              }
              if (worksheet && local === 'c')
                cell = String(tag.attributes.r ?? '');
              if (worksheet && local === 'f') {
                if (!/^[A-Z]+[1-9][0-9]*$/.test(cell))
                  throw Error('EXCEL_INVALID');
                formulas.set(cell, '工作簿公式（未重算）');
                const ref = tag.attributes.ref;
                if (ref) {
                  const range = utils.decode_range(String(ref));
                  if (
                    range.e.r >= 2000 ||
                    range.e.c >= 100 ||
                    (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) >
                      2000
                  )
                    throw Error('EXCEL_LIMIT');
                  for (let r = range.s.r; r <= range.e.r; r++)
                    for (let c = range.s.c; c <= range.e.c; c++)
                      formulas.set(
                        utils.encode_cell({ r, c }),
                        '公式区域（未重算）',
                      );
                }
                if (formulas.size > 2000) throw Error('EXCEL_LIMIT');
              }
            });
            stream.on('error', () => fail('EXCEL_INVALID'));
            stream.on('data', (chunk: Buffer) => {
              total += chunk.length;
              if (total > 16 * 1024 * 1024) {
                stream.destroy();
                fail('EXCEL_LIMIT');
              } else
                try {
                  parser?.write(decoder.write(chunk));
                } catch (error) {
                  stream.destroy();
                  fail(
                    error instanceof Error && error.message === 'EXCEL_LIMIT'
                      ? 'EXCEL_LIMIT'
                      : 'EXCEL_INVALID',
                  );
                }
            });
            stream.on('end', () => {
              try {
                parser?.write(decoder.end()).close();
                zip.readEntry();
              } catch {
                fail('EXCEL_INVALID');
              }
            });
          });
        });
        zip.on('end', () => {
          if (
            !names.has('[Content_Types].xml') ||
            !names.has('xl/workbook.xml')
          )
            return fail('EXCEL_UNSUPPORTED');
          resolve();
        });
        zip.readEntry();
      },
    );
  });
  return new Map(
    [...sheetIds].map(([name, id]) => [
      name,
      worksheets.get(relations.get(id) ?? '') ?? new Map<string, string>(),
    ]),
  );
}

/** 解析在有时限和堆上限的工作线程进行；记录拥有者仍可接受停止。 */
async function readWorkbook(bytes: Buffer): Promise<WorkBook> {
  const library = createRequire(
    typeof __filename === 'string' ? __filename : import.meta.url,
  ).resolve('xlsx');
  const worker = new Worker(
    `
    const {parentPort, workerData} = require('node:worker_threads');
    try {
      const XLSX = require(workerData.library);
      const book = XLSX.read(Buffer.from(workerData.bytes), {
        type: 'buffer', cellDates: false, cellFormula: true, cellNF: true,
        cellText: true, cellStyles: true, cellHTML: false, sheetStubs: true, bookVBA: false, nodim: true, xlfn: true, WTF: true
      });
      parentPort.postMessage({ book });
    } catch { parentPort.postMessage({ error: true }); }
  `,
    {
      eval: true,
      workerData: { library, bytes },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 16,
      },
    },
  );
  try {
    return await new Promise<WorkBook>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('EXCEL_LIMIT')), 8000);
      worker.once('message', (result: { book?: WorkBook }) => {
        clearTimeout(timer);
        if (result.book) resolve(result.book);
        else reject(Error('EXCEL_INVALID'));
      });
      worker.once('error', () => {
        clearTimeout(timer);
        reject(Error('EXCEL_INVALID'));
      });
      worker.once('exit', () => {
        clearTimeout(timer);
        reject(Error('EXCEL_INVALID'));
      });
    });
  } finally {
    await worker.terminate();
  }
}

export async function parseExcel(
  bytes: Buffer,
  name: string,
): Promise<ExcelData> {
  if (!/\.xlsx$/i.test(name) || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw Error('EXCEL_UNSUPPORTED');
  if (bytes.length > MATERIAL_LIMIT) throw Error('EXCEL_LIMIT');
  const formulaSheets = await inspectArchive(bytes);
  const book = await readWorkbook(bytes);
  if (book.SheetNames.length > 20) throw Error('EXCEL_LIMIT');
  const date1904 = Boolean(book.Workbook?.WBProps?.date1904);
  const result: ExcelData = {
    parser: EXCEL_PARSER,
    dateSystem: date1904 ? '1904' : '1900',
    recalculated: false,
    sheets: [],
    notices: [
      '公式不重算，所有公式结果均不作为确定事实；缓存可能过期或缺失，不显示为零。',
      '空白不是零；隐藏内容与合并区域的从属格不作为事实。图表、图片、批注及格式布局不参与成文。',
      '日期按工作簿日期系统解释，不附加本机时区；数字保留原值与显示格式。',
    ],
  };
  let count = 0;
  for (const [index, name] of book.SheetNames.entries()) {
    const sheet = book.Sheets[name]!;
    const hidden = Boolean(book.Workbook?.Sheets?.[index]?.Hidden);
    const cells: ExcelData['sheets'][number]['cells'] = [];
    if (sheet['!ref']) {
      const range = utils.decode_range(sheet['!ref']);
      if (
        range.e.r >= 2000 ||
        range.e.c >= 100 ||
        (count += (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1)) >
          2000
      )
        throw Error('EXCEL_LIMIT');
      for (let r = range.s.r; r <= range.e.r; r++)
        for (let c = range.s.c; c <= range.e.c; c++) {
          const address = utils.encode_cell({ r, c });
          const cell = sheet[address] as CellObject | undefined;
          const merge = sheet['!merges']?.find(
            (m) => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c,
          );
          const master = merge ? utils.encode_cell(merge.s) : null;
          const formula =
            cell?.f ?? cell?.F ?? formulaSheets.get(name)?.get(address) ?? null;
          const raw = cell?.t === 'z' ? null : (cell?.v ?? null);
          let status: ExcelData['sheets'][number]['cells'][number]['status'] =
            raw === null || cell?.t === 'z' ? 'blank' : 'value';
          let display = raw === null ? '' : (cell?.w ?? String(raw));
          if (cell?.t === 'e') status = 'error';
          if (cell?.t === 'n' && cell.z && formats.is_date(String(cell.z))) {
            const date = formats.parse_date_code(Number(raw), { date1904 });
            if (!date || (!date1904 && Math.floor(Number(raw)) === 60)) {
              status = 'date-invalid';
              display = '无法确定的 Excel 日期';
            }
          }
          if (formula !== null || cell?.D) {
            status = 'formula-unverified';
            display = '公式结果未核对';
          }
          if (
            hidden ||
            sheet['!rows']?.[r]?.hidden ||
            sheet['!cols']?.[c]?.hidden
          )
            status = 'hidden';
          if (master && master !== address) status = 'merged';
          cells.push({
            address,
            type: cell?.t ?? 'z',
            raw:
              formula !== null || cell?.D
                ? null
                : raw instanceof Date
                  ? raw.toISOString()
                  : raw,
            display,
            format: String(cell?.z ?? ''),
            formula,
            status,
            master,
          });
        }
    }
    result.sheets.push({ name, hidden, cells });
  }
  if (JSON.stringify(result).length > 100000) throw Error('EXCEL_LIMIT');
  return excelDataSchema.parse(result);
}
