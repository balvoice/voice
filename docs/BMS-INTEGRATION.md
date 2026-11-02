# BMS integration (backend)

BalVoice uses **BMS Africa** (mNotify) for two things:
- **SMS:** sign-in codes, through the `send-sms` Auth hook.
- **Voice:** broadcast campaigns, through the `dispatch-campaigns` and `sync-reports` Edge Functions.

Contacts, groups, campaigns, and results live in **Supabase**. BMS is used only to deliver.

Source: the BMS API v2.0 documentation at https://developer.bms.africa/, read on 1 Nov 2026.

---

## What the BMS API provides (and what it doesn't)

| BMS API | Endpoint | Used by BalVoice |
|---|---|---|
| Auth | API key as a query parameter `?key=…` on every request | ✅ (`BMS_API_KEY` secret) |
| Quick SMS | `POST /sms/quick` — `recipient[]`, `sender`, `message`, `is_schedule`, `schedule_date`, `sms_type` | ✅ sign-in codes, with `sms_type: "otp"` |
| Sender ID registration | `POST /senderid/register` — `sender_name`, `purpose`, `otp_url` | Done once, by you (see below) |
| Quick voice | `POST /voice/quick` (multipart) — `campaign`, `recipient[]`, `file` **or** `voice_id`, `is_schedule`, `schedule_date` → returns campaign `_id` and `voice_id` | ✅ every campaign send |
| Group voice | `POST /voice/group` (uses BMS-side groups) | ❌ groups live in Supabase; BalVoice sends the number list |
| Voice report | `GET /calls/<campaign_id>` → per number: `status` (`pending` / `received` / `missed`), `total_duration`, `answer_time`, `retries` | ✅ polled by sync-reports |
| Voice balance | `GET /balance/voice` | ✅ checked before each dispatch |
| IVR scenarios | `/ivr-scenario…` outbound flows with keypress (DTMF) routes | Not yet; see "Opt-out by keypress" |
| IVR inbound | your callback URL returns actions (playback, get_digits, dial, hangup…) | Not yet; see "Call-backs" |
| Contacts, groups, templates, USSD | various | Not used |

**Gaps that shape the design:**
1. **No caller ID parameter on voice sends.** BMS decides which number your calls come from. A dedicated caller ID has to be arranged with BMS for your account; it can't be chosen per campaign through the API. The dashboard's caller ID picker must be changed to reflect this (see "Next steps").
2. **No text-to-speech.** BMS voice needs an audio file. Text-to-speech campaigns are paused with a clear message until a speech engine is added to turn text into audio before sending.
3. **No delivery webhook for voice.** Results are fetched by polling `/calls/<id>` every 2 minutes.
4. **No calling-window or retry settings.** BalVoice enforces the calling window and retries itself, so a retry is a new BMS send to the unanswered numbers only, reusing the `voice_id` so the audio isn't uploaded again.
5. **OTP rules.** Sign-in codes must be sent with `sms_type: "otp"` from a sender ID registered as an OTP sender (with an `otp_url`). BMS rejects them otherwise. BMS charges 0.035 extra per OTP send.

---

## How a campaign is delivered

```
pg_cron (every minute) ──► dispatch-campaigns
   claim_campaign_work()        due campaigns → running (15-min lease; no double sends)
   calling window?              outside → wait until it opens
   BMS voice balance > 0?       empty → wait 30 min, event shown to client
   audio file?                  text-to-speech → paused with explanation
   snapshot_recipients()        groups → deduplicated list, opt-outs removed (first attempt)
   dispatch_targets()           everyone not yet answered and not opted out
   POST /voice/quick            chunks of 500; first uploads audio, rest reuse voice_id
   campaign_dispatches rows     BMS campaign id + exact recipient ids per chunk

pg_cron (every 2 minutes) ──► sync-reports
   GET /calls/<id>              for each open send
   call_results upsert          received → answered, missed → no answer, busy, others → unreachable
   send is final when           no number is pending, or 6 hours have passed (pending → no answer)
   numbers BMS never reported   → unreachable ("not_reported")
   all sends final?             unanswered and retries left → next attempt after retry interval
                                otherwise finish_campaign_run() → completed, or next repeat scheduled
```

Opt-outs are checked when the list is frozen and again before every retry. A number added to the register mid-campaign is never called again.

---

## Setup

### 1. BMS account
1. Get your API key from the BMS dashboard. Keep it secret; it controls your credit.
2. **Register an OTP sender ID** for sign-in codes (once):
   ```bash
   curl -X POST "https://api.mnotify.com/api/senderid/register?key=YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"sender_name":"BALVOICE","purpose":"Sign-in verification codes for BalVoice accounts","otp_url":"https://your-domain.com/login.html","is_otp":true}'
   ```
   Wait until its status is **Approved** (`POST /senderid/status`). The `otp_url` can only be set once, so check it first.
