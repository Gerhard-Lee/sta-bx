-- Run in a transaction after the migration; no verification data is kept.
begin;
do $verify_roles$
declare
  superadmin_id uuid;
  ordinary_admin_id uuid;
  explicit_finance_id uuid;
  row jsonb;
begin
  select id into superadmin_id from public.app_users where lower(username) = 'admin' and active;
  if superadmin_id is null then raise exception 'built-in admin is required'; end if;

  row := private.app_insert_user('verify_role_admin_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证管理员', '验证');
  ordinary_admin_id := (row->>'id')::uuid;
  insert into public.user_roles(user_id, role) values (ordinary_admin_id, 'admin');

  row := private.app_insert_user('verify_role_finance_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证财委', '验证');
  explicit_finance_id := (row->>'id')::uuid;
  insert into public.user_roles(user_id, role) values (explicit_finance_id, 'admin'), (explicit_finance_id, 'finance');

  if not private.app_user_has_role(ordinary_admin_id, 'admin') then raise exception 'admin role missing'; end if;
  if private.app_user_has_role(ordinary_admin_id, 'finance') or private.app_user_has_role(ordinary_admin_id, 'chair') then
    raise exception 'ordinary admin inherited workflow identity';
  end if;
  if not private.app_user_has_role(explicit_finance_id, 'finance') then raise exception 'explicit finance role missing'; end if;
  if private.app_user_has_role(explicit_finance_id, 'chair') then raise exception 'unassigned chair role inherited'; end if;
  if not private.app_user_has_role(superadmin_id, 'finance') or not private.app_user_has_role(superadmin_id, 'chair') then
    raise exception 'built-in admin did not retain super-admin access';
  end if;
end $verify_roles$;
rollback;

