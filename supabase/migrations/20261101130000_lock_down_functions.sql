-- BalVoice — restrict who can call helper functions through the API
-- (flagged by the Supabase security advisor on 1 Nov 2026).
-- Trigger functions and internal helpers are never called through the API.
-- (Postgres does not check EXECUTE when firing triggers, so the triggers keep working.)
revoke execute on function public.audit_bulk()                  from public, anon, authenticated;
revoke execute on function public.audit_row()                   from public, anon, authenticated;
revoke execute on function public.handle_new_user()             from public, anon, authenticated;
revoke execute on function public.sync_profile_contact()        from public, anon, authenticated;
revoke execute on function public.recipient_done_on_answer()    from public, anon, authenticated;
revoke execute on function public.recipients_done_on_run_end()  from public, anon, authenticated;
revoke execute on function public.is_opted_out(uuid, text)      from public, anon, authenticated;
grant  execute on function public.is_opted_out(uuid, text)      to service_role;

-- Access checks used by Row Level Security: signed-in staff only, never anonymous visitors.
revoke execute on function public.is_staff()                                   from public, anon;
revoke execute on function public.is_admin()                                   from public, anon;
revoke execute on function public.is_member(uuid)                              from public, anon;
revoke execute on function public.has_role(uuid, public.workspace_role[])     from public, anon;
revoke execute on function public.can_access_workspace_path(text)              from public, anon;
grant  execute on function public.is_staff(), public.is_admin(), public.is_member(uuid),
                           public.has_role(uuid, public.workspace_role[]), public.can_access_workspace_path(text) to authenticated, service_role;