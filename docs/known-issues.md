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

该迁移在**未合并、从未部署**的分支上，因此审查修复时直接改了它四次：第一次新增 `sending` 状态、租约、事件集收窄；第二次新增 `cancelled` 终态、把去重唯一约束换成部分唯一索引、`app_bind_email` 改成三参数；第三次（PR #19 外部评审）修 `array_agg(a.attname)` 的 `name[] = text[]` 解析错误、加 `app_notify_recipient_allowed` 消费前身份复核与"版本已过期"作废、把 `app_claim_notifications` 改成五参数（失败上限）并让恢复路径也执行它；第四次（复审）把事件集恢复为七类并加 `settings.email_notify_events` 逐类开关、领取时作废被关闭类型、新增 `app_notify_blocked_rows` 供投递前复核、`app_update_email_notify` 改成三参数。每次都保留了对旧结构收敛的 `alter` / `drop ... if exists` / 按函数名删重载的语句，因此对"已经执行过旧版"的库重跑本文件仍然有效。
**如果有人已经在自己的库上执行过旧版本**：迁移账本与文件内容不一致，需要 `supabase migration repair` 或手工重跑该文件（它是幂等的）。

## 已修（本轮邮件审查的产出，留此备查）

队列并发重复寄信 → 租约 + 批次号原子领取；开关关闭期间积压导致补发旧邮件 → 24 小时丢弃；永久失败无出口 → `app_reset_failed_notifications` + 面板按钮；收件人停用后仍寄信 → 发送时二次校验；`admin_data` 静默吞掉队列查询错误 → 逐个检查；前端与新后端部署耦合白屏 → 字段兜底；迁移依赖散装 SQL 却运行期才报错 → fail-fast 前置检查；自托管空 `SUPABASE_SECRET_KEYS` 与内网签名地址 → 两处加固。完整背景见 [decisions.md](decisions.md)。

## 已修（实现审查的第二轮）

发送前不复核状态导致寄出"已经做完的事"、正文状态与事件标题矛盾 → 事件→状态映射 + `cancelled`；中继每分钟 12 封的限频被当成失败、几十分钟就把积压打成永久失败 → 429 不计尝试次数、按 `Retry-After` 暂停本轮；一轮 800 封撞上函数墙钟被硬杀、剩余行还要吃一次尝试 → 240 秒时间预算 + 原样退回；同一版本内"收款码移除 → 重新提交"漏提醒 → 离开 `payment_pending` 时作废旧提醒、去重改部分唯一索引；`app_bind_email` 数据库层不校验调用者 → 三参数签名强制本人；`sameSecret` 注释与实现不符 → 改成如实描述；fail-fast 只查一个依赖 → 补齐 `app_set_member_roles` 与 `app_user_has_role`；`docs/testing.md` 的测试数过期、两处文档锚点失效 → 已更正。详见 [notifications.md](notifications.md) 与 [decisions.md](decisions.md)。

独立复核（只读审查）后又补了四处：自托管 cron 的 curl 超时 90 秒小于函数预算 240 秒 → 默认改 300 秒并用测试绑住两个数；写回失败被当成已处理（计数虚报、行卡在"发送中"）→ `settle` 返回是否成功、计数只在成功后加；迁移里删约束/删函数的作用域过大 → 只删去重那一组列、按函数名删所有重载；领取结果不带 `last_error` → 带上它，退回时不再冲掉上一次的失败原因。

## 已修（PR #19 外部评审的六条）

评审（维护者 yhwlwl）在独立环境里逐条复现，全部已修，并各自补了真实执行测试（见 [testing.md](testing.md)）：

