import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeEmail, validateEmail, NOTIFY_EVENTS, NOTIFY_QUEUE, EMAIL_PATTERN, EMAIL_MAX } from '../src/notify-rules.js';

const source = (path) => readFileSync(path, 'utf8');
const migration = source('supabase/migrations/20261004210000_email_notify.sql');
const verify = source('supabase/migrations/20261004210000_email_notify.verify.sql');
const cron = source('supabase/migrations/20261005140000_email_notify_cron.sql');
const cronVerify = source('supabase/migrations/20261005140000_email_notify_cron.verify.sql');
const api = source('supabase/functions/app-api/index.ts');
const main = source('src/main.jsx');
const admin = source('src/admin.jsx');
const readme = source('README.md');
const EMAIL_CORE = '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$';
const slice = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `找不到起点：${from}`);
  const end = text.indexOf(to, start);
  assert.ok(end > start, `找不到终点：${to}`);
  return text.slice(start, end);
};
// 从 app-api 源码里读出“事件 → 仍然要处理的状态”映射，用来和数据库触发器逐项比对。
const NOTIFY_EVENT_STATUS_FROM_API = () => {
  const block = slice(api, 'const NOTIFY_EVENT_STATUS: Record<string, string> = {', '}');
  return [...block.matchAll(/'([^']+)': '([^']+)'/g)].map((match) => [match[1], match[2]]);
};

