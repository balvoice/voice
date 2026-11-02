-- BalVoice — initial schema for Supabase
-- ---------------------------------------------------------------------------
-- Multi-tenant model: every row belongs to a workspace; users access data only
-- through workspace membership, enforced by Row Level Security on every table.
-- A personal workspace is created automatically when a user signs up.
--
-- Mirrors the dashboard prototype (docs/DASHBOARD-GUIDE.md):
--   profiles · workspaces · workspace_members · workspace_settings · api_keys
--   contacts · contact_groups · contact_group_members · opt_outs
--   caller_ids · message_templates · audio_files (+ storage bucket)
--   campaigns · campaign_groups · campaign_recipients · call_results · campaign_events
--   sms_otp_log (used only by the send-sms Edge Function)
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto with schema extensions;

-- Utility -------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.is_service_role()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role'
$$;

-- Profiles ------------------------------------------------------------------

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  full_name    text check (char_length(full_name) <= 80),
  organization text check (char_length(organization) <= 120),
  email        text,
  phone        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Workspaces and membership --------------------------------------------------

create type public.workspace_role as enum ('owner', 'admin', 'member');

create table public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 120),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         public.workspace_role not null default 'member',
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

-- Membership helpers. SECURITY DEFINER avoids recursive RLS on workspace_members.
create or replace function public.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
  )
$$;

create or replace function public.has_role(ws uuid, roles public.workspace_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.role = any (roles)
  )
$$;

-- The creator of a new workspace becomes its owner.
create or replace function public.add_workspace_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.created_by is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (new.id, new.created_by, 'owner')
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger workspaces_add_owner after insert on public.workspaces
  for each row execute function public.add_workspace_owner();

-- New users: profile + personal workspace (from sign-up metadata).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  display_name text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), '');
  org          text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'organization', '')), '');
