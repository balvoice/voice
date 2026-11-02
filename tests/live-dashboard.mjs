// Connected-mode dashboard test: real migrations + RLS (PGlite behind tests/fake-supabase.mjs),
// the built site served locally, and Chromium driven by Playwright.
//
//   SUPABASE_URL=http://127.0.0.1:8771 SUPABASE_ANON_KEY=anon python3 build.py   (then see tests/README.md)
//   node tests/live-dashboard.mjs
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startFakeSupabase } from "./fake-supabase.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST = ROOT + "/dist", SITE = "http://127.0.0.1:8770", API = "http://127.0.0.1:8771";
const ADMIN = "00000000-0000-0000-0000-0000000000a1", OPER = "00000000-0000-0000-0000-0000000000b2", STRANGER = "00000000-0000-0000-0000-0000000000c3";
let failures = 0;
const check = (cond, label) => { console.log((cond ? "ok  " : "FAIL ") + label); if (!cond) failures++; };

// Site server. The test build points at an http backend, so its CSP is adjusted to match.
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".xlsx": "application/octet-stream" };
const site = http.createServer((req, res) => {
  let f = DIST + decodeURIComponent(new URL(req.url, SITE).pathname);
  if (f.endsWith("/")) f += "index.html";
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  if (f.endsWith(".html")) body = body.toString().replaceAll("https://127.0.0.1:8771", API).replaceAll("wss://127.0.0.1:8771", "ws://127.0.0.1:8771");
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); res.end(body);
}).listen(8770, "127.0.0.1");

const fake = await startFakeSupabase(ROOT, 8771);
const { db } = fake;
await db.exec(`
  insert into auth.users (id, email, raw_user_meta_data) values
    ('${ADMIN}', 'ama@balvoice.test', '{"full_name":"Ama Admin"}'),
    ('${OPER}', 'kofi@balvoice.test', '{"full_name":"Kofi Operator"}'),
    ('${STRANGER}', 'someone@example.org', '{}');
  insert into public.staff (user_id, role, created_by) values ('${ADMIN}', 'admin', null), ('${OPER}', 'operator', null);
  insert into public.campaign_requests (organization, contact_name, email, phone, campaign_type, list_size, message, consent_contacts_at, consent_optout_at)
    values ('Hope Assembly', 'Abena Owusu', 'abena@example.org', '0201234567', 'church', 'under-1000', 'Weekly service reminders', now(), now());`);
const q1 = async (sql, v) => (await db.query(sql, v)).rows[0];

function session(id, email) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const token = b64({ alg: "HS256", typ: "JWT" }) + "." + b64({ sub: id, role: "authenticated", email, exp, aud: "authenticated" }) + ".sig";
  return { access_token: token, refresh_token: "r", token_type: "bearer", expires_in: 86400, expires_at: exp,
           user: { id, email, aud: "authenticated", role: "authenticated", user_metadata: {}, app_metadata: {} } };
}
const sc = (await import("@sparticuz/chromium")).default;
const browser = await chromium.launch({ executablePath: await sc.executablePath(), headless: true,
  args: sc.args.filter(a => !/^--(single-process|no-zygote|disable-web-security|allow-running-insecure-content)/.test(a)).concat(["--no-proxy-server"]) });

async function open(id, email, width = 1366) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
  await ctx.addCookies([{ name: "bv_consent", value: encodeURIComponent(JSON.stringify({ v: "2026-10", necessary: true, preferences: false, analytics: false })), url: SITE }]);
  await ctx.addInitScript(([s]) => { try { localStorage.setItem("sb-127-auth-token", s); } catch (e) {} }, [JSON.stringify(session(id, email))]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/fonts\.g|407|Failed to load resource: the server responded with a status of 40[34]/.test(m.text())) page.errors.push(m.text()); });
  page.on("dialog", d => d.accept(d.type() === "prompt" ? d.defaultValue() : undefined));
  return page;
}
const settle = p => p.waitForTimeout(700);
const overflow = p => p.evaluate(() => {
  if (document.documentElement.scrollWidth <= window.innerWidth + 1) return false;
  const clipped = e => { for (let x = e.parentElement; x && x !== document.body; x = x.parentElement) if (/auto|scroll|hidden/.test(getComputedStyle(x).overflowX)) return true; return false; };
  const wide = [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && !clipped(e));
  const leaf = wide.filter(e => !wide.some(w => w !== e && e.contains(w)));
  return leaf.slice(0, 3).map(e => e.tagName.toLowerCase() + "." + e.className + " → " + Math.round(e.getBoundingClientRect().right) + "px").join("; ") || true;
});

