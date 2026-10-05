# 部署

操作细节（文件、脚本、逐步命令）在 [`deploy/README.md`](../deploy/README.md)。这一篇讲**有哪些选择、各自代价、以及每类凭据放在哪里**。

## 拓扑选择

| 方案 | 数据库/函数 | 前端 | 邮件 | 要维护的机器 | 要域名/备案 |
| --- | --- | --- | --- | --- | --- |
| 全托管 | Supabase Cloud | Vercel / Cloudflare Pages | 外部 HTTP API（Resend 等） | 无 | 不需要 |
| 半自托管 | Supabase Cloud | 自己的服务器/NAS | 外部 HTTP API 或自建中继 | 前端那台 | 给成员用就需要 |
| 全自托管 | 官方 docker-compose（精简 5 容器） | 同一台机反代 | 同机 `mail-relay` → SMTP(465) | 一台（2 vCPU / 4 GB 起） | 发信不需要；对外网站需要 |

两个容易判断错的点：

- **邮件走 SMTP（QQ 授权码、单位邮箱、DirectMail）时，必须有一台能出 465 端口的机器**。Supabase 托管 Edge Functions 的官方出站限制只列了 `25` 与 `587`（[Limits](https://supabase.com/docs/guides/functions/limits)），`465` 并不在禁用之列，社区也实测过在函数里用 denomailer 直连 465 发信（[supabase#21977](https://github.com/supabase/supabase/issues/21977)）——**这不是物理上做不到**，而是 465 直连属未承诺行为、且没有 587/STARTTLS 退路（自托管 edge-runtime 是否放行 TCP 也需自行实测）。所以这里**有意**把 SMTP 交给 `deploy/mail-relay` 容器：函数这一侧只说 HTTP，`MAIL FROM` 必须等于认证账号的校验与 `RELAY_RATE_PER_MINUTE` 限频由常驻进程放，SMTP 授权码也留在中继、不进 Edge Function secrets。中继只监听容器网络，不发布任何公网端口。
- **备案只管"用域名对境内提供网站"**，纯出站发信不涉及。云服务器（阿里云）默认封**出方向 25**，所以 SMTP 一律用 465（或 587）。

## 凭据清单

| 位置 | 变量 | 说明 |
| --- | --- | --- |
| 前端构建环境 | `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY` | 只有 publishable key；**绝不放 service role key** |
| Edge Function 密钥 | `EMAIL_API_URL`、`EMAIL_API_KEY`、`EMAIL_FROM`、`APP_URL`、`CRON_SECRET` | 云端用 Dashboard Secrets 或 `supabase secrets set`；自托管写进 compose override 的 `functions.environment`，值来自 `.env`（`chmod 600`，不进仓库） |
| 中继容器 | `SMTP_HOST/PORT/USER/PASS`、`RELAY_TOKEN` | `SMTP_PASS` 是 QQ 的**授权码**，只存在这一处；`RELAY_TOKEN` 与函数的 `EMAIL_API_KEY` 同值 |
| 主机 cron | `/etc/stabx-notify.env`：`STABX_URL`、`STABX_APIKEY`、`CRON_SECRET` | `STABX_APIKEY` 就是前端的 publishable key（公开值）；`CRON_SECRET` 与函数侧同值 |
| 数据库 GUC（可选） | `stabx.email_cron_url` / `_public_key` / `_secret` | 只有选择 pg_cron 调度时才需要；`alter database` 后要**新开连接**再登记 |

仓库里任何文件都不允许出现真实地址、密钥或邮箱账号——`tests/self-host-deploy.test.mjs` 会断言这一点。

## 部署顺序

1. 数据库结构与迁移（顺序见 [database-migrations.md](database-migrations.md)）。
2. 部署函数：云端 `supabase functions deploy app-api`；自托管把 `supabase/functions/app-api/index.ts` 放进 `volumes/functions/app-api/` 后 `docker compose restart functions`。
3. 配好密钥并**重启/重新部署函数**（改 env 不重启是不生效的，最容易踩）。
4. 前端构建 `npm run build`，发布 `dist/`。
5. 建定时消费：主机 cron（`deploy/stabx-notify.cron`）或控制台 Scheduled Functions；不建也能用，只是要人工点「立即发送」。
6. 跑 `sh deploy/check.sh`：SMTP 出口 → 中继存活/鉴权 → 真发一封 → 队列与开关 → 定时入口。
7. 打开「设置 → 邮件通知」，让一位财委绑定邮箱，提交一笔申请验证端到端。

## 升级与回滚

- 迁移只前进：新结构一律新文件；**就地修改已执行过的迁移**会让迁移账本与实际结构不一致，需要 `supabase migration repair`。当前 `20261004210000_email_notify.sql` 属于"分支未合并、从未部署"，因此被就地改写过一次（同时保留了收敛旧结构的 `alter`）。
- 函数改动与迁移有**部署耦合**：前端字段（如 `data.notifications`）都做了空值兜底，后端未同步时设置页不会白屏，但新功能不可用。
- 备份：`pg_dump` + Storage 目录（自托管时是 `volumes/db/data` 与 `volumes/storage`）。云端要确认 PITR/自动备份是否开启——**默认套餐不一定有**。

## 监控什么

| 症状 | 先看 |
| --- | --- |
| 打开页面只显示"连接暂不可用" | **构建时缺 `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`**：Vite 会把这两个 `import.meta.env` 常量折叠成 `undefined`，整个应用被当死代码摇掉，产物只剩错误壳——而且构建**不报错**（本地产物约 223 KB，正常约 274 KB）。`vite.config.js` 已经对这两个变量 fail-fast，所以正常构建缺变量会直接失败；真遇到这页就先看构建日志，再用 `grep -c 启用邮件提醒 dist/assets/*.js` 之类的关键字自检。 |
| 开关开着但队列一直 0 封 | 成员是否绑定邮箱（面板成员列表的"未绑定邮箱"标记）；状态是否真的变化过 |
| 待发送持续上涨 | 定时任务是否在跑；`deploy/check.sh` 第 6 项；函数日志里是否 401（`CRON_SECRET` 不一致） |
| 失败数上涨 | 面板的失败明细（`last_error` 前 200 字）；配好后点「失败项重新排队」 |
| 附件打不开、URL 是内网名 | `SUPABASE_PUBLIC_URL` 未设或函数未重启 |
| 邮件都进垃圾箱 | 发件域名 SPF/DKIM；降低频率；换自有域名发件 |
