-- BalVoice — campaign delivery through BMS
-- ---------------------------------------------------------------------------
-- Adds what the dispatch-campaigns and sync-reports Edge Functions need:
--   * campaign_dispatches  one row per send to BMS (a campaign run can have several:
--                          first attempt, retries, and chunks of large lists)
--   * delivery state on campaigns (attempt_number, next_attempt_at, last_error)
--   * BMS ids on audio files and call results
--   * SQL functions used only by the service role:
--       claim_campaign_work()   pick due campaigns without double-sending
--       snapshot_recipients()   freeze who is called in this run (groups minus opt-outs)
--       dispatch_targets()      who still needs a call (not answered, not opted out)
--       finish_campaign_run()   complete the run, or schedule the next repeat
-- ---------------------------------------------------------------------------

alter table public.audio_files add column bms_voice_id text;

alter table public.campaigns
  add column attempt_number  smallint not null default 0 check (attempt_number between 0 and 4),
  add column next_attempt_at timestamptz,
  add column last_error      text check (char_length(last_error) <= 300);
create index campaigns_next_attempt_idx on public.campaigns (next_attempt_at) where status = 'running';

create table public.campaign_dispatches (
  id                   bigint generated always as identity primary key,
  workspace_id         uuid not null,
  campaign_id          uuid not null,
  run_number           integer not null,
  attempt              smallint not null check (attempt between 1 and 4),
  provider             text not null default 'bms',
  provider_campaign_id text,                         -- BMS "_id", used to poll /calls/<id>
  recipient_ids        bigint[] not null,            -- campaign_recipients targeted by this send
  total_rejected       integer not null default 0,
  credit_used          numeric(12, 2) not null default 0,
  status               text not null default 'sent' check (status in ('sent', 'final', 'failed')),
  error                text check (char_length(error) <= 300),
  created_at           timestamptz not null default now(),
  last_synced_at       timestamptz,
  final_at             timestamptz,
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade
);
create index campaign_dispatches_open_idx on public.campaign_dispatches (created_at) where status = 'sent';
create index campaign_dispatches_campaign_idx on public.campaign_dispatches (campaign_id, run_number);

alter table public.call_results
  add column dispatch_id      bigint references public.campaign_dispatches (id) on delete set null,
  add column provider_call_id text,
  add column raw_status       text check (char_length(raw_status) <= 40);

alter table public.campaign_dispatches enable row level security;
create policy "members read dispatches" on public.campaign_dispatches for select to authenticated
  using (public.is_member(workspace_id));

-- Recipients for "upload a file" campaigns are written by the dashboard before the
-- campaign starts. Group campaigns are snapshotted by the dispatcher.
create policy "members add recipients before start" on public.campaign_recipients for insert to authenticated
  with check (
    public.is_member(workspace_id)
    and exists (select 1 from public.campaigns c
                where c.id = campaign_id and c.workspace_id = campaign_recipients.workspace_id
                  and c.status in ('draft', 'scheduled') and c.run_number = campaign_recipients.run_number)
  );

-- Phone comparison helper: last 9 digits identify a subscriber whatever the format.
create or replace function public.phone_key(p text)
returns text language sql immutable set search_path = '' as $$
  select right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 9)
$$;
create index contacts_phone_key_idx on public.contacts (workspace_id, public.phone_key(phone));
create index opt_outs_phone_key_idx on public.opt_outs (workspace_id, public.phone_key(phone));

-- 1. Claim work --------------------------------------------------------------------
-- Returns campaigns that are due: newly scheduled ones (moved to running) and running
-- ones whose next attempt time has come. Claiming sets a 15-minute lease in
-- next_attempt_at: overlapping dispatcher runs never pick the same campaign twice,
-- the report syncer leaves it alone while it is being sent, and if a dispatcher run
-- crashes the campaign is picked up again when the lease expires.
create or replace function public.claim_campaign_work(max_count integer default 5)
returns setof public.campaigns language plpgsql security definer set search_path = '' as $$
begin
  return query
  with picked as (
    select id from public.campaigns
    where (status = 'scheduled' and schedule_start <= now())
       or (status = 'running' and next_attempt_at is not null and next_attempt_at <= now())
    order by coalesce(next_attempt_at, schedule_start)
    limit greatest(1, least(max_count, 50))
    for update skip locked
  )
  update public.campaigns c
     set status = 'running',
         attempt_number = case when c.status = 'scheduled' then 0 else c.attempt_number end,
         next_attempt_at = now() + interval '15 minutes',
         last_error = case when c.status = 'scheduled' then null else c.last_error end
    from picked
   where c.id = picked.id
  returning c.*;
end $$;

