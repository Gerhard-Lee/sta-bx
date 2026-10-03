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

生产项目已创建初始超级管理员账号 `admin`。管理员可以在「设置」中为其他已注册成员配置财委、主席、财务或管理员角色，并调整主席审批金额门槛。默认门槛为 100 元，恰好 100 元需要主席审批。

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
