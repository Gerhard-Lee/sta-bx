-- 邮件队列的自动消费：注册一个 pg_cron 任务，每 5 分钟调用 app-api 的 send_notifications 定时入口（带 x-app-cron 头）。
-- 项目地址与密钥不进仓库：运维先把参数设到数据库上（具体取值示例见 README「Supabase」章节）——
--   alter database postgres set stabx.email_cron_url         = '<app-api 的函数访问地址>';
--   alter database postgres set stabx.email_cron_public_key  = '<前端同一个 publishable key，本身就是公开值>';
--   alter database postgres set stabx.email_cron_secret      = '<与 Edge Function 密钥 CRON_SECRET 完全相同>';
--   alter database postgres set stabx.email_cron_timeout_ms  = '140000';  -- 可选，pg_net 请求超时（毫秒）
-- 然后执行本迁移；改完 CRON_SECRET 后可以反复 select public.app_register_email_cron() 重新登记（任务按名字覆盖，不会重复）。
-- 没有 pg_cron/pg_net、参数没设或登记失败时，本迁移只输出提示并跳过，不阻塞其它改动；也可以改用控制台 Scheduled Functions 配同样的 5 分钟任务。
--
-- 超时这件事有个坑：pg_net 的 `timeout_milliseconds` **现在真的生效**（官方文档：`default 2000`，毫秒），
-- 早期文档里"currently ignored, so there is no timeout"的说法已经过时。2 秒会在几秒内掐断一轮消费：
-- 函数还在跑，调用方已经断开，剩下的行卡在"发送中"、按中断累加失败次数（正是函数侧 110 秒预算要避免的事）。
-- 所以这里显式传超时，默认 140 秒 = 函数默认预算 110 秒 + 30 秒余量；函数预算调大时（自托管）用
-- stabx.email_cron_timeout_ms 同步调大。

-- 真正登记调度的部分抽成 private 函数：它不探测扩展（探测留在 app_register_email_cron 里），
-- 因此测试库可以放一个 cron 桩直接调用它，验证任务名/周期/x-app-cron 头/pg_net 超时都写对了。
create or replace function private.app_schedule_email_cron(
  p_api_url text, p_public_key text, p_cron_secret text, p_timeout_ms integer
)
returns text language plpgsql security definer set search_path = public, private, pg_temp as $$
declare job_name text := 'email-notify-drain';
declare command_text text;
declare old_job bigint;
begin
  if coalesce(trim(p_api_url), '') = '' or coalesce(trim(p_public_key), '') = '' or coalesce(trim(p_cron_secret), '') = '' then
    return '跳过：缺少访问地址、publishable key 或定时密钥';
  end if;
  if p_timeout_ms is null or p_timeout_ms < 1000 or p_timeout_ms > 900000 then
    raise exception 'pg_net 超时应在 1000–900000 毫秒之间';
  end if;

  -- 按任务名覆盖，重复调用只保留一条调度。
  for old_job in select jobid from cron.job where jobname = job_name loop
    perform cron.unschedule(old_job);
  end loop;

  command_text := format(
    'select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb, timeout_milliseconds := %s) as request_id',
    p_api_url,
    jsonb_build_object('content-type', 'application/json', 'apikey', p_public_key, 'x-app-cron', p_cron_secret)::text,
    '{"action":"send_notifications"}',
    p_timeout_ms
  );

  begin
    execute format('select cron.schedule(%L, %L, %L)', job_name, '*/5 * * * *', command_text);
  exception when others then
    return '跳过：定时任务登记失败（' || sqlerrm || '），请改用控制台 Scheduled Functions（*/5 * * * *）';
  end;

  return '已注册 ' || job_name || '（*/5 * * * *）';
end $$;

revoke all on function private.app_schedule_email_cron(text, text, text, integer) from public, anon, authenticated;

create or replace function public.app_register_email_cron()
returns text language plpgsql security definer set search_path = public, private, pg_temp as $$
declare api_url text := nullif(trim(coalesce(current_setting('stabx.email_cron_url', true), '')), '');
declare public_key text := nullif(trim(coalesce(current_setting('stabx.email_cron_public_key', true), '')), '');
declare cron_secret text := nullif(trim(coalesce(current_setting('stabx.email_cron_secret', true), '')), '');
declare raw_timeout text := nullif(trim(coalesce(current_setting('stabx.email_cron_timeout_ms', true), '')), '');
-- 默认 140000 = 函数默认预算 110000 + 30000 余量；非法取值一律回落默认值，不让迁移因为一个手滑的 GUC 失败。
declare cron_timeout_ms integer := case when raw_timeout ~ '^[0-9]+$' then raw_timeout::integer else 140000 end;
begin
  if api_url is null or public_key is null or cron_secret is null then
    return '跳过：未设置 stabx.email_cron_url / stabx.email_cron_public_key / stabx.email_cron_secret';
  end if;
  if not exists(select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists(select 1 from pg_available_extensions where name = 'pg_net') then
    return '跳过：当前数据库没有 pg_cron/pg_net，请改用控制台 Scheduled Functions';
  end if;

  begin
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
  exception when others then
    return '跳过：扩展安装失败（' || sqlerrm || '），请改用控制台 Scheduled Functions';
  end;

  return private.app_schedule_email_cron(api_url, public_key, cron_secret, cron_timeout_ms);
end $$;

revoke all on function public.app_register_email_cron() from public, anon, authenticated;
grant execute on function public.app_register_email_cron() to service_role;

do $$
declare result text;
begin
  result := public.app_register_email_cron();
  raise notice '邮件队列定时任务：%', result;
end $$;
