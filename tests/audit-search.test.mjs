import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditFilterSummary } from '../src/reporting.js';

const jsx = readFileSync('src/admin.jsx', 'utf8');
const api = readFileSync('supabase/functions/app-api/index.ts', 'utf8');
const sql = readFileSync('supabase/audit-search-and-pagination.sql', 'utf8');

test('操作日志按用户名、操作名称、IP 和日期范围筛选，并只返回符合条件的记录', () => {
  for (const label of ['搜索用户名', '搜索操作名称', '搜索 IP 地址', '开始日期', '结束日期', '重置']) assert.ok(jsx.includes(label), `缺少筛选控件 ${label}`);
  assert.match(jsx, /apiRequest\('admin_audit', \{ \.\.\.filters, page, page_size: pageSize \}\)/);
  assert.match(api, /action === 'admin_audit'[\s\S]{0,80}requireRole\(actor, 'admin'\)/);
  // Every entered condition reaches the query; nothing is dropped or ignored.
  for (const key of ['username', 'event', 'ip', 'start', 'end']) assert.ok(sql.includes(`p_${key}`), `筛选条件 ${key} 未参与查询`);
  assert.match(sql, /p_username='' or strpos\(lower\(coalesce\(l\.username,''\)\),lower\(trim\(p_username\)\)\)>0/);
  assert.match(sql, /p_event='' or strpos\(lower\(l\.event\),lower\(trim\(p_event\)\)\)>0/);
  assert.match(sql, /p_ip='' or coalesce\(l\.ip_address,''\) ilike/);
  assert.match(sql, /start_at is null or l\.created_at>=start_at/);
  assert.match(sql, /end_at is null or l\.created_at<end_at/);
});

test('服务端分页且按时间倒序，日志不再一次性全部加载到浏览器', () => {
  assert.ok(!jsx.includes('data.audit.map'));
  assert.doesNotMatch(jsx, /最近 50 条/);
  // Ordering is time plus the unique id, so a page boundary can never repeat or skip a row.
  assert.match(sql, /order by l\.created_at desc,l\.id desc/);
  assert.match(sql, /limit p_page_size offset \(current_page-1\)\*p_page_size/);
  assert.match(sql, /current_page := least\(p_page,greatest\(1,\(total\+p_page_size-1\)\/p_page_size\)\)/);
  assert.match(sql, /create index if not exists audit_logs_created_id_idx on public\.audit_logs\(created_at desc, id desc\)/);
  assert.match(sql, /p_page_size is null or p_page_size not in \(10,20,50,100\)/);
  for (const label of ['每页日志数', '上一页', '下一页']) assert.ok(jsx.includes(label), `缺少分页控件 ${label}`);
});

test('日志列表与操作日志导出共用同一套筛选条件', () => {
  // One filter definition, two consumers: the paged table and the export.
  assert.match(api, /readAuditFilters\(body, true\)/);
  assert.match(api, /readAuditFilters\(body, false\)/);
  assert.match(api, /const auditExport = action === 'export_audit'/);
  assert.ok(api.includes('if (auditExport) query = applyAuditFilters(query, filters, actorIds)'), '导出没有复用同一套筛选条件');
  assert.match(jsx, /kind === 'financial' \? \{ start: period\.start, end: period\.end \} : \{ \.\.\.auditFilters \}/);
  // The export keeps its Beijing-day boundaries identical to the list.
  assert.match(api, /filters\.start \+ 'T00:00:00\+08:00'/);
  assert.match(sql, /\(p_start\|\|' 00:00:00\+08'\)::timestamptz/);
  assert.match(sql, /interval '1 day'/);
});

test('普通管理员只看到允许查看的内容，超级管理员看到完整记录和关联对象', () => {
  assert.match(sql, /super_admin := private\.app_user_is_superadmin\(p_actor_id\)/);
  assert.match(sql, /when super_admin\s*\n\s*then to_jsonb\(l\)/);
  // The limited projection keeps the action text but withholds IP and request metadata.
  assert.match(sql, /'ip_address',null/);
  assert.match(sql, /'metadata','\{\}'::jsonb/);
  assert.match(sql, /'scope',case when super_admin then 'full' else 'limited' end/);
  assert.match(jsx, /result\.scope === 'limited' \? ' · 当前身份仅可查看操作内容' : ''/);
  assert.match(jsx, /仅超级管理员可见/);
});

test('可以查看单条日志的完整内容和关联对象', () => {
  assert.match(jsx, /function AuditDetailDialog/);
  for (const label of ['日志详情', '具体内容', '关联对象', '字段变更', '查看']) assert.ok(jsx.includes(label), `详情视图缺少 ${label}`);
  assert.match(jsx, /onClick=\{\(\) => setDetailed\(row\)\}/);
  assert.match(jsx, /<dt>编号<\/dt><dd className="audit-code">\{String\(row\.id\)\}<\/dd>/);
});

test('筛选条件由界面到导出保持一致，日期范围校验不放松', () => {
  assert.match(jsx, /auditFiltersActive\(auditFilters\) \? auditFilterSummary\(auditFilters\) : '全部分类、全部时间'/);
  assert.equal(auditFilterSummary({ username: 'admin', start: '2026-10-01', end: '2026-10-31' }), '用户名 含「admin」 · 2026-10-01 至 2026-10-31');
  assert.match(api, /请选择有效的日期范围。|有效的日期范围/);
  assert.match(sql, /raise exception '搜索或分页参数无效'/);
  assert.match(sql, /length\(p_username\)>80/);
  assert.match(sql, /length\(p_ip\)>64/);
});
