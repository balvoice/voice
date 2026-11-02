-- Seed for integration.ts (run after rls_test.sql on the test database).
create role authenticator login noinherit;   -- skip if it exists
grant anon, authenticated, service_role to authenticator;
set role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
create temp table t as select workspace_id as ws from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000a';
insert into public.audio_files (workspace_id, storage_path, file_name, mime_type, size_bytes, duration_sec)
  select ws, ws::text || '/sunday.mp3', 'sunday.mp3', 'audio/mpeg', 2000, 42 from t;
insert into public.contact_groups (workspace_id, name) select ws, 'Integration group' from t;
insert into public.contacts (workspace_id, phone, first_name) select ws, p, n from t,
  (values ('+233550000001','Abena'),('0550000002','Kwesi'),('233550000003','Akua')) v(p, n);
insert into public.contact_group_members (workspace_id, group_id, contact_id)
  select t.ws, g.id, c.id from t, public.contact_groups g, public.contacts c
   where g.name = 'Integration group' and c.first_name in ('Abena','Kwesi','Akua') and c.workspace_id = t.ws;
insert into public.campaigns (workspace_id, name, type, sender_name, message_type, audio_file_id, status, schedule_start,
  window_start, window_end, consent_confirmed, sender_identified, optout_included, retries, retry_interval_min)
select ws, 'Integration run', 'church', 'Grace', 'audio', (select id from public.audio_files where file_name = 'sunday.mp3'),
  'scheduled', now() - interval '1 minute', '00:00', '23:59', true, true, true, 1, 15 from t;
insert into public.campaign_groups (workspace_id, campaign_id, group_id)
  select c.workspace_id, c.id, g.id from public.campaigns c, public.contact_groups g where c.name = 'Integration run' and g.name = 'Integration group';
