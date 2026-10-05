# 数据库结构与迁移

## 现状：两套来源

| 来源 | 内容 | 说明 |
| --- | --- | --- |
| `supabase/migrations/<时间戳>_*.sql` | 9 条迁移（其中 4 条带同名 `.verify.sql`） | 新改动一律进这里 |
| `supabase/*.sql`（根目录散装） | `admin-settings-audit.sql`、`member-management-and-resubmission.sql`、`detailed-file-and-review-audit.sql`、`explicit-submission.sql`（各有同名 `.verify.sql`） | 历史遗留：早期直接在 Dashboard 的 SQL 编辑器里执行，没进迁移账本 |

### 现有迁移清单

| 文件（`supabase/migrations/`） | 做了什么 |
| --- | --- |
| `20260929130000_funds.sql` | 初始结构：`profiles`、`user_roles`、`settings`、`applications`、`application_files`、`approval_actions`、`payments`、`audit_logs`；RLS 策略；`application-files` bucket 与对象策略；基于 `auth.uid()` 的旧工作流函数与 `claim_first_admin` |
| `20260929130500_security_and_indexes.sql` | 收紧授权：内部触发器函数 `revoke`，只向 `authenticated` 暴露必要 RPC；补 5 个外键/统计索引 |
| `20260929180000_custom_app_users.sql` | 自研账号体系：`app_users`、`app_sessions`、注册/登录/改密；工作流函数改为显式传 `p_actor_id`；业务表整体 `revoke` |
| `20260929181000_custom_app_users_crypto_search_path.sql` | 给用到 pgcrypto 的三个函数补 `extensions` 搜索路径（否则 `crypt`/`gen_salt` 找不到） |
| `20260929190000_admin_all_permissions.sql` | 一度把"拥有 `admin` 即视同所有流程身份"写进 `app_user_has_role`——**已被下一条推翻**，保留是因为迁移历史不可改写 |
| `20261002133000_separate_admin_and_workflow_roles.sql` + verify | 管理员与流程身份分离；新增 `app_user_is_superadmin`，只有内置 `admin` 跨身份 |
| `20261004210000_email_notify.sql` + verify | 邮箱绑定、通知队列与触发器、带租约的原子领取与失败重置、发送前状态复核与 `cancelled` 终态、依赖 fail-fast 检查 |
| `20261005010000_finance_can_record_payment.sql` + verify | 付款登记视同财委身份：重定义 `private.app_user_has_role`，让 `finance` 通过 `cashier` 判定（PR #15 已合并）；通知触发器无需改动即继承新语义 |
| `20261005140000_email_notify_cron.sql` + verify | 可选的 pg_cron 登记函数 `app_register_email_cron()`；缺扩展或未配置参数时只输出提示并跳过 |

**它们之间有真实依赖**：`20261004210000_email_notify.sql` 重写的 `app_admin_create_user` 调用 `private.app_insert_user`，而后者只在 `admin-settings-audit.sql` 里定义。plpgsql 函数体在建函数时不解析引用，所以缺依赖**不会在迁移时报错，而是等到有人点"添加用户"才炸**。因此该迁移开头有一道 fail-fast：

```sql
if to_regprocedure('private.app_insert_user(text,text,text,text)') is null then
  raise exception '缺少 private.app_insert_user：请先执行 supabase/admin-settings-audit.sql …';
end if;
```

### 执行顺序（空库从零建起）

1. `supabase/admin-settings-audit.sql`
2. `supabase/member-management-and-resubmission.sql`
3. `supabase/detailed-file-and-review-audit.sql`、`supabase/explicit-submission.sql`
4. `supabase/migrations/` 内按文件名时间戳升序
5. 每步之后可执行同名 `.verify.sql`

顺序错了不会污染数据（verify 全部包在 `begin; … rollback;` 里），但会报"函数不存在"。

> 用 Supabase CLI 管理时注意：手工执行过的 SQL 不在迁移账本里，需要 `supabase migration repair --status applied` 标记，否则 `db push` 会重复执行或报冲突。

## 写迁移的规矩

- 文件名 `<14 位时间戳>_<主题>.sql`，时间戳必须比已有的更大；同时提交 `<同名>.verify.sql`。
- **必须可重复执行**（幂等）：`create or replace function`、`add column if not exists`、`drop constraint if exists` + `add constraint`、`drop index if exists` + `create index if not exists`、`drop trigger if exists` + `create trigger`。
- 函数一律 `security definer` + `set search_path = public, private, pg_temp`（临时 schema 放最后，防劫持），辅助函数放 `private` schema。
- 新表：`enable row level security` + `revoke all on table … from public, anon, authenticated`；新函数：`revoke all … from public, anon, authenticated` + `grant execute … to service_role`。只有确实要让 PostgREST 直接暴露的表才写策略。
- 改函数签名时：先 `drop function if exists <旧签名>`，新参数**带 default** 以兼容既有调用方；`app-api` 通过 PostgREST 以命名参数调用，因此不会被旧重载抢走（`admin-settings-audit.verify.sql` 的六参数写法仍然能跑）。
- 权限判定只走 `private.app_user_has_role`，不要在业务函数里直接查 `user_roles`——否则身份含义变化时（例如"付款登记视同财委"）会漏改一处。
- 业务异常文本用中文短句，前端会直接显示给用户；verify 脚本依赖这些文本做负向断言，改文案要同步改测试。

## verify 脚本的写法

```sql
begin;
do $$
declare …
begin
  select … into flag from public.settings where id = 1;
  if flag is distinct from false then raise exception '…应为…'; end if;
  begin
    perform public.app_bind_email(new_id, new_id, 'not-an-email');
    raise exception '非法邮箱应被拒绝';
  exception when raise_exception then
    if sqlerrm not like '%邮箱格式不正确%' then raise; end if;   -- 预期内的错误吞掉，其他照抛
  end;
end $$;
rollback;
```

要点：**驱动真实数据变化来验证行为**，而不是只查对象存在。例如通知的验证会真的插一条申请、改状态、检查队列里出现了谁的行、重复状态是否被去重、领取是否带租约、超龄是否丢弃、非管理员是否被拒。需要造用户时用 `private.app_insert_user`，需要分配角色时借用内置 `admin`（缺该账号时直接抛错，与其他 verify 脚本一致）。

## 本机没有 CLI 怎么执行

```bash
docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/20261004210000_email_notify.sql
```

`storage`/`auth` 服务要先起过一次并建好自己的 schema（`storage.buckets` 等），否则迁移里对 `storage.objects` 的策略会失败。
