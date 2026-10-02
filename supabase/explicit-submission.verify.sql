-- Isolated integration checks. All records are rolled back at the end.
begin;
do $$
<<explicit_submission_verify>>
declare
  owner_id uuid := gen_random_uuid(); cashier_id uuid := gen_random_uuid(); outsider_id uuid := gen_random_uuid(); superadmin_id uuid;
  application_id uuid := gen_random_uuid(); f uuid; old_qr uuid; reference_value text := gen_random_uuid()::text;
  blocked boolean; current_status text;
begin
  select id into superadmin_id from public.app_users where lower(username)='admin' and active;
  if superadmin_id is null then raise exception 'built-in admin is required for verification'; end if;
  insert into public.app_users(id,username,password_hash) values
    (owner_id,'verify_' || replace(owner_id::text,'-',''),'not-a-login-hash'),
    (cashier_id,'verify_' || replace(cashier_id::text,'-',''),'not-a-login-hash'),
    (outsider_id,'verify_' || replace(outsider_id::text,'-',''),'not-a-login-hash');
  insert into public.profiles(id,full_name) values (owner_id,'验证申请人'),(cashier_id,'验证管理员'),(outsider_id,'验证普通成员');
  insert into public.user_roles(user_id,role) values (cashier_id,'admin');
  insert into public.applications(id,owner_id,title,purpose,amount,category,department,use_date)
  values (application_id,owner_id,'事务回滚验证','不保留测试数据',200,'验证','验证',current_date);
  f := public.app_save_workflow_file(application_id,owner_id,'attachment',owner_id::text || '/' || application_id::text || '/attachment-test.pdf','test.pdf','application/pdf');
  if (select status from public.applications where id = application_id) <> 'draft' then raise exception '附件保存自动提交'; end if;
  perform public.app_remove_application_file(application_id,owner_id,f);
  if (select removed_at from public.application_files where id = f) is null then raise exception '移除未生效'; end if;
  blocked := false;
  begin perform public.app_save_workflow_file(application_id,outsider_id,'attachment',owner_id::text || '/' || application_id::text || '/denied.pdf','denied.pdf','application/pdf'); exception when others then blocked := true; end;
  if not blocked then raise exception '普通成员越权上传'; end if;
  perform public.app_submit_application(application_id,owner_id,'');
  if (select status from public.applications where id = application_id) <> 'finance_pending' then raise exception '正式提交失败'; end if;
  blocked := false;
  begin perform public.app_approve_application(application_id,cashier_id,'验证通过'); exception when others then blocked := true; end;
  if not blocked then raise exception '普通管理员越权审批'; end if;
  perform public.app_approve_application(application_id,superadmin_id,'验证通过');
  if (select status from public.applications where id = application_id) <> 'chair_pending' then raise exception '主席流转失败'; end if;
  perform public.app_approve_application(application_id,superadmin_id,'验证通过');
  f := public.app_save_workflow_file(application_id,owner_id,'qr',owner_id::text || '/' || application_id::text || '/qr-test.jpg','qr.jpg','image/jpeg','');
  if (select status from public.applications where id = application_id) <> 'payment_info_required' then raise exception '收款保存自动提交'; end if;
  blocked := false;
  begin perform public.app_submit_workflow_file(application_id,owner_id,f,'',false); exception when others then blocked := true; end;
  if not blocked then raise exception '空收款人被提交'; end if;
  perform public.app_update_workflow_draft(application_id,owner_id,f,'验证人');
  perform public.app_submit_workflow_file(application_id,owner_id,f,'验证人',false);
  if (select status from public.applications where id = application_id) <> 'payment_pending' then raise exception '收款提交失败'; end if;
  old_qr := f;
  perform public.app_remove_application_file(application_id,owner_id,old_qr);
  if (select status from public.applications where id = application_id) <> 'payment_info_required' then raise exception '移除收款码未暂停付款'; end if;
  f := public.app_save_workflow_file(application_id,owner_id,'qr',owner_id::text || '/' || application_id::text || '/qr-replacement.jpg','qr-new.jpg','image/jpeg','验证人');
  perform public.app_submit_workflow_file(application_id,owner_id,f,'验证人',false);
  blocked := false;
  begin perform public.app_save_workflow_file(application_id,cashier_id,'receipt',owner_id::text || '/' || application_id::text || '/receipt-denied.pdf','receipt-denied.pdf','application/pdf',''); exception when others then blocked := true; end;
  if not blocked then raise exception '普通管理员越权保存付款凭证'; end if;
  f := public.app_save_workflow_file(application_id,superadmin_id,'receipt',owner_id::text || '/' || application_id::text || '/receipt-test.pdf','receipt.pdf','application/pdf','');
  if (select status from public.applications where id = application_id) <> 'payment_pending' or exists(select 1 from public.payments p where p.application_id = explicit_submission_verify.application_id) then
    raise exception '付款草稿产生付款记录';
  end if;
  blocked := false;
  begin perform public.app_submit_workflow_file(application_id,superadmin_id,f,reference_value,false); exception when others then blocked := true; end;
  if not blocked then raise exception '未核对也能提交付款'; end if;
  blocked := false;
  begin perform public.app_submit_workflow_file(application_id,outsider_id,f,reference_value,true); exception when others then blocked := true; end;
  if not blocked then raise exception '普通成员越权付款'; end if;
  perform public.app_submit_workflow_file(application_id,superadmin_id,f,reference_value,true);
  if (select status from public.applications where id = application_id) <> 'paid' then raise exception '付款提交失败'; end if;
  blocked := false;
  begin perform public.app_submit_workflow_file(application_id,superadmin_id,f,reference_value,true); exception when others then blocked := true; end;
  if not blocked then raise exception '重复提交未被阻止'; end if;
  blocked := false;
  begin perform public.app_remove_application_file(application_id,superadmin_id,f); exception when others then blocked := true; end;
  if not blocked then raise exception '已付凭证可直接删除'; end if;
  f := public.app_save_workflow_file(application_id,superadmin_id,'receipt',owner_id::text || '/' || application_id::text || '/receipt-correction.pdf','corrected.pdf','application/pdf',reference_value);
  perform public.app_submit_workflow_file(application_id,superadmin_id,f,reference_value,true);
  if (select count(*) from public.application_files af where af.application_id = explicit_submission_verify.application_id and kind = 'receipt' and removed_at is null and not pending) <> 1 then raise exception '凭证更正未替换旧文件'; end if;
end;
$$;
rollback;
