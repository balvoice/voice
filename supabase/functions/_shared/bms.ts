// BalVoice — BMS Africa (mNotify) API client
// ---------------------------------------------------------------------------
// Reference: https://developer.bms.africa/  (BMS API v2.0)
//   Base URL       https://api.mnotify.com/api
//   Auth           API key as a query parameter: ?key=YOUR_API_KEY
//   Responses      JSON; success = { status: "success", code: "2000", ... }
//
// Endpoints used by BalVoice:
//   POST /sms/quick        sign-in codes (sms_type: "otp", needs an OTP sender ID)
//   POST /voice/quick      voice broadcast (multipart: campaign, recipient[], file | voice_id)
//   GET  /calls/<id>       per-number voice results for a voice campaign id
//   GET  /balance/voice    voice credit balance
//
// The API key is only ever read from Edge Function secrets (BMS_API_KEY).

const BASE = (Deno.env.get("BMS_BASE_URL") ?? "https://api.mnotify.com/api").replace(/\/$/, "");
const KEY = Deno.env.get("BMS_API_KEY") ?? "";

export class BmsError extends Error {
  constructor(message: string, readonly status = 0, readonly code = "") {
    super(message);
    this.name = "BmsError";
  }
}

export const bmsConfigured = () => KEY.length > 0;

function url(path: string, query: Record<string, string> = {}) {
  const u = new URL(BASE + path);
  u.searchParams.set("key", KEY);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

async function call(path: string, init: RequestInit & { query?: Record<string, string>; timeoutMs?: number } = {}) {
  const { query, timeoutMs = 20000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url(path, query), { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new BmsError(e instanceof Error && e.name === "TimeoutError" ? "BMS request timed out" : "BMS unreachable");
  }
  // deno-lint-ignore no-explicit-any
  const body: any = await res.json().catch(() => ({}));
  const ok = res.ok && (body.status === "success" || String(body.code) === "2000");
  if (!ok) throw new BmsError(String(body.message ?? `BMS error ${res.status}`), res.status, String(body.code ?? ""));
  return body;
}

/** Phone numbers as BMS expects them: digits only, e.g. 233241234567 or 0241234567. */
export const bmsNumber = (phone: string) => String(phone).replace(/\D/g, "");

/** Last 9 digits — matches 0241234567, 233241234567 and +233241234567 to the same subscriber. */
export const phoneKey = (phone: string) => bmsNumber(phone).slice(-9);

// ---- SMS --------------------------------------------------------------------

export async function sendOtpSms(opts: { to: string; sender: string; message: string; timeoutMs?: number }) {
  return await call("/sms/quick", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      recipient: [bmsNumber(opts.to)],
      sender: opts.sender,
      message: opts.message,
      is_schedule: false,
      schedule_date: "",
      sms_type: "otp", // required by BMS for one-time codes; sender ID must be registered as an OTP sender
    }),
    timeoutMs: opts.timeoutMs ?? 4000,
  });
}

// ---- Voice ------------------------------------------------------------------

export interface VoiceSendResult {
  campaignId: string; // BMS "_id", used to fetch the call report
  voiceId: string;    // reuse instead of uploading the same audio again
  totalSent: number;
  totalRejected: number;
  creditUsed: number;
}

/** Send a recorded message to a list of numbers. Pass either an audio file or a voiceId from an earlier send. */
export async function sendQuickVoice(opts: {
  title: string;
  recipients: string[];
  audio?: { data: Blob; filename: string };
  voiceId?: string;
}): Promise<VoiceSendResult> {
  if (!opts.audio === !opts.voiceId) throw new BmsError("Provide either an audio file or a voice id");
  const form = new FormData();
  form.set("campaign", opts.title.slice(0, 100));
  for (const r of opts.recipients) form.append("recipient[]", bmsNumber(r));
  if (opts.audio) {
    form.set("file", opts.audio.data, opts.audio.filename);
    form.set("voice_id", "");
  } else {
    form.set("voice_id", opts.voiceId!);
  }
  form.set("is_schedule", "false");
  form.set("schedule_date", "");
  const body = await call("/voice/quick", { method: "POST", body: form, timeoutMs: 60000 });
  const s = body.summary ?? {};
  if (!s._id) throw new BmsError("BMS did not return a campaign id");
  return {
    campaignId: String(s._id),
    voiceId: String(s.voice_id ?? opts.voiceId ?? ""),
    totalSent: Number(s.total_sent ?? 0),
    totalRejected: Number(s.total_rejected ?? 0),
    creditUsed: Number(s.credit_used ?? 0),
  };
}

export interface CallReportRow {
  id: string;
  recipient: string;
  status: string;      // "pending" | "received" | "missed" | other provider values
  durationSec: number;
  answerTime: string | null;
  retries: number;
}

/** Per-number results for a BMS voice campaign. */
export async function getCallReport(campaignId: string): Promise<CallReportRow[]> {
  const body = await call(`/calls/${encodeURIComponent(campaignId)}`, { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const rows: any[] = Array.isArray(body.report) ? body.report : [];
  return rows.map((r) => ({
    id: String(r._id ?? ""),
    recipient: String(r.recipient ?? ""),
    status: String(r.status ?? "").toLowerCase(),
    durationSec: Number(r.total_duration ?? 0) || 0,
    answerTime: r.answer_time && !String(r.answer_time).startsWith("0000") ? String(r.answer_time) : null,
    retries: Number(r.retries ?? 0) || 0,
  }));
}

export async function getVoiceBalance(): Promise<number> {
  const body = await call("/balance/voice", { method: "GET", timeoutMs: 10000 });
  return Number(body.balance ?? 0);
}

/** Map a BMS call status to a BalVoice outcome. null = still pending. */
export function mapCallStatus(status: string): "answered" | "busy" | "noanswer" | "unreachable" | null {
  const s = status.toLowerCase().trim();
  if (s === "pending" || s === "queued" || s === "submitted" || s === "") return null;
  if (s === "received" || s === "answered" || s === "completed") return "answered";
  if (s === "missed" || s === "no answer" || s === "noanswer" || s === "no_answer") return "noanswer";
  if (s === "busy") return "busy";
  return "unreachable"; // failed, rejected, invalid, unreachable, …
}