1. **P1 迁移原样执行失败**：`array_agg(a.attname)` 是 `name[]`，与 `text[]` 字面量比较在解析期就报 `operator does not exist: name[] = text[]`（全新库也中招）→ 显式 `::text`。
2. **P1 中继提前返回成功**：nodemailer 的 `sendMail(message, callback)` 第二参数是回调，传 `{ maxAttempts: 1 }` 让 `await` 拿到 `undefined`（HTTP 200 先于投递结果），随后库把该对象当回调调用，抛出 try/catch 之外的 `TypeError` → 只 await 一个 Promise。
3. **P1 角色撤销后仍收到财务详情**：消费时只查 `active`/邮箱，不查当前身份 → 领取时用 `private.app_notify_recipient_allowed` 复核，不合格就地作废并计入「已作废」。
4. **P2 跨版本重提重复发信**：队列存了 `application_version` 却不比较 → 版本不一致就作废。
5. **P2 中断恢复绕过五次上限**：恢复路径只加 `attempts`，反复中断七轮仍是 `sending/attempts=6` → 恢复与投递失败共用 `p_max_attempts`，超龄的 `sending` 行直接丢弃。
6. **P2 新增的 verify 脚本自己跑不起来**：`RAISE EXCEPTION '…' || queued` 语法非法；修完语法后"付款提醒恰好一封"的断言又与 main 已合入的"付款登记视同财委"冲突 → 改 `%` 占位符 + 按合格收件人集合断言，并新增身份撤销/失败上限/超龄 `sending` 的行为验证。

评审同时确认"拒绝/已付款不发邮件"是产品口径问题、不算缺陷，但合并前需要维护者拍板。

### 复审（第二轮）后这条已按维护者建议解决

维护者给的方案是"**保留完整提醒类型，在管理端让管理员勾选，不要把组织偏好写死**"。现在七类事件全部入库，`settings.email_notify_events` 逐类勾选（默认只开五类待办，拒绝申请/已付款默认关、需要时打开），总开关仍在；只有管理员能改、写审计；关掉某类后积压未投递的该类行会在领取时作废。**原来的产品分歧不再需要拍板**——口径变成配置。设计取舍见 [decisions.md](decisions.md) 的"提醒范围交给管理员配置"。

### 真实执行测试顺带抓出来的两条（评审没有看到）

同一类问题在姊妹文件里还有一份、以及一处文档错误，都是新加的 PGlite 真实执行测试暴露的：

- `20261005140000_email_notify_cron.verify.sql:26` 也有 `raise exception '…' || jobs`（PL/pgSQL 语法错误）。它平时只在装了 pg_cron 的分支才会被执行，但**整个 `DO` 块在首次执行时就会被解析**，所以缺扩展的环境同样会报——和评审在邮件迁移里发现的是同一个坑。
- `docs/database-migrations.md` 与 README 的"空库从零建起"顺序写成了"先 4 份散装 SQL，再 `migrations/`"。空库上按这个顺序第一步就报 `relation "public.settings" does not exist`：散装 SQL 全是对既有表的 `alter`，那些表来自 `20260929130000_funds.sql` 与 `20260929180000_custom_app_users.sql`。两处已改成依赖驱动的真实顺序（基线段迁移 → 散装 SQL → 内置 admin → 邮件两条迁移 → verify），并以 `tests/sql-migrations.test.mjs` 作为可执行版本。

## 已修（PR #19 复审 / 第二轮的三条）

复审确认上一轮六条全部修复（含"领取之前撤角色"的场景），另提三条，已全部处理：

1. **提醒范围交给管理员配置**（原来是五类写死）→ 七类事件入库 + `settings.email_notify_events` 逐类勾选，默认只开五类待办；服务端校验枚举、规范化顺序、写审计；普通成员改不了；关掉的类型连积压的行也作废。
2. **P1 领取后、投递前的身份缺口**（领取时复核过，但一轮 100 封 / 每组 5 封，后面的行可能等几十秒）→ 新增 `public.app_notify_blocked_rows(ids)`，`app-api` 在每个发送组之前再复核一次身份与类型开关，被挡下的就地作废；`tests/app-api-notify.test.mjs` 在真实 PGlite + 真实 handler 上复现"RPC 返回后撤角色"，断言 `sent: 0`。
3. **P2 默认预算不适用于托管免费方案**（240 秒 > 官方 150 秒 worker 墙钟与 idle timeout）→ 默认降为 110 秒、`NOTIFY_MAX_RUNTIME_MS` 可覆盖（55 秒–15 分钟，自托管 compose 给 240 秒），并且每组之前判断"剩余时间够不够跑完这一组并收尾"，而不是只看是否大于 0。

