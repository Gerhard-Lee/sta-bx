-- Keep administrative access separate from workflow identities.
-- The built-in account named admin is the only super-admin allowed to cross roles.
create or replace function private.app_user_is_superadmin(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public, private, pg_temp
as $$
  select exists(
    select 1
    from public.app_users u
    join public.user_roles r on r.user_id = u.id and r.role = 'admin'
    where u.id = p_user_id
      and u.active
      and lower(u.username) = 'admin'
  );
$$;

create or replace function private.app_user_has_role(p_user_id uuid, p_role text)
returns boolean
language sql stable security definer set search_path = public, private, pg_temp
as $$
  select private.app_user_active(p_user_id)
     and (
       exists(
         select 1
         from public.user_roles
         where user_id = p_user_id and role = p_role
       )
       or (
         p_role in ('finance', 'chair', 'cashier')
         and private.app_user_is_superadmin(p_user_id)
       )
     );
$$;

-- Keep the legacy payment RPC safe as well as the current draft/submit workflow.
create or replace function public.app_record_payment(
  p_application_id uuid, p_actor_id uuid, p_reference text,
  p_storage_path text, p_name text, p_mime text
)
returns void
language plpgsql security definer set search_path = public, private, pg_temp
as $$
declare a public.applications%rowtype;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  select * into a from public.applications where id = p_application_id for update;
  if a.id is null or a.owner_id = p_actor_id or a.status <> 'payment_pending'
     or not private.app_user_has_role(p_actor_id, 'cashier')
     or length(trim(coalesce(p_reference, ''))) = 0
     or p_storage_path not like a.owner_id::text || '/%' then
    raise exception '当前不能登记付款';
  end if;
  insert into public.payments(application_id, amount, reference, actor_id)
  values (a.id, a.amount, left(trim(p_reference), 120), p_actor_id);
  insert into public.application_files(application_id, owner_id, kind, storage_path, name, mime)
  values (a.id, a.owner_id, 'receipt', p_storage_path, left(p_name, 180), left(p_mime, 120));
  update public.applications set status = 'paid', updated_at = now() where id = a.id;
  insert into public.approval_actions(application_id, version, actor_id, action, note)
  values (a.id, a.version, p_actor_id, '登记人工付款', trim(p_reference));
end;
$$;

