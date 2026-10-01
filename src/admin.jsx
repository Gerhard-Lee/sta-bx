import React, { useEffect, useRef, useState } from 'react';
import { apiRequest } from './api.js';
import { ROLE_LABEL, formatDateTime, auditDetail, downloadExport } from './reporting.js';

const Button = ({ kind = '', children, ...props }) => <button className={`button ${kind}`} {...props}>{children}</button>;
const ErrorText = ({ children }) => children ? <div className="error-text" role="alert">{children}</div> : null;
export function MemberRow({ profile, roles, busy, onSave, self = false }) {
  const signature = [...roles].sort().join(',');
  const [selected, setSelected] = useState(new Set(roles)); const [active, setActive] = useState(profile.active);
  useEffect(() => { setSelected(new Set(signature.split(',').filter(Boolean))); setActive(profile.active); }, [profile.id, profile.active, signature]);
  return <div className="member-row"><div><strong>{profile.full_name || profile.username}</strong><p className="muted">@{profile.username} · {profile.department || '未填写部门'}{self ? ' · 当前账号' : ''}</p></div>
    {self ? <span className="muted">管理员</span> : <fieldset disabled={busy} className="member-roles">{Object.entries(ROLE_LABEL).map(([role, label]) => <label className="check-row" key={role}><input type="checkbox" checked={selected.has(role)} onChange={(e) => { const next = new Set(selected); e.target.checked ? next.add(role) : next.delete(role); setSelected(next); }} />{label}</label>)}<label className="check-row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />启用</label><Button kind="secondary" type="button" onClick={() => onSave(profile.id, [...selected], active)}>保存</Button></fieldset>}
  </div>;
}
const emptyUser = () => ({ username: '', password: '', full_name: '', department: '', roles: [] });
export function AdminPanel({ identity }) {
  const [data, setData] = useState(null); const [threshold, setThreshold] = useState('100'); const [registration, setRegistration] = useState(true);
  const [passwords, setPasswords] = useState({ current: '', next: '' }); const [newUser, setNewUser] = useState(emptyUser);
  const [period, setPeriod] = useState({ start: '', end: '', opening: '' }); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false);
  const load = async () => {
    const result = await apiRequest('admin_data'); if (result.error) throw new Error(result.error.message);
    setData(result.data); setThreshold(String(result.data.threshold)); setRegistration(result.data.registration_enabled);
  };
  useEffect(() => { if (identity.roles.includes('admin')) load().catch((err) => setError(err.message)); }, []);
  const run = async (task, message) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await task(); await load(); setNotice(message); } catch (err) { setError(err.message || '操作没有完成，请重试。'); }
    finally { lock.current = false; setBusy(false); }
  };
  const request = async (action, payload) => { const result = await apiRequest(action, payload); if (result.error) throw new Error(result.error.message); return result.data; };
  const roleSet = (id) => new Set((data?.roles || []).filter((r) => r.user_id === id).map((r) => r.role));
  const exportReport = (kind) => run(async () => {
    if (period.start && period.end && period.start > period.end) throw new Error('结束日期不能早于开始日期。');
    if (period.opening !== '' && (!Number.isFinite(Number(period.opening)) || Math.abs(Number(period.opening)) > 1e12)) throw new Error('请输入有效的期初余额。');
    const result = await request(kind === 'financial' ? 'export_financial' : 'export_audit', { start: period.start, end: period.end });
    await downloadExport(kind, result, period.opening);
  }, '文件已生成，下载已开始。');
  if (!identity.roles.includes('admin')) return <div className="panel-empty"><h2>没有权限</h2></div>;
  return <><div className="heading-row"><div><p className="eyebrow">组织管理</p><h1>设置</h1></div></div>
    <ErrorText>{error}</ErrorText>{notice && <div className="notice" role="status">{notice}</div>}
    {!data ? <div className="panel-empty">加载中…</div> : <>
      <div className="settings-grid admin-settings">
        <section className="panel detail-panel"><h2>注册设置</h2><form onSubmit={(e) => { e.preventDefault(); run(() => request('update_registration', { enabled: registration }), '注册设置已保存。'); }}><fieldset disabled={busy}><label className="check-row registration-switch"><input type="checkbox" role="switch" checked={registration} onChange={(e) => setRegistration(e.target.checked)} />允许新用户注册</label><p className="hint">关闭后，已有用户仍可登录，管理员仍可添加用户。</p><Button kind="secondary">保存设置</Button></fieldset></form></section>
        <section className="panel detail-panel"><h2>金额设置</h2><form className="stack-form" onSubmit={(e) => { e.preventDefault(); run(() => request('update_threshold', { threshold: Number(threshold) }), '金额设置已保存。'); }}><fieldset disabled={busy}><label>主席处理起始金额（元）<input required type="number" min="0.01" max="10000000" step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label><Button kind="secondary">保存设置</Button></fieldset></form></section>
        <section className="panel detail-panel"><h2>添加用户</h2><form className="stack-form" onSubmit={(e) => { e.preventDefault(); run(async () => { await request('admin_create_user', newUser); setNewUser(emptyUser()); }, '用户已添加，可使用初始密码登录。'); }}><fieldset disabled={busy}>
          <div className="form-grid"><label>用户名<input required minLength="3" maxLength="40" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,39}" autoComplete="off" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} /></label><label>姓名<input required maxLength="80" value={newUser.full_name} onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })} /></label></div>
          <label>部门 / 活动<input maxLength="80" value={newUser.department} onChange={(e) => setNewUser({ ...newUser, department: e.target.value })} /></label><label>初始密码<input required type="password" minLength="10" maxLength="72" autoComplete="new-password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} placeholder="10–72 个字符" /></label>
          <div className="role-choices">{Object.entries(ROLE_LABEL).map(([role, label]) => <label className="check-row" key={role}><input type="checkbox" checked={newUser.roles.includes(role)} onChange={(e) => setNewUser({ ...newUser, roles: e.target.checked ? [...newUser.roles, role] : newUser.roles.filter((r) => r !== role) })} />{label}</label>)}</div><p className="hint">不选择角色时，为普通用户。</p><Button>添加用户</Button>
        </fieldset></form></section>
        <section className="panel detail-panel"><h2>数据导出</h2><fieldset disabled={busy}><div className="form-grid"><label>开始日期<input type="date" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} /></label><label>结束日期<input type="date" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} /></label></div><label>期初余额（元，可不填）<input type="number" step="0.01" value={period.opening} onChange={(e) => setPeriod({ ...period, opening: e.target.value })} /></label><p className="hint">财报仅含已付款报销。不填写期初余额时，收入及余额留空。</p><div className="export-actions"><Button type="button" onClick={() => exportReport('financial')}>导出财报</Button><Button type="button" kind="secondary" onClick={() => exportReport('audit')}>导出操作日志</Button></div></fieldset></section>
        <section className="panel detail-panel"><h2>修改密码</h2><form className="stack-form" onSubmit={(e) => { e.preventDefault(); run(async () => { await request('change_password', { current_password: passwords.current, new_password: passwords.next }); setPasswords({ current: '', next: '' }); }, '密码已更新。'); }}><fieldset disabled={busy}><label>当前密码<input required type="password" autoComplete="current-password" value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} /></label><label>新密码<input required minLength="10" maxLength="72" type="password" autoComplete="new-password" value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} /></label><Button kind="secondary">更新密码</Button></fieldset></form></section>
      </div>
      <section className="panel detail-panel admin-section"><h2>用户与权限</h2>{data.profiles.map((profile) => <MemberRow key={profile.id} profile={profile} roles={roleSet(profile.id)} self={profile.id === identity.profile.id} busy={busy} onSave={(user_id, roles, active) => run(() => request('set_member_roles', { user_id, roles, active }), '用户设置已保存。')} />)}</section>
      <section className="panel detail-panel admin-section"><div className="heading-row"><h2>最近操作</h2><span className="muted">最近 50 条 · 北京时间</span></div><div className="table-scroll audit-table"><table><thead><tr><th>时间</th><th>用户名</th><th>IP 地址</th><th>操作</th><th>具体内容</th></tr></thead><tbody>{data.audit.map((row) => <tr key={row.id}><td className="audit-time">{formatDateTime(row.created_at)}</td><td>@{row.username}</td><td className="audit-ip">{row.ip_address || '未记录'}</td><td>{row.event}</td><td className="audit-detail">{auditDetail(row) || '—'}</td></tr>)}</tbody></table>{!data.audit.length && <p className="muted">暂无操作记录</p>}</div></section>
    </>}
  </>;
}
