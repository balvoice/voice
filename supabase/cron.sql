-- BalVoice — schedule the delivery functions with pg_cron + pg_net.
-- Run once in the Supabase SQL editor AFTER deploying the functions.
-- 1. Database → Extensions: enable pg_cron and pg_net.
-- 2. Generate a long random secret (e.g. `openssl rand -hex 32`) and set it as the
--    CRON_SECRET Edge Function secret:  supabase secrets set CRON_SECRET=...
-- 3. Store the project URL and the same secret in Vault, then create the jobs below.

select vault.create_secret('https://urujipwfqflcjrmgqowl.supabase.co', 'project_url');
select vault.create_secret('3b565f18997672e79333f45b7afe10d53888efa45018754e4540191b63362154', 'cron_secret');

-- Send due campaigns every minute.
select cron.schedule(
  'balvoice-dispatch-campaigns', '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/dispatch-campaigns',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
  $$
);

-- Pull call results, schedule retries, and finish runs every 2 minutes.
select cron.schedule(
  'balvoice-sync-reports', '*/2 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sync-reports',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
  $$
);

-- Check the jobs:   select * from cron.job;
-- Recent runs:      select * from cron.job_run_details order by start_time desc limit 20;
-- Pause delivery:   select cron.unschedule('balvoice-dispatch-campaigns');
