# 邮件通知

一句话规则：**只在"需要有人动手"时通知对应的人**。审批结果（拒绝、已付款）不发邮件，成员在站内查看。

## 事件与收件人

| 状态变化 | 事件名 | 收件人 | 需要动手的事 |
| --- | --- | --- | --- |
| → `finance_pending` | 待财委审批 | 拥有 `finance` 身份、已绑邮箱、**非申请人**的成员 | 去审批 |
| → `chair_pending` | 待主席审批 | 同上，`chair` 身份 | 去审批 |
| → `payment_pending` | 待付款登记 | 同上，付款登记身份 | 转账并登记流水号 |
| → `changes_requested` | 退回修改 | **申请人本人** | 改完重新提交 |
| → `payment_info_required` | 待补充收款码 | **申请人本人** | 上传收款码 |
| → `rejected` / `paid` / `cancelled` / `draft` | — | 不发 | — |

事件名是数据契约的一部分：`notifications.event` 的 check 约束、触发器的 `CASE`、`app-api` 的文案表、`src/notify-rules.js` 的数组**四处必须完全一致**，`tests/email-notify.test.mjs` 会逐项比对。

## 入队

由 `applications` 上的列级触发器完成（`after update of status`），与状态变更在**同一个事务**里：

- 状态没变、或新状态不在映射表里 → 直接返回。
- 总开关 `settings.email_notify_enabled = false` → 不产生任何队列记录（关闭期间的变化**不会补发**）。
- 收件人条件：账号启用 + 已绑定邮箱 + 按上表推导身份（一律通过 `private.app_user_has_role`，所以身份含义变化不需要改这里）。
- 去重键 `(application_id, application_version, event, recipient_user_id)`，由**部分唯一索引** `notifications_dedupe_idx ... where status <> 'cancelled'` 承担，插入时 `on conflict (...) where status <> 'cancelled' do nothing`：同一版本同一事件同一收件人只有一封；重新提交会升 `version`，因此能再次收到提醒；**已作废（`cancelled`）的行不占去重名额**，所以待办真的再次出现时还能再提醒一次。
- 唯一的同版本内重入是「收款码被移除 → 重新提交」（`payment_pending ↔ payment_info_required`，不升版本）。触发器在离开 `payment_pending` 回到 `payment_info_required` 时，把这一版的「待付款登记」提醒整批标记为 `cancelled`（原因写"收款信息已变更"，若作废前已发出过则保留 `sent_at`）——旧提醒指向的收款人已经变了，不能再拿它催付款；重新提交收款码会重新入队一封新的。

## 消费：一个实现，两个入口

`app-api` 里的 `drainNotifications(actorId)` 是唯一实现。

| 入口 | 条件 | 说明 |
| --- | --- | --- |
| 管理员手动 | 登录 + `admin` 角色，动作 `send_notifications` | 「设置 → 邮件通知 → 立即发送」 |
| 定时任务 | 请求头 `x-app-cron` 与 Edge Function 密钥 `CRON_SECRET` **恒定时间比较**通过 | 不需要任何人的登录会话，且**只允许这一个动作**；其余动作一律要求登录 |

顺序上有意的两处设计：**先看总开关再看密钥**——开关关闭时返回 `{skipped:true}`，定时任务不会因为没配邮件服务而每 5 分钟报一次 503；密钥缺失时，管理员入口抛 503 提示配置，定时入口返回 `{misconfigured:true}` 只记一次状态、不刷日志。

## 队列状态机与并发

```
pending ──app_claim_notifications(批次号, 上限, 租约秒, 超龄小时, 失败上限)──► sending ──► sent / failed / cancelled / 退回 pending
```

