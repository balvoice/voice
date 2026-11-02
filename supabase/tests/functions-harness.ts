// End-to-end check of the dialer, request-form and opt-out Edge Functions.
// The real migrations run in PGlite; a tiny stand-in for Supabase's REST API forwards
// rpc calls and inserts to it as the service role; each function runs as a subprocess.
//
//   deno run -A supabase/tests/functions-harness.ts
import { PGlite } from "npm:@electric-sql/pglite@0.4";
import { pgcrypto } from "npm:@electric-sql/pglite@0.4/contrib/pgcrypto";

const root = new URL("../", import.meta.url).pathname;
const read = (p: string) => Deno.readTextFileSync(root + p);
const db = new PGlite({ extensions: { pgcrypto } });
const migrations = [...Deno.readDirSync(root + "migrations")].map((e) => "migrations/" + e.name).filter((n) => n.endsWith(".sql")).sort();
for (const f of ["tests/supabase-stub.sql", ...migrations]) await db.exec(read(f));

// Seed: one client, 40 contacts in a group (2 opted out), a TTS campaign due now with no retries.
await db.exec(`
  select set_config('balvoice.trusted', 'on', false);
  insert into public.workspaces (id, name) values ('11111111-1111-1111-1111-111111111111', 'Grace Chapel');
  insert into public.contacts (workspace_id, phone, first_name)
    select '11111111-1111-1111-1111-111111111111', '0244' || lpad(g::text, 6, '0'), 'Member ' || g from generate_series(1, 40) g;
  insert into public.contact_groups (id, workspace_id, name) values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Members');
  insert into public.contact_group_members (workspace_id, group_id, contact_id)
    select workspace_id, '22222222-2222-2222-2222-222222222222', id from public.contacts;
  insert into public.opt_outs (workspace_id, phone) values ('11111111-1111-1111-1111-111111111111', '0244000001');
  insert into public.global_opt_outs (phone) values ('0244000002');
  insert into public.campaigns (id, workspace_id, name, type, sender_name, message_type, tts_text, status, schedule_start,
                                consent_confirmed, sender_identified, optout_included, consent_basis, window_start, window_end, retries)
    values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Sunday reminder', 'church', 'Grace Chapel', 'tts',
            'Hello {first_name|friend}, see you Sunday.', 'scheduled', now() - interval '1 minute', true, true, true, 'Membership form', '00:00', '23:59', 0);
  insert into public.campaign_groups values ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222');
  select set_config('balvoice.trusted', '', false);
`);

// Serialised access: PGlite has one connection.
let chain = Promise.resolve();
function asService<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    await db.exec(`begin; set local role service_role; select set_config('request.jwt.claims', '{"role":"service_role"}', true);`);
    try { const r = await fn(); await db.exec("commit"); return r; } catch (e) { await db.exec("rollback"); throw e; }
  });
  chain = run.then(() => {}, () => {});
  return run;
}
const ident = (s: string) => { if (!/^[a-z_]+$/.test(s)) throw new Error("bad identifier"); return s; };

const api = Deno.serve({ port: 54399, onListen() {} }, async (req) => {
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  try {
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (rpc) {
      const fn = ident(rpc[1]);
      const keys = Object.keys(body).map(ident);
      const res = await asService(() => db.query(`select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`, keys.map((k) => body[k])));
      const scalar = res.fields.length === 1 && res.fields[0].name === fn;
      return Response.json(scalar ? (res.rows[0] as Record<string, unknown>)?.[fn] ?? null : res.rows);
    }
    const tbl = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
    if (tbl && req.method === "POST") {
      const rows = Array.isArray(body) ? body : [body];
      const cols = Object.keys(rows[0]).map(ident);
      const conflict = url.searchParams.get("on_conflict");
      const ignore = (req.headers.get("prefer") ?? "").includes("ignore-duplicates");
      for (const r of rows) {
        await asService(() => db.query(
          `insert into public.${ident(tbl[1])} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})` +
          (conflict && ignore ? ` on conflict (${ident(conflict)}) do nothing` : ""), cols.map((c) => r[c])));
      }
      return new Response(null, { status: 201 });
    }
    return Response.json({ message: "not supported by harness" }, { status: 404 });
  } catch (e) {
    return Response.json({ message: (e as Error).message, code: "P0001" }, { status: 400 });
  }
});

// Run an Edge Function as a subprocess on its own port.
async function start(name: string, port: number, extra: Record<string, string>) {
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", "--allow-read", root + `functions/${name}/index.ts`],
    env: { DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}`, SUPABASE_URL: "http://127.0.0.1:54399",
           SUPABASE_SERVICE_ROLE_KEY: "service-key", SUPABASE_ANON_KEY: "anon-key", ...extra },
    stdout: "null", stderr: "piped",
  }).spawn();
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`, { method: "OPTIONS" }); return proc; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error(name + " did not start");
}

