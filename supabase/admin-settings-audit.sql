alter table public.settings add column if not exists registration_enabled boolean not null default true;
alter table public.audit_logs add column if not exists username text not null default '';
alter table public.audit_logs add column if not exists ip_address text;
alter table public.audit_logs add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.audit_logs add column if not exists request_id uuid;
create index if not exists audit_logs_created_id_idx on public.audit_logs(created_at desc, id desc);
alter table public.user_roles drop constraint if exists user_roles_role_check;
alter table public.user_roles add constraint user_roles_role_check check (role in ('finance','chair','admin'));

create or replace function private.decorate_audit_log()
returns trigger language plpgsql security definer set search_path = public, private, pg_temp as $$
declare h jsonb; app public.applications%rowtype; f public.application_files%rowtype; target uuid; u public.app_users%rowtype; decision text; note_value text;
begin
  h := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  new.username := coalesce(nullif(new.username,''), (select username from public.app_users where id=new.actor_id), '系统');
  new.ip_address := coalesce(new.ip_address, nullif(h->>'x-audit-ip',''));
  new.created_at := clock_timestamp();
  if h->>'x-audit-request-id' ~ '^[0-9a-f-]{36}$' then new.request_id := (h->>'x-audit-request-id')::uuid; end if;
  new.metadata := new.metadata || jsonb_strip_nulls(jsonb_build_object('api_action',h->>'x-audit-action','ip_source',nullif(h->>'x-audit-ip-source','')));
  begin target := split_part(new.detail, ':', 1)::uuid; exception when invalid_text_representation then target := null; end;
  if target is not null then
    select * into app from public.applications where id=target;
    if app.id is null then
      select * into f from public.application_files where id=target;
      if f.id is not null then select * into app from public.applications where id=f.application_id; end if;
    end if;
    if app.id is not null then
      if f.id is null and new.event in ('保存文件','移除文件','提交文件') then
        begin
          target := (case when split_part(new.detail,':',3)<>'' then split_part(new.detail,':',3) else split_part(new.detail,':',2) end)::uuid;
          select * into f from public.application_files where id=target;
        exception when invalid_text_representation then null; end;
      end if;
      new.metadata := new.metadata || jsonb_build_object('application_id',app.id,'title',app.title,'amount',app.amount,'status',app.status);
      new.detail := format('申请「%s」 · ¥%s · 编号 %s%s%s',app.title,app.amount,app.id,
        case when f.id is not null then ' · 文件：'||f.name else '' end,
        case when f.id is not null then ' · '||case f.kind when 'attachment' then '申请附件' when 'qr' then '收款码' else '付款凭证' end else '' end);
      if f.id is not null then
        new.metadata := new.metadata || jsonb_build_object('file_id',f.id,'file_name',f.name,'file_kind',f.kind,'draft_value',f.draft_value);
        if f.kind in ('qr','receipt') and f.draft_value<>'' then new.detail := new.detail||' · '||case f.kind when 'qr' then '收款人：' else '流水号：' end||f.draft_value; end if;
      end if;
      if new.event='处理申请' then
        select action,note into decision,note_value from public.approval_actions where application_id=app.id and actor_id=new.actor_id order by id desc limit 1;
        new.detail := new.detail||' · 结果：'||coalesce(decision,'未记录')||' · 意见：'||left(coalesce(note_value,''),2000);
        new.metadata := new.metadata||jsonb_build_object('decision',decision,'note',note_value);
      end if;
    elsif new.event='更新成员权限' then
      select * into u from public.app_users where id=target;
      new.detail := format('用户 @%s（%s） · 角色：%s · %s',u.username,u.full_name,
        coalesce((select string_agg(case role when 'finance' then '财委' when 'chair' then '主席' when 'admin' then '管理员' else role end,'、' order by role) from public.user_roles where user_id=target),'普通用户'),
        case when u.active then '启用' else '停用' end);
      new.metadata := new.metadata || jsonb_build_object('target_user_id',target,'target_username',u.username,'active',u.active);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists decorate_audit_log on public.audit_logs;
create trigger decorate_audit_log before insert on public.audit_logs for each row execute function private.decorate_audit_log();

create or replace function private.audit_application_edit()
returns trigger language plpgsql security definer set search_path = public, private, pg_temp as $$
declare h jsonb; actor uuid; changes jsonb := '{}'::jsonb; k text; ev text;
begin
  h := coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb);
  begin actor := (h->>'x-audit-actor')::uuid; exception when invalid_text_representation then actor := null; end;
  actor := coalesce(actor,new.owner_id);
  if TG_OP='INSERT' then ev := '保存申请草稿'; changes := jsonb_build_object('title',new.title,'amount',new.amount,'department',new.department,'category',new.category);
  else
    foreach k in array array['title','purpose','amount','category','department','use_date'] loop
      if to_jsonb(old)->k is distinct from to_jsonb(new)->k then changes := changes || jsonb_build_object(k,jsonb_build_object('原值',to_jsonb(old)->k,'新值',to_jsonb(new)->k)); end if;
    end loop;
    if changes='{}'::jsonb then
      if old.status is distinct from new.status and new.status='cancelled' then ev := '撤回申请'; else return new; end if;
    else ev := '修改申请'; end if;
  end if;
  insert into public.audit_logs(actor_id,event,detail,metadata) values(actor,ev,new.id::text,jsonb_build_object('changes',changes));
  return new;
end $$;
drop trigger if exists audit_application_edit on public.applications;
create trigger audit_application_edit after insert or update on public.applications for each row execute function private.audit_application_edit();