// 1. Admin: first client -------------------------------------------------------------------
const a = await open(ADMIN, "ama@balvoice.test");
await a.goto(SITE + "/dashboard.html");
await a.waitForSelector("#client-form");
check(await a.isVisible("text=Team") && await a.isVisible("text=Audit log"), "admin sees Team and Audit log in the sidebar");
check(!(await a.isVisible(".demo-banner")), "no demo banner when connected");
await a.fill("#cl-name", "Grace Chapel"); await a.fill("#cl-contact", "Rev. Mensah"); await a.fill("#cl-phone", "0244 000 001");
await a.click("#client-form button[type=submit]");
await a.waitForSelector("text=Create, schedule, and monitor");
check((await q1("select name, contact_phone from public.workspaces")).contact_phone === "+233244000001", "client created with normalised phone");
check(await a.inputValue("#client-select") === (await q1("select id from public.workspaces")).id, "client switcher shows the new client");

// 2. Groups and contacts --------------------------------------------------------------------
await a.goto(SITE + "/dashboard.html#/groups");
await a.click("#g-new-toggle"); await a.fill("#g-name", "Members"); await a.click("#g-new button[type=submit]");
await a.waitForSelector("#imp-file");
await a.setInputFiles("#imp-file", ROOT + "/tests/group.csv");
await a.waitForFunction(() => /Import complete/.test(document.getElementById("imp-result").textContent));
await settle(a); await a.waitForTimeout(1500);
const nContacts = Number((await q1("select count(*) n from public.contacts")).n), nMembers = Number((await q1("select count(*) n from public.contact_group_members")).n);
check(nContacts === 130 && nMembers === 130, `130 contacts and memberships saved (${nContacts}/${nMembers})`);
check(Number((await q1("select count(*) n from public.contacts where phone !~ '^\\+'")).n) === 0, "every stored number is in +country format");

// 3. Opt-outs: one for this client, one for all clients
const phones = (await db.query("select phone from public.contacts order by phone limit 2")).rows.map(r => r.phone);
await a.goto(SITE + "/dashboard.html#/optouts");
await a.fill("#o-phone", phones[0]); await a.click("#optout-form button[type=submit]"); await settle(a);
await a.fill("#o-phone", phones[1]); await a.selectOption("#o-scope", "all"); await a.click("#optout-form button[type=submit]"); await a.waitForTimeout(1200);
check(Number((await q1("select count(*) n from public.opt_outs")).n) === 1 && Number((await q1("select count(*) n from public.global_opt_outs")).n) === 1, "client and all-client opt-outs stored separately");

// 4. Caller ID requested and approved; billing rate
await a.goto(SITE + "/dashboard.html#/callerids");
await a.fill("#cid-value", "GRACE"); await a.click("#cid-form button[type=submit]"); await settle(a);
await a.click("[data-cid-approve]"); await a.waitForTimeout(1200);
const cid = await q1("select status, reviewed_by from public.caller_ids");
check(cid.status === "approved" && cid.reviewed_by === ADMIN, "admin approved caller ID; reviewer recorded");
await a.goto(SITE + "/dashboard.html#/settings");
await a.fill("#s-rate", "0.15"); await a.click("#bill-form button[type=submit]"); await a.waitForTimeout(1000);
check(Number((await q1("select airtime_rate from public.workspace_settings")).airtime_rate) === 0.15, "airtime rate saved for the client");

