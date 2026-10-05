// 在 Node 里真实跑 supabase/functions/app-api/index.ts 的 drainNotifications（邮件队列消费）。
// 只替换外部依赖：Supabase 客户端 → PGlite SQL adapter（真实 PostgreSQL 语义，跑的是同一套迁移/RPC），
// 邮件服务 → 本地假 fetch。路由、原子领取、投递前复核、写回、审计全部走仓库里的真实代码。
// 覆盖维护者复审指出的 P1：领取之后、真正投递之前撤销身份/关闭类型，邮件必须不再寄出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { createSqlStack, rootPath, SQL_STACK_TIMEOUT } from './helpers/sql-stack.mjs';
import { createSqlClient } from './helpers/pglite-supabase-adapter.mjs';

const PROJECT_ROOT = rootPath();
const API_SOURCE = 'supabase/functions/app-api/index.ts';
const API_SOURCE_TEXT = readFileSync(rootPath(API_SOURCE), 'utf8');
const CRON_SECRET = 'test-cron-secret';
const BASE_ENV = {
  SUPABASE_URL: 'http://localhost:8000',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  EMAIL_API_URL: 'http://mail.invalid/send',
  EMAIL_API_KEY: 'test-email-key',
  EMAIL_FROM: 'notify@example.com',
  CRON_SECRET,
};

// handler 在模块求值时就把 NOTIFY_MAX_RUNTIME_MS 算成常量，所以"预算可由环境变量覆盖"要换个变体再 import 一次：
// 同一份 bundle 用不同 query 串形成两个模块实例，一个带 NOTIFY_MAX_RUNTIME_MS=60000、一个不带（走默认值）。
// 环境变量在每次请求前通过 globalThis.__STABX_TEST_ENV__ 注入，因此两个变体共用同一个 stub。
const VARIANTS = {
  default: { env: {} },
  customBudget: { env: { NOTIFY_MAX_RUNTIME_MS: '60000' } },
};

// 生成产物必须落在工作区里：Node 从模块所在目录向上找 node_modules，
// 放进 os.tmpdir() 的话连裸导入都解析不到。
// 用本文件自己的子目录：不能删 tests/.tmp 整个目录（那是共享暂存区，别的进程/测试也在用）。
const BUILD_ROOT = path.join(PROJECT_ROOT, 'tests', '.tmp', 'app-api-notify');
const STUB_FILE = path.join(BUILD_ROOT, 'supabase-js-stub.mjs');
const BUNDLE_FILE = path.join(BUILD_ROOT, 'app-api.bundle.mjs');

const STUB_SOURCE = `// 测试替身：真实 Supabase 客户端换成注入到 globalThis 的 PGlite SQL adapter。
export function createClient() {
  const client = globalThis.__STABX_TEST_CLIENT__;
  if (!client) throw new Error('测试未注入 Supabase 客户端（globalThis.__STABX_TEST_CLIENT__）');
  return client;
}
export default { createClient };
`;

let built;
async function buildHandler() {
  if (built) return built;
  mkdirSync(BUILD_ROOT, { recursive: true });
  // 唯一的依赖导入 from 'npm:@supabase/supabase-js@2' 改写成指向本地 stub 的 file:// URL。
  const code = API_SOURCE_TEXT.replaceAll(
    "from 'npm:@supabase/supabase-js@2'",
    `from ${JSON.stringify(pathToFileURL(STUB_FILE).href)}`,
  );
  assert.ok(!code.includes('npm:@supabase/supabase-js@2'), '唯一的依赖导入必须被改写到本地 stub');
  const { code: bundle } = await transform(code, { loader: 'ts', format: 'esm' });
  await writeFile(STUB_FILE, STUB_SOURCE, 'utf8');
  await writeFile(BUNDLE_FILE, bundle, 'utf8');

  // handler 只依赖 Deno.env.get 与 Deno.serve；serve 把入口交给测试。
  globalThis.Deno = {
    env: { get: (key) => globalThis.__STABX_TEST_ENV__?.[key] ?? '' },
    serve: (handler) => { globalThis.__STABX_HANDLER__ = handler; },
  };
  const variants = {};
  for (const [name, variant] of Object.entries(VARIANTS)) {
    globalThis.__STABX_TEST_ENV__ = { ...BASE_ENV, ...variant.env };
    await import(`${pathToFileURL(BUNDLE_FILE).href}?variant=${name}`);
    const handler = globalThis.__STABX_HANDLER__;
    assert.equal(typeof handler, 'function', `${name} 变体应导出 handler`);
    variants[name] = { handler, env: { ...BASE_ENV, ...variant.env } };
  }
  built = { variants };
  return built;
}

