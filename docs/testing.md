# 测试

```bash
npm install
npm test        # 即 node --test，自动发现 tests/*.test.mjs
```

当前 113 项全部通过；没有 CI（仓库里没有 `.github/workflows`），**提交前必须本地跑一次**。秒级以上的耗时都花在真实执行测试上（PGlite 的整套 SQL 栈 + 真实 handler），具体数字随机器变化，不必写进文档。`tests/helpers/` 下两个模块不是用例文件，只给真实执行测试复用：`sql-stack.mjs` 是 SQL 栈加载器（含一个 cron 桩，让没有真实 pg_cron 的环境也能验证登记 SQL），`pglite-supabase-adapter.mjs` 是把 PostgREST 调用翻译成 PGlite SQL 的假 Supabase 客户端。

**变异验证是新增断言的验收方式**：写完一条断言后，把实现改坏一处，它必须失败。至少要能抓住：去掉领取/投递前的身份检查、事件 ↔ 状态映射错位、漏掉 `status='sending'` 过滤、丢超龄行不计数、把总开关当成"类型已关闭"、投递前复核把 `skip`/缺席当成放行、复核不比对当前申请版本与状态、复核跳过的行被"跳过"与"退回"重复计数（同一行只计一次，6 行的队列必须报出 6 个封数）、终态 `failed` 忘了清 `claim_id`、投递用的是整批开始时的收件地址快照而不是投递前重读的当前地址。抓不住的断言等于注释。

## 三类测试：能真跑的就真跑

1. **真实执行**——能真实运行的部分不允许只做字符串断言：
   - `tests/sql-migrations.test.mjs`：PGlite（真实 PostgreSQL + pgcrypto 的 WASM 构建）按 [database-migrations.md](database-migrations.md) 的顺序把散装 SQL、全部迁移与全部 `.verify.sql` 真跑一遍，再检查对象、签名与行为——解析期错误（例如 `array_agg(a.attname)` 的 `name[] = text[]`）只有真执行才抓得到。
   - `tests/mail-relay.test.mjs`：真实 nodemailer（自定义 transport 只替换 SMTP 那层）+ 真实 HTTP handler，覆盖"投递结果回来之前不能回 200"、失败 502、鉴权/发件地址/限频与 `Retry-After`。
   - `tests/app-api-notify.test.mjs`：esbuild 转译真实 `app-api/index.ts` + 假 Supabase 客户端接 PGlite + 假邮件 fetch，驱动真实 `drainNotifications`：投递前撤角色/关类型不投递、**复核前用真实 RPC 作废正在发送的付款提醒后不投递**、失去本批租约不投递也不改状态、复核返回空数组时不放行、复核失败退回而不烧队列、复核跳过的行不被重复计数（6 行封数对齐）、失败到上限的 `failed` 释放批次号、改绑邮箱后按当前地址投递、预算与审计、结果通知开关。
   - 纯逻辑（`validateEmail`、`validateFile`、`validateStep`、`hasRole`、金额与日期格式化）直接调 `src/*-rules.js` 的真模块——这也是把规则从组件里抽出来的理由。
2. **契约断言**——真实执行代价过高的"多处必须同时成立"（事件清单、队列参数、权限判定入口、密钥来源）写成对源码的断言，挡住"改了一处忘另一处"。例如：

```js
assert.deepEqual(sqlEvents, NOTIFY_EVENTS);                                          // 三处事件清单逐项相等
assert.match(api, new RegExp(`const NOTIFY_BATCH = ${NOTIFY_QUEUE.batch}\\b`));      // 前端常量 ↔ app-api 字面量
assert.equal(/action === 'bind_email'[\s\S]{0,300}body\.user_id/.test(api), false);  // 收件人不许由请求体指定
```

3. **安全负向断言**——某些东西不许出现（打印密钥、把项目地址写进仓库、中继发布公网端口等）。

> PGlite 与真实 Supabase 有差异（Edge Runtime、pg_cron/pg_net、Storage、托管连接池都不在里面），所以它证明的是"SQL 能被真实执行、行为断言成立"，**不是生产验收**。上线前仍要在测试项目上按 [database-migrations.md](database-migrations.md#执行顺序空库从零建起) 跑一遍。

## 各测试文件负责什么

| 文件 | 覆盖 |
| --- | --- |
| `tests/workflow.test.mjs` | 状态机、门槛、附件草稿/提交、身份三处一致性 |
| `tests/member-management.test.mjs` | 成员搜索分页、内置 admin 锁定、重复提交、账户入口 |
| `tests/admin-reporting.test.mjs` | 管理端权限、导出与账目、payload 白名单 |
| `tests/email-notify.test.mjs` | 通知全链路契约：事件清单、收件人、去重与作废、白名单复核、租约与失败上限、预算、限频、定时入口、隐私边界 |
| `tests/sql-migrations.test.mjs` | **真实执行**：整套 SQL 栈 + 对象/签名/行为断言 |
| `tests/mail-relay.test.mjs` | **真实执行**：真实 nodemailer + HTTP handler 的成功/失败/鉴权/限频 |
| `tests/app-api-notify.test.mjs` | **真实执行**：真实 handler + PGlite adapter 的消费路径（见上） |
| `tests/docs.test.mjs` | 文档集完整、相对链接与锚点有效、事件与迁移清单与代码一致 |
| `tests/self-host-deploy.test.mjs` | 部署层：中继接口形状与不泄露、compose 不发布端口、脚本无硬编码密钥、密钥模板可被 sh 解析、LF 约束 |
| `tests/workflow-preview.{jsx,html}` | 手工预览夹具，不参与 `npm test` |

## 加一个功能要配什么

1. 迁移 + `.verify.sql`（在真实库里驱动一次行为，见 [database-migrations.md](database-migrations.md)）；新迁移会被 `tests/sql-migrations.test.mjs` 自动纳入执行清单。
2. 可分层、可本地运行的部分（SQL、HTTP handler、纯函数）写**真实执行**测试，不要只断言源码字符串。
3. 规则抽进 `src/*-rules.js` → 写直接调用的逻辑测试。
4. 跨层事实（事件名、参数、权限判定、密钥来源）→ 写字符串契约断言。
5. 安全相关 → 加一条"不许出现 X"的负向断言。
6. 界面文案被测试引用时（例如按钮文字），改文案要同步改断言——这是有意的摩擦。

## 可选的运行时验证

```bash
JSDOM_MODULE=E:\path\to\node_modules\jsdom\lib\api.js node scripts/verify-react-regressions.mjs   # 目前在本分支失效，见 known-issues
node scripts/verify-export-workbooks.mjs                                                          # 校验导出模板
node scripts/build-export-templates.mjs                                                           # 重新生成模板
npx vite build                                                                                    # 唯一的 JSX 编译期检查（缺 VITE_* 会直接报错）
```

`npm test` **不做编译检查**，改过 `src/*.jsx` 之后至少跑一次 `vite build`。
