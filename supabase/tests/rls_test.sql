\set ON_ERROR_STOP 1
-- Two users sign up (triggers create profile + workspace + owner membership).
insert into auth.users (id, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-00000000000a', 'a@example.org', '{"full_name":"Ama Mensah","organization":"Grace Chapel"}'),
 ('00000000-0000-0000-0000-00000000000b', null, '{"full_name":"Kofi B"}');
update auth.users set phone = '233241234567' where id = '00000000-0000-0000-0000-00000000000b';
select p.full_name, p.organization, p.phone, w.name as workspace, m.role
  from public.profiles p join public.workspace_members m on m.user_id = p.id join public.workspaces w on w.id = m.workspace_id order by 1;

create temp table t_ws as select user_id, workspace_id from public.workspace_members;
grant select on t_ws to authenticated;

create or replace function pg_temp.expect_fail(sql text, label text) returns text language plpgsql as $$
begin
  execute sql;
  return 'FAIL (allowed): ' || label;
exception when others then
  return 'ok  blocked: ' || label || ' — ' || left(sqlerrm, 70);
end $$;

-- Act as user A.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
\set wsA '(select workspace_id from t_ws where user_id = ''00000000-0000-0000-0000-00000000000a'')'
\set wsB '(select workspace_id from t_ws where user_id = ''00000000-0000-0000-0000-00000000000b'')'
insert into public.contacts (workspace_id, phone, first_name) values (:wsA, '+233200000001', 'Esi');
insert into public.contact_groups (workspace_id, name) values (:wsA, 'Members');
insert into public.contact_group_members (workspace_id, group_id, contact_id)
  select :wsA, g.id, c.id from public.contact_groups g, public.contacts c;
select 'ok  A sees own contacts: ' || count(*) from public.contacts;
select 'ok  A sees workspaces: ' || count(*) || ' (expect 1)' from public.workspaces;
select pg_temp.expect_fail($$insert into public.contacts (workspace_id, phone) values ((select workspace_id from t_ws where user_id='00000000-0000-0000-0000-00000000000b'), '+233200000002')$$, 'A writes into B workspace');
select pg_temp.expect_fail($$insert into public.caller_ids (workspace_id, type, value, status) values ((select workspace_id from t_ws where user_id='00000000-0000-0000-0000-00000000000a'), 'brand', 'GRACE', 'approved')$$, 'A self-approves caller ID');
insert into public.caller_ids (workspace_id, type, value) values (:wsA, 'brand', 'GRACE');
with u as (update public.caller_ids set status='approved' returning 1) select case when count(*)=0 then 'ok  blocked: A approves caller ID by update (0 rows changed)' else 'FAIL' end from u;
select 'ok  caller ID status still: ' || status from public.caller_ids;
select pg_temp.expect_fail($$insert into public.campaigns (workspace_id, name, type, sender_name, message_type, tts_text, status, schedule_start) values ((select workspace_id from t_ws where user_id='00000000-0000-0000-0000-00000000000a'), 'Test', 'church', 'Grace', 'tts', 'Hello there friend', 'scheduled', now() + interval '1 day')$$, 'schedule without compliance confirmations');
select pg_temp.expect_fail($$insert into public.campaigns (workspace_id, name, type, sender_name, message_type, tts_text, status, schedule_start, consent_confirmed, sender_identified, optout_included) values ((select workspace_id from t_ws where user_id='00000000-0000-0000-0000-00000000000a'), 'Test', 'church', 'Grace', 'tts', 'Hello there friend', 'running', now() + interval '1 day', true, true, true)$$, 'client sets status running');
select pg_temp.expect_fail($$insert into public.campaigns (workspace_id, name, type, sender_name, message_type, tts_text, status, schedule_start, consent_confirmed, sender_identified, optout_included, caller_id) values ((select workspace_id from t_ws where user_id='00000000-0000-0000-0000-00000000000a'), 'Test', 'church', 'Grace', 'tts', 'Hello there friend', 'scheduled', now() + interval '1 day', true, true, true, (select id from public.caller_ids limit 1))$$, 'uses unapproved caller ID');
insert into public.campaigns (workspace_id, name, type, sender_name, message_type, tts_text, status, schedule_start, consent_confirmed, sender_identified, optout_included)
  values (:wsA, 'Sunday reminder', 'church', 'Grace', 'tts', 'Hello {first_name|friend}, see you Sunday.', 'scheduled', now() + interval '1 day', true, true, true);
select 'ok  A scheduled a compliant campaign: ' || count(*) from public.campaigns where status = 'scheduled';
select pg_temp.expect_fail($$insert into public.call_results (workspace_id, campaign_id, recipient_id, outcome) values ((select workspace_id from t_ws where user_id='00000000-0000-0000-0000-00000000000a'), (select id from public.campaigns limit 1), 1, 'answered')$$, 'client writes call results');
select pg_temp.expect_fail($$select count(*) from public.sms_otp_log$$, 'client reads sms_otp_log');
select 'ok  A creates API key: ' || left(public.create_api_key(:wsA, 'Server'), 12) || '…';
select 'ok  stored as hash only: ' || (select count(*) from public.api_keys where key_hash ~ '^[0-9a-f]{64}$');
select pg_temp.expect_fail($$select public.create_api_key((select workspace_id from t_ws where user_id='00000000-0000-0000-0000-00000000000b'))$$, 'A creates API key for B');
insert into storage.objects (bucket_id, name) values ('campaign-audio', (:wsA)::text || '/msg.mp3');
select pg_temp.expect_fail($$insert into storage.objects (bucket_id, name) values ('campaign-audio', (select workspace_id from t_ws where user_id='00000000-0000-0000-0000-00000000000b')::text || '/x.mp3')$$, 'A uploads audio into B folder');
select pg_temp.expect_fail($$insert into storage.objects (bucket_id, name) values ('campaign-audio', 'not-a-uuid/x.mp3')$$, 'upload to malformed path');
with u as (update public.workspace_members set role = 'member' returning 1) select case when count(*)=0 then 'ok  blocked: A demotes the owner row (0 rows changed)' else 'FAIL' end from u;
insert into public.opt_outs (workspace_id, phone) values (:wsA, '+233200000009');
commit;

-- Act as user B: must see nothing of A.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select 'ok  B sees A contacts: ' || count(*) || ' (expect 0)' from public.contacts;
select 'ok  B sees A campaigns: ' || count(*) || ' (expect 0)' from public.campaigns;
select 'ok  B sees profiles: ' || count(*) || ' (expect 1, own)' from public.profiles;
select 'ok  B sees A audio objects: ' || count(*) || ' (expect 0)' from storage.objects;
with d as (delete from public.opt_outs returning 1) select 'ok  B deletes A opt-outs: ' || count(*) || ' rows affected (expect 0)' from d;
commit;

-- Anonymous visitor.
begin;
set local role anon;
select pg_temp.expect_fail($$select count(*) from public.contacts$$, 'anon reads contacts');
commit;

-- Delivery system (service role) can approve caller IDs and run campaigns.
begin;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.caller_ids set status = 'approved', reviewed_at = now();
update public.campaigns set status = 'running';
select 'ok  service role: caller ID ' || (select status from public.caller_ids) || ', campaign ' || (select status from public.campaigns);
commit;
