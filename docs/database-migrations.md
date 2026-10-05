# 数据库结构与迁移

## 现状：两套来源

| 来源 | 内容 | 说明 |
| --- | --- | --- |
| `supabase/migrations/<时间戳>_*.sql` | 9 条迁移（其中 4 条带同名 `.verify.sql`） | 新改动一律进这里 |
| `supabase/*.sql`（根目录散装） | `admin-settings-audit.sql`、`member-management-and-resubmission.sql`、`explicit-submission.sql` 三份带同名 `.verify.sql`；`detailed-file-and-review-audit.sql` **没有** verify | 历史遗留：早期直接在 Dashboard 的 SQL 编辑器里执行，没进迁移账本 |

### 现有迁移清单

| 文件（`supabase/migrations/`） | 做了什么 |
| --- | --- |
| `20260929130000_funds.sql` | 初始结构：`profiles`、`user_roles`、`settings`、`applications`、`application_files`、`approval_actions`、`payments`、`audit_logs`；RLS 策略；`application-files` bucket 与对象策略；基于 `auth.uid()` 的旧工作流函数与 `claim_first_admin` |
| `20260929130500_security_and_indexes.sql` | 收紧授权：内部触发器函数 `revoke`，只向 `authenticated` 暴露必要 RPC；补 5 个外键/统计索引 |
| `20260929180000_custom_app_users.sql` | 自研账号体系：`app_users`、`app_sessions`、注册/登录/改密；工作流函数改为显式传 `p_actor_id`；业务表整体 `revoke` |
| `20260929181000_custom_app_users_crypto_search_path.sql` | 给用到 pgcrypto 的三个函数补 `extensions` 搜索路径（否则 `crypt`/`gen_salt` 找不到） |
| `20260929190000_admin_all_permissions.sql` | 一度把"拥有 `admin` 即视同所有流程身份"写进 `app_user_has_role`——**已被下一条推翻**，保留是因为迁移历史不可改写 |
| `20261002133000_separate_admin_and_workflow_roles.sql` + verify | 管理员与流程身份分离；新增 `app_user_is_superadmin`，只有内置 `admin` 跨身份 |
| `20261004210000_email_notify.sql` + verify | 邮箱绑定、七类事件的通知队列与触发器、状态 ↔ 事件映射（`private.app_notify_event_for_status`，触发器与投递前复核同源）、`settings.email_notify_events` 逐类开关、带租约的原子领取（五参数：批次号/上限/租约秒/超龄小时/失败上限）、领取时身份/版本/类型复核与 `app_notify_verify_rows` 白名单投递前复核（send/cancel/skip）、发送前状态复核与 `cancelled` 终态、依赖 fail-fast 检查 |
| `20261005010000_finance_can_record_payment.sql` + verify | 付款登记视同财委身份：重定义 `private.app_user_has_role`，让 `finance` 通过 `cashier` 判定（PR #15 已合并）；通知触发器无需改动即继承新语义 |
| `20261005140000_email_notify_cron.sql` + verify | 可选的 pg_cron 登记函数 `app_register_email_cron()`（探测扩展与 GUC，缺扩展或未配置参数时只输出提示并跳过）；登记逻辑抽成 `private.app_schedule_email_cron(...)`，显式传 pg_net 的 `timeout_milliseconds`（默认 140 秒，可用 `stabx.email_cron_timeout_ms` 调大）；verify 在没有真实 pg_cron 的测试库里用 cron 桩直接验证登记 SQL |

**它们之间有真实依赖**：`20261004210000_email_notify.sql` 重写的 `app_admin_create_user` 调用 `private.app_insert_user`，而后者只在 `admin-settings-audit.sql` 里定义。plpgsql 函数体在建函数时不解析引用，所以缺依赖**不会在迁移时报错，而是等到有人点"添加用户"才炸**。因此该迁移开头有一道 fail-fast：

```sql
if to_regprocedure('private.app_insert_user(text,text,text,text)') is null then
  raise exception '缺少 private.app_insert_user：请先执行 supabase/admin-settings-audit.sql …';
end if;
```

### 执行顺序（空库从零建起）

真实项目上这些早就在账本里了，所以维护时只需要"新迁移排在最后"。若要在一只空库上从零建起，顺序由**依赖**决定（不是简单的"散装 SQL 先、迁移后"）：

1. **基线段迁移**：`20260929130000_funds.sql`（`settings`/`profiles`/业务表）→ `20260929130500` → `20260929180000_custom_app_users.sql`（`app_users`/`app_sessions`）→ `20260929181000` → `20260929190000` → `20261002133000_separate_admin_and_workflow_roles.sql` → `20261005010000_finance_can_record_payment.sql`。散装 SQL 全是对既有表的 `alter`，表还不存在时第一步就报 `relation "public.settings" does not exist`；后两条提供 `private.app_user_has_role` 的当前语义，散装 SQL 会调用它。
2. **散装 SQL 第一份**：`admin-settings-audit.sql`（提供 `private.app_insert_user`、`app_admin_create_user`、以及 `user_roles_role_check` 的最终定义）。
3. **内置 `admin` 账号**（只在空库上需要）：所有 `.verify.sql` 与多个 RPC 都假设它存在，而建号位置**只有一个可插入点**——必须在第 2 步之后、第 4 步之前：`member-management-and-resubmission.sql` 装上的 `protect_builtin_admin` 触发器会让任何补写角色的语句抛"admin 的权限已锁定，任何用户都不能修改"。口令必须是 10–72 位（`private.app_insert_user` 会校验），具体两条语句：
   ```sql
   do $$
   declare super_id uuid;
   begin
     super_id := (private.app_insert_user('admin', '换成至少10位的强口令', '内置管理员', '管理') ->> 'id')::uuid;
     insert into public.user_roles(user_id, role) values (super_id, 'admin');
   end $$;
   ```
   真实项目上这个账号本来就存在，不需要重跑。