let failures = 0;
const check = (cond: boolean, label: string) => { console.log((cond ? "ok  " : "FAIL ") + label); if (!cond) failures++; };
const q1 = async (sql: string) => (await db.query(sql)).rows[0] as Record<string, unknown>;

// Dialer --------------------------------------------------------------------------------
const dialer = await start("dialer", 54401, { DIALER_SECRET: "s3cret", VOICE_PROVIDER: "simulator", DIALER_BATCH: "15" });
const call = (secret?: string) => fetch("http://127.0.0.1:54401/", { method: "POST", headers: secret ? { "x-dialer-secret": secret } : {}, body: "{}" });
check((await call()).status === 401, "dialer: no secret → 401");
check((await call("wrong")).status === 401, "dialer: wrong secret → 401");
const r1 = await (await call("s3cret")).json();
check(r1.started === 1 && r1.placed === 38 && r1.failed === 0, `dialer: started 1 campaign, placed ${r1.placed} calls (38 expected)`);
check(r1.finished === 1, "dialer: run finished in the same pass");
const stats = await q1(`select recipients, skipped, done, answered + busy + noanswer + unreachable as outcomes from public.campaign_run_stats`);
check(Number(stats.recipients) === 38 && Number(stats.skipped) === 2 && Number(stats.done) === 38 && Number(stats.outcomes) === 38,
  `results: ${stats.done}/${stats.recipients} done, ${stats.skipped} opt-outs skipped`);
check((await q1(`select status from public.campaigns`)).status === "completed", "campaign completed");
check(Number((await q1(`select count(*) n from public.campaign_recipients where provider_call_id like 'sim-%'`)).n) === 38, "simulated calls are labelled sim-");
const r2 = await (await call("s3cret")).json();
check(r2.started === 0 && r2.placed === 0, "second pass: nothing left to do");
dialer.kill();

// Request form ----------------------------------------------------------------------------
const form = await start("request-form", 54402, { SITE_URL: "https://www.balvoice.test", RATE_LIMIT_SALT: "salt" });
const post = (body: unknown, origin = "https://www.balvoice.test", ip = "198.51.100.7") =>
  fetch("http://127.0.0.1:54402/", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "x-forwarded-for": ip }, body: JSON.stringify(body) });
const valid = { organization: "Hope Church", name: "Abena Owusu", email: "abena@example.org", phone: "020 123 4567",
  campaign_type: "church", list_size: "under-1000", message: "Sunday service reminder", consent_contacts: "on", consent_optout: "on", website: "" };
check((await post(valid)).status === 200, "form: valid request accepted");
const saved = await q1(`select phone, consent_contacts_at is not null as c, ip_hash from public.campaign_requests`);
check(saved.phone === "+233201234567" && saved.c === true && String(saved.ip_hash).length === 64, "form: stored with normalised phone, consent time and hashed IP");
const bad = await post({ ...valid, email: "nope", consent_optout: "" });
check(bad.status === 422 && Object.keys((await bad.json()).fields).sort().join() === "consent_optout,email", "form: invalid fields → 422 naming them");
check((await post({ ...valid, website: "http://spam" })).status === 200 && Number((await q1(`select count(*) n from public.campaign_requests`)).n) === 1, "form: honeypot answered 200 but not stored");
check((await post(valid, "https://evil.example")).status === 403, "form: foreign origin → 403");
const codes: number[] = [];
for (let i = 0; i < 5; i++) codes.push((await post(valid)).status);
check(codes.join() === "200,200,200,200,429", "form: 5 per hour per IP, then 429 (" + codes.join() + ")");
check((await post(valid, undefined, "203.0.113.9")).status === 200, "form: another IP still accepted");
form.kill();

// Opt-out -----------------------------------------------------------------------------
const opt = await start("opt-out", 54403, { SITE_URL: "https://www.balvoice.test", RATE_LIMIT_SALT: "salt" });
const optPost = (phone: string) => fetch("http://127.0.0.1:54403/", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://www.balvoice.test" }, body: JSON.stringify({ phone, website: "" }) });
check((await optPost("0277 555 123")).status === 200, "opt-out: accepted");
check((await optPost("0277555123")).status === 200, "opt-out: repeat gives the same answer");
check(Number((await q1(`select count(*) n from public.global_opt_outs where phone = '+233277555123'`)).n) === 1, "opt-out: stored once, normalised");
check((await optPost("12")).status === 422, "opt-out: invalid number → 422");
opt.kill();

await api.shutdown();
console.log(failures ? `${failures} check(s) failed` : "all passed");
Deno.exit(failures ? 1 : 0);
