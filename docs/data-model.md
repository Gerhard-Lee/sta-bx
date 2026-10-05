# 数据模型

全部表在 `public` schema，内部辅助函数在 `private` schema。除特别说明外，每张表都 `enable row level security` 且对 `anon`/`authenticated` 执行过 `revoke all`——也就是说**只有 app-api（service role）能读写**，RLS 策略是历史遗留的第二层。

## 一览

| 表 | 职责 | 谁写 |
| --- | --- | --- |
| `app_users` | 真实登录账号与成员资料 | `app_create_user` / `app_login` / `app_bind_email` / `app_set_member_roles` |
| `app_sessions` | 会话令牌摘要 | app-api 直接 insert/delete |
| `profiles` | 遗留表（Supabase Auth 时代的镜像），`applications.owner_id` 仍指向它 | `app_insert_user` 同步写入 |
| `user_roles` | 成员的流程身份 | `app_set_member_roles` |
| `settings` | 单行配置（`id = 1`） | 管理员动作对应的函数 |
| `applications` | 一笔资金申请 | 工作流函数 |
| `application_files` | 附件/收款码/付款凭证的元数据（文件本体在 Storage） | `app_save_workflow_file` 等 |
| `approval_actions` | 审批与提交时间线（含处理意见） | 工作流函数 |
| `payments` | 实际付款流水登记 | `app_record_payment` / `app_submit_workflow_file` |
| `audit_logs` | 人类可读的操作审计 | 各函数 + app-api 的 `audit()` |
| `notifications` | 待发邮件队列 | 触发器入队，app-api 消费 |

## applications

```
id uuid pk · owner_id → profiles(id) · title(1..120) · purpose(1..5000)
amount numeric(12,2)  -- > 0 且 <= 10_000_000
category(1..80) · department(1..80) · use_date date
status text  -- 见下方状态机
version integer not null default 0 check (version >= 0)
rule_threshold numeric(12,2)   -- 提交那一刻的门槛快照
recipient text                 -- 收款人姓名（来自收款码步骤）
created_at / updated_at
```

- **`version` 只在"提交"时递增**（草稿/退回/撤回 → `finance_pending`）。审批、退回、补收款码、付款登记都沿用当前版本。它是审批时间线的分组键，也是通知去重键的一部分。
- **`rule_threshold` 是快照**：管理员之后改门槛，不影响已经提交在流程里的申请。
- 索引：`applications_owner_updated_idx(owner_id, updated_at desc)`、`applications_status_updated_idx(status, updated_at desc)`。

### 状态机

| 状态 | 中文 | 进入条件 | 谁能推进 |
| --- | --- | --- | --- |
| `draft` | 草稿 | 新建 | 申请人 |
| `finance_pending` | 待财委审批 | 提交（`version + 1`） | 财委 |
| `chair_pending` | 待主席审批 | 财委通过且 `amount >= rule_threshold` | 主席 |
| `changes_requested` | 退回修改 | 任一审批人选择退回 | 申请人改后重新提交 |
| `rejected` | 已拒绝 | 审批人拒绝（终态） | — |
| `payment_info_required` | 待补充收款码 | 主席通过，或财委直接通过 | 申请人 |
| `payment_pending` | 待付款 | 申请人提交收款信息 | 付款登记身份 |
| `paid` | 已付款（终态） | 登记流水号 + 凭证 | 付款登记身份（可更正） |
| `cancelled` | 已撤回 | 申请人在 `draft`/`changes_requested`/`finance_pending`/`chair_pending` 时撤回 | 申请人可重新提交 |

## application_files

```
application_id → applications  (on delete cascade)
owner_id → profiles            -- 永远是申请人，不是上传者
kind in (attachment | qr | receipt)
storage_path text unique       -- 必须以 <owner_id>/<application_id>/ 开头
name(<=180) · mime(<=120)
pending boolean                -- 草稿：true 时不算已提交
removed_at timestamptz         -- 被替换/移除，保留行与文件供审计
uploaded_by → profiles(id)     -- 实际上传人
draft_value text               -- 收款人姓名或支付宝流水号的草稿值
```

`qr` 与 `receipt` 是"草稿 → 显式提交"两步；同一 `kind` 只保留一份已提交记录（提交时其余行打 `removed_at`）。**已提交的付款凭证不允许删除**，只能用新凭证替换。

## settings（单行 `id = 1`）

| 列 | 含义 | 默认 |
| --- | --- | --- |
| `threshold` | 主席介入的金额门槛 | `100.00`，**恰好等于门槛需要主席审批**（判定是 `>=`） |
| `registration_enabled` | 是否开放自助注册 | `true` |
| `email_notify_enabled` | 邮件通知总开关 | `false` |
| `updated_at` / `updated_by` | 最后一次修改 | — |

## notifications（邮件队列）

```
id bigint identity pk
application_id → applications (cascade) · application_version int
event text  -- 五类"需要动手"事件之一
recipient_user_id → app_users (cascade)
status text in (pending | sending | sent | failed | cancelled)
attempts int check (>= 0) · next_attempt_at · lease_expires_at · claim_id uuid
last_error text · created_at · sent_at
-- 去重键是部分唯一索引，cancelled 的行不占名额：
-- unique index notifications_dedupe_idx(application_id, application_version, event, recipient_user_id) where status <> 'cancelled'
```

状态流转与并发语义：

```
触发器入队 → pending ──app_claim_notifications（租约 + 批次号）──► sending
   sending ── 发送成功 ──► sent
   sending ── 状态已变（发送前复核失败）──► cancelled（终态，不寄出）
   sending ── HTTP 429 限频 ──► pending（按 Retry-After 延后，不计 attempts）
   sending ── 失败且 attempts < 5 ──► pending（next_attempt_at 退避）
   sending ── 失败且 attempts >= 5 ──► failed（可用 app_reset_failed_notifications 退回 pending）
   sending ── 一轮时间预算用尽 ──► pending（原样退回，不计 attempts）
   sending ── 租约到期（进程被硬中断）──► pending，并计入一次 attempts
   pending 且 created_at 超过 24 小时 ──► failed（原因："超过 24 小时未发送，已丢弃"）
   本轮尚未作废的「待付款登记」提醒（含已发出的）── 收款码被移除（payment_pending → payment_info_required）──► cancelled
```

部分索引：`notifications_pending_idx(next_attempt_at) where status='pending'`、`notifications_lease_idx(lease_expires_at) where status='sending'`、`notifications_dedupe_idx(application_id, application_version, event, recipient_user_id) where status <> 'cancelled'`。完整规则见 [notifications.md](notifications.md)。

## app_users / app_sessions

```
app_users: username(3..40, 唯一按小写) · password_hash · full_name(<=80)
           department(<=80) · active · email(<=254 且形态受限，可为 NULL) · created_at/updated_at
app_sessions: token_hash(sha256 hex, unique) · user_id → app_users (cascade)
              expires_at · last_seen_at
```

`email` 的 check 约束与前端 `src/notify-rules.js` 的 `EMAIL_PATTERN`、`app-api` 的入库前处理必须一致（254 长度 + 同一形态，统一小写存储）。

## user_roles / audit_logs

- `user_roles.role in ('finance','chair','cashier','admin')`；`cashier`（付款登记）目前**无法通过管理界面分配**，见 [known-issues.md](known-issues.md)。
- `audit_logs`: `actor_id`（可空，空表示系统/定时任务）、`event`、`detail`、`username`、`ip_address`、`metadata jsonb`、`request_id uuid`、`created_at`。`event` 是中文短语，管理面板按它筛选展示。
