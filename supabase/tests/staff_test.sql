-- Tests for 20261101120000_internal_staff.sql. Every output line should start with "ok".
-- Runs on plain PostgreSQL (psql -f) or PGlite (supabase/tests/run-pglite.mjs); no psql meta-commands.

create or replace function pg_temp.expect_fail(sql text, label text) returns text language plpgsql as $$
begin
  execute sql;
  return 'FAIL (allowed): ' || label;
exception when others then
  return 'ok  blocked: ' || label || ' — ' || left(sqlerrm, 70);
end $$;
create or replace function pg_temp.expect_ok(sql text, label text) returns text language plpgsql as $$
begin
  execute sql;
  return 'ok  ' || label;
exception when others then
  return 'FAIL ' || label || ' — ' || left(sqlerrm, 70);
end $$;
create or replace function pg_temp.check(cond boolean, label text) returns text language sql as $$
  select case when cond then 'ok  ' else 'FAIL ' end || label
$$;
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"' || uid || '","role":"authenticated"}', true)
$$;

-- Users: admin (a), operator (o), a stranger who somehow signed in (x).
insert into auth.users (id, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-00000000000a', 'admin@balvoice.test', '{"full_name":"Ama Admin"}'),
 ('00000000-0000-0000-0000-00000000000b', 'op@balvoice.test', '{"full_name":"Kofi Operator"}'),
 ('00000000-0000-0000-0000-00000000000c', 'stranger@example.org', '{}');
select pg_temp.check((select count(*) from public.profiles) = 3, 'profiles created, no workspaces: ' || (select count(*) from public.workspaces));
insert into public.staff (user_id, role, created_by) values
 ('00000000-0000-0000-0000-00000000000a', 'admin', null),
 ('00000000-0000-0000-0000-00000000000b', 'operator', null);

-- Stranger -------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect_fail($$insert into public.workspaces (name) values ('Sneaky client')$$, 'non-staff creates a client');
select pg_temp.check((select count(*) from public.staff) = 0, 'non-staff sees no staff rows');
commit;

-- Clients and assignments ------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect_fail($$insert into public.workspaces (name) values ('Operator client')$$, 'operator adds a client');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into public.workspaces (name, contact_name, contact_phone) values ('Grace Chapel', 'Rev. Mensah', '+233244000001');
insert into public.workspaces (name) values ('Civic Forum');
select pg_temp.expect_ok($$insert into public.workspaces (name) values ('Returned client') returning name$$, 'admin adds a client and gets it back (insert … returning)');
delete from public.workspaces where name = 'Returned client';
insert into public.client_assignments (workspace_id, user_id)
  select id, '00000000-0000-0000-0000-00000000000b' from public.workspaces where name = 'Grace Chapel';
select pg_temp.check((select count(*) from public.workspaces) = 2, 'admin creates clients and sees both');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select string_agg(name, ',') from public.workspaces) = 'Grace Chapel', 'operator sees only the assigned client');
select pg_temp.expect_fail($$insert into public.client_assignments (workspace_id, user_id) select id, '00000000-0000-0000-0000-00000000000b' from public.workspaces$$, 'operator assigns themself a client');
commit;

-- Delete by an operator removes nothing (RLS), checked by row count.
begin;
set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
with d as (delete from public.workspaces returning 1) select pg_temp.check(count(*) = 0, 'operator cannot delete clients (0 rows)') from d;
-- Contacts: phone normalisation + bulk upsert
insert into public.contacts (workspace_id, phone, first_name)
  select id, '0244 123 456', 'Esi' from public.workspaces where name = 'Grace Chapel';