-- 2. Snapshot recipients ------------------------------------------------------------
-- Adds everyone in the campaign's groups (deduplicated) to this run, then removes
-- anyone on the opt-out register. For repeating file-based campaigns, the previous
-- run's list is carried forward. Returns the number of recipients in the run.
create or replace function public.snapshot_recipients(cid uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  c public.campaigns;
  n integer;
begin
  select * into c from public.campaigns where id = cid;
  if not found then raise exception 'campaign not found'; end if;

  if exists (select 1 from public.campaign_groups where campaign_id = cid) then
    insert into public.campaign_recipients (workspace_id, campaign_id, run_number, phone, first_name, last_name, company)
    select distinct on (public.phone_key(ct.phone))
           c.workspace_id, c.id, c.run_number, ct.phone, ct.first_name, ct.last_name, ct.company
      from public.campaign_groups cg
      join public.contact_group_members m on m.group_id = cg.group_id
      join public.contacts ct on ct.id = m.contact_id
     where cg.campaign_id = cid
     order by public.phone_key(ct.phone), ct.created_at
    on conflict (campaign_id, run_number, phone) do nothing;
  elsif c.run_number > 1 then
    insert into public.campaign_recipients (workspace_id, campaign_id, run_number, phone, first_name, last_name, company)
    select workspace_id, campaign_id, c.run_number, phone, first_name, last_name, company
      from public.campaign_recipients
     where campaign_id = cid and run_number = c.run_number - 1
    on conflict (campaign_id, run_number, phone) do nothing;
  end if;

  -- Opt-outs win, including numbers added to the register after the campaign was created.
  delete from public.campaign_recipients r
   using public.opt_outs o
   where r.campaign_id = cid and r.run_number = c.run_number
     and o.workspace_id = c.workspace_id and public.phone_key(o.phone) = public.phone_key(r.phone)
     and not exists (select 1 from public.call_results cr where cr.recipient_id = r.id);

  select count(*) into n from public.campaign_recipients where campaign_id = cid and run_number = c.run_number;
  return n;
end $$;

-- 3. Who to call now ------------------------------------------------------------------
-- Everyone in the current run who has not answered yet and is not opted out.
-- On the first attempt that is the whole list; on retries, only the unanswered.
create or replace function public.dispatch_targets(cid uuid)
returns table (recipient_id bigint, phone text) language sql stable security definer set search_path = '' as $$
  select r.id, r.phone
    from public.campaign_recipients r
    join public.campaigns c on c.id = r.campaign_id and r.run_number = c.run_number
    left join public.call_results cr on cr.recipient_id = r.id
   where r.campaign_id = cid
     and (cr.id is null or cr.outcome <> 'answered')
     and not exists (select 1 from public.opt_outs o
                     where o.workspace_id = c.workspace_id and public.phone_key(o.phone) = public.phone_key(r.phone))
   order by r.id
$$;

-- 4. Finish a run -----------------------------------------------------------------------
-- Writes the summary event and either completes the campaign or schedules its next
-- repeat (daily/weekly/monthly, until repeat_until). Returns 'completed' or 'rescheduled'.
create or replace function public.finish_campaign_run(cid uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  c public.campaigns;
  answered integer;
  total integer;
  step interval;
  nxt timestamptz;
begin
  select * into c from public.campaigns where id = cid for update;
  if not found or c.status <> 'running' then return 'skipped'; end if;

  select count(*) filter (where cr.outcome = 'answered'), count(*)
    into answered, total
    from public.campaign_recipients r
    left join public.call_results cr on cr.recipient_id = r.id
   where r.campaign_id = cid and r.run_number = c.run_number;

  insert into public.campaign_events (workspace_id, campaign_id, message, created_by)
  values (c.workspace_id, cid, format('Run %s completed: %s of %s answered', c.run_number, answered, total), null);

  step := case c.repeat_rule when 'daily' then interval '1 day' when 'weekly' then interval '7 days'
                             when 'monthly' then interval '1 month' end;
  if step is not null and c.repeat_until is not null then
    nxt := c.schedule_start + step;
    while nxt <= now() loop nxt := nxt + step; end loop;
    if (nxt at time zone c.timezone)::date <= c.repeat_until then
      update public.campaigns
         set status = 'scheduled', run_number = run_number + 1, attempt_number = 0,
             schedule_start = nxt, next_attempt_at = null, last_error = null
       where id = cid;
      insert into public.campaign_events (workspace_id, campaign_id, message, created_by)
      values (c.workspace_id, cid, format('Next run scheduled for %s', to_char(nxt at time zone c.timezone, 'DD Mon YYYY HH24:MI')), null);
      return 'rescheduled';
    end if;
  end if;

  update public.campaigns set status = 'completed', next_attempt_at = null where id = cid;
  return 'completed';
end $$;

-- These functions bypass RLS, so only the service role may call them.
revoke execute on function public.claim_campaign_work(integer) from public, anon, authenticated;
revoke execute on function public.snapshot_recipients(uuid)     from public, anon, authenticated;
revoke execute on function public.dispatch_targets(uuid)        from public, anon, authenticated;
revoke execute on function public.finish_campaign_run(uuid)     from public, anon, authenticated;
grant execute on function public.claim_campaign_work(integer) to service_role;
grant execute on function public.snapshot_recipients(uuid)     to service_role;
grant execute on function public.dispatch_targets(uuid)        to service_role;
grant execute on function public.finish_campaign_run(uuid)     to service_role;
