-- QQ群提醒与邮件独立；不在群中公开申请详情。
alter table public.settings add column qq_notify_enabled boolean not null default false;
alter table public.settings add column qq_group_openid text not null default '';
alter table public.settings add column qq_notify_events text[] not null default array['待财委审批','待主席审批','退回修改','待补充收款码','待付款登记'];
alter table public.settings add constraint settings_qq_events_check check
 (array_position(qq_notify_events,null) is null and qq_notify_events <@ array['待财委审批','待主席审批','退回修改','待补充收款码','待付款登记','拒绝申请','已付款']);
alter table public.settings add constraint settings_qq_group_check check
 (qq_group_openid='' or qq_group_openid ~ '^[A-Za-z0-9_-]{16,128}$');
create table public.qq_notifications (
 id bigint generated always as identity primary key,
 application_id uuid not null references public.applications(id) on delete cascade,
 application_version integer not null,
 event text not null,
 group_openid text not null,
 status text not null default 'pending' check(status in ('pending','sending','sent','failed','cancelled')),
 attempts integer not null default 0,
 claim_id uuid,
 lease_expires_at timestamptz,
 next_attempt_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 sent_at timestamptz,
 last_error text not null default ''
);
alter table public.qq_notifications enable row level security;
revoke all on public.qq_notifications from public,anon,authenticated;
grant all on public.qq_notifications to service_role;
grant usage,select on sequence public.qq_notifications_id_seq to service_role;
create unique index qq_notify_dedupe on public.qq_notifications(application_id,application_version,event,group_openid) where status<>'cancelled';
create index qq_notify_pending on public.qq_notifications(next_attempt_at,id) where status in ('pending','sending');
create function private.enqueue_qq_notification() returns trigger
language plpgsql security definer set search_path=public,private,pg_temp as $$
declare target_event text;
begin
 if old.status is not distinct from new.status then return null; end if;
 update public.qq_notifications set status='cancelled',claim_id=null,last_error='申请状态已变化'
 where application_id=new.id and status in ('pending','sending');
 target_event:=private.app_notify_event_for_status(new.status);
 insert into public.qq_notifications(application_id,application_version,event,group_openid)
 select new.id,new.version,target_event,s.qq_group_openid from public.settings s
 where s.id=1 and s.qq_notify_enabled and s.qq_group_openid<>'' and target_event=any(s.qq_notify_events)
 on conflict(application_id,application_version,event,group_openid) where status<>'cancelled' do nothing;
 return null;
end $$;
create trigger qq_notify_status_change after update of status on public.applications
for each row execute function private.enqueue_qq_notification();
revoke all on function private.enqueue_qq_notification() from public,anon,authenticated;
create function public.app_update_qq_notify(p_actor_id uuid,p_enabled boolean,p_group_openid text,p_events text[])
returns void language plpgsql security definer set search_path=public,private,pg_temp as $$
begin
 if not private.app_user_has_role(p_actor_id,'admin') or p_enabled is null then raise exception '没有管理员权限或参数无效'; end if;
 if p_events is null or array_position(p_events,null) is not null or not p_events <@ array['待财委审批','待主席审批','退回修改','待补充收款码','待付款登记','拒绝申请','已付款'] then raise exception '提醒类型无效'; end if;
 if p_group_openid is null or (p_group_openid<>'' and p_group_openid !~ '^[A-Za-z0-9_-]{16,128}$') or (p_enabled and p_group_openid='') then raise exception '请填写有效的群OpenID（不是数字群号）'; end if;
 perform 1 from public.settings where id=1 for update;
 update public.settings set qq_notify_enabled=p_enabled,qq_group_openid=p_group_openid,
 qq_notify_events=array(select distinct e from unnest(p_events) e),updated_at=now(),updated_by=p_actor_id where id=1;
 update public.qq_notifications set status='cancelled',claim_id=null,last_error='QQ提醒设置已变更'
 where status in ('pending','sending') and (group_openid<>p_group_openid or not event=any(p_events));
 insert into public.audit_logs(actor_id,event,detail) values(p_actor_id,'修改QQ通知设置',case when p_enabled then '开启' else '关闭' end || 'QQ群提醒，类型：' || array_to_string(p_events,'、'));
end $$;
-- 总开关用于暂停消费，群/事件/版本/状态用于判定是否作废。
create function private.qq_notify_valid(n public.qq_notifications) returns boolean
language sql stable set search_path=public,private,pg_temp as $$
 select exists(select 1 from public.applications a,public.settings s where a.id=n.application_id
 and a.version=n.application_version and private.app_notify_event_for_status(a.status)=n.event
 and s.id=1 and s.qq_group_openid=n.group_openid and n.event=any(s.qq_notify_events))
$$;
revoke all on function private.qq_notify_valid(public.qq_notifications) from public,anon,authenticated;
create function public.app_claim_qq_notifications(p_claim_id uuid) returns jsonb
language plpgsql security definer set search_path=public,private,pg_temp as $$
declare claimed jsonb;
begin
 if not exists(select 1 from public.settings where id=1 and qq_notify_enabled) then return '[]'::jsonb; end if;
 update public.qq_notifications n set status='cancelled',claim_id=null,last_error='提醒已过期或不再适用'
 where status in ('pending','sending') and (created_at<now()-interval '24 hours' or not private.qq_notify_valid(n));
 update public.qq_notifications set status=case when attempts>=5 then 'failed' else 'pending' end,claim_id=null,last_error='上次投递中断或结果保存失败'
 where status='sending' and lease_expires_at<now();
 with picked as (
 select id from public.qq_notifications where status='pending' and next_attempt_at<=now() and attempts<5
 order by id for update skip locked limit 3
 ), leased as (
 update public.qq_notifications n set status='sending',claim_id=p_claim_id,lease_expires_at=now()+interval '60 seconds',attempts=attempts+1
 from picked where n.id=picked.id returning n.*
 ) select coalesce(jsonb_agg(to_jsonb(leased) order by id),'[]'::jsonb) into claimed from leased;
 return claimed;
end $$;
create function public.app_verify_qq_notification(p_id bigint,p_claim_id uuid) returns boolean
language sql security definer set search_path=public,private,pg_temp as $$
 select exists(select 1 from public.qq_notifications n,public.settings s where n.id=p_id and n.claim_id=p_claim_id
 and n.status='sending' and n.lease_expires_at>now() and s.id=1 and s.qq_notify_enabled and private.qq_notify_valid(n))
$$;
create function public.app_reset_qq_notifications(p_actor_id uuid) returns integer
language plpgsql security definer set search_path=public,private,pg_temp as $$
declare affected integer;
begin
 if not private.app_user_has_role(p_actor_id,'admin') then raise exception '没有管理员权限'; end if;
 update public.qq_notifications n set status='pending',attempts=0,claim_id=null,next_attempt_at=now()
 where status='failed' and created_at>now()-interval '24 hours' and private.qq_notify_valid(n);
 get diagnostics affected=row_count;
 insert into public.audit_logs(actor_id,event,detail) values(p_actor_id,'重试QQ提醒',affected || '条有效提醒已重新排队');
 return affected;
end $$;
revoke all on function public.app_update_qq_notify(uuid,boolean,text,text[]),public.app_claim_qq_notifications(uuid),public.app_verify_qq_notification(bigint,uuid),public.app_reset_qq_notifications(uuid) from public,anon,authenticated;
grant execute on function public.app_update_qq_notify(uuid,boolean,text,text[]),public.app_claim_qq_notifications(uuid),public.app_verify_qq_notification(bigint,uuid),public.app_reset_qq_notifications(uuid) to service_role;
