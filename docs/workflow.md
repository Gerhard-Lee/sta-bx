# 申请流程

状态与字段的定义在 [data-model.md](data-model.md)，这里讲**规则**：谁在什么时候能做什么，以及被什么挡住。

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
| 修改附件 | 上述三态 + `finance_pending`、`chair_pending`、`payment_info_required`、`payment_pending` | 只有申请人本人；已提交的附件不会被静默删除，替换会留下 `removed_at` 记录 |

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
| `attachment` 申请附件 | 申请人 | 草稿、退回、撤回、三个待处理态 | 直接生效，无草稿步骤 |
| `qr` 收款码 | 申请人 | `payment_info_required`、`payment_pending` | 写入 `recipient`，状态 → `payment_pending` |
| `receipt` 付款凭证 | **非申请人**且拥有付款登记身份（或内置超级管理员） | `payment_pending`、`paid` | 首次：写 `payments` 记录 + 状态 → `paid`；已在 `paid` 时：视为**更正**，只更新 `payments.reference`，不新增记录 |

补充规则：

- 提交付款必须勾选"已完成转账"确认（`p_confirmed`），流水号 ≤ 120 字，收款人 ≤ 80 字。
- 存在未提交的收款码草稿时，**禁止登记付款**（"收款信息正在修改，请先完成收款信息提交"），防止按过期收款人付款。
- 移除**已提交**的收款码会把 `payment_pending` 退回 `payment_info_required` 并清空 `recipient`——付款被挂起，直到重新提交。**同时会作废本轮的"待付款登记"邮件提醒**（它指向的收款人已经变了），重新提交收款码后会重新提醒付款登记人一次（见 [notifications.md](notifications.md)）。
- 已提交的付款凭证不能删除，只能用新凭证替换。
- 文件校验：`png`/`jpg`/`pdf`，收款码不接受 `pdf`，单文件 ≤ 5 MB，路径必须是 `<申请人>/<申请>/…`。

## 校验发生在哪

| 层 | 位置 | 内容 |
| --- | --- | --- |
| 浏览器 | `src/workflow-rules.js` 的 `validateFile` / `validateStep`，`src/notify-rules.js` 的 `validateEmail` | 只影响提示与按钮可用性 |
| HTTP | `app-api`：金额范围、必填、分页参数、`requireRole` | 挡住明显非法请求 |
| 数据库 | 每个 `app_*` 函数第一行 + check 约束 + 触发器 | **最终裁决**，绕过前端和函数也拦得住 |

新增一条规则时，三层都要落，并且要有对应测试（见 [testing.md](testing.md)）。
