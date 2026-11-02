// BalVoice — campaign delivery logic (provider-independent core)
// ---------------------------------------------------------------------------
// Two jobs, each run on a schedule by pg_cron (see supabase/cron.sql):
//
//   dispatch()  every minute — for each due campaign: check the calling window,
//               freeze the recipient list, get the audio, send to BMS in chunks,
//               and record each send in campaign_dispatches.
//
//   sync()      every few minutes — poll BMS for call results of open sends,
//               write them to call_results, and when a send is final decide:
//               retry the unanswered (after the retry interval), or finish the run
//               (which completes the campaign or schedules its next repeat).
//
// All database access goes through the Store interface, so this logic is tested
// with an in-memory store and a fake BMS (supabase/tests/delivery-harness.ts).

import type { CallReportRow, VoiceSendResult } from "./bms.ts";

export type Outcome = "answered" | "busy" | "noanswer" | "unreachable";

export interface Campaign {
  id: string;
  workspace_id: string;
  name: string;
  status: string;
  message_type: "audio" | "tts";
  audio_file_id: string | null;
  run_number: number;
  attempt_number: number;
  retries: number;
  retry_interval_min: number;
  window_start: string; // "09:00:00"
  window_end: string;   // "19:00:00"
  timezone: string;
}
export interface AudioFile { id: string; storage_path: string; file_name: string; bms_voice_id: string | null }
export interface Target { recipient_id: number; phone: string }
export interface Dispatch {
  id: number;
  workspace_id: string;
  campaign_id: string;
  run_number: number;
  attempt: number;
  provider_campaign_id: string;
  recipient_ids: number[];
  created_at: string;
}
export interface ResultRow {
  workspace_id: string;
  campaign_id: string;
  recipient_id: number;
  run_number: number;
  outcome: Outcome;
  attempts: number;
  duration_sec: number;
  dispatch_id: number;
  provider_call_id: string | null;
  raw_status: string;
}

export interface Store {
  claimWork(max: number): Promise<Campaign[]>;
  snapshotRecipients(campaignId: string): Promise<number>;
  dispatchTargets(campaignId: string): Promise<Target[]>;
  getAudio(audioId: string): Promise<AudioFile | null>;
  downloadAudio(path: string): Promise<Blob>;
  saveVoiceId(audioId: string, voiceId: string): Promise<void>;
  insertDispatch(d: Omit<Dispatch, "id" | "created_at"> & { total_rejected: number; credit_used: number }): Promise<number>;
  updateCampaign(id: string, patch: Partial<{ attempt_number: number; next_attempt_at: string | null; last_error: string | null; status: string }>): Promise<void>;
  addEvent(c: { id: string; workspace_id: string }, message: string): Promise<void>;
  openDispatches(limit: number): Promise<Dispatch[]>;
  recipientsForRun(campaignId: string, run: number): Promise<Target[]>;
  upsertResults(rows: ResultRow[]): Promise<void>;
  resultsForDispatch(dispatchId: number): Promise<number[]>; // recipient ids that have a result from this dispatch
  markDispatch(id: number, patch: { status?: "final" | "failed"; last_synced_at: string; final_at?: string }): Promise<void>;
  campaignsAwaitingDecision(): Promise<Campaign[]>; // running, next_attempt_at null (not leased or deferred), no open dispatch, attempted at least once
  finishRun(campaignId: string): Promise<string>;
}

export interface Provider {
  configured(): boolean;
  balance(): Promise<number>;
  sendVoice(opts: { title: string; recipients: string[]; audio?: { data: Blob; filename: string }; voiceId?: string }): Promise<VoiceSendResult>;
  report(providerCampaignId: string): Promise<CallReportRow[]>;
  mapStatus(status: string): Outcome | null;
  phoneKey(phone: string): string;
}

export interface Options {
  now?: () => Date;
  chunkSize?: number;            // numbers per BMS request
  maxCampaignsPerRun?: number;
  reportTimeoutHours?: number;   // after this, numbers still "pending" count as no answer
  log?: (...args: unknown[]) => void;
}

const MIN = 60_000;

// ---- Calling window ------------------------------------------------------------