create or replace function private.audit_file_draft_edit()
returns trigger language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  if old.draft_value is distinct from new.draft_value then
    insert into public.audit_logs(actor_id,event,detail,metadata) values(coalesce(new.uploaded_by,new.owner_id),'修改文件草稿',new.id::text,
      jsonb_build_object('changes',jsonb_build_object(case new.kind when 'qr' then 'recipient' else 'reference' end,jsonb_build_object('原值',old.draft_value,'新值',new.draft_value))));
  end if;
  return new;
end $$;
drop trigger if exists audit_file_draft_edit on public.application_files;
create trigger audit_file_draft_edit after update on public.application_files for each row execute function private.audit_file_draft_edit();

create or replace function private.app_insert_user(p_username text,p_password text,p_full_name text,p_department text)
returns jsonb language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare u public.app_users%rowtype; v_username text := lower(trim(p_username));
begin
  if v_username !~ '^[a-z0-9][a-z0-9_.-]{2,39}$' then raise exception '用户名需为 3-40 位字母、数字、点、下划线或短横线'; end if;
  if length(coalesce(p_password,''))<10 or length(p_password)>72 then raise exception '密码需为 10-72 个字符'; end if;
  insert into public.app_users(username,password_hash,full_name,department)
  values(v_username,crypt(p_password,gen_salt('bf',12)),coalesce(nullif(left(trim(p_full_name),80),''),v_username),left(coalesce(p_department,''),80)) returning * into u;
  insert into public.profiles(id,full_name,email,department,active) values(u.id,u.full_name,u.username,u.department,true);
  return jsonb_build_object('id',u.id,'username',u.username,'full_name',u.full_name,'department',u.department,'active',true,'roles','[]'::jsonb);
exception when unique_violation then raise exception '用户名已存在';
end $$;

create or replace function public.app_create_user(p_username text,p_password text,p_full_name text default '',p_department text default '')
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare u jsonb; enabled boolean;
begin
  select registration_enabled into enabled from public.settings where id=1 for share;
  if enabled is distinct from true then raise exception '当前暂不开放注册，请联系管理员'; end if;
  u := private.app_insert_user(p_username,p_password,p_full_name,p_department);
  insert into public.audit_logs(actor_id,event,detail) values((u->>'id')::uuid,'注册账号','用户 @'||(u->>'username'));
  return u;
end $$;

create or replace function public.app_set_member_roles(p_actor_id uuid,p_user_id uuid,p_roles text[],p_active boolean)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  if not private.app_user_has_role(p_actor_id,'admin') or p_user_id=p_actor_id or p_active is null or
    exists(select 1 from unnest(coalesce(p_roles,'{}'::text[])) r where r is null or r not in ('finance','chair','admin')) then raise exception '没有权限或角色无效'; end if;
  perform 1 from public.app_users where id=p_user_id for update;
  if not found then raise exception '用户不存在'; end if;
  update public.app_users set active=p_active,updated_at=now() where id=p_user_id;
  update public.profiles set active=p_active where id=p_user_id;
  delete from public.user_roles where user_id=p_user_id;
  insert into public.user_roles(user_id,role) select p_user_id,r from (select distinct unnest(coalesce(p_roles,'{}'::text[])) r) v;
  if not p_active then delete from public.app_sessions where user_id=p_user_id; end if;
  insert into public.audit_logs(actor_id,event,detail) values(p_actor_id,'更新成员权限',p_user_id::text);
end $$;

create or replace function public.app_admin_create_user(p_actor_id uuid,p_username text,p_password text,p_full_name text,p_department text,p_roles text[])
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare u jsonb;
begin
  if not private.app_user_has_role(p_actor_id,'admin') then raise exception '没有管理员权限'; end if;
  if exists(select 1 from unnest(coalesce(p_roles,'{}'::text[])) r where r is null or r not in ('finance','chair','admin')) then raise exception '角色无效'; end if;
  u := private.app_insert_user(p_username,p_password,p_full_name,p_department);
  perform public.app_set_member_roles(p_actor_id,(u->>'id')::uuid,p_roles,true);
  insert into public.audit_logs(actor_id,event,detail,metadata) values(p_actor_id,'添加用户','创建 @'||(u->>'username')||'（'||(u->>'full_name')||'）',jsonb_build_object('target_user_id',u->>'id','target_username',u->>'username','roles',p_roles));
  return u;
end $$;

create or replace function public.app_update_registration(p_actor_id uuid,p_enabled boolean)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare old_value boolean;
begin
  if not private.app_user_has_role(p_actor_id,'admin') or p_enabled is null then raise exception '没有管理员权限或参数无效'; end if;
  select registration_enabled into old_value from public.settings where id=1 for update;
  update public.settings set registration_enabled=p_enabled,updated_at=now(),updated_by=p_actor_id where id=1;
  insert into public.audit_logs(actor_id,event,detail,metadata) values(p_actor_id,'修改注册设置',case when p_enabled then '允许注册' else '关闭注册' end,jsonb_build_object('原值',old_value,'新值',p_enabled));
end $$;

revoke all on function private.decorate_audit_log(),private.audit_application_edit(),private.audit_file_draft_edit(),private.app_insert_user(text,text,text,text) from public,anon,authenticated;
revoke all on function public.app_create_user(text,text,text,text),public.app_set_member_roles(uuid,uuid,text[],boolean),public.app_admin_create_user(uuid,text,text,text,text,text[]),public.app_update_registration(uuid,boolean) from public,anon,authenticated;
grant execute on function public.app_create_user(text,text,text,text),public.app_set_member_roles(uuid,uuid,text[],boolean),public.app_admin_create_user(uuid,text,text,text,text,text[]),public.app_update_registration(uuid,boolean) to service_role;
