# Internal backend: staff, clients, website endpoints

BalVoice is used only by its own staff. This document covers what migration `20261101120000_internal_staff.sql` and its Edge Functions add on top of the original schema and the BMS delivery pipeline ([BMS-INTEGRATION.md](BMS-INTEGRATION.md)).

## Model

| | |
|---|---|
| **Staff** | The only accounts. Table `staff` (role `admin` or `operator`, `active`). Sign-up is off everywhere; admins invite people. A signed-in account that is not active staff sees "No dashboard access" and can read nothing. |
| **Admins** | See every client. Add staff (temporary password or email invitation), assign clients to staff, add and archive clients, approve or reject caller IDs, remove numbers from opt-out registers, handle website campaign requests, read the audit log. There is always at least one active admin (enforced in the database). |
| **Operators** | See and work on **only the clients assigned to them** (`client_assignments`): their contacts, groups, templates, audio, campaigns and results. Data of other clients is invisible to them in the database itself, not just hidden in the dashboard. |
| **Clients** | The `workspaces` table, renamed in meaning only. Each client has its own contacts, groups, campaigns, caller IDs, templates, opt-out register and airtime rate. |

## Rules the database enforces

- **Phone numbers** are stored as `+233…`: `0244 123 456`, `233244123456` and `244123456` (Excel dropped the 0) are the same number. Other countries need `+` or `00`. The dashboard uses the same rules, so duplicates are caught before saving.
- **Contacts** are saved through `upsert_contacts()`, which matches on phone number within a client, so two staff importing the same list never create duplicates.
- **Consent record:** a campaign can't leave draft without the three confirmations (recipients agreed, sender identified, opt-out included) and a written **consent basis** ("how did these people agree to be called?"). The database stamps who confirmed it and when; the browser can't set those fields.
- **Opt-outs:** each client has a register, and the **all-clients register** (`global_opt_outs`) holds requests from the website form. Both are checked when a run starts and again before each call.
- **Delivery-owned states:** only the delivery system can set a campaign to running or completed, and a campaign's message can't change once delivery has started.
- **Audit log** (`audit_log`): every change to clients, staff, settings, groups, opt-outs, caller IDs, templates, audio, campaigns and requests, with who, when and what changed. Contact imports are logged as counts. Nobody can edit or delete entries; only admins can read them.

## Edge Functions

| Function | Who calls it | What it does | Secrets |
|---|---|---|---|
| `request-form` | Website contact page | Validates the campaign request, ignores honeypot submissions, limits each IP to 5 per hour (and 300 a day overall), stores the request with consent times. Optional email to staff through Resend. | `SITE_URL`, `RATE_LIMIT_SALT`, optional `RESEND_API_KEY`, `NOTIFY_EMAIL`, `NOTIFY_FROM` |
| `opt-out` | Website contact page | Adds a number to the all-clients opt-out register. Same answer whether or not it was listed. 5 per hour per IP. | `SITE_URL`, `RATE_LIMIT_SALT` |
| `staff-admin` | Dashboard Team page | Create an account with a temporary password, or invite by email; change role; deactivate (also blocks sign-in and ends sessions). Admins only, checked with the caller's own token. | `SITE_URL` (for invitation links) |
| `dialer`, `call-status` | Not scheduled | A provider-neutral per-call dialer with a simulator, kept as an alternative to the BMS functions. See "Two delivery pipelines" below. | `DIALER_SECRET`, `VOICE_PROVIDER` |

IP addresses are hashed with `RATE_LIMIT_SALT` before use; raw IPs are never stored.

Deploy:
```bash
supabase functions deploy request-form --no-verify-jwt
supabase functions deploy opt-out --no-verify-jwt
supabase functions deploy staff-admin
supabase secrets set SITE_URL=https://your-domain.com RATE_LIMIT_SALT=$(openssl rand -hex 16)
```

## Setting up staff

1. In the Supabase dashboard, **Authentication → Sign In / Providers**: turn off **Allow new users to sign up** (the same as `enable_signup = false` in `supabase/config.toml`). Google and phone sign-in still work for existing accounts.
2. **Authentication → Emails → Templates → Invite user**: paste `supabase/templates/invite.html`. The link opens the site, which asks the new staff member to choose a password.
3. **Authentication → Multi-Factor**: enable TOTP so staff can add an authenticator app.
4. Create the first administrator: invite yourself from **Authentication → Users → Invite**, accept the email, then in the SQL editor:
   ```sql
   insert into public.staff (user_id, role, created_by)
   select id, 'admin', null from auth.users where email = 'you@your-domain.com';
   ```
5. Sign in to the dashboard and invite everyone else from **Team**.

## Costs

`campaign_run_stats` gives per-run totals; `campaign_costs` and `client_monthly_costs` give answered calls, billable minutes (per second, or per minute rounded up, from the client's settings) and airtime at the client's rate. The dashboard's Reports page shows the monthly figures for invoicing.

## Two delivery pipelines

Two sessions built delivery on the same day:

- **BMS pipeline** (`dispatch-campaigns`, `sync-reports`, migration `20261101000000_bms_delivery.sql`) sends whole campaign runs to BMS voice and pulls results back. `supabase/cron.sql` schedules these.
- **Per-call dialer** (`dialer`, `call-status`, `dialer_*` functions in `20261101120000_internal_staff.sql`) leases one call at a time to a provider adapter (`_shared/voice-provider.ts`), with a simulator for testing.

Run only one. Both start campaigns that are due, so scheduling both would call people twice. The dashboard reads results from either: triggers in the internal-staff migration mark recipients as done when the BMS pipeline records outcomes.

## Tests

| Test | Command | Checks |
|---|---|---|
| Staff model, queue, costs, requests, audit (SQL) | `node supabase/tests/run-pglite.mjs supabase/tests/supabase-stub.sql supabase/migrations/*.sql supabase/tests/staff_test.sql` | 41 |
| Edge Functions end to end | `deno run -A supabase/tests/functions-harness.ts` | 19 |
| Connected dashboard in Chromium | `node tests/live-dashboard.mjs` (see tests/README.md) | 38 |

`run-pglite.mjs` needs `npm install @electric-sql/pglite`. No PostgreSQL server is required.
