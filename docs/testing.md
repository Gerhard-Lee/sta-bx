# 测试

```bash
npm install
npm test        # 即 node --test，自动发现 tests/*.test.mjs
```

当前 84 项，全部通过；没有 CI（仓库里没有 `.github/workflows`），所以**提交前必须本地跑一次**。

## 为什么很多测试是"读源文件做字符串断言"

项目没有可用的数据库实例，也不想在 CI 里维护一个 Postgres + Docker。于是采用**契约测试**：把"必须同时成立的多处事实"写成对源码的断言。它们不验证运行时行为（那由 `.verify.sql` 在真实库上验证），但能挡住最容易出的错——**改了其中一处、忘了另外两处**。

典型例子：

```js
// 事件清单：前端数组 / app-api 文案表 / 数据库 check 约束，三处必须逐项相等
assert.deepEqual(sqlEvents, NOTIFY_EVENTS);
assert.deepEqual(apiEvents, NOTIFY_EVENTS);
// 队列参数：前端常量 ↔ app-api 字面量 ↔ 数据库取值范围
assert.match(api, new RegExp(`const NOTIFY_BATCH = ${NOTIFY_QUEUE.batch}\\b`));
assert.match(migration, /p_limit < 1 or p_limit > 200/);
```

另一类是**安全负向断言**：某些东西不许出现。

```js
assert.equal(/action === 'bind_email'[\s\S]{0,300}body\.user_id/.test(api), false);  // 不许由请求体指定收件人
assert.equal(api.includes('console.log(apiKey'), false);                              // 不许打印密钥
assert.equal(cron.includes('https://'), false);                                       // 不许把项目地址写进仓库
assert.equal(/^\s+ports:/m.test(relayBlock), false);                                  // 中继不许发布公网端口
```

纯逻辑（`validateEmail`、`validateFile`、`validateStep`、`hasRole`、`isSuperAdmin`、金额与日期格式化）是**真调用真断言**，因为它们已经抽成 `src/*-rules.js` 的独立模块——这也是把规则从组件里抽出来的理由。

## 各测试文件负责什么

| 文件 | 覆盖 |
| --- | --- |
| `tests/workflow.test.mjs` | 状态机、门槛、附件草稿/提交、身份三处一致性 |
| `tests/member-management.test.mjs` | 成员搜索分页、内置 admin 锁定、重复提交、账户入口 |
| `tests/admin-reporting.test.mjs` | 管理端权限、导出与账目、payload 白名单 |
| `tests/email-notify.test.mjs` | 通知全链路契约：事件、收件人、去重与作废、租约领取、时间预算、限频、定时入口、隐私边界 |
| `tests/docs.test.mjs` | 文档集完整、相对链接与锚点有效、迁移清单与事件清单与代码一致 |
| `tests/self-host-deploy.test.mjs` | 部署层：中继接口形状与不泄露、compose 不发布端口、脚本无硬编码密钥、LF 约束 |
| `tests/workflow-preview.{jsx,html}` | 手工预览夹具，不参与 `npm test` |

## 加一个功能要配什么

1. 迁移 + `.verify.sql`（在真实库上驱动一次行为，见 [database-migrations.md](database-migrations.md)）。
2. 规则抽进 `src/*-rules.js` → 写直接调用的逻辑测试。
3. 跨层事实（事件名、参数、权限判定、密钥来源）→ 写字符串契约断言。
4. 安全相关 → 加一条"不许出现 X"的负向断言。
5. 界面文案被测试引用时（例如按钮文字），改文案要同步改断言——这是有意的摩擦，防止无声改掉用户可见契约。

## 可选的运行时验证

```bash
JSDOM_MODULE=E:\path\to\node_modules\jsdom\lib\api.js node scripts/verify-react-regressions.mjs   # 目前在本分支失效，见 known-issues
node scripts/verify-export-workbooks.mjs                                                          # 校验导出模板
node scripts/build-export-templates.mjs                                                           # 重新生成模板
npx vite build                                                                                    # 唯一的 JSX 编译期检查（需要 VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY，缺了 vite.config.js 会直接报错）
```

`npm test` **不做编译检查**，所以改过 `src/*.jsx` 之后至少跑一次 `vite build`。
