-- 迁移后在事务中执行；不保留任何验证数据。
-- 未配置 pg_cron 参数时本验证只输出提示：定时消费可以改由控制台 Scheduled Functions 承担。
-- 另外无论有没有真实 pg_cron，都会用 private.app_schedule_email_cron 在 cron 桩（tests 的 PGlite 占位里有
-- cron.job + cron.schedule/unschedule）上验证任务名、周期、x-app-cron 头与 pg_net 超时都写对了——
-- 这几条断言放在"装了真扩展"的分支里会永远不执行，等于没验。
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
  end if;

  -- 真实 pg_cron 装不上时（托管项目常见），走上面的"跳过"分支；这里用私有登记函数在 cron 桩上验证 SQL 本身。
  result := private.app_schedule_email_cron('https://example.invalid/functions/v1/app-api', 'test-public-key', 'test-cron-secret', 140000);
  if result not like '已注册%' then raise exception '桩环境下应能登记成功，实际 %', result; end if;
  select count(*) into jobs from cron.job where jobname = 'email-notify-drain';
  if jobs <> 1 then raise exception '重复登记应只保留一条调度，实际 %', jobs; end if;
  if not exists(select 1 from cron.job where jobname = 'email-notify-drain' and schedule = '*/5 * * * *') then raise exception '调度周期应为每 5 分钟'; end if;
  if not exists(select 1 from cron.job where jobname = 'email-notify-drain' and command like '%x-app-cron%') then raise exception '调度命令必须携带定时密钥头'; end if;
  -- pg_net 的 timeout_milliseconds 现在真的生效（官方 default 2000 毫秒）：不显式传就会在几秒内掐断一轮消费。
  if not exists(select 1 from cron.job where jobname = 'email-notify-drain' and command like '%timeout_milliseconds := 140000%') then
    raise exception '调度命令必须显式传 pg_net 超时（默认 2000 毫秒会掐断一轮消费）';
  end if;

  -- 再登记一次：按任务名覆盖，仍然只有一条。
  result := private.app_schedule_email_cron('https://example.invalid/functions/v1/app-api', 'test-public-key', 'test-cron-secret', 140000);
  select count(*) into jobs from cron.job where jobname = 'email-notify-drain';
  if jobs <> 1 then raise exception '重复登记应只保留一条调度，实际 %', jobs; end if;

  -- 非法超时被拒（防止把 0 或负数写进调度命令）。
  begin
    perform private.app_schedule_email_cron('https://example.invalid/functions/v1/app-api', 'test-public-key', 'test-cron-secret', 0);
    raise exception '非法超时应被拒绝';
  exception when raise_exception then
    if sqlerrm not like '%pg_net 超时应在%' then raise; end if;
  end;
end $$;
rollback;
