import React, { useEffect, useRef, useState } from 'react';
import { apiRequest, apiUpload } from './api.js';
import { STATUS, hasRole, isEditable, canEditAttachments, canEditPaymentInfo, canRecordPayment, validateFile, validateStep } from './workflow-rules.js';

const money = (value) => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateText = (value) => value ? new Date(value).toLocaleDateString('zh-CN') : '—';
const dateTime = (value) => new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const fileLabel = (kind) => ({ attachment: '申请附件', qr: '收款码', receipt: '付款凭证' }[kind]);
function Button({ kind = '', children, ...props }) { return <button className={`button ${kind}`} {...props}>{children}</button>; }
function ErrorText({ error }) { return error ? <div className="error-text" role="alert">{error}</div> : null; }
function Notice({ children }) { return children ? <div className="notice" role="status">{children}</div> : null; }
function StatusBadge({ status }) { return <span className={`status ${status}`}>{STATUS[status]}</span>; }
async function request(action, payload) { const result = await apiRequest(action, payload); if (result.error) throw new Error(result.error.message); return result.data; }
async function upload(fields) { const result = await apiUpload(fields); if (result.error) throw new Error(result.error.message); return result.data; }
function leaveEditor(callback) { if (window.confirm('离开后，未保存的修改不会保留。确定离开吗？')) callback(); }

function FileLink({ file }) {
  const [error, setError] = useState('');
  const open = async () => {
    const target = window.open('', '_blank');
    if (target) target.opener = null;
    try { const data = await request('file_url', { path: file.storage_path }); if (target) target.location.href = data.signedUrl; else window.location.assign(data.signedUrl); }
    catch (err) { target?.close(); setError(err.message); }
  };
  return <><button type="button" className="file-row" onClick={open}><span>{file.name}</span><small>{fileLabel(file.kind)}{file.pending ? ' · 已保存未提交' : ''}</small></button><ErrorText error={error} /></>;
}

function SelectedPreview({ file }) {
  const [url, setUrl] = useState('');
  useEffect(() => { if (!file.type.startsWith('image/')) return; const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next); }, [file]);
  return url ? <img className="selected-preview" src={url} alt={`预览 ${file.name}`} /> : null;
}

function FilePicker({ files, onChange, existing = [], removed = [], onRemove, kind = 'attachment', busy = false }) {
  const [error, setError] = useState('');
  const select = (event) => {
    const selected = [...event.target.files]; event.target.value = '';
    const invalid = selected.map((file) => validateFile(file, kind)).find(Boolean);
    if (invalid) { setError(invalid); return; }
    setError(''); onChange(kind === 'attachment' ? [...files, ...selected] : selected.slice(0, 1));
  };
  return <div className="file-picker">
    {existing.map((file) => <div className={`editable-file ${removed.includes(file.id) ? 'is-removed' : ''}`} key={file.id}>
      <FileLink file={file} />
      {onRemove && <button type="button" className="file-remove" disabled={busy} aria-label={`${removed.includes(file.id) ? '恢复' : '移除'} ${file.name}`} onClick={() => onRemove(file.id)}>{removed.includes(file.id) ? '恢复' : '×'}</button>}
    </div>)}
    {files.map((file, index) => <div className="selected-file" key={`${file.name}-${file.lastModified}-${index}`}><div className="selected-file-heading"><span>{file.name}<small>待保存 · {(file.size / 1024).toFixed(0)} KB</small></span><button type="button" className="file-remove" disabled={busy} aria-label={`移除 ${file.name}`} onClick={() => onChange(files.filter((_, i) => i !== index))}>×</button></div><SelectedPreview file={file} /></div>)}
    <label className="upload-box">{kind === 'attachment' ? '选择附件' : kind === 'qr' ? '选择收款码' : '选择付款凭证'}<input disabled={busy} type="file" multiple={kind === 'attachment'} accept={kind === 'qr' ? 'image/png,image/jpeg' : 'image/png,image/jpeg,application/pdf'} onChange={select} /></label>
    <p className="hint">每个文件不超过 5 MB。选择文件后，点击保存或提交才会上传。</p>
    <ErrorText error={error} />
  </div>;
}

