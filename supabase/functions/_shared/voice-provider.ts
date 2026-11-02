// Voice provider adapter — the only file that knows which telephony company places the calls.
// ---------------------------------------------------------------------------
// The dialer and call-status functions talk to this interface. To connect the
// real provider, fill in `customProvider` below (or add a new one) and set the
// secret VOICE_PROVIDER to its name. Nothing else needs to change.
//
//   VOICE_PROVIDER=simulator   no calls are placed; random outcomes are recorded
//                              and marked "sim-" so the dashboard labels them as simulated.
//   VOICE_PROVIDER=custom      your provider (to be written once it is chosen).

import { env, hmacSha256Hex, timingSafeEqual } from "./http.ts";

export type Outcome = "answered" | "busy" | "noanswer" | "unreachable";

export interface OutboundCall {
  recipientId: number;
  to: string;                       // E.164, e.g. +233244123456
  callerId: string | null;          // approved caller ID, or null for the provider's default number
  senderName: string;
  message:
    | { type: "tts"; text: string; language: string; voice: string } // text already personalised
    | { type: "audio"; url: string };                                 // short-lived signed URL (MP3/WAV)
  statusCallbackUrl: string;        // where the provider should report the result
  optOutDigit: string;              // keypress that means "stop calling me"
}

export interface PlaceResult {
  providerCallId: string;
  /** Set only when the provider answers synchronously (the simulator does). */
  result?: { outcome: Outcome; durationSec?: number; optOut?: boolean };
}

export interface StatusUpdate {
  providerCallId: string;
  outcome: Outcome;
  durationSec?: number;
  optOut?: boolean;
}

/** Thrown for errors that will not succeed on retry (e.g. the provider rejects the number). */
export class PermanentCallError extends Error {}

export interface VoiceProvider {
  name: string;
  placeCall(call: OutboundCall): Promise<PlaceResult>;
  /** Verify the callback really came from the provider and turn it into status updates. */
  parseStatus(req: Request, rawBody: string): Promise<StatusUpdate[]>;
}

// Simulator ------------------------------------------------------------------------------------

const simulator: VoiceProvider = {
  name: "simulator",
  async placeCall(call) {
    const r = Math.random();
    const outcome: Outcome = r < 0.58 ? "answered" : r < 0.70 ? "busy" : r < 0.88 ? "noanswer" : "unreachable";
    return {
      providerCallId: "sim-" + crypto.randomUUID(),
      result: {
        outcome,
        durationSec: outcome === "answered" ? 10 + Math.floor(Math.random() * 50) : undefined,
        optOut: outcome === "answered" && Math.random() < 0.01,
      },
    };
  },
  async parseStatus() {
    throw new Error("The simulator does not send status callbacks");
  },
};

// Custom provider (fill in once the provider is chosen) ----------------------------------------
// Typical shape of a voice API: POST the number, caller ID and either a TTS
// script or an audio URL; receive a call ID; get the result later on a webhook.
// The parseStatus below accepts a neutral JSON body signed with CALL_STATUS_SECRET:
//   X-BalVoice-Signature: <hex HMAC-SHA256 of the raw body>
//   {"call_id":"…","outcome":"answered|busy|noanswer|unreachable","duration_sec":42,"digits":"9"}
// Replace it with the provider's own signature scheme and payload.

const customProvider: VoiceProvider = {
  name: "custom",
  async placeCall(_call) {
    const url = env("VOICE_API_URL");
    if (!url) throw new Error("VOICE_API_URL is not set");
    // const res = await fetch(url, {
    //   method: "POST",
    //   headers: { Authorization: `Bearer ${env("VOICE_API_KEY")}`, "Content-Type": "application/json" },
    //   body: JSON.stringify({ to: _call.to, from: _call.callerId, ... , callback: _call.statusCallbackUrl }),
    //   signal: AbortSignal.timeout(10_000),
    // });
    // if (res.status === 400 || res.status === 422) throw new PermanentCallError("rejected");
    // if (!res.ok) throw new Error("provider " + res.status);
    // return { providerCallId: (await res.json()).id };
    throw new Error("The custom voice provider has not been written yet (see _shared/voice-provider.ts)");
  },
  async parseStatus(req, rawBody) {
    const secret = env("CALL_STATUS_SECRET");
    const sig = req.headers.get("x-balvoice-signature") ?? "";
    if (!secret || !timingSafeEqual(await hmacSha256Hex(secret, rawBody), sig)) throw new Error("bad signature");
    const b = JSON.parse(rawBody);
    const items = Array.isArray(b) ? b : [b];
    return items.map((x) => ({
      providerCallId: String(x.call_id ?? ""),
      outcome: x.outcome as Outcome,
      durationSec: Number.isFinite(Number(x.duration_sec)) ? Number(x.duration_sec) : undefined,
      optOut: x.digits != null && String(x.digits).includes(env("OPTOUT_DIGIT", "9")),
    }));
  },
};

const PROVIDERS: Record<string, VoiceProvider> = { simulator, custom: customProvider };

export function getProvider(): VoiceProvider | null {
  return PROVIDERS[env("VOICE_PROVIDER")] ?? null;
}

/** {first_name}, {first_name|fallback}, {last_name}, {full_name}, {company} — same as the dashboard. */
export function personalize(text: string, c: { first_name?: string | null; last_name?: string | null; company?: string | null }): string {
  const full = [c.first_name, c.last_name].filter(Boolean).join(" ");
  const value: Record<string, string> = {
    first_name: c.first_name ?? "", last_name: c.last_name ?? "", full_name: full, company: c.company ?? "",
  };
  return text.replace(/\{(first_name|last_name|full_name|company)(?:\|([^}]{0,40}))?\}/g, (_, f, fb) => value[f] || fb || "");
}
