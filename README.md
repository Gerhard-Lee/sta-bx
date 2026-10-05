# 成都七中科学技术协会 财务报销平台

这是一个组织内部资金申请、分级审批和人工付款登记平台。普通成员提交申请，系统按金额规则生成财委与主席审批步骤，审批完成后由申请人上传支付宝收款码，财务线下转账并登记流水号和付款凭证。

## 本地运行

```bash
npm install
cp .env.example .env
# 填入 Supabase 项目的 URL 与 publishable key
npm run dev
```

缺 `VITE_SUPABASE_URL` 或 `VITE_SUPABASE_PUBLISHABLE_KEY` 时 `npm run dev` / `npm run build` 会直接报错：这两个变量在源码里是 `import.meta.env` 常量，缺了会被折叠成 `undefined`，整个应用被当死代码摇掉，产物只会渲染"连接暂不可用"的错误壳（而且构建不报错）。`vite.config.js` 负责 fail-fast，云端部署记得在项目环境变量里配置这两个键。

## Supabase

数据库迁移位于 `supabase/migrations/`。应用使用自己的 `app_users` 和 `app_sessions` 表登录，不使用 Supabase Auth；`supabase/functions/app-api` 是唯一的数据访问入口，前端不会直接读取业务表。数据库包含角色、申请、审批动作、私有文件元数据、付款记录、审计记录、RLS、Storage bucket 和受保护的工作流函数。每份新迁移都配同名 `.verify.sql`，在事务里执行、不保留验证数据。

**执行顺序（空库从零建起）**：`supabase/` 根目录下还有几份历史 SQL 没有收进 `migrations/`，顺序由依赖决定，不是"散装 SQL 先、迁移后"：

1. 基线段迁移：`supabase/migrations/20260929130000_funds.sql`、`20260929130500`、`20260929180000`、`20260929181000`、`20260929190000`、`20261002133000`、`20261005010000`（建出 `settings`/`profiles`/`app_users` 等表，并给出 `private.app_user_has_role` 的当前语义；只有邮件那两条留到第 5 步）
2. `supabase/admin-settings-audit.sql`（提供 `private.app_insert_user`、`public.app_admin_create_user` 等），随后是空库时才需要的**内置 `admin` 账号**
3. `supabase/member-management-and-resubmission.sql`（提供 `public.app_list_members` 等；它会锁死 admin 账号，所以第 2 步的建号必须在此之前）
4. `supabase/detailed-file-and-review-audit.sql` 与 `supabase/explicit-submission.sql`
5. 其余迁移按文件名时间戳升序：`20261004210000_email_notify.sql`、`20261005140000_email_notify_cron.sql`

这套顺序有可执行版本：`tests/sql-migrations.test.mjs` 会在 PGlite 里按同样的顺序把整套 SQL 真跑一遍。`supabase/migrations/20261004210000_email_notify.sql` 开头还会检查第 2 步是否完成，缺依赖时迁移直接报错，不会拖到“添加用户”在运行期才失败。

邮件通知默认关闭，且提醒类型由管理员在「设置 → 邮件通知」逐类勾选（不在代码里写死组织偏好）。共七类：待办类（待财委审批、待主席审批、待付款登记发给拥有对应处理身份的成员且不含申请人自己；退回修改、待补充收款码发给申请人本人——后者就是"审批通过，请补充收款信息"）默认开启；结果类（拒绝申请、已付款只发给申请人本人）默认关闭，管理员需要时打开。已撤回、草稿永远不发。关闭某一类不会生成新提醒，已经积压但尚未发出的会在下一次消费时作废。发送使用 HTTP 邮件服务（请求体为 `from/to/subject/html`，兼容 Resend 等 API；只有 SMTP 邮箱时可在同一台服务器加一个 HTTP→SMTP 中继），需为 app-api 配置以下 Edge Function 密钥（`supabase secrets set ...`），密钥不进入前端、仓库、数据库或日志：

- `EMAIL_API_URL`：邮件服务提交接口地址
- `EMAIL_API_KEY`：邮件服务 API 密钥
- `EMAIL_FROM`：已通过域名验证的发件地址（如 `STA <notify@mail.example.org>`）
- `APP_URL`：可选，邮件正文中的平台入口链接
- `CRON_SECRET`：可选，定时任务消费队列用的随机密钥。未设置时定时入口一律拒绝（401），队列只能由管理员手动消费

