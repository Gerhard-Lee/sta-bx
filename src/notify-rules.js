export const EMAIL_MAX = 254;
export const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
export function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return '请填写邮箱地址。';
  if (email.length > EMAIL_MAX) return '邮箱地址过长。';
  return EMAIL_PATTERN.test(email) ? '' : '请输入有效的邮箱地址。';
}
// 提醒类型必须与数据库 notifications.event 的 check 约束、settings.email_notify_events 的白名单、
// 触发器的 CASE 分支以及 app-api 的事件文案表保持一致（契约测试逐项比对四处）。
// 待办类（默认开启）：待财委审批 / 待主席审批 / 待付款登记 → 对应处理身份（排除申请人本人）；
// 退回修改 / 待补充收款码 → 申请人本人（"待补充收款码"就是"审批通过，请补充收款信息"）。
// 结果类（默认关闭，管理员可在设置里打开）：拒绝申请 / 已付款 → 申请人本人。
// 已撤回、草稿两类状态永远不发。
export const NOTIFY_EVENTS = ['待财委审批', '待主席审批', '退回修改', '待补充收款码', '待付款登记', '拒绝申请', '已付款'];
export const NOTIFY_DEFAULT_EVENTS = ['待财委审批', '待主席审批', '退回修改', '待补充收款码', '待付款登记'];
export const NOTIFY_EVENT_GROUPS = [
  { title: '待办提醒（需要有人动手）', hint: '默认开启', events: NOTIFY_DEFAULT_EVENTS },
  { title: '结果通知', hint: '默认关闭，需要时打开', events: ['拒绝申请', '已付款'] },
];
// 服务端读回来的勾选状态做规范化：只保留合法事件、按固定顺序、去重。
// 只有"字段不是数组"（旧后端）才回落到默认值——空数组是合法配置（管理员全部取消勾选）。
export function normalizeNotifyEvents(value) {
  if (!Array.isArray(value)) return [...NOTIFY_DEFAULT_EVENTS];
  return NOTIFY_EVENTS.filter((event) => value.includes(event));
}
// 队列消费参数：与 app-api 顶部的 NOTIFY_* 常量一一对应（Edge Function 不能引用前端模块，两边各自声明），
// 并且必须落在数据库 app_claim_notifications 允许的取值范围内（单次 1–200 封、租约 30–900 秒、有效期 1–168 小时、
// 失败上限 1–10；maxAttempts 同时也是该函数的默认值）。
// maxRuntimeMs 是一轮消费的默认预算：托管免费方案的墙钟与 idle timeout 都是 150 秒，默认值必须留在其内，
// 自托管可用环境变量 NOTIFY_MAX_RUNTIME_MS 调大（app-api 侧钳在 55 秒–15 分钟）。
export const NOTIFY_QUEUE = { batch: 100, rounds: 8, concurrency: 5, sendTimeoutMs: 15000, leaseSeconds: 300, maxAgeHours: 24, maxAttempts: 5, backoffCapMinutes: 60, maxRuntimeMs: 110000 };
