-- Isolated fixtures; all user, role and log changes roll back.
begin;
do $verify$
declare
  super_id uuid; manager uuid; member uuid; fixture text := 'VERIFY_'||gen_random_uuid()::text;
  user_name text; row_id bigint; r jsonb; a jsonb; b jsonb; full_export jsonb;
  first_ids bigint[]; second_ids bigint[]; denied boolean; i integer; snap bigint;
begin
  select id into super_id from public.app_users where lower(username)='admin' and active;
  if super_id is null then raise exception 'active built-in admin required'; end if;
  user_name := 'verify_'||substr(gen_random_uuid()::text,1,8);
  r := private.app_insert_user(user_name,'Verification-only-1369666','验证管理员','验证');
  manager := (r->>'id')::uuid;
  insert into public.user_roles(user_id,role) values(manager,'admin');
  r := private.app_insert_user('verify_'||substr(gen_random_uuid()::text,1,8),'Verification-only-1369666','验证成员','验证');
  member := (r->>'id')::uuid;

  for i in 1..25 loop
    insert into public.audit_logs(actor_id,event,detail,ip_address,metadata)
      values(manager,fixture,'fixture '||i,'10.20.0.'||i,'{"internal":"secret"}') returning id into row_id;
    -- Simulate historic rows and exact timestamp ties after the insert decorator.
    update public.audit_logs set username='',created_at='2026-10-01 00:00:00+08' where id=row_id;
  end loop;
  a := public.app_list_audit_logs(manager,user_name,fixture,'','','',1,10);
  if (a->>'total')::integer<>25 or jsonb_array_length(a->'logs')<>10 then raise exception 'legacy username filter failed'; end if;
  if a->'logs'->0->>'username'<>user_name then raise exception 'legacy username projection failed'; end if;
  if a->>'scope'<>'limited' or a->'logs'->0->'ip_address'<>'null'::jsonb
    or a->'logs'->0->'metadata'<>'{}'::jsonb or a->'logs'->0->'request_id'<>'null'::jsonb then raise exception 'limited projection failed'; end if;
  snap := (a->>'snapshot')::bigint;
  select array_agg((e->>'id')::bigint) into first_ids from jsonb_array_elements(a->'logs') e;

  -- Insert between pages, including a record with the same timestamp.
  insert into public.audit_logs(actor_id,event,detail,ip_address) values(manager,fixture,'new row','10.20.0.99') returning id into row_id;
  update public.audit_logs set created_at='2026-10-01 00:00:00+08' where id=row_id;
  b := public.app_list_audit_logs(manager,user_name,fixture,'','','',2,10,snap);
  select array_agg((e->>'id')::bigint) into second_ids from jsonb_array_elements(b->'logs') e;
  if first_ids && second_ids or (b->>'total')::integer<>25 then raise exception 'insert shifted page boundary'; end if;
  if (a->'logs'->-1->>'id')::bigint <= (b->'logs'->0->>'id')::bigint then raise exception 'timestamp tie ordering failed'; end if;
  full_export := public.app_list_audit_logs(manager,user_name,fixture,'','','',1,1000,snap);
  if jsonb_array_length(full_export->'logs')<>25 or exists(select 1 from jsonb_array_elements(full_export->'logs') e where (e->>'id')::bigint=row_id) then raise exception 'export snapshot mismatch'; end if;

  denied := false;
  begin perform public.app_list_audit_logs(manager,'',fixture,'10.20.','','',1,10); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'ordinary admin can probe IP'; end if;
  denied := false;
  begin perform public.app_list_audit_logs(member); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'ordinary member can read logs'; end if;
  denied := false;
  begin perform public.app_audit_log_events(member); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'ordinary member can read events'; end if;

  r := public.app_list_audit_logs(super_id,user_name,fixture,'10.20.0.99','','',1,10);
  if (r->>'total')::integer<>1 or r->'logs'->0->>'ip_address'<>'10.20.0.99' or r->>'scope'<>'full' then raise exception 'superadmin IP filter failed'; end if;
  r := public.app_list_audit_logs(super_id,'',fixture,'','2026-10-01','2026-10-01',1,100);
  if (r->>'total')::integer<>26 then raise exception 'Beijing date bounds failed'; end if;
  r := public.app_list_audit_logs(super_id,'',fixture,'','2026-10-02','',1,100);
  if (r->>'total')::integer<>0 then raise exception 'start date bound failed'; end if;
  r := public.app_list_audit_logs(super_id,'',fixture,'','','2026-09-30',1,100);
  if (r->>'total')::integer<>0 then raise exception 'end date bound failed'; end if;
  r := public.app_list_audit_logs(manager,'',fixture,'','','',999,10,snap);
  if (r->>'page')::integer<>3 then raise exception 'page clamp failed'; end if;
  denied := false;
  begin perform public.app_list_audit_logs(manager,'',fixture,'','2026-10-02','2026-10-01'); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'reversed dates accepted'; end if;
  denied := false;
  begin perform public.app_list_audit_logs(manager,'',fixture,'','','',1,7); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'invalid page size accepted'; end if;
  r := public.app_audit_log_events(manager);
  if not (r ? fixture) then raise exception 'event list missing fixture'; end if;
  if has_function_privilege('anon','public.app_list_audit_logs(uuid,text,text,text,text,text,integer,integer,bigint)','execute')
    or has_function_privilege('authenticated','public.app_list_audit_logs(uuid,text,text,text,text,text,integer,integer,bigint)','execute') then raise exception 'public RPC privileges leaked'; end if;
end $verify$;
rollback;
