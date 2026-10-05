import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hasRole, isSuperAdmin, isEditable, canEditAttachments, canEditPaymentInfo, canRecordPayment, validateFile, validateStep } from '../src/workflow-rules.js';

const owner = { profile: { id: 'owner' }, roles: [] };
const superadmin = { profile: { id: 'admin', username: 'admin' }, roles: ['admin'] };
const admin = { profile: { id: 'ops-admin', username: 'ops-admin' }, roles: ['admin'] };
const financeAdmin = { profile: { id: 'finance-admin', username: 'finance-admin' }, roles: ['admin', 'finance'] };
const outsider = { profile: { id: 'other' }, roles: [] };
const financeMember = { profile: { id: 'fin', username: 'fin' }, roles: ['finance'] };
const app = (status) => ({ owner_id: 'owner', status });

test('保存后的草稿和退回申请可以继续编辑，其他成员不能编辑', () => {
  for (const status of ['draft', 'changes_requested']) { assert.equal(isEditable(app(status), owner), true); assert.equal(isEditable(app(status), outsider), false); }
  assert.equal(isEditable(app('finance_pending'), owner), false);
});
test('已提交但未付的申请附件可修正，已付记录不可静默移除', () => {
  for (const status of ['draft','finance_pending','chair_pending','payment_info_required','payment_pending']) assert.equal(canEditAttachments(app(status), owner), true);
  assert.equal(canEditAttachments(app('paid'), owner), false);
  assert.equal(canEditAttachments(app('draft'), admin), false);
});
test('收款码可在付款前更换；付款登记由财委身份完成，普通管理员不代替流程身份，超级管理员可跨身份操作', () => {
  assert.equal(canEditPaymentInfo(app('payment_pending'), owner), true);
  assert.equal(canEditPaymentInfo(app('paid'), owner), false);
  assert.equal(isSuperAdmin(superadmin), true);
  assert.equal(isSuperAdmin(admin), false);
  assert.equal(canRecordPayment(app('payment_pending'), superadmin), true);
  assert.equal(canRecordPayment(app('paid'), superadmin), true);
  assert.equal(canRecordPayment(app('payment_pending'), admin), false);
  assert.equal(canRecordPayment(app('payment_pending'), financeAdmin), true);
  assert.equal(canRecordPayment(app('payment_pending'), financeMember), true);
  assert.equal(canRecordPayment(app('paid'), financeMember), true);
  assert.equal(canRecordPayment(app('finance_pending'), financeMember), false);
  assert.equal(canRecordPayment(app('payment_pending'), owner), false);
  assert.equal(hasRole(financeMember, 'cashier'), true);
  assert.equal(hasRole(financeMember, 'chair'), false);
  assert.equal(hasRole(superadmin, 'finance'), true);
  assert.equal(hasRole(admin, 'finance'), false);
  assert.equal(hasRole(financeAdmin, 'finance'), true);
  assert.equal(hasRole(admin, 'admin'), true);
});
test('保存付款草稿不要求确认，正式提交必须填写流水号且勾选确认', () => {
  assert.equal(validateStep('receipt', '', true, false, false), '');
  assert.notEqual(validateStep('receipt', '', true, true, true), '');
  assert.notEqual(validateStep('receipt', 'PAY-123', true, false, true), '');
  assert.equal(validateStep('receipt', 'PAY-123', true, true, true), '');
});
test('收款保存与提交分离，提交需要姓名和文件', () => {
  assert.equal(validateStep('qr', '', true, false, false), '');
  assert.notEqual(validateStep('qr', '', true, false, true), '');
  assert.notEqual(validateStep('qr', '小林', false, false, true), '');
  assert.equal(validateStep('qr', '小林', true, false, true), '');
});
test('文件大小和格式在选择时就校验', () => {
  assert.equal(validateFile({ type: 'application/pdf', size: 100 }, 'attachment'), '');
  assert.notEqual(validateFile({ type: 'application/pdf', size: 100 }, 'qr'), '');
  assert.notEqual(validateFile({ type: 'image/jpeg', size: 6 * 1024 * 1024 }), '');
  assert.notEqual(validateFile({ type: 'image/jpeg', size: 0 }), '');
});
test('文件选择处理器只修改本地状态，不上传或提交', async () => {
  const source = await readFile(new URL('../src/workflow.jsx', import.meta.url), 'utf8');
  const selectionHandler = source.slice(source.indexOf('const select = (event)'), source.indexOf('return <div className="file-picker">'));
  assert.ok(selectionHandler.includes('onChange('));
  assert.equal(/apiUpload|request\(|upload\(/.test(selectionHandler), false);
  assert.ok(source.includes('保存草稿'));
  assert.ok(source.includes('正式提交'));
  assert.ok(source.includes('提交付款登记'));
  assert.ok(source.includes('提交收款信息'));
  assert.ok(source.includes('提交处理结果'));
});
test('上传后端只保存，状态推进必须调用独立提交接口', async () => {
  const source = await readFile(new URL('../supabase/functions/app-api/index.ts', import.meta.url), 'utf8');
  const uploadHandler = source.slice(source.indexOf("if (action === 'upload_file')"), source.indexOf("if (action === 'file_url')"));
  assert.ok(uploadHandler.includes('app_save_workflow_file'));
  assert.equal(/app_submit_payment_info|app_record_payment|app_submit_workflow_file/.test(uploadHandler), false);
  assert.ok(source.includes('body.confirmed === true'));
  assert.ok(source.includes(".is('removed_at', null)"));
});

test('后端只把内置 admin 视为超级管理员', async () => {
  const source = await readFile(new URL('../supabase/functions/app-api/index.ts', import.meta.url), 'utf8');
  assert.match(source, /function isSuperAdmin[\s\S]{0,240}actor\.user\.username\.toLowerCase\(\) === 'admin'/);
  assert.match(source, /actor\.roles\.includes\(role\) \|\| \(role !== 'admin' && isSuperAdmin\(actor\)\)/);
  const sql = await readFile(new URL('../supabase/migrations/20261002133000_separate_admin_and_workflow_roles.sql', import.meta.url), 'utf8');
  assert.match(sql, /lower\(u\.username\) = 'admin'/);
  assert.match(sql, /p_role in \('finance', 'chair', 'cashier'\)/);
  assert.doesNotMatch(sql, /role = p_role or role = 'admin'/);
});

test('付款登记视同财委：前端、API 与数据库三处判定一致', async () => {
  const rules = await readFile(new URL('../src/workflow-rules.js', import.meta.url), 'utf8');
  assert.match(rules, /\(role === 'cashier' && identity\?\.roles\?\.includes\('finance'\) === true\)/);
  const source = await readFile(new URL('../supabase/functions/app-api/index.ts', import.meta.url), 'utf8');
  assert.match(source, /\(role === 'cashier' && actor\.roles\.includes\('finance'\)\)/);
  const sql = await readFile(new URL('../supabase/migrations/20261005010000_finance_can_record_payment.sql', import.meta.url), 'utf8');
  assert.match(sql, /p_role = 'cashier'\s*\n\s*and exists\([\s\S]{0,140}role = 'finance'/);
  assert.match(sql, /p_role in \('finance', 'chair', 'cashier'\)\s*\n\s*and private\.app_user_is_superadmin/);
  assert.doesNotMatch(sql, /role = p_role or role = 'admin'/);
});
