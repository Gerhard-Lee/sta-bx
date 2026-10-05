# 申请流程与权限

状态与字段的定义在 [data-model.md](data-model.md)，这里讲**规则**：谁在什么时候能做什么、被什么挡住。

## 主路径

```
新建草稿 ──提交(v+1)──► 待财委审批 ──通过──┬─ amount >= 门槛 ──► 待主席审批 ──通过──► 待补充收款码
                                          └─ amount <  门槛 ─────────────────────► 待补充收款码
待补充收款码 ──申请人提交收款码+收款人──► 待付款 ──登记流水号+凭证──► 已付款
```

任一审批环节都可以 **退回修改**（申请人改完重新提交，版本 +1）或 **拒绝**（终态）。

## 提交与撤回

| 动作 | 允许的状态 | 规则 |
| --- | --- | --- |
| 提交 `app_submit_application` | `draft`、`changes_requested`、`cancelled` | 只有申请人本人；`version + 1`；把当前 `settings.threshold` 快照进 `rule_threshold`；写时间线"提交申请" |
| 撤回 `app_cancel_application` | `draft`、`changes_requested`、`finance_pending`、`chair_pending` | 只有申请人本人；进入 `cancelled`，之后仍可编辑并重新提交；**进入 `payment_info_required` 之后不能撤回** |
| 编辑正文 `update_application` | `draft`、`changes_requested`、`cancelled` | 只有申请人本人 |
| 修改附件 | 上述三态 + 四个处理中状态（`finance_pending`、`chair_pending`、`payment_info_required`、`payment_pending`） | 只有申请人本人；已提交的附件不会被静默删除，替换会留下 `removed_at` 记录 |

## 审批

`private.app_review_application`（approve / return / reject）的硬性前提：

1. **必须填处理意见**，空意见直接报错。
2. **不能处理自己的申请**（`owner_id = actor` 一律拒绝）。
3. 当前状态必须是 `finance_pending` 或 `chair_pending`，且处理人必须拥有对应的 `finance` / `chair` 身份（内置超级管理员除外）。
4. 通过后的去向用**提交时快照的门槛**判断：`amount >= rule_threshold` → 主席，否则 → 待补充收款码。主席通过后一律 → 待补充收款码。

每次处理都写一条 `approval_actions`（提交申请 / 审批通过 / 退回修改 / 拒绝申请 / 撤回申请 / 提交收款信息 / 登记人工付款 / 更新付款凭证）和一条 `audit_logs`。

## 收款码与付款登记：草稿 → 显式提交

上传文件只产生**草稿**（`pending = true`），必须再调一次"正式提交"才推进状态。这样"选了文件"和"我确认提交"是两个动作，避免误触。

| 类型 | 谁能操作 | 允许的状态 | 正式提交的效果 |
| --- | --- | --- | --- |
| `attachment` 申请附件 | 申请人本人 | 见上表 | 直接生效，无草稿步骤 |
| `qr` 收款码 | 申请人本人 | `payment_info_required`、`payment_pending` | 写入 `recipient`，状态 → `payment_pending` |
| `receipt` 付款凭证 | **非申请人**且拥有付款登记身份（或内置超级管理员） | `payment_pending`、`paid` | 首次：写 `payments` 记录 + 状态 → `paid`；已在 `paid` 时：视为**更正**，只更新 `payments.reference`，不新增记录 |

补充规则：

- 提交付款必须勾选"已完成转账"确认（`p_confirmed`），流水号 ≤ 120 字，收款人 ≤ 80 字。
- 存在未提交的收款码草稿时，**禁止登记付款**（"收款信息正在修改，请先完成收款信息提交"），防止按过期收款人付款。
- 移除**已提交**的收款码会把 `payment_pending` 退回 `payment_info_required` 并清空 `recipient`——付款被挂起，直到重新提交。**同时会作废本轮的"待付款登记"邮件提醒**（它指向的收款人已经变了），重新提交收款码后会重新提醒付款登记人一次（见 [notifications.md](notifications.md)）。
- 已提交的付款凭证不能删除，只能用新凭证替换。
- 文件校验：`png`/`jpg`/`pdf`，收款码不接受 `pdf`，单文件 ≤ 5 MB，路径必须是 `<申请人>/<申请>/…`。

## 身份与权限

### 三个可分配身份 + 一个派生能力

| 值 | 中文 | 存哪 | 能做什么 | 怎么获得 |
| --- | --- | --- | --- | --- |
| `finance` | 财委 | `user_roles` | 处理 `finance_pending`；**同时获得付款登记能力** | 管理员在「设置 → 用户与权限」里分配 |
| `chair` | 主席 | `user_roles` | 处理 `chair_pending` | 管理员分配 |
| `admin` | 管理员 | `user_roles` | 成员/角色/门槛/注册开关/审计/导出/通知设置 | 管理员分配 |
| `cashier` | 付款登记 | **不是 `user_roles` 的一行** | 登记付款、上传付款凭证 | 由 `finance` **派生**：`private.app_user_has_role(u,'cashier')` 在 `u` 拥有 `finance` 时通过；内置超级管理员也通过 |