test('邮箱统一去空格转小写，空值表示解绑', () => {
  assert.equal(normalizeEmail('  Verify-Notify@Example.COM '), 'verify-notify@example.com');
  assert.equal(normalizeEmail(null), '');
});
test('邮箱校验只接受规范格式且长度受限', () => {
  assert.equal(validateEmail('a@b.cn'), '');
  assert.equal(validateEmail('  A.B+C@Sub.Domain.COM '), '');
  assert.match(normalizeEmail('A@B.CN'), EMAIL_PATTERN);
  assert.notEqual(validateEmail(''), '');
  assert.notEqual(validateEmail('not-an-email'), '');
  assert.notEqual(validateEmail('a@b'), '');
  assert.notEqual(validateEmail('a@b.c'), '');
  assert.notEqual(validateEmail(`${'x'.repeat(EMAIL_MAX)}@b.cn`), '');
});
test('数据库邮箱规则与前端一致：254 长度和同一邮箱形态', () => {
  assert.ok(migration.includes('char_length(email) <= 254'));
  assert.ok(migration.includes(EMAIL_CORE));
  assert.equal(EMAIL_PATTERN.source, `^${EMAIL_CORE}`);
  assert.equal((migration.match(/~\* '\^\[a-z0-9\._%\+\-\]\+@/g) ?? []).length, 3);
  assert.match(migration, /app_bind_email\(p_actor_id uuid, p_user_id uuid, p_email text\)[\s\S]{0,600}normalized !~\* '\^\[a-z0-9\._%\+\-\]\+@/);
});
test('邮件通知总开关默认关闭，且关闭时触发器不入队', () => {
  assert.match(migration, /email_notify_enabled boolean not null default false/);
  assert.match(migration, /if not exists\(select 1 from public\.settings where id = 1 and email_notify_enabled\) then return null/);
  assert.match(verify, /开关关闭时不应生成队列记录/);
});
test('只有“需要动手”的五类事件会发信，完结态不映射', () => {
  assert.deepEqual(NOTIFY_EVENTS, ['待财委审批', '待主席审批', '退回修改', '待补充收款码', '待付款登记']);
  const mapping = slice(migration, 'target_event := case new.status', 'else null end');
  assert.equal((mapping.match(/when '/g) ?? []).length, 5);
  for (const done of ['rejected', 'paid', 'cancelled', 'draft']) assert.equal(new RegExp(`when '${done}' then`).test(migration), false, `完结态 ${done} 不应该映射成邮件事件`);
  const sqlEvents = [...migration.matchAll(/when '(?:finance_pending|chair_pending|changes_requested|payment_info_required|payment_pending)' then '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(sqlEvents, NOTIFY_EVENTS);
  const apiSlice = slice(api, 'const NOTIFY_EVENTS', 'const STATUS_LABELS');
  const apiEvents = [...apiSlice.matchAll(/'([^']+)': '/g)].map((m) => m[1]);
  assert.deepEqual(apiEvents, NOTIFY_EVENTS);
  const checkEvents = [...migration.matchAll(/event text not null check \(event in \(([^)]+)\)/g)][0][1];
  assert.deepEqual(checkEvents.split(',').map((item) => item.trim().replaceAll("'", '')), NOTIFY_EVENTS);
  assert.match(verify, /退回修改应提醒申请人本人/);
  assert.match(verify, /待补充收款码应提醒申请人本人/);
  assert.match(verify, /完结态不应生成队列记录/);
});
test('收件人由服务端按状态推导：审批事件给对应角色且跳过申请人本人', () => {
  assert.match(migration, /when '待财委审批' then u\.id <> new\.owner_id and private\.app_user_has_role\(u\.id, 'finance'\)/);
  assert.match(migration, /when '待主席审批' then u\.id <> new\.owner_id and private\.app_user_has_role\(u\.id, 'chair'\)/);
  assert.match(migration, /when '待付款登记' then u\.id <> new\.owner_id and private\.app_user_has_role\(u\.id, 'cashier'\)/);
  // 退回修改与待补充收款码是“申请人要动手”，只发给本人；三类审批/付款待办都必须排除申请人。
  assert.match(migration, /else u\.id = new\.owner_id/);
  assert.equal((migration.match(/u\.id <> new\.owner_id/g) ?? []).length, 3);
  assert.match(migration, /where u\.active\s+and coalesce\(u\.email, ''\) <> ''/);
  // 身份含义变化（例如付款登记视同财委）只需要改 private.app_user_has_role，这里必须继续走同一个判定函数。
  assert.equal((migration.match(/private\.app_user_has_role\(u\.id/g) ?? []).length, 3);
  assert.equal(/from public\.user_roles\s+where user_id = u\.id/.test(migration), false);
});
test('同一申请同一版本同一事件同一收件人只保留一封待发邮件，已作废的不占名额', () => {
  assert.match(migration, /create unique index if not exists notifications_dedupe_idx\s+on public\.notifications\(application_id, application_version, event, recipient_user_id\)\s+where status <> 'cancelled'/);
  assert.match(migration, /on conflict \(application_id, application_version, event, recipient_user_id\) where status <> 'cancelled' do nothing/);
  assert.match(verify, /同一版本同一事件应只保留一封/);
  assert.match(verify, /新版本应重新入队/);
});
test('收款码被移除会作废本轮的待付款登记提醒，重新提交后可以再次提醒', () => {
  // 触发器：离开 payment_pending 且回到“待补充收款码”时，把这一版的待付款登记提醒标记为 cancelled。
  assert.match(migration, /if old\.status = 'payment_pending' and new\.status = 'payment_info_required' then/);
  assert.match(migration, /set status = 'cancelled', claim_id = null, lease_expires_at = now\(\)/);
  assert.match(migration, /收款信息已变更，本次待付款登记提醒作废/);
  assert.match(migration, /event = '待付款登记' and status <> 'cancelled'/);
  assert.match(verify, /移除收款码应作废本轮的待付款登记提醒/);
  assert.match(verify, /重新提交收款码后应再次入队/);
});
test('后端绑定邮箱只写入当前账号，请求体与数据库层都不接受替别人绑定', () => {
  assert.match(api, /action === 'bind_email'[\s\S]{0,240}p_actor_id: actor\.user\.id, p_user_id: actor\.user\.id, p_email/);
  assert.equal(/action === 'bind_email'[\s\S]{0,320}body\.user_id/.test(api), false);
  assert.match(migration, /app_bind_email\(p_actor_id uuid, p_user_id uuid, p_email text\)[\s\S]{0,900}where id = p_user_id and active/);
  assert.match(migration, /if p_actor_id is null or p_user_id is null or p_actor_id <> p_user_id then raise exception '只能绑定自己的邮箱'; end if;/);
  assert.ok(verify.includes("perform public.app_bind_email(new_id, new_id, 'not-an-email')"));
  assert.match(verify, /替别人绑定邮箱应被拒绝/);
});
test('审计与队列记录都不落邮箱地址', () => {
  assert.match(migration, /'绑定邮箱', case when normalized = '' then '清除邮箱' else '邮箱已更新' end/);
  const bindSlice = slice(migration, 'public.app_bind_email(p_actor_id', 'public.app_update_email_notify');
  const auditLine = bindSlice.slice(bindSlice.indexOf('insert into public.audit_logs'));
  assert.equal(auditLine.includes('||'), false);
  assert.equal(/create table if not exists public\.notifications\([\s\S]{0,900}email/.test(migration), false);
});
test('邮件正文只含申请可见字段与入口链接，不含令牌或附件地址', () => {
  const builder = slice(api, 'function buildNotifyEmail', "const bucket = 'application-files'");
  for (const field of ['申请标题', '金额', '部门 / 活动', '费用类别', '申请人', '当前状态']) assert.ok(builder.includes(`['${field}'`), `正文缺少 ${field}`);
  for (const banned of ['storage_path', 'token', 'signedUrl', 'file.', 'mime']) assert.equal(builder.includes(banned), false, `正文不应出现 ${banned}`);
  assert.match(api, /escapeHtml\(appUrl\)/);
  assert.match(api, /await audit\(actorId, '发送邮件提醒'/);
});
test('队列消费参数在前端、后端与数据库取值范围三方一致', () => {
  assert.match(api, new RegExp(`const NOTIFY_BATCH = ${NOTIFY_QUEUE.batch}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_ROUNDS = ${NOTIFY_QUEUE.rounds}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_CONCURRENCY = ${NOTIFY_QUEUE.concurrency}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_SEND_TIMEOUT_MS = ${NOTIFY_QUEUE.sendTimeoutMs}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_LEASE_SECONDS = ${NOTIFY_QUEUE.leaseSeconds}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_MAX_AGE_HOURS = ${NOTIFY_QUEUE.maxAgeHours}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_MAX_ATTEMPTS = ${NOTIFY_QUEUE.maxAttempts}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_BACKOFF_CAP_MINUTES = ${NOTIFY_QUEUE.backoffCapMinutes}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_MAX_RUNTIME_MS = ${NOTIFY_QUEUE.maxRuntimeMs}\\b`));
  // 一轮消费必须在 Edge Function 的墙钟上限（免费 150 秒 / 付费 400 秒）之内收尾。
  assert.ok(NOTIFY_QUEUE.maxRuntimeMs > 0 && NOTIFY_QUEUE.maxRuntimeMs < 400000, '运行时长预算必须小于托管环境的墙钟上限');
  assert.match(migration, /p_limit < 1 or p_limit > 200/);
  assert.match(migration, /p_lease_seconds < 30 or p_lease_seconds > 900/);
  assert.match(migration, /p_max_age_hours < 1 or p_max_age_hours > 168/);
  assert.ok(NOTIFY_QUEUE.batch >= 1 && NOTIFY_QUEUE.batch <= 200);
  assert.ok(NOTIFY_QUEUE.leaseSeconds >= 30 && NOTIFY_QUEUE.leaseSeconds <= 900);
  assert.ok(NOTIFY_QUEUE.maxAgeHours >= 1 && NOTIFY_QUEUE.maxAgeHours <= 168);
  assert.ok(NOTIFY_QUEUE.leaseSeconds * 1000 > NOTIFY_QUEUE.sendTimeoutMs, '租约必须比单封超时更久，否则慢批次会被别人抢走');
});
test('发送前先原子领取：带批次号与租约，写回必须同时匹配，两个发送方不会重复寄信', () => {
  assert.match(migration, /create or replace function public\.app_claim_notifications\(p_claim_id uuid, p_limit integer, p_lease_seconds integer, p_max_age_hours integer\)/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /set status = 'sending', lease_expires_at = now\(\) \+ make_interval\(secs => p_lease_seconds\), claim_id = p_claim_id/);
  assert.match(api, /rpc\('app_claim_notifications', \{ p_claim_id: claimId, p_limit: NOTIFY_BATCH, p_lease_seconds: NOTIFY_LEASE_SECONDS, p_max_age_hours: NOTIFY_MAX_AGE_HOURS \}\)/);
  assert.match(api, /\.eq\('id', note\.id\)\.eq\('status', 'sending'\)\.eq\('claim_id', claimId\)/);
  assert.match(migration, /status text not null default 'pending' check \(status in \('pending','sending','sent','failed','cancelled'\)\)/);
});
test('中断批次退回队列并计入尝试，超龄提醒丢弃且保留原因', () => {
  assert.match(migration, /where status = 'sending' and lease_expires_at <= now\(\)/);
  assert.match(migration, /set status = 'pending', attempts = attempts \+ 1, claim_id = null, next_attempt_at = now\(\)/);
  assert.match(migration, /上一次发送未完成，已重新排队/);
  assert.match(migration, /where status = 'pending' and created_at < now\(\) - make_interval\(hours => p_max_age_hours\)/);
  assert.match(migration, /小时未发送，已丢弃/);
  assert.match(verify, /中断批次应重新领取并计入一次尝试/);
  assert.match(verify, /超龄提醒不应继续留在队列/);
  assert.match(verify, /丢弃应保留原因/);
});
test('队列消费只有一个实现，管理员会话与定时任务共用', () => {
  assert.match(api, /const drainNotifications = async \(actorId: string \| null\) =>/);
  assert.match(api, /action === 'send_notifications'[\s\S]{0,240}requireRole\(actor, 'admin'\)/);
  assert.match(api, /return await drainNotifications\(actor\.user\.id\)/);
  assert.match(api, /return await drainNotifications\(null\)/);
  assert.equal(/const due, error: dueError/.test(api), false, '不允许再走“裸查队列再逐行写回”的旧路径');
});
test('定时入口只放行消费队列，密钥不正确就拒绝，且不要求用户登录', () => {
  assert.match(api, /if \(action === 'send_notifications' && cronHeader\)/);
  assert.match(api, /if \(!cronSecret \|\| !sameSecret\(cronHeader, cronSecret\)\) throw new HttpError\('定时密钥不正确。', 401\)/);
  assert.match(api, /Deno\.env\.get\('CRON_SECRET'\)/);
  assert.match(api, /function sameSecret\(left: string, right: string\)[\s\S]{0,240}diff \^= left\.charCodeAt\(index\) \^ right\.charCodeAt\(index\)/);
  const preAuth = slice(api, '// 定时任务没有用户会话', "if (action === 'me')");
  assert.deepEqual([...new Set([...preAuth.matchAll(/action === '([a-z_]+)'/g)].map((m) => m[1]))], ['send_notifications']);
  assert.equal(preAuth.includes('requireRole'), false, '定时入口不得借用某个人的登录会话');
});
test('开关关闭优先于密钥检查：定时任务不会因为没配邮件服务而反复失败刷日志', () => {
  const drain = slice(api, 'const drainNotifications = async', "const { count: pendingLeft");
  assert.ok(drain.indexOf('if (!settingsRow.email_notify_enabled)') < drain.indexOf('if (!apiUrl || !apiKey || !emailFrom)'));
  assert.match(drain, /if \(!settingsRow\.email_notify_enabled\) return ok\(\{ sent: 0, failed: 0, retried: 0, cancelled: 0, deferred: 0, discarded: 0, skipped: true/);
  assert.match(drain, /if \(actorId === null\) return ok\(\{[\s\S]{0,160}misconfigured: true/);
  assert.match(drain, /throw new HttpError\('邮件服务尚未配置，请项目负责人为 app-api 配置 EMAIL_API_URL、EMAIL_API_KEY 与 EMAIL_FROM。', 503\)/);
  assert.match(drain, /AbortSignal\.timeout\(NOTIFY_SEND_TIMEOUT_MS\)/);
  assert.match(drain, /while \(rounds < NOTIFY_ROUNDS && !stop\)/);
  assert.match(drain, /rows\.slice\(index, index \+ NOTIFY_CONCURRENCY\)/);
});
test('一轮消费有时间预算：到点把没发送的行退回队列，不消耗尝试次数也不卡在发送中', () => {
  const drain = slice(api, 'const drainNotifications = async', "const { count: pendingLeft");
  assert.match(drain, /const timeLeft = \(\) => NOTIFY_MAX_RUNTIME_MS - \(Date\.now\(\) - startedAt\)/);
  assert.match(drain, /if \(timeLeft\(\) <= 0\) break/);
  assert.match(drain, /if \(timeLeft\(\) <= 0 \|\| throttleWait > 0\) \{ stop = true; break \}/);
  // 退回队列的行必须回到 pending、清掉批次号，并且不写 attempts。
  const release = slice(drain, 'const release = (note', 'const sendOne = async');
  assert.match(release, /status: 'pending', claim_id: null/);
  assert.equal(/attempts:/.test(release), false, '退回队列不能消耗尝试次数');
  assert.match(drain, /const leftovers = rows\.filter\(\(note\) => !touched\.has\(note\.id\)\)/);
  assert.match(drain, /deferred \+= results\.filter\(Boolean\)\.length/);
  assert.match(drain, /本轮时间用尽，已退回队列/);
});
test('发送前复核状态：已经不处于待办状态的提醒改为作废，不再寄出', () => {
  assert.deepEqual(NOTIFY_EVENT_STATUS_FROM_API(), [
    ['待财委审批', 'finance_pending'], ['待主席审批', 'chair_pending'], ['退回修改', 'changes_requested'],
    ['待补充收款码', 'payment_info_required'], ['待付款登记', 'payment_pending'],
  ]);
  const sendOne = slice(api, 'const sendOne = async', 'for (let index = 0;');
  assert.match(sendOne, /const expectedStatus = NOTIFY_EVENT_STATUS\[note\.event\]/);
  assert.match(sendOne, /if \(expectedStatus && app\.status !== expectedStatus\)/);
  assert.match(sendOne, /status: 'cancelled', claim_id: null, last_error: `申请状态已变为「\$\{STATUS_LABELS\[app\.status\] \?\? app\.status\}」，提醒已作废`/);
  // 事件与期望状态的映射必须和数据库触发器里的 CASE 分支一致。
  const sqlMapping = [...migration.matchAll(/when '(\w+)' then '([^']+)'/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(NOTIFY_EVENT_STATUS_FROM_API(), sqlMapping);
});
test('邮件服务限频（429）不计入尝试次数，按 Retry-After 暂停本轮并退回其余行', () => {
  const sendOne = slice(api, 'const sendOne = async', 'for (let index = 0;');
  assert.match(sendOne, /if \(response\.status === 429\)/);
  assert.match(sendOne, /response\.headers\.get\('retry-after'\)/);
  assert.match(sendOne, /throttleWait = Math\.max\(throttleWait, Math\.min\(Math\.max\(wait, NOTIFY_THROTTLE_MIN_WAIT_SECONDS\), NOTIFY_THROTTLE_MAX_WAIT_SECONDS\)\)/);
  // 限频的那封回到 pending 且 attempts 不变；其余没发送的行整批退回，不逐封烧尝试次数。
  const throttleBranch = slice(sendOne, 'if (throttled) {', 'const attempts = note.attempts + 1');
  assert.match(throttleBranch, /status: 'pending', claim_id: null/);
  assert.equal(/attempts:/.test(throttleBranch), false, '限频不能计入尝试次数');
  assert.match(throttleBranch, /邮件服务限频（HTTP 429）/);
  assert.match(api, /const NOTIFY_THROTTLE_MIN_WAIT_SECONDS = 30/);
  assert.match(api, /const NOTIFY_THROTTLE_MAX_WAIT_SECONDS = 600/);
  // 中继要把“还要等多久”告诉调用方。
  assert.match(source('deploy/mail-relay/index.mjs'), /'retry-after': String\(throttleWaitSeconds\(\)\)/);
});
test('发送时跳过已停用收件人和不存在的申请，失败按 2 的幂退避并封顶', () => {
  assert.match(api, /admin\.from\('app_users'\)\.select\('id,email,full_name,username,active'\)/);
  const sendOne = slice(api, 'const sendOne = async', 'for (let index = 0;');
  assert.match(sendOne, /if \(!app\) \{/);
  assert.match(sendOne, /last_error: '申请已不存在'/);
  assert.match(sendOne, /if \(!recipient\?\.email\) \{/);
  assert.match(sendOne, /last_error: '收件人邮箱已不存在'/);
  assert.match(sendOne, /if \(!recipient\.active\)/);
  assert.match(sendOne, /last_error: '收件人账号已停用'/);
  assert.match(sendOne, /if \(attempts >= NOTIFY_MAX_ATTEMPTS\)/);
  assert.match(sendOne, /Math\.min\(2 \*\* attempts, NOTIFY_BACKOFF_CAP_MINUTES\)/);
});
test('写回失败不算已处理：计数只在写回成功后增加，行留给退回步骤或租约', () => {
  const drain = slice(api, 'const drainNotifications = async', "const { count: pendingLeft");
  // settle 返回是否写回成功；失败时该行不进 touched，于是会被收尾的退回步骤重新处理。
  assert.match(drain, /const \{ error \} = await admin\.from\('notifications'\)\.update\(fields\)\.eq\('id', note\.id\)\.eq\('status', 'sending'\)\.eq\('claim_id', claimId\)/);
  assert.match(drain, /if \(error\) return false[\s\S]{0,40}touched\.add\(note\.id\)[\s\S]{0,20}return true/);
  // 每种终局都在写回成功后才计数，审计里的数字不虚报。
  const sendOne = slice(api, 'const sendOne = async', 'for (let index = 0;');
  for (const counter of ['sent\\+\\+', 'failed\\+\\+', 'cancelled\\+\\+', 'retried\\+\\+']) {
    const gated = new RegExp(`if \\(await settle\\(note, \\{[\\s\\S]{0,220}?\\)\\) ${counter}`);
    assert.match(sendOne, gated, `${counter} 应该在写回成功后才计数`);
  }
  // 退回步骤只统计写回成功的行。
  assert.match(drain, /const results = await Promise\.all\(leftovers\.slice\(index, index \+ NOTIFY_CONCURRENCY\)\.map\(\(note\) => release\(note, message\)\)\)/);
  assert.match(drain, /deferred \+= results\.filter\(Boolean\)\.length/);
  // 领取时把上一次的失败原因带回来，退回时不会把它冲掉。
  assert.match(migration, /'attempts', attempts, 'last_error', last_error\) order by created_at, id/);
});
test('永久失败可以重新排队，且只有管理员可以', () => {
  assert.match(migration, /create or replace function public\.app_reset_failed_notifications\(p_actor_id uuid\)/);
  assert.match(migration, /if not private\.app_user_has_role\(p_actor_id, 'admin'\) then raise exception '没有管理员权限'; end if;/);
  assert.match(migration, /set status = 'pending', attempts = 0, next_attempt_at = now\(\), lease_expires_at = now\(\), claim_id = null\s+where status = 'failed'/);
  assert.match(api, /action === 'reset_notifications'[\s\S]{0,240}requireRole\(actor, 'admin'\)/);
  assert.match(api, /rpc\('app_reset_failed_notifications', \{ p_actor_id: actor\.user\.id \}\)/);
  assert.match(verify, /重置后失败项应回到待发送/);
  assert.match(verify, /非管理员不应能重置队列/);
});
test('密钥只从 Edge Function 环境读取，配置值不进前端、仓库与日志', () => {
  assert.match(api, /Deno\.env\.get\('EMAIL_API_KEY'\)/);
  assert.match(api, /Deno\.env\.get\('EMAIL_FROM'\)/);
  assert.equal(api.includes('console.log(apiKey'), false);
  assert.equal(api.includes('console.log(cronSecret'), false);
  assert.equal(readme.includes('sb_secret'), false);
  assert.equal(cron.includes('Bearer '), false, '定时调度 SQL 不得内嵌任何真实密钥');
});
test('定时消费用 pg_cron，缺扩展或未配置时只提示不阻塞，且不写死项目地址', () => {
  assert.match(cron, /create or replace function public\.app_register_email_cron\(\)/);
  assert.match(cron, /cron\.schedule\(%L, %L, %L\)/);
  assert.match(cron, /job_name, '\*\/5 \* \* \* \*'/);
  assert.match(cron, /'x-app-cron', cron_secret/);
  assert.match(cron, /current_setting\('stabx\.email_cron_secret', true\)/);
  assert.match(cron, /not exists\(select 1 from pg_available_extensions where name = 'pg_cron'\)/);
  assert.match(cron, /for old_job in select jobid from cron\.job where jobname = job_name loop/);
  assert.equal(cron.includes('https://'), false, '项目地址来自数据库参数，不写进仓库');
  assert.match(cronVerify, /重复登记应只保留一条调度/);
  assert.match(readme, /app_register_email_cron/);
});
test('迁移先检查散装 SQL 的前置依赖，避免运行期才报函数不存在', () => {
  assert.match(migration, /if to_regprocedure\('private\.app_insert_user\(text,text,text,text\)'\) is null then/);
  assert.match(migration, /请先执行 supabase\/admin-settings-audit\.sql/);
  // 建号分配角色与身份判定同样在运行期才会用到，缺了也要在迁移时就报出来。
  assert.match(migration, /if to_regprocedure\('public\.app_set_member_roles\(uuid,uuid,text\[\],boolean\)'\) is null then/);
  assert.match(migration, /if to_regprocedure\('private\.app_user_has_role\(uuid,text\)'\) is null then/);
  assert.match(readme, /supabase\/admin-settings-audit\.sql/);
});
test('管理员列表只回传是否绑定邮箱，不回传地址本身', () => {
  assert.match(api, /has_email: bound\.has\(row\.id\)/);
  const membersSlice = slice(api, "action === 'admin_members'", "action === 'update_registration'");
  assert.equal(membersSlice.includes(', email'), false);
  assert.match(admin, /profile\.has_email \? '' : ' · 未绑定邮箱'/);
});
test('管理数据的每个队列查询都要报错，不再静默显示 0 封', () => {
  assert.match(api, /if \(settingResult\.error \|\| auditResult\.error \|\| pendingResult\.error \|\| sendingResult\.error \|\| sentResult\.error \|\| failedResult\.error \|\| cancelledResult\.error\)/);
  assert.match(api, /cancelled: cancelledResult\.count \?\? 0/);
  assert.match(api, /if \(failuresResult\.error\) throw new Error\('通知队列读取失败。'\)/);
  assert.match(api, /if \(recipientsResult\.error\) throw new Error\('用户信息读取失败。'\)/);
  const failureSlice = slice(api, 'const failureRows = failuresResult.data', "if (action === 'admin_members')");
  assert.equal(failureSlice.includes(',email'), false);
  assert.match(api, /\.select\('id,event,application_id,recipient_user_id,attempts,last_error,created_at'\)/);
});
test('管理端提供开关、五类队列统计、配置提示、失败明细与手动发送入口', () => {
  assert.ok(admin.includes('<h2>邮件通知</h2>'));
  assert.match(admin, /request\('update_email_notify', \{ enabled: emailNotify \}\)/);
  assert.match(admin, /待发送 \{queue\.pending\} 封 · 发送中 \{queue\.sending\} 封 · 已发送 \{queue\.sent\} 封 · 失败 \{queue\.failed\} 封 · 已作废 \{queue\.cancelled\} 封/);
  assert.match(admin, /「已作废」表示提醒发出前申请状态已经变化/);
  assert.match(admin, /request\('send_notifications', \{\}\)/);
  assert.match(admin, /request\('reset_notifications', \{\}\)/);
  assert.match(admin, /data\.email_service_configured === false/);
  assert.match(admin, /邮箱（可选，用于接收待办提醒）/);
  assert.match(admin, /开启后只在出现待办时入队/);
  assert.match(main, /只在需要你动手时提醒/);
  assert.match(admin, /import \{ NOTIFY_QUEUE \} from '\.\/notify-rules\.js';/);
});
test('后端未随前端一起部署时设置面板仍有兜底，不再整页白屏', () => {
  assert.equal(admin.includes('data.notifications.pending'), false);
  // 逐字段兜底：老后端不返回 cancelled 时，面板显示 0 而不是 undefined。
  assert.match(admin, /const queue = \{ pending: 0, sending: 0, sent: 0, failed: 0, cancelled: 0, \.\.\.\(data\?\.notifications \?\? \{\}\) \};/);
  assert.match(admin, /const failures = data\?\.failures \?\? \[\];/);
});
test('账户页可自助绑定或解绑邮箱，按服务端规范回显并即时更新本地资料', () => {
  assert.ok(main.includes('<h2>邮箱提醒</h2>'));
  assert.match(main, /apiRequest\('bind_email', \{ email: value \}\)/);
  assert.match(main, /const stored = value \? normalizeEmail\(value\) : '';/);
  assert.match(main, /onProfileUpdate\(\{ email: stored \|\| null \}\)/);
  assert.match(main, /已清除邮箱，将不再收到邮件提醒/);
  assert.match(main, /系统不验证邮箱归属/);
  assert.match(main, /import \{ normalizeEmail, validateEmail \} from '\.\/notify-rules\.js';/);
});
test('账户入口不再只叫修改密码', () => {
  assert.match(main, /onClick=\{\(\) => open\('account'\)\}>账户设置<\/button>/);
  assert.match(main, /<h2>修改密码<\/h2>/);
});
test('新表和新函数延续最小权限：RLS 加 service_role 专属执行', () => {
  assert.match(migration, /alter table public\.notifications enable row level security/);
  assert.match(migration, /revoke all on table public\.notifications from public, anon, authenticated/);
  for (const fn of ['app_bind_email(uuid, uuid, text)', 'app_update_email_notify(uuid, boolean)', 'app_claim_notifications(uuid, integer, integer, integer)', 'app_reset_failed_notifications(uuid)']) {
    assert.ok(migration.includes(`revoke all on function public.${fn} from public, anon, authenticated;`));
    assert.ok(migration.includes(`grant execute on function public.${fn} to service_role;`));
  }
  assert.match(migration, /revoke all on function private\.enqueue_email_notification\(\) from public, anon, authenticated/);
  assert.match(cron, /revoke all on function public\.app_register_email_cron\(\) from public, anon, authenticated;/);
  assert.match(cron, /grant execute on function public\.app_register_email_cron\(\) to service_role;/);
});
test('迁移行为验证真的驱动状态变化，而不是只看对象是否存在', () => {
  for (const needed of [
    'insert into public.applications(owner_id, title, purpose, amount, category, department, use_date, status, version)',
    "update public.applications set status = 'finance_pending', version = 1 where id = app_id;",
    '已绑定邮箱的财委应收到待审批提醒',
    '申请人本人、未绑定邮箱和已停用的成员都不应入队',
    'public.app_claim_notifications(claim_1, 200, 300, 24)',
    '已领取的行必须处于发送中',
    '领取必须带上未过期的租约',
    '同一封邮件不应被两个批次领取',
    'public.app_reset_failed_notifications(super_id)',
    '移除收款码应作废本轮的待付款登记提醒',
    '重新提交收款码后应再次入队',
    '替别人绑定邮箱应被拒绝',
  ]) assert.ok(verify.includes(needed), `验证脚本缺少：${needed}`);
  assert.equal(/\binsert into public\.notifications\b/.test(verify), false, '队列记录必须由触发器产生，验证不能自己插行');
});
test('README 说明密钥、执行顺序与两种消费入口', () => {
  for (const needed of ['EMAIL_API_URL', 'EMAIL_API_KEY', 'EMAIL_FROM', 'CRON_SECRET', 'app_register_email_cron', 'send_notifications', 'supabase/admin-settings-audit.sql', 'x-app-cron']) assert.ok(readme.includes(needed), `README 缺少：${needed}`);
});
