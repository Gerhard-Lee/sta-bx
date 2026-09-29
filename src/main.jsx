import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const apiUrl = supabaseUrl ? `${supabaseUrl}/functions/v1/app-api` : '';
const SESSION_KEY = 'yuxing_app_session';

const STATUS = {
  draft: '草稿', finance_pending: '待财委审批', chair_pending: '待主席审批',
  changes_requested: '退回修改', rejected: '已拒绝', payment_info_required: '待补充收款码',
  payment_pending: '待付款', paid: '已付款', cancelled: '已撤回'
};
const ROLE_LABEL = { finance: '财委', chair: '主席', cashier: '财务', admin: '管理员' };

const money = (value) => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateText = (value) => value ? new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' }) : '—';
const dateTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const fileLabel = (kind) => ({ attachment: '申请附件', qr: '收款码', receipt: '付款凭证' }[kind] || '文件');
const roleNames = (roles = []) => roles.map((role) => ROLE_LABEL[role] || role).join('、');

function ErrorText({ error }) { return error ? <div className="error-text" role="alert">{error}</div> : null; }
function StatusBadge({ status }) { return <span className={`status ${status}`}>{STATUS[status] || status}</span>; }
function Button({ children, kind = '', ...props }) { return <button className={`button ${kind}`} {...props}>{children}</button>; }
function Spinner() { return <span className="spinner" aria-label="加载中" />; }

async function apiRequest(action, payload = {}) {
  if (!apiUrl || !supabaseKey) return { data: null, error: { message: '站点尚未配置数据服务。' } };
  const headers = { apikey: supabaseKey, 'Content-Type': 'application/json' };
  const token = localStorage.getItem(SESSION_KEY);
  if (token) headers['x-app-session'] = token;
  try {
    const response = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify({ action, ...payload }) });
    const result = await response.json().catch(() => ({ data: null, error: { message: '服务返回了无法识别的结果。' } }));
    return result?.error ? result : { data: result?.data ?? result, error: null };
  } catch (error) { return { data: null, error: { message: error.message || '网络连接失败。' } }; }
}

async function apiUpload(fields) {
  if (!apiUrl || !supabaseKey) return { data: null, error: { message: '站点尚未配置数据服务。' } };
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => { if (value !== undefined && value !== null) form.append(key, value); });
  form.set('action', 'upload_file');
  const headers = { apikey: supabaseKey };
  const token = localStorage.getItem(SESSION_KEY);
  if (token) headers['x-app-session'] = token;
  try {
    const response = await fetch(apiUrl, { method: 'POST', headers, body: form });
    const result = await response.json().catch(() => ({ data: null, error: { message: '服务返回了无法识别的结果。' } }));
    return result?.error ? result : { data: result?.data ?? result, error: null };
  } catch (error) { return { data: null, error: { message: error.message || '网络连接失败。' } }; }
}

function AuthScreen() {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ username: '', password: '', name: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiRequest(mode === 'login' ? 'login' : 'register', { username: form.username.trim(), password: form.password, full_name: form.name.trim() });
      if (result.error) throw new Error(result.error.message);
      localStorage.setItem(SESSION_KEY, result.data.session.token);
      setNotice(mode === 'login' ? '登录成功，正在进入…' : '账号已创建，正在进入…');
      window.location.reload();
    } catch (err) { setError(err.message || '登录没有完成。'); }
    finally { setBusy(false); }
  };
  return <main className="auth-page">
    <section className="auth-card">
      <div className="logo-mark">予</div><div className="brand-name">予行 <span>资金申请</span></div>
      <h1>{mode === 'login' ? '欢迎回来' : '创建账号'}</h1>
      <p className="auth-lead">{mode === 'login' ? '登录后查看申请进展。' : '注册后即可提交第一笔申请。'}</p>
      <div className="tabs"><button className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>登录</button><button className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setError(''); }}>注册</button></div>
      <form onSubmit={submit} className="stack-form">
        {mode === 'signup' && <label>姓名<input required maxLength="80" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="你的姓名" /></label>}
        <label>用户名<input required minLength="3" maxLength="40" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,39}" autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="例如：zhangsan" /></label>
        <label>密码<input required type="password" minLength="10" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="至少 10 个字符" /></label>
        <ErrorText error={error} />{notice && <div className="notice">{notice}</div>}
        <Button disabled={busy}>{busy ? <Spinner /> : mode === 'login' ? '登录' : '创建账号'}</Button>
      </form>
    </section>
  </main>;
}

