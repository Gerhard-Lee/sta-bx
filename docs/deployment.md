# 部署

逐步命令、脚本与自托管细节在 [`deploy/README.md`](../deploy/README.md)（三种摆法 A/B/C、compose 覆盖、中继容器、主机 cron、六层自检）。这一篇讲**选择、凭据归属与上线后的检查**。

## 拓扑选择

| 方案 | 数据库/函数 | 前端 | 邮件 | 要维护的机器 | 域名/备案 |
| --- | --- | --- | --- | --- | --- |
| 全托管 | Supabase Cloud | Vercel / Cloudflare Pages | 外部 HTTP API（Resend 等） | 无 | 不需要 |
| 半自托管 | Supabase Cloud | 自己的服务器/NAS | 外部 HTTP API 或自建中继 | 前端那台 | 给成员用就需要 |
| 全自托管 | 官方 docker-compose（本仓库 override 只取消 5432/6543 公网映射并叠加 `mail-relay`，**不删官方服务**） | 同机反代 | 同机 `mail-relay` → SMTP(465) | 一台（建议起步 2 vCPU / 4 GB，这是建议值不是容量承诺） | 发信不需要；对外网站需要 |

两个容易判断错的点：

- **SMTP 走 465 需要一台能出 465 的机器**。托管 Edge Functions 官方出站限制只列 `25`/`587`（[Limits](https://supabase.com/docs/guides/functions/limits)），465 不在禁用之列、社区也实测过直连（[supabase#21977](https://github.com/supabase/supabase/issues/21977)）——不是做不到，而是未承诺、且没有 587/STARTTLS 退路。所以这里**有意**把 SMTP 交给 `deploy/mail-relay`：函数只说 HTTP，`MAIL FROM` 必须等于认证账号的校验与 `RELAY_RATE_PER_MINUTE` 限频由常驻进程放，授权码也留在中继、不进 Edge Function secrets；中继只监听容器网络。
- **备案只管"用域名对境内提供网站"**，纯出站发信不涉及。云服务器默认封出方向 25，所以 SMTP 用 465。

## 凭据清单

| 位置 | 变量 | 说明 |
| --- | --- | --- |
| 前端构建环境 | `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY` | 只有 publishable key；**绝不放 service role key** |
| Edge Function 密钥 | `EMAIL_API_URL`、`EMAIL_API_KEY`、`EMAIL_FROM`、`APP_URL`、`CRON_SECRET`、可选 `NOTIFY_MAX_RUNTIME_MS` | 云端用 Dashboard Secrets 或 `supabase secrets set`；自托管写进 compose override 的 `functions.environment`，值来自 `.env`（`chmod 600`）。`NOTIFY_MAX_RUNTIME_MS` 钳在 55 秒–840 秒，不设时 110 秒、自托管覆盖给 240 秒 |
| 中继容器 | `SMTP_HOST/PORT/USER/PASS`、`RELAY_TOKEN` | `SMTP_PASS` 是 QQ 的**授权码**，只存在这一处；`RELAY_TOKEN` 与 `EMAIL_API_KEY` 同值 |
| 主机 cron | `/etc/stabx-notify.env`：`STABX_URL`、`STABX_APIKEY`、`CRON_SECRET` | `STABX_APIKEY` 就是 publishable key（公开值）；`CRON_SECRET` 与函数侧同值 |
| 数据库 GUC（可选） | `stabx.email_cron_url` / `_public_key` / `_secret` | 只有用 pg_cron 调度时才需要；`alter database` 后要**新开连接**再登记 |

仓库里任何文件都不允许出现真实地址、密钥或邮箱账号——`tests/self-host-deploy.test.mjs` 会断言。

## 部署顺序

1. 数据库结构与迁移：顺序与内置 `admin` 建号方法见 [database-migrations.md](database-migrations.md)。
2. 部署函数：云端 `supabase functions deploy app-api`。**JWT 校验不需要改**：Edge Functions 默认 `verify_jwt = true`，平台会在 handler 之前检查请求带的凭据，但它对兼容性**接受 `apikey` 头里的 publishable/secret key**（[Authorization headers](https://supabase.com/docs/guides/functions/auth-headers)："a key on `apikey` passes the check too"），而本项目前端始终带 `apikey: <publishable key>`（`src/api.js`），所以默认配置下请求能正常到达 handler；应用层再用 `x-app-session` / `x-app-cron` 做真正的鉴权。若某次部署不带 `apikey`（或你想让平台在进 handler 前就拒掉无凭据请求、拿到更清晰的 401），可在 `supabase/config.toml` 里为该函数显式设置 `verify_jwt`（仓库目前没有这个文件），或在部署命令上加 CLI 的 `--no-verify-jwt`（该 flag `functions deploy` 与 `functions serve` 都支持）。自托管把 `supabase/functions/app-api/index.ts` 放进 `volumes/functions/app-api/` 后 `docker compose restart functions`；自托管的 Kong 对 `/functions/v1` 是**透传、不校验 key**（[kong.yml](https://github.com/supabase/supabase/blob/master/docker/volumes/api/kong.yml)："Functions is a passthrough that does NOT validate keys … the runtime handles verify_jwt itself"），`verify_jwt` 同样由 edge-runtime 决定，按同样口径确认即可。
3. 配好密钥并**重启/重新部署函数**（改 env 不重启不生效，最容易踩）。
4. 前端 `npm run build`，发布 `dist/`。
5. 建定时消费：主机 cron（`deploy/stabx-notify.cron`）或控制台 Scheduled Functions；不建也能用，只是要人工点「立即发送」。
6. 跑 `sh deploy/check.sh`（在部署目录里执行，它会 source 同目录 `.env`）：SMTP 出口 → 中继存活/鉴权 → 真发一封 → 队列与开关 → 定时入口。
7. 打开「设置 → 邮件通知」，让一位财委绑定邮箱，提交一笔申请验证端到端。

> 顺序注意：第 2 步的新函数要读 `settings.email_notify_events`，所以第 1 步必须先做完。第 2–4 步之间的窗口里，旧前端保存总开关会收到 400「请选择要发送的提醒类型。」，新前端配旧函数则会报未知操作——按顺序部署即可，前端对缺失字段都有兜底。

## 升级与回滚

- 迁移只前进：新结构一律新文件。**`supabase migration repair` 只改迁移账本（history 表），不执行任何 SQL**：结构缺东西要先补迁移或经核实的 SQL，只在"记录与实际不符"时才用 `--status applied`。当前 `20261004210000_email_notify.sql` 属于"分支未合并、从未部署"，分支内被就地改写过并保留了收敛旧结构的语句——**已经执行过旧版的库直接重跑该文件即可**（幂等）；根目录散装 SQL 没有时间戳，不要笼统标 applied。
- 函数与迁移有**部署耦合**：前端字段都有空值兜底，后端未同步时不会白屏，但新功能不可用。
- 备份：`pg_dump` + Storage 目录（自托管是 `volumes/db/data`、`volumes/storage`）。云端要确认 PITR/自动备份是否开启——默认套餐不一定有。

## 监控什么

| 症状 | 先看 |
| --- | --- |
| 页面只显示"连接暂不可用" | 构建时是否缺 `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`（正常产物约 274 KB，只剩错误壳约 223 KB）；`vite.config.js` 已 fail-fast，先看构建日志 |
| 开关开着但队列一直 0 封 | 成员是否绑定邮箱（面板的"未绑定邮箱"标记）；状态是否真的变化过 |
| 待发送持续上涨 | 定时任务是否在跑；`deploy/check.sh` 第 6 项；函数日志里是否 401（`CRON_SECRET` 不一致） |
| 失败数上涨 | 面板的失败明细（`last_error` 前 200 字）；配好后点「失败项重新排队」 |
| 附件打不开、URL 是内网名 | `SUPABASE_PUBLIC_URL` 未设或函数未重启 |
| 邮件都进垃圾箱 | 发件域名 SPF/DKIM；降低频率；换自有域名发件 |
