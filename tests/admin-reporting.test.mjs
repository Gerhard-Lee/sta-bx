import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROLE_LABEL, formatDateTime, auditDetail, auditFilterSummary, financialRows, fillExportTemplate, unpackTemplate } from '../src/reporting.js';

const data = { start: '2026-10-01', end: '2026-10-01', generated_at: '2026-10-01T04:00:01Z', rows: [
  { created_at: '2026-09-30T16:00:01Z', amount: 19.01, reference: '00123', applicant: '小明', applications: { title: '=错误 <& 标题', category: '报销', status: 'paid' } },
  { created_at: '2026-10-01T04:00:01Z', amount: 10.02, reference: '00124', applicant: '小红', applications: { title: '活动', category: '报销', status: 'paid' } },
  { created_at: '2026-10-01T04:00:02Z', amount: 100, reference: 'exclude', applications: { status: 'draft' } },
] };
const template = (kind) => new Uint8Array(readFileSync(`public/export-templates/${kind}.xlsx`));
test('用户分类不再包含财务，保留财委、主席、管理员', () => { assert.deepEqual(Object.keys(ROLE_LABEL), ['finance', 'chair', 'admin']); });
test('日志统一显示北京时间且精确到秒', () => { assert.equal(formatDateTime('2026-10-01T04:00:01Z'), '2026-10-01 12:00:01'); });
test('日志描述包含修改前后的具体字段', () => { assert.match(auditDetail({ detail: '申请活动', metadata: { changes: { amount: { 原值: 19, 新值: 29 } } } }), /金额：19 → 29/); });
test('财报只计已付款，缺少期初余额时不虚构余额', () => { const r = financialRows(data); assert.equal(r.rows.length, 2); assert.equal(r.closing, null); assert.equal(r.rows[0].values[4], null); assert.equal(r.rows[0].values[6], null); });
test('金额按分计算，零期初余额不是缺失', () => { const r = financialRows(data, '0'); assert.equal(r.rows.length, 3); assert.equal(r.closing, -29.03); assert.equal(financialRows(data, '100').closing, 70.97); });
test('财报导出保留样表字段、公式和汇总，不执行用户文字公式', () => {
  const files = unpackTemplate(fillExportTemplate(template('financial'), 'financial', data, '100'));
  const sheet = new TextDecoder().decode(files.get('xl/worksheets/sheet1.xml'));
  for (const header of ['日期','备注','收支类型','资金类型','收入金额','支出金额','期末余额']) assert.ok(sheet.includes(header));
  assert.ok(sheet.includes('<f>G6+E7-F7</f>')); assert.ok(sheet.includes('<v>70.97</v>')); assert.ok(sheet.includes('SUM(F6:F8)'));
  assert.ok(sheet.includes('=错误 &lt;&amp; 标题')); assert.ok(!sheet.includes('<f>错误')); assert.ok(!sheet.includes('__PERIOD__')); assert.ok(!sheet.includes('__SCOPE__'));
});
test('没有付款记录的财报仍可导出且无伪造收入或余额', () => {
  const sheet = new TextDecoder().decode(unpackTemplate(fillExportTemplate(template('financial'), 'financial', { ...data, rows: [] })).get('xl/worksheets/sheet1.xml'));
  assert.ok(sheet.includes('收入和余额留空')); assert.ok(!sheet.includes('<v>NaN</v>')); assert.ok(sheet.includes('<f>0</f><v>0</v>'));
});
test('日志导出包含完整 IP、用户名、秒级时间、具体内容及编号', () => {
  const logs = { ...data, rows: [{ id: '9007199254740993', created_at: '2026-10-01T04:00:01Z', username: 'admin', ip_address: '2001:db8::1', event: '修改设置', detail: '关闭注册 <&>' }] };
  const sheet = new TextDecoder().decode(unpackTemplate(fillExportTemplate(template('audit'), 'audit', logs)).get('xl/worksheets/sheet1.xml'));
  for (const text of ['admin','2001:db8::1','关闭注册 &lt;&amp;&gt;','9007199254740993']) assert.ok(sheet.includes(text));
  assert.ok(sheet.includes('2026-10-01 12:00:01'));
});
test('注册开关、添加用户和导出端点均在后端检查管理员权限', () => {
  const source = readFileSync('supabase/functions/app-api/index.ts','utf8');
  for (const action of ['update_registration', 'admin_create_user']) assert.match(source, new RegExp(`action === '${action}'[\\s\\S]{0,50}requireRole\\(actor, 'admin'\\)`));
  assert.match(source, /action === 'export_financial' \|\| action === 'export_audit'[\s\S]{0,60}requireRole\(actor, 'admin'\)/);
  assert.ok(!source.includes('p_password: body.password')); // Only typed validated payloads enter account RPCs.
});
test('导出的操作日志标注实际使用的筛选条件，与界面显示一致', () => {
  const filters = { username: 'admin', event: '登录', ip: '127.0.0.1', start: '2026-10-01', end: '2026-10-31' };
  assert.equal(auditFilterSummary(filters), '用户名 含「admin」 · 操作 含「登录」 · IP 含「127.0.0.1」 · 2026-10-01 至 2026-10-31');
  assert.equal(auditFilterSummary({}), '');
  assert.equal(auditFilterSummary({ start: '', end: '2026-10-31' }), '最早 至 2026-10-31');
  const sheet = new TextDecoder().decode(unpackTemplate(fillExportTemplate(template('audit'), 'audit', { ...data, filters })).get('xl/worksheets/sheet1.xml'));
  for (const text of ['admin','登录','127.0.0.1','2026-10-01 至 2026-10-31']) assert.ok(sheet.includes(text));
  // The date range must come from the filter object and be stated exactly once.
  assert.ok(sheet.includes('2026-10-01 至 2026-10-31 · 用户名 含「admin」'));
  assert.equal(sheet.split('2026-10-01 至 2026-10-31').length - 1, 1);
  assert.ok(!sheet.includes('2026-10-01 至 2026-10-01'));
});
test('未使用筛选条件时导出不虚构条件', () => {
  const sheet = new TextDecoder().decode(unpackTemplate(fillExportTemplate(template('audit'), 'audit', { ...data, start: '', end: '', filters: {} })).get('xl/worksheets/sheet1.xml'));
  assert.ok(sheet.includes('全部日期 至 现在'));
  assert.ok(!sheet.includes('含「'));
  // A date range limit is still reported once when only that range is active.
  const ranged = new TextDecoder().decode(unpackTemplate(fillExportTemplate(template('audit'), 'audit', { ...data, filters: { start: '2026-10-01', end: '2026-10-31' } })).get('xl/worksheets/sheet1.xml'));
  assert.ok(ranged.includes('2026-10-01 至 2026-10-31 · 导出时间'));
});
