# 成都七中科学技术协会 财务报销平台

组织内部资金申请、分级审批与人工付款登记平台。成员提交申请，系统按金额规则生成财委与主席审批步骤，审批完成后由申请人上传支付宝收款码，财务线下转账并登记流水号与付款凭证。

## 本地运行

```bash
npm install
cp .env.example .env
# 填入 Supabase 项目的 URL 与 publishable key
npm run dev
```

缺 `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` 时 `dev`/`build` 直接报错：这两个是 `import.meta.env` 常量，缺了会被折叠成 `undefined`、整个应用被当死代码摇掉，产物只剩渲染"连接暂不可用"的错误壳（`vite.config.js` 负责 fail-fast）。

## 结构速览

- 数据库迁移在 `supabase/migrations/`（新改动一律进这里）；根目录还有几份历史散装 SQL（`supabase/admin-settings-audit.sql` 等），执行顺序由依赖决定。
- **空库从零建起的顺序**（基线段迁移 → `supabase/admin-settings-audit.sql` → 内置 `admin` 建号 → 其余散装 SQL → 其余迁移 → 各自的 `.verify.sql`）与建号 SQL 见 [docs/database-migrations.md](docs/database-migrations.md)；`tests/sql-migrations.test.mjs` 按同一顺序在 PGlite 上真跑一遍。
- 应用使用自己的 `app_users`/`app_sessions` 登录，不用 Supabase Auth；`supabase/functions/app-api` 是唯一数据入口，前端不直连数据库。

## 邮件通知

**七类提醒由管理员在「设置 → 邮件通知」逐类勾选，不在代码里写死组织偏好**：待办类（待财委审批、待主席审批、待付款登记发给对应处理身份且不含申请人本人；退回修改、待补充收款码发给申请人本人）默认开启；结果类（拒绝申请、已付款，只发给申请人本人）默认关闭。已撤回、草稿永远不发。关掉某一类后，积压未投递的该类行会在下一次消费时作废。**完整规则（队列状态机、复核层次、预算、容量与已知边界）见 [docs/notifications.md](docs/notifications.md)**，这里只列配置：

- 发送走 HTTP 邮件服务（请求体 `from/to/subject/html`，兼容 Resend 等；只有 SMTP 邮箱时可在同机加一个 HTTP→SMTP 中继）。为 app-api 配置：`EMAIL_API_URL`、`EMAIL_API_KEY`、`EMAIL_FROM`，可选 `APP_URL`、`CRON_SECRET`、`NOTIFY_MAX_RUNTIME_MS`。
- 消费有两个入口：管理员点「立即发送」，或定时任务 `send_notifications`（带 `x-app-cron: <CRON_SECRET>` 头；未设 `CRON_SECRET` 时该入口一律 401）。投递语义是 **at-least-once**：领取靠批次号 + 租约保证有效租约内不重复领取，已发出但没写回 `sent` 的邮件会重发一次。
- 定时消费用 pg_cron（`supabase/migrations/20261005140000_email_notify_cron.sql`），或主机 cron / 控制台 Scheduled Functions。用 pg_cron 时先设参数再执行迁移，改完密钥可随时 `select public.app_register_email_cron();` 重新登记：

```sql
alter database postgres set stabx.email_cron_url = 'https://<项目 ref>.supabase.co/functions/v1/app-api';
alter database postgres set stabx.email_cron_public_key = '<与前端相同的 publishable key，本身就是公开值>';
alter database postgres set stabx.email_cron_secret = '<与 CRON_SECRET 完全相同>';
-- 可选：pg_net 请求超时（毫秒），默认 140000 = 函数默认预算 110 秒 + 30 秒余量；
-- 调大 NOTIFY_MAX_RUNTIME_MS 时要一起调大，否则一轮消费会被 pg_net 提前掐断。
alter database postgres set stabx.email_cron_timeout_ms = '140000';
```

没有 pg_cron/pg_net 或参数未设置时，该迁移只提示并跳过，不影响其它改动。邮箱地址不做归属验证（没有确认邮件），管理员只看得到成员「是否已绑定邮箱」；`待付款登记` 的收件人由 `private.app_user_has_role(user,'cashier')` 推导，而付款登记能力由财委派生，所以这类提醒发给所有财委（申请人本人除外）。

## 角色与门槛

管理员在「设置」中为成员配置财委、主席或管理员角色并调整主席门槛（默认 100 元，**恰好 100 元需要主席审批**）。付款登记（流水号与付款凭证）由财委派生完成；内置 `admin` 超级管理员可以跨身份操作，普通管理员不行。身份与动作矩阵见 [docs/workflow.md](docs/workflow.md#身份与权限)。

## 部署

前端用 Vite 构建，适合 Vercel / Cloudflare Pages，需要 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_PUBLISHABLE_KEY`（**只用 publishable key，绝不放 service role key**）。云端部署函数注意 JWT 校验开关、自托管（含 SMTP 中继、compose 覆盖、主机 cron、自检脚本）见 [docs/deployment.md](docs/deployment.md) 与 [`deploy/README.md`](deploy/README.md)。

维护者文档在 [`docs/`](docs/README.md)：架构与请求路径、数据模型与状态机、流程与权限、邮件通知、迁移规矩、测试风格、部署与升级、决策记录、已知问题。改代码前先查 [docs/known-issues.md](docs/known-issues.md) 和 [docs/decisions.md](docs/decisions.md)。

## 功能

- 用户名密码登录和注册；申请草稿、附件、提交、撤回和退回修改
- 财委审批、金额门槛后的主席审批；收款码与付款凭证私有存储；财务人工转账后的流水号登记
- 成员角色、审批门槛和审计记录管理；浅色响应式中文界面