// 生成物用完即删；Windows 上偶发 EPERM（模块文件句柄还没释放），删不掉也无害——目录已在 .gitignore 里。
test.after(() => { try { rmSync(BUILD_ROOT, { recursive: true, force: true }); } catch { /* 留到下次运行覆盖 */ } });

// ---------------------------------------------------------------- 测试夹具与工具

// SQL 栈只建一次（首次约 7 秒），用例之间串行共用同一个内存库；
// 每个用例都用新账号/新申请，互不干扰。
let stackPromise;
const stack = () => { stackPromise ??= createSqlStack(); return stackPromise; };
// 只关真的建起来过的实例（没跑任何用例时不要为了关它反而建一个）。
test.after(async () => { if (stackPromise) await (await stackPromise).db.close(); });

class Fixture {
  constructor(db) {
    this.db = db;
    this.serial = 0;
  }

  async init() {
    const result = await this.db.query("select id from public.app_users where lower(username) = 'admin'");
    assert.equal(result.rows.length, 1, '内置 admin 夹具应存在');
    this.superId = result.rows[0].id;
    // 把上一个用例留下的库状态清干净：
    // 入队是真库触发器做的，而触发器会给"所有仍有对应身份且绑了邮箱的 active 账号"各插一行，
    // 所以上个用例的财委/主席会跟着这个用例的申请一起入队。停用它们（不改角色，便于复用），
    // 再清掉待发/发送中的队列，每个用例就只会在自己的申请上看到自己造出来的行。
    await this.db.query("update public.app_users set active = false where id <> $1 and active", [this.superId]);
    await this.db.query("delete from public.notifications where status in ('pending', 'sending')");
    return this;
  }

  async user(label, { email = '', roles = [] } = {}) {
    const username = `api_${label}_${Date.now().toString(36)}_${this.serial++}`;
    const result = await this.db.query(
      "select (private.app_insert_user($1, 'Test-only-1369666', $2, '验证组') ->> 'id')::uuid as id",
      [username, label],
    );
    const id = result.rows[0]?.id;
    assert.ok(id, `夹具建号失败：${label}`);
    if (email) await this.db.query('select public.app_bind_email($1, $1, $2)', [id, email]);
    if (roles.length) {
      await this.db.query('select public.app_set_member_roles($1, $2, $3::text[], true)', [this.superId, id, roles]);
    }
    return id;
  }

  // 建申请；不传 status 就是 draft（不触发入队），之后由用例 update 成目标状态。
  async application(ownerId, { title = '端到端邮件提醒', amount = 128.5, status = 'draft', version = 0 } = {}) {
    const result = await this.db.query(
      `insert into public.applications(owner_id, title, purpose, amount, category, department, use_date, status, version)
       values ($1, $2, '仅用于 handler 测试', $3, '物资', '验证组', current_date, $4, $5) returning id`,
      [ownerId, title, amount, status, version],
    );
    return result.rows[0].id;
  }

  async setStatus(applicationId, status, version = 1) {
    await this.db.query('update public.applications set status = $2, version = $3 where id = $1', [applicationId, status, version]);
  }

  async notification(applicationId, event = null) {
    const result = await this.db.query(
      `select id, status, event, recipient_user_id, application_version, attempts, last_error, claim_id, sent_at
         from public.notifications
        where application_id = $1 and ($2::text is null or event = $2)
        order by id`,
      [applicationId, event],
    );
    return { rows: result.rows, row: result.rows[0] };
  }

  async latestAudit(event) {
    const result = await this.db.query(
      'select id, actor_id, event, detail, metadata, created_at from public.audit_logs where event = $1 order by id desc limit 1',
      [event],
    );
    return result.rows[0];
  }

  async setEmailNotify(enabled, events) {
    await this.db.query('select public.app_update_email_notify($1, $2, $3::text[])', [this.superId, enabled, events]);
  }
}