export function ApplicationForm({ identity, onDone, onCancel, initial = null, initialFiles = [] }) {
  const [form, setForm] = useState(initial || { title: '', purpose: '', amount: '', category: '', department: identity.profile.department || '', use_date: '' });
  const [savedId, setSavedId] = useState(initial?.id || null);
  const [existing, setExisting] = useState(initialFiles.filter((file) => file.kind === 'attachment'));
  const [files, setFiles] = useState([]); const [removed, setRemoved] = useState([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const lock = useRef(false);
  const toggleRemoved = (id) => setRemoved((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const save = async (event) => {
    event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError('');
    const formallySubmit = event.nativeEvent.submitter?.value === 'submit';
    let id = savedId;
    try {
      const amount = Number(form.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) throw new Error('请输入有效金额。');
      const data = await request(id ? 'update_application' : 'create_application', { id, title: form.title.trim(), purpose: form.purpose.trim(), amount, category: form.category.trim(), department: form.department.trim(), use_date: form.use_date });
      id = data.id; setSavedId(id);
      for (const fileId of removed) { await request('remove_file', { application_id: id, file_id: fileId }); setExisting((current) => current.filter((file) => file.id !== fileId)); setRemoved((current) => current.filter((item) => item !== fileId)); }
      for (const file of files) {
        const saved = await upload({ application_id: id, kind: 'attachment', file });
        setExisting((current) => [...current, { id: saved.file_id, name: file.name, kind: 'attachment', storage_path: saved.path }]);
        setFiles((current) => current.filter((item) => item !== file));
      }
      if (formallySubmit) await request('submit_application', { application_id: id });
      onDone(id);
    } catch (err) { setError(`${err.message}${id ? ' 已保存的内容会保留，可继续修改后重试。' : ''}`); }
    finally { lock.current = false; setBusy(false); }
  };
  const field = (key) => ({ value: form[key], onChange: (event) => setForm({ ...form, [key]: event.target.value }) });
  return <><button className="back-button" disabled={busy} onClick={() => leaveEditor(onCancel)}>‹ 返回</button><h1>{initial ? '编辑申请' : '新建申请'}</h1>
    <section className="panel form-panel"><form onSubmit={save} className="stack-form"><fieldset disabled={busy}>
      <label>申请标题<input required maxLength="120" {...field('title')} placeholder="例如：迎新活动物资" /></label>
      <div className="form-grid"><label>申请金额（元）<input required min="0.01" max="10000000" step="0.01" type="number" {...field('amount')} /></label><label>使用日期<input required type="date" {...field('use_date')} /></label><label>费用类别<input required maxLength="80" {...field('category')} placeholder="例如：活动物资" /></label><label>部门 / 活动<input required maxLength="80" {...field('department')} /></label></div>
      <label>用途说明<textarea required rows="5" maxLength="5000" {...field('purpose')} placeholder="需要购买什么，用于哪项活动？" /></label>
      <h3>附件</h3><FilePicker files={files} onChange={setFiles} existing={existing} removed={removed} onRemove={toggleRemoved} busy={busy} />
      <ErrorText error={error} /><div className="form-actions"><Button kind="quiet" type="button" onClick={() => leaveEditor(onCancel)}>取消</Button><Button kind="secondary" type="submit" value="draft">{busy ? '保存中…' : '保存草稿'}</Button><Button type="submit" value="submit">{busy ? '处理中…' : '正式提交'}</Button></div>
    </fieldset></form></section></>;
}

function AttachmentEditor({ application, initialFiles, onSaved }) {
  const [files, setFiles] = useState([]); const [removed, setRemoved] = useState([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const lock = useRef(false);
  const save = async (event) => {
    event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try {
      for (const fileId of removed) { await request('remove_file', { application_id: application.id, file_id: fileId }); setRemoved((current) => current.filter((id) => id !== fileId)); }
      for (const file of files) { await upload({ application_id: application.id, kind: 'attachment', file }); setFiles((current) => current.filter((item) => item !== file)); }
      await onSaved('附件已保存。');
    } catch (err) { setError(err.message); await onSaved(''); }
    finally { lock.current = false; setBusy(false); }
  };
  return <form onSubmit={save}><FilePicker files={files} onChange={setFiles} existing={initialFiles} removed={removed} onRemove={(id) => setRemoved((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} busy={busy} /><ErrorText error={error} /><div className="form-actions"><Button kind="secondary" disabled={busy || (!files.length && !removed.length)}>{busy ? '保存中…' : '保存附件'}</Button></div></form>;
}

function StepEditor({ application, kind, draft: initialDraft, committedFiles = [], payment, onSaved }) {
  const [value, setValue] = useState(initialDraft?.draft_value || (kind === 'qr' ? application.recipient : payment?.reference) || '');
  const [draft, setDraft] = useState(initialDraft || null); const [files, setFiles] = useState([]); const [removed, setRemoved] = useState([]);
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const lock = useRef(false);
  useEffect(() => { setDraft(initialDraft || null); }, [initialDraft?.id]);
  const save = async (event) => {
    event.preventDefault(); if (lock.current) return;
    const submit = event.nativeEvent.submitter?.value === 'submit';
    const validation = validateStep(kind, value, Boolean(files.length || (draft && !removed.includes(draft.id))), confirmed, submit);
    if (validation && !(removed.length && !submit && !files.length)) { setError(validation); return; }
    lock.current = true; setBusy(true); setError('');
    try {
      let saved = draft;
      for (const fileId of removed) { await request('remove_file', { application_id: application.id, file_id: fileId }); if (saved?.id === fileId) { saved = null; setDraft(null); } setRemoved((current) => current.filter((id) => id !== fileId)); }
      if (files[0]) {
        const file = files[0]; const result = await upload({ application_id: application.id, kind, value, file });
        saved = { id: result.file_id, storage_path: result.path, kind, pending: true, name: file.name, draft_value: value }; setDraft(saved); setFiles([]);
      } else if (saved) await request('save_file_draft', { application_id: application.id, file_id: saved.id, value });
      if (submit) { await request('submit_file_draft', { application_id: application.id, file_id: saved.id, value, confirmed }); setDraft(null); setRemoved([]); setConfirmed(false); }
      await onSaved(submit ? kind === 'qr' ? '收款信息已提交。' : application.status === 'paid' ? '付款凭证已更新。' : '付款已登记。' : saved ? '已保存，尚未提交。' : '草稿文件已移除。');
    } catch (err) { setError(err.message); await onSaved(''); }
    finally { lock.current = false; setBusy(false); }
  };
  const heading = kind === 'qr' ? '收款信息' : application.status === 'paid' ? '更正付款凭证' : '登记付款';
  return <div className="action-block"><h2>{heading}</h2><form onSubmit={save}><fieldset disabled={busy}>
    {kind === 'receipt' && <p className="muted">收款人：{application.recipient} · {application.status === 'paid' ? '已付' : '应付'} {money(application.amount)}</p>}
    <label>{kind === 'qr' ? '收款人姓名' : '支付宝流水号'}<input maxLength={kind === 'qr' ? 80 : 120} value={value} onChange={(event) => setValue(event.target.value)} /></label>
    <FilePicker files={files} onChange={setFiles} existing={[...committedFiles, ...(draft ? [draft] : [])]} removed={removed} onRemove={kind === 'qr' ? (id) => setRemoved((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]) : draft ? (id) => { if (id === draft.id) setRemoved((current) => current.includes(id) ? [] : [id]); } : undefined} kind={kind} busy={busy} />
    {kind === 'receipt' && <label className="check-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />已核对收款人及金额，并完成转账</label>}
    <ErrorText error={error} /><div className="form-actions"><Button kind="secondary" type="submit" value="draft">{busy ? '保存中…' : '保存草稿'}</Button><Button type="submit" value="submit">{busy ? '处理中…' : kind === 'qr' ? '提交收款信息' : application.status === 'paid' ? '提交更正' : '提交付款登记'}</Button></div>
  </fieldset></form></div>;
}

function ReviewEditor({ id, onSaved }) {
  const [decision, setDecision] = useState('approve_application'); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const lock = useRef(false);
  const submit = async (event) => { event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { await request(decision, { application_id: id, note: note.trim() }); setNote(''); await onSaved('处理结果已提交。'); } catch (err) { setError(err.message); } finally { lock.current = false; setBusy(false); } };
  return <div className="action-block"><h2>处理申请</h2><form onSubmit={submit}><fieldset disabled={busy}><label>处理结果<select value={decision} onChange={(event) => setDecision(event.target.value)}><option value="approve_application">通过</option><option value="return_application">退回修改</option><option value="reject_application">拒绝</option></select></label><label>意见<textarea required rows="3" maxLength="2000" value={note} onChange={(event) => setNote(event.target.value)} /></label><ErrorText error={error} /><div className="form-actions"><Button disabled={!note.trim()}>{busy ? '提交中…' : '提交处理结果'}</Button></div></fieldset></form></div>;
}

export function ApplicationDetail({ id, identity, onBack, onRefresh }) {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [editing, setEditing] = useState(false); const [busy, setBusy] = useState(false);
  const load = async () => { const next = await request('get_application', { id }); setData(next); return next; };
  useEffect(() => { let mounted = true; setLoading(true); setData(null); request('get_application', { id }).then((next) => { if (mounted) setData(next); }).catch((err) => { if (mounted) setError(err.message); }).finally(() => { if (mounted) setLoading(false); }); return () => { mounted = false; }; }, [id]);
  const onSaved = async (message) => { await load(); setNotice(message); onRefresh(); };
  const perform = async (action) => { if (busy) return; setBusy(true); setError(''); try { await request(action, { application_id: id }); await onSaved(action === 'submit_application' ? '申请已正式提交。' : '申请已撤回。'); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  if (loading) return <div className="panel-empty">加载中…</div>;
  if (!data) return <div className="panel-empty"><ErrorText error={error || '申请不存在。'} /><Button onClick={onBack}>返回</Button></div>;
  const { application, files, actions, payment, ownerName } = data;
  const own = application.owner_id === identity.profile.id;
  const editable = isEditable(application, identity);
  const canReview = !own && ((hasRole(identity, 'finance') && application.status === 'finance_pending') || (hasRole(identity, 'chair') && application.status === 'chair_pending'));
  if (editing) return <ApplicationForm key={application.id} identity={identity} initial={application} initialFiles={files} onCancel={() => setEditing(false)} onDone={async () => { setEditing(false); await onSaved('申请已保存。'); }} />;
  const attachments = files.filter((file) => file.kind === 'attachment');
  const committed = files.filter((file) => file.kind !== 'attachment' && !file.pending);
  return <><button className="back-button" onClick={onBack}>‹ 返回申请列表</button><div className="heading-row detail-heading"><div><p className="eyebrow">申请 #{id.slice(0, 8)}</p><h1>{application.title}</h1><StatusBadge status={application.status} /></div><div className="detail-actions">
    {editable && <><Button kind="secondary" disabled={busy} onClick={() => setEditing(true)}>编辑申请</Button><Button disabled={busy} onClick={() => perform('submit_application')}>{busy ? '提交中…' : '正式提交'}</Button></>}
    {own && ['draft', 'changes_requested', 'finance_pending', 'chair_pending'].includes(application.status) && <Button kind="quiet danger" disabled={busy} onClick={() => { if (window.confirm('确定撤回这笔申请吗？')) perform('cancel_application'); }}>撤回</Button>}
  </div></div><Notice>{notice}</Notice><ErrorText error={error} /><div className="detail-grid"><section className="panel detail-panel"><div className="amount-label">申请金额</div><div className="hero-amount">{money(application.amount)}</div><dl><dt>申请人</dt><dd>{ownerName}</dd><dt>部门 / 活动</dt><dd>{application.department}</dd><dt>费用类别</dt><dd>{application.category}</dd><dt>使用日期</dt><dd>{dateText(application.use_date)}</dd></dl><h3>用途说明</h3><p className="prose">{application.purpose}</p><h3>申请附件</h3>
    {canEditAttachments(application, identity) && !editable ? <AttachmentEditor application={application} initialFiles={attachments} onSaved={onSaved} /> : <>{attachments.length ? attachments.map((file) => <FileLink key={file.id} file={file} />) : <p className="muted">暂无附件</p>}{editable && <Button kind="secondary" onClick={() => setEditing(true)}>编辑附件</Button>}</>}
    {committed.length > 0 && <><h3>收款与付款文件</h3>{committed.map((file) => <FileLink key={file.id} file={file} />)}</>}
    {canEditPaymentInfo(application, identity) && <StepEditor key={`${id}-qr-${application.status}`} application={application} kind="qr" draft={files.find((file) => file.kind === 'qr' && file.pending)} committedFiles={committed.filter((file) => file.kind === 'qr')} payment={payment} onSaved={onSaved} />}
    {canRecordPayment(application, identity) && <StepEditor key={`${id}-receipt-${application.status}`} application={application} kind="receipt" draft={files.find((file) => file.kind === 'receipt' && file.pending)} payment={payment} onSaved={onSaved} />}
    {canReview && <ReviewEditor key={`${id}-${application.status}`} id={id} onSaved={onSaved} />}
    {payment && <div className="payment-record"><h3>付款记录</h3><p>{money(payment.amount)} · {payment.reference}</p></div>}
  </section><aside className="panel timeline"><h2>进展</h2>{actions.length ? <ol>{actions.map((action) => <li key={action.id}><strong>{action.action}</strong><p>{action.note || '—'}</p><time>{dateTime(action.created_at)}</time></li>)}</ol> : <p className="muted">草稿已保存</p>}</aside></div></>;
}
