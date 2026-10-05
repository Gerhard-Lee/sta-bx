import React, { useEffect, useRef, useState } from 'react';
import { apiRequest } from './api.js';
import { ROLE_LABEL, formatDateTime, auditDetail, downloadExport } from './reporting.js';
import { NOTIFY_QUEUE } from './notify-rules.js';

const Button = ({ kind = '', children, ...props }) => <button className={`button ${kind}`} {...props}>{children}</button>;
const ErrorText = ({ children }) => children ? <div className="error-text" role="alert">{children}</div> : null;
export function MemberRow({ profile, roles, busy, onSave, self = false }) {
  const protectedAccount = profile.username?.toLowerCase() === 'admin';
  const signature = [...roles].sort().join(',');
  const [selected, setSelected] = useState(new Set(roles)); const [active, setActive] = useState(profile.active);
  useEffect(() => { setSelected(new Set(signature.split(',').filter(Boolean))); setActive(profile.active); }, [profile.id, profile.active, signature]);
  return <div className="member-row"><div><strong>{profile.full_name || profile.username}</strong><p className="muted">@{profile.username} · {profile.department || '未填写部门'}{profile.has_email ? '' : ' · 未绑定邮箱'}{self ? ' · 当前账号' : ''}</p></div>
    {self || protectedAccount ? <span className="muted">{protectedAccount ? '超级管理员 · 权限已锁定' : '管理员'}</span> : <fieldset disabled={busy} className="member-roles">{Object.entries(ROLE_LABEL).map(([role, label]) => <label className="check-row" key={role}><input type="checkbox" checked={selected.has(role)} onChange={(e) => { const next = new Set(selected); e.target.checked ? next.add(role) : next.delete(role); setSelected(next); }} />{label}</label>)}<label className="check-row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />启用</label><Button kind="secondary" type="button" onClick={() => onSave(profile.id, [...selected], active)}>保存</Button></fieldset>}
  </div>;
}
const emptyUser = () => ({ username: '', password: '', full_name: '', department: '', email: '', roles: [] });
export function MemberDirectory({ identity, busy, revision, onSave }) {
  const [filters, setFilters] = useState({ query: '', role: '', active: '' });
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(10);
  const [result, setResult] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  useEffect(() => {
    let mounted = true; setLoading(true); setError('');
    const timer = setTimeout(async () => {
      const response = await apiRequest('admin_members', { ...filters, page, page_size: pageSize });
      if (!mounted) return;
      if (response.error) setError(response.error.message); else setResult(response.data);
      setLoading(false);
    }, filters.query ? 250 : 0);
    return () => { mounted = false; clearTimeout(timer); };
  }, [filters.query, filters.role, filters.active, page, pageSize, revision]);
  const change = (key, value) => { setFilters((current) => ({ ...current, [key]: value })); setPage(1); };
  const currentPage = result?.page || 1; const pages = Math.max(1, Math.ceil((result?.total || 0) / pageSize));
  return <section className="panel detail-panel admin-section member-directory"><div className="heading-row"><h2>用户与权限</h2><span className="muted">{result ? `${result.total} 位用户` : ''}</span></div>
    <div className="toolbar member-toolbar"><input type="search" aria-label="搜索用户" placeholder="搜索用户名、姓名或部门" value={filters.query} maxLength="80" onChange={(e) => change('query', e.target.value)} />
      <select aria-label="用户角色筛选" value={filters.role} onChange={(e) => change('role', e.target.value)}><option value="">全部角色</option><option value="ordinary">普通用户</option>{Object.entries(ROLE_LABEL).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select>
      <select aria-label="账号状态筛选" value={filters.active} onChange={(e) => change('active', e.target.value)}><option value="">全部状态</option><option value="active">已启用</option><option value="inactive">已停用</option></select>
      {(filters.query || filters.role || filters.active) && <Button kind="quiet" type="button" onClick={() => { setFilters({ query: '', role: '', active: '' }); setPage(1); }}>重置</Button>}
    </div><ErrorText>{error}</ErrorText>
    <div aria-busy={loading}>{loading ? <div className="panel-empty">加载中…</div> : result?.profiles.length ? result.profiles.map((profile) => <MemberRow key={profile.id} profile={profile} roles={new Set(profile.roles)} self={profile.id === identity.profile.id} busy={busy} onSave={onSave} />) : <div className="panel-empty">没有符合条件的用户</div>}</div>
    <div className="member-pagination"><label>每页<select aria-label="每页用户数" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}><option value="10">10 位</option><option value="20">20 位</option><option value="50">50 位</option></select></label><div><Button kind="secondary" disabled={loading || currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</Button><span>{currentPage} / {pages}</span><Button kind="secondary" disabled={loading || currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页</Button></div></div>
  </section>;
}
export function AdminPanel({ identity }) {
  const [data, setData] = useState(null); const [threshold, setThreshold] = useState('100'); const [registration, setRegistration] = useState(true);
  const [emailNotify, setEmailNotify] = useState(false);
  const [newUser, setNewUser] = useState(emptyUser);
  const [period, setPeriod] = useState({ start: '', end: '', opening: '' }); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false);
  const load = async () => {
    const result = await apiRequest('admin_data'); if (result.error) throw new Error(result.error.message);
    setData(result.data); setThreshold(String(result.data.threshold)); setRegistration(result.data.registration_enabled); setEmailNotify(result.data.email_notify_enabled === true);
  };
  useEffect(() => { if (identity.roles.includes('admin')) load().catch((err) => setError(err.message)); }, []);
  const run = async (task, message) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await task(); await load(); setNotice(message); } catch (err) { setError(err.message || '操作没有完成，请重试。'); }
    finally { lock.current = false; setBusy(false); }
  };
  const request = async (action, payload) => { const result = await apiRequest(action, payload); if (result.error) throw new Error(result.error.message); return result.data; };
  const exportReport = (kind) => run(async () => {
    if (period.start && period.end && period.start > period.end) throw new Error('结束日期不能早于开始日期。');
    if (period.opening !== '' && (!Number.isFinite(Number(period.opening)) || Math.abs(Number(period.opening)) > 1e12)) throw new Error('请输入有效的期初余额。');
    const result = await request(kind === 'financial' ? 'export_financial' : 'export_audit', { start: period.start, end: period.end });
    await downloadExport(kind, result, period.opening);
  }, '文件已生成，下载已开始。');
  if (!identity.roles.includes('admin')) return <div className="panel-empty"><h2>没有权限</h2></div>;
  // 后端未随前端一起部署时字段会缺失（包括新增的“已作废”），逐字段兜底，避免整页白屏或显示 undefined。
  const queue = { pending: 0, sending: 0, sent: 0, failed: 0, cancelled: 0, ...(data?.notifications ?? {}) };
  const failures = data?.failures ?? [];
  return <><div className="heading-row"><div><p className="eyebrow">组织管理</p><h1>设置</h1></div></div>
    <ErrorText>{error}</ErrorText>{notice && <div className="notice" role="status">{notice}</div>}
    {!data ? <div className="panel-empty">加载中…</div> : <>
      <div className="settings-grid admin-settings">
        <section className="panel detail-panel"><h2>注册设置</h2><form onSubmit={(e) => { e.preventDefault(); run(() => request('update_registration', { enabled: registration }), '注册设置已保存。'); }}><fieldset disabled={busy}><label className="check-row registration-switch"><input type="checkbox" role="switch" checked={registration} onChange={(e) => setRegistration(e.target.checked)} />允许新用户注册</label><p className="hint">关闭后，已有用户仍可登录，管理员仍可添加用户。</p><Button kind="secondary">保存设置</Button></fieldset></form></section>
        <section className="panel detail-panel"><h2>邮件通知</h2><form onSubmit={(e) => { e.preventDefault(); run(() => request('update_email_notify', { enabled: emailNotify }), '邮件通知设置已保存。'); }}><fieldset disabled={busy}><label className="check-row registration-switch"><input type="checkbox" role="switch" checked={emailNotify} onChange={(e) => setEmailNotify(e.target.checked)} />启用邮件提醒</label><p className="hint">开启后只在出现待办时入队：待财委审批、待主席审批、待付款登记发给对应身份成员，退回修改与待补充收款码发给申请人本人；拒绝与已付款不发信。关闭时不生成新提醒，超过 {NOTIFY_QUEUE.maxAgeHours} 小时仍未发送的提醒会被丢弃。邮件服务密钥由项目负责人在服务端配置，收件人只包含申请中可见的信息。</p><p className="hint">队列由定时任务定期消费；没有配置定时任务时，请点“立即发送”。「已作废」表示提醒发出前申请状态已经变化（或收款信息被更换），这些提醒不会再发，也不占用去重名额。</p>{data.email_service_configured === false && <p className="hint warn">服务端尚未配置 EMAIL_API_URL、EMAIL_API_KEY 与 EMAIL_FROM，队列暂时发不出去。</p>}<p className="muted">队列：待发送 {queue.pending} 封 · 发送中 {queue.sending} 封 · 已发送 {queue.sent} 封 · 失败 {queue.failed} 封 · 已作废 {queue.cancelled} 封</p>{failures.length > 0 && <ul className="queue-failures">{failures.map((item) => <li key={item.id}>@{item.username} · {item.event} · 尝试 {item.attempts} 次 · {item.last_error}</li>)}</ul>}<div className="form-actions"><Button kind="secondary">保存设置</Button><Button type="button" onClick={() => run(() => request('send_notifications', {}), '队列已处理，数量见上方统计。')}>立即发送</Button>{failures.length > 0 && <Button type="button" kind="secondary" onClick={() => run(() => request('reset_notifications', {}), '失败提醒已重新排队。')}>失败项重新排队</Button>}</div></fieldset></form></section>
        <section className="panel detail-panel"><h2>金额设置</h2><form className="stack-form" onSubmit={(e) => { e.preventDefault(); run(() => request('update_threshold', { threshold: Number(threshold) }), '金额设置已保存。'); }}><fieldset disabled={busy}><label>主席处理起始金额（元）<input required type="number" min="0.01" max="10000000" step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label><Button kind="secondary">保存设置</Button></fieldset></form></section>
        <section className="panel detail-panel"><h2>添加用户</h2><form className="stack-form" onSubmit={(e) => { e.preventDefault(); run(async () => { await request('admin_create_user', newUser); setNewUser(emptyUser()); }, '用户已添加，可使用初始密码登录。'); }}><fieldset disabled={busy}>
          <div className="form-grid"><label>用户名<input required minLength="3" maxLength="40" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,39}" autoComplete="off" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} /></label><label>姓名<input required maxLength="80" value={newUser.full_name} onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })} /></label></div>
          <label>部门 / 活动<input maxLength="80" value={newUser.department} onChange={(e) => setNewUser({ ...newUser, department: e.target.value })} /></label><label>邮箱（可选，用于接收待办提醒）<input type="email" maxLength="254" autoComplete="off" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} placeholder="例如 you@example.com" /></label><label>初始密码<input required type="password" minLength="10" maxLength="72" autoComplete="new-password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} placeholder="10–72 个字符" /></label>
          <div className="role-choices">{Object.entries(ROLE_LABEL).map(([role, label]) => <label className="check-row" key={role}><input type="checkbox" checked={newUser.roles.includes(role)} onChange={(e) => setNewUser({ ...newUser, roles: e.target.checked ? [...newUser.roles, role] : newUser.roles.filter((r) => r !== role) })} />{label}</label>)}</div><p className="hint">不选择角色时，为普通用户。</p><Button>添加用户</Button>
        </fieldset></form></section>
        <section className="panel detail-panel"><h2>数据导出</h2><fieldset disabled={busy}><div className="form-grid"><label>开始日期<input type="date" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} /></label><label>结束日期<input type="date" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} /></label></div><label>期初余额（元，可不填）<input type="number" step="0.01" value={period.opening} onChange={(e) => setPeriod({ ...period, opening: e.target.value })} /></label><p className="hint">财报仅含已付款报销。不填写期初余额时，收入及余额留空。</p><div className="export-actions"><Button type="button" onClick={() => exportReport('financial')}>导出财报</Button><Button type="button" kind="secondary" onClick={() => exportReport('audit')}>导出操作日志</Button></div></fieldset></section>
      </div>
      <MemberDirectory identity={identity} busy={busy} revision={data} onSave={(user_id, roles, active) => run(() => request('set_member_roles', { user_id, roles, active }), '用户设置已保存。')} />
      <section className="panel detail-panel admin-section"><div className="heading-row"><h2>最近操作</h2><span className="muted">最近 50 条 · 北京时间</span></div><div className="table-scroll audit-table"><table><thead><tr><th>时间</th><th>用户名</th><th>IP 地址</th><th>操作</th><th>具体内容</th></tr></thead><tbody>{data.audit.map((row) => <tr key={row.id}><td className="audit-time">{formatDateTime(row.created_at)}</td><td>@{row.username}</td><td className="audit-ip">{row.ip_address || '未记录'}</td><td>{row.event}</td><td className="audit-detail">{auditDetail(row) || '—'}</td></tr>)}</tbody></table>{!data.audit.length && <p className="muted">暂无操作记录</p>}</div></section>
    </>}
  </>;
}
