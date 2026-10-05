-- Shared audit query for the directory, legacy admin_data and export.
-- Requires admin-settings-audit.sql and the separate-admin-role migration.
create index if not exists audit_logs_created_id_idx on public.audit_logs(created_at desc, id desc);

create or replace function public.app_list_audit_logs(
  p_actor_id uuid, p_username text default '', p_event text default '',
  p_ip text default '', p_start text default '', p_end text default '',
  p_page integer default 1, p_page_size integer default 20,
  p_snapshot bigint default null
)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  super_admin boolean;
  start_at timestamptz;
  end_at timestamptz;
  snapshot_id bigint;
  result jsonb;
begin
  if not private.app_user_has_role(p_actor_id,'admin') then raise exception '没有管理员权限'; end if;
  super_admin := private.app_user_is_superadmin(p_actor_id);
  if p_username is null or length(p_username)>80
    or p_event is null or length(p_event)>80
    or p_ip is null or length(p_ip)>64
    or p_start is null or p_end is null
    or p_page is null or p_page<1
    or p_page_size is null or p_page_size not in (10,20,50,100,1000)
    or (p_snapshot is not null and p_snapshot<0)
    or (p_start<>'' and p_start !~ '^\d{4}-\d{2}-\d{2}$')
    or (p_end<>'' and p_end !~ '^\d{4}-\d{2}-\d{2}$')
    or (p_start<>'' and p_end<>'' and p_start>p_end)
  then raise exception '搜索或分页参数无效'; end if;
  if not super_admin and trim(p_ip)<>'' then raise exception '仅超级管理员可以按 IP 筛选'; end if;
  if p_start<>'' then start_at := (p_start||' 00:00:00+08')::timestamptz; end if;
  if p_end<>'' then end_at := ((p_end||' 00:00:00+08')::timestamptz + interval '1 day'); end if;
  -- Freeze the insertion boundary for subsequent pages and the matching export.
  select least(coalesce(p_snapshot,coalesce(max(id),0)),coalesce(max(id),0)) into snapshot_id from public.audit_logs;

  with filtered as materialized (
    select l.*,coalesce(nullif(l.username,''),u.username,'系统') as audit_username
    from public.audit_logs l left join public.app_users u on u.id=l.actor_id
    where l.id<=snapshot_id
      and (p_username='' or strpos(lower(coalesce(nullif(l.username,''),u.username,'系统')),lower(trim(p_username)))>0)
      and (p_event='' or strpos(lower(l.event),lower(trim(p_event)))>0)
      and (p_ip='' or strpos(lower(coalesce(l.ip_address,'')),lower(trim(p_ip)))>0)
      and (start_at is null or l.created_at>=start_at)
      and (end_at is null or l.created_at<end_at)
  ), stats as (
    select count(*) as total from filtered
  ), paging as (
    select total,least(p_page,greatest(1,(total+p_page_size-1)/p_page_size)) as current_page from stats
  ), selected as (
    select l.* from filtered l
    order by l.created_at desc,l.id desc
    limit p_page_size offset (select (current_page-1)*p_page_size from paging)
  )
  select jsonb_build_object(
    'logs',coalesce((select jsonb_agg(
      case when super_admin then (to_jsonb(l)-'audit_username') || jsonb_build_object('username',l.audit_username)
      else jsonb_build_object('id',l.id,'created_at',l.created_at,'actor_id',l.actor_id,
        'username',l.audit_username,'event',l.event,'detail',l.detail,
        'ip_address',null,'metadata','{}'::jsonb,'request_id',null) end
      order by l.created_at desc,l.id desc) from selected l),'[]'::jsonb),
    'total',total,'page',current_page,'page_size',p_page_size,
    'snapshot',snapshot_id::text,'scope',case when super_admin then 'full' else 'limited' end
  ) into result from paging;
  return result;
end $$;

create or replace function public.app_audit_log_events(p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare result jsonb;
begin
  if not private.app_user_has_role(p_actor_id,'admin') then raise exception '没有管理员权限'; end if;
  select coalesce(jsonb_agg(e.event order by e.event),'[]'::jsonb) into result
    from (select distinct event from public.audit_logs where event<>'') e;
  return result;
end $$;
revoke all on function public.app_list_audit_logs(uuid,text,text,text,text,text,integer,integer,bigint),public.app_audit_log_events(uuid) from public,anon,authenticated;
grant execute on function public.app_list_audit_logs(uuid,text,text,text,text,text,integer,integer,bigint),public.app_audit_log_events(uuid) to service_role;
