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


revoke all on function private.audit_file_draft_edit() from public,anon,authenticated;
