# Sign-in and Supabase setup

BalVoice uses **Supabase** for accounts, the database, and file storage. Visitors can create an account and sign in three ways:

| Method | How it works |
|---|---|
| **Google** | "Continue with Google" → Google consent screen → back to `auth-callback.html` (PKCE flow) |
| **Email + password** | Sign up → confirmation email → sign in. Forgot password → reset link → `reset-password.html` |
| **Phone** | Enter number → Supabase generates a 6-digit code → the **send-sms Edge Function** delivers it through **BMS** → enter code |

Until Supabase is configured, the sign-in pages show a "not connected yet" notice and the dashboard stays in demo mode.

---

## What's in the project

```
.env.example                         Public website settings (copy to .env)
build.py                             Reads .env, writes dist/assets/js/config.js, sets the CSP
src/pages/login.html                 Sign in (Google · Email · Phone)
src/pages/signup.html                Create account (Google · Email · Phone)
src/pages/forgot-password.html       Request a reset link
src/pages/reset-password.html        Choose a new password
src/pages/auth-callback.html         Finishes Google sign-in and email links
src/assets/js/auth.js                All sign-in logic + dashboard session guard
src/assets/vendor/supabase-js-2.117.3.js   Supabase client (self-hosted; CSP allows only 'self' scripts)
supabase/config.toml                 Auth settings for the Supabase CLI (mirror them in the dashboard)
supabase/migrations/…_init.sql       Database schema, Row Level Security, storage bucket
supabase/functions/send-sms/index.ts Send SMS Hook → BMS SMS API
supabase/templates/*.html            Branded confirmation / reset / email-change emails
```

---

## Setup, step by step

### 1. Create the Supabase project
1. Create a project at supabase.com. Choose the region closest to your users.
2. **Project Settings → API**: copy the **Project URL** and the **anon public** key.

### 2. Configure the website
```bash
cp .env.example .env
# edit .env:
SITE_URL=https://your-domain.com
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=<anon public key>
ALLOWED_PHONE_COUNTRIES=GH
python3 build.py      # prints "Supabase connected"
```
The anon key is meant to be public; Row Level Security protects the data. **Never** put the service-role key, the BMS API key, or the Google client secret in `.env`.

