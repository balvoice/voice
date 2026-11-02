-- BalVoice — clients are assigned to staff (least privilege)
-- ---------------------------------------------------------------------------
-- Admins see and manage every client. Operators see ONLY the clients an admin
-- has assigned to them: contacts, groups, campaigns, results, audio, settings,
-- caller IDs, templates and opt-out registers of other clients are invisible.
-- Because every policy goes through is_member(), redefining it applies the rule
-- to all client data, storage included.
-- Campaign requests from the website are sales leads, not client data: admins only.
-- ---------------------------------------------------------------------------

create table public.client_assignments (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references public.staff (user_id) on delete cascade,
  assigned_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index client_assignments_user_idx on public.client_assignments (user_id);
alter table public.client_assignments enable row level security;
create policy "staff read their assignments" on public.client_assignments for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());
create policy "admins assign clients" on public.client_assignments for insert to authenticated with check (public.is_admin());
create policy "admins unassign clients" on public.client_assignments for delete to authenticated using (public.is_admin());
create trigger audit after insert or delete on public.client_assignments
  for each row execute function public.audit_row('workspace_id', 'user_id');

-- Admin: every client. Operator: assigned clients only.
-- No lookup of the client row itself: a statement that inserts a client and returns it
-- could not see its own new row in that lookup. Client-data tables all reference a real
-- client through foreign keys, so the lookup added nothing.
create or replace function public.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select ws is not null
     and (public.is_admin()
          or (public.is_staff() and exists (
                select 1 from public.client_assignments a where a.workspace_id = ws and a.user_id = (select auth.uid()))))
$$;

-- Clients: operators see and edit only their assigned clients; only admins add or delete.
drop policy "staff read clients" on public.workspaces;
drop policy "staff add clients" on public.workspaces;
drop policy "staff edit clients" on public.workspaces;
create policy "read assigned clients" on public.workspaces for select to authenticated using (public.is_member(id));
create policy "admins add clients" on public.workspaces for insert to authenticated with check (public.is_admin());
create policy "edit assigned clients" on public.workspaces for update to authenticated using (public.is_member(id)) with check (public.is_member(id));

-- Website requests: admins only.
drop policy "staff read requests" on public.campaign_requests;
drop policy "staff handle requests" on public.campaign_requests;
create policy "admins read requests" on public.campaign_requests for select to authenticated using (public.is_admin());
create policy "admins handle requests" on public.campaign_requests for update to authenticated using (public.is_admin()) with check (public.is_admin());
