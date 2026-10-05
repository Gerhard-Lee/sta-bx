// HTTP→SMTP 中继：把 app-api 的 {from,to,subject,html} 投递给 QQ 邮箱（或任何只有 SMTP 的邮箱）。
// 托管 Edge Functions 官方只禁 25/587，465 实测可用但不被承诺（也没有 587/STARTTLS 退路），
// 所以这里是工程取舍而非物理限制：函数只说 HTTP，MAIL FROM 校验、限频与授权码都留在这一侧。
// 换服务商只改这里的环境变量，app-api 一行都不用动。
import http from 'node:http';
import nodemailer from 'nodemailer';

const required = (name) => { const value = String(process.env[name] ?? '').trim(); if (!value) throw new Error(`缺少环境变量 ${name}`); return value; };
const RELAY_TOKEN = required('RELAY_TOKEN');
const SMTP_HOST = required('SMTP_HOST');
const SMTP_PORT = Number(process.env.SMTP_PORT || '465');
const SMTP_USER = required('SMTP_USER');
const SMTP_PASS = required('SMTP_PASS');
// QQ 邮箱：465 用隐式 TLS，587 用 STARTTLS；25 在云服务器上通常被封，不要尝试。
const SMTP_SECURE = String(process.env.SMTP_SECURE ?? (SMTP_PORT === 465)) === 'true';
const RATE_PER_MINUTE = Number(process.env.RELAY_RATE_PER_MINUTE || '12');
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || '262144');
const SOCKET_TIMEOUT = Number(process.env.SOCKET_TIMEOUT_MS || '20000');
const PORT = Number(process.env.PORT || '8080');
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

// MAIL FROM 必须与认证账号完全一致：QQ 会直接拒掉“代发别的地址”，也会让显示名解析失败。
const bareAddress = (value) => { const text = String(value ?? '').trim(); const match = text.match(/<([^>]+)>/); return (match ? match[1] : text).trim().toLowerCase(); };
const BARE_SMTP_USER = bareAddress(SMTP_USER);

const transporter = nodemailer.createTransport({
  host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: { servername: SMTP_HOST },
  connectionTimeout: SOCKET_TIMEOUT, greetingTimeout: SOCKET_TIMEOUT, socketTimeout: SOCKET_TIMEOUT,
});

let windowStart = Date.now(); let windowCount = 0;
const allowSend = () => { const now = Date.now(); if (now - windowStart > 60_000) { windowStart = now; windowCount = 0; } windowCount += 1; return windowCount <= RATE_PER_MINUTE; };
// 限频时告诉调用方还要等多久（秒）：app-api 会据此暂停本轮并稍后重试，而不是把这封算成一次失败尝试。
const throttleWaitSeconds = () => Math.max(1, Math.ceil((60_000 - (Date.now() - windowStart)) / 1000));
const reply = (res, status, message, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify({ message })); };
const readJson = async (req) => {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return null; chunks.push(chunk); }
  if (size > MAX_BODY) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return undefined; }
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) return reply(res, 200, 'ok');
  if (req.method !== 'POST' || req.url !== '/send') return reply(res, 404, '未知接口');
  if (req.headers.authorization !== `Bearer ${RELAY_TOKEN}`) return reply(res, 401, '中继密钥不正确');

  const payload = await readJson(req);
  if (payload === null) return reply(res, 413, '请求体过大');
  if (!payload || typeof payload !== 'object') return reply(res, 400, '请求体不是合法 JSON');

  const to = bareAddress(payload.to);
  const from = bareAddress(payload.from);
  const subject = String(payload.subject ?? '').trim();
  const html = String(payload.html ?? '').trim();
  if (!EMAIL.test(to)) return reply(res, 400, '收件地址格式不正确');
  if (from !== BARE_SMTP_USER) return reply(res, 400, `发件地址必须等于 ${SMTP_USER}`);
  if (!subject || !html) return reply(res, 400, '缺少主题或正文');
  if (!allowSend()) return reply(res, 429, `超过每分钟 ${RATE_PER_MINUTE} 封，稍后重试`, { 'retry-after': String(throttleWaitSeconds()) });

  try {
    await transporter.sendMail({ from: payload.from, to, subject, html }, { maxAttempts: 1 });
    return reply(res, 200, '已受理');
  } catch (error) {
    // 只把服务商的短错误文本回传给调用方写进队列原因；日志里不出现正文、收件人清单与授权码。
    const code = Number(error?.responseCode ?? 0);
    console.error(`relay send rejected: code=${code || error?.code || 'unknown'}`);
    return reply(res, 502, String(error?.response ?? error?.message ?? 'SMTP 投递失败').slice(0, 200));
  }
});

// 只监听容器网络：由反代或 app-api 通过服务名访问，不向公网发布端口。
server.listen(PORT, () => console.log(`mail-relay listening on ${PORT}`));
