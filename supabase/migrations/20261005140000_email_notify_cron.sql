-- 邮件队列的自动消费：注册一个 pg_cron 任务，每 5 分钟调用 app-api 的 send_notifications 定时入口（带 x-app-cron 头）。
-- 项目地址与密钥不进仓库：运维先把三个参数设到数据库上（具体取值示例见 README「Supabase」章节）——
--   alter database postgres set stabx.email_cron_url         = '<app-api 的函数访问地址>';
--   alter database postgres set stabx.email_cron_public_key  = '<前端同一个 publishable key，本身就是公开值>';
--   alter database postgres set stabx.email_cron_secret      = '<与 Edge Function 密钥 CRON_SECRET 完全相同>';
-- 然后执行本迁移；改完 CRON_SECRET 后可以反复 select public.app_register_email_cron() 重新登记（任务按名字覆盖，不会重复）。
-- 没有 pg_cron/pg_net、参数没设或登记失败时，本迁移只输出提示并跳过，不阻塞其它改动；也可以改用控制台 Scheduled Functions 配同样的 5 分钟任务。
create or replace function public.app_register_email_cron()
returns text language plpgsql security definer set search_path = public, private, pg_temp as $$
declare job_name text := 'email-notify-drain';
declare api_url text := nullif(trim(coalesce(current_setting('stabx.email_cron_url', true), '')), '');
declare public_key text := nullif(trim(coalesce(current_setting('stabx.email_cron_public_key', true), '')), '');
declare cron_secret text := nullif(trim(coalesce(current_setting('stabx.email_cron_secret', true), '')), '');
declare command_text text;
declare old_job bigint;
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

  -- 按任务名覆盖，重复调用只保留一条调度。
  for old_job in select jobid from cron.job where jobname = job_name loop
    perform cron.unschedule(old_job);
  end loop;

  -- pg_net 的 timeout_milliseconds 参数目前被忽略（官方文档写明“currently ignored, so there is no timeout”），
  -- 所以这里不传超时；一轮消费的边界由函数侧的 240 秒预算与平台墙钟决定。
  command_text := format(
    'select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb) as request_id',
    api_url,
    jsonb_build_object('content-type', 'application/json', 'apikey', public_key, 'x-app-cron', cron_secret)::text,
    '{"action":"send_notifications"}'
  );

  begin
    execute format('select cron.schedule(%L, %L, %L)', job_name, '*/5 * * * *', command_text);
  exception when others then
    return '跳过：定时任务登记失败（' || sqlerrm || '），请改用控制台 Scheduled Functions（*/5 * * * *）';
  end;

  return '已注册 ' || job_name || '（*/5 * * * *）';
end $$;

revoke all on function public.app_register_email_cron() from public, anon, authenticated;
grant execute on function public.app_register_email_cron() to service_role;

do $$
declare result text;
begin
  result := public.app_register_email_cron();
  raise notice '邮件队列定时任务：%', result;
end $$;