// 假邮件服务：只记录投递内容，返回 200，不发任何网络请求。
function captureEmails() {
  const originalFetch = globalThis.fetch;
  const emails = [];
  globalThis.fetch = async (url, options = {}) => {
    emails.push({ url: String(url), headers: options.headers ?? {}, ...JSON.parse(String(options.body ?? '{}')) });
    return new Response('ok', { status: 200 });
  };
  return { emails, restore: () => { globalThis.fetch = originalFetch; } };
}

// 走定时任务入口（x-app-cron），handle() 会调用同一个 drainNotifications(null)。
// 注意 extraEnv 只在每次请求前注入 Deno.env：对 APP_URL / CRON_SECRET 这类"每次读取"的变量有效；
// 模块级常量（NOTIFY_MAX_RUNTIME_MS、NOTIFY_* 预算）在 import 时就固化了，改它们必须换 variant。
async function drain(client, { variant = 'default', extraEnv = {} } = {}) {
  const { variants } = await buildHandler();
  const { handler, env } = variants[variant];
  const mail = captureEmails();
  const originalClient = globalThis.__STABX_TEST_CLIENT__;
  globalThis.__STABX_TEST_CLIENT__ = client;
  globalThis.__STABX_TEST_ENV__ = { ...env, ...extraEnv };
  try {
    const request = new Request('http://localhost/functions/v1/app-api', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-cron': CRON_SECRET },
      body: JSON.stringify({ action: 'send_notifications' }),
    });
    const response = await handler(request);
    return { status: response.status, payload: await response.json(), emails: mail.emails };
  } finally {
    mail.restore();
    globalThis.__STABX_TEST_CLIENT__ = originalClient;
  }
}

const DEFAULT_EVENTS = ['待财委审批', '待主席审批', '退回修改', '待补充收款码', '待付款登记'];

// ---------------------------------------------------------------- 用例

test('基线：开关打开、财委绑了邮箱、申请待财委审批 → 定时任务真的寄出 1 封并写回 sent', { timeout: SQL_STACK_TIMEOUT }, async () => {
  const { db } = await stack();
  const fixture = await new Fixture(db).init();
  const client = createSqlClient(db);

  await fixture.setEmailNotify(true, DEFAULT_EVENTS);
  const owner = await fixture.user('owner_baseline', { email: 'baseline-owner@example.com' });
  const finance = await fixture.user('finance_baseline', { email: 'baseline-finance@example.com', roles: ['finance'] });
  const applicationId = await fixture.application(owner, { title: '基线邮件提醒', amount: 128.5 });
  await fixture.setStatus(applicationId, 'finance_pending', 1);

  const queued = await fixture.notification(applicationId);
  assert.equal(queued.rows.length, 1, '待财委审批应在队列里生成 1 行');
  assert.equal(queued.row.status, 'pending');
  assert.equal(queued.row.recipient_user_id, finance);

  const result = await drain(client);
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.error, null);
  assert.equal(result.payload.data.sent, 1, `应寄出 1 封，实际 ${JSON.stringify(result.payload.data)}`);
  assert.equal(result.payload.data.cancelled, 0);
  assert.equal(result.emails.length, 1, '假邮件服务应收到 1 封');
  assert.equal(result.emails[0].to, 'baseline-finance@example.com');
  assert.match(result.emails[0].subject, /待财委审批/);
  assert.match(result.emails[0].html, /基线邮件提醒/);
  assert.match(result.emails[0].html, /128\.50/, '邮件正文应含申请金额');

  const after = await fixture.notification(applicationId);
  assert.equal(after.row.status, 'sent');
  assert.ok(after.row.sent_at, 'sent_at 应写入');
  // 终态必须把批次号清掉：cancelled/failed/pending 分支都显式清了，sent 分支原来漏了（handler 运行时测试发现）。
  assert.equal(after.row.claim_id, null, 'sent 行应释放批次号');
});

