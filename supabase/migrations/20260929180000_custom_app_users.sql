-- Replace Supabase Auth with an application-owned account and session layer.
create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  password_hash text not null,
  full_name text not null default '',
  department text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists app_users_username_lower_idx on public.app_users (lower(username));

create table if not exists public.app_sessions (
  token_hash text primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists app_sessions_user_idx on public.app_sessions(user_id, expires_at desc);
create index if not exists app_sessions_expires_idx on public.app_sessions(expires_at);

-- Profiles are still used by the workflow tables, but no longer belong to auth.users.
do $$
declare constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.profiles'::regclass
      and con.contype = 'f'
      and pg_get_constraintdef(con.oid) like '%auth.users%'
  loop
    execute format('alter table public.profiles drop constraint %I', constraint_name);
  end loop;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
revoke all on function public.handle_new_user() from public, anon, authenticated;

alter table public.app_users enable row level security;
alter table public.app_sessions enable row level security;

create or replace function private.app_user_active(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public, private, pg_temp
as $$
  select exists(select 1 from public.app_users where id = p_user_id and active);
$$;

create or replace function private.app_user_has_role(p_user_id uuid, p_role text)
returns boolean
language sql stable security definer set search_path = public, private, pg_temp
as $$
  select private.app_user_active(p_user_id)
     and exists(select 1 from public.user_roles where user_id = p_user_id and role = p_role);
$$;

create or replace function public.app_create_user(
  p_username text,
  p_password text,
  p_full_name text default '',
  p_department text default ''
)
returns jsonb
language plpgsql security definer set search_path = public, private, pg_temp
as $$
declare
  new_user public.app_users%rowtype;
  first_user boolean;
  display_name text := left(nullif(trim(p_full_name), ''), 80);
  username_value text := lower(trim(p_username));
begin
  if username_value !~ '^[a-z0-9][a-z0-9_.-]{2,39}$' then
    raise exception '用户名需为 3-40 位字母、数字、点、下划线或短横线';
  end if;
  if length(coalesce(p_password, '')) < 10 then raise exception '密码至少需要 10 个字符'; end if;
  if display_name is null then display_name := username_value; end if;
  select not exists(select 1 from public.app_users) into first_user;
  insert into public.app_users(username, password_hash, full_name, department)
  values (username_value, crypt(p_password, gen_salt('bf', 12)), display_name, left(coalesce(p_department, ''), 80))
  returning * into new_user;
  insert into public.profiles(id, full_name, email, department, active)
  values (new_user.id, new_user.full_name, new_user.username, new_user.department, true)
  on conflict (id) do update set full_name = excluded.full_name, email = excluded.email, department = excluded.department, active = true;
  if first_user then
    insert into public.user_roles(user_id, role) values (new_user.id, 'admin') on conflict do nothing;
    insert into public.audit_logs(actor_id, event, detail) values (new_user.id, '创建首个管理员', new_user.username);
  end if;
  return jsonb_build_object(
    'id', new_user.id,
    'username', new_user.username,
    'full_name', new_user.full_name,
    'department', new_user.department,
    'active', new_user.active,
    'roles', coalesce((select jsonb_agg(role order by role) from public.user_roles where user_id = new_user.id), '[]'::jsonb)
  );
exception when unique_violation then
  raise exception '用户名已存在';
end;
$$;

create or replace function public.app_login(p_username text, p_password text)
returns jsonb
language plpgsql security definer set search_path = public, private, pg_temp
as $$
declare
  matched_user public.app_users%rowtype;
begin
  select * into matched_user
  from public.app_users
  where username = lower(trim(p_username))
    and active
    and password_hash = crypt(p_password, password_hash);
  if matched_user.id is null then return null; end if;
  update public.app_users set updated_at = now() where id = matched_user.id;
  return jsonb_build_object(
    'id', matched_user.id,
    'username', matched_user.username,
    'full_name', matched_user.full_name,
    'department', matched_user.department,
    'active', matched_user.active,
    'roles', coalesce((select jsonb_agg(role order by role) from public.user_roles where user_id = matched_user.id), '[]'::jsonb)
  );
end;
$$;

create or replace function public.app_change_password(p_user_id uuid, p_current_password text, p_new_password text)
returns void
language plpgsql security definer set search_path = public, private, pg_temp
as $$
begin
  if length(coalesce(p_new_password, '')) < 10 then raise exception '新密码至少需要 10 个字符'; end if;
  update public.app_users
  set password_hash = crypt(p_new_password, gen_salt('bf', 12)), updated_at = now()
  where id = p_user_id and active and password_hash = crypt(p_current_password, password_hash);
  if not found then raise exception '当前密码不正确'; end if;
  insert into public.audit_logs(actor_id, event, detail) values (p_user_id, '修改登录密码', '');
end;
$$;

create or replace function public.app_submit_application(p_application_id uuid, p_actor_id uuid, p_note text default '')
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare a public.applications%rowtype; threshold_value numeric(12,2); next_version integer;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  select * into a from public.applications where id = p_application_id for update;
  if a.id is null or a.owner_id <> p_actor_id or a.status not in ('draft','changes_requested') then raise exception '当前申请不能提交'; end if;
  select threshold into threshold_value from public.settings where id = 1;
  next_version := a.version + 1;
  update public.applications set status = 'finance_pending', version = next_version, rule_threshold = coalesce(threshold_value, 100), updated_at = now() where id = a.id;
  insert into public.approval_actions(application_id, version, actor_id, action, note) values (a.id, next_version, p_actor_id, '提交申请', coalesce(p_note, ''));
  insert into public.audit_logs(actor_id, event, detail) values (p_actor_id, '提交申请', a.id::text);
end;
$$;

create or replace function private.app_review_application(p_application_id uuid, p_actor_id uuid, p_decision text, p_note text)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare a public.applications%rowtype; next_status text; reviewer_role text;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  if length(coalesce(p_note, '')) = 0 then raise exception '请填写处理意见'; end if;
  select * into a from public.applications where id = p_application_id for update;
  if a.id is null or a.owner_id = p_actor_id then raise exception '不能处理此申请'; end if;
  reviewer_role := case when a.status = 'finance_pending' then 'finance' when a.status = 'chair_pending' then 'chair' else null end;
  if reviewer_role is null or not private.app_user_has_role(p_actor_id, reviewer_role) then raise exception '没有对应处理权限'; end if;
  if p_decision = 'approve' then
    next_status := case when reviewer_role = 'finance' and a.amount >= coalesce(a.rule_threshold, 100) then 'chair_pending' else 'payment_info_required' end;
  elsif p_decision = 'return' then next_status := 'changes_requested';
  elsif p_decision = 'reject' then next_status := 'rejected';
  else raise exception '未知处理方式';
  end if;
  update public.applications set status = next_status, updated_at = now() where id = a.id;
  insert into public.approval_actions(application_id, version, actor_id, action, note) values (a.id, a.version, p_actor_id, case p_decision when 'approve' then '审批通过' when 'return' then '退回修改' else '拒绝申请' end, p_note);
  insert into public.audit_logs(actor_id, event, detail) values (p_actor_id, '处理申请', a.id::text || ':' || p_decision);
end;
$$;

create or replace function public.app_approve_application(p_application_id uuid, p_actor_id uuid, p_note text) returns void language sql security definer set search_path = public, private, pg_temp as $$ select private.app_review_application(p_application_id, p_actor_id, 'approve', p_note); $$;
create or replace function public.app_return_application(p_application_id uuid, p_actor_id uuid, p_note text) returns void language sql security definer set search_path = public, private, pg_temp as $$ select private.app_review_application(p_application_id, p_actor_id, 'return', p_note); $$;
create or replace function public.app_reject_application(p_application_id uuid, p_actor_id uuid, p_note text) returns void language sql security definer set search_path = public, private, pg_temp as $$ select private.app_review_application(p_application_id, p_actor_id, 'reject', p_note); $$;

create or replace function public.app_cancel_application(p_application_id uuid, p_actor_id uuid, p_note text default '')
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare a public.applications%rowtype;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  select * into a from public.applications where id = p_application_id for update;
  if a.id is null or a.owner_id <> p_actor_id or a.status not in ('draft','changes_requested','finance_pending','chair_pending') then raise exception '当前申请不能撤回'; end if;
  update public.applications set status = 'cancelled', updated_at = now() where id = a.id;
  insert into public.approval_actions(application_id, version, actor_id, action, note) values (a.id, a.version, p_actor_id, '撤回申请', coalesce(p_note, ''));
end;
$$;

create or replace function public.app_add_application_file(p_application_id uuid, p_actor_id uuid, p_kind text, p_storage_path text, p_name text, p_mime text)
returns uuid language plpgsql security definer set search_path = public, private, pg_temp as $$
declare a public.applications%rowtype; file_id uuid;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  select * into a from public.applications where id = p_application_id;
  if a.id is null or a.owner_id <> p_actor_id or a.status not in ('draft','changes_requested') or p_kind <> 'attachment' or p_storage_path not like a.owner_id::text || '/%' then raise exception '当前不能添加附件'; end if;
  insert into public.application_files(application_id, owner_id, kind, storage_path, name, mime) values (a.id, a.owner_id, p_kind, p_storage_path, left(p_name, 180), left(p_mime, 120)) returning id into file_id;
  return file_id;
end;
$$;

create or replace function public.app_submit_payment_info(p_application_id uuid, p_actor_id uuid, p_recipient text, p_storage_path text, p_name text, p_mime text)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare a public.applications%rowtype;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  select * into a from public.applications where id = p_application_id for update;
  if a.id is null or a.owner_id <> p_actor_id or a.status <> 'payment_info_required' or length(trim(coalesce(p_recipient, ''))) = 0 or p_storage_path not like a.owner_id::text || '/%' then raise exception '当前不能提交收款信息'; end if;
  insert into public.application_files(application_id, owner_id, kind, storage_path, name, mime) values (a.id, a.owner_id, 'qr', p_storage_path, left(p_name, 180), left(p_mime, 120));
  update public.applications set recipient = left(trim(p_recipient), 80), status = 'payment_pending', updated_at = now() where id = a.id;
  insert into public.approval_actions(application_id, version, actor_id, action, note) values (a.id, a.version, p_actor_id, '提交收款信息', trim(p_recipient));
end;
$$;

create or replace function public.app_record_payment(p_application_id uuid, p_actor_id uuid, p_reference text, p_storage_path text, p_name text, p_mime text)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare a public.applications%rowtype;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  select * into a from public.applications where id = p_application_id for update;
  if a.id is null or a.owner_id = p_actor_id or a.status <> 'payment_pending' or (not private.app_user_has_role(p_actor_id, 'cashier') and not private.app_user_has_role(p_actor_id, 'admin')) or length(trim(coalesce(p_reference, ''))) = 0 or p_storage_path not like a.owner_id::text || '/%' then raise exception '当前不能登记付款'; end if;
  insert into public.payments(application_id, amount, reference, actor_id) values (a.id, a.amount, left(trim(p_reference), 120), p_actor_id);
  insert into public.application_files(application_id, owner_id, kind, storage_path, name, mime) values (a.id, a.owner_id, 'receipt', p_storage_path, left(p_name, 180), left(p_mime, 120));
  update public.applications set status = 'paid', updated_at = now() where id = a.id;
  insert into public.approval_actions(application_id, version, actor_id, action, note) values (a.id, a.version, p_actor_id, '登记人工付款', trim(p_reference));
end;
$$;

create or replace function public.app_update_approval_threshold(p_actor_id uuid, p_threshold numeric)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  if not private.app_user_has_role(p_actor_id, 'admin') or p_threshold <= 0 or p_threshold > 10000000 then raise exception '没有权限或金额无效'; end if;
  update public.settings set threshold = round(p_threshold, 2), updated_at = now(), updated_by = p_actor_id where id = 1;
  insert into public.audit_logs(actor_id, event, detail) values (p_actor_id, '更新审批门槛', round(p_threshold, 2)::text);
end;
$$;

create or replace function public.app_set_member_roles(p_actor_id uuid, p_user_id uuid, p_roles text[], p_active boolean)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  if not private.app_user_has_role(p_actor_id, 'admin') or p_user_id = p_actor_id or exists(select 1 from unnest(coalesce(p_roles, '{}'::text[])) r where r not in ('finance','chair','cashier','admin')) then raise exception '没有权限或角色无效'; end if;
  update public.app_users set active = p_active, updated_at = now() where id = p_user_id;
  update public.profiles set active = p_active where id = p_user_id;
  delete from public.user_roles where user_id = p_user_id;
  insert into public.user_roles(user_id, role) select p_user_id, r from unnest(coalesce(p_roles, '{}'::text[])) r;
  insert into public.audit_logs(actor_id, event, detail) values (p_actor_id, '更新成员权限', p_user_id::text);
end;
$$;

-- The browser can only invoke the Edge Function. All direct Data API access is closed.
revoke all on table public.app_users, public.app_sessions, public.profiles, public.user_roles, public.settings, public.applications, public.application_files, public.approval_actions, public.payments, public.audit_logs from public, anon, authenticated;
revoke all on table storage.objects from public, anon, authenticated;
revoke all on function public.claim_first_admin() from public, anon, authenticated;
revoke all on function public.submit_application(uuid, text) from public, anon, authenticated;
revoke all on function public.approve_application(uuid, text) from public, anon, authenticated;
revoke all on function public.return_application(uuid, text) from public, anon, authenticated;
revoke all on function public.reject_application(uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_application(uuid, text) from public, anon, authenticated;
revoke all on function public.add_application_file(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.submit_payment_info(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.record_payment(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.update_approval_threshold(numeric) from public, anon, authenticated;
revoke all on function public.set_member_roles(uuid, text[], boolean) from public, anon, authenticated;

revoke all on function public.app_create_user(text, text, text, text) from public, anon, authenticated;
revoke all on function public.app_login(text, text) from public, anon, authenticated;
revoke all on function public.app_change_password(uuid, text, text) from public, anon, authenticated;
revoke all on function public.app_submit_application(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.app_approve_application(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.app_return_application(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.app_reject_application(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.app_cancel_application(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.app_add_application_file(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.app_submit_payment_info(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.app_record_payment(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.app_update_approval_threshold(uuid, numeric) from public, anon, authenticated;
revoke all on function public.app_set_member_roles(uuid, uuid, text[], boolean) from public, anon, authenticated;
grant execute on function public.app_create_user(text, text, text, text) to service_role;
grant execute on function public.app_login(text, text) to service_role;
grant execute on function public.app_change_password(uuid, text, text) to service_role;
grant execute on function public.app_submit_application(uuid, uuid, text) to service_role;
grant execute on function public.app_approve_application(uuid, uuid, text) to service_role;
grant execute on function public.app_return_application(uuid, uuid, text) to service_role;
grant execute on function public.app_reject_application(uuid, uuid, text) to service_role;
grant execute on function public.app_cancel_application(uuid, uuid, text) to service_role;
grant execute on function public.app_add_application_file(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.app_submit_payment_info(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.app_record_payment(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.app_update_approval_threshold(uuid, numeric) to service_role;
grant execute on function public.app_set_member_roles(uuid, uuid, text[], boolean) to service_role;
