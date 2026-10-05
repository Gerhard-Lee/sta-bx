# 成都七中科学技术协会 财务报销平台 · 文档

面向维护者的说明。根目录 `README.md` 是快速上手入口，这里是可以长期查阅的完整版。

| 文档 | 什么时候读 |
| --- | --- |
| [architecture.md](architecture.md) | 想知道请求怎么走过前端 → 函数 → 数据库，为什么这么分层 |
| [data-model.md](data-model.md) | 要加字段、改约束、查表关系、看队列状态机 |
| [workflow.md](workflow.md) | 改申请流程、状态判定、附件与付款登记规则 |
| [roles-and-permissions.md](roles-and-permissions.md) | 改权限、加身份、排查"为什么他不能点这个按钮" |
| [notifications.md](notifications.md) | 邮件通知的一切：事件规则、队列、密钥、定时消费 |
| [database-migrations.md](database-migrations.md) | 要写新迁移，或者要在一个空库上把结构建起来 |
| [testing.md](testing.md) | 要加测试，或不理解为什么测试是字符串断言 |
| [deployment.md](deployment.md) | 部署、换邮件服务商、备份、升级 |
| [decisions.md](decisions.md) | 想知道"为什么是这样而不是那样"——每条决定的背景与代价 |
| [known-issues.md](known-issues.md) | 已确认但还没修的问题，接手前先扫一眼 |

## 系统一句话

组织内部资金申请（报销）平台：成员提交申请与凭证 → 财委审批、超门槛再走主席 → 申请人上传收款码 → 财务线下转账后登记流水号与付款凭证。管理员维护成员、角色、门槛、审计记录并导出财报。

## 三条不可破坏的边界

1. **`supabase/functions/app-api` 是唯一数据入口**。前端只用 `fetch`（`src/api.js`），不引入 supabase-js，也不持有任何能读业务表的凭据。业务权限判定在数据库函数里做第二遍，函数里做的是第三遍。
2. **密钥不进仓库、不进前端、不进日志**。`app_users`/`app_sessions` 是自研账号体系（不用 Supabase Auth），会话令牌只在 `localStorage` 与请求头里出现。
3. **审计不可绕过**。所有写操作都要落 `audit_logs`，由 `private.decorate_audit_log()` 补齐操作人、IP、请求编号与人类可读的描述。
