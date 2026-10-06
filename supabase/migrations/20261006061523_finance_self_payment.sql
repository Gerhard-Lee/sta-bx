-- 审批仍必须由他人处理；付款登记允许具备财委/付款登记身份的申请人本人操作。
-- 保留身份、状态、确认、文件路径、草稿归属及审计校验。
-- 不重定义 private.app_review_application，继续禁止申请人自审。

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
  if p_kind = 'receipt' and (not private.app_user_has_role(p_actor_id,'cashier') or a.status not in ('payment_pending','paid')) then raise exception '当前不能保存付款凭证'; end if;
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

create or replace function public.app_update_workflow_draft(p_application_id uuid,p_actor_id uuid,p_file_id uuid,p_value text)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare a public.applications%rowtype; f public.application_files%rowtype;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  select * into a from public.applications where id = p_application_id for update;
  select * into f from public.application_files where id = p_file_id and application_id = a.id and removed_at is null;
  if f.id is null or not f.pending then raise exception '请先选择并保存文件'; end if;
  if f.kind = 'qr' and (a.owner_id <> p_actor_id or a.status not in ('payment_info_required','payment_pending')) then raise exception '没有收款信息编辑权限'; end if;
  if f.kind = 'receipt' and (not private.app_user_has_role(p_actor_id,'cashier') or a.status not in ('payment_pending','paid')) then raise exception '没有付款登记权限'; end if;
  if f.kind not in ('qr','receipt') then raise exception '文件类型无效'; end if;
  update public.application_files set draft_value = left(trim(coalesce(p_value,'')),120), uploaded_by = p_actor_id where id = f.id;
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
  if f.kind = 'receipt' and (not f.pending or not private.app_user_has_role(p_actor_id,'cashier') or a.status not in ('payment_pending','paid')) then raise exception '已提交的付款凭证请用新凭证替换'; end if;
  update public.application_files set removed_at = now() where id = f.id;
  -- Removing a submitted QR code pauses payment until a replacement is explicitly submitted.
  if f.kind = 'qr' and not f.pending and a.status = 'payment_pending' then
    update public.applications set status = 'payment_info_required',recipient = null,updated_at = now() where id = a.id;
  else update public.applications set updated_at = now() where id = a.id;
  end if;
  insert into public.audit_logs(actor_id,event,detail) values (p_actor_id,'移除文件',a.id::text || ':' || f.id::text);
end;
$$;

create or replace function public.app_submit_workflow_file(p_application_id uuid,p_actor_id uuid,p_file_id uuid,p_value text,p_confirmed boolean default false)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare a public.applications%rowtype; f public.application_files%rowtype; correction boolean;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  select * into a from public.applications where id = p_application_id for update;
  select * into f from public.application_files where id = p_file_id and application_id = a.id and removed_at is null for update;
  if f.id is null or not f.pending or f.uploaded_by <> p_actor_id then raise exception '文件草稿已变化，请刷新后重试'; end if;
  if length(trim(coalesce(p_value,''))) = 0 then raise exception '请填写收款人或流水号'; end if;
  if f.kind = 'qr' then
    if a.owner_id <> p_actor_id or a.status not in ('payment_info_required','payment_pending') or length(trim(p_value)) > 80 then raise exception '当前不能提交收款信息'; end if;
    update public.applications set recipient = trim(p_value),status = 'payment_pending',updated_at = now() where id = a.id;
  elsif f.kind = 'receipt' then
    if not private.app_user_has_role(p_actor_id,'cashier') or a.status not in ('payment_pending','paid') then raise exception '当前不能登记付款'; end if;
    if not coalesce(p_confirmed,false) then raise exception '请先核对收款人和金额，并确认已完成转账'; end if;
    if length(trim(p_value)) > 120 then raise exception '流水号过长'; end if;
    if exists(select 1 from public.application_files where application_id = a.id and kind = 'qr' and pending and removed_at is null) then raise exception '收款信息正在修改，请先完成收款信息提交'; end if;
    correction := a.status = 'paid';
    if correction then
      update public.payments set reference = trim(p_value) where application_id = a.id;
      if not found then raise exception '付款记录不存在'; end if;
    else
      insert into public.payments(application_id,amount,reference,actor_id) values (a.id,a.amount,trim(p_value),p_actor_id);
      update public.applications set status = 'paid',updated_at = now() where id = a.id;
    end if;
  else raise exception '文件类型无效';
  end if;
  update public.application_files set removed_at = now() where application_id = a.id and kind = f.kind and id <> f.id and removed_at is null;
  update public.application_files set pending = false,draft_value = trim(p_value) where id = f.id;
  insert into public.approval_actions(application_id,version,actor_id,action,note)
  values (a.id,a.version,p_actor_id,case when f.kind = 'qr' then '提交收款信息' when correction then '更新付款凭证' else '登记人工付款' end,trim(p_value));
  insert into public.audit_logs(actor_id,event,detail) values (p_actor_id,'提交文件',a.id::text || ':' || f.kind || ':' || f.id::text);
