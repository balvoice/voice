# Process log

A record of every step taken to build the BalVoice website and dashboard prototype, in order. Each stage lists what was asked, what was decided, what was built, and how it was checked.

---

## Stage 1 — Website from the project instructions (31 Oct 2026)

**Request:** "Use the instructions and nothing else." Build the site described in the BalVoice project instructions.

### 1.1 Scope and constraints

- Only the project instructions were used. The two project documents (`Political_Voice_Broadcast_Services_BAL.docx`, `Evangelism_Church_Voice_Broadcast_Services.docx`) were **not** opened. The only content taken from them is what the instructions already quote.
- The target folder `~/Documents/BalVoice` was empty.
- Rules carried through every page:
  - Never invent customers, reviews, statistics, partners, certifications, or prices. Missing information gets a visible `[placeholder]`.
  - Avoid "AI startup" visuals: no gradients, glassmorphism, robot imagery, or purple/blue AI palettes.
  - Always show consent, opt-out, and responsible messaging.

### 1.2 Technical decisions

| Decision | Reason |
|---|---|
| Plain HTML/CSS/JS, no framework | Fastest loading, no build dependencies, easy to host anywhere |
| `build.py` assembles pages from `src/partials` | Header and footer are written once and shared by every page ("reusable components") without needing JavaScript to render them, which helps SEO |
| IBM Plex Sans and Mono | Listed in the instructions; reads as telecom and enterprise |
| Colours: navy `#13233D`, blue `#1D5BBF`, green `#14804A`, soft grey `#F5F7FA` | The instructions' palette: deep navy, professional blue, green for success, white or grey backgrounds |
| Strict Content Security Policy (no inline scripts or styles) | Secure default; this rules out inline `style=""` attributes, so widths are set through JavaScript instead |
| Hero visual is an HTML "campaign console", labelled illustrative | Follows the instructions' visual ideas (communication dashboard, call delivery) without stock photos, and without passing off example data as real |

### 1.3 Pages built

1. **Home:** hero with the instructions' headline and both buttons; what you provide / what we handle / what you receive; the five-step workflow; three audiences; the call outcomes table; responsible-by-design principles; a closing call to action.
2. **Church & Evangelism:** the instructions' service description, the Record → Upload → Schedule → Deliver → Report workflow, what the service includes, common uses, guidelines, and an FAQ.
3. **Political & Civic:** a neutrality statement, use cases (announcements, voter communication, outreach, reminders, mobilization), responsible communication guidelines, and an FAQ. No party or candidate is promoted.
4. **How It Works:** a flow diagram (Voice Platform → Dialer Engine → Telephone Network → Recipient Phone → Reporting System), a detailed timeline, outcome definitions, and data and consent handling.
5. **Pricing:** "Campaign Cost Factors" with the instructions' formula, the six factors, and a calculator. There are no prices; the airtime rate is entered by the visitor.
6. **About:** story, mission, values, and leadership and contact as placeholders.
7. **Contact:** campaign request form with validation, a honeypot, a resubmit throttle, two required consent boxes, and opt-out instructions.
8. **Dashboard:** prototype of create campaign → audio → contacts → schedule → status → reports, plus an opt-out register.
9. **404 page**, `sitemap.xml`, `robots.txt`, `_headers` (security headers).

### 1.4 Checks

- Every page was screenshotted with Playwright/Chromium at 1366 px and 390 px.
- Fixed:
  - Mobile horizontal overflow, caused by grid columns of `1fr` with wide content (changed to `minmax(0,1fr)`).
  - Legend swatches with no colour.
  - The calculator's empty state and answer-rate field width.
  - Mobile overflow on the dashboard detail page.
  - The step bar not scrolling to the current step on mobile.
- The calculator was checked by hand: 5,000 × 0.75 × 0.5 × 1.75 + 200 = 3,481.25 ✓.
- The dashboard flow was tested end to end with a generated WAV file and a 303-row CSV. The duplicate, invalid, and opted-out numbers were each handled correctly.
- Files were copied to `~/Documents/BalVoice`.

---

