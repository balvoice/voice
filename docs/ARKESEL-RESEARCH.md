# Arkesel feature research

Research done on 31 Oct 2026 to find features from Arkesel (a Ghanaian SMS and voice messaging platform) worth bringing into BalVoice. Only feature ideas were used. No Arkesel text, prices, branding, or design were copied.

## Sources

- [Voice SMS Ghana — arkesel.com/voice-sms](https://arkesel.com/voice-sms/)
- [Bulk SMS Service in Africa — arkesel.com/bulk-sms](https://arkesel.com/bulk-sms/)
- [Developer APIs — arkesel.com/developer-api](https://arkesel.com/developer-api/)
- [Personalize Bulk SMS Messages — arkesel.com](https://arkesel.com/personalizing-bulk-sms-messages-to-enhance-customer-experience/)
- [arkesel-python usage docs](https://arkesel-python.readthedocs.io/en/latest/usage.html)
- [arkesel-js on npm](https://npmjs.com/package/arkesel-js)

Website features change. Re-check these pages before relying on any detail.

## What Arkesel offers (as published)

### Voice SMS
- Record a message, upload MP3 or WAV, or type text and convert it to speech.
- Text-to-speech in English, Twi, Hausa, Ewe, "and more".
- Send to an uploaded list, a saved group, or segments.
- Automatic retries for unanswered calls.
- Scheduled and recurring broadcasts.
- Real-time call status (answered, missed, failed) and exportable reports.
- Caller ID: a brand name or a local number.
- API: JSON, text-to-speech or an audio URL, call status webhooks.
- Published pricing model: per minute, billed per second, answered calls only, no monthly fee.

### Contacts and groups
- Contacts are uploaded (CSV or Excel) or synced, then organized into contact groups.
- Campaigns target groups instead of the whole contact list.
- Contact fields (first name, last name, company, phone, email, …) power personalization.
- Advice: check groups for blank fields before personalizing, and send yourself a test first.
- API methods: `create_contact_group(group_name)`, `add_contact_to_group(group_name, contacts[{phone_number}])`, `send_group_sms`.

### Other platform features
- Templates (industry and seasonal), AI message drafting.
- Custom sender IDs, registered in the account.
- Credits with volume discounts; low balance alerts by webhook or email.
- API keys sent in an `api-key` header, with multiple keys and per-key permissions.
- Sandbox that simulates delivery without spending credit.
- OTP, USSD, WhatsApp, email, IVR/call centre, CRM.

## Decisions for BalVoice

| Arkesel feature | BalVoice | Where |
|---|---|---|
| Contact groups / phonebook | ✅ Adopted — global phonebook, contacts belong to any number of groups | Dashboard → Contact groups, All contacts |
| Import contacts from file | ✅ CSV import into a group; matches on phone, fills empty fields, reports added/updated/invalid/duplicate/opted-out | Group detail |
| Send to saved groups | ✅ Choose one or more groups; duplicates across groups removed | Wizard → Recipients |
| Save uploaded list as group | ✅ Optional "Save these contacts to a group" (new or existing) | Wizard → Recipients |
| Text-to-speech, local languages | ✅ English, Twi, Hausa, Ewe; male/female voice; browser preview for English | Wizard → Message |
| Personalization with contact fields | ✅ `{first_name}`, `{last_name}`, `{full_name}`, `{company}`, with fallback `{first_name\|friend}` | Wizard → Message, Templates |
| Check blanks before sending | ✅ Warning counts contacts missing a field that has no fallback | Wizard → Recipients |
| Templates | ✅ Four starter scripts (read-only) plus your own | Dashboard → Templates |
| Caller ID (brand or number) | ✅ Request → under review → approved; choose per campaign | Dashboard → Caller IDs |
| Scheduling | ✅ Already present; kept | Wizard → Schedule |
| Recurring broadcasts | ✅ Daily, weekly, monthly with an end date; each run re-reads the group | Wizard → Schedule, campaign detail |
| Retries | ✅ Already present; kept | Wizard → Schedule |
| Real-time status, export | ✅ Already present; added billable minutes and estimated cost | Campaign detail, Reports |
| Send a test | ✅ "Call me" test call on Review (simulated) | Wizard → Review |
| Answered-only, per-second billing | ✅ As configurable settings, **not** as BalVoice prices | Settings & API, Pricing calculator |
| API key in `api-key` header, webhooks | ✅ Settings preview and API design doc; not live | Settings & API, [API-DESIGN.md](API-DESIGN.md) |
| Low balance alerts | ✅ Alert email field (preview) | Settings & API |
| Sandbox | ➖ The whole prototype behaves as a sandbox (simulated delivery) | — |
| Follow up the unreached | ✅ BalVoice addition: save non-answered contacts as a new group | Campaign detail |
| Segments | ➖ Covered by groups; rule-based segments left for later | — |
| Birthday automation | ❌ Not adopted — needs a server scheduler and stored birth dates | — |
| AI message drafting | ❌ Not adopted — conflicts with the human-crafted brand direction | — |
| Wallet / credit top-up | ❌ Not adopted — no payments in the prototype; would need a payment provider | — |
| SMS, OTP, USSD, WhatsApp, email, IVR | ❌ Out of scope — BalVoice is a voice broadcast service | — |

## Notes for production

- Text-to-speech in Twi, Hausa, and Ewe needs a speech engine that supports those languages. Browser speech synthesis covers English only, which is why the preview is limited.
- Caller ID display depends on network operator rules. Approval should include proof of ownership.
- Recurring campaigns need a server-side scheduler. In the prototype, the next run is triggered by hand.