test('P1 复现：领取之后、投递之前撤销财委身份 → sent: 0、行变 cancelled（handler 确实调用 app_notify_blocked_rows）', { timeout: SQL_STACK_TIMEOUT }, async () => {
  const { db } = await stack();
  const fixture = await new Fixture(db).init();
  const client = createSqlClient(db);

  await fixture.setEmailNotify(true, DEFAULT_EVENTS);
  const owner = await fixture.user('owner_revoke', { email: 'revoke-owner@example.com' });
  const finance = await fixture.user('finance_revoke', { email: 'revoke-finance@example.com', roles: ['finance'] });
  const applicationId = await fixture.application(owner, { title: '撤角色后不应寄出' });
  await fixture.setStatus(applicationId, 'finance_pending', 1);

  const queued = await fixture.notification(applicationId);
  assert.equal(queued.rows.length, 1);
  assert.equal(queued.row.status, 'pending');

  // adapter 钩子：app_claim_notifications 的 RPC 返回之后、handler 读取收件人之前撤销 finance 角色——
  // 这正是复审指出的窗口（领取时判定为合格，投递前身份已经没了）。
  // drain 在每组之前都重新领取，所以会有第二轮"空领取"；这里记录每轮领到几行，只认第一轮。
  const claims = [];
  const originalRpc = client.rpc.bind(client);
  client.rpc = async (name, args) => {
    const result = await originalRpc(name, args);
    if (name === 'app_claim_notifications') {
      claims.push(result.data?.rows?.length ?? 0);
      if (claims.length === 1) {
        assert.equal((await fixture.notification(applicationId)).row.status, 'sending', '钩子必须发生在领取之后');
        await db.query('select public.app_set_member_roles($1, $2, $3::text[], true)', [fixture.superId, finance, []]);
      }
    }
    return result;
  };

  const result = await drain(client);
  assert.deepEqual(claims, [1, 0], `第一轮应领到 1 行、第二轮队列应已空，实际每轮领到 ${JSON.stringify(claims)}`);
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.data.sent, 0, '身份已被撤销，不能再寄出财务详情');
  assert.equal(result.payload.data.cancelled, 1, `应计 1 封作废，实际 ${JSON.stringify(result.payload.data)}`);
  assert.equal(result.emails.length, 0, '假邮件服务不应收到任何邮件');

  const after = await fixture.notification(applicationId);
  assert.equal(after.row.status, 'cancelled');
  assert.match(after.row.last_error, /不具备该待办的处理身份/);
  assert.equal(after.row.claim_id, null);

  // 字符串断言：这条用例抓的是"handler 在每个发送组之前调用复核 RPC"这个行为。
  // 去掉那次调用（见报告里的临时验证）后，上面的 sent:0 / emails:0 断言就会失败。
  assert.match(API_SOURCE_TEXT, /rpc\('app_notify_blocked_rows'/, 'handler 必须在投递前调用 app_notify_blocked_rows');
  assert.match(API_SOURCE_TEXT, /const recheckGroup = async/, '投递前复核应集中在 recheckGroup');
});

test('领取之后关闭「待财委审批」提醒 → sent: 0、行变 cancelled 且原因含"已关闭"', { timeout: SQL_STACK_TIMEOUT }, async () => {
  const { db } = await stack();
  const fixture = await new Fixture(db).init();
  const client = createSqlClient(db);

  await fixture.setEmailNotify(true, DEFAULT_EVENTS);
  const owner = await fixture.user('owner_type_off', { email: 'type-off-owner@example.com' });
  const finance = await fixture.user('finance_type_off', { email: 'type-off-finance@example.com', roles: ['finance'] });
  const applicationId = await fixture.application(owner, { title: '关掉类型后不应寄出' });
  await fixture.setStatus(applicationId, 'finance_pending', 1);

  const queued = await fixture.notification(applicationId);
  assert.equal(queued.rows.length, 1);
  assert.equal(queued.row.status, 'pending');
  assert.equal(queued.row.recipient_user_id, finance);

  // 管理员在领取之后关掉该类提醒：只留另外四类待办。
  const claims = [];
  const originalRpc = client.rpc.bind(client);
  client.rpc = async (name, args) => {
    const result = await originalRpc(name, args);
    if (name === 'app_claim_notifications') {
      claims.push(result.data?.rows?.length ?? 0);
      if (claims.length === 1) {
        await db.query('select public.app_update_email_notify($1, true, $2::text[])', [
          fixture.superId, ['待主席审批', '退回修改', '待补充收款码', '待付款登记'],
        ]);
      }
    }
    return result;
  };

  const result = await drain(client);
  assert.deepEqual(claims, [1, 0], `第一轮应领到 1 行、第二轮队列应已空，实际每轮领到 ${JSON.stringify(claims)}`);
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.data.sent, 0, '类型已关闭，不能再寄出');
  assert.equal(result.payload.data.cancelled, 1, `应计 1 封作废，实际 ${JSON.stringify(result.payload.data)}`);
  assert.equal(result.emails.length, 0);

  const after = await fixture.notification(applicationId);
  assert.equal(after.row.status, 'cancelled');
  assert.match(after.row.last_error, /已关闭/);
  assert.match(after.row.last_error, /待财委审批/);
  assert.equal(after.row.claim_id, null);
});

