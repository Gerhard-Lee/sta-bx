# 身份与权限

## 四个身份值

| 值 | 中文 | 能做什么 | 怎么获得 |
| --- | --- | --- | --- |
| `finance` | 财委 | 处理 `finance_pending` 的申请 | 管理员分配 |
| `chair` | 主席 | 处理 `chair_pending` 的申请 | 管理员分配 |
| `cashier` | 付款登记 | 登记付款、上传付款凭证 | **数据库允许，界面不分配**；PR #15 合并后"拥有 `finance` 即通过"，实际由财委承担（见 [known-issues.md](known-issues.md)） |
| `admin` | 管理员 | 成员/角色/门槛/注册开关/审计/导出/通知设置 | 管理员分配；第一个注册用户自动获得 |

一个成员可以同时有多个身份；没有任何身份就是普通申请人。

## 三条铁律

1. **管理员身份不替代流程身份**。拥有 `admin` 不等于能审批：`app_user_has_role(user,'finance')` 只查 `user_roles` 里有没有那一行。这是 `20261002133000_separate_admin_and_workflow_roles.sql` 确立的分离。
2. **只有内置超级管理员可以跨身份**：用户名（不区分大小写）恰好是 `admin` **且**拥有 `admin` 角色。此时对 `finance`/`chair`/`cashier` 的判定一律通过。
   ```sql
   private.app_user_has_role(u, r) = 账号启用 且 ( user_roles 里有 (u,r) 行  或  (r ∈ {finance,chair,cashier} 且 u 是内置超级管理员) )
   ```
3. **内置 `admin` 账号被三重锁死**：`private.protect_builtin_admin()` 触发器覆盖 `app_users`、`profiles`、`user_roles` 三张表——不能删、不能改名、不能停用、不能改角色；`app_set_member_roles` 另外还拒绝"管理员修改自己"（`p_user_id = p_actor_id`）。前端对应 `protectedAccount`，那一行只渲染"超级管理员 · 权限已锁定"，不给任何输入控件。

## 三层判定的落点（必须同步修改）

| 层 | 位置 | 失败表现 |
| --- | --- | --- |
| 界面 | `src/workflow-rules.js`：`isSuperAdmin`、`hasRole`、`canRecordPayment`、`canEditAttachments`… | 按钮/入口不显示（**不是安全边界**） |
| HTTP | `app-api`：`requireRole(actor, role)`、`hasRole(actor, role)` | 403「没有对应操作权限。」 |
| 数据库 | `private.app_user_has_role(...)` 在每个业务函数首行 | 抛中文业务异常，例如「当前不能登记付款」 |

三处的"超管跨身份"规则必须一致，`tests/workflow.test.mjs` 有一条专门盯住它（"付款登记视同财委：前端、API 与数据库三处判定一致"）。

## 动作矩阵

| 动作 | 申请人 | 财委 | 主席 | 付款登记 | 普通管理员 | 内置 admin |
| --- | --- | --- | --- | --- | --- | --- |
| 建/改/提交/撤回自己的申请 | ✅ | ✅（自己的） | ✅ | ✅ | ✅ | ✅ |
| 处理 `finance_pending` | — | ✅ | — | — | ❌ | ✅ |
| 处理 `chair_pending` | — | — | ✅ | — | ❌ | ✅ |
| 处理任何申请（**本人提交的除外**） | — | ❌ |  | ❌ |  | ✅ |
| 上传收款码 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 登记付款/上传凭证 | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| 成员与角色、门槛、注册开关、导出、通知设置 | ❌ | ❌ |  | ❌ | ✅ | ✅ |
| 绑定自己的邮箱 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**任何身份都不能处理自己提交的申请**（数据库层 `a.owner_id = p_actor_id` 直接拒绝），也不能给别人绑定邮箱。

## 停用与登录

- `app_users.active = false` → `app_user_has_role`/`app_user_active` 全部返回 false，并且 `app_set_member_roles` 会顺手删掉该用户所有会话；已登录的令牌在下一次请求时以 403「账号已停用。」失效。
- 停用成员的邮箱**不再收到新邮件**：入队时过滤 `u.active`，发送时再查一次 `active`（否则会把提醒发给已经离开的成员）。

## 付款登记视同财委（已随 PR #15 合并）

`20261005010000_finance_can_record_payment.sql` 把 `cashier` 的判定改成"拥有 `finance` 即通过"，**通知收件人不需要跟着改**：触发器一直通过 `private.app_user_has_role(u.id,'cashier')` 问同一个函数，身份含义变化会自动流过去。所以现在所有财委都会收到"待付款登记"提醒——这是预期效果，也意味着邮件量会上升，见 [notifications.md](notifications.md#容量与频率)。