消费队列有两个入口，共用同一段逻辑：管理员在「设置 → 邮件通知」点「立即发送」，或定时任务调用 `send_notifications`（带 `x-app-cron: <CRON_SECRET>` 请求头）。定时入口不借用任何人的登录会话，也允许这一个动作，其余动作仍必须登录。每一轮先调用 `app_claim_notifications` 原子领取一批（`FOR UPDATE SKIP LOCKED` + 租约 + 批次号），写回结果时必须同时匹配这三个条件，因此两个人同时点也不会把同一封邮件寄两次；领取时会把"收件人已失去该身份""申请版本已过期""管理员已关闭这一类"的提醒一并作废，只留下仍然成立的待发行。进程被超时打断的批次会连同一次尝试计入下一轮，连续五次仍未完成就转永久失败（不会无限重领），超龄的“发送中”行直接丢弃。失败按 2^n 分钟退避，五次后转永久失败并保留原因，配好邮件服务后可以点「失败项重新排队」。开关关闭期间积压的提醒超过 24 小时会被丢弃，避免重新开启时突然补发几天前的邮件。**每一组（最多 5 封）真正投递之前，还会用数据库再复核一次收件人身份与类型开关**：领取之后到投递之间的窗口里被撤角色或关类型，就地作废而不是寄出。邮件服务返回 429 限频时按 `Retry-After` 暂停本轮、稍后自动重试，不计入失败次数。一轮消费的默认预算 110 秒：托管免费方案的 worker 墙钟与请求 idle timeout 都是 150 秒，所以默认值必须留在其内；自托管可用环境变量 `NOTIFY_MAX_RUNTIME_MS`（毫秒，钳在 55 秒–15 分钟）调大。每开始一组之前先判断剩余时间够不够跑完这一组（最多 15 秒发送 + 写回）并完成收尾（退回队列 + 审计，另留 20 秒），到点把没发出去的提醒原样退回队列。

定时消费用 pg_cron（`supabase/migrations/20261005140000_email_notify_cron.sql`）。项目地址与密钥不进仓库，先在数据库上设置三个参数，再执行该迁移；之后改完密钥可以随时调用 `select public.app_register_email_cron();` 重新登记（按任务名覆盖，不会重复）：

```sql
alter database postgres set stabx.email_cron_url = 'https://<项目 ref>.supabase.co/functions/v1/app-api';
alter database postgres set stabx.email_cron_public_key = '<与前端相同的 publishable key，本身就是公开值>';
alter database postgres set stabx.email_cron_secret = '<与 CRON_SECRET 完全相同>';
-- 可选：pg_net 请求超时（毫秒）。默认 140000 = 函数默认预算 110 秒 + 30 秒余量；
-- 把 NOTIFY_MAX_RUNTIME_MS 调大时（自托管）要一起调大，否则一轮消费会被 pg_net 提前掐断。
alter database postgres set stabx.email_cron_timeout_ms = '140000';
```

没有 pg_cron/pg_net、参数未设置或登记失败时，该迁移只输出提示并跳过，不影响其它改动；也可以改用控制台的 Scheduled Functions，配同样的 `*/5 * * * *` 周期、同一个 `x-app-cron` 头和 `{"action":"send_notifications"}` 请求体。注意 `timeout_milliseconds` **现在真的生效**（官方文档默认 2000 毫秒），所以登记函数会显式传超时；不要把它留在默认值上。

邮箱地址不做归属验证（没有确认邮件），邮件服务返回成功只代表受理：地址填错就只是收不到提醒。管理员侧只看得到成员「是否已绑定邮箱」，看不到地址本身。

收件人身份说明：`待付款登记` 通过 `private.app_user_has_role(user, 'cashier')` 判定。`20261005010000_finance_can_record_payment.sql`（付款登记视同财委，已合并进 main）让"拥有财委即通过"，所以这类提醒发给所有财委（申请人本人除外），不再只发给内置 admin。

管理员可以在「设置」中为其他已注册成员配置财委、主席或管理员角色，并调整主席审批金额门槛。默认门槛为 100 元，恰好 100 元需要主席审批。付款登记（流水号与付款凭证）视同财委身份完成；内置 admin 超级管理员可以跨身份操作，普通管理员不行。

## 文档

维护者文档在 [`docs/`](docs/README.md)：架构与请求路径、数据模型与状态机、流程规则、身份与权限矩阵、邮件通知、迁移规矩、测试风格、部署拓扑、决策记录、已知问题。改代码前先查 [docs/known-issues.md](docs/known-issues.md) 和 [docs/decisions.md](docs/decisions.md)。

## 部署

项目使用 Vite 构建，适合部署到 Vercel 或 Cloudflare Pages。生产环境需要配置：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

只使用 publishable key；不要把 Supabase service role key 放入前端或仓库。

要把整套服务（数据库、接口、附件）放在自己的服务器上，或者邮件通道只有 SMTP（例如 QQ 邮箱授权码）时，见 `deploy/README.md`：里面有三种摆法的取舍、HTTP→SMTP 中继容器、compose 覆盖、主机 cron 定时消费和六层自检脚本 `deploy/check.sh`。

## 功能

- 用户名密码登录和注册
- 申请草稿、附件、提交、撤回和退回修改
- 财委审批、金额门槛后的主席审批
- 收款码与付款凭证私有存储
- 财务人工转账后的流水号登记
- 成员角色、审批门槛和审计记录管理
- 邮件提醒：七类提醒由管理员逐类勾选（默认只开五类待办，拒绝/已付款等结果通知按需打开；总开关默认关闭，需配置邮件服务，队列由定时任务或管理员消费）
- 浅色响应式中文界面
