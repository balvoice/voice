// BalVoice — "Stop receiving calls" (public).
// Adds a number to the global opt-out register, which every client's campaigns respect.
// The response is the same whether or not the number was already listed.
//
// Secrets: SITE_URL (or SITE_ORIGINS), RATE_LIMIT_SALT, OPTOUT_MAX_PER_HOUR (default 5)
// Deploy:  supabase functions deploy opt-out --no-verify-jwt

import { corsHeaders, env, ipKey, json, normalizePhone, originAllowed, readJson, serviceClient, str } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });
  if (!originAllowed(req)) return json(req, 403, { error: "origin_not_allowed" });

  const b = await readJson(req, 2_000);
  if (!b) return json(req, 400, { error: "invalid_body" });
  if (str(b.website, 200)) return json(req, 200, { ok: true });
  const phone = normalizePhone(b.phone);
  if (!phone) return json(req, 422, { error: "validation_failed", fields: { phone: "invalid" } });

  const db = serviceClient();
  const { data: allowed, error: rlError } = await db.rpc("rate_limit_hit", {
    p_bucket: "opt-out", p_key_hash: await ipKey(req), p_max: Number(env("OPTOUT_MAX_PER_HOUR", "5")), p_window_seconds: 3600,
  });
  if (rlError) { console.error("opt-out: rate limit check failed", rlError.message); return json(req, 503, { error: "unavailable" }); }
  if (!allowed) return json(req, 429, { error: "too_many_requests" });

  const { error } = await db.from("global_opt_outs").upsert({ phone, source: "Website request" }, { onConflict: "phone", ignoreDuplicates: true });
  if (error) { console.error("opt-out: insert failed", error.code); return json(req, 500, { error: "could_not_save" }); }
  return json(req, 200, { ok: true });
});
