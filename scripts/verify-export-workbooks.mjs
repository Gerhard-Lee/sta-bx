import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';
const root = process.env.PROJECT_ROOT;
const { fillExportTemplate } = await import(`${root}/src/reporting.js`);
const fixtures = {
  financial: { rows: [
    { created_at: '2026-10-01T04:12:13Z', amount: 19.01, reference: '00123', applicant: '小明', applications: { title: '活动物资', category: '报销', status: 'paid' } },
    { created_at: '2026-10-01T04:23:14Z', amount: 10.02, reference: '00124', applicant: '小红', applications: { title: '打印资料', category: '报销', status: 'paid' } },
  ] },
  audit: { rows: [{ id: '123', created_at: '2026-10-01T04:12:13Z', username: 'admin', ip_address: '203.0.113.10', event: '修改申请', detail: '申请「活动物资」 · ¥29 · 编号 00000000-0000-0000-0000-000000000001', metadata: { changes: { amount: { 原值: 19, 新值: 29 } } } }] },
};
for (const kind of ['financial','audit']) {
  const data = { ...fixtures[kind], start: '2026-10-01', end: '2026-10-01', generated_at: '2026-10-01T04:30:01Z' };
  const source = new Uint8Array(await fs.readFile(`${root}/public/export-templates/${kind}.xlsx`));
  const file = `${process.cwd()}/${kind}-filled.xlsx`;
  await fs.writeFile(file, fillExportTemplate(source,kind,data,'100'));
  const wb = await SpreadsheetFile.importXlsx(await FileBlob.load(file));
  wb.recalculate();
  const sheet = kind === 'financial' ? '财报' : '操作日志';
  console.log((await wb.inspect({ kind: 'region', sheetId: sheet, range: kind === 'financial' ? 'A5:L8' : 'A5:F6', maxChars: 2500, tableMaxRows: 5, tableMaxCols: 12 })).ndjson);
  console.log((await wb.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!', options: { useRegex: true, maxResults: 20 }, maxChars: 1000 })).ndjson);
  const png = await wb.render({ sheetName: sheet, range: kind === 'financial' ? 'A1:L9' : 'A1:F7', scale: 1, format: 'png' });
  await fs.writeFile(`${process.cwd()}/${kind}-filled.png`, new Uint8Array(await png.arrayBuffer()));
  if(kind==='financial') {
    const values = wb.worksheets.getItem(sheet).getRange('G8').values;
    if (Math.abs(Number(values[0][0])-70.97)>0.005) throw new Error('Balance recalculation failed');
    wb.worksheets.getItem(sheet).getRange('F8').values=[[20.02]];
    wb.recalculate();
    if (Math.abs(Number(wb.worksheets.getItem(sheet).getRange('G8').values[0][0])-60.97)>0.005) throw new Error('Formula does not update');
    console.log('Balance and summary formulas recalculate correctly');
  }
}
