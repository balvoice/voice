> **Superseded (1 Nov 2026).** BalVoice is now an internal tool, so there is no public API or customer webhooks. The dashboard talks to Supabase directly under Row Level Security; see [INTERNAL-BACKEND.md](INTERNAL-BACKEND.md). This proposal is kept for reference.

# API design (proposal)

A proposed REST API behind the dashboard. Not implemented yet. The dashboard prototype's screens map one-to-one onto these resources.

## Conventions

- Base URL: `https://api.<your-domain>/v1`
- Authentication: `api-key: <key>` header (server-to-server) or a session cookie (dashboard). Keys are stored hashed, can be revoked, and are scoped per account.
- JSON in and out. Times in ISO 8601 UTC. Phone numbers in E.164 format (`+233…`).
- Errors: `{"error": {"code": "invalid_phone", "message": "…", "field": "phone"}}` with 4xx/5xx status codes.
- Rate limits per key; `429` responses include a `Retry-After` header.

## Contacts and groups

| Method | Path | Purpose |
|---|---|---|
| GET | `/groups` | List groups with member counts |
| POST | `/groups` | Create `{name, description}` (unique name per account) |
| PATCH | `/groups/{id}` | Rename or describe |
| DELETE | `/groups/{id}` | Delete the group (contacts are kept) |
| GET | `/groups/{id}/contacts?q=&cursor=` | List members |
| POST | `/groups/{id}/contacts` | Add contacts `[{phone, first_name, last_name, company, email}]`; matched on phone |
| POST | `/groups/{id}/imports` | Upload a CSV (multipart); returns an import job with added/updated/invalid/duplicate counts |
| POST | `/groups/{id}/contacts:remove` | `{contact_ids: []}` |
| POST | `/groups/{target}/contacts:copy` | `{contact_ids: [], move_from?: groupId}` |
| GET | `/contacts?q=&group=` | Phonebook |
| DELETE | `/contacts/{id}` | Delete everywhere |

## Messages

| Method | Path | Purpose |
|---|---|---|
| POST | `/audio` | Upload MP3/WAV (max 10 MB, 3 min); scanned and transcoded; returns `{id, duration}` |
| GET/POST/PATCH/DELETE | `/templates` | Text-to-speech scripts |

## Caller IDs

| Method | Path | Purpose |
|---|---|---|
| GET | `/caller-ids` | List with status `pending` / `approved` / `rejected` |
| POST | `/caller-ids` | Request `{type: "brand" \| "number", value, purpose}` |
| DELETE | `/caller-ids/{id}` | Remove |

## Campaigns

| Method | Path | Purpose |
|---|---|---|
| POST | `/campaigns` | Create (see body below) |
| GET | `/campaigns/{id}` | Status and counts |
| POST | `/campaigns/{id}:start` / `:pause` / `:resume` / `:cancel` | Control |
| POST | `/campaigns/{id}/test-calls` | `{phone}` — place a test call |
| GET | `/campaigns/{id}/results?outcome=&cursor=` | Per-number results |
| GET | `/campaigns/{id}/report.csv` | Export |

```json
{
  "name": "Sunday reminder",
  "type": "church",
  "sender": "Grace Chapel",
  "caller_id": "cid_123",
  "message": { "type": "tts", "language": "en", "voice": "female",
               "text": "Hello {first_name|friend}, ..." },
  "recipients": { "group_ids": ["grp_123", "grp_456"] },
  "schedule": { "start": "2027-01-10T10:00:00Z", "window": ["09:00", "19:00"],
                "timezone": "Africa/Accra", "retries": 2, "retry_interval_min": 30,
                "repeat": "weekly", "repeat_until": "2027-02-10" },
  "compliance": { "consent_confirmed": true, "sender_identified": true, "optout_included": true },
  "webhook_url": "https://example.org/voice-status"
}
```

The server rejects campaigns without all three compliance confirmations, and removes opted-out numbers at creation **and** at dial time.

## Webhooks

Each finished call is POSTed to `webhook_url`:

```json
{ "event": "call.completed", "campaign_id": "cmp_1", "phone": "+233200000000",
  "outcome": "answered", "attempt": 1, "duration_sec": 42, "at": "2027-01-10T10:03:12Z" }
```

Requests are signed with an `X-Signature` header (an HMAC-SHA256 of the body using a per-account secret) and retried with backoff on failure. Other events: `campaign.started`, `campaign.completed`, `balance.low`.

## Opt-outs

| Method | Path | Purpose |
|---|---|---|
| GET | `/opt-outs` | List |
| POST | `/opt-outs` | `{phone, source}` — also created automatically from a keypress during a call |
| DELETE | `/opt-outs/{phone}` | Remove (logged, requires confirmation) |
