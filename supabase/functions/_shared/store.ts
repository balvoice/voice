// BalVoice — Store implementation backed by Supabase (service role).
// Used by dispatch-campaigns and sync-reports. Bypasses RLS, so it must only run
// inside Edge Functions protected by the CRON_SECRET check.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.3";
import type { AudioFile, Campaign, Dispatch, ResultRow, Store, Target } from "./delivery.ts";

const CAMPAIGN_COLS =
  "id, workspace_id, name, status, message_type, audio_file_id, run_number, attempt_number, retries, retry_interval_min, window_start, window_end, timezone";

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

export function supabaseStore(db: SupabaseClient = adminClient()): Store {
  return {
    async claimWork(max) {
      return check(await db.rpc("claim_campaign_work", { max_count: max }), "claim_campaign_work") as Campaign[];
    },
    async snapshotRecipients(id) {
      return check(await db.rpc("snapshot_recipients", { cid: id }), "snapshot_recipients") as number;
    },
    async dispatchTargets(id) {
      return check(await db.rpc("dispatch_targets", { cid: id }), "dispatch_targets") as Target[];
    },
    async getAudio(id) {
      return check(await db.from("audio_files").select("id, storage_path, file_name, bms_voice_id").eq("id", id).maybeSingle(), "audio_files") as AudioFile | null;
    },
    async downloadAudio(path) {
      return check(await db.storage.from("campaign-audio").download(path), "download audio") as Blob;
    },
    async saveVoiceId(id, voiceId) {
      check(await db.from("audio_files").update({ bms_voice_id: voiceId }).eq("id", id), "save voice id");
    },
    async insertDispatch(d) {
      const row = check(await db.from("campaign_dispatches").insert(d).select("id").single(), "insert dispatch") as { id: number };
      return row.id;
    },
    async updateCampaign(id, patch) {
      check(await db.from("campaigns").update(patch).eq("id", id), "update campaign");
    },
    async addEvent(c, message) {
      check(await db.from("campaign_events").insert({ workspace_id: c.workspace_id, campaign_id: c.id, message: message.slice(0, 300), created_by: null }), "add event");
    },
    async openDispatches(limit) {
      return check(
        await db.from("campaign_dispatches")
          .select("id, workspace_id, campaign_id, run_number, attempt, provider_campaign_id, recipient_ids, created_at")
          .eq("status", "sent").order("last_synced_at", { ascending: true, nullsFirst: true }).limit(limit),
        "open dispatches",
      ) as Dispatch[];
    },
    async recipientsForRun(campaignId, run) {
      const rows = check(
        await db.from("campaign_recipients").select("id, phone").eq("campaign_id", campaignId).eq("run_number", run).limit(100000),
        "recipients",
      ) as { id: number; phone: string }[];
      return rows.map((r) => ({ recipient_id: r.id, phone: r.phone }));
    },
    async upsertResults(rows: ResultRow[]) {
      const payload = rows.map(({ run_number, ...r }) => ({ ...r, run_number, last_attempt_at: new Date().toISOString() }));
      for (let i = 0; i < payload.length; i += 1000) {
        check(await db.from("call_results").upsert(payload.slice(i, i + 1000), { onConflict: "recipient_id" }), "upsert results");
      }
    },
    async resultsForDispatch(dispatchId) {
      const rows = check(await db.from("call_results").select("recipient_id").eq("dispatch_id", dispatchId).limit(100000), "results for dispatch") as { recipient_id: number }[];
      return rows.map((r) => r.recipient_id);
    },
    async markDispatch(id, patch) {
      check(await db.from("campaign_dispatches").update(patch).eq("id", id), "mark dispatch");
    },
    async campaignsAwaitingDecision() {
      const running = check(
        await db.from("campaigns").select(CAMPAIGN_COLS).eq("status", "running").is("next_attempt_at", null).gt("attempt_number", 0).limit(100),
        "running campaigns",
      ) as Campaign[];
      if (!running.length) return [];
      const open = check(
        await db.from("campaign_dispatches").select("campaign_id").eq("status", "sent").in("campaign_id", running.map((c) => c.id)),
        "open dispatches by campaign",
      ) as { campaign_id: string }[];
      const busy = new Set(open.map((o) => o.campaign_id));
      return running.filter((c) => !busy.has(c.id));
    },
    async finishRun(id) {
      return check(await db.rpc("finish_campaign_run", { cid: id }), "finish_campaign_run") as string;
    },
  };
}
