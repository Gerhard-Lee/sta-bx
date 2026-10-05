export const EMAIL_MAX = 254;
export const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
export function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return '请填写邮箱地址。';
  if (email.length > EMAIL_MAX) return '邮箱地址过长。';
  return EMAIL_PATTERN.test(email) ? '' : '请输入有效的邮箱地址。';
}
// 队列事件必须与数据库通知触发器和 app-api 的事件清单保持一致。规则只有一条：需要有人动手才发信。
// 待财委审批 / 待主席审批 / 待付款登记 → 对应处理身份（排除申请人本人）；退回修改 / 待补充收款码 → 申请人本人。
// 拒绝申请、已付款、已撤回、草稿属于完结或起始态，没有待办，不发邮件。
export const NOTIFY_EVENTS = ['待财委审批', '待主席审批', '退回修改', '待补充收款码', '待付款登记'];
// 队列消费参数：与 app-api 顶部的 NOTIFY_* 常量一一对应（Edge Function 不能引用前端模块，两边各自声明），
// 并且必须落在数据库 app_claim_notifications 允许的取值范围内（单次 1–200 封、租约 30–900 秒、有效期 1–168 小时）。
// maxRuntimeMs 只在前端与函数两侧使用：托管 Edge Functions 的墙钟上限是 150/400 秒，一轮消费到点就收尾。
export const NOTIFY_QUEUE = { batch: 100, rounds: 8, concurrency: 5, sendTimeoutMs: 15000, leaseSeconds: 300, maxAgeHours: 24, maxAttempts: 5, backoffCapMinutes: 60, maxRuntimeMs: 240000 };
