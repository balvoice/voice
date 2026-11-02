// BalVoice — Supabase "Send SMS" Auth Hook → BMS Africa (mNotify) SMS API
// ---------------------------------------------------------------------------
// Supabase Auth calls this function whenever it needs to text a one-time code
// (phone sign-up, phone sign-in, phone change). The function:
//   1. verifies the request really comes from Supabase (Standard Webhooks signature),
//   2. checks the number is in an allowed country (stops SMS fraud to premium routes),
//   3. limits how many codes one number can receive per hour,
//   4. sends the code through the BMS SMS API (POST /sms/quick with sms_type "otp").
//
// Secrets (set with `supabase secrets set …`, never in the website's .env):
//   SEND_SMS_HOOK_SECRETS   "v1,whsec_…" from Authentication → Hooks
//   BMS_API_KEY             your BMS API key
//   BMS_SENDER_ID           sender ID approved by BMS AS AN OTP SENDER (registered with an otp_url,
//                           e.g. https://your-domain.com/login.html). BMS rejects OTP messages
//                           from regular sender IDs. Max 11 characters (e.g. BALVOICE).
//   BMS_BASE_URL            optional; defaults to https://api.mnotify.com/api
//   ALLOWED_PHONE_PREFIXES  optional; comma-separated country codes, default "233"
//   SMS_MAX_PER_HOUR        optional; default 5
//   OTP_EXPIRY_MINUTES      optional; shown in the message, default 10 (match Auth → SMS OTP expiry)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Deploy:  supabase functions deploy send-sms --no-verify-jwt
// (JWT verification is off because Auth calls the hook before a user session exists;
//  the webhook signature check below is what authenticates the request.)

import { Webhook } from "npm:standardwebhooks@1.0.0";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { BmsError, bmsConfigured, sendOtpSms } from "../_shared/bms.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const HOOK_SECRET = env("SEND_SMS_HOOK_SECRETS").replace("v1,whsec_", "");
const BMS_SENDER_ID = env("BMS_SENDER_ID");
const ALLOWED_PREFIXES = env("ALLOWED_PHONE_PREFIXES", "233").split(",").map((p) => p.trim()).filter(Boolean);
const MAX_PER_HOUR = Number(env("SMS_MAX_PER_HOUR", "5"));
const OTP_EXPIRY_MINUTES = Number(env("OTP_EXPIRY_MINUTES", "10"));

const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Supabase requires a JSON content type on every hook response.
function reply(status: number, body: Record<string, unknown> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
// Non-retryable failure: Supabase shows the user a generic "could not send SMS" error.
const fail = (message: string) => reply(400, { error: { http_code: 400, message } });

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
const redact = (digits: string) => digits.slice(0, 5) + "…" + digits.slice(-2);

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: { http_code: 405, message: "Method not allowed" } });
  if (!HOOK_SECRET || !bmsConfigured() || !BMS_SENDER_ID) {
    console.error("send-sms: missing configuration (hook secret, BMS_API_KEY or BMS_SENDER_ID)");
    return fail("SMS is not configured");
  }

  // 1. Verify the signature.
  const payload = await req.text();
  let event: { user?: { phone?: string }; sms?: { otp?: string } };
  try {
    event = new Webhook(HOOK_SECRET).verify(payload, Object.fromEntries(req.headers)) as typeof event;
  } catch {
    return reply(401, { error: { http_code: 401, message: "Invalid signature" } });
  }

  const digits = String(event.user?.phone ?? "").replace(/\D/g, "");
  const otp = String(event.sms?.otp ?? "");
  if (!/^\d{9,15}$/.test(digits) || !/^\d{4,10}$/.test(otp)) return fail("Invalid hook payload");

  // 2. Allowed countries only.
  if (!ALLOWED_PREFIXES.some((p) => digits.startsWith(p))) {
    console.warn("send-sms: blocked number outside allowed countries", redact(digits));
    return fail("Phone number country is not supported");
  }

  // 3. Per-number hourly limit (stored as a hash, never the raw number).
  const phoneHash = await sha256(digits);
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await admin
    .from("sms_otp_log").select("id", { count: "exact", head: true })
    .eq("phone_hash", phoneHash).gte("created_at", since);
  if (countError) console.error("send-sms: rate-limit lookup failed", countError.message);
  if ((count ?? 0) >= MAX_PER_HOUR) {
    console.warn("send-sms: hourly limit reached", redact(digits));
    return fail("Too many codes requested for this number. Try again later.");
  }

  // 4. Send through BMS.
  const message = `Your BalVoice code is ${otp}. It expires in ${OTP_EXPIRY_MINUTES} minutes. Never share this code with anyone.`;
  try {
    await sendOtpSms({ to: digits, sender: BMS_SENDER_ID, message, timeoutMs: 4000 }); // Auth gives hooks 5 s in total
  } catch (e) {
    // Never log the code or the full number.
    if (e instanceof BmsError) console.error("send-sms: BMS rejected the request", e.status, e.code, e.message);
    else console.error("send-sms: BMS request failed");
    return fail(e instanceof BmsError && /timed out|unreachable/.test(e.message) ? "SMS provider unavailable" : "SMS provider error");
  }

  const { error: logError } = await admin.from("sms_otp_log").insert({ phone_hash: phoneHash });
  if (logError) console.error("send-sms: could not record send", logError.message);
  return reply(200, {});
});
