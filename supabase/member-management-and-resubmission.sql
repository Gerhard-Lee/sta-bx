-- All application users, including other admins, must leave the built-in admin untouched.
create or replace function private.protect_builtin_admin()
returns trigger language plpgsql security definer set search_path = public, private, pg_temp as $$
declare protected boolean;
begin
  if tg_table_name = 'app_users' then
    if lower(old.username) = 'admin' then
      if tg_op = 'DELETE' then raise exception 'admin 是受保护账号，不能删除'; end if;
      if new.id is distinct from old.id or new.username is distinct from old.username or new.active is distinct from old.active then
        raise exception 'admin 的账号和权限不能修改或停用';
      end if;
    elsif tg_op = 'UPDATE' and lower(new.username) = 'admin' then raise exception 'admin 用户名已保留';
    end if;
  elsif tg_table_name = 'profiles' then
    select exists(select 1 from public.app_users where id=old.id and lower(username)='admin') into protected;
    if protected then
      if tg_op = 'DELETE' then raise exception 'admin 是受保护账号，不能删除'; end if;
      if new.id is distinct from old.id or new.active is distinct from old.active then raise exception 'admin 的账号和权限不能修改或停用'; end if;
    end if;
  else
    if tg_op <> 'INSERT' then
      select exists(select 1 from public.app_users where id=old.user_id and lower(username)='admin') into protected;
      if protected then raise exception 'admin 的权限已锁定，任何用户都不能修改'; end if;
    end if;
    if tg_op <> 'DELETE' then
      select exists(select 1 from public.app_users where id=new.user_id and lower(username)='admin') into protected;
      if protected then raise exception 'admin 的权限已锁定，任何用户都不能修改'; end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create or replace trigger protect_builtin_admin_account before update or delete on public.app_users for each row execute function private.protect_builtin_admin();
create or replace trigger protect_builtin_admin_profile before update or delete on public.profiles for each row execute function private.protect_builtin_admin();
create or replace trigger protect_builtin_admin_roles before insert or update or delete on public.user_roles for each row execute function private.protect_builtin_admin();

create or replace function public.app_set_member_roles(p_actor_id uuid,p_user_id uuid,p_roles text[],p_active boolean)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare target_username text;
begin
  if not private.app_user_has_role(p_actor_id,'admin') then raise exception '没有管理员权限'; end if;
  select username into target_username from public.app_users where id=p_user_id for update;
  if not found then raise exception '用户不存在'; end if;
  if lower(target_username)='admin' then raise exception 'admin 的权限已锁定，任何用户都不能修改'; end if;
  if p_user_id=p_actor_id or p_active is null or exists(select 1 from unnest(coalesce(p_roles,'{}'::text[])) r where r is null or r not in ('finance','chair','admin')) then raise exception '没有权限或角色无效'; end if;
  update public.app_users set active=p_active,updated_at=now() where id=p_user_id;
  update public.profiles set active=p_active where id=p_user_id;
  delete from public.user_roles where user_id=p_user_id;
  insert into public.user_roles(user_id,role) select p_user_id,r from (select distinct unnest(coalesce(p_roles,'{}'::text[])) r) v;
  if not p_active then delete from public.app_sessions where user_id=p_user_id; end if;
  insert into public.audit_logs(actor_id,event,detail) values(p_actor_id,'更新成员权限',p_user_id::text);
end $$;

create or replace function public.app_list_members(p_actor_id uuid,p_query text default '',p_role text default '',p_active text default '',p_page integer default 1,p_page_size integer default 10)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare total integer; current_page integer; result jsonb;
begin
  if not private.app_user_has_role(p_actor_id,'admin') then raise exception '没有管理员权限'; end if;
  if p_query is null or length(p_query)>80 or p_role is null or p_role not in ('','ordinary','finance','chair','admin') or p_active is null or p_active not in ('','active','inactive') or p_page is null or p_page<1 or p_page_size is null or p_page_size not in (10,20,50) then raise exception '搜索或分页参数无效'; end if;
  with matching as (
    select u.id from public.app_users u
    where (p_query='' or strpos(lower(u.username||' '||u.full_name||' '||u.department),lower(trim(p_query)))>0)
      and (p_active='' or u.active=(p_active='active'))
      and (p_role='' or (p_role='ordinary' and not exists(select 1 from public.user_roles r where r.user_id=u.id)) or exists(select 1 from public.user_roles r where r.user_id=u.id and r.role=p_role))
  ) select count(*) into total from matching;
  current_page := least(p_page,greatest(1,(total+p_page_size-1)/p_page_size));
  select coalesce(jsonb_agg(to_jsonb(member) order by member.priority,member.full_name,member.username,member.id),'[]'::jsonb) into result from (
    select u.id,u.username,u.full_name,u.department,u.active,case when lower(u.username)='admin' then 0 else 1 end priority,
      coalesce((select jsonb_agg(r.role order by r.role) from public.user_roles r where r.user_id=u.id),'[]'::jsonb) roles
    from public.app_users u
    where (p_query='' or strpos(lower(u.username||' '||u.full_name||' '||u.department),lower(trim(p_query)))>0)
      and (p_active='' or u.active=(p_active='active'))
      and (p_role='' or (p_role='ordinary' and not exists(select 1 from public.user_roles r where r.user_id=u.id)) or exists(select 1 from public.user_roles r where r.user_id=u.id and r.role=p_role))
    order by priority,u.full_name,u.username,u.id limit p_page_size offset (current_page-1)*p_page_size
  ) member;
  return jsonb_build_object('profiles',result,'total',total,'page',current_page,'page_size',p_page_size);
