# 成都七中科学技术协会 财务报销平台

这是一个组织内部资金申请、分级审批和人工付款登记平台。普通成员提交申请，系统按金额规则生成财委与主席审批步骤，审批完成后由申请人上传支付宝收款码，财务线下转账并登记流水号和付款凭证。

## 本地运行

```bash
npm install
cp .env.example .env
# 填入 Supabase 项目的 URL 与 publishable key
npm run dev
```

## Supabase

数据库迁移位于 `supabase/migrations/`。应用使用自己的 `app_users` 和 `app_sessions` 表登录，不使用 Supabase Auth；`supabase/functions/app-api` 是唯一的数据访问入口，前端不会直接读取业务表。数据库包含角色、申请、审批动作、私有文件元数据、付款记录、审计记录、RLS、Storage bucket 和受保护的工作流函数。

管理员可以在「设置」中为其他已注册成员配置财委、主席或管理员角色，并调整主席审批金额门槛。默认门槛为 100 元，恰好 100 元需要主席审批。付款登记（流水号与付款凭证）视同财委身份完成；内置 admin 超级管理员可以跨身份操作，普通管理员不行。

## 部署

项目使用 Vite 构建，适合部署到 Vercel 或 Cloudflare Pages。生产环境需要配置：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

只使用 publishable key；不要把 Supabase service role key 放入前端或仓库。

## 功能

- 用户名密码登录和注册
- 申请草稿、附件、提交、撤回和退回修改
- 财委审批、金额门槛后的主席审批
- 收款码与付款凭证私有存储
- 财务人工转账后的流水号登记
- 成员角色、审批门槛和审计记录管理
- 浅色响应式中文界面

## QQ 群提醒

QQ 提醒与邮件分别开启。管理员在「设置 → QQ 群提醒」填写目标群的 `group_openid` 并勾选提醒类型；它不是数字 QQ 群号，可从该机器人收到的群消息事件取得。每次状态变化生成一条群提醒，无需成员绑定邮箱；群消息仅包含提醒类型与平台入口，不包含姓名、金额、申请标题或附件。本版本不绑定个人 QQ 身份，也不 @ 指定成员。

上线需要按顺序执行新增的 `*_qq_bot_notify.sql` 迁移、部署更新后的 `app-api`，再部署前端。在 **Supabase Edge Function 服务端 secrets** 配置 `QQ_BOT_APP_ID`、`QQ_BOT_APP_SECRET`，建议配置 `APP_URL` 为平台地址；密钥不要放入 `VITE_*`。测试沙箱可设置 `QQ_BOT_SANDBOX=true`，正式环境删除该值。无需另建常驻服务器或安装 Node SDK。

机器人需加入目标群，具备群主动消息权限，群主需允许机器人主动发言。如 QQ 后台启用了 IP 白名单，须确保实际调用 API 的后端出口满足白名单要求；Cloudflare 前端的 IP 不是 Supabase 函数出口。实际可用权限和额度以 QQ 后台为准。

共用现有 `send_notifications` 定时任务与 `CRON_SECRET`；每轮先处理最多 3 条 QQ 消息，再处理邮件。未配置现有定时任务时不会自动发送，可用管理员「立即发送 QQ 提醒」消费队列。关闭期间的变化不补发；更换群或取消类型会作废旧队列，发送前复核状态及申请版本。24 小时过期，最多尝试 5 次，失败按退避重试；HTTP 429 暂停本轮，10 分钟后重试且不消耗尝试次数。管理员可将仍有效的失败项重新排队。队列展示最近 10 条待发/失败记录，消费结果写入操作日志。网络超时或发送后写回失败时，上游可能已经收到消息，重试可能重复投递。

接口依据：[QQ 官方鉴权](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html)、[发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)。正式环境使用 `https://api.bot.qq.com`；发送成功需收到消息 `id`，权限拒绝不会记作已发送。
