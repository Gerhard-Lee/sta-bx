-- 迁移后在事务中执行；不保留任何验证数据。
begin;
do $$
declare
  super_id uuid;
  fin_id uuid;
  chair_id uuid;
  ops_admin_id uuid;
  row jsonb;
begin
  select id into super_id from public.app_users where lower(username) = 'admin' and active;
  if super_id is null then raise exception 'built-in admin is required'; end if;

  row := private.app_insert_user('verify_fin_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证财委', '验证');
  fin_id := (row->>'id')::uuid;
  insert into public.user_roles(user_id, role) values (fin_id, 'finance');

  row := private.app_insert_user('verify_chair_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证主席', '验证');
  chair_id := (row->>'id')::uuid;
  insert into public.user_roles(user_id, role) values (chair_id, 'chair');

  row := private.app_insert_user('verify_admin_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证管理员', '验证');
  ops_admin_id := (row->>'id')::uuid;
  insert into public.user_roles(user_id, role) values (ops_admin_id, 'admin');

  if not private.app_user_has_role(fin_id, 'finance') then raise exception '财委自有身份丢失'; end if;
  if not private.app_user_has_role(fin_id, 'cashier') then raise exception '财委应拥有付款登记能力'; end if;
  if private.app_user_has_role(fin_id, 'chair') then raise exception '财委不得兼任主席身份'; end if;
  if private.app_user_has_role(chair_id, 'cashier') then raise exception '主席不得登记付款'; end if;
  if private.app_user_has_role(ops_admin_id, 'finance') or private.app_user_has_role(ops_admin_id, 'chair') or private.app_user_has_role(ops_admin_id, 'cashier') then
    raise exception '普通管理员不得代替流程身份';
  end if;
  if not private.app_user_has_role(super_id, 'cashier') then raise exception '内置 admin 必须保留跨身份'; end if;
end $$;
rollback;
