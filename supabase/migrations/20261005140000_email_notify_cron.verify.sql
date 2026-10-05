-- 迁移后在事务中执行；不保留任何验证数据。
-- 未配置 pg_cron 参数时本验证只输出提示：定时消费可以改由控制台 Scheduled Functions 承担。
begin;
do $$
declare
  result text;
  jobs integer;
begin
  if to_regprocedure('public.app_register_email_cron()') is null then raise exception '缺少邮件队列定时登记函数'; end if;
  if to_regclass('cron.job') is null then
    raise notice '未安装 pg_cron，跳过定时调度验证；请设置 stabx.email_cron_* 参数后重跑迁移，或改用控制台 Scheduled Functions。';
    return;
  end if;

  result := public.app_register_email_cron();
  if result not like '已注册%' then
    raise notice '邮件队列定时任务未登记：%', result;
    if exists(select 1 from cron.job where jobname = 'email-notify-drain') then raise exception '登记未成功却留下了调度记录'; end if;
    return;
  end if;

  -- 反复登记必须按任务名收敛为一条。
  perform public.app_register_email_cron();
  perform public.app_register_email_cron();
  select count(*) into jobs from cron.job where jobname = 'email-notify-drain';
  if jobs <> 1 then raise exception '重复登记应只保留一条调度，实际 ' || jobs; end if;
  if not exists(select 1 from cron.job where jobname = 'email-notify-drain' and schedule = '*/5 * * * *') then raise exception '调度周期应为每 5 分钟'; end if;
  if not exists(select 1 from cron.job where jobname = 'email-notify-drain' and command like '%x-app-cron%') then raise exception '调度命令必须携带定时密钥头'; end if;
end $$;
rollback;
