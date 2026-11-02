// BalVoice — dispatch-campaigns
// Runs every minute (pg_cron → supabase/cron.sql). Sends due campaigns to BMS.
// Deploy: supabase functions deploy dispatch-campaigns --no-verify-jwt
// Secrets: BMS_API_KEY, CRON_SECRET (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are automatic)

import { dispatch } from "../_shared/delivery.ts";
import { supabaseStore } from "../_shared/store.ts";
import { bmsProvider } from "../_shared/bms-provider.ts";
import { authorizedCron, json } from "../_shared/cron-auth.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!authorizedCron(req)) return json(401, { error: "Unauthorized" });
  try {
    const summary = await dispatch(supabaseStore(), bmsProvider, {
      chunkSize: Number(Deno.env.get("BMS_CHUNK_SIZE") ?? "500"),
    });
    return json(200, summary);
  } catch (e) {
    console.error("dispatch-campaigns failed", e instanceof Error ? e.message : e);
    return json(500, { error: "dispatch failed" });
  }
});
