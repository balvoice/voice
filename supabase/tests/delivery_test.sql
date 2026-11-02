\set ON_ERROR_STOP 1
-- Delivery functions (run after rls_test.sql on the same database).
create or replace function pg_temp.expect_fail(sql text, label text) returns text language plpgsql as $$
begin execute sql; return 'FAIL (allowed): ' || label;
exception when others then return 'ok  blocked: ' || label || ' — ' || left(sqlerrm, 60); end $$;

-- Act as the delivery system.
set role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

create temp table t as
  select workspace_id as ws from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000a';

-- Audience: 4 contacts in two overlapping groups, one opted out.
insert into public.contacts (workspace_id, phone, first_name) select ws, p, n from t,
  (values ('+233240000001','Ama'),('0240000002','Kofi'),('233240000003','Efua'),('+233240000004','Yaw')) v(p, n)
  on conflict do nothing;
insert into public.contact_groups (workspace_id, name) select ws, g from t, (values ('Choir'),('Ushers')) v(g);
insert into public.contact_group_members (workspace_id, group_id, contact_id)
  select t.ws, g.id, c.id from t, public.contact_groups g, public.contacts c
   where g.workspace_id = t.ws and c.workspace_id = t.ws
     and ((g.name = 'Choir' and c.first_name in ('Ama','Kofi','Efua')) or (g.name = 'Ushers' and c.first_name in ('Efua','Yaw')));
insert into public.opt_outs (workspace_id, phone) select ws, '0240000004' from t;   -- Yaw, different format

-- A weekly campaign due now (inserted by the service role, so a past start is allowed).
insert into public.campaigns (workspace_id, name, type, sender_name, message_type, tts_text, status, schedule_start,
  consent_confirmed, sender_identified, optout_included, retries, repeat_rule, repeat_until)
select ws, 'Choir weekly', 'church', 'Grace', 'tts', 'Hello {first_name|friend}, rehearsal tonight.', 'scheduled',
  now() - interval '1 minute', true, true, true, 1, 'weekly', (now() + interval '20 days')::date from t;
insert into public.campaign_groups (workspace_id, campaign_id, group_id)
  select c.workspace_id, c.id, g.id from public.campaigns c join public.contact_groups g on g.workspace_id = c.workspace_id
   where c.name = 'Choir weekly' and g.name in ('Choir', 'Ushers');
create temp table cid as select id from public.campaigns where name = 'Choir weekly';

select 'ok  claim picks due campaign: ' || count(*) || ' (expect 1), status ' || min(status) from public.claim_campaign_work(5);
select 'ok  second claim is empty: ' || count(*) || ' (expect 0)' from public.claim_campaign_work(5);
select 'ok  snapshot recipients: ' || public.snapshot_recipients((select id from cid)) || ' (expect 3: Efua deduplicated, Yaw opted out)';
select 'ok  snapshot is idempotent: ' || public.snapshot_recipients((select id from cid)) || ' (expect 3)';
select 'ok  first-attempt targets: ' || count(*) || ' (expect 3)' from public.dispatch_targets((select id from cid));

-- Results from attempt 1: Ama answered, Kofi missed, Esi busy.
insert into public.call_results (workspace_id, campaign_id, recipient_id, outcome, attempts)
select r.workspace_id, r.campaign_id, r.id,
       case r.first_name when 'Ama' then 'answered' when 'Kofi' then 'noanswer' else 'busy' end, 1
  from public.campaign_recipients r where r.campaign_id = (select id from cid);
select 'ok  retry targets: ' || string_agg(r.first_name, ',' order by r.first_name) || ' (expect Efua,Kofi)'
  from public.dispatch_targets((select id from cid)) d join public.campaign_recipients r on r.id = d.recipient_id;

-- Kofi opts out before the retry.
insert into public.opt_outs (workspace_id, phone) select ws, '+233240000002' from t;
select 'ok  retry skips new opt-out: ' || count(*) || ' (expect 1)' from public.dispatch_targets((select id from cid));

-- Finish run 1 → weekly repeat is scheduled as run 2.
select 'ok  finish run 1: ' || public.finish_campaign_run((select id from cid)) || ' (expect rescheduled)';
select 'ok  run 2 state: status ' || status || ', run ' || run_number || ', starts in ~' || round(extract(epoch from schedule_start - now()) / 86400) || ' days'
  from public.campaigns where id = (select id from cid);
select 'ok  events: ' || string_agg(message, ' | ' order by id) from public.campaign_events where campaign_id = (select id from cid);

-- Jump past the end date: the next finish completes the campaign.
update public.campaigns set status = 'running', repeat_until = (now() + interval '2 days')::date where id = (select id from cid);
select 'ok  finish last run: ' || public.finish_campaign_run((select id from cid)) || ' (expect completed)';
reset role;

-- A signed-in client must not be able to call the dispatcher functions.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select pg_temp.expect_fail($$select * from public.claim_campaign_work(5)$$, 'client claims campaigns');
select pg_temp.expect_fail($$select public.finish_campaign_run((select id from public.campaigns limit 1))$$, 'client finishes a run');
select 'ok  client can read dispatches table (own rows only): ' || count(*) from public.campaign_dispatches;
commit;
