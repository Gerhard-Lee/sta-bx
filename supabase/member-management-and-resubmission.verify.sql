begin;
do $verify$
declare super_id uuid; other_admin uuid; ordinary uuid; u uuid; r jsonb; app uuid; f uuid; i integer; denied boolean;
begin
  select id into super_id from public.app_users where username='admin';
  r:=private.app_insert_user('verify_manager_'||substr(gen_random_uuid()::text,1,8),'Test-only-1369666','测试管理员','测试'); other_admin:=(r->>'id')::uuid;
  insert into public.user_roles(user_id,role) values(other_admin,'admin');
  insert into public.user_roles(user_id,role) values(other_admin,'finance');
  r:=private.app_insert_user('verify_member_'||substr(gen_random_uuid()::text,1,8),'Test-only-1369666','测试成员','测试'); ordinary:=(r->>'id')::uuid;
  foreach u in array array[super_id,other_admin,ordinary] loop
    denied:=false;
    begin perform public.app_set_member_roles(u,super_id,array[]::text[],false); exception when raise_exception then denied:=true; end;
    if not denied then raise exception 'admin role change allowed'; end if;
  end loop;
  denied:=false; begin delete from public.user_roles where user_id=super_id; exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'admin role deletion allowed'; end if;
  denied:=false; begin update public.app_users set active=false where id=super_id; exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'admin deactivation allowed'; end if;
  denied:=false; begin update public.profiles set active=false where id=super_id; exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'admin profile deactivation allowed'; end if;
  denied:=false; begin update public.app_users set username='renamed_admin' where id=super_id; exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'admin rename allowed'; end if;
  denied:=false; begin insert into public.user_roles(user_id,role) values(super_id,'chair'); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'admin extra role allowed'; end if;
  -- Login may still update timestamps and the owner may change their password.
  update public.app_users set updated_at=now() where id=super_id;
  for i in 1..23 loop
    r:=private.app_insert_user('verify_page_'||i||'_'||substr(gen_random_uuid()::text,1,8),'Test-only-1369666','分页成员'||i,'搜索测试组');
    if i%2=0 then perform public.app_set_member_roles(other_admin,(r->>'id')::uuid,array['finance'],true); end if;
  end loop;
  r:=public.app_list_members(other_admin,'搜索测试组','','',1,10);
  if (r->>'total')::integer<>23 or jsonb_array_length(r->'profiles')<>10 then raise exception 'pagination first page wrong'; end if;
  r:=public.app_list_members(other_admin,'搜索测试组','','',999,10);
  if (r->>'page')::integer<>3 or jsonb_array_length(r->'profiles')<>3 then raise exception 'pagination clamp wrong'; end if;
  r:=public.app_list_members(other_admin,'VERIFY_PAGE_','finance','active',1,20);
  if (r->>'total')::integer<>11 then raise exception 'combined search filter wrong'; end if;
  r:=public.app_list_members(other_admin,'搜索测试组','ordinary','',1,20);
  if (r->>'total')::integer<>12 then raise exception 'ordinary filter wrong'; end if;
  r:=public.app_list_members(other_admin,'不存在的搜索值','','',1,10);
  if (r->>'total')::integer<>0 or (r->>'page')::integer<>1 then raise exception 'empty page wrong'; end if;
  denied:=false; begin perform public.app_list_members(ordinary); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'ordinary access allowed'; end if;
  insert into public.applications(owner_id,title,purpose,amount,category,department,use_date) values(ordinary,'重复提交测试','测试用途',19,'测试','测试',current_date) returning id into app;
  perform public.app_submit_application(app,ordinary,'首次提交');
  perform public.app_cancel_application(app,ordinary,'撤回');
  f:=public.app_save_workflow_file(app,ordinary,'attachment',ordinary::text||'/'||app::text||'/test.pdf','test.pdf','application/pdf','');
  perform public.app_remove_application_file(app,ordinary,f);
  update public.applications set title='撤回后修改' where id=app;
  perform public.app_submit_application(app,ordinary,'再次提交');
  perform public.app_return_application(app,other_admin,'再次修改');
  perform public.app_submit_application(app,ordinary,'第三次提交');
  if not exists(select 1 from public.applications where id=app and version=3 and status='finance_pending') then raise exception 'resubmission failed'; end if;
  if (select count(*) from public.approval_actions where application_id=app and action='提交申请')<>3 then raise exception 'submission history incomplete'; end if;
  denied:=false; begin perform public.app_submit_application(app,ordinary,'重复点击'); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'duplicate pending submission allowed'; end if;
end $verify$;
rollback;
