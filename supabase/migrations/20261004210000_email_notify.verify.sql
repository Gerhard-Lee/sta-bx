-- 迁移后在事务中执行；不保留任何验证数据。
-- 这里除了检查结构与邮箱归一化，还真正驱动一次状态变化来验证入队规则、去重、领取租约、超龄丢弃与失败重置。
begin;
do $$
declare
  flag boolean;
  trigger_count integer;
  unique_count integer;
  stored_email text;
  new_id uuid;
  super_id uuid;
  owner_id uuid;
  finance_id uuid;
  chair_id uuid;
  plain_id uuid;
  nomail_id uuid;
  offline_id uuid;
  app_id uuid;
  queued integer;
  dup integer;
  expected uuid[];
  actual uuid[];
  events_now text[];
  blocked_row bigint;
  allowed_row bigint;
  claim_1_ids bigint[];
  round_index integer;
  claim_1 uuid;
  claim_2 uuid;
  result jsonb;
begin
  select email_notify_enabled into flag from public.settings where id = 1;
  if flag is distinct from false then raise exception '邮件通知总开关默认应为关闭'; end if;
  -- 默认只开五类待办；拒绝申请与已付款是结果通知，默认关（管理员在设置里打开）。
  select email_notify_events into events_now from public.settings where id = 1;
  if events_now is distinct from array['待财委审批','待主席审批','退回修改','待补充收款码','待付款登记']::text[] then
    raise exception '默认提醒类型应为五类待办，实际 %', events_now;
  end if;

  select count(*) into trigger_count from pg_trigger
  where tgname = 'email_notify_status_change' and not tgisinternal;
  if trigger_count <> 1 then raise exception '状态变化通知触发器缺失'; end if;

  -- 去重键现在是部分唯一索引（cancelled 的行不参与去重），不再用唯一约束。
  select count(*) into unique_count from pg_constraint
  where conrelid = 'public.notifications'::regclass and contype = 'u';
  if unique_count <> 0 then raise exception '不应再有通知去重约束，去重由部分唯一索引承担'; end if;
  select count(*) into unique_count from pg_indexes
  where schemaname = 'public' and tablename = 'notifications' and indexname = 'notifications_dedupe_idx';
  if unique_count <> 1 then raise exception '通知去重索引缺失'; end if;

  new_id := (private.app_insert_user('verify_notify_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证用户', '验证')->>'id')::uuid;
  perform public.app_bind_email(new_id, new_id, '  Verify-Notify@Example.COM  ');
  select email into stored_email from public.app_users where id = new_id;
  if stored_email is distinct from 'verify-notify@example.com' then raise exception '邮箱应去空格并转小写保存'; end if;

  begin
    perform public.app_bind_email(new_id, new_id, 'not-an-email');
    raise exception '非法邮箱应被拒绝';
  exception when raise_exception then
    if sqlerrm not like '%邮箱格式不正确%' then raise; end if;
  end;

  perform public.app_bind_email(new_id, new_id, '');
  select email into stored_email from public.app_users where id = new_id;
  if stored_email is not null then raise exception '空值应清除邮箱'; end if;

  -- 队列行为需要内置 admin 代为分配角色。
  select id into super_id from public.app_users where lower(username) = 'admin' and active;
  if super_id is null then raise exception '缺少内置 admin 账号，无法验证通知队列'; end if;

  owner_id := (private.app_insert_user('verify_owner_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证申请人', '验证组')->>'id')::uuid;
  finance_id := (private.app_insert_user('verify_finance_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证财委', '验证组')->>'id')::uuid;
  chair_id := (private.app_insert_user('verify_chair_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证主席', '验证组')->>'id')::uuid;
  -- 反向夹具：账号启用、邮箱已绑、但没有任何身份。所有"按身份发信"的事件都必须跳过它
  -- （审查用变异验证过：没有这个成员时，把中文的财务/付款身份检查删掉，旧断言照样全绿）。
  plain_id := (private.app_insert_user('verify_plain_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证无身份', '验证组')->>'id')::uuid;
  nomail_id := (private.app_insert_user('verify_nomail_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证未绑定', '验证组')->>'id')::uuid;
  offline_id := (private.app_insert_user('verify_offline_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证已停用', '验证组')->>'id')::uuid;
  perform public.app_bind_email(owner_id, owner_id, 'verify-owner@example.com');
  perform public.app_bind_email(finance_id, finance_id, 'verify-finance@example.com');
  perform public.app_bind_email(chair_id, chair_id, 'verify-chair@example.com');
  perform public.app_bind_email(plain_id, plain_id, 'verify-plain@example.com');
  perform public.app_bind_email(offline_id, offline_id, 'verify-offline@example.com');
  -- 数据库层不允许替别人绑定邮箱（app-api 只会传当前登录账号）。
  begin
    perform public.app_bind_email(new_id, owner_id, 'someone-else@example.com');
    raise exception '替别人绑定邮箱应被拒绝';
  exception when raise_exception then
    if sqlerrm not like '%只能绑定自己的邮箱%' then raise; end if;
  end;
  perform public.app_set_member_roles(super_id, finance_id, array['finance'], true);
  perform public.app_set_member_roles(super_id, chair_id, array['chair'], true);
  perform public.app_set_member_roles(super_id, plain_id, array[]::text[], true);
  perform public.app_set_member_roles(super_id, nomail_id, array['finance'], true);
  perform public.app_set_member_roles(super_id, offline_id, array['finance'], true);
  update public.app_users set active = false where id = offline_id;
  -- 内置 admin 也绑邮箱：superadmin 通过 finance/chair/cashier 判定，所以它会是审批类与付款类提醒的收件人之一。
  perform public.app_bind_email(super_id, super_id, 'verify-admin@example.com');

  insert into public.applications(owner_id, title, purpose, amount, category, department, use_date, status, version)
  values (owner_id, '验证邮件通知', '仅用于迁移验证', 12.00, '物资', '验证组', current_date, 'draft', 0)
  returning id into app_id;

  -- 开关关闭：状态变化不入队。
  update public.applications set status = 'finance_pending', version = 1 where id = app_id;
  if exists(select 1 from public.notifications where application_id = app_id) then raise exception '开关关闭时不应生成队列记录'; end if;

  update public.settings set email_notify_enabled = true where id = 1;
  update public.applications set status = 'draft', version = 1 where id = app_id;
  update public.applications set status = 'finance_pending', version = 1 where id = app_id;

  -- 收件人一律用**显式集合**断言，不能用与实现同一个谓词推导：
  -- 那样"删掉中文的 finance/cashier 检查"这类改动会静默通过（审查用变异验证过）。
  expected := array[finance_id, super_id];
  select coalesce(array_agg(recipient_user_id), '{}'::uuid[]) into actual
  from public.notifications where application_id = app_id and application_version = 1 and event = '待财委审批';
  if not (actual <@ expected and actual @> expected) then
    raise exception '待财委审批的收件人应恰好是财委与内置 admin，实际 %', actual;
  end if;

  -- 主席审批：只发主席与内置 admin（superadmin 通过 chair 判定），事件名必须是「待主席审批」。
  update public.applications set status = 'draft', version = 3 where id = app_id;
  update public.applications set status = 'chair_pending', version = 3 where id = app_id;
  expected := array[chair_id, super_id];
  select coalesce(array_agg(recipient_user_id), '{}'::uuid[]) into actual
  from public.notifications where application_id = app_id and application_version = 3 and event = '待主席审批';
  if not (actual <@ expected and actual @> expected) then
    raise exception '待主席审批的收件人应恰好是主席与内置 admin，实际 %', actual;
  end if;
  if exists(select 1 from public.notifications where application_id = app_id and application_version = 3 and event = '待财委审批') then
    raise exception 'chair_pending 不应生成待财委审批（事件映射错位）';
  end if;

  -- 同一版本同一事件重复进入同一状态：去重，只留一封。
  update public.applications set status = 'draft', version = 1 where id = app_id;
  update public.applications set status = 'finance_pending', version = 1 where id = app_id;
  select count(*) into queued from public.notifications where application_id = app_id and event = '待财委审批' and recipient_user_id = finance_id;
  if queued <> 1 then raise exception '同一版本同一事件应只保留一封，实际 %', queued; end if;

  -- 重新提交会升版本：同一事件应再次入队。
  update public.applications set status = 'draft', version = 2 where id = app_id;
  update public.applications set status = 'finance_pending', version = 2 where id = app_id;
  select count(*) into queued from public.notifications where application_id = app_id and event = '待财委审批' and recipient_user_id = finance_id;
  if queued <> 2 then raise exception '新版本应重新入队，实际 %', queued; end if;

  -- 申请人自己要动手的两类：只发给申请人本人，不打扰审批人或无身份成员。
  update public.applications set status = 'changes_requested' where id = app_id;
  expected := array[owner_id];
  select coalesce(array_agg(recipient_user_id), '{}'::uuid[]) into actual
  from public.notifications where application_id = app_id and event = '退回修改';
  if not (actual <@ expected and actual @> expected) then raise exception '退回修改只应发给申请人本人，实际 %', actual; end if;
  update public.applications set status = 'payment_info_required' where id = app_id;
  expected := array[owner_id];
  select coalesce(array_agg(recipient_user_id), '{}'::uuid[]) into actual
  from public.notifications where application_id = app_id and event = '待补充收款码';
  if not (actual <@ expected and actual @> expected) then raise exception '待补充收款码只应发给申请人本人，实际 %', actual; end if;

  -- 收款码被移除（payment_pending → payment_info_required）会把本轮的“待付款登记”提醒作废，
  -- 重新提交收款码后必须能再次提醒付款登记人（同一版本内允许第二次）。
  -- 合格收件人用显式集合断言（不能用与实现同一个谓词推导）：付款登记视同财委 → 内置 admin 与财委各一封；
  -- 主席、无身份成员、未绑邮箱、已停用都不收。
  expected := array[finance_id, super_id];

  update public.applications set status = 'payment_pending' where id = app_id;
  if not exists(select 1 from public.notifications where application_id = app_id and event = '待付款登记' and recipient_user_id = super_id and status = 'pending') then
    raise exception '进入待付款登记应提醒付款登记身份';
  end if;
  update public.applications set status = 'payment_info_required' where id = app_id;
  if not exists(select 1 from public.notifications where application_id = app_id and event = '待付款登记' and status = 'cancelled') then
    raise exception '移除收款码应作废本轮的待付款登记提醒';
  end if;
  update public.applications set status = 'payment_pending' where id = app_id;
  select coalesce(array_agg(recipient_user_id), '{}'::uuid[]) into actual
  from public.notifications
  where application_id = app_id and event = '待付款登记' and status <> 'cancelled';
  if not (actual <@ expected and actual @> expected) then
    raise exception '重新提交收款码后应再次入队：收件人应恰好是内置 admin 与财委（期望 %，实际 %）', expected, actual;
  end if;

  -- 消费前复核收件人身份（审查发现 P1-3）：撤销财委角色、账号仍启用时，指向他的待发提醒必须在领取时作废，
  -- 不能因为“入队时有身份”就把申请标题与金额继续寄给已经没有查看权限的人。
  perform public.app_set_member_roles(super_id, finance_id, array[]::text[], true);
  if private.app_user_has_role(finance_id, 'finance') then raise exception '前置条件失败：财委角色应已撤销'; end if;
  claim_1 := gen_random_uuid();
  result := public.app_claim_notifications(claim_1, 200, 300, 24, 5);
  if coalesce((result->>'cancelled')::integer, 0) < 1 then raise exception '撤销身份后应作废指向该收件人的提醒，实际作废 % 封', result->>'cancelled'; end if;
  if exists(select 1 from public.notifications where application_id = app_id and recipient_user_id = finance_id
            and status in ('pending','sending')) then
    raise exception '撤销身份后不应再有指向该收件人的待发提醒';
  end if;
  if not exists(select 1 from public.notifications where application_id = app_id and recipient_user_id = finance_id
                and status = 'cancelled' and last_error like '%不具备该待办的处理身份%') then
    raise exception '身份撤销导致的作废应保留原因';
  end if;

  -- 完结态没有需要动手的人：拒绝与已付款都不入队。
  update public.applications set status = 'rejected' where id = app_id;
  update public.applications set status = 'paid' where id = app_id;
  if exists(select 1 from public.notifications where application_id = app_id and event in ('拒绝申请','已付款')) then raise exception '完结态不应生成队列记录'; end if;

  -- 领取参数必须受约束。
  begin
    perform public.app_claim_notifications(gen_random_uuid(), 0, 300, 24, 5);
    raise exception '领取数量应被校验';
  exception when raise_exception then
    if sqlerrm not like '%领取数量无效%' then raise; end if;
  end;
  begin
    perform public.app_claim_notifications(gen_random_uuid(), 10, 300, 24, 0);
    raise exception '失败重试上限应被校验';
  exception when raise_exception then
    if sqlerrm not like '%失败重试上限无效%' then raise; end if;
  end;

  -- 把验证产生的行做得最老（仍在 24 小时窗口内），保证它们最先被领取，不受库里其它待发行影响。
  -- 上面那次身份复核的领取会把本申请的待发行一起领成 sending，这里先原样退回 pending，
  -- 否则下面的“本轮应领取 N 封”会退化成 0 == 0 的空断言。
  update public.notifications set status = 'pending', claim_id = null, lease_expires_at = now()
    where application_id = app_id and status = 'sending';
  update public.notifications set created_at = now() - interval '23 hours' where application_id = app_id and status = 'pending';
  select count(*) into queued from public.notifications where application_id = app_id and status = 'pending';
  claim_1 := gen_random_uuid();
  result := public.app_claim_notifications(claim_1, 200, 300, 24, 5);
  -- 只比较本次验证产生的行：库里可能存在其它待发行，它们同样会被领取。
  select count(*) into dup from public.notifications where claim_id = claim_1 and application_id = app_id;
  if dup <> queued then raise exception '本轮应领取本次验证产生的 % 封，实际 %', queued, dup; end if;
  -- 记下第一批的 id 集合，供"第二批不得重复领取"使用（见下）。
  select coalesce(array_agg((element->>'id')::bigint), '{}'::bigint[]) into claim_1_ids
  from jsonb_array_elements(result->'rows') element;
  if exists(select 1 from public.notifications where claim_id = claim_1 and status <> 'sending') then raise exception '已领取的行必须处于发送中'; end if;
  if exists(select 1 from public.notifications where claim_id = claim_1 and lease_expires_at <= now()) then raise exception '领取必须带上未过期的租约'; end if;
  if exists(select 1 from public.notifications where application_id = app_id and status = 'pending' and next_attempt_at <= now()) then raise exception '到期的待发行应被本轮领走'; end if;

  -- 第二个批次不得重复拿到同一个 id（租约内不可见）。
  -- 断言方式：直接比较两批返回的 id 集合。原先写的是 `claim_id = claim_1 and id in (第二批返回的 id)`，
  -- 第二批返回的行按定义属于 claim_2，两个 uuid 不可能相等——那条断言恒真，挡不住"第二批偷走同一行"。
  claim_2 := gen_random_uuid();
  result := public.app_claim_notifications(claim_2, 200, 300, 24, 5);
  select count(*) into dup from (
    select (element->>'id')::bigint as id from jsonb_array_elements(result->'rows') element
    intersect
    select unnest(claim_1_ids)
  ) overlap;
  if dup <> 0 then raise exception '同一封邮件不应被两个批次领取，实际重复 % 封', dup; end if;

  -- 上一轮中断（租约过期）：重新排队并计入一次尝试。
  update public.notifications set lease_expires_at = now() - interval '1 minute' where claim_id = claim_1;
  claim_2 := gen_random_uuid();
  result := public.app_claim_notifications(claim_2, 200, 300, 24, 5);
  if not exists(select 1 from public.notifications where claim_id = claim_2 and attempts = 1) then raise exception '中断批次应重新领取并计入一次尝试'; end if;

  -- 超龄提醒丢弃并保留原因：丢弃只针对待发送行，所以先把本轮发送中的行退回队列再压龄。
  update public.notifications set status = 'pending', created_at = now() - interval '30 days'
    where application_id = app_id and status in ('pending','sending');
  result := public.app_claim_notifications(gen_random_uuid(), 200, 300, 24, 5);
  if exists(select 1 from public.notifications where application_id = app_id and status in ('pending','sending')) then raise exception '超龄提醒不应继续留在队列'; end if;
  if not exists(select 1 from public.notifications where application_id = app_id and status = 'failed' and last_error like '%已丢弃') then raise exception '丢弃应保留原因'; end if;
  if coalesce((result->>'discarded')::integer, 0) < 1 then raise exception '丢弃数应计入返回结果，实际 %', result->>'discarded'; end if;

  -- 中断恢复同样执行失败上限（审查发现 P2-5）：反复“领取 → 租约过期”不能无限重领。
  -- 旧版恢复路径只加 attempts 而领取时不再看上限，七轮之后仍停在 sending/attempts=6。
  update public.applications set status = 'draft', version = 5 where id = app_id;
  update public.applications set status = 'payment_info_required', version = 5 where id = app_id;
  perform public.app_claim_notifications(gen_random_uuid(), 200, 300, 24, 5);
  for round_index in 1..5 loop
    update public.notifications set lease_expires_at = now() - interval '1 minute'
      where application_id = app_id and status = 'sending';
    perform public.app_claim_notifications(gen_random_uuid(), 200, 300, 24, 5);
  end loop;
  if exists(select 1 from public.notifications where application_id = app_id and status = 'sending') then
    raise exception '反复中断不应让提醒一直停在发送中';
  end if;
  if not exists(select 1 from public.notifications where application_id = app_id and status = 'failed'
                and attempts = 5 and last_error like '%次发送未完成，已停止重试%') then
    raise exception '中断恢复应在尝试次数用满后判失败';
  end if;

  -- 超龄的发送中行恢复时不能走“普通中断”那条路被退回队列、又在同一轮寄出。
  -- 要同时满足“超龄”与“租约已过期”，才会走进恢复分支。
  update public.applications set status = 'draft', version = 6 where id = app_id;
  update public.applications set status = 'payment_info_required', version = 6 where id = app_id;
  perform public.app_claim_notifications(gen_random_uuid(), 200, 300, 24, 5);
  select count(*) into queued from public.notifications where application_id = app_id and status = 'failed' and last_error like '%小时未发送，已丢弃%';
  update public.notifications set created_at = now() - interval '30 days', lease_expires_at = now() - interval '1 minute'
    where application_id = app_id and status = 'sending';
  result := public.app_claim_notifications(gen_random_uuid(), 200, 300, 24, 5);
  if exists(select 1 from public.notifications where application_id = app_id and status in ('pending','sending')) then
    raise exception '超龄的发送中行恢复后不应继续留在队列：%', (select string_agg(id || ':' || event || ':v' || application_version || ':' || status || ':' || attempts, ', ')
      from public.notifications where application_id = app_id and status in ('pending','sending'));
  end if;
  if (select count(*) from public.notifications where application_id = app_id and status = 'failed' and last_error like '%小时未发送，已丢弃%') <= queued then
    raise exception '超龄的发送中行恢复时应记为已丢弃';
  end if;
  -- 恢复分支丢弃的超龄 sending 行也要计入返回结果的 discarded（否则审计里"丢弃 N 封"会少报）。
  if coalesce((result->>'discarded')::integer, 0) < 1 then
    raise exception '超龄 sending 行恢复丢弃时应计入 discarded，实际 %', result->>'discarded';
  end if;

  -- 永久失败可以重新排队；但只有管理员可以。
  perform public.app_reset_failed_notifications(super_id);
  if exists(select 1 from public.notifications where application_id = app_id and status = 'failed') then raise exception '重置后失败项应回到待发送'; end if;
  begin
    perform public.app_reset_failed_notifications(owner_id);
    raise exception '非管理员不应能重置队列';
  exception when raise_exception then
    if sqlerrm not like '%没有管理员权限%' then raise; end if;
  end;

  -- 跨版本重提（审查发现 P2-4）：重置把各版本的失败行都退回了队列，此时申请是 version = 6，
  -- 队列里 v2/v5 的提醒都是"上一版待办"。这些行的 created_at 还停在上一段的 30 天前，
  -- 先把它们拉回时间窗内，让本段只考察"版本"这一条规则，而不是又被超龄丢弃抢先处理。
  update public.notifications set created_at = now() where application_id = app_id and status = 'pending';
  perform public.app_claim_notifications(gen_random_uuid(), 200, 300, 24, 5);
  if exists(select 1 from public.notifications where application_id = app_id
            and application_version <> 6 and status <> 'cancelled') then
    raise exception '版本不一致的旧提醒应在领取时作废：%', (select string_agg(id || ':' || event || ':v' || application_version || ':' || status || ':' || attempts, ', ')
      from public.notifications where application_id = app_id and application_version <> 6 and status <> 'cancelled');
  end if;
  if not exists(select 1 from public.notifications where application_id = app_id
                and application_version <> 6 and status = 'cancelled' and last_error like '%申请已重新提交（版本%') then
    raise exception '版本作废应保留原因';
  end if;
  if not exists(select 1 from public.notifications where application_id = app_id
                and application_version = 6 and status = 'sending') then
    raise exception '当前版本的提醒不应被误作废';
  end if;

  -- 提醒类型配置（复审要求「交给管理员勾选」）：
  -- 1) 结果类（拒绝申请/已付款）默认关的时候不入队（上面已断言），打开后应提醒申请人本人；
  -- 2) 数组乱序、去重后按固定顺序保存；非枚举值被拒；只有管理员能改；
  -- 3) 关掉某一类后，已经积压的该类提醒在领取时作废；
  -- 4) 投递前复核函数把"领取之后被撤身份"的行挡下（handler 侧另有一条运行时测试）。
  perform public.app_update_email_notify(super_id, true, array['已付款','拒绝申请','待付款登记']);
  select email_notify_events into events_now from public.settings where id = 1;
  if events_now is distinct from array['待付款登记','拒绝申请','已付款']::text[] then
    raise exception '提醒类型应按固定顺序去重保存，实际 %', events_now;
  end if;

  update public.applications set status = 'draft', version = 7 where id = app_id;
  update public.applications set status = 'rejected', version = 7 where id = app_id;
  if not exists(select 1 from public.notifications where application_id = app_id and event = '拒绝申请' and recipient_user_id = owner_id) then
    raise exception '打开结果通知后，拒绝申请应提醒申请人本人';
  end if;
  if exists(select 1 from public.notifications where application_id = app_id and event = '拒绝申请' and recipient_user_id <> owner_id) then
    raise exception '拒绝申请只应发给申请人本人';
  end if;
  update public.applications set status = 'paid', version = 7 where id = app_id;
  expected := array[owner_id];
  select coalesce(array_agg(recipient_user_id), '{}'::uuid[]) into actual
  from public.notifications where application_id = app_id and event = '已付款';
  if not (actual <@ expected and actual @> expected) then
    raise exception '已付款只应发给申请人本人，实际 %', actual;
  end if;
  -- 结果类也不能发给"启用+有邮箱但没有身份"的成员（负向夹具）。
  if exists(select 1 from public.notifications where application_id = app_id and recipient_user_id = plain_id) then
    raise exception '无身份成员不应收到任何提醒';
  end if;

  begin
    perform public.app_update_email_notify(owner_id, true, array['拒绝申请']);
    raise exception '普通成员不应能修改提醒设置';
  exception when raise_exception then
    if sqlerrm not like '%没有管理员权限%' then raise; end if;
  end;
  begin
    perform public.app_update_email_notify(super_id, true, array['不存在的类型']);
    raise exception '非法提醒类型应被拒绝';
  exception when raise_exception then
    if sqlerrm not like '%提醒类型无效%' then raise; end if;
  end;

  -- 单类关闭：先打开待财委审批并造一封积压提醒，再关掉该类型，领取时应作废而不是寄出。
  perform public.app_update_email_notify(super_id, true, array['待财委审批','待主席审批','退回修改','待补充收款码','待付款登记','拒绝申请','已付款']);
  perform public.app_set_member_roles(super_id, finance_id, array['finance'], true);
  update public.applications set status = 'draft', version = 8 where id = app_id;
  update public.applications set status = 'finance_pending', version = 8 where id = app_id;
  if not exists(select 1 from public.notifications where application_id = app_id and application_version = 8 and event = '待财委审批' and status = 'pending') then
    raise exception '打开待财委审批后应入队';
  end if;
  perform public.app_update_email_notify(super_id, true, array['待主席审批','退回修改','待补充收款码','待付款登记','拒绝申请','已付款']);
  perform public.app_claim_notifications(gen_random_uuid(), 200, 300, 24, 5);
  if exists(select 1 from public.notifications where application_id = app_id and application_version = 8 and event = '待财委审批' and status <> 'cancelled') then
    raise exception '关闭类型后已积压的该类提醒应作废';
  end if;
  if not exists(select 1 from public.notifications where application_id = app_id and application_version = 8 and event = '待财委审批' and status = 'cancelled' and last_error like '%已关闭%') then
    raise exception '关闭类型的作废应保留原因';
  end if;

  -- 投递前复核（PR #19 终审 P2 起是“白名单”契约）：领取之后才发生的变化必须被挡住，而且只有数据库
  -- 明确判定 send 的行才允许投递——没出现在结果里（旧版把缺席当放行）或判定 skip 的行一律不放行。
  perform public.app_update_email_notify(super_id, true, array['待财委审批','待主席审批','退回修改','待补充收款码','待付款登记','拒绝申请','已付款']);
  perform public.app_set_member_roles(super_id, finance_id, array['finance'], true);
  update public.applications set status = 'draft', version = 9 where id = app_id;
  update public.applications set status = 'finance_pending', version = 9 where id = app_id;
  select id into blocked_row from public.notifications
   where application_id = app_id and application_version = 9 and event = '待财委审批' and recipient_user_id = finance_id;
  select id into allowed_row from public.notifications
   where application_id = app_id and application_version = 9 and event = '待财委审批' and recipient_user_id = super_id;
  if blocked_row is null or allowed_row is null then raise exception '前置条件失败：财委与内置 admin 都应收到待审批提醒'; end if;
  claim_1 := gen_random_uuid();
  perform public.app_claim_notifications(claim_1, 200, 300, 24, 5);
  if not exists(select 1 from public.notifications where id = blocked_row and status = 'sending' and claim_id = claim_1) then
    raise exception '前置条件失败：待审批提醒应已被本批领取';
  end if;

  -- 1) 领取之后撤销身份：明确判 cancel，并带可读原因。
  perform public.app_set_member_roles(super_id, finance_id, array[]::text[], true);
  result := public.app_notify_verify_rows(claim_1, array[blocked_row]);
  if not exists(select 1 from jsonb_array_elements(result) e
                where (e->>'id')::bigint = blocked_row and e->>'verdict' = 'cancel'
                  and e->>'reason' like '%不具备该待办的处理身份%') then
    raise exception '领取后撤销身份的行应被投递前复核判为 cancel，实际 %', result;
  end if;
  -- 2) 身份与版本/状态都仍然成立的行必须被明确放行（“没出现在结果里就发”已经不再成立）。
  result := public.app_notify_verify_rows(claim_1, array[allowed_row]);
  if not exists(select 1 from jsonb_array_elements(result) e
                where (e->>'id')::bigint = allowed_row and e->>'verdict' = 'send') then
    raise exception '身份仍有效的行应被投递前复核明确放行，实际 %', result;
  end if;
  -- 3) 总开关只暂停、不作废：关掉总开关不影响逐类勾选的行被放行（handler 下一轮直接 skipped）。
  perform public.app_update_email_notify(super_id, false, array['待财委审批','待主席审批','退回修改','待补充收款码','待付款登记','拒绝申请','已付款']);
  result := public.app_notify_verify_rows(claim_1, array[allowed_row]);
  if not exists(select 1 from jsonb_array_elements(result) e
                where (e->>'id')::bigint = allowed_row and e->>'verdict' = 'send') then
    raise exception '总开关关闭只应暂停，不应影响投递前复核的放行判定，实际 %', result;
  end if;
  -- 4) 反过来，逐类开关关掉后，正在发送的那一行必须判 cancel。
  perform public.app_update_email_notify(super_id, true, array['待主席审批','退回修改','待补充收款码','待付款登记','拒绝申请','已付款']);
  result := public.app_notify_verify_rows(claim_1, array[allowed_row]);
  if not exists(select 1 from jsonb_array_elements(result) e
                where (e->>'id')::bigint = allowed_row and e->>'verdict' = 'cancel' and e->>'reason' like '%已关闭%') then
    raise exception '关掉某一类后，投递前复核应把该类正在发送的行判为 cancel，实际 %', result;
  end if;

  -- 5) 终审 P2 的核心：领取之后被工作流作废的行，旧版会因为“没出现在 blocked 结果里”而被放行寄出。
  --    这里先恢复配置，再把这一行改成 cancelled（模拟移除收款码触发器的作废），复核必须判 skip：
  --    既不放行，也不把它改回别的状态。
  perform public.app_update_email_notify(super_id, true, array['待财委审批','待主席审批','退回修改','待补充收款码','待付款登记','拒绝申请','已付款']);
  update public.notifications set status = 'cancelled', claim_id = null, lease_expires_at = now(),
         last_error = '收款信息已变更，本次待付款登记提醒作废' where id = blocked_row;
  result := public.app_notify_verify_rows(claim_1, array[blocked_row]);
  if coalesce((select e->>'verdict' from jsonb_array_elements(result) e where (e->>'id')::bigint = blocked_row), 'absent') <> 'skip' then
    raise exception '已被作废的提醒应判为 skip（缺席与 skip 都不是放行证据），实际 %', result;
  end if;
  if not exists(select 1 from public.notifications where id = blocked_row and status = 'cancelled' and claim_id is null) then
    raise exception '投递前复核不应改动已作废行的状态';
  end if;
  -- 5b) 请求里不存在的 id：结果里没有它就是不放行（handler 只在拿到明确 send 时才投递）。
  if public.app_notify_verify_rows(claim_1, array[9223372036854775807::bigint]) <> '[]'::jsonb then
    raise exception '不存在的 id 不应出现在复核结果里（缺席不是放行）';
  end if;

  -- 6) 复核前已经失去本批租约（批次号变成别人的）的行同样只能 skip：不放行，也不被别人改状态。
  result := public.app_notify_verify_rows(claim_2, array[allowed_row]);
  if coalesce((select e->>'verdict' from jsonb_array_elements(result) e where (e->>'id')::bigint = allowed_row), 'absent') <> 'skip' then
    raise exception '批次号不匹配的行应判为 skip，实际 %', result;
  end if;
  -- 6b) 缺少批次号（p_claim_id 为 null）时一行都不放行：即使那一行的 claim_id 也是 null，
  --     `is distinct from` 也会为假，不能让它落进 send。
  result := public.app_notify_verify_rows(null, array[allowed_row]);
  if coalesce((select e->>'verdict' from jsonb_array_elements(result) e where (e->>'id')::bigint = allowed_row), 'absent') <> 'skip' then
    raise exception '缺少批次号时不应放行任何行，实际 %', result;
  end if;
  -- 7) 租约已过期的行只能 skip：等中断恢复那条路处理，不能在这里寄出。
  update public.notifications set lease_expires_at = now() - interval '1 minute' where id = allowed_row;
  result := public.app_notify_verify_rows(claim_1, array[allowed_row]);
  if coalesce((select e->>'verdict' from jsonb_array_elements(result) e where (e->>'id')::bigint = allowed_row), 'absent') <> 'skip' then
    raise exception '租约已过期的行应判为 skip，实际 %', result;
  end if;
  update public.notifications set lease_expires_at = now() + interval '5 minutes' where id = allowed_row;
  -- 8) 非 sending 的行同样只能 skip：把状态过滤写成“不属于本批就跳过”之后，这一条仍然要能抓住
  --    漏掉状态/批次/租约过滤的改动（那一行其它条件全部成立，漏掉过滤就会变成 send）。
  update public.notifications set status = 'failed' where id = allowed_row;
  result := public.app_notify_verify_rows(claim_1, array[allowed_row]);
  if coalesce((select e->>'verdict' from jsonb_array_elements(result) e where (e->>'id')::bigint = allowed_row), 'absent') <> 'skip' then
    raise exception '投递前复核只应针对正在发送的行，非 sending 的行必须判为 skip，实际 %', result;
  end if;
  -- 9) 复核必须核对“申请当前的状态与版本”（handler 手里只有整批开始时读到的快照）。
  --    先把这一行恢复成"本批正在发送"，再让申请离开该待办状态：必须判 cancel 而不是 send。
  update public.notifications set status = 'sending', claim_id = claim_1, lease_expires_at = now() + interval '5 minutes'
    where id = allowed_row;
  update public.applications set status = 'draft' where id = app_id;
  result := public.app_notify_verify_rows(claim_1, array[allowed_row]);
  if coalesce((select e->>'verdict' from jsonb_array_elements(result) e where (e->>'id')::bigint = allowed_row), 'absent') <> 'cancel' then
    raise exception '申请已离开该待办状态时，投递前复核必须判为 cancel（不能只看 handler 的旧快照），实际 %', result;
  end if;
  -- 10) 版本不一致（申请已重新提交）同样必须判 cancel。
  update public.applications set status = 'finance_pending', version = 10 where id = app_id;
  result := public.app_notify_verify_rows(claim_1, array[allowed_row]);
  if coalesce((select e->>'verdict' from jsonb_array_elements(result) e where (e->>'id')::bigint = allowed_row), 'absent') <> 'cancel' then
    raise exception '版本不一致的提醒必须被判为 cancel，实际 %', result;
  end if;

  update public.settings set email_notify_enabled = false where id = 1;
end $$;
rollback;