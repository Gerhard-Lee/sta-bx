import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const root = process.env.PROJECT_ROOT;
if (!root) throw new Error('PROJECT_ROOT is required');
const out = `${root}/public/export-templates`;
await fs.mkdir(out, { recursive: true });
if (process.argv.includes('--inspect-reference')) {
  const reference = await SpreadsheetFile.importXlsx(await FileBlob.load(`${root}/upload/财报.xlsx`));
  console.log((await reference.inspect({ kind: 'region', sheetId: 'Sheet1', range: 'A1:L6', maxChars: 2000, tableMaxRows: 6, tableMaxCols: 12 })).ndjson);
  const png = await reference.render({ sheetName: 'Sheet1', range: 'A1:L10', scale: 1, format: 'png' });
  await fs.writeFile(`${process.cwd()}/reference.png`, new Uint8Array(await png.arrayBuffer()));
  process.exit(0);
}

for (const kind of ['financial', 'audit']) {
  const wb = Workbook.create();
  const sheet = wb.worksheets.add(kind === 'financial' ? '财报' : '操作日志');
  const end = kind === 'financial' ? 'L' : 'F';
  sheet.showGridLines = false;
  sheet.getRange(`A1:${end}9`).format.font = { name: 'Arial', size: 11, color: '#243047' };
  sheet.getRange(`A1:${end}9`).format.verticalAlignment = 'center';
  sheet.getRange(`A1:${end}1`).merge();
  sheet.getRange('A1').values = [[`成都七中科学技术协会 ${kind === 'financial' ? '财报' : '操作日志'}`]];
  sheet.getRange('A1').format.font = { name: 'Arial', size: 16, bold: true };
  sheet.getRange('A1').format.rowHeight = 34;
  sheet.getRange(`A2:${end}2`).merge(); sheet.getRange('A2').values = [['__PERIOD__']];
  sheet.getRange(`A3:${end}3`).merge(); sheet.getRange('A3').values = [['__SCOPE__']];
  sheet.getRange(`A2:${end}3`).format.font = { name: 'Arial', size: 10, color: '#637189' };
  sheet.getRange(`A2:${end}3`).format.rowHeight = 24;
  const headers = kind === 'financial'
    ? ['日期', '备注', '收支类型', '资金类型', '收入金额', '支出金额', '期末余额']
    : ['时间（北京时间）', '用户名', 'IP 地址', '操作', '具体内容', '记录编号'];
  const dataEnd = kind === 'financial' ? 'G' : 'F';
  sheet.getRange(`A5:${dataEnd}5`).values = [headers];
  sheet.getRange(`A5:${dataEnd}5`).format = { fill: '#eef2f7', font: { name: 'Arial', size: 11, bold: true }, horizontalAlignment: 'center', verticalAlignment: 'center', rowHeight: 28 };
  sheet.getRange(`A6:${dataEnd}6`).values = [headers.map(() => '')];
  sheet.getRange(`A6:${dataEnd}6`).format.rowHeight = 34;
  sheet.getRange(kind === 'financial' ? 'B6' : 'E6').format.wrapText = true;
  const widths = kind === 'financial' ? [22, 58, 20, 16, 17, 17, 17, 3, 17, 18, 18, 18] : [24, 22, 42, 25, 110, 18];
  widths.forEach((width, i) => { sheet.getRangeByIndexes(0, i, 9, 1).format.columnWidth = width; });
  if (kind === 'financial') {
    sheet.getRange('A6').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange('E6:G6').setNumberFormat('#,##0.00');
    sheet.getRange('E6:G6').format.horizontalAlignment = 'right';
    sheet.getRange('I5:L5').values = [['资金类型', '收入金额', '支出金额', '结余']];
    sheet.getRange('I5:L5').format = { fill: '#eef2f7', font: { name: 'Arial', size: 11, bold: true }, horizontalAlignment: 'center', rowHeight: 28 };
    sheet.getRange('I6:I7').values = [['支付宝'], ['总计']];
    sheet.getRange('J6:L7').values = [[null, null, null], [null, null, null]];
    sheet.getRange('J6:L7').setNumberFormat('#,##0.00');
    sheet.getRange('I7:L7').format.font = { name: 'Arial', size: 11, bold: true };
  } else {
    sheet.getRange('A6').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange('F6').setNumberFormat('@');
  }
  sheet.freezePanes.freezeRows(5);
  wb.recalculate();
  console.log((await wb.inspect({ kind: 'region', sheetId: sheet.name, range: `A1:${end}7`, maxChars: 1800, tableMaxRows: 7, tableMaxCols: 12 })).ndjson);
  const preview = await wb.render({ sheetName: sheet.name, range: `A1:${end}8`, scale: 1, format: 'png' });
  await fs.writeFile(`${process.cwd()}/${kind}.png`, new Uint8Array(await preview.arrayBuffer()));
  await (await SpreadsheetFile.exportXlsx(wb)).save(`${out}/${kind}.xlsx`);
}
