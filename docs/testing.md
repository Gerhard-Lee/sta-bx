# 测试

```bash
npm install
npm test        # 即 node --test，自动发现 tests/*.test.mjs
```

当前 96 项，全部通过；没有 CI（仓库里没有 `.github/workflows`），所以**提交前必须本地跑一次**。其中 `tests/sql-migrations.test.mjs`（6 项，PGlite 真实执行，约 18 秒）是耗时最大的一环。

## 三类测试：能真跑的就真跑

1. **真实执行**——凡是能真实运行的部分，不允许只做字符串断言：
   - `tests/sql-migrations.test.mjs`：用 PGlite（真实 PostgreSQL 18 + pgcrypto 的 WASM 构建）按 [database-migrations.md](database-migrations.md) 的顺序，把 4 份散装 SQL、`migrations/` 下全部迁移与全部 `.verify.sql` **真的执行一遍**，再检查对象、签名与行为。PR #19 评审发现的 `array_agg(a.attname)` 解析错误（`operator does not exist: name[] = text[]`）只有真执行才抓得到。
   - `tests/mail-relay.test.mjs`：真实 nodemailer（自定义 transport 只替换 SMTP 那一层）+ 真实 HTTP server/handler，覆盖"投递结果回来之前不能回 200"、失败回 502、鉴权/发件地址/限频与 `Retry-After`。评审发现的 `sendMail(message, { maxAttempts: 1 })`（第二个参数其实是回调，`await` 拿到 `undefined`）由它复现并永久锁住。
   - 纯逻辑（`validateEmail`、`validateFile`、`validateStep`、`hasRole`、`isSuperAdmin`、金额与日期格式化）直接调用 `src/*-rules.js` 的真模块断言——这也是把规则从组件里抽出来的理由。
2. **契约断言**——真实执行代价过高的"多处必须同时成立"，写对源码的断言：事件清单（前端数组 / app-api 文案表 / 数据库 `check` 约束三处逐项相等）、队列参数（前端常量 ↔ app-api 字面量 ↔ 数据库取值范围）、权限判定入口、密钥来源。它们不验证运行时行为，但能挡住最容易出的错：**改了其中一处、忘了另外两处**。
3. **安全负向断言**——某些东西不许出现。

```js
// 事件清单：前端数组 / app-api 文案表 / 数据库 check 约束，三处必须逐项相等
assert.deepEqual(sqlEvents, NOTIFY_EVENTS);
assert.deepEqual(apiEvents, NOTIFY_EVENTS);
// 队列参数：前端常量 ↔ app-api 字面量 ↔ 数据库取值范围
assert.match(api, new RegExp(`const NOTIFY_BATCH = ${NOTIFY_QUEUE.batch}\\b`));
assert.match(migration, /p_limit < 1 or p_limit > 200/);
// 安全负向：某些东西不许出现
assert.equal(/action === 'bind_email'[\s\S]{0,300}body\.user_id/.test(api), false);  // 不许由请求体指定收件人
assert.equal(api.includes('console.log(apiKey'), false);                              // 不许打印密钥
assert.equal(cron.includes('https://'), false);                                       // 不许把项目地址写进仓库
assert.equal(/^\s+ports:/m.test(relayBlock), false);                                  // 中继不许发布公网端口
```

> PGlite 与真实 Supabase 仍有差异（Edge Runtime、pg_cron/pg_net、Storage、托管连接池都不在里面），所以它证明的是"SQL 能被执行、行为断言成立"，**不是生产验收**。上线前仍要在测试项目上按 [database-migrations.md](database-migrations.md#执行顺序空库从零建起) 跑一遍。

## 各测试文件负责什么

| 文件 | 覆盖 |
| --- | --- |
| `tests/workflow.test.mjs` | 状态机、门槛、附件草稿/提交、身份三处一致性 |
| `tests/member-management.test.mjs` | 成员搜索分页、内置 admin 锁定、重复提交、账户入口 |
| `tests/admin-reporting.test.mjs` | 管理端权限、导出与账目、payload 白名单 |
| `tests/email-notify.test.mjs` | 通知全链路契约：事件、收件人、去重与作废、身份/版本/状态三重复核、租约领取与失败上限、时间预算、限频、定时入口、隐私边界 |
| `tests/sql-migrations.test.mjs` | **真实执行**：PGlite 里按顺序跑散装 SQL、全部迁移与全部 `.verify.sql`（6 项，约 18 秒），并校验对象、五参数签名、旧写法的必然失败与"verify 不留数据" |
| `tests/mail-relay.test.mjs` | **真实执行**：真实 nodemailer + 真实 HTTP handler 的成功/失败/鉴权/限频四条路径 |
| `tests/docs.test.mjs` | 文档集完整、相对链接与锚点有效、迁移清单与事件清单与代码一致 |
| `tests/self-host-deploy.test.mjs` | 部署层：中继接口形状与不泄露、compose 不发布端口、脚本无硬编码密钥、LF 约束 |
| `tests/workflow-preview.{jsx,html}` | 手工预览夹具，不参与 `npm test` |

## 加一个功能要配什么

1. 迁移 + `.verify.sql`（在真实库上驱动一次行为，见 [database-migrations.md](database-migrations.md)）；新迁移会被 `tests/sql-migrations.test.mjs` 自动纳入真实执行清单。
2. 可分层、可本地运行的部分（SQL、HTTP handler、纯函数）→ 写**真实执行**测试，不要只断言源码字符串。
3. 规则抽进 `src/*-rules.js` → 写直接调用的逻辑测试。
4. 跨层事实（事件名、参数、权限判定、密钥来源）→ 写字符串契约断言。
5. 安全相关 → 加一条"不许出现 X"的负向断言。
6. 界面文案被测试引用时（例如按钮文字），改文案要同步改断言——这是有意的摩擦，防止无声改掉用户可见契约。

## 可选的运行时验证

```bash
JSDOM_MODULE=E:\path\to\node_modules\jsdom\lib\api.js node scripts/verify-react-regressions.mjs   # 目前在本分支失效，见 known-issues
node scripts/verify-export-workbooks.mjs                                                          # 校验导出模板
node scripts/build-export-templates.mjs                                                           # 重新生成模板
npx vite build                                                                                    # 唯一的 JSX 编译期检查（需要 VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY，缺了 vite.config.js 会直接报错）
```

`npm test` **不做编译检查**，所以改过 `src/*.jsx` 之后至少跑一次 `vite build`。
