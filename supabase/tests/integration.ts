// Integration test: real supabase-js store → PostgREST → PostgreSQL (BalVoice migrations applied),
// real BMS client → fake BMS. Runs dispatch → report → retry → finish.
const b64 = (b: Uint8Array | string) => btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
async function jwt(payload: Record<string, unknown>, secret: string) {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" })), body = b64(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(head + "." + body)));
  return `${head}.${body}.${b64(sig)}`;
}
const SERVICE = await jwt({ role: "service_role", exp: Math.floor(Date.now() / 1000) + 3600 }, "test-jwt-secret-test-jwt-secret-123456789");

// Supabase-like gateway: /rest/v1 → PostgREST, /storage/v1 → audio bytes.
Deno.serve({ port: 8800, onListen() {} }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname.startsWith("/rest/v1/")) {
    const target = "http://127.0.0.1:3300" + u.pathname.slice(8) + u.search;
    const headers = new Headers(req.headers); headers.delete("host");
    const res = await fetch(target, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer() });
    return new Response(res.body, { status: res.status, headers: res.headers });
  }
  if (u.pathname.startsWith("/storage/v1/object/campaign-audio/")) return new Response(new Uint8Array(3000), { headers: { "Content-Type": "audio/mpeg" } });
  return new Response("not found", { status: 404 });
});

// Fake BMS.
const reports = new Map<string, { recipient: string; status: string }[]>(); let n = 0; const sends: { file: boolean; voice: string; to: string[] }[] = [];
Deno.serve({ port: 8799, onListen() {} }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/api/balance/voice") return Response.json({ status: "success", balance: 500 });
  if (u.pathname === "/api/voice/quick") {
    const f = await req.formData(); const to = f.getAll("recipient[]").map(String); const file = f.get("file");
    sends.push({ file: file instanceof File, voice: String(f.get("voice_id")), to });
    const id = "BMSI" + (++n); reports.set(id, to.map((r) => ({ recipient: "233" + r.slice(-9), status: "pending" })));
    return Response.json({ status: "success", code: "2000", summary: { _id: id, voice_id: String(f.get("voice_id") || "V-77"), total_sent: to.length, total_rejected: 0, credit_used: to.length * 9 } });
  }
  const m = u.pathname.match(/^\/api\/calls\/(.+)$/);
  if (m) return Response.json({ status: "success", report: (reports.get(m[1]) ?? []).map((r, i) => ({ _id: String(i + 1), ...r, total_duration: r.status === "received" ? "40" : "0", answer_time: "0000-00-00 00:00:00" })) });
  return new Response("nf", { status: 404 });
});

Deno.env.set("SUPABASE_URL", "http://127.0.0.1:8800");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
Deno.env.set("BMS_API_KEY", "K");
Deno.env.set("BMS_BASE_URL", "http://127.0.0.1:8799/api");
Deno.env.set("CRON_SECRET", "x".repeat(40));
const { dispatch, sync } = await import("../functions/_shared/delivery.ts");
const { supabaseStore, adminClient } = await import("../functions/_shared/store.ts");
const { bmsProvider } = await import("../functions/_shared/bms-provider.ts");
const { authorizedCron } = await import("../functions/_shared/cron-auth.ts");
const db = adminClient(); const store = supabaseStore(db);
const ok = (c: boolean, l: string, d = "") => console.log((c ? "ok  " : "FAIL ") + l + (d ? " — " + d : ""));
const camp = async () => (await db.from("campaigns").select("*").eq("name", "Integration run").single()).data!;
const quiet = () => {};

ok(!authorizedCron(new Request("http://x", { method: "POST" })), "cron endpoint rejects requests without the secret");
ok(authorizedCron(new Request("http://x", { method: "POST", headers: { "x-cron-secret": "x".repeat(40) } })), "cron endpoint accepts the secret");

let s = await dispatch(store, bmsProvider, { log: console.log });
let c = await camp();
ok(s.sent === 1 && c.status === "running" && c.attempt_number === 1, "dispatch via Supabase: campaign running, attempt 1", JSON.stringify(s));
ok(sends.length === 1 && sends[0].to.length === 3 && sends[0].file, "BMS received 3 numbers with the audio file", sends[0]?.to.join(","));
const d1 = (await db.from("campaign_dispatches").select("*").eq("campaign_id", c.id)).data!;
ok(d1.length === 1 && d1[0].provider_campaign_id === "BMSI1" && d1[0].recipient_ids.length === 3, "dispatch row stored with BMS id and recipient ids");
ok((await db.from("audio_files").select("bms_voice_id").eq("id", c.audio_file_id).single()).data!.bms_voice_id === "V-77", "BMS voice id saved on the audio file");

// BMS reports: Abena answered, Kwesi missed, Akua answered.
reports.get("BMSI1")!.forEach((r) => { r.status = r.recipient.endsWith("550000002") ? "missed" : "received"; });
s = await sync(store, bmsProvider, { log: console.log });
c = await camp();
const r1 = (await db.from("call_results").select("outcome, attempts, raw_status, duration_sec").eq("campaign_id", c.id)).data!;
ok(r1.length === 3 && r1.filter((r) => r.outcome === "answered").length === 2, "call results written via Supabase", JSON.stringify(s));
ok(!!c.next_attempt_at && s.retries === 1, "retry scheduled for the missed number", c.next_attempt_at);

// Make the retry due now and dispatch again.
await db.from("campaigns").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", c.id);
s = await dispatch(store, bmsProvider, { log: quiet });
ok(sends.length === 2 && sends[1].to.length === 1 && sends[1].to[0].endsWith("550000002") && !sends[1].file && sends[1].voice === "V-77", "retry sends only Kwesi, reusing the voice id", sends[1]?.to.join(","));
reports.get("BMSI2")!.forEach((r) => { r.status = "received"; });
s = await sync(store, bmsProvider, { log: quiet });
c = await camp();
const r2 = (await db.from("call_results").select("outcome, attempts").eq("campaign_id", c.id)).data!;
ok(c.status === "completed", "run finished → campaign completed", JSON.stringify(s));
ok(r2.every((r) => r.outcome === "answered") && r2.some((r) => r.attempts === 2), "all answered; Kwesi on attempt 2");
const ev = (await db.from("campaign_events").select("message").eq("campaign_id", c.id).order("id")).data!.map((e) => e.message);
console.log("    events: " + ev.join(" | "));
Deno.exit(0);