/** Minutes since local midnight in the campaign's time zone. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}
const toMinutes = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };

/** null if calls may be placed now; otherwise the time the window next opens. */
export function nextWindowOpening(now: Date, c: Pick<Campaign, "window_start" | "window_end" | "timezone">): Date | null {
  const cur = localMinutes(now, c.timezone || "Africa/Accra");
  const start = toMinutes(c.window_start), end = toMinutes(c.window_end);
  if (cur >= start && cur < end) return null;
  const wait = cur < start ? start - cur : 24 * 60 - cur + start;
  return new Date(now.getTime() + wait * MIN);
}

// ---- Dispatch -------------------------------------------------------------------

export async function dispatch(store: Store, bms: Provider, opts: Options = {}) {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? console.log;
  const chunk = opts.chunkSize ?? 500;
  const summary = { claimed: 0, sent: 0, deferred: 0, failed: 0, empty: 0 };

  if (!bms.configured()) { log("dispatch: BMS is not configured"); return summary; }
  const campaigns = await store.claimWork(opts.maxCampaignsPerRun ?? 5);
  summary.claimed = campaigns.length;
  if (!campaigns.length) return summary;

  let balance: number | null = null;
  try { balance = await bms.balance(); } catch (e) { log("dispatch: could not read BMS balance", String(e)); }

  for (const c of campaigns) {
    const retryLater = async (minutes: number, reason: string, eventText?: string) => {
      await store.updateCampaign(c.id, { next_attempt_at: new Date(now().getTime() + minutes * MIN).toISOString(), last_error: reason.slice(0, 300) });
      if (eventText) await store.addEvent(c, eventText);
    };
    try {
      // 1. Calling window.
      const opens = nextWindowOpening(now(), c);
      if (opens) {
        await store.updateCampaign(c.id, { next_attempt_at: opens.toISOString() });
        summary.deferred++;
        continue;
      }
      // 2. Provider credit.
      if (balance !== null && balance <= 0) {
        summary.failed++;
        await retryLater(30, "BMS voice balance is empty", "Delivery waiting: the BMS voice balance is empty. It will retry automatically.");
        continue;
      }
      // 3. Message audio. BMS voice needs a recorded file; text-to-speech must be rendered to audio first.
      if (c.message_type !== "audio" || !c.audio_file_id) {
        summary.failed++;
        await store.updateCampaign(c.id, { status: "paused", last_error: "Text-to-speech audio engine not configured" });
        await store.addEvent(c, "Paused: text-to-speech campaigns need an audio engine, which is not set up yet. Upload a recording instead.");
        continue;
      }
      const audio = await store.getAudio(c.audio_file_id);
      if (!audio) { summary.failed++; await store.updateCampaign(c.id, { status: "paused", last_error: "Audio file missing" }); await store.addEvent(c, "Paused: the audio file could not be found."); continue; }

      // 4. Who to call.
      const firstAttempt = c.attempt_number === 0;
      if (firstAttempt) await store.snapshotRecipients(c.id);
      const targets = await store.dispatchTargets(c.id);
      if (!targets.length) {
        summary.empty++;
        if (firstAttempt) await store.addEvent(c, "No one to call: the selected groups are empty or everyone has opted out.");
        await store.updateCampaign(c.id, { attempt_number: Math.max(1, c.attempt_number) });
        await store.finishRun(c.id);
        continue;
      }

      // 5. Send in chunks. The first chunk uploads the audio; the rest reuse BMS's voice id.
      const attempt = c.attempt_number + 1;
      let voiceId = audio.bms_voice_id ?? undefined;
      let sentCount = 0, rejected = 0;
      for (let i = 0; i < targets.length; i += chunk) {
        const part = targets.slice(i, i + chunk);
        const send = await bms.sendVoice({
          title: `${c.name} · run ${c.run_number}${attempt > 1 ? ` · retry ${attempt - 1}` : ""}`,
          recipients: part.map((t) => t.phone),
          ...(voiceId ? { voiceId } : { audio: { data: await store.downloadAudio(audio.storage_path), filename: audio.file_name } }),
        });
        if (!voiceId && send.voiceId) { voiceId = send.voiceId; await store.saveVoiceId(audio.id, voiceId); }
        await store.insertDispatch({
          workspace_id: c.workspace_id, campaign_id: c.id, run_number: c.run_number, attempt,
          provider_campaign_id: send.campaignId, recipient_ids: part.map((t) => t.recipient_id),
          total_rejected: send.totalRejected, credit_used: send.creditUsed,
        });
        sentCount += send.totalSent; rejected += send.totalRejected;
      }
      await store.updateCampaign(c.id, { attempt_number: attempt, next_attempt_at: null, last_error: null });
      const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
      await store.addEvent(c, `${attempt === 1 ? "Calls started" : `Retry ${attempt - 1} started`}: ${plural(targets.length, "number")} sent to BMS${rejected ? `, ${rejected} rejected by the network` : ""}`);
      summary.sent++;
    } catch (e) {
      summary.failed++;
      const msg = e instanceof Error ? e.message : String(e);
      log("dispatch: campaign failed", c.id, msg);
      await retryLater(10, msg, `Sending failed (${msg.slice(0, 120)}). Retrying in 10 minutes.`).catch(() => {});
    }
  }
  return summary;
}