function App() {
  const [session, setSession] = useState(undefined);
  const [identity, setIdentity] = useState(null);
  const [identityError, setIdentityError] = useState('');
  useEffect(() => {
    let mounted = true;
    const token = localStorage.getItem(SESSION_KEY);
    if (!token) { setSession(null); return () => { mounted = false; }; }
    apiRequest('me').then((result) => {
      if (!mounted) return;
      if (result.error) { localStorage.removeItem(SESSION_KEY); setSession(null); return; }
      setSession({ token, user: result.data.user });
      setIdentity({ profile: result.data.user, roles: result.data.roles || [] });
    });
    return () => { mounted = false; };
  }, []);
  if (!supabaseUrl || !supabaseKey) return <main className="auth-page"><section className="auth-card"><div className="logo-mark">予</div><h1>需要连接数据服务</h1><p className="auth-lead">请在部署环境中配置站点数据服务。</p></section></main>;
  if (session === undefined || (session && !identity && !identityError)) return <main className="loading-page"><Spinner /></main>;
  if (!session) return <AuthScreen />;
  if (identityError) return <main className="auth-page"><section className="auth-card"><h1>账号信息加载失败</h1><ErrorText error={identityError} /><Button onClick={() => window.location.reload()}>重新加载</Button></section></main>;
  return <Workspace session={session} identity={identity} />;
}