- `user_roles_role_check` 最终只允许 `'finance','chair','admin'`；前端 `src/workflow-rules.js` 的 `hasRole` 对 `cashier` 看 `finance`，界面允许清单同样是这三个。
- 一个成员可以有多个身份；没有任何身份就是普通申请人。
- **内置 `admin` 账号不会由"首个注册用户"自动产生**（早期版本有，最终生效的 `app_create_user` 已没有这个分支）。空库上线时按 [database-migrations.md](database-migrations.md#执行顺序空库从零建起) 第三步手工建号。

三条铁律：

1. **管理员身份不替代流程身份**：拥有 `admin` 不等于能审批，`app_user_has_role(user,'finance')` 只查 `user_roles` 有没有那一行（外加下面的派生）。
2. **只有内置超级管理员可以跨身份**：用户名（不区分大小写）恰好是 `admin` **且**拥有 `admin` 角色时，对 `finance`/`chair`/`cashier` 的判定一律通过。
3. **内置 `admin` 账号被三重锁死**：`private.protect_builtin_admin()` 触发器覆盖 `app_users`、`profiles`、`user_roles`——不能删、改名、停用、改角色；`app_set_member_roles` 还拒绝管理员改自己。前端只渲染"超级管理员 · 权限已锁定"。

### 动作矩阵

| 动作 | 申请人 | 财委 | 主席 | 普通管理员 | 内置 admin |
| --- | --- | --- | --- | --- | --- |
| 建/改/提交/撤回**自己**的申请；改附件；上传/更换/移除**自己**申请的收款码 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 处理 `finance_pending`（本人提交的除外） | — | ✅ | — | ❌ | ✅ |
| 处理 `chair_pending`（本人提交的除外） | — | — | ✅ | ❌ | ✅ |
| 登记付款 / 上传付款凭证（本人提交的申请除外） | ❌ | ✅（`cashier` 派生） | ❌ | ❌ | ✅ |
| 成员与角色、门槛、注册开关、导出、通知设置 | ❌ | ❌ | ❌ | ✅ | ✅ |
| 绑定/解绑**自己**的邮箱 | ✅ | ✅ | ✅ | ✅ | ✅ |

**任何身份都不能处理自己提交的申请**（`a.owner_id = p_actor_id` 直接拒绝），也不能给别人绑定邮箱；收款码与附件只有申请本人能改。

### 三层判定（必须同步修改）

| 层 | 位置 | 失败表现 |
| --- | --- | --- |
| 界面 | `src/workflow-rules.js`：`isSuperAdmin`、`hasRole`、`canRecordPayment`、`canEditAttachments`… | 按钮/入口不显示（**不是安全边界**） |
| HTTP | `app-api`：`requireRole(actor, role)`、`hasRole(actor, role)` | 403「没有对应操作权限。」 |
| 数据库 | `private.app_user_has_role(...)` 在每个业务函数首行 | 抛中文业务异常，例如「当前不能登记付款」 |

三处的"超管跨身份"与"`cashier` 由 `finance` 派生"必须一致，`tests/workflow.test.mjs` 有一条专门盯住。

### 停用与登录

- `app_users.active = false` → `app_user_has_role`/`app_user_active` 全部返回 false，`app_set_member_roles` 顺手删掉该用户所有会话；已登录令牌在下一次请求时以 403「账号已停用。」失效。
- 停用/撤角色后**不再收到新邮件**：入队过滤 `u.active`，领取时复核身份，每个发送组投递前再复核一次（见 [notifications.md](notifications.md#队列状态机与并发)）。
- `admin` 的通知设置权限指"总开关 + 七类逐类勾选"（`app_update_email_notify`）：勾选只决定发不发，收件人仍由身份与申请归属推导；改动写审计。

## 校验发生在哪

| 层 | 位置 | 内容 |
| --- | --- | --- |
| 浏览器 | `src/workflow-rules.js` 的 `validateFile` / `validateStep`，`src/notify-rules.js` 的 `validateEmail` | 只影响提示与按钮可用性 |
| HTTP | `app-api`：金额范围、必填、分页参数、`requireRole` | 挡住明显非法请求 |
| 数据库 | 每个 `app_*` 函数第一行 + check 约束 + 触发器 | **最终裁决**，绕过前端和函数也拦得住 |

新增一条规则时，三层都要落，并且要有对应测试（见 [testing.md](testing.md)）。