- **发送前复核收件人身份**：入队时校验过身份，但入队与发送之间可能隔了 cron 周期、退避重试（最长 24 小时）甚至几天。领取时数据库会用 `private.app_notify_recipient_allowed(收件人, 事件)` 再核一次——角色被撤销、账号被停用或邮箱被解绑，就地把这封标成 `cancelled`（原因写"收件人已不具备该待办的处理身份"），**不寄出**。否则一个已经被撤掉财委身份的人会继续收到别人的申请标题与金额，而他在站内已经看不到这些。判定仍然只走 `private.app_user_has_role`（与入队、与站内权限同一处语义），所以"付款登记视同财委"这类规则变化自动生效；作废数由领取结果带回，计入管理面板的「已作废」。
- **发送前复核状态**：领取之后、真正发信之前会用事件对应的状态再核一次（`待财委审批→finance_pending`、`待主席审批→chair_pending`、`退回修改→changes_requested`、`待补充收款码→payment_info_required`、`待付款登记→payment_pending`）。状态已经变了（被别人处理、被撤回、收款人换了）就标记 `cancelled` 并写清原因，**不再寄出**——避免"催办一件已经做完的事"，也避免正文里的"当前状态"与事件标题自相矛盾。
- **发送前复核版本**：只比状态挡不住"离开又回到同一个状态"。被退回修改后重新提交会升 `version`，所以队列行里的 `application_version` 必须等于申请当前的 `version`：领取时（数据库侧，和收件人身份一起把 `pending` 行清一遍）与真正发信前（`app-api` 侧，挡住"领取之后才提交"的那一小段窗口）各比一次，不一致就作废（原因写"申请已重新提交（版本 N → M）"）。典型场景 `finance_pending(v1) → changes_requested(v1) → finance_pending(v2)`：v1 那封已经指向上一次待办，不能再寄，否则同一件事会连发两封。
- `cancelled` 是终态、不是失败：`app_reset_failed_notifications` 只碰 `failed`，作废的提醒不会被重新排队；管理面板单独统计一类。身份恢复后如果待办没有再次发生状态变化，也不会重发——作废就是作废（这是有意选择：宁可让本人去站内看，也不把旧邮件补出去）。
- 领取用 `FOR UPDATE SKIP LOCKED` + `claim_id` + `lease_expires_at`，写回结果时必须同时匹配 `id`、`status='sending'`、`claim_id` 三个条件。**两个发送方（两个人同时点、或手动与定时撞上）不会把同一封邮件寄两次。**
- **一轮有时间预算**：单次调用最多跑 `NOTIFY_MAX_RUNTIME_MS`（240 秒，托管环境墙钟上限是 150/400 秒）。到点或遇到限频时，**本轮没发送过的行原样退回 `pending`**（清掉批次号、不写 `attempts`），不会卡在 `sending` 等 5 分钟租约。
- **调用方的超时必须大于这个预算**：主机 cron 的 `deploy/drain.sh` 用 `STABX_NOTIFY_TIMEOUT`（默认 300 秒）当 curl 的 `--max-time`——比预算小的话客户端先断开，上面那段退回逻辑根本没机会跑。pg_cron 那条路走 pg_net，官方文档说明 `timeout_milliseconds` **目前被忽略**（等于没有客户端超时），一轮的边界由函数预算与平台墙钟决定。
- 托管免费套餐的墙钟只有 150 秒，比预算短：那种套餐下一轮可能被平台截断，剩余行由租约兜底（并计一次尝试）。要稳定跑满预算得用付费套餐或自托管。
- 写回（`settle`）失败的行不算"已处理"：既不加计数，也会被收尾的退回步骤或租约到期再次领取——审计里的数字只反映真正写进库的状态。
- 进程被硬中断留下的 `sending` 行，在租约过期后自动退回 `pending` 并计入一次尝试；**恢复路径和真投递失败共用同一个失败上限**（`p_max_attempts`，与 `NOTIFY_MAX_ATTEMPTS` 同值）：连续 5 次中断未完成就转 `failed` 并写"连续 N 次发送未完成，已停止重试"，不会无限重领。恢复时如果这行已经超龄，直接按"超过 24 小时未发送，已丢弃"判失败，而不是先退回队列再被同一轮寄出去。
- **限频（HTTP 429）不计入尝试次数**：中继会带回 `Retry-After`，这一轮就此暂停，被限频的那封与同批剩余行一起稍后重试。否则中继每分钟 12 封的限频会在几十分钟内把正常积压打成"永久失败"。
- 失败退避 `2^attempts` 分钟（封顶 60 分钟），累计 5 次转 `failed` 并保留 `last_error`；管理员可以点「失败项重新排队」（`app_reset_failed_notifications`，仅管理员，写审计）。
- 超龄丢弃：`pending` 且 `created_at` 早于 24 小时的行会被标记 `failed`，原因"超过 24 小时未发送，已丢弃"——避免重新打开开关时突然补发几天前的邮件；租约过期但同样超龄的 `sending` 行一并丢弃于同一次领取。
- 批量：每轮最多 100 封、5 封并发、单封 15 秒超时、最多 8 轮，且整轮受 240 秒预算约束；参数集中在 `src/notify-rules.js` 的 `NOTIFY_QUEUE`，测试会校验它与 `app-api` 常量、数据库取值范围（1–200 / 30–900 秒 / 1–168 小时 / 失败上限 1–10）三方一致。

## 容量与频率

