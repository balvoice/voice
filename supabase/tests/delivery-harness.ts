// Delivery logic test: real BMS client + real dispatch/sync logic, against a fake BMS
// server (shaped like developer.bms.africa responses) and an in-memory store.
//   deno run --allow-net --allow-env --allow-read supabase/tests/delivery-harness.ts

Deno.env.set("BMS_API_KEY", "TESTKEY");
Deno.env.set("BMS_BASE_URL", "http://127.0.0.1:8799/api");
const bms = await import("../functions/_shared/bms.ts");
const { dispatch, sync, nextWindowOpening } = await import("../functions/_shared/delivery.ts");
import type { Campaign, Store, ResultRow, Dispatch, Target } from "../functions/_shared/delivery.ts";

// ---------------- Fake BMS ----------------
type Call = { recipient: string; status: string };
const fake = { balance: 100, failNextSend: false, sends: [] as { file: boolean; voiceId: string; recipients: string[]; key: string | null }[], campaigns: new Map<string, Call[]>() };
let seq = 0;
Deno.serve({ port: 8799, onListen() {} }, async (req) => {
  const u = new URL(req.url);
  const key = u.searchParams.get("key");
  if (key !== "TESTKEY") return Response.json({ status: "error", code: "1002", message: "Invalid API key" }, { status: 401 });
  if (u.pathname === "/api/balance/voice") return Response.json({ status: "success", balance: fake.balance });
  if (u.pathname === "/api/voice/quick" && req.method === "POST") {
    if (fake.failNextSend) { fake.failNextSend = false; return Response.json({ status: "error", code: "1003", message: "Insufficient balance" }); }
    const form = await req.formData();
    const recipients = form.getAll("recipient[]").map(String);
    const file = form.get("file");
    const voiceId = String(form.get("voice_id") ?? "");
    fake.sends.push({ file: file instanceof File && file.size > 0, voiceId, recipients, key });
    const id = "BMS" + (++seq);
    const rejected = recipients.filter((r) => r.endsWith("241999999"));
    fake.campaigns.set(id, recipients.filter((r) => !r.endsWith("241999999")).map((r) => ({ recipient: "233" + r.slice(-9), status: "pending" })));
    return Response.json({ status: "success", code: "2000", message: "voice call sent successfully",
      summary: { _id: id, voice_id: voiceId || "VOICE123", type: "QUICK BULK CALL", total_sent: recipients.length - rejected.length, contacts: recipients.length, total_rejected: rejected.length, credit_used: recipients.length * 9 } });
  }
  const m = u.pathname.match(/^\/api\/calls\/([^/]+)$/);
  if (m) {
    const rows = fake.campaigns.get(m[1]) ?? [];
    return Response.json({ status: "success", report: rows.map((r, i) => ({ _id: String(1000 + i), recipient: r.recipient, campaign: "x", status: r.status, total_duration: r.status === "received" ? "42" : "0", answer_time: "0000-00-00 00:00:00", retries: "0" })) });
  }
  return Response.json({ status: "error", message: "not found" }, { status: 404 });
});

// ---------------- In-memory store ----------------
let clock = new Date("2026-11-02T10:00:00Z"); // 10:00 in Accra (UTC+0)
const now = () => clock;
const advance = (min: number) => { clock = new Date(clock.getTime() + min * 60000); };

