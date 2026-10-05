# 架构

## 分层与一次请求的完整路径

```
浏览器（Vite + React 19，无路由，单页状态机）
  │  src/main.jsx / src/admin.jsx / src/workflow.jsx
  │  纯展示与本地校验：src/workflow-rules.js、src/notify-rules.js、src/reporting.js
  ▼
src/api.js  ── fetch POST {action, ...参数} ──►  Supabase Edge Function: app-api
  │  头：apikey（publishable）+ x-app-session（自研会话令牌）
  ▼
app-api（supabase/functions/app-api/index.ts）
  │  ① 解析会话 → ② 校验动作级权限（requireRole / hasRole）→ ③ 参数清洗
  ├── admin.rpc('app_xxx', {p_...})  ──► PostgREST ──► PostgreSQL 函数（真正的业务规则）
  ├── admin.from('table')            ──► PostgREST（读列表、读设置、写队列状态）
  └── admin.storage.from(bucket)     ──► Storage（上传、删除、createSignedUrl 300 秒）
```

- **前端不直连数据库**：`app_users`、`applications` 等表对 `anon`/`authenticated` 全部 `revoke`，RLS 也没有放行策略；能读到数据的只有持 service key 的 app-api。
- **业务规则写在 PL/pgSQL 里**（`app_submit_application`、`private.app_review_application`、`app_save_workflow_file`…），HTTP 层只做鉴权、参数整形和错误翻译。这样即使有人绕过前端直接打函数，规则仍然成立。
- **函数一律 `security definer` + `set search_path = public, private, pg_temp`**，并且 `revoke ... from public, anon, authenticated` + `grant execute ... to service_role`：只有 app-api 能调用。

## 账号与会话（不用 Supabase Auth）

| 环节 | 实现 |
| --- | --- |
| 口令 | pgcrypto `crypt(pw, gen_salt('bf', 12))`，10–72 字符；比对在 `app_login` 的一条 SQL 里完成 |
| 用户名 | 存前 `lower(trim())`，`app_users_username_lower_idx` 唯一索引保证大小写不敏感的唯一 |
| 会话 | 登录成功由函数生成 32 字节随机令牌，浏览器拿到原文，库里只存 **SHA-256 摘要**（`app_sessions.token_hash`），有效期 30 天 |
| 携带 | 请求头 `x-app-session`（或 `Authorization: Bearer`），每次请求刷新 `last_seen_at` |
| 失效 | 退出登录删除该行；管理员停用成员时 `app_set_member_roles` 直接删掉该用户所有会话 |
| 首个管理员 | 第一个注册的用户自动获得 `admin` 角色（`app_create_user` 里的 `first_user` 分支）；注册开关关掉后只能由管理员建号 |

> 为什么不用 Supabase Auth：见 [decisions.md](decisions.md) 的「自研账号体系，不用 Supabase Auth」。

## 权限的三层落点

同一个动作的判定出现在三处，**必须保持一致**（测试会盯住这件事）：

1. 前端 `src/workflow-rules.js` 的 `hasRole/isSuperAdmin/canRecordPayment…` —— 只决定按钮显示不显示。
2. `app-api` 的 `requireRole(actor, role)` / `hasRole(actor, role)` —— 决定这个 HTTP 动作能不能进来。
3. 数据库 `private.app_user_has_role(user, role)` —— 最终裁决，写在每个业务函数的第一行。

内置超级管理员（用户名恰好是 `admin` 且拥有 `admin` 角色）可以在第 2、3 层跨身份处理财委/主席/付款登记；**普通管理员不等于流程身份**。细节见 [roles-and-permissions.md](roles-and-permissions.md)。

## 文件与私有存储

- bucket `application-files`（`public: false`），路径强制 `<申请人 uuid>/<申请 uuid>/<随机名>`，函数用 `p_storage_path not like a.owner_id::text || '/' || a.id::text || '/%'` 卡死归属。
- 类型白名单 `image/png`、`image/jpeg`、`application/pdf`；收款码不允许 PDF；单文件 5 MB（前端选文件时校验，函数再校验一次）。
- 三类文件语义：`attachment`（申请附件）、`qr`（收款码）、`receipt`（付款凭证）。`qr`/`receipt` 走"草稿 → 显式提交"两步（`pending` 列），已提交的记录**只替换不删除**，旧行标记 `removed_at` 保留在存储里供审计。
- 预览通过 `file_url` 动作换 300 秒签名地址；自托管时函数内网地址会被 `SUPABASE_PUBLIC_URL` 改写（见 [deployment.md](deployment.md)）。

## 审计

`audit_logs` 的 `username`、`ip_address`、`metadata`、`request_id` 列由 `supabase/admin-settings-audit.sql` 添加；`private.decorate_audit_log()`（`supabase/detailed-file-and-review-audit.sql`）在插入前补齐：

- 操作人用户名（查不到就写"系统"，定时任务的审计正是这种情形）；
- 来源 IP 与 `api_action`、请求编号——app-api 通过 `createAdmin()` 注入的 `x-audit-*` 请求头传递，经 PostgREST 的 `request.headers` GUC 读到；
- 把 `detail` 从裸 uuid 改写成"申请「标题」 · ¥金额 · 编号 … · 文件：名 · 收款码 · 收款人：…"这种能直接读的文本，同时把结构化字段塞进 `metadata`。

`private.audit_file_draft_edit()` 会在草稿值被改动时额外记一条"修改文件草稿"，带原值/新值。

## 导出

财报与操作日志导出是**浏览器端**完成的：`app-api` 分页（每页 1000 行、上限 10 万行）取数返回 JSON，`src/reporting.js` 用自带的极简 zip 读写（`unpackTemplate` + CRC32）把数据填进 `public/export-templates/{financial,audit}.xlsx` 模板，因此**不需要 SheetJS 之类的重依赖**。模板由 `scripts/build-export-templates.mjs` 生成、`scripts/verify-export-workbooks.mjs` 校验。

## 时区与文案

所有时间显示统一 `Asia/Shanghai`（`formatDateTime` 用 `Intl.DateTimeFormat('sv-SE', …)`）。界面文案、审计事件名、通知事件名一律中文，且**事件名是数据库约束的一部分**，改名等于改数据契约。