### 3. Create the database
With the [Supabase CLI](https://supabase.com/docs/guides/cli):
```bash
supabase link --project-ref <ref>
supabase db push            # runs supabase/migrations/…_init.sql
```
Or paste the migration into **SQL Editor** and run it once.

### 4. Authentication settings (dashboard)
**Authentication → URL Configuration**
- Site URL: `https://your-domain.com`
- Redirect URLs: `https://your-domain.com/auth-callback.html`, `https://your-domain.com/reset-password.html` (add `http://127.0.0.1:8000/...` for local testing)

**Authentication → Sign In / Providers → Email**
- Enable email provider, **Confirm email: on**, **Secure email change: on**
- Minimum password length **10**, require **lowercase, uppercase and digits** (matches the sign-up form)
- Turn on **leaked password protection** if your plan includes it

**Authentication → Emails → SMTP**
- Set up **custom SMTP** (for example your domain's mail provider). The built-in mailer is limited to a few emails per hour and is for testing only.

**Authentication → Emails → Templates**: paste the files from `supabase/templates/`:
| Template | File | Subject |
|---|---|---|
| Confirm signup | `confirm-signup.html` | Confirm your BalVoice account |
| Reset password | `reset-password.html` | Reset your BalVoice password |
| Change email | `change-email.html` | Confirm your new email address |

These use `token_hash` links, so they work even if the email is opened on a different phone or computer.

### 5. Google sign-in
1. In Google Cloud Console → **APIs & Services → OAuth consent screen**: set the app name (BalVoice), support email, logo, and privacy policy URL (`/privacy.html`). Scopes: `openid`, `email`, `profile` only.
2. **Credentials → Create OAuth client ID → Web application**
   - Authorized JavaScript origins: `https://your-domain.com`
   - Authorized redirect URI: `https://<ref>.supabase.co/auth/v1/callback`
3. In Supabase **Authentication → Providers → Google**: enable, paste the client ID and secret.

### 6. Phone sign-in through BMS
1. **BMS account:** get your API key.
2. **Register an OTP sender ID** (max 11 characters, for example `BALVOICE`) with an `otp_url` pointing to your sign-in page. BMS only delivers one-time codes from OTP sender IDs, and the function sends them with `sms_type: "otp"` (BMS charges 0.035 extra per OTP send). The exact request is in [BMS-INTEGRATION.md](BMS-INTEGRATION.md#1-bms-account). Endpoint and format were confirmed from developer.bms.africa: `POST https://api.mnotify.com/api/sms/quick?key=…`.
3. **Enable phone auth:** Authentication → Providers → **Phone**: enable. Set SMS OTP expiry to 600 seconds (10 minutes) and OTP length 6.
4. **Create the hook:** Authentication → **Hooks → Send SMS hook → HTTP**
   - URL: `https://<ref>.supabase.co/functions/v1/send-sms`
   - Click **Generate secret** and copy it (it starts with `v1,whsec_`).
5. **Deploy the function and set its secrets:**
   ```bash
   supabase functions deploy send-sms --no-verify-jwt
   supabase secrets set \
     SEND_SMS_HOOK_SECRETS='v1,whsec_…' \
     BMS_API_KEY='…' \
     BMS_SENDER_ID='BALVOICE' \
     ALLOWED_PHONE_PREFIXES='233' \
     SMS_MAX_PER_HOUR='5' \
     OTP_EXPIRY_MINUTES='10'
   ```
   `--no-verify-jwt` is required because Auth calls the hook before a user session exists. The function checks the webhook signature instead.
6. **Test:** sign up with your phone on the site. To troubleshoot, check **Edge Functions → send-sms → Logs** (codes and full numbers are never logged).

### 7. Bot protection (strongly recommended)
Every SMS code costs money. Bots that request codes to premium numbers ("SMS pumping") can run up large bills. The country allow-list and per-number limit in the function help; a CAPTCHA closes the gap.
1. Create a **Cloudflare Turnstile** widget for your domain (free).
2. Supabase **Authentication → Attack Protection**: enable CAPTCHA, provider Turnstile, paste the **secret key**.
3. Add the **site key** to `.env` as `TURNSTILE_SITE_KEY=…` and rebuild. The forms show the check automatically, and the CSP is widened for Cloudflare only when a key is set.

### 8. Rate limits
**Authentication → Rate Limits**: keep the defaults or tighten them. Sensible starting points: 30 SMS per hour project-wide, 30 sign-ins per 5 minutes per IP, and token verifications at 30 per 5 minutes per IP.

---

## Security design

| Risk | Protection |
|---|---|
| Stolen passwords | Supabase stores bcrypt hashes; 10+ character policy with mixed case and digits; optional leaked-password check; resetting a password signs out other devices |
| Account discovery | Sign-up, forgot password, and phone sign-in show the same message whether or not an account exists |
| Phishing via redirects | `next` only accepts local pages (`dashboard.html#/…`); Supabase redirect URLs are allow-listed |
| OAuth interception | PKCE flow; the code verifier never leaves the browser |
| Session theft | Short-lived access tokens (1 h) with refresh token rotation; strict CSP (scripts only from this site); no inline scripts |
| SMS fraud and costs | CAPTCHA, country allow-list, a per-number hourly limit (hashed numbers), and project-wide SMS rate limits |
| Forged hook calls | Standard Webhooks signature verified on every request |
| Code brute force | 6-digit codes, 10-minute expiry, Supabase verification rate limits, and a 5-attempt limit on the form |
| Data access between clients | Row Level Security on every table; a workspace membership check on every row; storage folders per workspace |
| Privilege escalation | Clients cannot approve caller IDs, write call results, mark campaigns running/completed, or read API key hashes |
| Leaked logs | The Edge Function never logs codes or full phone numbers |

### Tested
- **Database:** the migration was applied to PostgreSQL 16 with a stand-in for Supabase's `auth` and `storage` schemas, then run through 23 access checks (`supabase/tests/rls_test.sql`): cross-workspace isolation, caller ID approval blocked, compliance required to schedule, status changes reserved for the delivery system, API keys stored as hashes, storage folder isolation, and no anonymous access.
- **Edge Function:** run in Deno against a fake BMS and a fake Supabase (`supabase/tests/send-sms-harness.ts`): valid send, bad signature rejected, other countries blocked, hourly limit, BMS rejection, BMS timeout within the 5-second budget, and no codes or numbers in the logs.
- **Pages:** Playwright against a mocked Supabase Auth (`tests/auth.js`), at desktop and mobile sizes. Covered: the redirect when signed out, wrong and right passwords, sign-out, phone code with a wrong and a right code, an invalid number, password rules, email and phone sign-up, forgot password, the Google redirect with PKCE, open-redirect protection, and an invalid reset link.

---

## Dashboard data (done)

The dashboard now reads and writes Supabase in connected mode, for staff only; sign-up is off and staff are invited. See [INTERNAL-BACKEND.md](INTERNAL-BACKEND.md). The table below is the original mapping, kept for reference.

Sign-in now protects the dashboard, but campaign data in the prototype is still kept in the browser. The schema is ready for it; each dashboard action maps to a table:

| Dashboard | Table(s) |
|---|---|
| Contact groups, All contacts | `contact_groups`, `contacts`, `contact_group_members` |
| Opt-out register | `opt_outs` |
| Caller IDs | `caller_ids` (approval by staff with the service role) |
| Templates | `message_templates` |
| Audio upload | Storage bucket `campaign-audio/<workspace_id>/…` + `audio_files` |
| Campaign wizard | `campaigns`, `campaign_groups` |
| Delivery, reports | `campaign_recipients`, `call_results`, `campaign_events` (written by the dialer) |
| Settings & API | `workspace_settings`, `api_keys` via `create_api_key()` |

The actual calling (the dialer that reads scheduled campaigns and writes results) runs server-side with the service role, for example as a scheduled Edge Function or a worker connected to your voice provider.
