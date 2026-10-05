-- Issue #7: administrator audit logs need search, filters and server-side paging.
-- Apply after admin-settings-audit.sql, member-management-and-resubmission.sql and
-- migrations/20261002133000_separate_admin_and_workflow_roles.sql.
-- Run this file, then run supabase/audit-search-and-pagination.verify.sql.
--
-- This file adds no column and changes no existing row: it only adds indexes and
-- one read-only RPC. The existing trigger private.decorate_audit_log() keeps
-- filling audit_logs.username, so a re-backfill is unnecessary.

-- Paging is time plus unique id, so a stable index is what keeps page N+1 exact
-- and lets a filtered range scan stop early.
create index if not exists audit_logs_created_id_idx on public.audit_logs(created_at desc, id desc);
create index if not exists audit_logs_username_idx on public.audit_logs(username);
create index if not exists audit_logs_ip_idx on public.audit_logs(ip_address);

-- One server-side query backs both the log table and the CSV/XLSX export, so the
-- list and the export can never drift apart on what a filter means.
-- p_username/p_event/p_ip are case-insensitive substring matches; p_start/p_end
-- are Beijing-time calendar days interpreted exactly like export_audit.
create or replace function public.app_list_audit_logs(
  p_actor_id uuid,
  p_username text default '',
  p_event text default '',
  p_ip text default '',
  p_start text default '',
  p_end text default '',
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  super_admin boolean;
  start_at timestamptz;
  end_at timestamptz;
  total integer;
  current_page integer;
  result jsonb;
begin
  if not private.app_user_has_role(p_actor_id,'admin') then raise exception '没有管理员权限'; end if;
  super_admin := private.app_user_is_superadmin(p_actor_id);

  if p_username is null or length(p_username)>80
    or p_event is null or length(p_event)>80
    or p_ip is null or length(p_ip)>64
    or p_start is null or p_end is null
    or p_page is null or p_page<1
    or p_page_size is null or p_page_size not in (10,20,50,100)
    or (p_start<>'' and p_start !~ '^\d{4}-\d{2}-\d{2}$')
    or (p_end<>'' and p_end !~ '^\d{4}-\d{2}-\d{2}$')
    or (p_start<>'' and p_end<>'' and p_start>p_end)
  then raise exception '搜索或分页参数无效'; end if;

  -- Beijing calendar days: >= 00:00 of the start day, < 00:00 of the day after end.
  if p_start<>'' then start_at := (p_start||' 00:00:00+08')::timestamptz; end if;
  if p_end<>'' then end_at := ((p_end||' 00:00:00+08')::timestamptz + interval '1 day'); end if;

  select count(*) into total
  from public.audit_logs l
  where (p_username='' or strpos(lower(coalesce(l.username,'')),lower(trim(p_username)))>0)
    and (p_event='' or strpos(lower(l.event),lower(trim(p_event)))>0)
    and (p_ip='' or coalesce(l.ip_address,'') ilike '%'||replace(replace(trim(p_ip),'%','\%'),'_','\_')||'%' escape '\')
    and (start_at is null or l.created_at>=start_at)
    and (end_at is null or l.created_at<end_at);

  current_page := least(p_page,greatest(1,(total+p_page_size-1)/p_page_size));

  -- Newest first, newest id first inside the same timestamp. The composite order
  -- is what guarantees the same row cannot appear on two pages or be skipped.
  select coalesce(jsonb_agg(entry),'[]'::jsonb) into result from (
    select case when super_admin
      then to_jsonb(l)
      else jsonb_build_object(
        'id',l.id,
        'created_at',l.created_at,
        'actor_id',l.actor_id,
        'username',coalesce(l.username,''),
        'event',l.event,
        'detail',l.detail,
        -- A non-super administrator sees what happened, not the network trace or
        -- the internal request metadata. A super administrator sees the full row.
        'ip_address',null,
        'metadata','{}'::jsonb,
        'request_id',null
      )
    end as entry
    from public.audit_logs l
    where (p_username='' or strpos(lower(coalesce(l.username,'')),lower(trim(p_username)))>0)
      and (p_event='' or strpos(lower(l.event),lower(trim(p_event)))>0)
      and (p_ip='' or coalesce(l.ip_address,'') ilike '%'||replace(replace(trim(p_ip),'%','\%'),'_','\_')||'%' escape '\')
      and (start_at is null or l.created_at>=start_at)
      and (end_at is null or l.created_at<end_at)
    order by l.created_at desc,l.id desc
    limit p_page_size offset (current_page-1)*p_page_size
  ) page;

  return jsonb_build_object('logs',result,'total',total,'page',current_page,'page_size',p_page_size,'scope',case when super_admin then 'full' else 'limited' end);
end $$;

-- Filter choices come from the data itself, so a renamed action never leaves a
-- dead filter behind in the interface.
create or replace function public.app_audit_log_events(p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare result jsonb;
begin
  if not private.app_user_has_role(p_actor_id,'admin') then raise exception '没有管理员权限'; end if;
  select coalesce(jsonb_agg(e.event order by e.event),'[]'::jsonb) into result
  from (select distinct event from public.audit_logs where event<>'' ) e;
  return result;
end $$;

revoke all on function public.app_list_audit_logs(uuid,text,text,text,text,text,integer,integer),public.app_audit_log_events(uuid) from public,anon,authenticated;
grant execute on function public.app_list_audit_logs(uuid,text,text,text,text,text,integer,integer),public.app_audit_log_events(uuid) to service_role;
