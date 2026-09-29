-- pgcrypto is installed in Supabase's extensions schema.
alter function public.app_create_user(text, text, text, text) set search_path = public, private, extensions, pg_temp;
alter function public.app_login(text, text) set search_path = public, private, extensions, pg_temp;
alter function public.app_change_password(uuid, text, text) set search_path = public, private, extensions, pg_temp;