end;
$$;

revoke all on function public.app_save_workflow_file(uuid,uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.app_update_workflow_draft(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.app_remove_application_file(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.app_submit_workflow_file(uuid,uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.app_save_workflow_file(uuid,uuid,text,text,text,text,text) to service_role;
grant execute on function public.app_update_workflow_draft(uuid,uuid,uuid,text) to service_role;
grant execute on function public.app_remove_application_file(uuid,uuid,uuid) to service_role;
grant execute on function public.app_submit_workflow_file(uuid,uuid,uuid,text,boolean) to service_role;


-- 兼容旧付款 RPC，保留原有 service_role 调用范围。
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
  if a.id is null or a.status <> 'payment_pending'
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



revoke all on function public.app_record_payment(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.app_record_payment(uuid,uuid,text,text,text,text) to service_role;

-- 本人具有付款身份时也应收到待付款提醒；审批提醒仍排除申请人。
create or replace function private.enqueue_email_notification()
returns trigger language plpgsql security definer set search_path = public, private, pg_temp as $$
declare target_event text;
begin
  if old.status is not distinct from new.status then return null; end if;

  -- 收款码被移除会把付款退回“待补充收款码”：本轮的“待付款登记”提醒随之作废——它指向的收款人已经变了，
  -- 不能再用旧收款信息催付款。作废（cancelled）后不参与去重，同一版本内重新提交收款码可以再次提醒付款登记人；
  -- 若作废前已经发出过一次，sent_at 仍保留，管理面板能看到它确实寄出过。
  if old.status = 'payment_pending' and new.status = 'payment_info_required' then
    update public.notifications
       set status = 'cancelled', claim_id = null, lease_expires_at = now(),
           last_error = left('收款信息已变更，本次待付款登记提醒作废' ||
             case when sent_at is null then '' else '（作废前已发出过一次）' end, 300)
     where application_id = new.id and application_version = old.version
       and event = '待付款登记' and status <> 'cancelled';
  end if;

  target_event := private.app_notify_event_for_status(new.status);
  if target_event is null then return null; end if;
  -- 总开关与该类型的勾选都要为真；关闭期间发生的变化不补发（管理员重新打开后只管之后的状态变化）。
  if not exists(select 1 from public.settings where id = 1 and email_notify_enabled and target_event = any(email_notify_events)) then return null; end if;
  insert into public.notifications(application_id, application_version, event, recipient_user_id)
  select new.id, new.version, target_event, u.id
  from public.app_users u
  where u.active
    and coalesce(u.email, '') <> ''
    and case target_event
      when '待财委审批' then u.id <> new.owner_id and private.app_user_has_role(u.id, 'finance')
      when '待主席审批' then u.id <> new.owner_id and private.app_user_has_role(u.id, 'chair')
      when '待付款登记' then private.app_user_has_role(u.id, 'cashier')
      else u.id = new.owner_id
    end
  on conflict (application_id, application_version, event, recipient_user_id) where status <> 'cancelled' do nothing;
  return null;
end $$;
revoke all on function private.enqueue_email_notification() from public,anon,authenticated;
