-- Verification for supabase/audit-search-and-pagination.sql (Issue #7).
-- Run this on the TEST Supabase project after applying the SQL file above.
-- Everything happens inside one transaction that is rolled back at the end.
-- It needs the built-in admin account and one ordinary (non-admin) account.
begin;
do $verify$
declare
  super_id uuid; other_admin uuid; ordinary uuid;
  first_page jsonb; second_page jsonb; filtered jsonb; r jsonb;
  first_id bigint; second_id bigint; s integer; other integer; denied boolean;
  seen bigint[] := '{}'::bigint[]; i integer;
begin
  select id into super_id from public.app_users where lower(username)='admin' and active;
  if super_id is null then raise exception 'built-in admin is required for verification'; end if;
  -- A different administrator that triggers can stamp without touching the row again.
  select id into other_admin from public.app_users u
    where lower(u.username) <> 'admin' and u.active
      and exists(select 1 from public.user_roles r where r.user_id=u.id and r.role='admin')
    order by u.created_at limit 1;
  if other_admin is null then
    r := private.app_insert_user('verify_audit_'||substr(gen_random_uuid()::text,1,8),'Test-only-1369666','日志测试管理员','测试');
    other_admin := (r->>'id')::uuid;
    insert into public.user_roles(user_id,role) values(other_admin,'admin');
  end if;
  ordinary := (select id from public.app_users where lower(username)='finance' and active limit 1);
  if ordinary is null then
    r := private.app_insert_user('verify_audit_user_'||substr(gen_random_uuid()::text,1,8),'Test-only-1369666','日志测试成员','测试');
    ordinary := (r->>'id')::uuid;
  end if;

  -- Hand-built fixtures: no trigger, so the timestamp is fully controlled.
  for i in 1..25 loop
    insert into public.audit_logs(actor_id,event,detail,created_at,username,ip_address)
    values (super_id,'VERIFY_AUDIT_A','分页记录 '||i,now() - interval '10 days','verify_alpha','10.0.0.'||i);
  end loop;
  -- Several rows share one timestamp: this is the case where a page boundary could
  -- repeat or skip a row when the order is time only.
  for i in 1..7 loop
    insert into public.audit_logs(actor_id,event,detail,created_at,username,ip_address)
    values (other_admin,'VERIFY_AUDIT_B','其他记录 '||i,now(),'verify_beta','10.1.0.'||i);
  end loop;
  insert into public.audit_logs(actor_id,event,detail,created_at,username,ip_address)
  values (super_id,'VERIFY_AUDIT_C','不可能存在的筛选值',now(),'verify_alpha','10.2.0.1');

  -- Ordinary members never see the log.
  denied := false;
  begin perform public.app_list_audit_logs(ordinary); exception when raise_exception then denied := true; end;
  if not denied then raise exception 'ordinary user reached the audit log'; end if;
  denied := false;
  begin perform public.app_audit_log_events(ordinary); exception when raise_exception then denied := true; end;
  if not denied then raise exception 'ordinary user reached the event list'; end if;

  first_page := public.app_list_audit_logs(other_admin,'','','','','',1,10);
  second_page := public.app_list_audit_logs(other_admin,'','','','','',2,10);
  if (first_page->>'total')::integer <> 33 then raise exception 'unfiltered count wrong (%), expected 33', first_page->>'total'; end if;
  if jsonb_array_length(first_page->'logs') <> 10 or jsonb_array_length(second_page->'logs') <> 10 then raise exception 'page size wrong'; end if;

  -- No row may appear twice, and the boundary row must be exactly one step older.
  for i in 0..9 loop
    seen := seen || (first_page->'logs'->i->>'id')::bigint;
  end loop;
  for i in 0..9 loop
    seen := seen || (second_page->'logs'->i->>'id')::bigint;
  end loop;
  if (select count(*) from unnest(seen) x) <> (select count(distinct x) from unnest(seen) x) then
    raise exception 'a log row appeared on two pages';
  end if;
  first_id := (first_page->'logs'->-1->>'id')::bigint;
  second_id := (second_page->'logs'->0->>'id')::bigint;
  if (first_page->'logs'->-1->>'created_at')::timestamptz < (second_page->'logs'->0->>'created_at')::timestamptz
    or (first_page->'logs'->-1->>'created_at')::timestamptz = (second_page->'logs'->0->>'created_at')::timestamptz and first_id <= second_id then
    raise exception 'page boundary is not ordered by time then id';
  end if;
  for i in 1..9 loop
    if (first_page->'logs'->(i-1)->>'created_at')::timestamptz < (first_page->'logs'->i->>'created_at')::timestamptz then
      raise exception 'log ordering is not time descending';
    end if;
  end loop;

  filtered := public.app_list_audit_logs(other_admin,'verify_alpha','','','','',1,100);
  if (filtered->>'total')::integer <> 26 then raise exception 'username filter wrong (%)', filtered->>'total'; end if;
  if exists(select 1 from jsonb_array_elements(filtered->'logs') e where e->>'username' <> 'verify_alpha') then
    raise exception 'username filter returned another user';
  end if;
  filtered := public.app_list_audit_logs(other_admin,'','VERIFY_AUDIT_B','','','',1,100);
  if (filtered->>'total')::integer <> 7 then raise exception 'event filter wrong (%)', filtered->>'total'; end if;
  filtered := public.app_list_audit_logs(other_admin,'','','10.1.0.3','','',1,100);
  if (filtered->>'total')::integer <> 1 then raise exception 'ip filter wrong (%)', filtered->>'total'; end if;
  filtered := public.app_list_audit_logs(other_admin,'verify_alpha','VERIFY_AUDIT_C','10.2.0','','',1,100);
  if (filtered->>'total')::integer <> 1 then raise exception 'combined filter wrong (%)', filtered->>'total'; end if;
  filtered := public.app_list_audit_logs(other_admin,'不可能存在的筛选值','','','','',1,100);
  if (filtered->>'total')::integer <> 1 or jsonb_array_length(filtered->'logs') <> 1 then raise exception 'exact search value wrong'; end if;

  -- Beijing calendar days, identical to the export boundaries. Rows were written
  -- ten days ago and moments ago, so only one of these ranges has to be empty.
  filtered := public.app_list_audit_logs(other_admin,'','VERIFY_AUDIT_A','',to_char((now() at time zone 'Asia/Shanghai')::date,'YYYY-MM-DD'),'',1,100);
  if (filtered->>'total')::integer <> 0 then raise exception 'start day filter returned older rows'; end if;
  filtered := public.app_list_audit_logs(other_admin,'','VERIFY_AUDIT_A','',to_char((now() at time zone 'Asia/Shanghai')::date - 10,'YYYY-MM-DD'),'',1,100);
  s := (filtered->>'total')::integer;
  if s < 25 then raise exception 'start day filter dropped the same-day rows (%)', s; end if;
  filtered := public.app_list_audit_logs(other_admin,'','VERIFY_AUDIT_A','',to_char((now() at time zone 'Asia/Shanghai')::date - 10,'YYYY-MM-DD'),to_char((now() at time zone 'Asia/Shanghai')::date - 11,'YYYY-MM-DD'),1,100);
  if (filtered->>'total')::integer <> 0 then raise exception 'reversed day range returned rows'; end if;

  filtered := public.app_list_audit_logs(other_admin,'','VERIFY_AUDIT_D','','','',1,100);
  if (filtered->>'total')::integer <> 0 or (filtered->>'page')::integer <> 1 or jsonb_array_length(filtered->'logs') <> 0 then
    raise exception 'empty result wrong';
  end if;
  filtered := public.app_list_audit_logs(other_admin,'','VERIFY_AUDIT_A','','','',999,10);
  if (filtered->>'page')::integer <> 3 then raise exception 'page clamp wrong (%)', filtered->>'page'; end if;

  denied := false;
  begin perform public.app_list_audit_logs(other_admin,'','','','',(now()+interval '1 day')::text,1,10); exception when raise_exception then denied := true; end;
  if not denied then raise exception 'invalid date filter accepted'; end if;
  denied := false;
  begin perform public.app_list_audit_logs(other_admin,'','','','','',1,7); exception when raise_exception then denied := true; end;
  if not denied then raise exception 'invalid page size accepted'; end if;
  denied := false;
  begin perform public.app_list_audit_logs(other_admin,repeat('x',81)); exception when raise_exception then denied := true; end;
  if not denied then raise exception 'over-long search value accepted'; end if;

  -- Ordinary administrators keep the action text but not IP or request metadata.
  filtered := public.app_list_audit_logs(other_admin,'不可能存在的筛选值','','','','',1,10);
  if filtered->'logs'->0->'metadata' <> '{}'::jsonb or filtered->'logs'->0->'ip_address' <> 'null'::jsonb then
    raise exception 'limited scope leaked ip or metadata';
  end if;
  if filtered->'logs'->0->>'detail' <> '不可能存在的筛选值' then raise exception 'limited scope lost the log content'; end if;
  if filtered->>'scope' <> 'limited' then raise exception 'limited scope marker missing'; end if;
  filtered := public.app_list_audit_logs(super_id,'不可能存在的筛选值','','','','',1,10);
  if filtered->>'scope' <> 'full' then raise exception 'super admin scope marker missing'; end if;
  if not (filtered->'logs'->0 ? 'request_id') or not (filtered->'logs'->0 ? 'metadata') or filtered->'logs'->0->>'ip_address' <> '10.2.0.1' then
    raise exception 'super admin did not receive the full row';
  end if;
  -- The built-in admin also sees another administrator's activity.
  other := (public.app_list_audit_logs(super_id,'verify_beta','','','','',1,10)->>'total')::integer;
  if other <> 7 then raise exception 'super admin missed another admin''s rows (%)', other; end if;

  r := public.app_audit_log_events(other_admin);
  if jsonb_typeof(r) <> 'array' or not (r ? 'VERIFY_AUDIT_A') or not (r ? 'VERIFY_AUDIT_B') then raise exception 'event choices incomplete'; end if;
  if exists(select 1 from jsonb_array_elements_text(r) e where e = '') then raise exception 'event choices contain an empty name'; end if;
end $verify$;
rollback;