## 已修（第三轮：完整代码审查 / 变异测试）

这一轮把两条独立审查（SQL 一条、app-api/前端/测试一条）的发现全部修掉，并用**变异测试**验证了新断言真的抓得住：

- **预算下限低于"一组 + 收尾"门槛**：`NOTIFY_MIN_RUNTIME_MS` 原为 30 秒，而进入一轮的门槛是 40 秒 → 配置 `NOTIFY_MAX_RUNTIME_MS` 落在 [1, 40) 秒时**每轮一封都发不出去**、却返回 200 并写一条"预算 30 秒"的审计（还申请了一次领取）。现在下限由 `组预算 + 收尾 + 单封超时` 派生（55 秒），文档五处与契约测试同步。
- **租约短于允许的预算**：预算上限 900 秒 > 租约 300 秒时，本轮最先领取的行会在中途过期、被另一批抢走并可能重复投递。现在租约按预算派生（预算 + 60 秒，300–900 秒），预算上限收到 840 秒。
- **复核接口失败会烧掉整个队列**（P1）：`app_notify_blocked_rows` 报错时整轮抛 400 → 最多 100 行卡在 `sending`、审计为空、5 轮后全部转 `failed`。现在降级为"该组退回 `pending`、结束本轮、写审计 + `console.error`"，并新增 handler 运行时测试。
- **`settle` 识别不了 0 行写回**：加上 `.select('id')` 并检查返回行数，被别人抢走的行不再被计成"已处理"。
- **复核返回空 reason 会被当成放行**：改为"出现在结果里就算被挡"，reason 为空时填默认文案。
- **投递前复核把总开关当成"该类已关闭"**：更正为只看逐类开关（总开关是暂停，不是作废理由），作废原因不再撒谎。
- **超龄 `sending` 行丢弃不计入 `discarded`**：拆成三条恢复路径，丢弃数如实计入。
- **pg_net 超时说法已过时**：官方文档现在明确 `timeout_milliseconds default 2000`（早期"currently ignored"的说法 2023 年已删除）。定时登记改为显式传超时（默认 140 秒，`stabx.email_cron_timeout_ms` 可调），否则一轮消费几秒就被掐断；登记逻辑抽成 `private.app_schedule_email_cron`，verify 用 cron 桩真实验证任务名/周期/密钥头/超时。
- **迁移对历史脏数据会抛难懂的错误**：`email_notify_events` 可空/越界、`notifications.event` 含集合外取值时，先回填默认值并对越界值给出"列出具体取值"的可操作报错；`app_admin_create_user` 改成与其它函数一致的"按函数名删所有重载"（避免将来出现异构签名时 PostgREST PGRST203）。
- **verify 里的恒真断言与反向夹具缺口**（审查用变异证明旧断言抓不到）：双批次"不得重复领取"改成比较两批 id 交集；收件人改用**显式集合**断言并新增"启用+有邮箱+无身份"的负向成员与 `chair_pending` 驱动；blocked_rows 的"类型关闭/非 sending"两条分支补断言。修完后 N1/N4/N5/N6/N7 五个变异全部被抓到（见 PR 评论）。
- **测试自身的脆弱点**：handler 测试的产物目录改成本文件子目录（不再删掉共享的 `tests/.tmp`）；假 Supabase 客户端的 `.single()`/`.maybeSingle()` 与 `count` 语义对齐真实 PostgREST；`drain({extraEnv})` 的适用范围写进注释；新增"状态中文标签两端一致"的契约测试。
