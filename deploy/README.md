# 部署这套东西

这里放的是**运维侧**文件：SMTP 中继容器、compose 覆盖、定时消费脚本、自检脚本。应用代码本身不依赖它们，删掉也不影响 `npm run dev` 和 `npm test`。

## 先选一种摆法（决定你要不要服务器）

| 摆法 | 邮件怎么走 | 需要服务器 | 需要域名/备案 | 代码改动 |
| --- | --- | --- | --- | --- |
| **A 云 Supabase + HTTP 邮件 API**（Resend 等） | 函数直接 `fetch` 服务商 HTTPS 接口 | 不需要 | 不需要 | 无 |
| **B 全栈自托管 + QQ 授权码**（推荐起点） | 函数 → 同机 `mail-relay` 容器 → `smtp.qq.com:465` | 需要（2 vCPU / 4 GB 起） | 给成员访问网站才需要；发信本身不需要 | 无 |
| **C 云 Supabase + QQ 授权码** | 函数 → 公网上一个 HTTPS 中继 → QQ | 需要一台能出 465 的机器 | **需要**（中继必须 HTTPS 可达，且境内服务器对外提供域名服务要备案） | 无 |

一句话结论：**QQ 授权码走的是 SMTP，而托管 Edge Functions 官方只禁 25/587、465 实测可用但不被承诺，所以工程上仍需一台能出 465 的机器替它发信**（函数里直连 465 的写法见 [supabase#21977](https://github.com/supabase/supabase/issues/21977)，官方限制见 [Limits](https://supabase.com/docs/guides/functions/limits)）。不想维护机器就选 A（换成 HTTP API 型邮件服务）；想选 QQ/单位邮箱就选 B，把整套放在同一台服务器上，中继只走容器内网，连端口都不用对外开——把 SMTP 单独放进中继还顺带换来 `MAIL FROM` 校验、限频和"授权码不进函数 secrets"。

## B 摆法的落地顺序

1. 服务器装 Docker Engine + Docker Compose **≥ 2.24**（`docker-compose.override.yml` 用到了 `!reset`，用来取消官方 compose 对 5432/6543 的公网映射）。
2. 取官方自托管配置：`git clone --depth 1 --branch self-hosted/<标签> https://github.com/supabase/supabase` 后 `cp -rf supabase/docker/. /opt/stabx-stack/`（或用官方 `curl -fsSL https://supabase.link/setup.sh | sh` 快速安装，再叠加本目录的文件）。
3. 把本目录的 `docker-compose.override.yml` 与 `mail-relay/` 放进同一个部署目录，`cp secrets.env.example .env` 后填值（`chmod 600 .env`）。
4. 起服务：`docker compose -f docker-compose.yml -f docker-compose.override.yml up -d`，等 storage/auth 把自己的表建完（`docker compose ps` 全部 healthy）。
5. 建库：按 README「执行顺序」那段，依次 `docker compose exec -T db psql -U postgres -d postgres < 文件`，最后 `supabase/migrations/` 按时间戳。`20261005140000_email_notify_cron.sql` 会打印"跳过：未安装 pg_cron/pg_net"，这是**预期结果**，定时消费改由下一步的主机 cron 承担。
6. 部署函数：`mkdir -p volumes/functions/app-api && cp ../stabx/supabase/functions/app-api/index.ts volumes/functions/app-api/index.ts`，然后 `docker compose restart functions`。首次调用会从 npm registry 拉 `@supabase/supabase-js`，服务器要能出公网（拉过一次就有 `deno-cache` 卷缓存）。
7. 定时消费：`cp drain.env.example /etc/stabx-notify.env` 填值并 `chmod 600`，`cp stabx-notify.cron /etc/cron.d/stabx-notify && chmod 644 /etc/cron.d/stabx-notify`。
8. 自检：`sh deploy/check.sh`（SMTP 出口 → 中继存活/鉴权 → 真发一封 → 队列与开关 → 定时入口，六层逐项 PASS/FAIL）。
9. 打开功能：管理员进「设置 → 邮件通知」勾选启用并保存，让一位财委在「账户设置」绑定邮箱，然后提交一笔申请测试——队列应出现 1 封"待财委审批"，点「立即发送」后对方收件。
10. 备份：`pg_dump` + `volumes/db/data` + `volumes/storage` 定期推对象存储（阿里云上就是 OSS，配生命周期规则）。自托管没有云端自动备份，这一步别省。

## 安全边界（已经按这些约束写好，改动时请保持）

- `STABX_NOTIFY_TIMEOUT`（默认 **300** 秒）是 curl 的 `--max-time`，必须**大于**函数侧一轮消费的预算 `NOTIFY_MAX_RUNTIME_MS`：本 compose 覆盖把它设成 240 秒（`${NOTIFY_MAX_RUNTIME_MS:-240000}`），托管环境下不设该变量则用代码默认的 110 秒（那是给免费方案 150 秒墙钟留的余量）。客户端先超时断开的话，函数来不及把没发送的行退回队列，它们会卡在"发送中"直到租约到期（并多计一次尝试）。改预算时要一起改这个值。
- `mail-relay` 只 `expose`，**永远不写 `ports:`**：公网扫不到它，只有同 compose 网络的 `functions` 能访问。
- 两个不同的密钥：`EMAIL_RELAY_TOKEN`（函数↔中继）与 `CRON_SECRET`（主机 cron↔函数），都不进仓库、不进数据库、不进日志。
- 中继会**拒绝任何不等于认证账号的发件地址**（QQ 的 `MAIL FROM` 规则），并且日志里不打印正文、收件人和授权码。
- `RELAY_RATE_PER_MINUTE`（默认 12）在应用侧的"每轮 100 封、5 并发"之外再加一层，专门用来躲 QQ 的风控。**超限返回 `429` 与 `Retry-After`**：app-api 据此暂停本轮、把没发送的行退回队列稍后重试，且**不计入失败尝试**——这一层比应用侧慢得多，大积压时是吞吐瓶颈，要提速就调这个值（代价是更容易被 QQ 风控）。
- 数据库端口不对公网开放；安全组只放行 443（和限源 IP 的 22）。

## 换邮件服务商要改什么

只改 `.env` 里的 `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` 五项。例如换成阿里邮件推送：`SMTP_HOST=smtpdm.aliyun.com`、`SMTP_PORT=465`、`SMTP_USER=` 控制台设置的发信地址、`SMTP_PASS=` 该地址的 SMTP 密码（需要你先给自己的域名配好 SPF/DKIM）。`app-api` 与数据库都不用动。

## 常见失败对照

| 队列里的 `last_error` / 现象 | 原因与处理 |
| --- | --- |
| `401 中继密钥不正确` | `EMAIL_API_KEY` 与 `RELAY_TOKEN` 不是同一个值，或函数没重启 |
| `400 发件地址必须等于 xxx@qq.com` | `EMAIL_FROM` 的裸地址与 `SMTP_USER` 不一致（显示名可以随便起，地址必须一样） |
| `429 超过每分钟 N 封` | 触发中继限频，队列会自动退避重试（限频不计入失败次数）；台账里显示"稍后重试"和"本轮退回"属正常，想快就调 `RELAY_RATE_PER_MINUTE`（但会更容易被 QQ 风控） |
| `550 …` / `SMTP 认证失败` | 授权码错（不是 QQ 密码）、没在 QQ 后台开启 IMAP/SMTP 服务，或该账号被临时限制 |
| 定时任务日志一直 401 | `CRON_SECRET` 与 `/etc/stabx-notify.env` 里的值不一致，或函数改完没重新部署 |
| 邮件都进了垃圾箱 | 换自有域名邮箱并配 SPF/DKIM；正文别加链接以外的营销措辞；降低频率 |
| 附件预览打不开、URL 是 `http://api-gw:8000/…` | `SUPABASE_PUBLIC_URL` 没设或函数没重启（`toPublicUrl` 依赖它） |