function Workspace({ session, identity }) {
  const [view, setView] = useState('dashboard');
  const [selectedId, setSelectedId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const roles = identity.roles || [];
  const open = (next, id = null) => { setSelectedId(id); setView(next); };
  const refresh = () => setRefreshKey((value) => value + 1);
  const logout = async () => { await apiRequest('logout'); localStorage.removeItem(SESSION_KEY); window.location.reload(); };
  return <div className="app-shell">
    <header className="topbar"><button className="brand-button" onClick={() => open('dashboard')}><span className="logo-mark small">予</span><span className="brand-name">予行 <em>资金申请</em></span></button>
      <nav><button className={view === 'dashboard' ? 'current' : ''} onClick={() => open('dashboard')}>我的申请</button>{roles.length > 0 && <button className={view === 'team' ? 'current' : ''} onClick={() => open('team')}>工作台</button>}{roles.includes('admin') && <button className={view === 'admin' ? 'current' : ''} onClick={() => open('admin')}>设置</button>}</nav>
      <div className="user-menu"><span>{identity.profile?.full_name || session.user.username}</span><button className="logout" onClick={logout}>退出</button></div>
    </header>
    <main className="content">{view === 'dashboard' || view === 'team' ? <Dashboard identity={identity} team={view === 'team'} onOpen={open} refreshKey={refreshKey} /> : view === 'new' ? <ApplicationForm identity={identity} onDone={(id) => { refresh(); open('detail', id); }} onCancel={() => open('dashboard')} /> : view === 'detail' ? <ApplicationDetail id={selectedId} identity={identity} onBack={() => open('dashboard')} onRefresh={refresh} /> : <AdminPanel identity={identity} />}</main>
    <footer>予行 · 资金申请</footer>
  </div>;
}

function Dashboard({ identity, team, onOpen, refreshKey }) {
  const [applications, setApplications] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [filter, setFilter] = useState(''); const [query, setQuery] = useState('');
  useEffect(() => {
    let mounted = true; setLoading(true);
    (async () => {
      const result = await apiRequest('list_applications', { scope: team ? 'team' : 'mine' });
      if (mounted) { setApplications(result.data || []); setError(result.error?.message || ''); setLoading(false); }
    })(); return () => { mounted = false; };
  }, [identity.profile.id, team, refreshKey]);
  const visible = applications.filter((item) => (!filter || item.status === filter) && (!query || `${item.title} ${item.department}`.toLowerCase().includes(query.toLowerCase())));
  const active = applications.filter((item) => !['rejected', 'cancelled'].includes(item.status));
  const paid = applications.filter((item) => item.status === 'paid');
  return <>
    <div className="heading-row"><div><p className="eyebrow">资金管理</p><h1>{team ? '工作台' : '我的申请'}</h1></div><Button onClick={() => onOpen('new')}>＋ 新建申请</Button></div>
    <div className="stat-grid"><div className="stat-card highlight"><span>申请总额</span><strong>{money(active.reduce((sum, item) => sum + Number(item.amount), 0))}</strong></div><div className="stat-card"><span>进行中</span><strong>{active.filter((item) => !['paid', 'draft'].includes(item.status)).length}<small> 笔</small></strong></div><div className="stat-card"><span>已付款</span><strong>{money(paid.reduce((sum, item) => sum + Number(item.amount), 0))}</strong></div></div>
    <section className="panel list-panel"><div className="toolbar"><input aria-label="搜索" placeholder="搜索标题或部门" value={query} onChange={(e) => setQuery(e.target.value)} /><select aria-label="状态筛选" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">全部状态</option>{Object.entries(STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      {loading ? <div className="panel-empty"><Spinner /></div> : error ? <div className="panel-empty"><ErrorText error={error} /></div> : visible.length === 0 ? <div className="panel-empty"><div className="empty-mark">＋</div><h2>这里还没有申请</h2><p>准备好了，就创建第一笔。</p><Button kind="secondary" onClick={() => onOpen('new')}>新建申请</Button></div> : <div className="table-scroll"><table><thead><tr><th>申请</th>{team && <th>申请人</th>}<th>金额</th><th>状态</th><th>更新日期</th></tr></thead><tbody>{visible.map((item) => <tr key={item.id} onClick={() => onOpen('detail', item.id)}><td><button className="link-button">{item.title}</button><span className="subtext">{item.department} · {item.category}</span></td>{team && <td>{item.owner_id === identity.profile.id ? '我' : item.owner_id.slice(0, 8)}</td>}<td className="numeric">{money(item.amount)}</td><td><StatusBadge status={item.status} /></td><td className="muted">{dateText(item.updated_at)}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}

function ApplicationForm({ identity, onDone, onCancel, initial = null }) {
  const [form, setForm] = useState(initial || { title: '', purpose: '', amount: '', category: '', department: identity.profile.department || '', use_date: '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) { setError('请输入有效金额。'); setBusy(false); return; }
    const payload = { id: initial?.id, title: form.title.trim(), purpose: form.purpose.trim(), amount, category: form.category.trim(), department: form.department.trim(), use_date: form.use_date };
    const result = await apiRequest(initial ? 'update_application' : 'create_application', payload);
    if (result.error) setError(result.error.message); else onDone(result.data.id); setBusy(false);
  };
  return <><button className="back-button" onClick={onCancel}>‹ 返回申请列表</button><h1>{initial ? '编辑申请' : '新建申请'}</h1><section className="panel form-panel"><form onSubmit={submit} className="stack-form"><label>申请标题<input required maxLength="120" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="例如：迎新活动物资" /></label><div className="form-grid"><label>申请金额（元）<input required min="0.01" max="10000000" step="0.01" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label><label>使用日期<input required type="date" value={form.use_date} onChange={(e) => setForm({ ...form, use_date: e.target.value })} /></label><label>费用类别<input required maxLength="80" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="例如：活动物资" /></label><label>部门 / 活动<input required maxLength="80" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></label></div><label>用途说明<textarea required rows="5" maxLength="5000" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} placeholder="需要购买什么，用于哪项活动？" /></label><ErrorText error={error} /><div className="form-actions"><Button kind="secondary" type="button" onClick={onCancel}>取消</Button><Button disabled={busy}>{busy ? <Spinner /> : '保存草稿'}</Button></div></form></section></>;
}

function ApplicationDetail({ id, identity, onBack, onRefresh }) {
  const [application, setApplication] = useState(null); const [files, setFiles] = useState([]); const [actions, setActions] = useState([]); const [payment, setPayment] = useState(null); const [ownerName, setOwnerName] = useState(''); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [note, setNote] = useState(''); const [recipient, setRecipient] = useState(''); const [reference, setReference] = useState('');
  const load = async () => { setLoading(true); const result = await apiRequest('get_application', { id }); if (result.error) { setError(result.error.message); setLoading(false); return; } const data = result.data; setApplication(data.application); setOwnerName(data.ownerName || '成员'); setFiles(data.files || []); setActions(data.actions || []); setPayment(data.payment); setLoading(false); };
  useEffect(() => { load(); }, [id]);
  if (loading) return <div className="panel-empty"><Spinner /></div>;
  if (!application) return <div className="panel-empty"><ErrorText error={error || '申请不存在。'} /><Button kind="secondary" onClick={onBack}>返回</Button></div>;
  const own = application.owner_id === identity.profile.id; const canFinance = identity.roles.includes('finance') && !own && application.status === 'finance_pending'; const canChair = identity.roles.includes('chair') && !own && application.status === 'chair_pending'; const canReview = canFinance || canChair; const editable = own && ['draft', 'changes_requested'].includes(application.status);
  const perform = async (action) => { setBusy(true); setError(''); const result = await apiRequest(action, { application_id: id, note }); if (result.error) setError(result.error.message); else { setNote(''); await load(); onRefresh(); } setBusy(false); };
  const uploadFile = async (event, kind) => { const file = event.target.files?.[0]; if (!file) return; setBusy(true); setError(''); const result = await apiUpload({ application_id: id, kind, recipient: recipient.trim(), reference: reference.trim(), file }); if (result.error) setError(result.error.message); else { setRecipient(''); setReference(''); await load(); onRefresh(); } setBusy(false); event.target.value = ''; };
  return <><button className="back-button" onClick={onBack}>‹ 返回申请列表</button><div className="heading-row detail-heading"><div><p className="eyebrow">申请 #{id.slice(0, 8)}</p><h1>{application.title}</h1><StatusBadge status={application.status} /></div><div className="detail-actions">{editable && <Button kind="secondary" onClick={() => perform('submit_application')}>提交申请</Button>}{own && ['draft', 'changes_requested', 'finance_pending', 'chair_pending'].includes(application.status) && <Button kind="quiet danger" onClick={() => perform('cancel_application')}>撤回</Button>}</div></div><div className="detail-grid"><section className="panel detail-panel"><div className="amount-label">申请金额</div><div className="hero-amount">{money(application.amount)}</div><dl><dt>申请人</dt><dd>{ownerName}</dd><dt>部门 / 活动</dt><dd>{application.department}</dd><dt>费用类别</dt><dd>{application.category}</dd><dt>使用日期</dt><dd>{dateText(application.use_date)}</dd></dl><h3>用途说明</h3><p className="prose">{application.purpose}</p><div className="route"><span>财委</span><b>›</b><span>{Number(application.rule_threshold) && Number(application.amount) >= Number(application.rule_threshold) ? '主席' : '财务付款'}</span>{Number(application.rule_threshold) && Number(application.amount) >= Number(application.rule_threshold) && <><b>›</b><span>财务付款</span></>}</div><h3>附件</h3>{files.length ? files.map((file) => <FileLink key={file.id} file={file} />) : <p className="muted">暂无附件</p>}{editable && <label className="upload-box">添加附件<input type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => uploadFile(e, 'attachment')} /></label>}{own && application.status === 'payment_info_required' && <div className="action-block"><h2>收款信息</h2><label>收款人姓名<input value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength="80" /></label><label className="upload-box">上传支付宝收款码<input type="file" accept="image/png,image/jpeg" onChange={(e) => uploadFile(e, 'qr')} /></label></div>}{identity.roles.includes('cashier') && !own && application.status === 'payment_pending' && <div className="action-block"><h2>登记付款</h2><p className="muted">收款人：{application.recipient} · 应付 {money(application.amount)}</p><label>支付宝流水号<input value={reference} onChange={(e) => setReference(e.target.value)} maxLength="120" /></label><label className="check-row"><input type="checkbox" required />已核对收款人及金额，并完成转账</label><label className="upload-box">上传付款凭证<input type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => uploadFile(e, 'receipt')} /></label></div>}{canReview && <div className="action-block"><h2>处理申请</h2><label>意见<textarea rows="3" maxLength="2000" required value={note} onChange={(e) => setNote(e.target.value)} /></label><div className="form-actions"><Button kind="secondary" disabled={busy || !note.trim()} onClick={() => perform('return_application')}>退回修改</Button><Button kind="danger" disabled={busy || !note.trim()} onClick={() => perform('reject_application')}>拒绝</Button><Button disabled={busy || !note.trim()} onClick={() => perform('approve_application')}>通过</Button></div></div>}{payment && <div className="payment-record"><h3>付款记录</h3><p>{money(payment.amount)} · {payment.reference}</p></div>}<ErrorText error={error} /></section><aside className="panel timeline"><h2>进展</h2>{actions.length ? <ol>{actions.map((action) => <li key={action.id}><strong>{action.action}</strong><p>{action.note || '—'}</p><time>{dateTime(action.created_at)}</time></li>)}</ol> : <p className="muted">草稿已保存</p>}</aside></div></>;
}

function FileLink({ file }) {
  const [busy, setBusy] = useState(false);
  const open = async () => { setBusy(true); const result = await apiRequest('file_url', { path: file.storage_path }); if (result.error) alert(result.error.message); else window.open(result.data.signedUrl, '_blank', 'noopener,noreferrer'); setBusy(false); };
  return <button className="file-row" onClick={open}><span>{file.name}</span><small>{busy ? '打开中…' : fileLabel(file.kind)}</small></button>;
}

function AdminPanel({ identity }) {
  const [data, setData] = useState(null); const [threshold, setThreshold] = useState('100'); const [passwords, setPasswords] = useState({ current: '', next: '' }); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const load = async () => { const result = await apiRequest('admin_data'); if (result.error) setError(result.error.message); else { setData(result.data); setThreshold(String(result.data.threshold)); } };
  useEffect(() => { if (identity.roles.includes('admin')) load(); }, []);
  const roleSet = (userId) => new Set((data?.roles || []).filter((item) => item.user_id === userId).map((item) => item.role));
  const updateUser = async (userId, nextRoles, active) => { setBusy(true); setError(''); const result = await apiRequest('set_member_roles', { user_id: userId, roles: nextRoles, active }); if (result.error) setError(result.error.message); else await load(); setBusy(false); };
  const saveRule = async (event) => { event.preventDefault(); setBusy(true); setError(''); const result = await apiRequest('update_threshold', { threshold: Number(threshold) }); if (result.error) setError(result.error.message); else await load(); setBusy(false); };
  const changePassword = async (event) => { event.preventDefault(); setBusy(true); setError(''); setNotice(''); const result = await apiRequest('change_password', { current_password: passwords.current, new_password: passwords.next }); if (result.error) setError(result.error.message); else { setPasswords({ current: '', next: '' }); setNotice('密码已更新。'); } setBusy(false); };
  if (!identity.roles.includes('admin')) return <div className="panel-empty"><h2>没有权限</h2></div>;
  return <><div className="heading-row"><div><p className="eyebrow">组织管理</p><h1>设置</h1></div></div><div className="settings-grid"><section className="panel detail-panel"><h2>审批规则</h2><form onSubmit={saveRule} className="stack-form"><label>主席审批起始金额（元）<input type="number" min="0.01" step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label><p className="hint">达到门槛后，财委通过的申请会进入主席审批。</p><Button disabled={busy}>保存规则</Button></form></section><section className="panel detail-panel"><h2>修改密码</h2><form onSubmit={changePassword} className="stack-form"><label>当前密码<input required type="password" value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} /></label><label>新密码<input required minLength="10" type="password" value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} /></label><Button disabled={busy}>更新密码</Button>{notice && <div className="notice">{notice}</div>}</form></section><section className="panel detail-panel"><h2>成员与权限</h2>{data?.profiles.map((profile) => { const roles = roleSet(profile.id); return <MemberRow key={profile.id} profile={profile} roles={roles} busy={busy} onSave={updateUser} />; }) || <Spinner />}</section></div><section className="panel detail-panel"><h2>最近操作</h2><div className="table-scroll"><table><thead><tr><th>操作</th><th>详情</th><th>时间</th></tr></thead><tbody>{data?.audit.map((row) => <tr key={row.id}><td>{row.event}</td><td>{row.detail}</td><td className="muted">{dateTime(row.created_at)}</td></tr>)}</tbody></table></div></section><ErrorText error={error} /></>;
}

function MemberRow({ profile, roles, busy, onSave }) {
  const [selected, setSelected] = useState(roles); const [active, setActive] = useState(profile.active);
  useEffect(() => { setSelected(roles); setActive(profile.active); }, [profile.id, profile.active, roles.size]);
  return <div className="member-row"><div><strong>{profile.full_name || '未命名成员'}</strong><p className="muted">@{profile.username} · {profile.department || '未填写部门'}</p></div><div className="member-roles">{Object.entries(ROLE_LABEL).map(([role, label]) => <label className="check-row" key={role}><input type="checkbox" checked={selected.has(role)} onChange={(e) => { const next = new Set(selected); e.target.checked ? next.add(role) : next.delete(role); setSelected(next); }} />{label}</label>)}<label className="check-row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />启用</label><Button kind="secondary" disabled={busy} onClick={() => onSave(profile.id, [...selected], active)}>保存</Button></div></div>;
}

function Root() { return <App />; }
createRoot(document.getElementById('root')).render(<Root />);
