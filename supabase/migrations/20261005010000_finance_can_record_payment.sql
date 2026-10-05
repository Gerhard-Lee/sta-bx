-- 决策（2026-10-05，项目负责人）：付款登记不单独设身份，财委（finance）即拥有付款登记能力。
-- 仿照 20260929190000 的做法，只重定义 private.app_user_has_role 一个函数：
-- 请求 cashier（付款登记）校验时，拥有 finance 身份即通过；
-- 「普通管理员不代替流程身份、只有内置 admin 超管可跨身份」保持不变，五个工作流函数无需改动。
create or replace function private.app_user_has_role(p_user_id uuid, p_role text)
returns boolean
language sql stable security definer set search_path = public, private, pg_temp
as $$
  select private.app_user_active(p_user_id)
     and (
       exists(
         select 1
         from public.user_roles
         where user_id = p_user_id and role = p_role
       )
       or (
         p_role = 'cashier'
         and exists(
           select 1
           from public.user_roles
           where user_id = p_user_id and role = 'finance'
         )
       )
       or (
         p_role in ('finance', 'chair', 'cashier')
         and private.app_user_is_superadmin(p_user_id)
       )
     );
$$;
