// Test harness: fake BMS + fake Supabase REST, then call the real function with signed hook payloads.
import { Webhook } from "npm:standardwebhooks@1.0.0";
const secretB64 = btoa("test-secret-test-secret-123456");
const sent: any[] = []; const log: string[] = []; let bmsMode = "ok";
Deno.serve({ port: 8787, onListen() {} }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/api/sms/quick") {
    const body = await req.json(); sent.push({ key: u.searchParams.get("key"), body });
    if (bmsMode === "reject") return Response.json({ status: "error", code: "1003", message: "Insufficient balance" }, { status: 200 });
    if (bmsMode === "slow") { await new Promise(r => setTimeout(r, 6000)); }
    return Response.json({ status: "success", code: "2000", message: "messages sent successfully" });
  }
  if (u.pathname === "/rest/v1/sms_otp_log") {
    if (req.method === "POST") { const b = await req.json(); log.push(b.phone_hash ?? b[0]?.phone_hash); return new Response(null, { status: 201 }); }
    const h = (u.searchParams.get("phone_hash") || "").replace("eq.", "");
    const n = log.filter(x => x === h).length;
    return new Response(null, { status: 200, headers: { "content-range": `*/${n}` } });
  }
  return new Response("nf", { status: 404 });
});
const proc = new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-net", "--allow-env", Deno.args[0]],
  env: { SEND_SMS_HOOK_SECRETS: "v1,whsec_" + secretB64, BMS_API_KEY: "KEY123", BMS_SENDER_ID: "BALVOICE",
         BMS_BASE_URL: "http://127.0.0.1:8787/api", SUPABASE_URL: "http://127.0.0.1:8787", SUPABASE_SERVICE_ROLE_KEY: "service", SMS_MAX_PER_HOUR: "3" },
  stdout: "null", stderr: "piped",
}).spawn();
await new Promise(r => setTimeout(r, 2500));
const wh = new Webhook(secretB64);
async function call(phone: string, otp = "123456", sign = true) {
  const payload = JSON.stringify({ user: { id: "u1", phone }, sms: { otp } });
  const id = "msg_" + crypto.randomUUID(); const ts = new Date();
  const headers: Record<string, string> = { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(Math.floor(ts.getTime() / 1000)) };
  headers["webhook-signature"] = sign ? wh.sign(id, ts, payload) : "v1,bad";
  const res = await fetch("http://127.0.0.1:8000/", { method: "POST", headers, body: payload });
  return `${res.status} ${res.headers.get("content-type")} ${await res.text()}`;
}
console.log("valid GH number      →", await call("233241234567"));
console.log("BMS request          →", JSON.stringify(sent[0]));
console.log("bad signature        →", await call("233241234567", "123456", false));
console.log("Nigerian number      →", await call("2348012345678"));
console.log("2nd + 3rd send       →", await call("233241234567"), "|", await call("233241234567"));
console.log("4th send (limit 3)   →", await call("233241234567"));
bmsMode = "reject";
console.log("BMS rejects          →", await call("233209999999"));
bmsMode = "slow";
const t0 = Date.now(); const r = await call("233208888888");
console.log("BMS timeout          →", r, `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
proc.kill();
const err = new TextDecoder().decode((await proc.output()).stderr);
console.log("function logs contain the code? ", /123456/.test(err), "| full number? ", /233241234567/.test(err));
console.log(err.split("\n").filter(l => l.includes("send-sms")).join("\n"));
Deno.exit(0);