type Row = Campaign & { schedule_start: string; next_attempt_at: string | null; last_error: string | null };
const db = {
  campaigns: [] as Row[],
  recipients: [] as { id: number; campaign_id: string; run: number; phone: string }[],
  optouts: new Set<string>(),
  results: new Map<number, ResultRow>(),
  dispatches: [] as (Dispatch & { status: string })[],
  events: [] as string[],
  audio: new Map([["a1", { id: "a1", storage_path: "ws/msg.mp3", file_name: "msg.mp3", bms_voice_id: null as string | null }]]),
  groupMembers: new Map<string, string[]>(),
};
let rid = 0, did = 0;
const store: Store = {
  async claimWork(max) {
    const due = db.campaigns.filter((c) => (c.status === "scheduled" && new Date(c.schedule_start) <= now()) ||
      (c.status === "running" && c.next_attempt_at && new Date(c.next_attempt_at) <= now())).slice(0, max);
    for (const c of due) { if (c.status === "scheduled") c.attempt_number = 0; c.status = "running"; c.next_attempt_at = new Date(now().getTime() + 15 * 60000).toISOString(); }
    return due.map((c) => ({ ...c }));
  },
  async snapshotRecipients(cid) {
    const c = db.campaigns.find((x) => x.id === cid)!;
    for (const p of db.groupMembers.get(cid) ?? []) {
      if (!db.recipients.some((r) => r.campaign_id === cid && r.run === c.run_number && bms.phoneKey(r.phone) === bms.phoneKey(p)) && !db.optouts.has(bms.phoneKey(p)))
        db.recipients.push({ id: ++rid, campaign_id: cid, run: c.run_number, phone: p });
    }
    return db.recipients.filter((r) => r.campaign_id === cid && r.run === c.run_number).length;
  },
  async dispatchTargets(cid) {
    const c = db.campaigns.find((x) => x.id === cid)!;
    return db.recipients.filter((r) => r.campaign_id === cid && r.run === c.run_number && db.results.get(r.id)?.outcome !== "answered" && !db.optouts.has(bms.phoneKey(r.phone)))
      .map((r) => ({ recipient_id: r.id, phone: r.phone }));
  },
  async getAudio(id) { return db.audio.get(id) ?? null; },
  async downloadAudio() { return new Blob([new Uint8Array(2000)], { type: "audio/mpeg" }); },
  async saveVoiceId(id, v) { db.audio.get(id)!.bms_voice_id = v; },
  async insertDispatch(d) { db.dispatches.push({ ...d, id: ++did, created_at: now().toISOString(), status: "sent" }); return did; },
  async updateCampaign(id, patch) { Object.assign(db.campaigns.find((c) => c.id === id)!, patch); },
  async addEvent(_c, m) { db.events.push(m); },
  async openDispatches() { return db.dispatches.filter((d) => d.status === "sent"); },
  async recipientsForRun(cid, run) { return db.recipients.filter((r) => r.campaign_id === cid && r.run === run).map((r) => ({ recipient_id: r.id, phone: r.phone })); },
  async upsertResults(rows) { for (const r of rows) db.results.set(r.recipient_id, r); },
  async resultsForDispatch(id) { return [...db.results.values()].filter((r) => r.dispatch_id === id).map((r) => r.recipient_id); },
  async markDispatch(id, patch) { const d = db.dispatches.find((x) => x.id === id)!; if (patch.status) d.status = patch.status; },
  async campaignsAwaitingDecision() {
    return db.campaigns.filter((c) => c.status === "running" && !c.next_attempt_at && c.attempt_number > 0 && !db.dispatches.some((d) => d.campaign_id === c.id && d.status === "sent")).map((c) => ({ ...c }));
  },
  async finishRun(id) { const c = db.campaigns.find((x) => x.id === id)!; c.status = "completed"; c.next_attempt_at = null; db.events.push("Run finished"); return "completed"; },
};

function campaign(id: string, extra: Partial<Row> = {}): Row {
  return { id, workspace_id: "ws", name: "Test " + id, status: "scheduled", message_type: "audio", audio_file_id: "a1", run_number: 1, attempt_number: 0,
    retries: 1, retry_interval_min: 30, window_start: "09:00:00", window_end: "19:00:00", timezone: "Africa/Accra",
    schedule_start: "2026-11-02T09:59:00Z", next_attempt_at: null, last_error: null, ...extra };
}
const ok = (cond: boolean, label: string, detail = "") => console.log((cond ? "ok  " : "FAIL ") + label + (detail ? " — " + detail : ""));
const quiet = () => {};

// ---------------- Tests ----------------
// Window helper
ok(nextWindowOpening(new Date("2026-11-02T08:30:00Z"), campaign("w"))?.toISOString() === "2026-11-02T09:00:00.000Z", "before window → opens 09:00 today");
ok(nextWindowOpening(new Date("2026-11-02T19:15:00Z"), campaign("w"))?.toISOString() === "2026-11-03T09:00:00.000Z", "after window → opens 09:00 tomorrow");
ok(nextWindowOpening(new Date("2026-11-02T12:00:00Z"), campaign("w")) === null, "inside window → send now");

// 1. Large list: 1,203 numbers (one opted out, one rejected by network), chunks of 500.
const phones = Array.from({ length: 1203 }, (_, i) => "+23324" + String(1000000 + i).padStart(7, "0"));
phones[5] = "0241999999";   // will be "rejected" by the fake network (ends in 999)
db.groupMembers.set("big", [...phones, "0241000000"]);  // duplicate of phones[0] in local format
db.optouts.add(bms.phoneKey(phones[7]));
db.campaigns.push(campaign("big"));
let s = await dispatch(store, bms_provider(), { now, chunkSize: 500, log: quiet });
ok(s.sent === 1, "dispatch sends due campaign", JSON.stringify(s));
ok(fake.sends.length === 3, "1,202 numbers sent in 3 chunks of ≤500", fake.sends.map((x) => x.recipients.length).join("+"));
ok(fake.sends[0].file && !fake.sends[1].file && fake.sends[1].voiceId === "VOICE123", "first chunk uploads audio, later chunks reuse BMS voice id");
ok(db.audio.get("a1")!.bms_voice_id === "VOICE123", "voice id saved for future campaigns");
ok(!fake.sends.flatMap((x) => x.recipients).some((r) => r.endsWith(bms.phoneKey(phones[7]))), "opted-out number not sent");
ok(fake.sends.every((x) => x.key === "TESTKEY"), "API key sent as ?key= on every request");
ok(db.campaigns[0].attempt_number === 1 && db.campaigns[0].next_attempt_at === null, "campaign marked attempt 1, lease cleared");

// 2. Sync while BMS still reports everything pending → nothing final.
s = await sync(store, bms_provider(), { now, log: quiet });
ok(s.finalized === 0 && s.results === 0, "pending report → wait", JSON.stringify(s));

