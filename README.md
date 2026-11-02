# BalVoice website

Public marketing site and internal campaign dashboard for BalVoice automated voice broadcast services.

Plain HTML, CSS and JavaScript. No frameworks, no build dependencies. Python 3.8+ is only used to assemble pages from shared partials.

## Accounts and database

The dashboard is an **internal tool for BalVoice staff**. Nobody can sign up: an administrator invites each staff member. Staff run campaigns for **clients** (churches, campaign teams, organizations), each with its own contacts, campaigns and settings. Sign-in (Google, email and password, phone codes sent through BMS) and the database run on **Supabase**. Setup: [docs/AUTH-SUPABASE.md](docs/AUTH-SUPABASE.md) and [docs/INTERNAL-BACKEND.md](docs/INTERNAL-BACKEND.md). Without Supabase settings in `.env`, the site builds in demo mode.

## Quick start

```bash
cp .env.example .env         # add Supabase settings (optional for a demo)
python3 build.py              # writes the site to dist/
cd dist && python3 -m http.server 8000
# open http://localhost:8000
```

Deploy by uploading the contents of `dist/` to any static host.

## Structure

```
build.py                 Assembles src/pages + src/partials into dist/
src/
  partials/              Shared head, header, footer and page layouts
  pages/                 One file per page (metadata block at the top)
    index.html           Homepage
    church.html          Church & Evangelism Voice Broadcast
    political.html       Political & Civic Voice Broadcast
    how-it-works.html    Technology explanation (5-stage timeline)
    pricing.html         Campaign cost factors + calculator
    about.html           Company page (placeholders for missing info)
    contact.html         Campaign request form + opt-out instructions
    cookies.html         Cookie policy
    privacy.html         Privacy notice (draft, needs legal review)
    dashboard.html       Campaign dashboard prototype
    404.html
  assets/
    css/styles.css       Design system and site styles
    css/dashboard.css    Dashboard styles
    js/main.js           Navigation, scroll reveal, calculator, form validation
    js/consent.js        Cookie consent banner, preferences dialog, script gating
    js/xlsx-reader.js    Dependency-free Excel (.xlsx) reader for contact uploads
    samples/contacts-sample.xlsx   Template with name and phone columns
    js/dashboard.js      Dashboard (clients, groups, TTS, caller IDs, campaigns, reports, team, audit)
    js/store.js          Supabase data layer for the dashboard (connected mode)
    img/favicon.svg
  static/_headers        Security headers for Netlify / Cloudflare Pages
supabase/
  config.toml            Auth settings (CLI); mirror them in the Supabase dashboard
  migrations/            Schema, Row Level Security, storage; BMS delivery; internal staff model
  functions/send-sms/    Send SMS Hook: delivers sign-in codes through BMS
  functions/request-form/  Website campaign request form (validated, rate-limited)
  functions/opt-out/       Website "stop receiving calls" form (all-client opt-out register)
  functions/staff-admin/   Invite staff, change roles, deactivate accounts (admins only)
  functions/dialer/, call-status/  Provider-neutral per-call dialer (alternative to the BMS functions; not scheduled)
  functions/dispatch-campaigns/  Sends due campaigns to BMS voice (every minute)
  functions/sync-reports/        Pulls call results, retries, finishes runs (every 2 minutes)
  functions/_shared/     BMS client, delivery logic, Supabase data access
  cron.sql               Schedules the two delivery functions
  templates/             Branded confirmation and reset emails
  tests/                 Access-rule tests (SQL) and Edge Function harnesses
docs/
  AUTH-SUPABASE.md       Step-by-step Supabase, Google, BMS and Turnstile setup; security design
  INTERNAL-BACKEND.md    Staff accounts, clients, website endpoints, compliance records, audit log, costs
  BMS-INTEGRATION.md     What the BMS API offers, how campaigns are delivered, setup, tests
  PROCESS.md             Step-by-step log of everything done, with checks
  ARKESEL-RESEARCH.md    Arkesel features found, sources, what was adopted and why
  DASHBOARD-GUIDE.md     How to use the dashboard, how groups work, CSV format
  COOKIE-CONSENT.md      How consent works, adding analytics later
  API-DESIGN.md          Proposed REST API and webhooks behind the dashboard
tests/                   Playwright scripts used to check the site (see tests/README.md)
```

To change the header or footer on every page, edit the file in `src/partials/` and run `python3 build.py` again.

## Before going live

0. **Legal pages:** fill in and have a legal adviser review `cookies.html` and `privacy.html`. Consider self-hosting the fonts (see docs/COOKIE-CONSENT.md).

1. **Domain:** set `SITE_URL` in `build.py` (used for canonical links and the sitemap).
2. **Placeholders:** search for `[` in `src/` and replace every bracketed placeholder — contact details, company history, leadership, opt-out contact. Nothing has been invented; these need real information.
3. **Website forms:** the campaign request and opt-out forms post to the `request-form` and `opt-out` Edge Functions automatically once Supabase is configured. Set the functions' `SITE_URL` secret to your domain.
5. **First administrator:** after the first sign-in, run the SQL in docs/INTERNAL-BACKEND.md to make that account an admin; invite everyone else from the dashboard's Team page.
4. **Security headers:** if your host does not read `_headers`, add the same headers in your server config.

## Request form backend

The `request-form` Edge Function re-validates every field, ignores honeypot submissions, limits each IP (hashed, never stored raw) to 5 requests an hour, and stores the request with the time both consent boxes were confirmed. Staff see requests on the dashboard's **Campaign requests** page.

## Dashboard

`dashboard.html` covers the full campaign workflow: clients, contact groups and a phonebook, caller IDs, message templates, text-to-speech or uploaded audio with personalization, recurring schedules, delivery monitoring, reports with airtime by month, follow-up groups, the opt-out register, website campaign requests, the team, and the audit log. See [docs/DASHBOARD-GUIDE.md](docs/DASHBOARD-GUIDE.md).

- **Connected** (Supabase configured): only active staff can open it. Data is read and written through Row Level Security; the database repeats every rule (phone format, opt-outs, consent record, calling window, who may approve or remove what). Calls are placed by the delivery functions and results appear as they arrive.
- **Demo** (no Supabase settings): data stays in the browser and delivery is simulated. A banner says so.

The dashboard is excluded from search engines.

## Design notes

- Fonts: IBM Plex Sans and IBM Plex Mono (Google Fonts)
- Colours: navy/charcoal primary, professional blue, green for success states, white and soft grey backgrounds
- No stock photos, fake metrics, testimonials or invented customers
- Animations are limited to scroll reveals, hover states and a one-time fill on the hero panel, and they respect `prefers-reduced-motion`
- A strict Content Security Policy blocks inline scripts and styles
