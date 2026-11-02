// BalVoice — dialer. Called every minute by pg_cron (see supabase/cron.sql).
// 1. starts campaigns that are due, 2. places the next batch of calls through the
// voice provider, 3. closes finished runs (and reschedules repeating campaigns).
// All queue rules (calling window, retries, opt-outs at dial time, leases) live in
// the database functions dialer_start_due / dialer_claim / dialer_report / dialer_finish.
//
// Secrets: DIALER_SECRET (shared with cron.sql), VOICE_PROVIDER (simulator | custom),
//          DIALER_BATCH (default 50), DIALER_CONCURRENCY (default 10), OPTOUT_DIGIT (default 9),
//          plus whatever the chosen provider needs (see _shared/voice-provider.ts).
// Deploy:  supabase functions deploy dialer --no-verify-jwt   (the shared secret authenticates)

import { env, json, serviceClient, timingSafeEqual } from "../_shared/http.ts";
import { getProvider, type OutboundCall, PermanentCallError, personalize } from "../_shared/voice-provider.ts";

interface Claimed {
  recipient_id: number; campaign_id: string; workspace_id: string; attempt: number;
  phone: string; first_name: string | null; last_name: string | null; company: string | null;
  message_type: "tts" | "audio"; tts_text: string | null; tts_language: string | null; tts_voice: string | null;
  audio_path: string | null; caller_id: string | null; sender_name: string;
}

const BATCH = Math.min(500, Math.max(1, Number(env("DIALER_BATCH", "50"))));
const CONCURRENCY = Math.min(50, Math.max(1, Number(env("DIALER_CONCURRENCY", "10"))));
const TIME_BUDGET_MS = 45_000; // stay well inside one cron minute

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(null, 405, { error: "method_not_allowed" });
  const secret = env("DIALER_SECRET");
  if (!secret || !timingSafeEqual(req.headers.get("x-dialer-secret") ?? "", secret)) return json(null, 401, { error: "unauthorized" });
  const provider = getProvider();
  if (!provider) return json(null, 503, { error: "VOICE_PROVIDER is not set; no calls placed" });

  const db = serviceClient();
  const started = Date.now();
  const stats = { provider: provider.name, started: 0, placed: 0, failed: 0, finished: 0 };
  const callback = env("SUPABASE_URL").replace(/\/$/, "") + "/functions/v1/call-status";
  const audioUrls = new Map<string, string>();

  const startRes = await db.rpc("dialer_start_due");
  if (startRes.error) return json(null, 500, { error: "start_due_failed", detail: startRes.error.message });
  stats.started = startRes.data ?? 0;

  while (Date.now() - started < TIME_BUDGET_MS) {
    const { data, error } = await db.rpc("dialer_claim", { p_limit: BATCH, p_lease_seconds: 300 });
    if (error) { console.error("dialer: claim failed", error.message); break; }
    const calls = (data ?? []) as Claimed[];
    if (!calls.length) break;

    await pool(calls, CONCURRENCY, async (c) => {
      try {
        let message: OutboundCall["message"];
        if (c.message_type === "tts") {
          message = { type: "tts", text: personalize(c.tts_text ?? "", c), language: c.tts_language ?? "en", voice: c.tts_voice ?? "female" };
        } else {
          if (!c.audio_path) throw new PermanentCallError("campaign has no audio file");
          let url = audioUrls.get(c.audio_path);
          if (!url) {
            const signed = await db.storage.from("campaign-audio").createSignedUrl(c.audio_path, 3600);
            if (signed.error || !signed.data) throw new Error("could not sign audio URL");
            url = signed.data.signedUrl;
            audioUrls.set(c.audio_path, url);
          }
          message = { type: "audio", url };
        }
        const placed = await provider.placeCall({
          recipientId: c.recipient_id, to: c.phone, callerId: c.caller_id, senderName: c.sender_name,
          message, statusCallbackUrl: callback, optOutDigit: env("OPTOUT_DIGIT", "9"),
        });
        if (placed.result) {
          await db.rpc("dialer_mark_sent", { p_recipient: c.recipient_id, p_provider_call_id: placed.providerCallId });
          await db.rpc("dialer_report", {
            p_recipient: c.recipient_id, p_outcome: placed.result.outcome, p_duration: placed.result.durationSec ?? null,
            p_provider_call_id: placed.providerCallId, p_opt_out: !!placed.result.optOut,
          });
        } else {
          await db.rpc("dialer_mark_sent", { p_recipient: c.recipient_id, p_provider_call_id: placed.providerCallId });
        }
        stats.placed++;
      } catch (e) {
        stats.failed++;
        if (e instanceof PermanentCallError) {
          await db.rpc("dialer_report", { p_recipient: c.recipient_id, p_outcome: "unreachable" });
        }
        // Other errors (network, provider outage): the lease expires and the call is retried.
        console.error("dialer: call failed", c.recipient_id, e instanceof Error ? e.message : "error");
      }
    });
  }

  const finishRes = await db.rpc("dialer_finish");
  if (finishRes.error) console.error("dialer: finish failed", finishRes.error.message);
  stats.finished = finishRes.data ?? 0;
  return json(null, 200, stats);
});
