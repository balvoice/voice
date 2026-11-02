-- BalVoice — internal staff model, delivery queue, compliance records, audit log
-- ---------------------------------------------------------------------------
-- BalVoice is used only by its own staff. This migration changes the
-- self-service model in 20261031000000_init.sql into an internal one:
--
--   * Accounts are staff only. Nobody can sign up; admins invite staff.
--     Every active staff member can work on every client.
--   * A "workspace" is now a CLIENT (a church, campaign team or organization
--     BalVoice runs campaigns for). The table keeps its name so the existing
--     foreign keys and policies stay valid.
--   * Roles: admin (manages staff, clients, caller IDs, opt-out removals,
--     reads the audit log) and operator (runs campaigns).
--   * Phone numbers are normalised to E.164 in the database (+233 default).
--   * A global opt-out register applies to every client (website requests).
--   * Delivery queue + dialer functions (provider-neutral), cost views,
--     website request storage with rate limits, and an audit log.
--
-- Written for a fresh project (no production data yet).
-- ---------------------------------------------------------------------------

-- 1. Staff -------------------------------------------------------------------

create type public.staff_role as enum ('admin', 'operator');

create table public.staff (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       public.staff_role not null default 'operator',
  active     boolean not null default true,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger staff_updated_at before update on public.staff
  for each row execute function public.set_updated_at();

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff s where s.user_id = (select auth.uid()) and s.active)
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff s where s.user_id = (select auth.uid()) and s.active and s.role = 'admin')
$$;

-- There must always be at least one active admin.
create or replace function public.staff_keep_an_admin()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.role = 'admin' and old.active
     and (tg_op = 'DELETE' or new.role <> 'admin' or not new.active)
     and not exists (select 1 from public.staff s where s.user_id <> old.user_id and s.role = 'admin' and s.active) then
    raise exception 'at least one active admin is required' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;
create trigger staff_keep_an_admin before update or delete on public.staff
  for each row execute function public.staff_keep_an_admin();

-- 2. Membership checks now mean "active staff" ---------------------------------
-- Every existing policy calls is_member()/has_role(), so redefining them moves
-- all tables to the staff model at once.

create or replace function public.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_staff() and exists (select 1 from public.workspaces w where w.id = ws)
$$;