// 5. Campaign: text-to-speech to the group --------------------------------------------------
await a.goto(SITE + "/dashboard.html#/new");
await a.fill("#w-name", "Sunday reminder"); await a.selectOption("#w-type", "church"); await a.fill("#w-sender", "Grace Chapel");
await a.selectOption("#w-caller", { label: "GRACE — brand name" });
await a.click("button[type=submit]");
await a.click("[data-seg='Message source'][data-value='tts']");
await a.fill("#w-tts", "Hello {first_name|friend}, this is Grace Chapel. Join us on Sunday at 9. To stop these calls, press 9.");
await a.check("#w-chk-sender"); await a.check("#w-chk-optout"); await a.click("button[type=submit]");
await a.click("[data-group]"); await a.check("#w-consent"); await a.fill("#w-basis", "Members gave their numbers on the registration form");
await a.click("button[type=submit]");
const tomorrow = new Date(Date.now() + 86400000), pad = n => String(n).padStart(2, "0");
await a.fill("#w-date", `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`);
await a.fill("#w-time", "10:00"); await a.fill("#w-ws", "00:00"); await a.fill("#w-we", "23:59");
await a.selectOption("#w-retries", "0");
await a.click("button[type=submit]");
check(await a.isVisible("text=Test calls will be available once the voice provider is connected"), "review step explains test calls need the provider");
await a.click("button[type=submit]");
await a.waitForSelector("text=Delivery"); await a.waitForTimeout(1500);
const camp = await q1("select id, status, consent_basis, compliance_confirmed_by, caller_id is not null as has_cid from public.campaigns");
check(camp && camp.status === "scheduled" && camp.compliance_confirmed_by === ADMIN && camp.has_cid, "campaign scheduled; consent confirmation stamped with the admin");
check(camp && /registration form/.test(camp.consent_basis), "consent basis stored with the campaign");
check(Number((await q1("select count(*) n from public.campaign_groups")).n) === 1, "campaign linked to the group");
check(await a.isVisible("text=About 128 contacts"), "detail estimates 128 contacts (130 minus 2 opt-outs)");

// 6. Start now, deliver, and watch results arrive --------------------------------------------
await a.click("[data-act=start]");
await a.waitForSelector("text=Delivery will begin within a minute");
check(new Date((await q1("select schedule_start from public.campaigns")).schedule_start) <= new Date(), "start brought forward to now");
await fake.asService(async () => {
  await db.query("select public.dialer_start_due()");
  const calls = (await db.query("select recipient_id from public.dialer_claim(500, 300)")).rows;
  let i = 0;
  for (const c of calls) {
    const o = ["answered", "answered", "busy", "noanswer", "unreachable"][i++ % 5];
    await db.query("select public.dialer_mark_sent($1, $2)", [c.recipient_id, "sim-" + c.recipient_id]);
    await db.query("select public.dialer_report($1, $2, $3, $4)", [c.recipient_id, o, o === "answered" ? 30 : null, "sim-" + c.recipient_id]);
  }
  await db.query("select public.dialer_finish()");
});
await a.waitForSelector(".tag-completed", { timeout: 15000 });
check(await a.isVisible("text=Results from the delivery system"), "detail switches to delivery results by polling");
const delCount = await a.textContent("#del-count");
check(/128 \/ 128/.test(delCount), "progress shows 128 / 128 (" + delCount.trim() + ")");
await a.waitForSelector("#results table");
check(await a.locator("#results tbody tr").count() === 25 && await a.isVisible("text=Showing 25 of 130"), "first 25 of 130 rows shown (128 called + 2 skipped)");
check(await a.locator("#results >> text=simulated").count() > 0, "simulated calls are labelled");
await a.selectOption("#f-o", "skipped"); await a.waitForTimeout(800);
check(await a.locator("#results tbody tr").count() === 2, "filter: 2 skipped for opt-out");
await a.selectOption("#f-o", "busy"); await a.waitForTimeout(800);
check(await a.locator("#results tbody tr").count() > 0 && await a.locator("#results tbody .tag-answered").count() === 0, "filter: busy only");
await a.selectOption("#f-o", "");
const [dl] = await Promise.all([a.waitForEvent("download"), a.click("[data-act=export]")]);
const csv = fs.readFileSync(await dl.path(), "utf8").trim().split(/\r?\n/);
check(csv.length === 131 && csv[0].startsWith("phone,first_name"), `export has header + 130 rows (${csv.length - 1})`);
await a.click("[data-act=unreached]"); await a.waitForTimeout(2000);
const unreached = await q1("select g.name, count(m.*) n from public.contact_groups g join public.contact_group_members m on m.group_id = g.id where g.name like '%not reached%' group by g.name");
check(unreached && Number(unreached.n) > 50, "unreached contacts saved as a new group (" + (unreached && unreached.n) + ")");

