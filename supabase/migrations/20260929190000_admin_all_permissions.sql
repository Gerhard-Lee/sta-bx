-- Admin is a super-admin role for operational workflows.
-- Ownership checks remain in place so an admin cannot approve their own request.
create or replace function private.app_user_has_role(p_user_id uuid, p_role text)
returns boolean
language sql stable security definer set search_path = public, private, pg_temp
as $$
  select private.app_user_active(p_user_id)
     and exists(
       select 1
       from public.user_roles
       where user_id = p_user_id
         and (role = p_role or role = 'admin')
     );
$$;
