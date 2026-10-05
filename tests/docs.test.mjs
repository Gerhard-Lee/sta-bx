import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { NOTIFY_EVENTS } from '../src/notify-rules.js';
import { ROLE_LABEL } from '../src/reporting.js';

const read = (path) => readFileSync(path, 'utf8');
const doc = (name) => read(`docs/${name}`);
const DOC_FILES = ['README.md', 'architecture.md', 'data-model.md', 'workflow.md', 'roles-and-permissions.md', 'notifications.md', 'database-migrations.md', 'testing.md', 'deployment.md', 'decisions.md', 'known-issues.md'];

test('文档集完整，索引里的每个链接都指向存在的文件', () => {
  for (const name of DOC_FILES) assert.ok(existsSync(`docs/${name}`), `缺少 docs/${name}`);
  const index = doc('README.md');
  for (const name of DOC_FILES.filter((item) => item !== 'README.md')) assert.ok(index.includes(`(${name})`), `docs/README.md 没有索引 ${name}`);
  assert.ok(read('README.md').includes('docs/README.md'), '根 README 没有指向文档目录');
});
test('文档里的相对链接与反引号路径都真实存在', () => {
  for (const name of DOC_FILES) {
    const text = doc(name);
    for (const match of text.matchAll(/\]\((?!https?:)([^)#]+)/g)) {
      const target = match[1];
      const resolved = target.startsWith('../') ? target.slice(3) : `docs/${target}`;
      assert.ok(existsSync(resolved), `${name} 的链接不存在：${target}`);
    }
    for (const match of text.matchAll(/`((?:supabase|src|deploy|scripts|tests|docs)\/[^`\s*?]+?\.(?:ts|js|jsx|mjs|sql|md|sh|json|yml|cron))`/g)) {
      assert.ok(existsSync(match[1]), `${name} 提到的路径不存在：${match[1]}`);
    }
  }
});
test('带 #小节 的链接指向真实存在的小节（锚点不再失效）', () => {
  const flatten = (value) => value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  let checked = 0;
  for (const name of DOC_FILES) {
    for (const match of doc(name).matchAll(/\]\(((?:docs\/)?[a-z-]+\.md)#([^)]+)\)/g)) {
      const target = match[1].startsWith('docs/') ? match[1] : `docs/${match[1]}`;
      assert.ok(existsSync(target), `${name} 的锚点链接指向不存在的文件：${match[1]}`);
      const wanted = flatten(decodeURIComponent(match[2]));
      const headings = [...doc(target.slice('docs/'.length)).matchAll(/^#{1,6}\s+(.+)$/gm)].map((item) => item[1]);
      assert.ok(headings.some((heading) => flatten(heading).includes(wanted)), `${name} 的锚点 #${match[2]} 在 ${match[1]} 里找不到对应小节`);
      checked += 1;
    }
  }
  assert.ok(checked >= 1, '至少应检查到一个带锚点的链接（否则说明锚点都没有了或被改成了纯文件链接）');
});
test('通知文档的事件清单与代码里的完全一致，并说明哪些状态不发信', () => {
  const text = doc('notifications.md');
  for (const event of NOTIFY_EVENTS) assert.ok(text.includes(event), `通知文档缺少事件：${event}`);
  assert.equal(NOTIFY_EVENTS.length, 7);
  for (const skipped of ['`rejected`', '`paid`', '不发']) assert.ok(text.includes(skipped.replace(/`/g, '`')), `通知文档没有说明不发信的情况：${skipped}`);
  for (const key of ['EMAIL_API_URL', 'EMAIL_API_KEY', 'EMAIL_FROM', 'APP_URL', 'CRON_SECRET', 'NOTIFY_MAX_RUNTIME_MS']) assert.ok(text.includes(key), `通知文档缺少密钥：${key}`);
  // 七类里哪些默认开、哪些默认关，以及"交给管理员配置"这件事必须在文档里说清。
  for (const needed of ['settings.email_notify_events', '默认', '管理员']) assert.ok(text.includes(needed), `通知文档缺少配置说明：${needed}`);
});
test('权限文档覆盖界面能分配的身份，并点出无法分配的 cashier', () => {
  const text = doc('roles-and-permissions.md');
  for (const [role, label] of Object.entries(ROLE_LABEL)) assert.ok(text.includes(role) && text.includes(label), `权限文档缺少身份 ${role}/${label}`);
  assert.ok(text.includes('cashier'));
  assert.ok(text.includes('app_user_has_role'), '权限文档必须说明数据库层判定入口');
  assert.ok(text.includes('不能处理自己'), '权限文档必须写明申请人不能处理自己的申请');
});
test('迁移文档列出全部现存迁移与散装 SQL', () => {
  const text = doc('database-migrations.md');
  const files = readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql'));
  assert.ok(files.length >= 8, '迁移目录内容异常');
  for (const name of files) assert.ok(text.includes(name.replace(/\.verify\.sql$/, '').replace(/\.sql$/, '')), `迁移文档缺少 ${name}`);
  for (const loose of ['admin-settings-audit.sql', 'member-management-and-resubmission.sql', 'detailed-file-and-review-audit.sql', 'explicit-submission.sql']) assert.ok(text.includes(loose), `迁移文档缺少散装 SQL ${loose}`);
  assert.ok(text.includes('to_regprocedure'), '迁移文档必须说明 fail-fast 依赖检查');
  assert.ok(text.includes('.verify.sql'), '迁移文档必须说明 verify 约定');
});
test('数据模型文档写清状态机与队列去重键', () => {
  const text = doc('data-model.md');
  for (const status of ['draft', 'finance_pending', 'chair_pending', 'changes_requested', 'rejected', 'payment_info_required', 'payment_pending', 'paid', 'cancelled']) assert.ok(text.includes(`\`${status}\``), `状态机缺少 ${status}`);
  for (const column of ['application_id, application_version, event, recipient_user_id', 'rule_threshold', 'lease_expires_at', 'claim_id']) assert.ok(text.includes(column), `数据模型文档缺少 ${column}`);
  for (const state of ['pending', 'sending', 'sent', 'failed', 'cancelled']) assert.ok(text.includes(state));
});
test('部署文档给出凭据归属，并承诺仓库零密钥', () => {
  const text = doc('deployment.md');
  for (const needed of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'CRON_SECRET', 'SMTP_PASS', 'RELAY_TOKEN', 'stabx.email_cron']) assert.ok(text.includes(needed), `部署文档缺少 ${needed}`);
  assert.ok(text.includes('465'), '部署文档必须写明 SMTP 用 465（25 在云上受限）');
  for (const path of ['deploy/README.md', 'deploy/drain.sh', 'deploy/check.sh', 'deploy/mail-relay/index.mjs']) assert.ok(existsSync(path), `部署文档引用的文件不存在：${path}`);
});
test('决策与已知问题不是空壳', () => {
  const decisions = doc('decisions.md');
  assert.ok((decisions.match(/^## /gm) ?? []).length >= 10, '决策记录太少');
  for (const topic of ['自研账号', '唯一数据入口', 'PL/pgSQL', 'rule_threshold', '租约', 'at-least-once', '中文', 'pg_cron', 'fail-fast']) assert.ok(decisions.includes(topic), `决策记录缺少：${topic}`);
  const issues = doc('known-issues.md');
  assert.ok((issues.match(/^## \d+ /gm) ?? []).length >= 8, '已知问题太少');
  for (const topic of ['cashier', 'verify-react-regressions', 'profiles.length', '绑定邮箱', 'CI', 'POSIX sh']) assert.ok(issues.includes(topic), `已知问题缺少：${topic}`);
});
test('架构文档描述的分层与真实代码一致', () => {
  const text = doc('architecture.md');
  assert.ok(read('src/api.js').includes('fetch'), 'api.js 仍是 fetch 实现，架构描述要同步');
  assert.equal(read('src/api.js').includes('@supabase/supabase-js'), false, '前端确实不引入 supabase-js');
  for (const needed of ['x-app-session', 'createSignedUrl', 'decorate_audit_log', 'gen_salt', 'SHA-256', 'Asia/Shanghai', 'export-templates']) assert.ok(text.includes(needed), `架构文档缺少：${needed}`);
});
test('文档里不出现真实密钥、真实邮箱或长随机串', () => {
  for (const name of DOC_FILES) {
    const text = doc(name);
    assert.equal(/[\w.+-]+@(qq|163)\.com/.test(text), false, `${name} 里出现了真实邮箱`);
    assert.equal(/(sk|key|token|secret)[=:]\s*['"]?[A-Za-z0-9_-]{28,}/i.test(text), false, `${name} 里出现了像真密钥的串`);
    assert.equal(text.includes('sb_secret_'), false, `${name} 里出现了 service role key`);
  }
});
