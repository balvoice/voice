# Dashboard guide

`dist/dashboard.html` is a working prototype of the client dashboard. It runs entirely in the browser. Data is saved in `localStorage` under `balvoice.demo.v1`, no calls are placed, and delivery results are simulated. Use **Clear demo data** in the banner to start again.

## Typical workflow

1. **Contact groups → New group.** Name it (for example "Members") and add a description.
2. **Add contacts to the group,** one at a time or by importing an Excel (.xlsx) or CSV file. **Sample Excel file** and **Sample CSV** show the format: a `name` column and a `phone` column.
3. **Caller IDs** *(optional)*. Request a brand name or number. In the demo, press **Approve** to simulate the review.
4. **Templates** *(optional)*. Copy a starter script or write your own.
5. **Settings & API** *(optional)*. Enter your airtime rate so campaigns show cost estimates.
6. **Create campaign:**
   1. Details: name, type, sending organization, caller ID.
   2. Message: upload an MP3 or WAV file, **or** use text-to-speech (template, language, voice, personal fields).
   3. Recipients: tick one or more groups, **or** upload a CSV (and optionally save it as a group). Confirm consent.
   4. Schedule: start date and time, repeat, calling window, retries.
   5. Review: check the summary and cost estimate, send a test call, then **Schedule campaign**.
7. **Campaign detail → Start now (simulate)** to watch delivery and results.
8. When it finishes: export the CSV report, **Save unreached contacts as group** for follow-up, or **Run next occurrence** for repeating campaigns.

## How groups work

- There is one **phonebook** (All contacts). A contact is identified by phone number and can belong to **any number of groups**.
- **Importing** into a group matches existing contacts by phone number. A match is added to the group and its empty fields are filled in; new numbers are created.
- **Copy to group** adds the selected contacts to another group and keeps them here. **Move** adds them there and removes them here. **Remove from group** keeps them in the phonebook.
- **Deleting a group** never deletes contacts. Deleting a contact (All contacts) removes it from every group.
- **Sending to several groups** calls each person once, even if they are in more than one of the selected groups.
- **Opted-out numbers** stay in your groups (marked "Opted out") but are never called. They are excluded when recipients are selected and again just before delivery starts.
- **Repeating campaigns** re-read the groups at the start of each run, so new members are included and people who have opted out are skipped.

### Contact files: Excel (.xlsx) and CSV

Both are accepted wherever contacts are uploaded (group import and the campaign wizard). The simplest file has two columns, **name** and **phone**:

| name | phone |
|---|---|
| Esi Owusu | +233244123456 |

- **Excel:** the **first worksheet** is read; other sheets are ignored. Phone numbers stored as numbers are read in full, without scientific notation. Old `.xls` files are rejected with a request to save as `.xlsx`.
- **Leading zeros:** Excel removes the leading 0 from local numbers stored as numbers (0244123456 becomes 244123456). The dashboard warns when numbers have only 9 digits. To avoid this, format the phone column as **Text** before typing numbers, or use the international format (+233…). The sample Excel file already formats the phone column as Text.
- **Limits:** 5 MB per file; 50,000 rows and 50 columns read from Excel.

#### Recognized columns

| Column (any of these headers) | Required | Notes |
|---|---|---|
| `phone`, `mobile`, `number`, `msisdn`, `tel` | Yes | 9–15 digits, optional `+`; `00` is converted to `+` |
| `first_name` / `firstname` / `first` | No | |
| `last_name` / `surname` / `last` | No | |
| `name` / `full name` | No | Split into first and last if the separate columns are missing |
| `company` / `organization` / `church` | No | |
| `email` | No | Ignored if invalid |

For CSV, comma, semicolon, and tab separators all work. For both formats, files without a header row are detected automatically (the column that contains phone numbers is used, and the first text column is treated as the name).

## Personalization

Text-to-speech messages can include:

| Field | Value |
|---|---|
| `{first_name}` | Contact's first name |
| `{last_name}` | Contact's last name |
| `{full_name}` | First and last name |
| `{company}` | Company or church |

Add a fallback after a bar: `{first_name|friend}` reads "friend" when the first name is empty. The Recipients step warns you how many contacts are missing any field that has no fallback.

## Billing estimates

Settings → Billing holds the airtime rate, currency, billing increment (per second or per minute rounded up), and whether only answered calls are billed. Campaigns use these to show:

- **Billable minutes** = billed minutes per call × (answered calls, or all attempts)
- **Estimated airtime cost** = billable minutes × rate

These are estimates for planning, not invoices.

## Connected mode (staff)

When Supabase is configured, the dashboard is for BalVoice staff only.

- **Client switcher** (top bar): every screen shows one client's data. **Clients** adds, edits and (admins) archives clients.
- **Campaign requests:** requests from the website form. Set a status, or **Create client** to turn a request into a client.
- **Consent basis:** step 3 of the wizard asks how the recipients agreed to be called. It is stored with the campaign, with your name and the time.
- **Start now / Pause / Resume / Cancel** control the delivery system. The detail page follows delivery every few seconds. Results, filters and the CSV export come from the server.
- **Opt-out register:** add a number for this client or for all clients. Only admins can remove numbers.
- **Caller IDs:** operators request; admins approve or reject.
- **Reports:** per-campaign totals and **airtime by month** at the client's rate, for invoicing.
- **Team** and **Audit log** are visible to admins.
- Uploaded files that aren't saved to a group are kept as a group named after the campaign, because delivery reads from groups.

## Limits

- 20,000 contacts per client in the dashboard, 5 MB Excel or CSV files, 10 MB / 3-minute audio, 1,000-character text-to-speech scripts.
- Test calls need the voice provider; in demo mode they are simulated.

Server-side rules and setup: [INTERNAL-BACKEND.md](INTERNAL-BACKEND.md).