## Stage 2 — Arkesel features and contact groups (31 Oct 2026)

**Request:** Find Arkesel features and integrate them, add groups the way Arkesel does them, and document every step.

### 2.1 Research

Sources were Arkesel's own pages and the public client libraries (full list in [ARKESEL-RESEARCH.md](ARKESEL-RESEARCH.md)):

- arkesel.com/voice-sms, /bulk-sms, /developer-api, and the personalization article
- The `arkesel-python` documentation (contact group methods)
- The `arkesel-js` package (sender ID, scheduling, balance)

Main findings: contact groups are central — contacts live in a phonebook and are organized into groups that campaigns target. Also found: text-to-speech in English, Twi, Hausa, and Ewe; MP3/WAV upload; retries; scheduled and recurring broadcasts; real-time reports with export; brand or number caller ID; personalization from contact fields; templates; an `api-key` header; webhooks; test sending; billing per second and only for answered calls.

### 2.2 What was adopted and what was not

The full comparison table is in ARKESEL-RESEARCH.md. In short:

- **Adopted** (fits a voice broadcast service): groups, text-to-speech, personalization with fallbacks, templates, caller IDs with review, recurring schedules, test calls, billing settings, API key and webhook settings, saving unreached contacts as a group.
- **Not adopted** (outside this product's scope or needing a backend): USSD, OTP, WhatsApp, email, AI message writing, birthday automation, wallet top-ups, SMS.
- **Not copied:** Arkesel's prices, wording, branding, or design. Only feature ideas were used.

### 2.3 Dashboard changes

- **Data model:** a global phonebook (`contacts`) where each contact has `groups: []`, plus `groups`, `callerIds`, `templates`, and `settings`. Older saved data migrates automatically.
- **New screens:**
  - Contact groups
  - Group detail (add, import, search, select, copy/move/remove, export, edit, delete)
  - All contacts
  - Templates
  - Caller IDs
  - Settings & API
- **Wizard:**
  - Caller ID choice.
  - Upload recording or text-to-speech, with language, voice, field insertion, a live personalised preview, and a browser speech preview for English.
  - Recipients from one or more groups, deduplicated across groups and filtered by opt-outs, or from an uploaded file that can be saved to a new or existing group.
  - A warning when contacts are missing personal fields.
  - Repeat daily, weekly, or monthly with an end date.
  - Test call and cost estimate on the Review step.
- **Campaign detail:** message panel, caller ID, billable minutes and estimated cost, "Save unreached contacts as group", recurring "Run next occurrence", and previous runs. Repeating runs re-read the group's current members.
- **Sidebar** regrouped into Campaigns / Audience / Messages / Account.

### 2.4 Website changes

- The How It Works, Church, and Political pages now describe groups, text-to-speech in local languages, caller ID, recurring campaigns, follow-up groups, and webhooks.

### 2.5 Checks

The automated Playwright run (`feat.js`), at desktop and mobile:

- Created a group and imported 132 rows: 130 added, 1 invalid, 1 duplicate skipped.
- Added a contact by hand, created a second group, and copied 50 contacts to it.
- Requested a caller ID and approved it, set the rate to 0.15, generated an API key, and copied a starter template.
- Built a text-to-speech campaign to a group with a weekly repeat and a test call, then simulated delivery.
- Saved unreached contacts as a group and ran the next occurrence.
- Billing was checked by hand: 124 answered × 17 s = 35.13 billable minutes × 0.15 = GHS 5.27 ✓.
- Result: no JavaScript errors and no horizontal overflow.
- Fixed: on mobile, the group page's add/import panels were below a long list, so they were moved above it.

---

## Stage 3 — Cookie consent (31 Oct 2026)

**Request:** Add cookie consent the way professional companies do it.

### 3.1 Approach

Built on common good practice: GDPR/ePrivacy guidance (also relevant to Ghana's Data Protection Act, 2012):

- No optional storage before a choice is made.
- **Reject** is as easy and as prominent as **Accept** (same button style, same size).
- Categories can be chosen individually in a preferences dialog.
- Choices can be changed at any time from "Cookie settings" in every footer and in the dashboard sidebar.
- The choice is kept for 180 days with a policy version; changing the version asks everyone again.
- The Global Privacy Control signal is honoured.
- An honest cookie policy that lists only what the site actually stores.

### 3.2 Built

- `assets/js/consent.js`: banner, accessible `<dialog>` with switch controls, `bv_consent` cookie (SameSite=Lax, Secure on HTTPS), a public `BalVoiceConsent` API, and script gating through `type="text/plain" data-consent="…"`.
- Categories:
  - Strictly necessary (always on)
  - Preferences: the calculator remembers your inputs only with consent, and the data is deleted when consent is withdrawn
  - Analytics: declared as "not currently in use"
- `cookies.html`: cookie policy with a table of every storage item. `privacy.html`: draft privacy notice with placeholders, marked for legal review.
- Footer: Cookie policy · Privacy notice · Cookie settings · Stop receiving calls.

### 3.3 Checks

The automated run (`cc.js`), at desktop and mobile:

- The banner appears on first visit.
- Manage → turn on Preferences → Save sets the cookie with `preferences:true, analytics:false`.
- The banner does not return after a choice is made.
- With consent, the calculator remembers its inputs.
- Reject from the footer deletes the stored inputs, and the calculator goes back to its defaults.
- With GPC on, "Accept all" still stores `analytics:false`.
- No overflow.

---

## Files added or changed in stages 2–3

```
src/assets/js/dashboard.js      rewritten (groups, TTS, caller IDs, templates, recurring, settings)
src/assets/css/dashboard.css    new component styles
src/pages/dashboard.html        sidebar sections
src/assets/js/consent.js        new
src/assets/css/styles.css       consent banner, dialog, policy tables
src/assets/js/main.js           calculator remembers inputs with consent
src/partials/site.html, app.html, footer.html
src/pages/cookies.html, privacy.html        new
src/pages/how-it-works.html, church.html, political.html   feature copy
docs/*                           this documentation
```

---

## Stage 4 — Excel (.xlsx) contact files (31 Oct 2026)

**Request:** Accept .xlsx files with a name column and a phone column.

### 4.1 Approach

- **Options considered:**
  - Bundle SheetJS (about 900 KB and a dependency to keep updated)
  - Ask users to convert to CSV (poor experience)
  - Write a small reader
- **Chosen:** a dependency-free reader, `src/assets/js/xlsx-reader.js` (about 200 lines). An .xlsx file is a ZIP of XML files. The reader finds the ZIP directory, inflates entries with the browser's built-in `DecompressionStream`, finds the first sheet through `workbook.xml` and its relationships, and parses shared strings and cells with `DOMParser`. It stays within the existing Content Security Policy (`script-src 'self'`) and loads only on the dashboard.
- **Safety:**
  - 5 MB file limit
  - 40 MB cap on decompressed size per part (zip bomb protection)
  - 50,000 rows and 50 columns
  - Rejects `.xls` and non-ZIP files with clear messages
  - All cell text is escaped before display, as before

### 4.2 Changes

- `dashboard.js`:
  - CSV parsing was split into `csvToRows()` and a shared `mapRows()`, so Excel and CSV go through the same column detection, cleaning, and deduplication.
  - `readContactFile()` picks the CSV or Excel path.
  - File inputs accept `.xlsx`, and the help text names the `name` and `phone` columns.
- Phone column detection was tightened: a header such as "Contact Name" is no longer mistaken for the phone column.
- Leading-zero warning: Excel strips the 0 from local numbers stored as numbers, so imports and uploads warn when numbers have only 9 digits and explain how to fix it.
- `src/assets/samples/contacts-sample.xlsx`: a downloadable template with `name` and `phone` columns (phone formatted as Text), offered next to the sample CSV.
- `app.html` loads `xlsx-reader.js` before `dashboard.js`.

### 4.3 Checks (`tests/excel-import.js`)

| File | Result |
|---|---|
| 250 contacts, numeric and spaced text phones, Unicode names, blank rows, invalid and duplicate rows, second sheet | 250 added, 2 invalid, 1 duplicate; numeric `233240000005` read in full; "Ama Ɔfori" kept; second sheet ignored ✓ |
| No header row, phone in column A | 5 added; names taken from column B ✓ |
| "Contact Name", "Phone Number", "Church" headers | Name, phone, and company mapped correctly ✓ |
| Local numbers stored as numbers (244123456) | Imported with the 9-digit warning ✓ |
| Fake `.xls` | "Older .xls files are not supported…" ✓ |
| Text file renamed `.xlsx` | "This file is not a valid Excel workbook…" ✓ |
| Wizard upload of the first file | 250 to call, 1 duplicate, 2 invalid ✓ |

The earlier dashboard and site tests were run again and still pass.

---

## Stage 5 — Sign-in and Supabase (31 Oct 2026)

**Request:** Build the login page for the public, with secure Google sign-in, email and password, and phone sign-up/sign-in, using the BMS SMS API to send codes, all aligned to Supabase.

### 5.1 Research and decisions
- **Supabase phone auth with a custom SMS provider:** Supabase's built-in SMS providers don't include BMS, but the **Send SMS Hook** (Authentication → Hooks) lets an HTTP endpoint deliver the code. The endpoint is a Supabase Edge Function that verifies the Standard Webhooks signature and calls BMS. Details came from Supabase's Auth Hooks documentation (secret format `v1,whsec_…`, headers, 5-second budget, retry rules, JSON content type required).
- **BMS API:** developer.bms.africa renders with JavaScript only, so its text could not be read here. BMS is mNotify's platform, so the function uses mNotify's documented quick-SMS request shape (`recipient[]`, `sender`, `message`, `is_schedule`, `schedule_date`; success is `status: "success"` / `code: "2000"`), with the URL and auth style configurable (`BMS_API_URL`, `BMS_AUTH_MODE`). **Confirm these against your BMS account before going live.**
- **Supabase client in the browser:** supabase-js 2.117.3, the browser build, self-hosted in `assets/vendor/` (218 KB, no `eval`). This keeps the strict CSP (`script-src 'self'`) instead of loading from a CDN.
- **Configuration:** `build.py` now reads `.env` (public values only) and writes `assets/js/config.js`. The CSP `connect-src` is widened only to the configured Supabase host, and to Cloudflare only if Turnstile is set.
- **Flows:**
  - PKCE for Google.
  - `token_hash` email links, so confirmation and reset work across devices.
  - Phone codes through `signInWithOtp` / `verifyOtp`. Sign-up allows creating a user; sign-in doesn't.

### 5.2 Built
- **Pages:** `login.html`, `signup.html`, `forgot-password.html`, `reset-password.html`, `auth-callback.html`, on a new "auth" layout (brand panel plus form card, single column on mobile).
- **`auth.js` features:**
  - Email/Phone tabs (keyboard accessible)
  - Google button
  - Password show/hide, strength meter and live rules
  - Country code picker with E.164 normalization (Ghana by default, configurable)
  - 6-digit code entry with `autocomplete="one-time-code"`, 60-second resend cooldown, and a 5-attempt limit
  - Optional Turnstile
  - Friendly errors that don't reveal accounts
  - Open-redirect-safe `next`
  - The dashboard session guard: redirects to sign-in and returns to the same dashboard tab, plus an account menu with sign-out
- **Supabase:**
  - `supabase/migrations/…_init.sql`: profiles, workspaces and roles, every dashboard entity, campaign rules enforced in the database, a private audio bucket, API keys stored as hashes, and an SMS log stored as hashes. RLS is on every table.
  - `supabase/functions/send-sms`: the hook that sends codes through BMS.
  - `supabase/config.toml` and branded email templates.
- **Pages updated:**
  - The header "Sign in" and footer links now go to the new pages.
  - The cookie policy lists the sign-in storage.
  - The privacy notice covers account data, BMS, and Supabase.
- **Docs:** `docs/AUTH-SUPABASE.md`, the full setup guide and security design.

### 5.3 Checks
- **Database** (PostgreSQL 16 with an `auth`/`storage` stand-in): the migration applies cleanly, and all 23 access checks pass. A first run flagged two UPDATE cases as failures; they had actually been blocked (0 rows changed), so the test was corrected to check row counts.
- **Edge Function** (Deno 2.5, fake BMS and fake Supabase): all 8 scenarios behave as designed, `deno check` passes, and no codes or full numbers appear in the logs.
- **Pages** (Playwright, mocked Supabase Auth, desktop and mobile): all flows pass, as listed in AUTH-SUPABASE.md.
  - **Bug found and fixed:** sign-out triggered two redirects at once.
  - **Messages corrected:** a wrong code was described as "expired", and field errors stayed visible after they were fixed.
- **Demo mode** (no `.env`): the sign-in pages explain how to connect Supabase, and the dashboard keeps working.

---

## Stage 6 — Backend: campaign delivery through BMS (1 Nov 2026)

**Request:** Start the backend; BMS provides API keys (developer.bms.africa).

### 6.1 Reading the BMS API
- developer.bms.africa only renders with JavaScript, which is why it couldn't be read in stage 5. This time it was opened in the built-in browser and read in full.
- **Confirmed:**
  - base URL `https://api.mnotify.com/api`, key as `?key=`
  - `POST /sms/quick`, `POST /voice/quick` (multipart, `file` or `voice_id`)
  - `GET /calls/<id>` per-number voice results (`pending` / `received` / `missed`)
  - `GET /balance/voice`, sender ID registration, IVR scenarios
- **Changed the design:**
  - OTP texts need `sms_type: "otp"` and an OTP-registered sender ID.
  - Voice sends have no caller ID setting, no text-to-speech, no retries or calling window, and no webhook.

### 6.2 Built
- `_shared/bms.ts`: one client for every BMS call, with timeouts and status mapping. `send-sms` now uses it and sends `sms_type: "otp"`.
- **Migration `20261101000000_bms_delivery.sql`:**
  - the `campaign_dispatches` table and delivery columns
  - BMS ids on audio and results
  - clients may add recipients for file campaigns before start
  - four service-role-only SQL functions: `claim_campaign_work` (15-minute lease), `snapshot_recipients`, `dispatch_targets`, `finish_campaign_run` (repeats)
- `_shared/delivery.ts`:
  - `dispatch()`: calling window, balance check, TTS pause, chunked sends with voice-id reuse
  - `sync()`: polling, result mapping, 6-hour timeout, retries, finishing the run
- `_shared/store.ts`: the Supabase data access behind both.
- **Edge Functions** `dispatch-campaigns` (every minute) and `sync-reports` (every 2 minutes), protected by `CRON_SECRET`, plus `supabase/cron.sql` (pg_cron + pg_net + Vault).
- `docs/BMS-INTEGRATION.md`: the full guide.

### 6.3 Checks
- **SQL functions** (`delivery_test.sql`, PostgreSQL 16): 14/14.
  - Two early failures were test-data mistakes (an earlier test's contact and group leaking into the campaign), not function bugs; the test was fixed.
- **Logic** (`delivery-harness.ts`, Deno + fake BMS): 27/27.
  - An apparent off-by-one turned out to be the fake network rejecting two numbers instead of one. The fake's rule was narrowed, and an exact count check added.
- **Full stack** (`integration.ts`, real supabase-js → PostgREST 12.2.8 → Postgres → fake BMS): 11/11, first run.
- **Sign-in SMS** (send-sms harness): passes, with `sms_type: "otp"` in the request.
- **Type check:** `deno check` passes for all three functions.
- **Bugs found and fixed during review:**
  - **Race:** the report syncer could finish a campaign while a large list was still being sent in chunks. Fixed with the claim lease.
  - **Wording:** "1 numbers" in events.

### 6.4 Still to do (in BMS-INTEGRATION.md)
1. Connect the dashboard to Supabase (this backend picks up campaigns saved there).
2. Caller ID from your BMS account.
3. A text-to-speech engine.
4. Opt-out by keypress (IVR).
5. Call-back handling.
6. Client credit.

## Stage 6 — Internal staff backend (1 Nov 2026)

**Request:** The application is for internal use; recheck what the backend needs, then build what can be built.

### 6.1 Decisions
- **Staff only.** Sign-up is off; admins invite staff (`staff-admin` function). Roles: admin and operator. Non-staff accounts that sign in see nothing.
- **Clients instead of personal workspaces.** The `workspaces` table now means clients, so existing keys and policies stay valid. `is_member()` and `has_role()` were redefined to mean "active staff" and "admin", which moved every policy to the new model at once.
- **Dropped:** API keys and per-user workspaces (self-service features).
- **Kept for the public site:** the campaign request form and a new "stop receiving calls" form, both as rate-limited Edge Functions.
- **Phone numbers** normalised to `+233…` in the database and the dashboard (fixes duplicates between `0244…`, `233244…` and Excel's `244…`).
- **Dashboard wiring:** a data layer (`store.js`) loads one client into the shape the dashboard already used and writes back only what changed, one write at a time. The screens didn't need rewriting.

### 6.2 Built
- Migration `20261101120000_internal_staff.sql`: staff, clients, phone normalisation, all-clients opt-outs, caller ID review by admins, consent basis and stamping, delivery queue and dialer functions, cost views, `upsert_contacts()`, campaign requests, rate limits, audit log, and triggers that keep recipient status right for the BMS pipeline.
- Edge Functions: `request-form`, `opt-out`, `staff-admin`, `dialer`, `call-status`; shared helpers and a provider adapter with a simulator.
- Dashboard: client switcher, Clients, Campaign requests, Team, Audit log; consent basis step; server results with filters, export and polling; real audio upload with a content check; monthly airtime; admin-only approvals and removals.
- Site: sign-up page replaced by an invitation notice; opt-out form on the contact page; request form posts to the function.

### 6.3 Checks
- SQL (PGlite, real migrations): 41 checks, with and without the BMS migration.
- Edge Functions (Deno, real functions, PGlite behind a stand-in REST API): 19 checks.
- Connected dashboard (Chromium, real RLS through a stand-in Supabase API): 38 checks, covering admin, operator on a phone, and a non-staff account.
- Demo dashboard, Excel import, cookie consent and sign-in page tests re-run: all pass. Tests updated for the consent-basis step, the removed API settings, and the invitation-only sign-up page.
- **Bugs found and fixed:**
  - An empty consent basis passed the database rule.
  - A name clash in `dialer_claim`.
  - The skipped filter returned nothing.
  - New recordings were missing from the audio library until a reload.
  - Screen-reader labels inside tables widened the page on phones.

### 6.4 Coordination note
Another session added the BMS delivery pipeline to this folder at the same time and replaced `supabase/cron.sql` with its own schedule. My migration was renamed to `20261101120000_…` so the two don't share a version number. Its tests `delivery_test.sql` and `integration_seed.sql` still seed through the removed `workspace_members` table and need updating to the staff model.

## Stage 7 — Client assignments and a staff-only front door (1 Nov 2026)

**Request:** Admins add staff from the dashboard and assign clients to them; staff see only their assigned clients. Remove sign-in from the public website.

- Migration `20261101140000_client_assignments.sql`: `client_assignments` table; `is_member()` now means "admin, or assigned to this client", which every client-data policy (and audio storage) already uses. Only admins add clients; operators edit only assigned ones. Website requests became admin-only.
- `staff-admin`: new `create` action (account with a temporary password, no email needed).
- Dashboard Team page: add staff by temporary password (default) or invitation; **Assign clients** per operator. Clients page: admins see who is assigned; operators see only their clients, or a "no clients assigned" message.
- Website: "Sign in" removed from the header and footer. Staff open `/login.html` directly (the page is excluded from search engines).
- **Bugs found and fixed:** the Clients page could redraw while someone typed. Adding a client failed because the membership check looked up the client row before it was visible to the inserting statement.
- Checks: SQL 49/49 (including operator isolation for reads, writes and edits), connected dashboard 43/43.

## Re-running the checks

The scripts used for every check above are in `tests/`. See `tests/README.md`.
