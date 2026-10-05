# 决策记录

每条只留**长期取舍**与"改动它要付什么"；机制细节在对应文档里（链接给出），这里不重复算法。

## 自研账号体系，不用 Supabase Auth

几十人校内使用，要用户名密码、部门、管理员批量建号、停用即踢下线，不想引入邮箱验证 → `app_users`（bcrypt cost 12）+ `app_sessions`（只存令牌 SHA-256 摘要，30 天）+ 自研登录/改密；`profiles` 只作为 `applications.owner_id` 的指向对象。
**代价**：口令策略、会话吊销、令牌熵自己负责；`profiles.email` 是历史占位（存的是用户名），与真实邮箱 `app_users.email` 并存、容易误用。

## app-api 是唯一数据入口

前端不能拿 service role key，而工作台/审计的可见范围用简单 RLS 表达不了 → 业务表对 `anon`/`authenticated` `revoke all`，前端只调 `POST {action}`，权限与规则在 app-api 与数据库各再做一遍。
**代价**：多一跳；`index.ts` 体积大；放弃 PostgREST 直连（实时订阅、自动 REST）。

## 业务规则写在 PL/pgSQL 里

状态机、门槛、"不能处理自己的申请"必须不可绕过 → 每个 `app_*` 函数第一行做权限与状态判定、用 `select … for update` 锁申请行；HTTP 层只做参数整形与错误翻译。
**代价**：规则分散在 TS 与 SQL 两处，靠测试盯一致性（见 [testing.md](testing.md)）。

## 管理员不替代流程身份，内置 `admin` 例外