begin
  insert into public.profiles (id, full_name, organization, email, phone)
  values (new.id, left(display_name, 80), left(org, 120), new.email, new.phone);

  insert into public.workspaces (name, created_by)
  values (left(coalesce(org, display_name || '''s workspace', 'My workspace'), 120), new.id);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep profile email/phone in sync when they change in auth.
create or replace function public.sync_profile_contact()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = new.email, phone = new.phone where id = new.id;
  return new;
end $$;
create trigger on_auth_user_updated after update of email, phone on auth.users
  for each row execute function public.sync_profile_contact();

-- Workspace settings and API keys ------------------------------------------

create table public.workspace_settings (
  workspace_id       uuid primary key references public.workspaces (id) on delete cascade,
  airtime_rate       numeric(12, 4) check (airtime_rate >= 0),
  currency           text not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  billing_increment  text not null default 'second' check (billing_increment in ('second', 'minute')),
  bill_answered_only boolean not null default true,
  webhook_url        text check (webhook_url is null or webhook_url ~ '^https://'),
  low_balance_email  text check (low_balance_email is null or low_balance_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  updated_at         timestamptz not null default now()
);
create trigger workspace_settings_updated_at before update on public.workspace_settings
  for each row execute function public.set_updated_at();

create table public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null default 'API key' check (char_length(name) <= 60),
  prefix       text not null,
  key_hash     text not null unique,         -- SHA-256 of the full key; the key itself is never stored
  created_by   uuid references auth.users (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index api_keys_workspace_idx on public.api_keys (workspace_id);

-- Returns the new key ONCE. Only owners and admins may create keys.
create or replace function public.create_api_key(ws uuid, key_name text default 'API key')
returns text language plpgsql security definer set search_path = '' as $$
declare
  raw text;
begin
  if not public.has_role(ws, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  raw := 'bv_live_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.api_keys (workspace_id, name, prefix, key_hash)
  values (ws, left(coalesce(key_name, 'API key'), 60), left(raw, 12), encode(extensions.digest(raw, 'sha256'), 'hex'));
  return raw;
end $$;

-- Contacts and groups --------------------------------------------------------

create table public.contacts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  phone        text not null check (phone ~ '^\+?[0-9]{9,15}$'),
  first_name   text check (char_length(first_name) <= 40),
  last_name    text check (char_length(last_name) <= 40),
  email        text check (char_length(email) <= 120),
  company      text check (char_length(company) <= 80),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, phone),
  unique (workspace_id, id)
);
create trigger contacts_updated_at before update on public.contacts
  for each row execute function public.set_updated_at();

create table public.contact_groups (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null check (char_length(name) between 2 and 60),
  description  text check (char_length(description) <= 120),
  created_at   timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index contact_groups_name_uniq on public.contact_groups (workspace_id, lower(name));

-- A contact can belong to any number of groups. Composite keys keep both sides in the same workspace.
create table public.contact_group_members (
  workspace_id uuid not null,
  group_id     uuid not null,
  contact_id   uuid not null,
  added_at     timestamptz not null default now(),
  primary key (group_id, contact_id),
  foreign key (workspace_id, group_id) references public.contact_groups (workspace_id, id) on delete cascade,
  foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete cascade
);
create index contact_group_members_contact_idx on public.contact_group_members (contact_id);
create index contact_group_members_ws_idx on public.contact_group_members (workspace_id);

create table public.opt_outs (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  phone        text not null check (phone ~ '^\+?[0-9]{9,15}$'),
  source       text not null default 'Recipient request' check (char_length(source) <= 40),
  created_by   uuid references auth.users (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, phone)
);

-- Caller IDs, templates, audio ------------------------------------------------

create table public.caller_ids (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  type         text not null check (type in ('brand', 'number')),
  value        text not null check (
                 (type = 'brand' and value ~ '^[A-Z0-9]{3,11}$') or
                 (type = 'number' and value ~ '^\+?[0-9]{9,15}$')),
  purpose      text check (char_length(purpose) <= 160),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (workspace_id, value),
  unique (workspace_id, id)
);

create table public.message_templates (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null check (char_length(name) between 2 and 60),
  category     text check (char_length(category) <= 30),
  body         text not null check (char_length(body) between 10 and 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger message_templates_updated_at before update on public.message_templates
  for each row execute function public.set_updated_at();

create table public.audio_files (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  storage_path text not null unique,          -- "<workspace_id>/<uuid>.mp3" in the campaign-audio bucket
  file_name    text not null check (char_length(file_name) <= 120),
  mime_type    text not null check (mime_type in ('audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave')),
  size_bytes   integer not null check (size_bytes between 1 and 10485760),
  duration_sec numeric(6, 1) check (duration_sec > 0 and duration_sec <= 180),
  created_at   timestamptz not null default now(),
  unique (workspace_id, id)
);

-- Campaigns ---------------------------------------------------------------------

create table public.campaigns (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  name               text not null check (char_length(name) between 3 and 80),
  type               text not null check (type in ('church', 'political', 'organization', 'other')),
  sender_name        text not null check (char_length(sender_name) between 2 and 80),
  description        text check (char_length(description) <= 500),
  caller_id          uuid,
  message_type       text not null check (message_type in ('audio', 'tts')),
  audio_file_id      uuid,
  tts_text           text check (char_length(tts_text) <= 1000),
  tts_language       text check (tts_language in ('en', 'tw', 'ha', 'ee')),
  tts_voice          text check (tts_voice in ('female', 'male')),
  status             text not null default 'draft'
                       check (status in ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled')),
  schedule_start     timestamptz,
  window_start       time not null default '09:00',
  window_end         time not null default '19:00',
  timezone           text not null default 'Africa/Accra',
  retries            smallint not null default 2 check (retries between 0 and 3),
  retry_interval_min smallint not null default 30 check (retry_interval_min in (15, 30, 60, 120)),
  repeat_rule        text not null default 'none' check (repeat_rule in ('none', 'daily', 'weekly', 'monthly')),
  repeat_until       date,
  run_number         integer not null default 1,
  consent_confirmed  boolean not null default false,
  sender_identified  boolean not null default false,
  optout_included    boolean not null default false,
  compliance_confirmed_at timestamptz,
  created_by         uuid references auth.users (id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, caller_id) references public.caller_ids (workspace_id, id) on delete set null (caller_id),
  foreign key (workspace_id, audio_file_id) references public.audio_files (workspace_id, id) on delete restrict,
  check (window_start < window_end),
  check (message_type <> 'audio' or status = 'draft' or audio_file_id is not null),
  check (message_type <> 'tts' or status = 'draft' or char_length(tts_text) >= 10),
  check (repeat_rule = 'none' or repeat_until is not null),
  check (status in ('draft', 'cancelled') or (consent_confirmed and sender_identified and optout_included and schedule_start is not null))
);
create index campaigns_workspace_idx on public.campaigns (workspace_id, created_at desc);
create index campaigns_due_idx on public.campaigns (schedule_start) where status = 'scheduled';
create trigger campaigns_updated_at before update on public.campaigns
  for each row execute function public.set_updated_at();

-- Users may draft, schedule, pause, and cancel. Only the dialer (service role)
-- moves campaigns to running/completed. Caller IDs must be approved.
create or replace function public.campaigns_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if public.is_service_role() then return new; end if;
  if new.status in ('running', 'completed') and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    raise exception 'status % can only be set by the delivery system', new.status using errcode = '42501';
  end if;
  if new.caller_id is not null and not exists (
       select 1 from public.caller_ids c where c.id = new.caller_id and c.status = 'approved') then
    raise exception 'caller ID is not approved' using errcode = '23514';
  end if;
  if new.status = 'scheduled' and (tg_op = 'INSERT' or old.status is distinct from 'scheduled') and new.schedule_start <= now() then
    raise exception 'schedule start must be in the future' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger campaigns_guard before insert or update on public.campaigns
  for each row execute function public.campaigns_guard();

create table public.campaign_groups (
  workspace_id uuid not null,
  campaign_id  uuid not null,
  group_id     uuid not null,
  primary key (campaign_id, group_id),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade,
  foreign key (workspace_id, group_id) references public.contact_groups (workspace_id, id) on delete cascade
);

-- Snapshot of who is called in each run (groups can change after a campaign starts).
create table public.campaign_recipients (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null,
  campaign_id  uuid not null,
  run_number   integer not null default 1,
  phone        text not null check (phone ~ '^\+?[0-9]{9,15}$'),
  first_name   text,
  last_name    text,
  company      text,
  unique (campaign_id, run_number, phone),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade
);

create table public.call_results (
  id              bigint generated always as identity primary key,
  workspace_id    uuid not null,
  campaign_id     uuid not null,
  recipient_id    bigint not null references public.campaign_recipients (id) on delete cascade,
  run_number      integer not null default 1,
  outcome         text not null check (outcome in ('answered', 'busy', 'noanswer', 'unreachable')),
  attempts        smallint not null default 1 check (attempts between 1 and 4),
  duration_sec    integer check (duration_sec >= 0),
  last_attempt_at timestamptz not null default now(),
  unique (recipient_id),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade
);
create index call_results_campaign_idx on public.call_results (campaign_id, run_number, outcome);

create table public.campaign_events (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null,
  campaign_id  uuid not null,
  message      text not null check (char_length(message) <= 300),
  created_by   uuid references auth.users (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade
);
create index campaign_events_campaign_idx on public.campaign_events (campaign_id, created_at desc);

-- SMS code rate limiting (Edge Function only) ----------------------------------

create table public.sms_otp_log (
  id         bigint generated always as identity primary key,
  phone_hash text not null,                  -- SHA-256 of the phone number; no raw numbers stored
  created_at timestamptz not null default now()
);
create index sms_otp_log_phone_idx on public.sms_otp_log (phone_hash, created_at desc);

-- Row Level Security ----------------------------------------------------------------

alter table public.profiles              enable row level security;
alter table public.workspaces            enable row level security;
alter table public.workspace_members     enable row level security;
alter table public.workspace_settings    enable row level security;
alter table public.api_keys              enable row level security;
alter table public.contacts              enable row level security;
alter table public.contact_groups        enable row level security;
alter table public.contact_group_members enable row level security;
alter table public.opt_outs              enable row level security;
alter table public.caller_ids            enable row level security;
alter table public.message_templates     enable row level security;
alter table public.audio_files           enable row level security;
alter table public.campaigns             enable row level security;
alter table public.campaign_groups       enable row level security;
alter table public.campaign_recipients   enable row level security;
alter table public.call_results          enable row level security;
alter table public.campaign_events       enable row level security;
alter table public.sms_otp_log           enable row level security;  -- no policies: service role only

-- Profiles: users see and edit only their own.
create policy "own profile: read" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile: update" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Workspaces.
create policy "members read workspace" on public.workspaces for select to authenticated using (public.is_member(id));
create policy "users create workspaces" on public.workspaces for insert to authenticated with check (created_by = (select auth.uid()));
create policy "admins update workspace" on public.workspaces for update to authenticated
  using (public.has_role(id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_role(id, array['owner', 'admin']::public.workspace_role[]));
create policy "owners delete workspace" on public.workspaces for delete to authenticated
  using (public.has_role(id, array['owner']::public.workspace_role[]));

-- Membership: members can see the team; owners/admins manage it.
create policy "members read membership" on public.workspace_members for select to authenticated using (public.is_member(workspace_id));
create policy "admins add members" on public.workspace_members for insert to authenticated
  with check (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]) and role <> 'owner');
create policy "admins change members" on public.workspace_members for update to authenticated
  using (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]) and role <> 'owner')
  with check (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]) and role <> 'owner');
create policy "admins remove members or leave" on public.workspace_members for delete to authenticated
  using ((public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]) and role <> 'owner')
         or (user_id = (select auth.uid()) and role <> 'owner'));

-- Settings and API keys: read by members, changed by owners/admins. Keys are created only via create_api_key().
create policy "members read settings" on public.workspace_settings for select to authenticated using (public.is_member(workspace_id));
create policy "admins write settings" on public.workspace_settings for all to authenticated
  using (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy "admins read keys" on public.api_keys for select to authenticated
  using (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy "admins revoke keys" on public.api_keys for update to authenticated
  using (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- Workspace data: full access for members.
create policy "members manage contacts" on public.contacts for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members manage groups" on public.contact_groups for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members manage group membership" on public.contact_group_members for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members manage templates" on public.message_templates for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members manage audio" on public.audio_files for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members manage campaigns" on public.campaigns for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members manage campaign groups" on public.campaign_groups for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));

-- Opt-outs: members add and read; removing a number requires owner/admin.
create policy "members read opt-outs" on public.opt_outs for select to authenticated using (public.is_member(workspace_id));
create policy "members add opt-outs" on public.opt_outs for insert to authenticated with check (public.is_member(workspace_id));
create policy "admins remove opt-outs" on public.opt_outs for delete to authenticated
  using (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- Caller IDs: members request (always 'pending') and remove; approval is done by BalVoice staff (service role).
create policy "members read caller ids" on public.caller_ids for select to authenticated using (public.is_member(workspace_id));
create policy "members request caller ids" on public.caller_ids for insert to authenticated
  with check (public.is_member(workspace_id) and status = 'pending' and reviewed_at is null);
create policy "members remove caller ids" on public.caller_ids for delete to authenticated using (public.is_member(workspace_id));

-- Delivery data: members read; written by the delivery system (service role) only.
create policy "members read recipients" on public.campaign_recipients for select to authenticated using (public.is_member(workspace_id));
create policy "members read results" on public.call_results for select to authenticated using (public.is_member(workspace_id));
create policy "members read events" on public.campaign_events for select to authenticated using (public.is_member(workspace_id));
create policy "members add events" on public.campaign_events for insert to authenticated
  with check (public.is_member(workspace_id) and created_by = (select auth.uid()));

-- Lock down helpers and tables that clients must not touch directly.
revoke all on public.sms_otp_log from anon, authenticated;
revoke execute on function public.create_api_key(uuid, text) from anon;
revoke all on all tables in schema public from anon;

-- Storage: private bucket for campaign audio, one folder per workspace ----------------

-- True when the first folder of an object path is a workspace the user belongs to.
-- Returns false (instead of erroring) for paths that don't start with a UUID.
create or replace function public.can_access_workspace_path(object_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  folder text := split_part(object_name, '/', 1);
begin
  if folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.is_member(folder::uuid);
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('campaign-audio', 'campaign-audio', false, 10485760, array['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave'])
on conflict (id) do nothing;

create policy "members read workspace audio" on storage.objects for select to authenticated
  using (bucket_id = 'campaign-audio' and public.can_access_workspace_path(name));
create policy "members upload workspace audio" on storage.objects for insert to authenticated
  with check (bucket_id = 'campaign-audio' and public.can_access_workspace_path(name));
create policy "members delete workspace audio" on storage.objects for delete to authenticated
  using (bucket_id = 'campaign-audio' and public.can_access_workspace_path(name));
