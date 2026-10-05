# 已确认但还没解决的问题

只记**当前仍未解决**的问题与真实限制；修复过程与评审往来留在 PR / commit 里，不在这里记流水账。**接手前先扫这一页**，免得把已知问题当新 bug 查。

## 1 没有 CI，也没有 lint

仓库里没有 `.github/workflows`，`package.json` 只有 `dev/build/preview/test` 四个脚本。`npm test` 完全依赖人工执行；`vite build` 不在 `npm test` 里，所以**改过 JSX 只跑测试是查不出编译错误的**。

## 2 `scripts/verify-react-regressions.mjs` 跑不起来

`choose()` 找 `.action-block input[type=file]` 时拿到 `null`，随后 `Object.defineProperty(null, …)` 抛错：夹具里的管理员是普通管理员，而"管理员不替代流程身份"之后他没有付款登记入口，也就找不到文件输入。
**处理**：把夹具改成内置超级管理员（`profile.username='admin'`）或给它补 `finance` 身份。该脚本不在 `npm test` 里，不会自动暴露。

## 3 `MemberDirectory` 有一处空值保护不完整

`src/admin.jsx` 里的 `result?.profiles.length` 只保护了 `result`：`result` 非空但**缺少 `profiles`**（后端与前端形状不一致、局部部署）时 `undefined.length` 直接抛错，成员列表整块白屏。（`result` 为 `null` 时反而不会抛，会走"没有符合条件的用户"。）
**处理**：改成 `(result?.profiles ?? []).length`。

## 4 管理面板看不到"多少人还没绑定邮箱"

面板只有队列计数（待发送/发送中/已发送/失败/已作废），没有"多少人还没绑定邮箱"的汇总。开关开着但没人绑定时，看起来像"通知坏了"。
**处理**：`deploy/check.sh` 已经带了这条 SQL（`已绑定邮箱人数 / 启用成员数`），界面还没接。

## 5 未绑定邮箱的成员没有任何提示

绑定入口在「账户设置」，但成员不会主动去找。
**处理**：建议加一条可关闭的顶部提示（localStorage 记住），点击跳到账户设置。

## 6 邮件的投递语义限制（有意为之，但要知道）

- 不验证邮箱归属，没有确认邮件；地址填错就静默收不到。
- `sent` 只代表服务商**受理**（HTTP 2xx），不代表投递成功、更不代表没进垃圾箱。
- 服务商非 2xx、请求超时、网络异常都会写进 `last_error`；但"服务商已受理、收件方没收到"（进垃圾箱、被拒收）在系统里查不到痕迹。
- 复核挡不住"已经进入 HTTP 调用"的那一封：投递前复核把窗口压到复核返回到 `fetch` 之间的几毫秒，但它终究不是"作废后绝不会收到"，详见 [notifications.md](notifications.md#已知限制)。

## 7 队列没有清理任务

`sent`/`cancelled` 行长期保留（只存用户 id，不存地址，隐私上没问题）。bigint 主键 + 少量数据，短期内不需要归档；真要清就按 `sent_at` 做定期删除，别动 `pending`/`failed`。

## 8 前端没有路由，邮件只能给首页链接

`APP_URL` 是平台入口，无法深链到具体申请（应用是单页状态机，没有 URL 参数）。要深链得先做路由层。

## 9 部署脚本的语法检查要人工跑

`deploy/drain.sh`、`deploy/check.sh`、`deploy/secrets.env.example` 都必须是能被 POSIX sh 解析的文本（`check.sh` 会直接 `. ./.env`，模板里的值因此一律加引号）。`tests/self-host-deploy.test.mjs` 只做字符串断言，语法要人工验：
`sh -n deploy/drain.sh && sh -n deploy/check.sh && sh -n deploy/secrets.env.example`（Windows 上可用 Git 自带的 `"C:\Program Files\Git\bin\sh.exe" -n <文件>`）。

## 10 版本号硬编码

`src/main.jsx` 的 footer 里写死"版本号 1.0.0"，`package.json` 也是 `1.0.0`，两者没有联动，也没有构建期注入。发版时容易忘记。

## 11 `20261004210000_email_notify.sql` 在分支内被就地改写过

该迁移**尚未合并、从未部署**，所以分支内直接改了它多次（每次改动都在 PR 里说明）。对"已经执行过旧版本"的库：**直接重跑这个文件即可**——它保留了收敛旧结构的 `alter`、`drop ... if exists` 与按函数名删重载语句，是幂等的。
账本与实际不一致时才用 `supabase migration repair --status applied` 修**记录**（它不会执行任何 SQL）；结构真的缺东西要先补一个新增/修正迁移，见 [deployment.md](deployment.md#升级与回滚)。

## 12 复核的收件人规则比入队规则弱（今日不可达）

入队时按"待办发给对应身份且**排除申请人本人**、结果通知只发给申请人本人"筛选收件人；投递前复核调用的 `private.app_notify_recipient_allowed(p_user_id, p_event)` 只看"账号 active + 绑了邮箱 + 事件对应的身份"，没有申请归属这一维。
**目前不可达**：全仓没有任何语句会更新 `applications.owner_id`，申请归属不会变。一旦将来加"转移申请人 / 代提交"，复核就会放行一封寄给前申请人的邮件。
**处理**：给这个函数补申请归属参数（两个调用点 `app_claim_notifications` / `app_notify_verify_rows` 都拿得到 `application_id`），或把归属判断收进同一条规则里；改动时要同步 `tests/email-notify.test.mjs` 里对该调用形状的断言。