end $$;

-- A withdrawn application may be edited and resubmitted; every submission gets a new version.
create or replace function public.app_submit_application(p_application_id uuid,p_actor_id uuid,p_note text default '')
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare a public.applications%rowtype; threshold_value numeric(12,2); next_version integer;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  select * into a from public.applications where id=p_application_id for update;
  if a.id is null or a.owner_id<>p_actor_id or a.status not in ('draft','changes_requested','cancelled') then raise exception '当前申请不能提交'; end if;
  select threshold into threshold_value from public.settings where id=1;
  next_version := a.version+1;
  update public.applications set status='finance_pending',version=next_version,rule_threshold=coalesce(threshold_value,100),updated_at=now() where id=a.id;
  insert into public.approval_actions(application_id,version,actor_id,action,note) values(a.id,next_version,p_actor_id,'提交申请',coalesce(p_note,''));
  insert into public.audit_logs(actor_id,event,detail) values(p_actor_id,'提交申请',a.id::text);
end $$;

revoke all on function private.protect_builtin_admin() from public,anon,authenticated;
revoke all on function public.app_list_members(uuid,text,text,text,integer,integer),public.app_set_member_roles(uuid,uuid,text[],boolean),public.app_submit_application(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.app_list_members(uuid,text,text,text,integer,integer),public.app_set_member_roles(uuid,uuid,text[],boolean),public.app_submit_application(uuid,uuid,text) to service_role;

create or replace function public.app_save_workflow_file(
  p_application_id uuid, p_actor_id uuid, p_kind text,
  p_storage_path text, p_name text, p_mime text, p_value text default ''
) returns uuid language plpgsql security definer set search_path = public, private, pg_temp as $$
declare a public.applications%rowtype; file_id uuid;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  select * into a from public.applications where id = p_application_id for update;
  if a.id is null or p_kind not in ('attachment','qr','receipt') then raise exception '文件类型或申请无效'; end if;
  if p_kind = 'attachment' and (a.owner_id <> p_actor_id or a.status not in ('draft','changes_requested','cancelled','finance_pending','chair_pending','payment_info_required','payment_pending')) then raise exception '当前不能修改申请附件'; end if;
  if p_kind = 'qr' and (a.owner_id <> p_actor_id or a.status not in ('payment_info_required','payment_pending')) then raise exception '当前不能保存收款信息'; end if;
  if p_kind = 'receipt' and (a.owner_id = p_actor_id or not private.app_user_has_role(p_actor_id,'cashier') or a.status not in ('payment_pending','paid')) then raise exception '当前不能保存付款凭证'; end if;
  if p_storage_path not like a.owner_id::text || '/' || a.id::text || '/%' then raise exception '文件路径无效'; end if;
  if p_mime not in ('image/png','image/jpeg','application/pdf') or (p_kind = 'qr' and p_mime = 'application/pdf') then raise exception '文件格式不支持'; end if;
  if p_kind in ('qr','receipt') then
    update public.application_files set removed_at = now()
    where application_id = a.id and kind = p_kind and pending and removed_at is null;
  end if;
  insert into public.application_files(application_id,owner_id,kind,storage_path,name,mime,pending,uploaded_by,draft_value)
  values (a.id,a.owner_id,p_kind,p_storage_path,left(p_name,180),p_mime,p_kind <> 'attachment',p_actor_id,left(trim(coalesce(p_value,'')),120))
  returning id into file_id;
  update public.applications set updated_at = now() where id = a.id;
  insert into public.audit_logs(actor_id,event,detail) values (p_actor_id,'保存文件',a.id::text || ':' || p_kind || ':' || file_id::text);
  return file_id;
end;
$$;

create or replace function public.app_remove_application_file(p_application_id uuid,p_actor_id uuid,p_file_id uuid)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare a public.applications%rowtype; f public.application_files%rowtype;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  select * into a from public.applications where id = p_application_id for update;
  select * into f from public.application_files where id = p_file_id and application_id = a.id and removed_at is null;
  if f.id is null then raise exception '文件不存在或已移除'; end if;
  if f.kind = 'attachment' and (a.owner_id <> p_actor_id or a.status not in ('draft','changes_requested','cancelled','finance_pending','chair_pending','payment_info_required','payment_pending')) then raise exception '当前不能移除附件'; end if;
  if f.kind = 'qr' and (a.owner_id <> p_actor_id or a.status not in ('payment_info_required','payment_pending')) then raise exception '当前不能移除收款码'; end if;
  if f.kind = 'receipt' and (not f.pending or a.owner_id = p_actor_id or not private.app_user_has_role(p_actor_id,'cashier') or a.status not in ('payment_pending','paid')) then raise exception '已提交的付款凭证请用新凭证替换'; end if;
  update public.application_files set removed_at = now() where id = f.id;
  -- Removing a submitted QR code pauses payment until a replacement is explicitly submitted.
  if f.kind = 'qr' and not f.pending and a.status = 'payment_pending' then
    update public.applications set status = 'payment_info_required',recipient = null,updated_at = now() where id = a.id;
  else update public.applications set updated_at = now() where id = a.id;
  end if;
  insert into public.audit_logs(actor_id,event,detail) values (p_actor_id,'移除文件',a.id::text || ':' || f.id::text);
end;
$$;
