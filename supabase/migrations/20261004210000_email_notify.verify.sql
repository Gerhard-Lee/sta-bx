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
  nomail_id uuid;
  offline_id uuid;
  app_id uuid;
  queued integer;
  dup integer;
  expected uuid[];
  actual uuid[];
  round_index integer;
  claim_1 uuid;
  claim_2 uuid;
  result jsonb;
begin
  select email_notify_enabled into flag from public.settings where id = 1;
  if flag is distinct from false then raise exception '邮件通知总开关默认应为关闭'; end if;

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
  nomail_id := (private.app_insert_user('verify_nomail_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证未绑定', '验证组')->>'id')::uuid;
  offline_id := (private.app_insert_user('verify_offline_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证已停用', '验证组')->>'id')::uuid;
  perform public.app_bind_email(owner_id, owner_id, 'verify-owner@example.com');
  perform public.app_bind_email(finance_id, finance_id, 'verify-finance@example.com');
  perform public.app_bind_email(offline_id, offline_id, 'verify-offline@example.com');
  -- 数据库层不允许替别人绑定邮箱（app-api 只会传当前登录账号）。
  begin
    perform public.app_bind_email(new_id, owner_id, 'someone-else@example.com');
    raise exception '替别人绑定邮箱应被拒绝';
  exception when raise_exception then
    if sqlerrm not like '%只能绑定自己的邮箱%' then raise; end if;
  end;
  perform public.app_set_member_roles(super_id, finance_id, array['finance'], true);
  perform public.app_set_member_roles(super_id, nomail_id, array['finance'], true);
  perform public.app_set_member_roles(super_id, offline_id, array['finance'], true);
  update public.app_users set active = false where id = offline_id;

  insert into public.applications(owner_id, title, purpose, amount, category, department, use_date, status, version)
  values (owner_id, '验证邮件通知', '仅用于迁移验证', 12.00, '物资', '验证组', current_date, 'draft', 0)
  returning id into app_id;

  -- 开关关闭：状态变化不入队。
  update public.applications set status = 'finance_pending', version = 1 where id = app_id;
  if exists(select 1 from public.notifications where application_id = app_id) then raise exception '开关关闭时不应生成队列记录'; end if;

  update public.settings set email_notify_enabled = true where id = 1;
  update public.applications set status = 'draft', version = 1 where id = app_id;
  update public.applications set status = 'finance_pending', version = 1 where id = app_id;

  if not exists(select 1 from public.notifications where application_id = app_id and event = '待财委审批' and recipient_user_id = finance_id) then raise exception '已绑定邮箱的财委应收到待审批提醒'; end if;
  if exists(select 1 from public.notifications where application_id = app_id and recipient_user_id in (owner_id, nomail_id, offline_id)) then raise exception '申请人本人、未绑定邮箱和已停用的成员都不应入队'; end if;

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

  -- 申请人自己要动手的两类：只发给申请人本人，不打扰审批人。
  update public.applications set status = 'changes_requested' where id = app_id;
  if not exists(select 1 from public.notifications where application_id = app_id and event = '退回修改' and recipient_user_id = owner_id) then raise exception '退回修改应提醒申请人本人'; end if;
  if exists(select 1 from public.notifications where application_id = app_id and event = '退回修改' and recipient_user_id = finance_id) then raise exception '退回修改不应发给审批人'; end if;
  update public.applications set status = 'payment_info_required' where id = app_id;
  if not exists(select 1 from public.notifications where application_id = app_id and event = '待补充收款码' and recipient_user_id = owner_id) then raise exception '待补充收款码应提醒申请人本人'; end if;

  -- 收款码被移除（payment_pending → payment_info_required）会把本轮的“待付款登记”提醒作废，
  -- 重新提交收款码后必须能再次提醒付款登记人（同一版本内允许第二次）。
  -- 合格收件人要用与实现同一处的判定函数推导，不能写死“恰好一封”：main 已合入“付款登记视同财委”，
  -- 内置 admin（superadmin 判定）与已绑邮箱的财委都能通过 cashier 判定，各应收到一封。
  perform public.app_bind_email(super_id, super_id, 'verify-admin@example.com');
  select coalesce(array_agg(u.id order by u.id), '{}'::uuid[]) into expected
  from public.app_users u
  where u.active and coalesce(u.email, '') <> '' and u.id <> owner_id
    and private.app_user_has_role(u.id, 'cashier');
  if not (super_id = any(expected)) then raise exception '前置条件失败：内置 admin 应通过付款登记身份判定'; end if;
  if not (finance_id = any(expected)) then raise exception '付款登记视同财委：已绑邮箱的财委也应是合格收件人'; end if;

  update public.applications set status = 'payment_pending' where id = app_id;
  if not exists(select 1 from public.notifications where application_id = app_id and event = '待付款登记' and recipient_user_id = super_id and status = 'pending') then
    raise exception '进入待付款登记应提醒付款登记身份';
  end if;
  update public.applications set status = 'payment_info_required' where id = app_id;
  if not exists(select 1 from public.notifications where application_id = app_id and event = '待付款登记' and status = 'cancelled') then
    raise exception '移除收款码应作废本轮的待付款登记提醒';
  end if;
  update public.applications set status = 'payment_pending' where id = app_id;
  select coalesce(array_agg(recipient_user_id order by recipient_user_id), '{}'::uuid[]) into actual
  from public.notifications
  where application_id = app_id and event = '待付款登记' and status <> 'cancelled';
  if actual is distinct from expected then
    raise exception '重新提交收款码后应再次入队：每个合格收件人各一封（期望 %，实际 %）', expected, actual;
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
  if exists(select 1 from public.notifications where claim_id = claim_1 and status <> 'sending') then raise exception '已领取的行必须处于发送中'; end if;
  if exists(select 1 from public.notifications where claim_id = claim_1 and lease_expires_at <= now()) then raise exception '领取必须带上未过期的租约'; end if;
  if exists(select 1 from public.notifications where application_id = app_id and status = 'pending' and next_attempt_at <= now()) then raise exception '到期的待发行应被本轮领走'; end if;

  -- 第二个批次不得重复拿到同一个 id（租约内不可见）。
  claim_2 := gen_random_uuid();
  result := public.app_claim_notifications(claim_2, 200, 300, 24, 5);
  select count(*) into dup from public.notifications where claim_id = claim_1 and id in (
    select (element->>'id')::bigint from jsonb_array_elements(result->'rows') element
  );
  if dup <> 0 then raise exception '同一封邮件不应被两个批次领取'; end if;

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
  perform public.app_claim_notifications(gen_random_uuid(), 200, 300, 24, 5);
  if exists(select 1 from public.notifications where application_id = app_id and status in ('pending','sending')) then
    raise exception '超龄的发送中行恢复后不应继续留在队列：%', (select string_agg(id || ':' || event || ':v' || application_version || ':' || status || ':' || attempts, ', ')
      from public.notifications where application_id = app_id and status in ('pending','sending'));
  end if;
  if (select count(*) from public.notifications where application_id = app_id and status = 'failed' and last_error like '%小时未发送，已丢弃%') <= queued then
    raise exception '超龄的发送中行恢复时应记为已丢弃';
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

  update public.settings set email_notify_enabled = false where id = 1;
end $$;
rollback;