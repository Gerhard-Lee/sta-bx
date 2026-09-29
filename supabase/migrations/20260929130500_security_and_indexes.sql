-- Supabase creates explicit default EXECUTE grants for API roles in some projects.
-- Keep the trigger internal and expose workflow RPCs only to signed-in users.
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.claim_first_admin() from public, anon, authenticated;
revoke all on function public.submit_application(uuid, text) from public, anon, authenticated;
revoke all on function public.approve_application(uuid, text) from public, anon, authenticated;
revoke all on function public.return_application(uuid, text) from public, anon, authenticated;
revoke all on function public.reject_application(uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_application(uuid, text) from public, anon, authenticated;
revoke all on function public.add_application_file(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.submit_payment_info(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.record_payment(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.update_approval_threshold(numeric) from public, anon, authenticated;
revoke all on function public.set_member_roles(uuid, text[], boolean) from public, anon, authenticated;
grant execute on function public.claim_first_admin() to authenticated;
grant execute on function public.submit_application(uuid, text) to authenticated;
grant execute on function public.approve_application(uuid, text) to authenticated;
grant execute on function public.return_application(uuid, text) to authenticated;
grant execute on function public.reject_application(uuid, text) to authenticated;
grant execute on function public.cancel_application(uuid, text) to authenticated;
grant execute on function public.add_application_file(uuid, text, text, text, text) to authenticated;
grant execute on function public.submit_payment_info(uuid, text, text, text, text) to authenticated;
grant execute on function public.record_payment(uuid, text, text, text, text) to authenticated;
grant execute on function public.update_approval_threshold(numeric) to authenticated;
grant execute on function public.set_member_roles(uuid, text[], boolean) to authenticated;

create index if not exists application_files_owner_idx on public.application_files(owner_id);
create index if not exists approval_actions_actor_idx on public.approval_actions(actor_id);
create index if not exists audit_logs_actor_idx on public.audit_logs(actor_id);
create index if not exists payments_actor_idx on public.payments(actor_id);
create index if not exists settings_updated_by_idx on public.settings(updated_by);
