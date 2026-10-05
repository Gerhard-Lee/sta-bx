import React, { useEffect, useRef, useState } from 'react';
import { apiRequest } from './api.js';
import { ROLE_LABEL, formatDateTime, auditDetail, auditFilterSummary, downloadExport } from './reporting.js';

const Button = ({ kind = '', children, ...props }) => <button className={`button ${kind}`} {...props}>{children}</button>;
const ErrorText = ({ children }) => children ? <div className="error-text" role="alert">{children}</div> : null;
const NO_AUDIT_FILTERS = { username: '', event: '', ip: '', start: '', end: '' };
const AUDIT_TEXT_KEYS = ['username', 'event', 'ip'];
const auditFiltersActive = (filters) => Object.values(filters).some(Boolean);

/** Page through a server-side result set with keyset-stable ordering decided by the server. */
function Pager({ page, total, pageSize, loading, onPage, onPageSize, unit, sizeLabel, sizes = [10, 20, 50] }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages);
  return <div className="member-pagination">
    <label>每页<select aria-label={sizeLabel} value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>{sizes.map((size) => <option key={size} value={size}>{size} {unit}</option>)}</select></label>
    <div><Button kind="secondary" disabled={loading || current <= 1} onClick={() => onPage(current - 1)}>上一页</Button><span>{current} / {pages}</span><Button kind="secondary" disabled={loading || current >= pages} onClick={() => onPage(current + 1)}>下一页</Button></div>
  </div>;
}

export function MemberRow({ profile, roles, busy, onSave, self = false }) {
  const protectedAccount = profile.username?.toLowerCase() === 'admin';
  const signature = [...roles].sort().join(',');
  const [selected, setSelected] = useState(new Set(roles)); const [active, setActive] = useState(profile.active);
  useEffect(() => { setSelected(new Set(signature.split(',').filter(Boolean))); setActive(profile.active); }, [profile.id, profile.active, signature]);
  return <div className="member-row"><div><strong>{profile.full_name || profile.username}</strong><p className="muted">@{profile.username} · {profile.department || '未填写部门'}{self ? ' · 当前账号' : ''}</p></div>
    {self || protectedAccount ? <span className="muted">{protectedAccount ? '超级管理员 · 权限已锁定' : '管理员'}</span> : <fieldset disabled={busy} className="member-roles">{Object.entries(ROLE_LABEL).map(([role, label]) => <label className="check-row" key={role}><input type="checkbox" checked={selected.has(role)} onChange={(e) => { const next = new Set(selected); e.target.checked ? next.add(role) : next.delete(role); setSelected(next); }} />{label}</label>)}<label className="check-row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />启用</label><Button kind="secondary" type="button" onClick={() => onSave(profile.id, [...selected], active)}>保存</Button></fieldset>}
  </div>;
}
const emptyUser = () => ({ username: '', password: '', full_name: '', department: '', roles: [] });
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
  return <section className="panel detail-panel admin-section member-directory"><div className="heading-row"><h2>用户与权限</h2><span className="muted">{result ? `${result.total} 位用户` : ''}</span></div>
    <div className="toolbar member-toolbar"><input type="search" aria-label="搜索用户" placeholder="搜索用户名、姓名或部门" value={filters.query} maxLength="80" onChange={(e) => change('query', e.target.value)} />
      <select aria-label="用户角色筛选" value={filters.role} onChange={(e) => change('role', e.target.value)}><option value="">全部角色</option><option value="ordinary">普通用户</option>{Object.entries(ROLE_LABEL).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select>
      <select aria-label="账号状态筛选" value={filters.active} onChange={(e) => change('active', e.target.value)}><option value="">全部状态</option><option value="active">已启用</option><option value="inactive">已停用</option></select>
      {(filters.query || filters.role || filters.active) && <Button kind="quiet" type="button" onClick={() => { setFilters({ query: '', role: '', active: '' }); setPage(1); }}>重置</Button>}
    </div><ErrorText>{error}</ErrorText>
    <div aria-busy={loading}>{loading ? <div className="panel-empty">加载中…</div> : result?.profiles.length ? result.profiles.map((profile) => <MemberRow key={profile.id} profile={profile} roles={new Set(profile.roles)} self={profile.id === identity.profile.id} busy={busy} onSave={onSave} />) : <div className="panel-empty">没有符合条件的用户</div>}</div>
    <Pager page={page} total={result?.total || 0} pageSize={pageSize} loading={loading} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} unit="位" sizeLabel="每页用户数" sizes={[10, 20, 50]} />
  </section>;
}

