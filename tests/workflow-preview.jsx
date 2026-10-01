// Local-only UI fixture. Requests are intercepted, never sent to Supabase.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApplicationForm, ApplicationDetail } from '../src/workflow.jsx';
import '../src/style.css';

const fixture = { application: { id: 'fixture-app', owner_id: 'owner', title: '迎新活动物资', purpose: '购买活动物资', amount: 19, department: '活动部', category: '物资', use_date: '2026-10-01', status: 'draft', version: 1, recipient: '小林' }, files: [], actions: [], ownerName: '小林', payment: null };
const requestLog = [];
window.fetch = async (_url, options) => {
  const body = options.body instanceof FormData ? Object.fromEntries(options.body.entries()) : JSON.parse(options.body);
  requestLog.push(body.action); document.getElementById('request-log').textContent = requestLog.join(', ');
  let data = null; let error = null;
  if (body.action === 'get_application') data = structuredClone(fixture);
  if (body.action === 'create_application' || body.action === 'update_application') { fixture.application = { ...fixture.application, ...body }; data = fixture.application; }
  if (body.action === 'submit_application') fixture.application.status = 'finance_pending';
  if (body.action === 'remove_file') fixture.files = fixture.files.filter((file) => file.id !== body.file_id);
  if (body.action === 'upload_file') {
    const id = `file-${requestLog.length}`;
    if (body.kind !== 'attachment') fixture.files = fixture.files.filter((file) => !(file.kind === body.kind && file.pending));
    fixture.files.push({ id, name: body.file.name, kind: body.kind, pending: body.kind !== 'attachment', draft_value: body.value, storage_path: id });
    data = { file_id: id, path: id };
  }
  if (body.action === 'save_file_draft') fixture.files.find((file) => file.id === body.file_id).draft_value = body.value;
  if (body.action === 'submit_file_draft') {
    const file = fixture.files.find((item) => item.id === body.file_id);
    if (file.kind === 'receipt' && !body.confirmed) error = { message: '未确认' };
    else { file.pending = false; fixture.application.status = file.kind === 'qr' ? 'payment_pending' : 'paid'; if (file.kind === 'receipt') fixture.payment = { amount: 19, reference: body.value }; }
  }
  return new Response(JSON.stringify({ data, error }), { headers: { 'Content-Type': 'application/json' } });
};

function Preview() {
  const [scenario, setScenario] = useState('new'); const [revision, setRevision] = useState(0);
  const select = (value) => {
    fixture.application.status = value === 'receipt' ? 'payment_pending' : value === 'qr' ? 'payment_info_required' : 'draft';
    fixture.files = value === 'draft' ? [{ id: 'saved-attachment', name: '原附件.pdf', kind: 'attachment', pending: false, storage_path: 'fixture' }] : [];
    fixture.payment = null; requestLog.length = 0; document.getElementById('request-log').textContent = ''; setScenario(value); setRevision((n) => n + 1);
  };
  const identity = { profile: { id: scenario === 'receipt' ? 'admin' : 'owner', department: '活动部' }, roles: scenario === 'receipt' ? ['admin'] : [] };
  return <main className="content"><label>回归场景<select value={scenario} onChange={(e) => select(e.target.value)}><option value="new">新建申请</option><option value="draft">已保存的草稿</option><option value="qr">收款信息</option><option value="receipt">付款登记</option></select></label><p>请求：<span id="request-log" /></p>
    {scenario === 'new' ? <ApplicationForm identity={identity} onDone={() => { setScenario('draft'); setRevision((n) => n + 1); }} onCancel={() => select('new')} /> : <ApplicationDetail key={revision} id="fixture-app" identity={identity} onBack={() => select('new')} onRefresh={() => {}} />}
  </main>;
}
createRoot(document.getElementById('root')).render(<Preview />);
