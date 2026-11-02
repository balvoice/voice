# Supabase tests

## Database access rules (Row Level Security)
Runs the migration on a plain PostgreSQL 15+ server with a small stand-in for Supabase's `auth` and `storage` schemas, then checks the access rules for two users.
```bash
createdb bv_test
psql -d bv_test -f supabase/tests/supabase-stub.sql
psql -d bv_test -f supabase/migrations/20261031000000_init.sql
psql -d bv_test -t -A -f supabase/tests/rls_test.sql     # every line should start with "ok"
```
Against a real Supabase project, use `supabase test db` or run the same statements in the SQL editor on a branch or staging project (never production).

## send-sms Edge Function
Starts a fake BMS API and a fake Supabase REST endpoint, runs the real function, and sends it signed hook requests.
```bash
deno run --allow-net --allow-env --allow-run --allow-read supabase/tests/send-sms-harness.ts supabase/functions/send-sms/index.ts
```
Expected: 200 for a valid Ghana number, 401 for a bad signature, 400 for other countries, a 400 after the hourly limit, 400 when BMS rejects or times out (in about 4 s), and no codes or full numbers in the logs.

## Campaign delivery
```bash
# SQL functions (after rls_test.sql, on the same test database)
psql -d bv_test -f supabase/migrations/20261101000000_bms_delivery.sql
psql -d bv_test -t -A -f supabase/tests/delivery_test.sql            # every line "ok"

# Logic with a fake BMS and an in-memory store
deno run --allow-net --allow-env --allow-read supabase/tests/delivery-harness.ts

# Full stack: supabase-js → PostgREST → Postgres (with both migrations) → fake BMS.
# Needs PostgREST on :3300 with jwt-secret "test-jwt-secret-test-jwt-secret-123456789",
# an `authenticator` role granted anon/authenticated/service_role, and supabase/tests/integration_seed.sql applied.
deno run --allow-net --allow-env --allow-read supabase/tests/integration.ts
```

## Internal staff model (no PostgreSQL server needed)
```bash
npm install @electric-sql/pglite
node supabase/tests/run-pglite.mjs supabase/tests/supabase-stub.sql supabase/migrations/*.sql supabase/tests/staff_test.sql   # 41 checks, "all passed"
deno run -A supabase/tests/functions-harness.ts                                                                             # 19 checks: dialer, request-form, opt-out
```
`rls_test.sql` checks the original self-service model and applies to `20261031000000_init.sql` alone. `delivery_test.sql` and `integration_seed.sql` seed through `workspace_members`, which the internal-staff migration removes; update their seeds to insert `staff` rows and a client in `workspaces` before running them after that migration.