- 应用侧（每轮 100 封、5 并发）与中继侧（`RELAY_RATE_PER_MINUTE`，默认 12/分钟）是**两层独立限频**。中继超限返回 429 + `Retry-After`，app-api 会暂停本轮并稍后重试，**不消耗尝试次数**。
- 实际吞吐因此由更慢的一层决定：走自带中继（12/分钟）时，每 5 分钟一轮大约只发得掉 12 封，大积压要按小时计；走 HTTP 邮件 API（A 摆法）没有这层限制，一轮能把 800 封跑完（在 240 秒预算内）。
- 要提吞吐就动中继的 `RELAY_RATE_PER_MINUTE`（代价是更容易被 QQ 风控），或者换不限频的 HTTP 服务商；不建议改应用侧批量，那一层已经不构成瓶颈。

> 投递语义是 **at-least-once**：只有发送成功才写 `sent`，中途崩溃的批次会重发。这是刻意选择——宁可偶尔重复一封，也不能漏掉待办。

## 邮件内容

- 主题：`【财务报销平台】<事件文案>`。
- 正文（HTML，全部字段经 `escapeHtml`）：事件说明、申请标题、金额、部门/活动、费用类别、申请人、当前状态，最后是 `APP_URL` 入口链接（未配置就没有链接）与"请勿直接回复"落款。
- **不含**附件地址、签名 URL、令牌，也不含任何第三方跟踪元素。

## 隐私边界

- 邮箱地址只存在 `app_users.email`，`revoke` 掉 `anon`/`authenticated`，前端永远读不到别人的地址。
- 管理面板的成员列表只回传布尔值 `has_email`（未绑定的人显示"· 未绑定邮箱"）；`app_list_members` 本身也不选 `email` 列。
- 审计只写"绑定邮箱 / 清除邮箱 / 邮箱已更新"，**不写地址**；管理员建号的审计只写 `email_bound: true/false`。
- `notifications` 表只存 `recipient_user_id`，不存地址副本（成员解绑后队列里的行会因"邮箱已不存在"转失败）。
- 一人一封、收件人互不可见；没有 BCC、没有群发列表。
- 提醒内容包含申请人、部门与金额——这与站内工作台的可见范围一致，但它是发到成员**个人**邮箱，所以绑定页明确写出这一点，由本人填写作为同意动作。

## 配置

| 密钥（Edge Function 环境变量） | 用途 |
| --- | --- |
| `EMAIL_API_URL` | 提交接口地址（`http://mail-relay:8080/send` 或外部 HTTP 邮件 API） |
| `EMAIL_API_KEY` | 调用邮件服务的 `Authorization: Bearer` 值 |
| `EMAIL_FROM` | 已通过服务商验证的发件地址，如 `成都七中科协 <notify@你的域名>` |
| `APP_URL` | 可选，正文里的平台入口 |
| `CRON_SECRET` | 可选，定时消费密钥；未设置时定时入口一律 401 |

定时消费的两种做法（主机 cron / pg_cron）、SMTP 中继容器与自检脚本见 [deployment.md](deployment.md)。

发送协议的边界：**函数这一侧只说 HTTP**——把 `{from,to,subject,html}` POST 给 `EMAIL_API_URL`。真正发 SMTP 的是可选的中继容器 `deploy/mail-relay`（`nodemailer` → `smtp.qq.com:465`），它同时负责 `MAIL FROM` 必须等于认证账号的校验与每分钟限频。官方出站限制目前只禁 `25`/`587`，函数内直连 `465` 并非不可能，但属未承诺行为且没有退路，所以没有采用（理由见 [decisions.md](decisions.md)）。

## 已知限制

- **不验证邮箱归属**：没有确认邮件，任何人都能把地址填成自己拥有的任意邮箱；填错只会静默收不到。
- **`sent` 只代表服务商受理**，不代表投递成功，也不代表进了收件箱（服务商返回 2xx 即算成功）。
- 成员未绑定邮箱时不会有任何提醒；管理面板目前只显示队列计数（待发送/发送中/已发送/失败/已作废），**没有"多少人还没绑定"的汇总**（`deploy/check.sh` 里有这条 SQL，界面还没接）。
- 队列没有清理任务，`sent`/`cancelled` 行会长期保留（隐私上是好事：只留用户 id；容量上 bigint 足够）。
- 发送前复核挡不住"已经在路上的"那一封：某行被领取后正在 HTTP 调用中，此时状态才变化或身份才被撤销，那一封仍会寄出。窗口只有一次请求的时间（≤15 秒），不为此加锁。
- 身份与版本复核在**领取时**做（同一次 `app_claim_notifications`），状态与版本的第二次复核在发送前做；两处都依赖数据库当前状态，所以如果撤销角色/重新提交与消费恰好并发，结果取决于谁先提交。这在工程上够了（待办不会因为一个已经无权的人晚收到而阻塞），但不是严格串行化保证。
- 已作废（`cancelled`）的行会从去重名额里让位，但**不会自动复活**：角色被重新授予、或申请绕一圈回到同一个状态时，只有再次发生状态变化（或新版本）才会重新入队。
- 去重仍按"版本 + 事件 + 收件人"：同一版本内**除收款码重提交外**没有合法的状态重入，所以没有其它"应该再提醒一次"的场景；真要新增，走新版本（重新提交）或新事件。
- **将来若新增"把申请推回某个待办状态"的路径要一起改这里**：去重只让 `cancelled` 行让位，同版本里已经 `sent` 的同名提醒仍占名额（例如"已付款后又回到待付款"这种目前不存在的路径）。

