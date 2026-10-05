import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOTIFY_QUEUE } from '../src/notify-rules.js';

const source = (path) => readFileSync(path, 'utf8');
const relay = source('deploy/mail-relay/index.mjs');
const dockerfile = source('deploy/mail-relay/Dockerfile');
const pkg = JSON.parse(source('deploy/mail-relay/package.json'));
const override = source('deploy/docker-compose.override.yml');
const secrets = source('deploy/secrets.env.example');
const drain = source('deploy/drain.sh');
const cron = source('deploy/stabx-notify.cron');
const check = source('deploy/check.sh');
const guide = source('deploy/README.md');
const api = source('supabase/functions/app-api/index.ts');

test('中继的接口形状与 app-api 的发送请求完全一致', () => {
  assert.match(relay, /req\.method !== 'POST' \|\| req\.url !== '\/send'/);
  assert.match(relay, /req\.headers\.authorization !== `Bearer \$\{RELAY_TOKEN\}`/);
  for (const field of ['payload.to', 'payload.from', 'payload.subject', 'payload.html']) assert.ok(relay.includes(field), `中继缺少 ${field}`);
  assert.match(relay, /reply\(res, 200, '已受理'\)/);
  assert.match(relay, /fetch\('http:\/\/127\.0\.0\.1:8080\/health'\)|GET' && \(req\.url === '\/health'/);
});
test('中继挡住误配：收件地址要合法，发件地址必须等于认证账号，超频返回 429 与 Retry-After', () => {
  assert.match(relay, /if \(!EMAIL\.test\(to\)\) return reply\(res, 400, '收件地址格式不正确'\)/);
  assert.match(relay, /if \(from !== BARE_SMTP_USER\) return reply\(res, 400, `发件地址必须等于 \$\{SMTP_USER\}`\)/);
  assert.match(relay, /const bareAddress = /);
  assert.match(relay, /if \(!allowSend\(\)\) return reply\(res, 429/);
  // 限频要告诉调用方还要等多久：app-api 据此暂停本轮，而不是把 429 记成一次失败尝试。
  assert.match(relay, /const throttleWaitSeconds = \(\) => Math\.max\(1, Math\.ceil\(\(60_000 - \(Date\.now\(\) - windowStart\)\) \/ 1000\)\)/);
  assert.match(relay, /'retry-after': String\(throttleWaitSeconds\(\)\)/);
  assert.match(relay, /return reply\(res, 502, String\(error\?\.response \?\? error\?\.message/);
  assert.match(relay, /maxAttempts: 1/);
});
test('中继不泄露授权码、正文与收件清单', () => {
  assert.equal(/console\.(log|error)\([\s\S]{0,140}(SMTP_PASS|RELAY_TOKEN|EMAIL_RELAY_TOKEN|payload\.html|subject)/.test(relay), false);
  assert.equal(/process\.env\.SMTP_PASS[\s\S]{0,60}console\./.test(relay), false);
  assert.match(relay, /只把服务商的短错误文本回传给调用方/);
});
test('中继镜像与依赖：只装生产依赖、非 root、不发布公网端口', () => {
  assert.match(dockerfile, /npm install --omit=dev/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /EXPOSE 8080/);
  assert.equal(dockerfile.includes('ports'), false);
  assert.equal(pkg.devDependencies, undefined);
  assert.match(pkg.dependencies.nodemailer, /^\^\d+\.\d+\.\d+$/);
  assert.equal(pkg.private, true);
});
test('compose 覆盖：中继只在容器网内，数据库端口收回本机，函数拿到五个密钥', () => {
  const relayBlock = override.slice(override.indexOf('  mail-relay:'), override.indexOf('  db:'));
  assert.match(relayBlock, /expose:/);
  assert.equal(/^\s+ports:/m.test(relayBlock), false, 'mail-relay 绝不能发布到公网');
  assert.match(override, /db:\r?\n\s+# [^\n]*\r?\n\s+ports: !reset \[\]/);
  assert.match(override, /supavisor:\r?\n\s+ports: !reset \[\]/);
  for (const key of ['EMAIL_API_URL', 'EMAIL_API_KEY', 'EMAIL_FROM', 'APP_URL', 'CRON_SECRET', 'SUPABASE_PUBLIC_URL']) assert.ok(override.includes(`      ${key}:`), `functions 缺少 ${key}`);
  assert.equal(/[\w.+-]+@(qq|163|example)\.com/.test(override), false, '覆盖文件里不写真邮箱');
  assert.equal(/Bearer\s+[A-Za-z0-9_-]{16,}/.test(override), false, '覆盖文件里不写真密钥');
});
test('密钥模板只留占位符，并说明两个 token 的用途', () => {
  assert.match(secrets, /SMTP_PASS=在这里填/);
  assert.match(secrets, /EMAIL_RELAY_TOKEN=换成随机串/);
  assert.match(secrets, /CRON_SECRET=换成随机串/);
  assert.match(secrets, /RELAY_RATE_PER_MINUTE=12/);
  assert.equal(/[A-Za-z0-9]{28,}/.test(secrets), false, '模板里不能出现像真密钥的长串');
});
test('定时消费走主机 cron：带 x-app-cron、有超时、凭据不落脚本', () => {
  assert.match(drain, /set -eu/);
  assert.match(drain, /-H "x-app-cron: \$\{CRON_SECRET\}"/);
  assert.match(drain, /--max-time/);
  assert.match(drain, /curl -fsS/);
  assert.match(drain, /STABX_NOTIFY_ENV:-\/etc\/stabx-notify\.env/);
  assert.equal(/CRON_SECRET=[A-Za-z0-9]{12,}/.test(drain), false, '脚本里不能写死密钥');
  assert.match(cron, /^\*\/5 \* \* \* \* root /m);
  assert.match(cron, /drain\.sh/);
});
test('curl 超时必须大于函数一轮的消费预算，否则客户端先断开会把行留在发送中', () => {
  const seconds = (text, pattern) => {
    const match = text.match(pattern);
    assert.ok(match, `找不到超时默认值：${pattern}`);
    return Number(match[1]);
  };
  const budgetSeconds = NOTIFY_QUEUE.maxRuntimeMs / 1000;
  assert.ok(seconds(drain, /STABX_NOTIFY_TIMEOUT:-(\d+)/) > budgetSeconds, 'drain.sh 的默认超时必须大于 NOTIFY_MAX_RUNTIME_MS');
  assert.ok(seconds(source('deploy/drain.env.example'), /STABX_NOTIFY_TIMEOUT=(\d+)/) > budgetSeconds, '模板里的超时必须大于 NOTIFY_MAX_RUNTIME_MS');
  assert.match(source('deploy/README.md'), /必须\*\*大于\*\*函数侧一轮消费的预算/);
  // pg_net 的 timeout_milliseconds 目前被忽略，所以定时 SQL 有意不传它，靠函数侧预算收尾。
  const cronSql = source('supabase/migrations/20261005140000_email_notify_cron.sql');
  assert.equal(/timeout_milliseconds\s*:=/.test(cronSql), false, 'pg_net 的超时参数目前无效，不要传');
  assert.match(cronSql, /目前被忽略/);
});
test('自检脚本覆盖六层，且失败会让退出码非 0', () => {
  for (const needed of ['s_client -connect', '/health', '"$code" = "401"', '/send', 'from public.notifications group by status', 'email_notify_enabled', 'drain.sh']) assert.ok(check.includes(needed), `自检缺少一层：${needed}`);
  assert.match(check, /exit "\$fail"/);
  assert.match(check, /已绑定邮箱人数/);
});
test('部署说明给出三种摆法与“备案只关乎对外网站”的结论', () => {
  for (const needed of ['云 Supabase + HTTP 邮件 API', '全栈自托管 + QQ 授权码', '云 Supabase + QQ 授权码', '备案', 'Docker Compose **≥ 2.24**', 'pg_dump', 'smtpdm.aliyun.com']) assert.ok(guide.includes(needed), `部署说明缺少：${needed}`);
  // 口径必须准确：官方限制只禁 25/587，465 可用但不被承诺——中继是工程取舍，不是物理不可能。
  assert.match(guide, /465 实测可用但不被承诺/);
  assert.match(guide, /25\/587/);
});
test('部署脚本与 compose 必须是 LF：Windows 上 checkout 后拷到 Linux 执行不能被回车符破坏', () => {
  const attributes = source('.gitattributes');
  for (const rule of ['*.sh text eol=lf', '*.cron text eol=lf', 'Dockerfile text eol=lf', '*.yml text eol=lf', '*.yaml text eol=lf']) assert.ok(attributes.includes(rule), `.gitattributes 缺少 ${rule}`);
  for (const path of ['deploy/drain.sh', 'deploy/check.sh', 'deploy/stabx-notify.cron', 'deploy/mail-relay/Dockerfile', 'deploy/docker-compose.override.yml']) {
    assert.equal(source(path).includes('\r'), false, `${path} 里出现了 CRLF`);
  }
});
test('构建缺 VITE_* 时 fail-fast，而不是悄悄产出只显示错误壳的产物', () => {
  const config = source('vite.config.js');
  for (const key of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']) assert.ok(config.includes(key), `vite.config.js 没有检查 ${key}`);
  assert.match(config, /loadEnv\(mode, process\.cwd\(\), 'VITE_'\)/);
  assert.match(config, /process\.env\[key\]/, '云端（Vercel/CF）的环境变量来自 process.env，必须一起读');
  assert.match(config, /throw new Error\(/, '缺变量必须让构建失败');
  assert.match(source('README.md'), /连接暂不可用/);
});

test('app-api 两处自托管加固：空密钥回落与签名地址换 host', () => {
  assert.match(api, /\|\| \(Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\) \?\? ''\)/);
  assert.match(api, /const toPublicUrl = \(value: string\) =>/);
  assert.match(api, /signedUrl: toPublicUrl\(data\.signedUrl\)/);
  assert.ok(api.indexOf('const toPublicUrl =') < api.indexOf('signedUrl: toPublicUrl('), 'helper 必须定义在使用之前');
  assert.match(api, /Deno\.env\.get\('SUPABASE_PUBLIC_URL'\)/);
  // 云端没有 SUPABASE_PUBLIC_URL 时必须原样返回，不能把签名地址改坏。
  assert.match(api, /publicBaseUrl && supabaseUrl && value\.startsWith\(supabaseUrl\)/);
});