const AUDIT_OBJECT_LABEL = { api_action: '接口动作', ip_source: 'IP 来源', application_id: '申请编号', title: '申请标题', amount: '金额', status: '申请状态', file_id: '文件编号', file_name: '文件名', file_kind: '文件类型', draft_value: '草稿内容', decision: '审批结果', note: '审批意见', target_user_id: '用户编号', target_username: '目标用户', active: '账号状态', roles: '角色', changes: '字段变更', 原值: '原值', 新值: '新值', recipient: '收款人', reference: '流水号' };
const objectEntries = (metadata) => Object.entries(metadata || {}).filter(([key]) => key !== 'changes');
const objectText = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.map(objectText).join('、') : '—';
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${AUDIT_OBJECT_LABEL[key] || key} ${objectText(item)}`).join(' · ');
  return String(value);
};

/** The complete log entry: full text, field changes and linked objects, no truncation. */
function AuditDetailDialog({ row, onClose }) {
  const changes = row.metadata?.changes || {};
  const objects = objectEntries(row.metadata);
  return <div className="dialog-backdrop" role="presentation" onClick={onClose}>
    <div className="dialog-panel audit-dialog" role="dialog" aria-modal="true" aria-labelledby="audit-dialog-title" onClick={(e) => e.stopPropagation()}>
      <div className="heading-row"><h2 id="audit-dialog-title">日志详情</h2><Button kind="quiet" type="button" onClick={onClose}>关闭</Button></div>
      <dl className="audit-detail-list">
        <dt>编号</dt><dd className="audit-code">{String(row.id)}</dd>
        <dt>时间</dt><dd>{formatDateTime(row.created_at)}{' '}<span className="muted">北京时间</span></dd>
        <dt>用户名</dt><dd>@{row.username || '系统'}</dd>
        <dt>IP 地址</dt><dd className="audit-code">{row.ip_address || '未记录'}</dd>
        <dt>操作</dt><dd>{row.event}</dd>
        <dt>具体内容</dt><dd className="prose">{auditDetail(row) || '—'}</dd>
      </dl>
      {Object.keys(changes).length > 0 && <><h3>字段变更</h3><ul className="audit-change-list">{Object.entries(changes).map(([field, value]) => <li key={field}>{objectText({ [field]: value })}</li>)}</ul></>}
      {objects.length > 0 ? <><h3>关联对象</h3><dl className="audit-detail-list">{objects.map(([key, value]) => <React.Fragment key={key}><dt>{AUDIT_OBJECT_LABEL[key] || key}</dt><dd className={key.endsWith('_id') ? 'audit-code' : ''}>{objectText(value)}</dd></React.Fragment>)}</dl></>
        : <p className="hint">这条日志没有关联对象。</p>}
      {!row.metadata || Object.keys(row.metadata).length === 0 ? <p className="hint">当前身份只能查看操作内容；完整 IP、请求来源和关联对象仅超级管理员可见。</p> : null}
    </div>
  </div>;
}

/** Server-side audit log search: filters, time-descending paging and a per-row detail view. */
export function AuditDirectory({ identity, revision, filters, onFiltersChange, filtersRevision = 0 }) {
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(20);
  const [result, setResult] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [detailed, setDetailed] = useState(null);
  const textFilter = AUDIT_TEXT_KEYS.some((key) => filters[key]);
  useEffect(() => {
    let mounted = true; setLoading(true); setError('');
    const timer = setTimeout(async () => {
      const response = await apiRequest('admin_audit', { ...filters, page, page_size: pageSize });
      if (!mounted) return;
      if (response.error) setError(response.error.message); else setResult(response.data);
      setLoading(false);
    }, textFilter ? 250 : 0);
    return () => { mounted = false; clearTimeout(timer); };
  }, [filters.username, filters.event, filters.ip, filters.start, filters.end, page, pageSize, revision, filtersRevision]);
  const change = (key, value) => { onFiltersChange({ ...filters, [key]: value }); setPage(1); };
  const rows = result?.logs || [];
  return <section className="panel detail-panel admin-section audit-directory">
    <div className="heading-row"><h2>操作日志</h2><span className="muted">{result ? `${result.total} 条记录${result.scope === 'limited' ? ' · 当前身份仅可查看操作内容' : ''}` : ''}</span></div>
    <div className="toolbar audit-toolbar">
      <input type="search" aria-label="搜索用户名" placeholder="用户名" value={filters.username} maxLength="80" onChange={(e) => change('username', e.target.value)} />
      <input type="search" aria-label="搜索操作名称" placeholder="操作名称" value={filters.event} maxLength="80" onChange={(e) => change('event', e.target.value)} />
      <input type="search" aria-label="搜索 IP 地址" placeholder="IP 地址" value={filters.ip} maxLength="64" onChange={(e) => change('ip', e.target.value)} />
      <label className="audit-date">开始日期<input type="date" value={filters.start} onChange={(e) => change('start', e.target.value)} /></label>
      <label className="audit-date">结束日期<input type="date" value={filters.end} onChange={(e) => change('end', e.target.value)} /></label>
      {auditFiltersActive(filters) && <Button kind="quiet" type="button" onClick={() => { onFiltersChange({ ...NO_AUDIT_FILTERS }); setPage(1); }}>重置</Button>}
    </div><ErrorText>{error}</ErrorText>
    <div aria-busy={loading}>{loading ? <div className="panel-empty">加载中…</div> : rows.length ? <div className="table-scroll audit-table"><table><thead><tr><th>时间</th><th>用户名</th><th>IP 地址</th><th>操作</th><th>具体内容</th><th><span className="sr-only">详情</span></th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}><td className="audit-time">{formatDateTime(row.created_at)}</td><td>@{row.username}</td><td className="audit-ip">{row.ip_address || '未记录'}</td><td>{row.event}</td><td className="audit-detail">{auditDetail(row) || '—'}</td><td><Button kind="quiet" type="button" onClick={() => setDetailed(row)}>查看</Button></td></tr>)}</tbody></table></div>
      : <div className="panel-empty">没有符合条件的日志</div>}</div>
    <Pager page={page} total={result?.total || 0} pageSize={pageSize} loading={loading} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} unit="条" sizeLabel="每页日志数" sizes={[10, 20, 50, 100]} />
    {detailed && <AuditDetailDialog row={detailed} onClose={() => setDetailed(null)} />}
  </section>;
}

export function AdminPanel({ identity }) {
  const [data, setData] = useState(null); const [threshold, setThreshold] = useState('100'); const [registration, setRegistration] = useState(true);
  const [newUser, setNewUser] = useState(emptyUser);
  const [auditFilters, setAuditFilters] = useState({ ...NO_AUDIT_FILTERS });
  // The audit export and the audit list read the same filter object, so they can never disagree.
  const [auditFiltersRevision, setAuditFiltersRevision] = useState(0);
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
  const validPeriod = () => {
    if (period.start && period.end && period.start > period.end) throw new Error('结束日期不能早于开始日期。');
    if (period.opening !== '' && (!Number.isFinite(Number(period.opening)) || Math.abs(Number(period.opening)) > 1e12)) throw new Error('请输入有效的期初余额。');
  };
  const exportReport = (kind) => run(async () => {
    validPeriod();
    const result = await request(kind === 'financial' ? 'export_financial' : 'export_audit', kind === 'financial' ? { start: period.start, end: period.end } : { ...auditFilters });
    await downloadExport(kind, result, period.opening);
  }, '文件已生成，下载已开始。');
  // Plain date-range export, kept for the period-based report work in the same panel.
  const exportPeriodAudit = () => run(async () => {
    validPeriod();
    await downloadExport('audit', await request('export_audit', { start: period.start, end: period.end }));
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
        <section className="panel detail-panel"><h2>数据导出</h2><fieldset disabled={busy}><div className="form-grid"><label>开始日期<input type="date" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} /></label><label>结束日期<input type="date" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} /></label></div><label>期初余额（元，可不填）<input type="number" step="0.01" value={period.opening} onChange={(e) => setPeriod({ ...period, opening: e.target.value })} /></label><p className="hint">财报仅含已付款报销。不填写期初余额时，收入及余额留空。</p><div className="export-actions"><Button type="button" onClick={() => exportReport('financial')}>导出财报</Button><Button type="button" kind="secondary" onClick={() => exportPeriodAudit()}>按日期导出操作日志</Button></div></fieldset>
          <div className="audit-export-row"><p className="hint">按上面的「操作日志」筛选条件导出：{auditFiltersActive(auditFilters) ? auditFilterSummary(auditFilters) : '全部分类、全部时间'}</p><div className="export-actions"><Button type="button" kind="secondary" onClick={() => exportReport('audit')}>导出筛选后的操作日志</Button><Button type="button" kind="quiet" onClick={() => { setAuditFilters({ ...NO_AUDIT_FILTERS }); setAuditFiltersRevision((value) => value + 1); }}>清空筛选</Button></div></div>
        </section>
      </div>
      <MemberDirectory identity={identity} busy={busy} revision={data} onSave={(user_id, roles, active) => run(() => request('set_member_roles', { user_id, roles, active }), '用户设置已保存。')} />
      <AuditDirectory identity={identity} revision={data} filters={auditFilters} onFiltersChange={setAuditFilters} filtersRevision={auditFiltersRevision} />
    </>}
  </>;
}