-- 'member' → any active staff; 'owner' / 'admin' → staff admins.
create or replace function public.has_role(ws uuid, roles public.workspace_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when 'member' = any (roles) then public.is_member(ws)
    else public.is_admin() and exists (select 1 from public.workspaces w where w.id = ws)
  end
$$;

drop trigger if exists workspaces_add_owner on public.workspaces;
drop function if exists public.add_workspace_owner();
drop table public.workspace_members;

-- 3. Clients (workspaces) -------------------------------------------------------

alter table public.workspaces
  add column contact_name  text check (char_length(contact_name) <= 80),
  add column contact_phone text check (contact_phone is null or contact_phone ~ '^\+?[0-9]{9,15}$'),
  add column contact_email text check (contact_email is null or (char_length(contact_email) <= 160 and contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$')),
  add column notes         text check (char_length(notes) <= 1000),
  add column archived_at   timestamptz,
  add column updated_at    timestamptz not null default now();
create trigger workspaces_updated_at before update on public.workspaces
  for each row execute function public.set_updated_at();
create unique index workspaces_name_uniq on public.workspaces (lower(name));

drop policy "members read workspace" on public.workspaces;
drop policy "users create workspaces" on public.workspaces;
drop policy "admins update workspace" on public.workspaces;
drop policy "owners delete workspace" on public.workspaces;
create policy "staff read clients" on public.workspaces for select to authenticated using (public.is_staff());
create policy "staff add clients" on public.workspaces for insert to authenticated with check (public.is_staff());
create policy "staff edit clients" on public.workspaces for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "admins delete clients" on public.workspaces for delete to authenticated using (public.is_admin());

-- 4. Accounts: profile only; no personal workspace ----------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  display_name text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), '');
begin
  insert into public.profiles (id, full_name, email, phone)
  values (new.id, left(display_name, 80), new.email, new.phone);
  return new;
end $$;

alter table public.staff enable row level security;
create policy "staff read staff" on public.staff for select to authenticated using (public.is_staff());
create policy "admins change staff" on public.staff for update to authenticated using (public.is_admin()) with check (public.is_admin());
-- Staff rows are created by the staff-admin Edge Function (service role) when an admin invites someone.

create policy "staff read profiles" on public.profiles for select to authenticated using (public.is_staff());

-- API keys belonged to the self-service model.
drop function if exists public.create_api_key(uuid, text);
drop table public.api_keys;

-- 5. Phone numbers ----------------------------------------------------------------
-- Ghana by default: 0244123456, 233244123456 and 244123456 (Excel dropped the 0)
-- all become +233244123456. Numbers for other countries must start with + or 00.
-- dashboard.js normPhone() applies the same rules.

create or replace function public.normalize_phone(raw text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  s text := regexp_replace(coalesce(raw, ''), '[\s().-]', '', 'g');
begin
  if s like '00%' then s := '+' || substr(s, 3); end if;
  if s like '+%' then return s; end if;
  if s ~ '^0[0-9]{9}$' then return '+233' || substr(s, 2); end if;
  if s ~ '^233[0-9]{9}$' then return '+' || s; end if;
  if s ~ '^[0-9]{9}$' then return '+233' || s; end if;
  return s;
end $$;

create or replace function public.normalize_phone_column()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.phone := public.normalize_phone(new.phone);
  return new;
end $$;

create trigger contacts_phone before insert or update of phone on public.contacts
  for each row execute function public.normalize_phone_column();
create trigger opt_outs_phone before insert or update of phone on public.opt_outs
  for each row execute function public.normalize_phone_column();

create or replace function public.normalize_caller_number()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.type = 'number' then new.value := public.normalize_phone(new.value); end if;
  return new;
end $$;
create trigger caller_ids_number before insert or update of value on public.caller_ids
  for each row execute function public.normalize_caller_number();

-- 6. Global opt-out register (applies to every client) -------------------------

create table public.global_opt_outs (
  phone      text primary key check (phone ~ '^\+?[0-9]{9,15}$'),
  source     text not null default 'Website request' check (char_length(source) <= 40),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create trigger global_opt_outs_phone before insert or update of phone on public.global_opt_outs
  for each row execute function public.normalize_phone_column();
alter table public.global_opt_outs enable row level security;
create policy "staff read global opt-outs" on public.global_opt_outs for select to authenticated using (public.is_staff());
create policy "staff add global opt-outs" on public.global_opt_outs for insert to authenticated with check (public.is_staff());
create policy "admins remove global opt-outs" on public.global_opt_outs for delete to authenticated using (public.is_admin());

create or replace function public.is_opted_out(ws uuid, p text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.opt_outs o where o.workspace_id = ws and o.phone = p)
      or exists (select 1 from public.global_opt_outs g where g.phone = p)
$$;

-- 7. Caller IDs: admins approve -------------------------------------------------

alter table public.caller_ids add column reviewed_by uuid references auth.users (id) on delete set null;
create policy "admins add caller ids" on public.caller_ids for insert to authenticated with check (public.has_role(workspace_id, array['admin']::public.workspace_role[]));
create policy "admins review caller ids" on public.caller_ids for update to authenticated
  using (public.has_role(workspace_id, array['admin']::public.workspace_role[]))
  with check (public.has_role(workspace_id, array['admin']::public.workspace_role[]));

create or replace function public.caller_ids_stamp_review()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status <> 'pending' and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    new.reviewed_at := now();
    new.reviewed_by := auth.uid();
  end if;
  return new;
end $$;
create trigger caller_ids_stamp_review before insert or update on public.caller_ids
  for each row execute function public.caller_ids_stamp_review();

-- 8. Campaign compliance records and guard --------------------------------------

alter table public.campaigns
  add column consent_basis text check (char_length(consent_basis) <= 300),
  add column compliance_confirmed_by uuid references auth.users (id) on delete set null,
  add constraint campaigns_consent_basis_required
    check (status in ('draft', 'cancelled') or coalesce(char_length(trim(consent_basis)), 0) >= 5);

-- "Trusted" = the delivery system: the service role, or a SECURITY DEFINER
-- function below that sets balvoice.trusted for its own transaction. Clients
-- reach the database only through the API, which cannot call set_config.
create or replace function public.is_trusted()
returns boolean language sql stable set search_path = '' as $$
  select public.is_service_role() or coalesce(current_setting('balvoice.trusted', true), '') = 'on'
$$;

create or replace function public.campaigns_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not public.is_trusted() then
    if new.status in ('running', 'completed') and (tg_op = 'INSERT' or new.status is distinct from old.status) then
      raise exception 'status % can only be set by the delivery system', new.status using errcode = '42501';
    end if;
    if new.status = 'scheduled' and (tg_op = 'INSERT' or old.status is distinct from 'scheduled') and new.schedule_start <= now() then
      raise exception 'schedule start must be in the future' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' and old.status in ('running', 'completed')
       and (new.message_type, new.audio_file_id, new.tts_text, new.run_number)
           is distinct from (old.message_type, old.audio_file_id, old.tts_text, old.run_number) then
      raise exception 'the message cannot be changed after delivery has started' using errcode = '23514';
    end if;
  end if;
  if new.caller_id is not null and not public.is_service_role() and not exists (
       select 1 from public.caller_ids c where c.id = new.caller_id and c.status = 'approved') then
    raise exception 'caller ID is not approved' using errcode = '23514';
  end if;
  -- Record who confirmed consent, sender identification and opt-out, and when.
  -- Set by the database, never taken from the client.
  if new.status not in ('draft', 'cancelled') and (tg_op = 'INSERT' or old.status = 'draft') then
    new.compliance_confirmed_at := now();
    new.compliance_confirmed_by := auth.uid();
  end if;
  return new;
end $$;

-- 9. Delivery queue ------------------------------------------------------------------

alter table public.campaign_recipients
  add column status           text not null default 'queued' check (status in ('queued', 'dialing', 'done', 'skipped')),
  add column attempts         smallint not null default 0 check (attempts between 0 and 4),
  add column next_attempt_at  timestamptz not null default now(),
  add column locked_until     timestamptz,
  add column provider_call_id text check (char_length(provider_call_id) <= 120),
  add column skip_reason      text check (char_length(skip_reason) <= 40);
create index campaign_recipients_queue_idx on public.campaign_recipients (next_attempt_at) where status = 'queued';
create index campaign_recipients_run_idx on public.campaign_recipients (campaign_id, run_number, status);
create unique index campaign_recipients_call_idx on public.campaign_recipients (provider_call_id) where provider_call_id is not null;
create trigger campaign_recipients_phone before insert or update of phone on public.campaign_recipients
  for each row execute function public.normalize_phone_column();

-- Staff actions on campaigns ------------------------------------------------------

create or replace function public.campaign_start_now(p_campaign uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.campaigns;
begin
  select * into c from public.campaigns where id = p_campaign for update;
  if not found or not public.is_member(c.workspace_id) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  if c.status <> 'scheduled' then
    raise exception 'only a scheduled campaign can be started now' using errcode = '23514';
  end if;
  update public.campaigns set schedule_start = now() where id = p_campaign;
  insert into public.campaign_events (workspace_id, campaign_id, message, created_by)
  values (c.workspace_id, c.id, 'Start brought forward to now', auth.uid());
end $$;

create or replace function public.campaign_resume(p_campaign uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.campaigns;
begin
  select * into c from public.campaigns where id = p_campaign for update;
  if not found or not public.is_member(c.workspace_id) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  if c.status <> 'paused' then
    raise exception 'only a paused campaign can be resumed' using errcode = '23514';
  end if;
  perform set_config('balvoice.trusted', 'on', true);
  if exists (select 1 from public.campaign_recipients r where r.campaign_id = c.id and r.run_number = c.run_number) then
    update public.campaigns set status = 'running' where id = c.id;
  else
    -- Paused before delivery began: go back to the schedule.
    update public.campaigns set status = 'scheduled', schedule_start = greatest(schedule_start, now()) where id = c.id;
  end if;
  insert into public.campaign_events (workspace_id, campaign_id, message, created_by)
  values (c.workspace_id, c.id, 'Delivery resumed', auth.uid());
end $$;

-- Dialer functions (service role / pg_cron only) -------------------------------------

-- Start campaigns whose time has come: snapshot recipients from the groups,
-- skipping opted-out numbers, and mark the campaign running.
create or replace function public.dialer_start_due()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  c record;
  n integer := 0;
  added integer;
  skipped integer;
begin
  perform set_config('balvoice.trusted', 'on', true);
  for c in
    select * from public.campaigns
     where status = 'scheduled' and schedule_start <= now()
     order by schedule_start
     for update skip locked
  loop
    insert into public.campaign_recipients (workspace_id, campaign_id, run_number, phone, first_name, last_name, company)
    select distinct on (ct.phone) c.workspace_id, c.id, c.run_number, ct.phone, ct.first_name, ct.last_name, ct.company
      from public.campaign_groups cg
      join public.contact_group_members m on m.group_id = cg.group_id
      join public.contacts ct on ct.id = m.contact_id
     where cg.campaign_id = c.id
     order by ct.phone
    on conflict (campaign_id, run_number, phone) do nothing;
    get diagnostics added = row_count;

    update public.campaign_recipients r set status = 'skipped', skip_reason = 'Opt-out register'
     where r.campaign_id = c.id and r.run_number = c.run_number and r.status = 'queued'
       and public.is_opted_out(c.workspace_id, r.phone);
    get diagnostics skipped = row_count;

    update public.campaigns set status = 'running' where id = c.id;
    insert into public.campaign_events (workspace_id, campaign_id, message, created_by)
    values (c.workspace_id, c.id,
            'Delivery started (run ' || c.run_number || '): ' || (added - skipped) || ' to call'
            || case when skipped > 0 then ', ' || skipped || ' skipped (opt-out register)' else '' end, null);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Hand out the next calls to place. Calls are leased; a call the provider never
-- reports on is retried (or closed as unreachable) once its lease runs out.
create or replace function public.dialer_claim(p_limit integer default 50, p_lease_seconds integer default 300)
returns table (
  recipient_id bigint, campaign_id uuid, workspace_id uuid, run_number integer, attempt smallint,
  phone text, first_name text, last_name text, company text,
  message_type text, tts_text text, tts_language text, tts_voice text,
  audio_path text, caller_id text, sender_name text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if p_limit < 1 or p_limit > 500 then raise exception 'p_limit must be between 1 and 500'; end if;

  -- Expired leases on the last allowed attempt: close as unreachable.
  insert into public.call_results (workspace_id, campaign_id, recipient_id, run_number, outcome, attempts, last_attempt_at)
  select r.workspace_id, r.campaign_id, r.id, r.run_number, 'unreachable', greatest(r.attempts, 1), now()
    from public.campaign_recipients r join public.campaigns c on c.id = r.campaign_id
   where r.status = 'dialing' and r.locked_until < now() and r.attempts >= c.retries + 1
  on conflict (recipient_id) do update set outcome = 'unreachable', attempts = excluded.attempts, last_attempt_at = now();
  update public.campaign_recipients r set status = 'done', locked_until = null
    from public.campaigns c
   where c.id = r.campaign_id and r.status = 'dialing' and r.locked_until < now() and r.attempts >= c.retries + 1;
  -- Other expired leases: back in the queue.
  update public.campaign_recipients r set status = 'queued', locked_until = null, next_attempt_at = now()
   where r.status = 'dialing' and r.locked_until < now();

  -- Opt-outs are checked again just before dialing.
  update public.campaign_recipients r set status = 'skipped', skip_reason = 'Opt-out register'
    from public.campaigns c
   where c.id = r.campaign_id and c.status = 'running' and r.status = 'queued' and r.next_attempt_at <= now()
     and public.is_opted_out(r.workspace_id, r.phone);

  return query
  with picked as (
    select r.id
      from public.campaign_recipients r join public.campaigns c on c.id = r.campaign_id
     where r.status = 'queued' and r.next_attempt_at <= now() and c.status = 'running'
       and (now() at time zone c.timezone)::time >= c.window_start
       and (now() at time zone c.timezone)::time < c.window_end
     order by r.next_attempt_at, r.id
     limit p_limit
     for update of r skip locked)
  update public.campaign_recipients r
     set status = 'dialing', attempts = r.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds), provider_call_id = null
    from picked, public.campaigns c
         left join public.audio_files a on a.id = c.audio_file_id
         left join public.caller_ids ci on ci.id = c.caller_id
   where r.id = picked.id and c.id = r.campaign_id
  returning r.id, r.campaign_id, r.workspace_id, r.run_number, r.attempts,
            r.phone, r.first_name, r.last_name, r.company,
            c.message_type, c.tts_text, c.tts_language, c.tts_voice,
            a.storage_path, case when ci.status = 'approved' then ci.value end, c.sender_name;
end $$;

-- Remember the provider's call ID so its status callback can be matched.
create or replace function public.dialer_mark_sent(p_recipient bigint, p_provider_call_id text)
returns void language sql security definer set search_path = '' as $$
  update public.campaign_recipients set provider_call_id = p_provider_call_id
   where id = p_recipient and status = 'dialing'
$$;

-- Look up a call from the provider's call ID (used by the call-status webhook).
create or replace function public.dialer_find_call(p_provider_call_id text)
returns bigint language sql stable security definer set search_path = '' as $$
  select id from public.campaign_recipients where provider_call_id = p_provider_call_id
$$;

-- Record the outcome of one attempt. Retries are scheduled automatically.
-- Returns 'final', 'retry', or 'ignored' (duplicate or late report).
create or replace function public.dialer_report(
  p_recipient bigint, p_outcome text, p_duration integer default null,
  p_provider_call_id text default null, p_opt_out boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare
  r public.campaign_recipients;
  c public.campaigns;
  final boolean;
begin
  if p_outcome not in ('answered', 'busy', 'noanswer', 'unreachable') then
    raise exception 'unknown outcome %', p_outcome using errcode = '22023';
  end if;
  select * into r from public.campaign_recipients where id = p_recipient for update;
  if not found or r.status <> 'dialing'
     or (p_provider_call_id is not null and r.provider_call_id is not null and r.provider_call_id <> p_provider_call_id) then
    return 'ignored';
  end if;
  select * into c from public.campaigns where id = r.campaign_id;
  final := p_outcome = 'answered' or r.attempts >= c.retries + 1 or c.status = 'cancelled' or p_opt_out;

  insert into public.call_results (workspace_id, campaign_id, recipient_id, run_number, outcome, attempts, duration_sec, last_attempt_at)
  values (r.workspace_id, r.campaign_id, r.id, r.run_number, p_outcome, greatest(r.attempts, 1),
          case when p_outcome = 'answered' then greatest(coalesce(p_duration, 0), 0) end, now())
  on conflict (recipient_id) do update
    set outcome = excluded.outcome, attempts = excluded.attempts,
        duration_sec = excluded.duration_sec, last_attempt_at = excluded.last_attempt_at;

  update public.campaign_recipients
     set status = case when final then 'done' else 'queued' end,
         locked_until = null,
         next_attempt_at = case when final then next_attempt_at else now() + make_interval(mins => c.retry_interval_min) end
   where id = r.id;

  if p_opt_out then
    insert into public.opt_outs (workspace_id, phone, source, created_by)
    values (r.workspace_id, r.phone, 'During call', null) on conflict do nothing;
  end if;
  return case when final then 'final' else 'retry' end;
end $$;

-- Close runs with nothing left to dial. Repeating campaigns are rescheduled.
create or replace function public.dialer_finish()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  c record;
  n integer := 0;
  total integer;
  answered integer;
  step interval;
  next_start timestamptz;
begin
  perform set_config('balvoice.trusted', 'on', true);
  for c in
    select * from public.campaigns cc
     where cc.status = 'running'
       and not exists (select 1 from public.campaign_recipients r
                        where r.campaign_id = cc.id and r.run_number = cc.run_number and r.status in ('queued', 'dialing'))
     for update skip locked
  loop
    select count(*) filter (where r.status <> 'skipped'), count(cr.id) filter (where cr.outcome = 'answered')
      into total, answered
      from public.campaign_recipients r left join public.call_results cr on cr.recipient_id = r.id
     where r.campaign_id = c.id and r.run_number = c.run_number;
    insert into public.campaign_events (workspace_id, campaign_id, message, created_by)
    values (c.workspace_id, c.id, 'Run ' || c.run_number || ' completed: ' || answered || ' answered of ' || total, null);

    step := case c.repeat_rule when 'daily' then interval '1 day' when 'weekly' then interval '7 days'
                               when 'monthly' then interval '1 month' end;
    next_start := c.schedule_start;
    if step is not null then
      loop
        next_start := next_start + step;
        exit when next_start > now();
      end loop;
    end if;
    if step is not null and (next_start at time zone c.timezone)::date <= c.repeat_until then
      update public.campaigns set status = 'scheduled', run_number = run_number + 1, schedule_start = next_start where id = c.id;
      insert into public.campaign_events (workspace_id, campaign_id, message, created_by)
      values (c.workspace_id, c.id, 'Next run scheduled for ' || to_char(next_start at time zone c.timezone, 'DD Mon YYYY HH24:MI'), null);
    else
      update public.campaigns set status = 'completed' where id = c.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- 10. Results and costs -------------------------------------------------------------

create view public.campaign_run_stats with (security_invoker = true) as
select r.workspace_id, r.campaign_id, r.run_number,
       count(*) filter (where r.status <> 'skipped')                            as recipients,
       count(*) filter (where r.status = 'skipped')                             as skipped,
       count(*) filter (where r.status in ('queued', 'dialing'))                as pending,
       count(*) filter (where r.status = 'done')                                as done,
       count(*) filter (where r.status = 'done' and cr.outcome = 'answered')    as answered,
       count(*) filter (where r.status = 'done' and cr.outcome = 'busy')        as busy,
       count(*) filter (where r.status = 'done' and cr.outcome = 'noanswer')    as noanswer,
       count(*) filter (where r.status = 'done' and cr.outcome = 'unreachable') as unreachable,
       coalesce(sum(cr.attempts), 0)                                            as attempts,
       coalesce(sum(cr.duration_sec) filter (where cr.outcome = 'answered'), 0) as answered_seconds,
       max(cr.last_attempt_at)                                                  as last_call_at
  from public.campaign_recipients r
  left join public.call_results cr on cr.recipient_id = r.id
 group by r.workspace_id, r.campaign_id, r.run_number;

-- Airtime cost per run, from each client's rate settings. Only answered calls carry airtime.
create view public.campaign_costs with (security_invoker = true) as
select r.workspace_id, r.campaign_id, r.run_number,
       date_trunc('month', max(cr.last_attempt_at))::date as month,
       count(cr.id) filter (where cr.outcome = 'answered') as answered_calls,
       round(coalesce(sum(case when coalesce(s.billing_increment, 'second') = 'minute'
                               then ceil(cr.duration_sec / 60.0) else cr.duration_sec / 60.0 end)
                      filter (where cr.outcome = 'answered'), 0), 2) as billable_minutes,
       s.airtime_rate,
       coalesce(s.currency, 'GHS') as currency,
       round(coalesce(sum(case when coalesce(s.billing_increment, 'second') = 'minute'
                               then ceil(cr.duration_sec / 60.0) else cr.duration_sec / 60.0 end)
                      filter (where cr.outcome = 'answered'), 0) * s.airtime_rate, 2) as airtime_cost
  from public.call_results cr
  join public.campaign_recipients r on r.id = cr.recipient_id
  left join public.workspace_settings s on s.workspace_id = r.workspace_id
 group by r.workspace_id, r.campaign_id, r.run_number, s.airtime_rate, s.currency;

create view public.client_monthly_costs with (security_invoker = true) as
select workspace_id, month, currency,
       count(*) as runs, sum(answered_calls) as answered_calls,
       sum(billable_minutes) as billable_minutes, sum(airtime_cost) as airtime_cost
  from public.campaign_costs
 group by workspace_id, month, currency;

-- 11. Contacts written in bulk -------------------------------------------------------------
-- Upserts by phone within a client, so two staff importing the same number
-- never create duplicates. Returns the stored id for each submitted row.
create or replace function public.upsert_contacts(p_workspace uuid, p_rows jsonb)
returns table (client_id text, id uuid) language plpgsql security invoker set search_path = '' as $$
begin
  if not public.is_member(p_workspace) then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'send between 1 and 2000 rows per call' using errcode = '22023';
  end if;
  return query
  with input as (
    select x.client_id, public.normalize_phone(x.phone) as phone,
           left(nullif(trim(x.first_name), ''), 40) as first_name, left(nullif(trim(x.last_name), ''), 40) as last_name,
           left(nullif(trim(x.email), ''), 120) as email, left(nullif(trim(x.company), ''), 80) as company
      from jsonb_to_recordset(p_rows) as x(client_id text, phone text, first_name text, last_name text, email text, company text)
  ), valid as (
    select distinct on (i.phone) i.* from input i where i.phone ~ '^\+?[0-9]{9,15}$' order by i.phone
  ), up as (
    insert into public.contacts as ct (id, workspace_id, phone, first_name, last_name, email, company)
    select case when v.client_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then v.client_id::uuid else gen_random_uuid() end,
           p_workspace, v.phone, v.first_name, v.last_name, v.email, v.company
      from valid v
    on conflict (workspace_id, phone) do update
      set first_name = coalesce(excluded.first_name, ct.first_name),
          last_name  = coalesce(excluded.last_name, ct.last_name),
          email      = coalesce(excluded.email, ct.email),
          company    = coalesce(excluded.company, ct.company)
    returning ct.id, ct.phone
  )
  select i.client_id, up.id from input i join up on up.phone = i.phone;
end $$;

-- 12. Website: campaign requests and rate limits -----------------------------------------

create table public.campaign_requests (
  id                  uuid primary key default gen_random_uuid(),
  organization        text not null check (char_length(organization) between 2 and 120),
  contact_name        text not null check (char_length(contact_name) between 2 and 80),
  email               text not null check (char_length(email) <= 160 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$'),
  phone               text not null check (phone ~ '^\+?[0-9]{9,15}$'),
  campaign_type       text not null check (campaign_type in ('church', 'political', 'organization', 'other')),
  list_size           text not null check (list_size in ('under-1000', '1000-10000', '10000-50000', 'over-50000', 'unsure')),
  preferred_date      date,
  message             text check (char_length(message) <= 2000),
  consent_contacts_at timestamptz not null,
  consent_optout_at   timestamptz not null,
  status              text not null default 'new' check (status in ('new', 'contacted', 'converted', 'declined')),
  workspace_id        uuid references public.workspaces (id) on delete set null,
  staff_notes         text check (char_length(staff_notes) <= 1000),
  handled_by          uuid references auth.users (id) on delete set null,
  handled_at          timestamptz,
  ip_hash             text,
  created_at          timestamptz not null default now()
);
create index campaign_requests_status_idx on public.campaign_requests (status, created_at desc);
create trigger campaign_requests_phone before insert or update of phone on public.campaign_requests
  for each row execute function public.normalize_phone_column();
alter table public.campaign_requests enable row level security;
create policy "staff read requests" on public.campaign_requests for select to authenticated using (public.is_staff());
create policy "staff handle requests" on public.campaign_requests for update to authenticated using (public.is_staff()) with check (public.is_staff());
-- Inserted only by the request-form Edge Function (service role).

create or replace function public.campaign_requests_stamp()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    new.handled_by := auth.uid();
    new.handled_at := now();
  end if;
  return new;
end $$;
create trigger campaign_requests_stamp before update on public.campaign_requests
  for each row execute function public.campaign_requests_stamp();

create table public.public_rate_limits (
  id         bigint generated always as identity primary key,
  bucket     text not null,
  key_hash   text not null,
  created_at timestamptz not null default now()
);
create index public_rate_limits_idx on public.public_rate_limits (bucket, key_hash, created_at desc);
alter table public.public_rate_limits enable row level security;  -- no policies: service role only

-- Records a hit and returns true while the caller is under the limit.
create or replace function public.rate_limit_hit(p_bucket text, p_key_hash text, p_max integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  hits integer;
begin
  if random() < 0.02 then
    delete from public.public_rate_limits where created_at < now() - interval '2 days';
  end if;
  select count(*) into hits from public.public_rate_limits
   where bucket = p_bucket and key_hash = p_key_hash and created_at > now() - make_interval(secs => p_window_seconds);
  if hits >= p_max then return false; end if;
  insert into public.public_rate_limits (bucket, key_hash) values (p_bucket, p_key_hash);
  return true;
end $$;

-- 13. Audit log -------------------------------------------------------------------------------

create table public.audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor        uuid,
  actor_kind   text not null check (actor_kind in ('staff', 'system')),
  workspace_id uuid,
  table_name   text not null,
  row_id       text,
  action       text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  changes      jsonb
);
create index audit_log_at_idx on public.audit_log (at desc);
create index audit_log_ws_idx on public.audit_log (workspace_id, at desc);
alter table public.audit_log enable row level security;
create policy "admins read audit log" on public.audit_log for select to authenticated using (public.is_admin());

-- Row-level audit. tg_argv[0] = column holding the client id (or '-'), tg_argv[1] = row id column.
create or replace function public.audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  old_j jsonb;
  new_j jsonb;
  diff  jsonb;
  ws    uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then old_j := to_jsonb(old) - 'updated_at'; end if;
  if tg_op in ('UPDATE', 'INSERT') then new_j := to_jsonb(new) - 'updated_at'; end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, jsonb_build_object('from', old_j -> k, 'to', new_j -> k)) into diff
      from jsonb_object_keys(new_j) k where new_j -> k is distinct from old_j -> k;
    if diff is null then return null; end if;
  else
    diff := coalesce(new_j, old_j);
  end if;
  if tg_argv[0] <> '-' then ws := (coalesce(new_j, old_j) ->> tg_argv[0])::uuid; end if;
  insert into public.audit_log (actor, actor_kind, workspace_id, table_name, row_id, action, changes)
  values (auth.uid(), case when auth.uid() is null then 'system' else 'staff' end,
          ws, tg_table_name, coalesce(new_j, old_j) ->> tg_argv[1], tg_op, diff);
  return null;
end $$;

create trigger audit after insert or update or delete on public.workspaces         for each row execute function public.audit_row('id', 'id');
create trigger audit after insert or update or delete on public.staff              for each row execute function public.audit_row('-', 'user_id');
create trigger audit after insert or update or delete on public.workspace_settings for each row execute function public.audit_row('workspace_id', 'workspace_id');
create trigger audit after insert or update or delete on public.contact_groups     for each row execute function public.audit_row('workspace_id', 'id');
create trigger audit after insert or update or delete on public.opt_outs           for each row execute function public.audit_row('workspace_id', 'phone');
create trigger audit after insert or update or delete on public.global_opt_outs    for each row execute function public.audit_row('-', 'phone');
create trigger audit after insert or update or delete on public.caller_ids         for each row execute function public.audit_row('workspace_id', 'id');
create trigger audit after insert or update or delete on public.message_templates  for each row execute function public.audit_row('workspace_id', 'id');
create trigger audit after insert or update or delete on public.audio_files        for each row execute function public.audit_row('workspace_id', 'id');
create trigger audit after insert or update or delete on public.campaigns          for each row execute function public.audit_row('workspace_id', 'id');
create trigger audit after update on public.campaign_requests                       for each row execute function public.audit_row('workspace_id', 'id');

-- Bulk tables: one entry per statement and client, with a row count.
create or replace function public.audit_bulk()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    insert into public.audit_log (actor, actor_kind, workspace_id, table_name, action, changes)
    select auth.uid(), case when auth.uid() is null then 'system' else 'staff' end, o.workspace_id, tg_table_name, tg_op, jsonb_build_object('rows', count(*))
      from old_rows o group by o.workspace_id;
  else
    insert into public.audit_log (actor, actor_kind, workspace_id, table_name, action, changes)
    select auth.uid(), case when auth.uid() is null then 'system' else 'staff' end, n.workspace_id, tg_table_name, tg_op, jsonb_build_object('rows', count(*))
      from new_rows n group by n.workspace_id;
  end if;
  return null;
end $$;

create trigger audit_ins after insert on public.contacts referencing new table as new_rows for each statement execute function public.audit_bulk();
create trigger audit_upd after update on public.contacts referencing new table as new_rows for each statement execute function public.audit_bulk();
create trigger audit_del after delete on public.contacts referencing old table as old_rows for each statement execute function public.audit_bulk();
create trigger audit_ins after insert on public.contact_group_members referencing new table as new_rows for each statement execute function public.audit_bulk();
create trigger audit_del after delete on public.contact_group_members referencing old table as old_rows for each statement execute function public.audit_bulk();

-- 14. Privileges ------------------------------------------------------------------------------

revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;
revoke all on public.public_rate_limits from anon, authenticated;
revoke insert, delete on public.campaign_requests from authenticated;
revoke insert, delete on public.staff from authenticated;
revoke all on all tables in schema public from anon;

do $$
declare f text;
begin
  foreach f in array array[
    'public.dialer_start_due()', 'public.dialer_claim(integer, integer)', 'public.dialer_mark_sent(bigint, text)',
    'public.dialer_find_call(text)', 'public.dialer_report(bigint, text, integer, text, boolean)',
    'public.dialer_finish()', 'public.rate_limit_hit(text, text, integer, integer)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.campaign_start_now(uuid)', 'public.campaign_resume(uuid)', 'public.upsert_contacts(uuid, jsonb)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- 15. Results written by a campaign-level dispatcher -------------------------------------------
-- The BMS pipeline (20261101000000_bms_delivery.sql: dispatch-campaigns / sync-reports) records
-- outcomes in call_results without moving recipients through the per-call queue. These triggers
-- keep campaign_recipients.status in step so the dashboard's run statistics are right either way.
-- They only touch recipients still 'queued', so the per-call dialer above is unaffected.

create or replace function public.recipient_done_on_answer()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.outcome = 'answered' then
    update public.campaign_recipients set status = 'done' where id = new.recipient_id and status = 'queued';
  end if;
  return null;
end $$;
create trigger call_results_mark_done after insert or update of outcome on public.call_results
  for each row execute function public.recipient_done_on_answer();

-- When a run ends (completed, cancelled, or moved on to the next repeat), every recipient
-- with a recorded outcome is final.
create or replace function public.recipients_done_on_run_end()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (old.status = 'running' and new.status in ('completed', 'cancelled', 'scheduled'))
     or new.run_number <> old.run_number then
    update public.campaign_recipients r set status = 'done'
     where r.campaign_id = old.id and r.run_number = old.run_number and r.status = 'queued'
       and exists (select 1 from public.call_results cr where cr.recipient_id = r.id);
  end if;
  return null;
end $$;
create trigger campaigns_mark_recipients_done after update of status, run_number on public.campaigns
  for each row execute function public.recipients_done_on_run_end();