早期"管理员可以干一切"让职责与审计都糊了 → `admin` 只管成员/配置/审计；财委、主席、付款登记是独立身份；唯一例外是用户名恰好 `admin` 的内置超管，账号与角色被触发器锁死。
**代价**："管理员顺手代审"不再可能；`user_roles` 只允许 `finance`/`chair`/`admin`，付款登记能力由 `finance` 派生（见 [workflow.md](workflow.md#身份与权限)），于是每个财委都能登记付款、也会收到「待付款登记」提醒。

## 门槛用提交时的快照 `rule_threshold`

主席门槛会被调整，流程中的申请不该被事后影响 → 提交时把 `settings.threshold` 写进该申请，审批去向按快照判断（`amount >= rule_threshold` 走主席，**恰好等于门槛要主席审批**）。
**代价**：改门槛后旧申请显示的是它自己的快照值，需要解释。

## 文件"草稿 → 显式提交"两步，且只替换不删除

误选文件就推进状态会返工，已提交的凭证又是审计依据 → `qr`/`receipt` 先落 `pending` 草稿、显式提交才改状态；替换打 `removed_at`、文件留在存储；已提交凭证不能删；有未提交收款码草稿时禁止登记付款；移除已提交收款码把付款挂回 `payment_info_required`。
**代价**：状态与文件的组合边界多（重复更换收款码、同状态重复提交），是回归测试最密的地方。

## 提醒范围交给管理员配置，代码只给默认值

七类全发还是只发五类待办是**组织偏好**，写死在代码里意味着每次改口径都要改代码、重新部署 → 七类全部入库，`settings.email_notify_enabled` 是总开关、`settings.email_notify_events` 是逐类勾选（默认只开五类待办，结果通知默认关），只有管理员能改并写审计；收件人仍按身份与申请归属推导，勾选只决定"发不发"。
**代价**：多一处配置面；"为什么没收到"要同时看总开关、勾选、身份与队列状态——审计因此记下旧值/新值与本轮预算、开启类型数。

## 队列用"带租约的原子领取"，语义是 at-least-once

手动与定时可能同时跑，函数被墙钟打断会留下半批 → `app_claim_notifications` 用 `FOR UPDATE SKIP LOCKED` 领取并写 `status='sending'` + `lease_expires_at`；写回必须同时匹配 `id` + `status='sending'` + 批次号；租约过期的 `sending` 行退回 `pending` 并计一次尝试，恢复同样受 5 次失败上限约束。
**代价**：崩溃在"已发出但未写回"窗口内的邮件会重发一次——宁可重复，不可漏发。机制见 [notifications.md](notifications.md#队列状态机与并发)。

## 超龄提醒丢弃而不是无限积压

开关关一周再打开会突然补发几天前的"待审批"邮件 → 领取时把 `pending` 且超过 24 小时的行标 `failed`（"超过 24 小时未发送，已丢弃"）；租约过期但同样超龄的 `sending` 行在恢复时就地丢弃。
**代价**：长时间不开邮件服务会真的丢通知；站内状态仍然正确，队列里留着丢弃记录。

## 事件名、审计事件名用中文，并且是数据契约

界面、审计、邮件全面向中文使用者，映射层只会增加错位 → 中文字符串直接进 check 约束、审计 `event` 列与 `notifications.event`。
**代价**：改名等于改数据（迁移 + 多处同步 + 测试同步），是仓库里最"重"的一类改动。

## 密钥只存在于运行环境

邮件密钥、`CRON_SECRET`、SMTP 授权码走 Edge Function 环境变量或 compose 的 `.env`；pg_cron 的项目地址与密钥走数据库参数 `stabx.email_cron_*` → 仓库里既没有真实地址也没有长随机串（有测试断言）。
**代价**：换密钥要三处同步（函数 env、中继 env、cron env），见 [deployment.md](deployment.md)。

## 邮件出口是 HTTP 接口，SMTP 交给自托管中继

官方出站限制只列 `25`/`587`（[Limits](https://supabase.com/docs/guides/functions/limits)），`465` 未被禁止但属未承诺行为、没有 587/STARTTLS 退路 → 函数只说 HTTP（`POST EMAIL_API_URL`，`{from,to,subject,html}`），SMTP 由 `deploy/mail-relay` 承担：`MAIL FROM` 校验与 `RELAY_RATE_PER_MINUTE` 限频需要常驻进程，授权码只留在中继。
**代价**：多一个容器；纯云端必须选 HTTP API 型服务商；用 QQ/单位邮箱绕不开一台能出 465 的机器（社区实测见 [supabase#21977](https://github.com/supabase/supabase/issues/21977)）。

## 去重键排除已作废的行

唯一不升版本的状态重入是"收款码移除 → 重新提交"，原唯一约束会把第二次「待付款登记」提醒静默吞掉 → 唯一约束换成部分唯一索引 `where status <> 'cancelled'`，新增终态 `cancelled`；离开 `payment_pending` 时把这一版提醒标 `cancelled`（保留 `sent_at`），重新提交后自然再入队。
**代价**：作废是就地改状态，已发出的那封从"已发送"挪到"已作废"；`cancelled` 与 `failed` 必须分开看，重置按钮只碰 `failed`。

## 复核分三层：过时的提醒作废，而不是寄出

入队到发送之间可能隔几小时（退避重试最长 24 小时）甚至一轮内部的几十秒，这期间收件人身份可能没了、待办可能过期或换了对象、管理员可能关掉这一类 → ① 领取时复核身份、队列行版本、该事件是否还在白名单，不合格的 `pending` 行就地作废；② **每个发送组（≤5 封）之前**调 `app_notify_verify_rows(claim_id, ids)`，逐项返回 `send`/`cancel`/`skip`，**只有 `send` 才投递**，"结果缺席"与 `skip` 一律不放行（早前的 blocked 契约把"没出现在结果里"当放行，于是领取后被工作流作废的行反而被寄出）；③ 单封发送前用整批快照再对一次状态与版本。
**代价**：判定要在 SQL/handler 两处一致（契约测试 + 两套真实执行测试盯着）；每组多一次 RPC；复核返回到 `fetch` 之间仍有毫秒级窗口，不是"作废后绝不会收到"；`skip` 的行复核不改状态（本轮收尾退回队列是既有的中断恢复逻辑）。

## 投递前复核接口失败时"退回"，而不是让整轮崩掉

复核 RPC 报错（PostgREST 抖动、schema 缓存未刷新、迁移未执行）时，原写法会让整轮抛 400、最多 100 行卡在 `sending`、审计为空，5 轮后全部转 `failed` → 改成把该组行原样退回 `pending`（清批次号、不消耗尝试）、结束本轮，审计写"投递前复核失败 N 组"并 `console.error`。
**代价**：复核长时间不可用时邮件停在 `pending`（最终按 24 小时丢弃），管理员得从审计与函数日志看原因。

## 让"能真实执行的测试"覆盖关键路径

早期测试大多做源码字符串断言，两个必然失败的问题（迁移里 `name[] = text[]`、中继的 `sendMail` 第二参数）在测试里毫无痕迹 → `tests/sql-migrations.test.mjs` 用 PGlite 按文档顺序执行整套 SQL，`tests/mail-relay.test.mjs` 用真实 nodemailer 驱动真实 HTTP handler；字符串契约只用于"多处必须同时成立"。
**代价**：两个 devDependencies（只在 `npm test` 用）；PGlite 与真实 Supabase 有差异（Edge Runtime、pg_cron、Storage 都不在里面），它证明"SQL 能执行且行为符合断言"，不是生产验收。

## 限频与墙钟都按"暂停"处理，不消耗重试预算

中继默认每分钟 12 封、应用侧每轮 100 封，429 原和真失败同路，几十分钟就能把正常积压打成"永久失败" → 429 按 `Retry-After` 暂停本轮，被限频与同批未发送的行一起退回 `pending`、**不写 `attempts`**；一轮另有时间预算，到点同样原样退回；真实错误（5xx/超时/网络）照旧消耗 5 次预算。
**代价**：积压大时发得慢，提速要放宽中继限频或换服务商；"暂停"路径多一处状态写回，靠测试盯住。

## 时间预算默认取托管免费方案墙钟之内的值

原来默认 240 秒是按"150/400 秒墙钟"估的，但免费方案 worker 墙钟与请求 idle timeout 都是 150 秒，代码还没走到主动收尾就被平台终止 → 默认 110 秒（`src/notify-rules.js` 的 `NOTIFY_QUEUE.maxRuntimeMs` ↔ `app-api` 的 `NOTIFY_DEFAULT_RUNTIME_MS`），`NOTIFY_MAX_RUNTIME_MS` 可覆盖、钳在 55 秒–840 秒；租约按预算派生（预算 + 60 秒，300–900 秒），自托管 compose 覆盖给 240 秒。
**代价**：单轮吞吐下降、大积压要多轮；"默认值必须留在 150 秒内"这条关系靠契约测试锁住，平台抖动仍可能提前终止（剩余行由租约兜底）。

## 定时消费优先主机 cron，pg_cron 只是可选便利

自托管 Postgres 镜像的扩展集固定，pg_cron/pg_net 未必可用，而主机本来就有 cron → `send_notifications` 开放一个不依赖登录会话的入口（`x-app-cron` 恒定时间比较、**只允许这一个动作**）；pg_cron 迁移存在，缺扩展或未配置时只提示并跳过。
**代价**：多一种调用路径，靠测试保证它没被用来做别的事。

## 导出在浏览器端完成

函数分页取数（每页 1000、上限 10 万行）返回 JSON，前端用自带的极简 zip + CRC32 填 `public/export-templates/*.xlsx` 模板 → 不必引入 SheetJS 之类的重依赖。
**代价**：模板要单独构建与校验；超过 10 万行必须缩小日期范围。

## 历史散装 SQL 保留原状，只加 fail-fast 前置检查

把 `supabase/*.sql` 搬进 `migrations/` 会影响已部署库的迁移账本，属于独立清理任务 → 暂不搬迁；新迁移开头检查依赖函数是否存在，缺了就报错并指出该先执行哪个文件。
**代价**：顺序知识仍分散在 README 与文档里；重跑散装文件会重新引入 6 参数版 `app_admin_create_user`（PostgREST 命名参数调用不会静默丢 `p_email`，但要知道这一点）。