// ---- Sync ----------------------------------------------------------------------------

export async function sync(store: Store, bms: Provider, opts: Options = {}) {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? console.log;
  const timeoutMs = (opts.reportTimeoutHours ?? 6) * 60 * MIN;
  const summary = { checked: 0, results: 0, finalized: 0, retries: 0, finished: 0 };
  if (!bms.configured()) return summary;

  // 1. Pull results for open sends.
  const open = await store.openDispatches(50);
  const recipientCache = new Map<string, Map<string, number>>();
  for (const d of open) {
    summary.checked++;
    try {
      const report = await bms.report(d.provider_campaign_id);
      const cacheKey = `${d.campaign_id}:${d.run_number}`;
      if (!recipientCache.has(cacheKey)) {
        const list = await store.recipientsForRun(d.campaign_id, d.run_number);
        recipientCache.set(cacheKey, new Map(list.map((r) => [bms.phoneKey(r.phone), r.recipient_id])));
      }
      const byKey = recipientCache.get(cacheKey)!;
      const inThisSend = new Set(d.recipient_ids);
      const rows: ResultRow[] = [];
      let pending = 0;
      for (const r of report) {
        const rid = byKey.get(bms.phoneKey(r.recipient));
        if (!rid || !inThisSend.has(rid)) continue;
        const outcome = bms.mapStatus(r.status);
        if (!outcome) { pending++; continue; }
        rows.push({ workspace_id: d.workspace_id, campaign_id: d.campaign_id, recipient_id: rid, run_number: d.run_number,
          outcome, attempts: d.attempt, duration_sec: r.durationSec, dispatch_id: d.id, provider_call_id: r.id || null, raw_status: r.status.slice(0, 40) });
      }
      if (rows.length) { await store.upsertResults(rows); summary.results += rows.length; }

      const expired = now().getTime() - new Date(d.created_at).getTime() > timeoutMs;
      const reported = new Set([...(await store.resultsForDispatch(d.id))]);
      const missing = d.recipient_ids.filter((id) => !reported.has(id));
      // Final when BMS has a result for every number it reported, or the send is too old to wait for.
      if (expired || (pending === 0 && report.length > 0)) {
        // Numbers BMS never reported (rejected, or still pending after the timeout).
        if (missing.length) {
          await store.upsertResults(missing.map((rid) => ({ workspace_id: d.workspace_id, campaign_id: d.campaign_id, recipient_id: rid,
            run_number: d.run_number, outcome: expired ? "noanswer" : "unreachable", attempts: d.attempt, duration_sec: 0,
            dispatch_id: d.id, provider_call_id: null, raw_status: expired ? "timeout" : "not_reported" })));
        }
        await store.markDispatch(d.id, { status: "final", last_synced_at: now().toISOString(), final_at: now().toISOString() });
        summary.finalized++;
      } else {
        await store.markDispatch(d.id, { last_synced_at: now().toISOString() });
      }
    } catch (e) {
      log("sync: report failed", d.id, e instanceof Error ? e.message : String(e));
    }
  }

  // 2. Decide what happens next for campaigns whose sends are all final.
  for (const c of await store.campaignsAwaitingDecision()) {
    const remaining = await store.dispatchTargets(c.id);
    if (remaining.length && c.attempt_number <= c.retries) {
      const at = new Date(now().getTime() + c.retry_interval_min * MIN);
      await store.updateCampaign(c.id, { next_attempt_at: at.toISOString() });
      await store.addEvent(c, `${remaining.length} not answered. Retry ${c.attempt_number} in ${c.retry_interval_min} minutes.`);
      summary.retries++;
    } else {
      const r = await store.finishRun(c.id);
      summary.finished++;
      log("sync: run finished", c.id, r);
    }
  }
  return summary;
}