// 7. Reports: airtime by month ------------------------------------------------------------------
await a.goto(SITE + "/dashboard.html#/reports");
await a.waitForSelector("#monthly table");
const airtime = await a.locator("#monthly tbody td").last().textContent();
check(/GH|₵/.test(airtime) && /3\.90|3,90/.test(airtime), "monthly airtime: 52 answered × 30 s = 26 min × 0.15 = GHS 3.90 (shown " + airtime.trim() + ")");

// 7b. Recorded message: upload goes to private storage; draft keeps the file
await a.goto(SITE + "/dashboard.html#/new");
await a.fill("#w-name", "Easter invitation"); await a.selectOption("#w-type", "church"); await a.fill("#w-sender", "Grace Chapel");
await a.click("button[type=submit]");
await a.setInputFiles("#w-audio", ROOT + "/tests/msg.wav");
await a.waitForSelector("#audio-remove");
const audioRow = await q1("select storage_path, mime_type, duration_sec from public.audio_files");
const stored = await q1("select count(*) n from storage.objects where bucket_id = 'campaign-audio' and name = $1", [audioRow && audioRow.storage_path]);
check(audioRow && audioRow.mime_type === "audio/wav" && Number(stored.n) === 1 && audioRow.storage_path.startsWith((await q1("select id from public.workspaces")).id + "/"),
  "recording uploaded to the client's private folder (" + (audioRow && audioRow.duration_sec) + " s)");
await a.check("#w-chk-sender"); await a.check("#w-chk-optout"); await a.click("button[type=submit]");
await a.click("[data-group]"); await a.check("#w-consent"); await a.fill("#w-basis", "Members gave their numbers on the registration form");
await a.click("button[type=submit]");
await a.fill("#w-date", `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`); await a.fill("#w-time", "11:00");
await a.click("button[type=submit]");
await a.click("#save-draft"); await a.waitForSelector("text=This campaign is a draft"); await a.waitForTimeout(1200);
check((await q1("select count(*) n from public.campaigns where status = 'draft' and audio_file_id is not null")).n == 1, "draft saved with its recording");
await a.goto(SITE + "/dashboard.html#/audio");
await a.waitForSelector("[data-play]");
check(await a.isVisible("text=Easter invitation"), "audio library shows the file and the campaign using it");