4. **其余散装 SQL**：`member-management-and-resubmission.sql`、`detailed-file-and-review-audit.sql`、`explicit-submission.sql`（顺序按文件名列表即可，它们之间没有依赖）。
5. **其余迁移**按文件名时间戳升序：`20261004210000_email_notify.sql`、`20261005140000_email_notify_cron.sql`。前者开头的 fail-fast 会检查第 2 步是否完成。
6. 每个结构文件之后执行**同名 `.verify.sql`（有的话）**，各自包在 `begin; … rollback;` 里。verify 依赖"最终结构"：它们会调用 `private.app_user_has_role`、`private.app_insert_user`、`public.app_list_members` 等最终形态的函数，所以要**在一整套结构都建好之后**再跑，不要夹在中间。

顺序错了不会污染数据，但会报"函数不存在"或"表不存在"。**这份顺序有可执行版本**：`tests/sql-migrations.test.mjs` 在 PGlite 上按同样的顺序（基线段 → 第 1 份散装 SQL → 内置 admin → 其余散装 SQL → 其余迁移 → 全部 `verify`）把整套 SQL 真跑一遍，改顺序会让它直接失败。

> 用 Supabase CLI 管理时注意：手工执行过的 SQL 不在迁移账本里。**`supabase migration repair --status applied` 只改账本（history 表），不会执行任何 SQL**——结构缺东西要先补迁移或经核实的 SQL，只有在"记录与实际不符"时才用它修记录。根目录那几份散装 SQL 没有时间戳、也不是迁移，不要笼统地把它们标成 applied。

## 写迁移的规矩

- 文件名 `<14 位时间戳>_<主题>.sql`，时间戳必须比已有的更大；同时提交 `<同名>.verify.sql`。
- **必须可重复执行**（幂等）：`create or replace function`、`add column if not exists`、`drop constraint if exists` + `add constraint`、`drop index if exists` + `create index if not exists`、`drop trigger if exists` + `create trigger`。
- 函数一律 `security definer` + `set search_path = public, private, pg_temp`（临时 schema 放最后，防劫持），辅助函数放 `private` schema。
- 新表：`enable row level security` + `revoke all on table … from public, anon, authenticated`；新函数：`revoke all … from public, anon, authenticated` + `grant execute … to service_role`。只有确实要让 PostgREST 直接暴露的表才写策略。
- 改函数签名时：先 `drop function if exists <旧签名>`，新参数**带 default** 以兼容既有调用方；`app-api` 通过 PostgREST 以命名参数调用，因此不会被旧重载抢走（`admin-settings-audit.verify.sql` 的六参数写法仍然能跑）。
- 权限判定只走 `private.app_user_has_role`，不要在业务函数里直接查 `user_roles`——否则身份含义变化时（例如"付款登记视同财委"）会漏改一处。
- 业务异常文本用中文短句，前端会直接显示给用户；verify 脚本依赖这些文本做负向断言，改文案要同步改测试。

## verify 脚本的写法

结构固定：`begin;` → 一个 `do $$ … $$;` 块 → `rollback;`，全程不落数据。**要点是驱动真实数据变化来验证行为**，而不是只查对象存在：例如通知的 verify 会真的插申请、改状态、检查队列里出现了谁的行、重复状态是否去重、领取是否带租约、超龄是否丢弃、身份撤销后是否作废、反复中断是否在第五次转 `failed`、非管理员是否被拒。造用户用 `private.app_insert_user`，分配角色借用内置 `admin`（缺该账号时直接抛错，与其他 verify 一致）。

三条踩过的坑：

- **`RAISE` 不能用 `||` 拼字符串**：`raise exception '实际 ' || queued` 是语法错误（`syntax error at or near "||"`），整个 `DO` 块还没开始验证就退出。用占位符：`raise exception '实际 %', queued`（多个值时依次给参数）。
- **`pg_attribute.attname` 是 `name` 类型**：`array_agg(a.attname)` 与 `text[]` 字面量比较会在**解析期**报 `operator does not exist: name[] = text[]`（即使表上没有任何旧约束也照样报）。显式转文字：`array_agg(a.attname::text order by a.attname)`。
- **不要写死"恰好 N 封"**：收件人依赖 `private.app_user_has_role`，权限规则变化（例如"付款登记视同财委"）会让数量改变。用同一处判定函数推出期望集合，再和实际行做集合比较，并显式断言前置条件（确实是两个合格收件人），否则"期望 == 实际"会退化成永真的空断言。

## 本机没有 CLI / 没有 Docker 怎么执行

**先让 `npm test` 打头阵**：`tests/sql-migrations.test.mjs` 用 PGlite（真实 PostgreSQL + pgcrypto 的 WASM 构建）按上面第 1–5 步的顺序，把 4 份散装 SQL、全部迁移与全部 `.verify.sql` 真跑一遍，不需要 Docker、不连任何 Supabase 项目。它证明的是"SQL 能被真实解析并执行、行为断言成立"，**不能替代**在真实 Supabase 测试项目上按顺序执行一遍（Edge Runtime、pg_cron/pg_net、Storage 服务、托管连接池都不在里面）。

有 Docker 时：

```bash
docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/20261004210000_email_notify.sql
```

`storage`/`auth` 服务要先起过一次并建好自己的 schema（`storage.buckets` 等），否则迁移里对 `storage.objects` 的策略会失败。
