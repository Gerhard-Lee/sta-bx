# 已确认但还没修的问题

审查邮件通知功能时逐条核实过，按影响排序。**接手前先扫这一页**，免得把已知问题当新 bug 查。

## 1 `cashier`（付款登记）身份仍然无法从界面分配

`user_roles.role` 允许 `cashier`，但 `src/reporting.js` 的 `ROLE_LABEL` 只有 `finance/chair/admin`，`app_set_member_roles` 与 `app_admin_create_user` 的白名单也只有这三个。
**影响**：界面上没有"付款登记"这个勾选项；"待付款登记"提醒的收件人靠 `private.app_user_has_role(user,'cashier')` 推导。
**已缓解**：PR #15 合并的 `20261005010000_finance_can_record_payment.sql` 让"拥有 `finance` 即通过" `cashier` 判定，所以财委自动获得付款登记能力并收到提醒，**通知侧不需要改代码**（触发器一直调用 `private.app_user_has_role`）。
**注意**：邮件量会上升（每个财委 × 每笔待付款），见 [notifications.md](notifications.md)。

## 2 `scripts/verify-react-regressions.mjs` 在本分支已经跑不起来

`choose()` 找 `.action-block input[type=file]` 时拿到 `null`，随后 `Object.defineProperty(null, …)` 抛错。夹具里的管理员是 `{profile:{id:'manager'},roles:['admin']}`，而"管理员不替代流程身份"之后普通管理员不再有付款登记入口 → 找不到文件输入。
**已验证**：在未修改的 `05ca0bb` 上同样失败，**不是邮件功能引入的**。
**处理**：要么把夹具改成内置超级管理员（`profile.username='admin'`），要么给夹具补 `finance` 身份；这条脚本目前不在 `npm test` 里，所以不会自动暴露。

## 3 `MemberDirectory` 有一处空值保护不完整

`src/admin.jsx`：`result?.profiles.length` 只保护了 `result`，没保护 `profiles`。若 `admin_members` 返回 `data: null`（函数缺失或部署不同步），成员列表整块白屏。
**处理**：改成 `(result?.profiles ?? []).length`。属于成员管理功能，与通知无关，未在本次改动里顺手修。

## 4 管理面板看不到"多少人还没绑定邮箱"

面板只有五类队列计数（待发送/发送中/已发送/失败/已作废），没有"多少人还没绑定邮箱"的汇总。开关开着但没人绑定时，看起来像"通知坏了"。
**处理**：`deploy/check.sh` 已经带了这条 SQL（`已绑定邮箱人数 / 启用成员数`），界面还没接。

## 5 未绑定邮箱的成员没有任何提示

绑定入口在「账户设置」，但成员不会主动去找。
**处理**：建议加一条可关闭的顶部提示（localStorage 记住），点击跳到账户设置。

## 6 没有 CI，也没有 lint

仓库里没有 `.github/workflows`，`package.json` 只有 `dev/build/preview/test` 四个脚本。`npm test` 完全依赖人工执行；`vite build` 不在 `npm test` 里，所以**改过 JSX 只跑测试是查不出编译错误的**。

## 7 邮件的投递语义限制（有意为之，但要知道）

- 不验证邮箱归属，没有确认邮件；地址填错就静默收不到。
- `sent` 只代表服务商**受理**，不代表投递成功、更不代表没进垃圾箱。
- 只有服务商返回非 2xx 才会写进 `last_error`，所以"发出去了但没收到"在系统里查不到痕迹。

## 8 队列没有清理任务

`sent` 行长期保留（只存用户 id，不存地址，隐私上没问题）。bigint 主键 + 少量数据，短期内不需要归档；真要清就按 `sent_at` 做定期删除，别动 `pending`/`failed`。

## 9 前端没有路由，邮件只能给首页链接

`APP_URL` 是平台入口，无法深链到具体申请（应用是单页状态机，没有 URL 参数）。要深链得先做路由层。

## 10 部署脚本没做过真实语法检查

`deploy/drain.sh`、`deploy/check.sh`、`deploy/stabx-notify.cron` 是手写的 POSIX sh，本机（Windows）没有 `sh`/`bash` 可执行，`tests/self-host-deploy.test.mjs` 只做字符串断言。
**上线前先跑**：`sh -n deploy/drain.sh && sh -n deploy/check.sh`。

## 11 版本号硬编码

`src/main.jsx` 的 footer 里写死"版本号 1.0.0"，`package.json` 也是 `1.0.0`，两者没有联动，也没有构建期注入。发版时容易忘记。

## 12 `20261004210000_email_notify.sql` 被就地改写过

该迁移在**未合并、从未部署**的分支上，因此审查修复时直接改了它两次：第一次新增 `sending` 状态、租约、事件集收窄；第二次新增 `cancelled` 终态、把去重唯一约束换成部分唯一索引、`app_bind_email` 改成三参数。每次都保留了对旧结构收敛的 `alter` / `drop ... if exists` 语句。
**如果有人已经在自己的库上执行过旧版本**：迁移账本与文件内容不一致，需要 `supabase migration repair` 或手工重跑该文件（它是幂等的）。

## 已修（本轮邮件审查的产出，留此备查）

队列并发重复寄信 → 租约 + 批次号原子领取；开关关闭期间积压导致补发旧邮件 → 24 小时丢弃；永久失败无出口 → `app_reset_failed_notifications` + 面板按钮；收件人停用后仍寄信 → 发送时二次校验；`admin_data` 静默吞掉队列查询错误 → 逐个检查；前端与新后端部署耦合白屏 → 字段兜底；迁移依赖散装 SQL 却运行期才报错 → fail-fast 前置检查；自托管空 `SUPABASE_SECRET_KEYS` 与内网签名地址 → 两处加固。完整背景见 [decisions.md](decisions.md)。

## 已修（实现审查的第二轮）

发送前不复核状态导致寄出"已经做完的事"、正文状态与事件标题矛盾 → 事件→状态映射 + `cancelled`；中继每分钟 12 封的限频被当成失败、几十分钟就把积压打成永久失败 → 429 不计尝试次数、按 `Retry-After` 暂停本轮；一轮 800 封撞上函数墙钟被硬杀、剩余行还要吃一次尝试 → 240 秒时间预算 + 原样退回；同一版本内"收款码移除 → 重新提交"漏提醒 → 离开 `payment_pending` 时作废旧提醒、去重改部分唯一索引；`app_bind_email` 数据库层不校验调用者 → 三参数签名强制本人；`sameSecret` 注释与实现不符 → 改成如实描述；fail-fast 只查一个依赖 → 补齐 `app_set_member_roles` 与 `app_user_has_role`；`docs/testing.md` 的测试数过期、两处文档锚点失效 → 已更正。详见 [notifications.md](notifications.md) 与 [decisions.md](decisions.md)。

独立复核（只读审查）后又补了四处：自托管 cron 的 curl 超时 90 秒小于函数预算 240 秒 → 默认改 300 秒并用测试绑住两个数；写回失败被当成已处理（计数虚报、行卡在"发送中"）→ `settle` 返回是否成功、计数只在成功后加；迁移里删约束/删函数的作用域过大 → 只删去重那一组列、按函数名删所有重载；领取结果不带 `last_error` → 带上它，退回时不再冲掉上一次的失败原因。