// 8. Requests, team, audit --------------------------------------------------------------------
await a.goto(SITE + "/dashboard.html#/requests");
await a.waitForSelector("text=Hope Assembly");
await a.selectOption("[data-req]", "contacted"); await a.waitForTimeout(800);
const reqRow = await q1("select status, handled_by from public.campaign_requests");
check(reqRow.status === "contacted" && reqRow.handled_by === ADMIN, "request status updated and attributed");
await a.goto(SITE + "/dashboard.html#/team");
await a.waitForSelector("#team-box table");
check(await a.locator("#team-box tbody tr").count() === 2, "team lists 2 staff");
await a.fill("#iv-name", "Esi Mensah"); await a.fill("#iv-email", "esi@balvoice.test"); await a.fill("#iv-pass", "weak");
await a.click("#invite-form button[type=submit]");
check(await a.isVisible("text=Use at least 10 characters"), "weak temporary password refused");
await a.click("#iv-gen"); await a.click("#invite-form button[type=submit]");
await a.waitForFunction(() => document.querySelectorAll("#team-box tbody tr").length === 3);
check(true, "staff account created with a temporary password");
// Assign Grace Chapel to the operator
await a.click(`[data-assign="${OPER}"]`);
await a.waitForSelector(".assign-form");
await a.check(".assign-form .pick input"); await a.click(".assign-form button[type=submit]");
await a.waitForSelector("text=Assignments saved");
check(Number((await q1("select count(*) n from public.client_assignments where user_id = $1", [OPER])).n) === 1, "operator assigned to Grace Chapel");
check(await a.isVisible(`#team-box >> text=Grace Chapel`), "team page lists the operator's client");
await a.goto(SITE + "/dashboard.html#/audit");
await a.waitForSelector("#audit-box table");
const auditRows = await a.locator("#audit-box tbody tr").count();
check(auditRows > 10 && await a.isVisible("#audit-box >> text=Delivery system"), `audit log shows ${auditRows} entries, including the delivery system`);
check(a.errors.length === 0, "admin session: no script errors " + JSON.stringify(a.errors.slice(0, 3)));

// 9. Operator ------------------------------------------------------------------------------------
const o = await open(OPER, "kofi@balvoice.test", 390);
await o.goto(SITE + "/dashboard.html");
await o.waitForSelector("text=Create, schedule, and monitor");
check(!(await o.isVisible("text=Audit log")) && !(await o.isVisible(".sidebar >> text=Team")) && !(await o.isVisible(".sidebar >> text=Campaign requests")), "operator: no Team, Audit log or Campaign requests");
await o.goto(SITE + "/dashboard.html#/clients"); await settle(o);
check(!(await o.isVisible("#cl-name")) && await o.locator("tbody tr").count() === 1, "operator: sees only the assigned client and can't add clients");
check(await o.isVisible("#client-select"), "operator: client switcher visible on a phone");
await o.goto(SITE + "/dashboard.html#/optouts"); await settle(o);
check(await o.locator("[data-remove]").count() === 0, "operator: cannot remove opt-outs");
await o.goto(SITE + "/dashboard.html#/team"); await settle(o);
check(await o.isVisible("text=Create, schedule, and monitor"), "operator: team page redirects to campaigns");
for (const r of ["campaigns", "groups", "reports", "clients"]) {
  await o.goto(SITE + "/dashboard.html#/" + r); await settle(o);
  const ov = await overflow(o);
  if (ov) check(false, "operator phone: horizontal overflow on " + r + ": " + ov);
}
check(o.errors.length === 0, "operator session: no script errors " + JSON.stringify(o.errors.slice(0, 3)));

// 9b. Operator with no clients assigned
await db.exec("insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d4', 'new@balvoice.test'); insert into public.staff (user_id, role) values ('00000000-0000-0000-0000-0000000000d4', 'operator')");
const n = await open("00000000-0000-0000-0000-0000000000d4", "new@balvoice.test");
await n.goto(SITE + "/dashboard.html");
await n.waitForSelector("text=No clients assigned to you yet");
check(true, "unassigned operator sees a clear 'no clients assigned' message");

// 10. Signed in but not staff ---------------------------------------------------------------------
const x = await open(STRANGER, "someone@example.org");
await x.goto(SITE + "/dashboard.html");
await x.waitForSelector("text=No dashboard access");
check(true, "non-staff account: no dashboard access");

await browser.close(); site.close(); fake.server.close();
console.log(failures ? failures + " check(s) failed" : "all passed");
process.exit(failures ? 1 : 0);
