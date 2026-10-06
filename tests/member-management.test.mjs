import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isEditable, canEditAttachments } from '../src/workflow-rules.js';
const source = (path) => readFileSync(path, 'utf8');
test('撤回申请可以编辑和再次提交，其他用户和已付款申请仍受保护', () => {
  const owner={profile:{id:'owner'},roles:[]}; const app={owner_id:'owner',status:'cancelled'};
  assert.equal(isEditable(app,owner),true); assert.equal(canEditAttachments(app,owner),true);
  assert.equal(isEditable(app,{profile:{id:'other'},roles:['admin']}),false);
  assert.equal(isEditable({...app,status:'paid'},owner),false);
});
test('admin 保护独立于当前账号，前端不显示修改选项', () => {
  assert.match(source('src/admin.jsx'), /self \|\| protectedAccount/);
  assert.match(source('src/admin.jsx'), /profile.username\?\.toLowerCase\(\) === 'admin'/);
  const sql=source('supabase/member-management-and-resubmission.sql');
  assert.match(sql,/lower\(target_username\)='admin'/);
  for(const table of ['app_users','profiles','user_roles']) assert.ok(sql.includes(`on public.${table} for each row execute function private.protect_builtin_admin()`));
  assert.ok(sql.includes('revoke all on function public.app_list_members'));
});
test('用户列表由服务端搜索筛选分页，不再一次渲染所有用户', () => {
  const jsx=source('src/admin.jsx'); const api=source('supabase/functions/app-api/index.ts');
  for(const label of ['搜索用户','用户角色筛选','账号状态筛选','每页用户数','上一页','下一页']) assert.ok(jsx.includes(label));
  assert.ok(!jsx.includes('data.profiles.map'));
  assert.match(api,/action === 'admin_members'[\s\S]{0,60}requireRole\(actor, 'admin'\)/);
  assert.ok(source('supabase/member-management-and-resubmission.sql').includes('limit p_page_size offset'));
});
test('同一状态下再次提交文件不复用已经提交的草稿，处理阶段切换重置表单', () => {
  const jsx=source('src/workflow.jsx');
  assert.match(jsx,/await request\('submit_file_draft',[^\n]+setDraft\(null\); setRemoved\(\[\]\); setConfirmed\(false\)/);
  assert.ok(jsx.includes('key={`${id}-${application.status}`}'));
});
test('修改密码对所有登录用户可见，不依赖管理员设置', () => {
  const main=source('src/main.jsx'); const admin=source('src/admin.jsx');
  assert.match(main,/view === 'account'/);
  assert.match(main,/>账户设置<\/button>/); // 账户页同时承载邮箱绑定，入口不再只叫修改密码
  assert.match(main,/<h2>修改密码<\/h2>/);
  assert.match(main,/apiRequest\('change_password'/);
  assert.doesNotMatch(admin,/<h2>修改密码<\/h2>/);
});

test('管理员权限不替代财委、主席身份，只有内置 admin 可以跨身份', () => {
  const rules = source('src/workflow-rules.js');
  assert.match(rules, /isSuperAdmin/);
  assert.match(rules, /role !== 'admin' && isSuperAdmin/);
  const api = source('supabase/functions/app-api/index.ts');
  assert.match(api, /role !== 'admin' && isSuperAdmin/);
  const migration = source('supabase/migrations/20261002133000_separate_admin_and_workflow_roles.sql');
  assert.match(migration, /create or replace function private\.app_user_is_superadmin/);
  assert.match(migration, /p_role in \('finance', 'chair', 'cashier'\)/);
});