select pg_temp.check((select phone from public.contacts limit 1) = '+233244123456', 'local number normalised to +233244123456');
select pg_temp.check((select count(*) from public.upsert_contacts(
  (select id from public.workspaces where name = 'Grace Chapel'),
  '[{"client_id":"c1","phone":"233244123456","last_name":"Owusu"},
    {"client_id":"c2","phone":"244000002","first_name":"Yaw"},
    {"client_id":"c3","phone":"+233244000003"},
    {"client_id":"c4","phone":"+233244000004"},
    {"client_id":"bad","phone":"12"}]'::jsonb)) = 4, 'upsert_contacts returns 4 valid rows, drops invalid');
select pg_temp.check((select count(*) from public.contacts) = 4, 'no duplicate for 233244123456 (now 4 contacts)');
select pg_temp.check((select first_name || ' ' || last_name from public.contacts where phone = '+233244123456') = 'Esi Owusu', 'existing contact filled in, not overwritten');
insert into public.contact_groups (workspace_id, name) select id, 'Members' from public.workspaces where name = 'Grace Chapel';
insert into public.contact_group_members (workspace_id, group_id, contact_id)
  select g.workspace_id, g.id, c.id from public.contact_groups g join public.contacts c on c.workspace_id = g.workspace_id;
insert into public.opt_outs (workspace_id, phone) select id, '0244000004' from public.workspaces where name = 'Grace Chapel';
select pg_temp.expect_fail($$insert into public.caller_ids (workspace_id, type, value, status) select id, 'brand', 'GRACE', 'approved' from public.workspaces where name = 'Grace Chapel'$$, 'operator self-approves caller ID');
insert into public.caller_ids (workspace_id, type, value) select id, 'brand', 'GRACE' from public.workspaces where name = 'Grace Chapel';
with u as (update public.caller_ids set status = 'approved' returning 1) select pg_temp.check(count(*) = 0, 'operator cannot approve by update (0 rows)') from u;
select pg_temp.expect_fail($$insert into public.campaigns (workspace_id, name, type, sender_name, message_type, tts_text, status, schedule_start, consent_confirmed, sender_identified, optout_included) select id, 'No basis', 'church', 'Grace', 'tts', 'Hello there friend', 'scheduled', now() + interval '1 day', true, true, true from public.workspaces where name = 'Grace Chapel'$$, 'schedule without a consent basis');
insert into public.campaigns (workspace_id, name, type, sender_name, message_type, tts_text, status, schedule_start,
                              consent_confirmed, sender_identified, optout_included, consent_basis, window_start, window_end, retries, repeat_rule, repeat_until)
  select id, 'Sunday reminder', 'church', 'Grace Chapel', 'tts', 'Hello {first_name|friend}, see you Sunday.', 'scheduled', now() + interval '1 hour',
         true, true, true, 'Members signed the church contact form', '00:00', '23:59', 1, 'weekly', (now() + interval '30 days')::date
    from public.workspaces where name = 'Grace Chapel';
insert into public.campaign_groups (workspace_id, campaign_id, group_id) select c.workspace_id, c.id, g.id from public.campaigns c, public.contact_groups g;
select pg_temp.check((select compliance_confirmed_by::text from public.campaigns) = '00000000-0000-0000-0000-00000000000b', 'compliance confirmation stamped with the operator');
select public.campaign_start_now((select id from public.campaigns));
select pg_temp.expect_fail($$select public.dialer_start_due()$$, 'operator calls dialer functions');
select pg_temp.expect_fail($$select public.rate_limit_hit('x','y',1,60)$$, 'operator calls rate limiter');
select pg_temp.expect_fail($$update public.campaigns set status = 'running'$$, 'operator sets running');
select pg_temp.check((select count(*) from public.audit_log) = 0, 'operator cannot read the audit log');
commit;

-- Admin ---------------------------------------------------------------------------
begin;
set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
update public.caller_ids set status = 'approved';
select pg_temp.check((select reviewed_by::text from public.caller_ids) = '00000000-0000-0000-0000-00000000000a', 'admin approves caller ID; reviewer recorded');
select pg_temp.check((select count(*) from public.audit_log) > 0, 'admin reads audit log: ' || (select count(*) from public.audit_log) || ' entries');
select pg_temp.expect_fail($$update public.staff set role = 'operator' where user_id = '00000000-0000-0000-0000-00000000000a'$$, 'last admin demotes themself');
insert into public.global_opt_outs (phone, source) values ('0244000003', 'Website request');
commit;

-- Delivery system (service role) ---------------------------------------------------
begin;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.check(public.dialer_start_due() = 1, 'dialer starts the due campaign');
select pg_temp.check((select status from public.campaigns) = 'running', 'campaign is running');
select pg_temp.check((select count(*) from public.campaign_recipients where status = 'skipped') = 2, 'client + global opt-outs skipped at start (2)');
create temp table t_claim as select * from public.dialer_claim(10, 300);
select pg_temp.check((select count(*) from t_claim) = 2, 'claimed 2 calls');
select pg_temp.check((select count(*) from public.dialer_claim(10, 300)) = 0, 'nothing double-claimed');
select public.dialer_mark_sent(recipient_id, 'call-' || recipient_id) from t_claim;
select pg_temp.check(public.dialer_report((select min(recipient_id) from t_claim), 'answered', 42, 'call-' || (select min(recipient_id) from t_claim)) = 'final', 'answered is final');
select pg_temp.check(public.dialer_report((select min(recipient_id) from t_claim), 'answered', 42) = 'ignored', 'duplicate report ignored');
select pg_temp.check(public.dialer_report((select max(recipient_id) from t_claim), 'busy', null) = 'retry', 'busy on attempt 1 of 2 is retried');
update public.campaign_recipients set next_attempt_at = now() where status = 'queued';
select pg_temp.check((select attempt from public.dialer_claim(10, 300)) = 2, 'retry claimed as attempt 2');
select pg_temp.check(public.dialer_report((select max(recipient_id) from t_claim), 'noanswer', null, null, true) = 'final', 'last attempt final; keypress opt-out');
select pg_temp.check((select count(*) from public.opt_outs where source = 'During call') = 1, 'keypress opt-out added to the client register');
select pg_temp.check(public.dialer_finish() = 1, 'run finished');
select pg_temp.check((select status || ' run ' || run_number from public.campaigns) = 'scheduled run 2', 'weekly campaign rescheduled as run 2');
select pg_temp.check((select answered || '/' || recipients || ' skipped ' || skipped from public.campaign_run_stats where run_number = 1) = '1/2 skipped 2', 'run stats: 1 answered of 2, 2 skipped');
commit;

begin;
set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into public.workspace_settings (workspace_id, airtime_rate) select id, 0.15 from public.workspaces where name = 'Grace Chapel';
select pg_temp.check((select airtime_cost from public.campaign_costs) = 0.11, 'cost: 42 s × 0.15/min = 0.11');
select pg_temp.check((select billable_minutes from public.client_monthly_costs) = 0.70, 'monthly billable minutes 0.70');
commit;

-- Website requests and rate limits (service role) ------------------------------------
begin;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.check(public.rate_limit_hit('form', 'ip1', 2, 3600) and public.rate_limit_hit('form', 'ip1', 2, 3600) and not public.rate_limit_hit('form', 'ip1', 2, 3600), 'rate limit allows 2 then blocks');
insert into public.campaign_requests (organization, contact_name, email, phone, campaign_type, list_size, consent_contacts_at, consent_optout_at)
  values ('Hope Church', 'Abena', 'abena@example.org', '0201234567', 'church', 'under-1000', now(), now());
commit;
begin;
set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect_fail($$insert into public.campaign_requests (organization, contact_name, email, phone, campaign_type, list_size, consent_contacts_at, consent_optout_at) values ('X org', 'Xx', 'x@example.org', '0201234567', 'church', 'unsure', now(), now())$$, 'staff insert requests directly');
with u as (update public.campaign_requests set status = 'declined' returning 1) select pg_temp.check(count(*) = 0, 'operator cannot see or handle website requests') from u;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
update public.campaign_requests set status = 'contacted';
select pg_temp.check((select handled_by::text || ' ' || phone || ' ' || status from public.campaign_requests) = '00000000-0000-0000-0000-00000000000a +233201234567 contacted', 'admin handles the request; phone normalised');
commit;

-- Isolation between clients --------------------------------------------------------------
begin;
insert into public.contacts (workspace_id, phone, first_name) select id, '0277000001', 'Civic member' from public.workspaces where name = 'Civic Forum';
create temp table t_civic as select id from public.workspaces where name = 'Civic Forum';
grant select on t_civic to authenticated;
commit;
begin;
set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from public.contacts where first_name = 'Civic member') = 0, 'operator cannot see contacts of an unassigned client');
select pg_temp.expect_fail($$insert into public.contacts (workspace_id, phone) values ((select id from t_civic), '0244999998')$$, 'operator writes into an unassigned client (knowing its id)');
with u as (update public.workspaces set notes = 'x' where id = (select id from t_civic) returning 1) select pg_temp.check(count(*) = 0, 'operator cannot edit an unassigned client') from u;
commit;