test('消费预算可由 NOTIFY_MAX_RUNTIME_MS 覆盖并写进审计，默认值低于 150 秒', { timeout: SQL_STACK_TIMEOUT }, async () => {
  const { db } = await stack();
  const fixture = await new Fixture(db).init();
  const client = createSqlClient(db);

  await fixture.setEmailNotify(true, ['待财委审批']);
  const result = await drain(client, { variant: 'customBudget', extraEnv: { NOTIFY_MAX_RUNTIME_MS: '60000' } });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.error, null);

  const audit = await fixture.latestAudit('发送邮件提醒');
  assert.ok(audit, '消费结束应写一条「发送邮件提醒」审计');
  assert.equal(audit.actor_id, null, '定时任务入口的 actor 为空');
  assert.match(audit.detail, /预算 60 秒/, `审计应记下环境变量覆盖后的预算，实际：${audit.detail}`);
  assert.match(audit.detail, /定时任务处理/);
  assert.match(audit.detail, /已开启提醒类型 1 类/);

  // 默认预算必须明显低于平台 150 秒墙钟：从源码读常量，不靠计时（避免脆弱）。
  const match = API_SOURCE_TEXT.match(/const NOTIFY_DEFAULT_RUNTIME_MS = (\d+)/);
  assert.ok(match, '源码里应有 NOTIFY_DEFAULT_RUNTIME_MS 常量');
  const defaultRuntimeMs = Number(match[1]);
  assert.ok(defaultRuntimeMs > 0, '默认预算应为正数');
  assert.ok(defaultRuntimeMs < 150000, `默认预算 ${defaultRuntimeMs}ms 必须低于 150 秒`);
  // 下限必须高于"一组 + 收尾"，否则每轮会在第一组之前退出、一封都发不出去。
  // 数字全部从源码常量推出（不抄硬编码），并确认停止阈值用的就是这两个余量。
  const sendTimeout = Number(API_SOURCE_TEXT.match(/const NOTIFY_SEND_TIMEOUT_MS = (\d+)/)[1]);
  const groupBudget = sendTimeout + 5000;
  const wrapupBudget = Number(API_SOURCE_TEXT.match(/const NOTIFY_WRAPUP_BUDGET_MS = (\d+)/)[1]);
  const minRuntime = groupBudget + wrapupBudget + sendTimeout;
  assert.match(API_SOURCE_TEXT, /const NOTIFY_MIN_RUNTIME_MS = NOTIFY_GROUP_BUDGET_MS \+ NOTIFY_WRAPUP_BUDGET_MS \+ NOTIFY_SEND_TIMEOUT_MS/);
  assert.match(API_SOURCE_TEXT, /if \(timeLeft\(\) < NOTIFY_GROUP_BUDGET_MS \+ NOTIFY_WRAPUP_BUDGET_MS\) break/);
  assert.ok(minRuntime > groupBudget + wrapupBudget, `下限 ${minRuntime}ms 必须严格大于阈值 ${groupBudget + wrapupBudget}ms，否则第一组之前就退出`);
  assert.ok(defaultRuntimeMs > minRuntime, `默认预算 ${defaultRuntimeMs}ms 必须大于下限 ${minRuntime}ms`);
  assert.ok(minRuntime < 150000, `下限 ${minRuntime}ms 也必须留在免费方案 150 秒墙钟之内`);
  // 上限必须留在租约上限之内，否则本轮最先领取的行会在中途被别的批次抢走（可能重复投递）。
  const limitRuntimeMs = Number(API_SOURCE_TEXT.match(/const NOTIFY_MAX_RUNTIME_LIMIT_MS = (\d+)/)[1]);
  const leaseLimitSeconds = Number(API_SOURCE_TEXT.match(/const NOTIFY_LEASE_LIMIT_SECONDS = (\d+)/)[1]);
  assert.equal(leaseLimitSeconds, 900, '租约上限应与 app_claim_notifications 的取值上限一致');
  assert.ok(limitRuntimeMs / 1000 + 60 <= leaseLimitSeconds, `预算上限 ${limitRuntimeMs}ms 派生出的租约必须不超过 ${leaseLimitSeconds}s`);
  assert.match(API_SOURCE_TEXT, /const NOTIFY_LEASE_SECONDS = Math\.min\(NOTIFY_LEASE_LIMIT_SECONDS, Math\.max\(300, Math\.ceil\(NOTIFY_MAX_RUNTIME_MS \/ 1000\) \+ 60\)\)/);
});