3. Top up **voice credit** (balance at `GET /balance/voice`).
4. Ask BMS about a **dedicated caller ID** for your voice campaigns (the API can't set one).

### 2. Database
```bash
supabase db push      # applies 20261031000000_init.sql and 20261101000000_bms_delivery.sql
```

### 3. Functions and secrets
```bash
supabase functions deploy send-sms --no-verify-jwt
supabase functions deploy dispatch-campaigns --no-verify-jwt
supabase functions deploy sync-reports --no-verify-jwt

supabase secrets set \
  BMS_API_KEY='…' \
  BMS_SENDER_ID='BALVOICE' \
  CRON_SECRET="$(openssl rand -hex 32)" \
  SEND_SMS_HOOK_SECRETS='v1,whsec_…' \
  ALLOWED_PHONE_PREFIXES='233'
# optional: BMS_CHUNK_SIZE=500  REPORT_TIMEOUT_HOURS=6  SMS_MAX_PER_HOUR=5  OTP_EXPIRY_MINUTES=10
```
`--no-verify-jwt` is required because pg_cron and the Auth hook call these without a user session. Each function checks its own secret instead: `CRON_SECRET` for the delivery functions, and the webhook signature for send-sms.

### 4. Schedule
Enable the **pg_cron** and **pg_net** extensions, then run `supabase/cron.sql` in the SQL editor, using your project URL and the same `CRON_SECRET`.

### 5. Watch it work
- **Function logs:** Edge Functions → dispatch-campaigns / sync-reports → Logs
- **Cron runs:** `select * from cron.job_run_details order by start_time desc limit 20;`
- **Per campaign:** the `campaign_events` table (shown as Activity in the dashboard), `campaign_dispatches`, `call_results`
- **Pause all delivery:** `select cron.unschedule('balvoice-dispatch-campaigns');`

---

## Files

```
supabase/functions/_shared/bms.ts           BMS API client (SMS, voice, reports, balance, status mapping)
supabase/functions/_shared/delivery.ts      dispatch() and sync() logic; calling window; retries
supabase/functions/_shared/store.ts         Supabase data access (service role)
supabase/functions/_shared/bms-provider.ts  Connects the client to the delivery logic
supabase/functions/_shared/cron-auth.ts     CRON_SECRET check (constant-time)
supabase/functions/dispatch-campaigns/      Edge Function, every minute
supabase/functions/sync-reports/            Edge Function, every 2 minutes
supabase/functions/send-sms/                Auth hook for sign-in codes (sms_type "otp")
supabase/migrations/20261101000000_bms_delivery.sql   dispatches table, delivery columns, SQL functions
supabase/cron.sql                           pg_cron jobs
supabase/tests/delivery_test.sql            SQL function tests
supabase/tests/delivery-harness.ts          Logic tests: fake BMS + in-memory store
supabase/tests/integration.ts               Full stack: supabase-js → PostgREST → Postgres → fake BMS
```

---

## Testing done

| Test | Result |
|---|---|
| `delivery_test.sql` on PostgreSQL 16 | 14/14. Claim once only; overlapping groups deduplicated; opt-outs in other formats removed; retries target only the unanswered and skip new opt-outs; weekly repeat reschedules, then completes after the end date; clients cannot call the functions |
| `delivery-harness.ts` (Deno, fake BMS) | 27/27. Calling window maths; 1,202 numbers in 3 chunks; audio uploaded once, then the voice id is reused; API key on every request; every number gets a result (1 network-rejected → unreachable); retry after 30 min to the 170 unanswered only; run finishes; outside hours → deferred to 09:00; TTS → paused; empty balance → waits; BMS error → retries in 10 min; pending after 6 h → no answer |
| `integration.ts` (supabase-js → PostgREST 12.2.8 → Postgres, fake BMS) | 11/11. Cron secret enforced; dispatch rows, voice id, call results, retry, and completion all written through the real Supabase client and schema |
| `send-sms-harness.ts` | Request now includes `sms_type: "otp"`; all earlier checks still pass |
| `deno check` | All three functions type-check |

Not yet tested against the live BMS API. The first real campaign should go to a small internal group, to confirm the exact `status` values BMS returns (the docs list `pending`, `received`, `missed`).

---

## Next steps

1. **Connect the dashboard to Supabase.** Campaigns created in the dashboard need to be saved to these tables, and audio uploaded to the `campaign-audio` bucket, for this backend to pick them up.
2. **Caller ID:** replace the per-campaign picker with your BMS account's assigned number (and a number pool later, if you move to your own SIP trunk).
3. **Text-to-speech:** choose an engine that supports Twi, Hausa, and Ewe, render audio before dispatch, and store it like an uploaded recording.
4. **Opt-out by keypress:** use a BMS outbound IVR scenario ("press 9 to stop these calls") and record the keypress on the opt-out register. Needs testing with BMS on how keypress results are reported.
5. **Call-backs:** point your BMS inbound IVR callback at a new Edge Function that plays "This is BalVoice on behalf of…" and offers an opt-out.
6. **Credit:** charge clients per answered minute from a prepaid balance, and alert when BMS voice credit runs low.