-- Campaign-level dispatcher (BMS pipeline) writing results directly -------------------------
begin;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('balvoice.trusted', 'on', true);
insert into public.campaigns (id, workspace_id, name, type, sender_name, message_type, tts_text, status, schedule_start, consent_confirmed, sender_identified, optout_included, consent_basis)
  select '44444444-4444-4444-4444-444444444444', id, 'Bulk send', 'church', 'Grace', 'tts', 'Hello everyone, see you', 'running', now(), true, true, true, 'Membership form'
    from public.workspaces where name = 'Grace Chapel';
insert into public.campaign_recipients (workspace_id, campaign_id, phone)
  select workspace_id, '44444444-4444-4444-4444-444444444444', p from public.campaigns, unnest(array['+233200000101', '+233200000102', '+233200000103']) p
   where id = '44444444-4444-4444-4444-444444444444';
insert into public.call_results (workspace_id, campaign_id, recipient_id, outcome, duration_sec)
  select workspace_id, campaign_id, id, case when phone like '%101' then 'answered' else 'busy' end, case when phone like '%101' then 20 end
    from public.campaign_recipients where campaign_id = '44444444-4444-4444-4444-444444444444' and phone <> '+233200000103';
select pg_temp.check((select done || '/' || answered || ' pending ' || pending from public.campaign_run_stats where campaign_id = '44444444-4444-4444-4444-444444444444') = '1/1 pending 2', 'dispatcher: answered call counted at once, others pending');
update public.campaigns set status = 'completed' where id = '44444444-4444-4444-4444-444444444444';
select pg_temp.check((select done || ' busy ' || busy || ' pending ' || pending from public.campaign_run_stats where campaign_id = '44444444-4444-4444-4444-444444444444') = '2 busy 1 pending 1', 'dispatcher: run end finalises outcomes; never-called number stays pending');
commit;