## 已修（本轮审查的产出）

- 发送前不复核状态 → 现在状态已变的提醒改为 `cancelled`，不再寄出。
- 中继每分钟 12 封的限频与应用侧"每轮 100 封"对不上，429 被当成失败并吃满 5 次尝试 → 现在 429 不计入尝试次数，按 `Retry-After` 暂停本轮。
- 一轮 800 封可能撞上 Edge Function 墙钟被硬杀 → 现在有 240 秒时间预算，到点把没发送的行原样退回。
- 同一版本内"收款码移除 → 重新提交"漏提醒 → 离开 `payment_pending` 时作废旧提醒，去重索引改为部分唯一索引。
- `app_bind_email` 在数据库层不校验调用者 → 改成 `(p_actor_id, p_user_id, p_email)` 并强制两者相同。
- fail-fast 只查一个依赖 → 补上 `app_set_member_roles` 与 `app_user_has_role`。

### 独立复核后补的

- 自托管 cron 的 curl 超时（90 秒）**小于**函数侧一轮预算（240 秒）→ 默认改成 300 秒，并加测试把这两个数绑在一起（`tests/self-host-deploy.test.mjs`）。
- 写回失败被当成成功：`settle` 不检查 PostgREST 返回 → 现在返回是否写回成功，**计数只在成功后增加**，失败的行留给退回步骤或租约，审计不再虚报。
- 迁移里"按名字删掉 notifications 的所有唯一约束"范围过大 → 只删列正好是去重那四列的那一个。
- 迁移按签名删旧 `app_bind_email` → 改成按函数名删掉所有重载（避免将来出现不同参数个数的重载让 PostgREST 调用有歧义）。
- 领取结果不带 `last_error`，退回/重试时会把上一次的失败原因冲掉 → 领取时带上它。
- `deploy/README.md` 与 `drain.env.example` 写明超时与预算的关系；pg_cron 那条路明确不传 pg_net 的 `timeout_milliseconds`（官方文档说明该参数当前被忽略）。

### PR #19 外部评审（yhwlwl）后补的

评审用独立环境（本地 PGlite + 真实 nodemailer）逐条复现，下面每一条都有对应的真实执行测试，不再只靠源码字符串断言：

- **迁移原样执行就报错**：`array_agg(a.attname)` 是 `name[]`，与 `text[]` 字面量比较时解析期就抛 `operator does not exist: name[] = text[]`，全新库也跑不过 → 改成 `array_agg(a.attname::text ...)`；`tests/sql-migrations.test.mjs` 用 PGlite 真的把整个 SQL 栈执行一遍（见 [testing.md](testing.md)）。
- **中继把失败记成已受理**：`sendMail(message, { maxAttempts: 1 })` 的第二参数在 nodemailer 里是回调，`await` 拿到 `undefined`，HTTP 200 先于投递结果发出，库随后还会把那个对象当回调调用并抛出 try/catch 之外的 `TypeError`（进程退出） → 只 `await` 一个 Promise；`tests/mail-relay.test.mjs` 用真实 nodemailer + 桩 transport 覆盖成功、失败、鉴权与限频四条路径。
- **角色撤销后仍寄出财务详情** → 领取时复核收件人身份，不合格就地作废（见上文"发送前复核收件人身份"）。
- **跨版本重提后旧提醒和新提醒一起寄** → 领取时比 `application_version`（数据库侧，已作废数同样计入「已作废」），发送前 `app-api` 再核一次（见上文"发送前复核版本"）；`verify.sql` 里造出 v2/v5/v6 三版并存的队列，断言旧版本全部作废、当前版本仍被领取。
- **中断恢复绕过五次上限**：恢复路径只加 `attempts`，领取时又不看上限，反复中断七轮后仍是 `sending/attempts=6` → 恢复与投递失败共用 `p_max_attempts`，用满即 `failed`；超龄的 `sending` 行恢复时直接丢弃。
- **新增的 `.verify.sql` 自己跑不起来**：`RAISE EXCEPTION '…' || queued` 不是合法 PL/pgSQL → 改成 `%` 占位符；两处过期断言（"付款提醒恰好一封"、`app_claim_notifications` 四参数签名）按 main 已合入的"付款登记视同财委"与五参数签名重写，并新增身份撤销、失败上限、超龄 `sending` 三类行为断言。
