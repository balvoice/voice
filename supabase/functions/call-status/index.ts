// BalVoice — call status webhook from the voice provider.
// The provider adapter verifies the request; each update is matched to the queued
// call by the provider's call ID and recorded with dialer_report (which schedules
// retries and adds keypress opt-outs to the client's register).
//
// Secrets: VOICE_PROVIDER, CALL_STATUS_SECRET (or the provider's own signing secret)
// Deploy:  supabase functions deploy call-status --no-verify-jwt   (the provider signature authenticates)

import { json, serviceClient } from "../_shared/http.ts";
import { getProvider } from "../_shared/voice-provider.ts";

const OUTCOMES = ["answered", "busy", "noanswer", "unreachable"];

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(null, 405, { error: "method_not_allowed" });
  const provider = getProvider();
  if (!provider) return json(null, 503, { error: "VOICE_PROVIDER is not set" });
  const raw = await req.text();
  if (raw.length > 256_000) return json(null, 413, { error: "too_large" });

  let updates;
  try {
    updates = await provider.parseStatus(req, raw);
  } catch {
    return json(null, 401, { error: "invalid_signature_or_body" });
  }

  const db = serviceClient();
  const results: Record<string, number> = { final: 0, retry: 0, ignored: 0, unknown: 0 };
  for (const u of updates) {
    if (!u.providerCallId || !OUTCOMES.includes(u.outcome)) { results.unknown++; continue; }
    const { data: id } = await db.rpc("dialer_find_call", { p_provider_call_id: u.providerCallId });
    if (!id) { results.unknown++; continue; }
    const { data, error } = await db.rpc("dialer_report", {
      p_recipient: id, p_outcome: u.outcome, p_duration: u.durationSec ?? null,
      p_provider_call_id: u.providerCallId, p_opt_out: !!u.optOut,
    });
    if (error) { console.error("call-status: report failed", error.message); return json(null, 500, { error: "report_failed" }); }
    results[String(data)] = (results[String(data)] ?? 0) + 1;
  }
  // 2xx tells the provider not to resend.
  return json(null, 200, results);
});