// BMS finishes: most answered, some missed, a few busy.
for (const rows of fake.campaigns.values()) rows.forEach((r, i) => { r.status = i % 10 === 0 ? "missed" : i % 25 === 3 ? "busy" : "received"; });
advance(5);
s = await sync(store, bms_provider(), { now, log: quiet });
const res = [...db.results.values()];
ok(s.finalized === 3, "all 3 sends final once BMS reports every number", JSON.stringify(s));
ok(res.length === 1202 && res.filter((r) => r.raw_status === "not_reported").length === 1, "every targeted number has a result (1,201 reported + 1 rejected)", String(res.length));
ok(res.find((r) => r.raw_status === "not_reported")?.outcome === "unreachable", "number rejected by the network recorded as unreachable");
ok(s.retries === 1, "unanswered numbers → retry scheduled");
const c0 = db.campaigns[0];
ok(!!c0.next_attempt_at && new Date(c0.next_attempt_at).getTime() - clock.getTime() === 30 * 60000, "retry after the 30-minute interval");
const unanswered = res.filter((r) => r.outcome !== "answered").length;

// 3. Retry: only the unanswered are called again.
advance(31);
fake.sends.length = 0;
s = await dispatch(store, bms_provider(), { now, chunkSize: 500, log: quiet });
const retried = fake.sends.reduce((n, x) => n + x.recipients.length, 0);
ok(retried === unanswered, "retry calls only the unanswered", `${retried} of ${unanswered}`);
ok(fake.sends.every((x) => !x.file), "retry reuses the voice id (no re-upload)");
for (const [id, rows] of fake.campaigns) if (Number(id.slice(3)) > 3) rows.forEach((r) => { r.status = "received"; });
advance(5);
s = await sync(store, bms_provider(), { now, log: quiet });
ok(s.finished === 1 && db.campaigns[0].status === "completed", "after the last attempt the run finishes", JSON.stringify(s));
ok([...db.results.values()].filter((r) => r.attempts === 2).length === retried, "retried numbers show 2 attempts");

// 4. Outside calling hours → deferred to the next window.
clock = new Date("2026-11-02T20:30:00Z");
db.campaigns.push(campaign("late", { schedule_start: "2026-11-02T20:00:00Z" }));
db.groupMembers.set("late", ["0240000001"]);
s = await dispatch(store, bms_provider(), { now, log: quiet });
ok(s.deferred === 1 && db.campaigns[1].next_attempt_at === "2026-11-03T09:00:00.000Z", "8:30 pm → deferred to 9:00 am next day");

// 5. Text-to-speech campaign → paused with an explanation (BMS voice needs an audio file).
clock = new Date("2026-11-03T10:00:00Z");
db.campaigns.push(campaign("tts", { message_type: "tts", audio_file_id: null }));
s = await dispatch(store, bms_provider(), { now, log: quiet });
ok(db.campaigns[2].status === "paused" && db.events.some((e) => e.includes("text-to-speech")), "TTS campaign paused with explanation");

// 6. Empty BMS balance → waits and retries in 30 minutes.
fake.balance = 0;
db.campaigns.push(campaign("broke", { schedule_start: "2026-11-03T09:00:00Z" }));
db.groupMembers.set("broke", ["0240000002"]);
fake.sends.length = 0;
s = await dispatch(store, bms_provider(), { now, log: quiet });
const broke = db.campaigns.find((c) => c.id === "broke")!;
ok(fake.sends.length === 0 && broke.last_error === "BMS voice balance is empty", "empty balance → nothing sent, retries later");

// 7. BMS error during send → retry in 10 minutes.
fake.balance = 100; fake.failNextSend = true;
advance(31);
s = await dispatch(store, bms_provider(), { now, log: quiet });
ok(broke.last_error === "Insufficient balance" && db.events.some((e) => e.startsWith("Sending failed")), "BMS error → event + retry", broke.next_attempt_at ?? "");

// 8. Report never completes → after the timeout, pending numbers count as no answer.
advance(11);
s = await dispatch(store, bms_provider(), { now, log: quiet });
advance(7 * 60);
s = await sync(store, bms_provider(), { now, reportTimeoutHours: 6, log: quiet });
const brokeRes = [...db.results.values()].filter((r) => r.campaign_id === "broke");
ok(brokeRes.length === 1 && brokeRes[0].raw_status === "timeout" && brokeRes[0].outcome === "noanswer", "pending after 6 h → no answer (timeout)");

// 9. Status mapping and phone matching.
ok(bms.mapCallStatus("received") === "answered" && bms.mapCallStatus("missed") === "noanswer" && bms.mapCallStatus("pending") === null && bms.mapCallStatus("failed") === "unreachable", "BMS statuses mapped");
ok(bms.phoneKey("+233241234567") === bms.phoneKey("0241234567") && bms.phoneKey("233241234567") === "241234567", "phone formats match");

function bms_provider() {
  return { configured: bms.bmsConfigured, balance: bms.getVoiceBalance, sendVoice: bms.sendQuickVoice, report: bms.getCallReport, mapStatus: bms.mapCallStatus, phoneKey: bms.phoneKey };
}
Deno.exit(0);
