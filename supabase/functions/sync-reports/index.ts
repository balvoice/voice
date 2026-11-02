// BalVoice — sync-reports
// Runs every 2 minutes (pg_cron → supabase/cron.sql). Pulls call results from BMS,
// schedules retries for unanswered numbers, and finishes completed runs.
// Deploy: supabase functions deploy sync-reports --no-verify-jwt
// Secrets: BMS_API_KEY, CRON_SECRET

import { sync } from "../_shared/delivery.ts";
import { supabaseStore } from "../_shared/store.ts";
import { bmsProvider } from "../_shared/bms-provider.ts";
import { authorizedCron, json } from "../_shared/cron-auth.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!authorizedCron(req)) return json(401, { error: "Unauthorized" });
  try {
    const summary = await sync(supabaseStore(), bmsProvider, {
      reportTimeoutHours: Number(Deno.env.get("REPORT_TIMEOUT_HOURS") ?? "6"),
    });
    return json(200, summary);
  } catch (e) {
    console.error("sync-reports failed", e instanceof Error ? e.message : e);
    return json(500, { error: "sync failed" });
  }
});
