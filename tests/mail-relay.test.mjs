import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { createRelay } from '../deploy/mail-relay/index.mjs';

const source = (path) => readFileSync(path, 'utf8');
const TOKEN = 'test-relay-token';
const SMTP_USER = 'notify@qq.com';
const MAIL = { from: `成都七中科协 <${SMTP_USER}>`, to: 'member@example.com', subject: '【财务报销平台】待财委审批', html: '<p>正文</p>' };

// 真实 nodemailer + 自定义 send 传输：只有 SMTP 那一层换成本地桩，sendMail 的参数约定、
// Promise/回调双模式都走库的真实代码路径——评审复现的那个 bug 正好在这条路径上。
function stubTransport(onSend) {
  return nodemailer.createTransport({ name: 'stabx-test', version: '0.0.1', send: (mail, callback) => onSend(mail, callback) });
}

// 起一个真实 HTTP server，走真实 http 客户端：handler 就是中继线上跑的那一个。
async function withRelay(options, run) {
  const server = http.createServer(createRelay({ token: TOKEN, smtpUser: SMTP_USER, ...options }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/send',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('投递结果回来之前不能回 200：sendMail 的第二个参数是回调，不是 options', async () => {
  let handed = null;
  const transporter = stubTransport((mail, callback) => { handed = { mail, callback }; });
  await withRelay({ transporter }, async (port) => {
    const responsePromise = post(port, MAIL);
    let settled = false;
    responsePromise.then(() => { settled = true; });

    // 给 handler 足够时间走到 sendMail：旧写法（第二参数传 { maxAttempts: 1 }）会让 await 拿到
    // undefined，200 立刻返回，而 SMTP 结果要等 callback 才产生——这里就会先 settled。
    await wait(120);
    assert.ok(handed, '中继应该把请求交给 transport');
    assert.equal(settled, false, '投递还没有结果，中继不能先回 200');

    handed.callback(null, { messageId: 'stub-1', accepted: [MAIL.to] });
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).message, '已受理');
    assert.equal(handed.mail.data.to, MAIL.to, 'transport 收到的收件地址应已归一化');
    assert.equal(handed.mail.data.subject, MAIL.subject);
  });
});

test('投递失败要回 502 并带上服务商错误，而不是把失败记成已受理', async () => {
  const transporter = stubTransport((mail, callback) => {
    setTimeout(() => callback(Object.assign(new Error('550 拒绝投递'), { responseCode: 550, response: '550 拒绝投递' })), 20);
  });
  await withRelay({ transporter }, async (port) => {
    const response = await post(port, MAIL);
    assert.equal(response.status, 502);
    assert.match(JSON.parse(response.body).message, /550 拒绝投递/);
  });
});

test('中继仍然挡住误配：密钥、发件地址、限频与 Retry-After', async () => {
  let sent = 0;
  const transporter = stubTransport((mail, callback) => { sent += 1; callback(null, { messageId: 'stub-2' }); });
  await withRelay({ transporter, ratePerMinute: 1 }, async (port) => {
    assert.equal((await post(port, MAIL, { authorization: 'Bearer wrong-token' })).status, 401);
    assert.equal((await post(port, { ...MAIL, from: 'someone@example.com' })).status, 400);
    assert.equal((await post(port, { ...MAIL, to: 'not-an-email' })).status, 400);
    assert.equal((await post(port, { ...MAIL, subject: '' })).status, 400);
    assert.equal((await post(port, MAIL)).status, 200);
    const limited = await post(port, MAIL);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1, '限频必须告诉调用方还要等多久');
    assert.equal(sent, 1, '被拒绝的请求不应真的投递');
  });
});

test('中继源码只 await 一个 Promise，且被 import 时不读环境变量、不监听端口', () => {
  const relay = source('deploy/mail-relay/index.mjs');
  assert.match(relay, /await transporter\.sendMail\(\{ from: payload\.from, to, subject, html \}\)/);
  assert.equal(/maxAttempts/.test(relay), false, '第二参数会被 nodemailer 当成回调，不能再出现');
  assert.match(relay, /export function createRelay\(/);
  assert.match(relay, /if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\) await main\(\)/);
});
