# Tests

Browser checks used during development (Playwright + Chromium).

```bash
python3 build.py
cd dist && python3 -m http.server 8765 &      # the scripts expect this port
cd ../tests && mkdir -p screenshots
npm install playwright && npx playwright install chromium   # first time only
node pages.js               # every public page at 1366px and 390px: JS errors, horizontal overflow, screenshots
node cookie-consent.js      # banner, preferences dialog, cookie value, calculator memory, withdrawal, GPC
node dashboard-basic.js     # upload-file campaign: audio, CSV cleaning, opt-out exclusion, simulated delivery
node dashboard-features.js  # groups, import, copy, caller ID, settings, templates, TTS campaign, recurring, follow-up group
node auth.js               # sign-in pages against a mocked Supabase (build with SUPABASE_URL=https://test.supabase.co and serve on :8766)
node excel-import.js        # .xlsx import: numeric phones, no header, header variants, leading-zero warning, .xls and corrupt files
```

`dashboard-basic.js` and `dashboard-features.js` need these fixtures in this folder: `msg.wav` (any short WAV), `list.csv` and `group.csv` (see `make-fixtures.py`). `excel-import.js` needs `t1.xlsx`–`t6.xlsx`, created by `make-xlsx-fixtures.py` (requires `pip install openpyxl`).

## Connected mode (staff dashboard against the real schema)
```bash
npm install playwright @electric-sql/pglite      # plus a Chromium (npx playwright install chromium)
SUPABASE_URL=http://127.0.0.1:8771 SUPABASE_ANON_KEY=anon python3 build.py
node tests/live-dashboard.mjs                     # 38 checks
```
`fake-supabase.mjs` runs every migration in PGlite and answers the dashboard's REST, RPC, storage and staff-admin calls as the signed-in user, so Row Level Security applies exactly as in production. The test covers an admin, an operator at phone width, and a signed-in account that isn't staff. The test build points at an http backend, so the site server rewrites the CSP host to match.