test('投递前复核接口失败时不烧队列：本组退回 pending、写审计，不累加尝试次数', { timeout: SQL_STACK_TIMEOUT }, async () => {
  const { db } = await stack();
  const fixture = await new Fixture(db).init();
  const client = createSqlClient(db);
  // 只让 app_notify_blocked_rows 出错（模拟 PostgREST schema 缓存未刷新/暂时不可用），其余 RPC 正常。
  const brokenClient = {
    ...client,
    rpc: (name, args) => (name === 'app_notify_blocked_rows'
      ? Promise.resolve({ data: null, error: { message: 'PGRST002 could not query the database for the schema cache' } })
      : client.rpc(name, args)),
  };

  await fixture.setEmailNotify(true, DEFAULT_EVENTS);
  const owner = await fixture.user('owner_recheck_fail', { email: 'recheck-owner@example.com' });
  const finance = await fixture.user('finance_recheck_fail', { email: 'recheck-finance@example.com', roles: ['finance'] });
  const applicationId = await fixture.application(owner, { title: '复核接口挂了也不能烧队列' });
  await fixture.setStatus(applicationId, 'finance_pending', 1);
  assert.equal((await fixture.notification(applicationId)).rows.length, 1, '待财委审批应在队列里生成 1 行');

  const result = await drain(brokenClient);
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.error, null);
  assert.equal(result.payload.data.sent, 0, '复核失败时不能寄出任何邮件');
  assert.equal(result.emails.length, 0);
  assert.ok(result.payload.data.recheck_failed >= 1, `应记录复核失败次数，实际 ${JSON.stringify(result.payload.data)}`);

  const after = await fixture.notification(applicationId);
  assert.equal(after.row.status, 'pending', '被复核失败挡住的行必须退回队列，不能卡在 sending');
  assert.equal(after.row.claim_id, null, '退回后应释放批次号');
  assert.equal(after.row.attempts, 0, '这是基础设施故障，不能消耗投递尝试次数');
  assert.match(after.row.last_error, /投递前复核暂时失败/);

  const audit = await fixture.latestAudit('发送邮件提醒');
  assert.ok(audit, '复核失败也要写审计，否则日志里什么都看不到');
  assert.match(audit.detail, /投递前复核失败 1 组/);
  assert.equal(after.row.recipient_user_id, finance, '退回的那一行仍指向原来的收件人');
});

test('结果通知开关：拒绝申请未勾选时入队被拒，勾选后出现该行', { timeout: SQL_STACK_TIMEOUT }, async () => {
  const { db } = await stack();
  const fixture = await new Fixture(db).init();

  const owner = await fixture.user('owner_rejected', { email: 'rejected-owner@example.com' });
  const applicationId = await fixture.application(owner, { title: '结果通知开关' });

  // 未勾选：状态改为 rejected 不入队（finance_pending 那一步生成的「待财委审批」行与本次断言无关）。
  await fixture.setEmailNotify(true, ['待财委审批']);
  await fixture.setStatus(applicationId, 'finance_pending', 1);
  await fixture.setStatus(applicationId, 'rejected', 1);
  assert.equal((await fixture.notification(applicationId, '拒绝申请')).rows.length, 0, '未勾选「拒绝申请」时不应入队');

  // 勾选「拒绝申请」：之后的状态变化才入队。
  await fixture.setEmailNotify(true, ['待财委审批', '拒绝申请']);
  await fixture.setStatus(applicationId, 'draft', 2);
  await fixture.setStatus(applicationId, 'rejected', 2);
  const queued = await fixture.notification(applicationId, '拒绝申请');
  assert.equal(queued.rows.length, 1, '勾选后应出现「拒绝申请」提醒');
  assert.equal(queued.row.event, '拒绝申请');
  assert.equal(queued.row.recipient_user_id, owner);
  assert.equal(queued.row.application_version, 2);
  assert.equal(queued.row.status, 'pending');
});
