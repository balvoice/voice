// BalVoice — website campaign request form (public).
// Re-validates every field, drops honeypot submissions, rate-limits by hashed IP,
// stores the request with consent timestamps, and optionally emails the team.
//
// Secrets: SITE_URL (or SITE_ORIGINS), RATE_LIMIT_SALT, FORM_MAX_PER_HOUR (default 5),
//          optional RESEND_API_KEY + NOTIFY_EMAIL + NOTIFY_FROM for an email to staff.
// Deploy:  supabase functions deploy request-form --no-verify-jwt

import { corsHeaders, env, ipKey, json, normalizePhone, originAllowed, readJson, serviceClient, str } from "../_shared/http.ts";

const TYPES = ["church", "political", "organization", "other"];
const SIZES = ["under-1000", "1000-10000", "10000-50000", "over-50000", "unsure"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const truthy = (v: unknown) => v === true || v === "on" || v === "true" || v === "1";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });
  if (!originAllowed(req)) return json(req, 403, { error: "origin_not_allowed" });

  const b = await readJson(req, 12_000);
  if (!b) return json(req, 400, { error: "invalid_body" });
  // Honeypot: pretend success so bots learn nothing.
  if (str(b.website, 200)) return json(req, 200, { ok: true });

  const errors: Record<string, string> = {};
  const organization = str(b.organization, 121), name = str(b.name, 81), email = str(b.email, 161);
  const phone = normalizePhone(b.phone), message = str(b.message, 2001), date = str(b.preferred_date, 10);
  if (organization.length < 2 || organization.length > 120) errors.organization = "invalid";
  if (name.length < 2 || name.length > 80) errors.name = "invalid";
  if (!EMAIL.test(email) || email.length > 160) errors.email = "invalid";
  if (!phone) errors.phone = "invalid";
  if (!TYPES.includes(String(b.campaign_type))) errors.campaign_type = "invalid";
  if (!SIZES.includes(String(b.list_size))) errors.list_size = "invalid";
  if (message.length > 2000) errors.message = "too_long";
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.preferred_date = "invalid";
  if (!truthy(b.consent_contacts)) errors.consent_contacts = "required";
  if (!truthy(b.consent_optout)) errors.consent_optout = "required";
  if (Object.keys(errors).length) return json(req, 422, { error: "validation_failed", fields: errors });

  const db = serviceClient();
  const key = await ipKey(req);
  const perIp = await db.rpc("rate_limit_hit", { p_bucket: "request-form", p_key_hash: key, p_max: Number(env("FORM_MAX_PER_HOUR", "5")), p_window_seconds: 3600 });
  const overall = await db.rpc("rate_limit_hit", { p_bucket: "request-form-all", p_key_hash: "all", p_max: 300, p_window_seconds: 86400 });
  if (perIp.error || overall.error) { console.error("request-form: rate limit check failed", perIp.error?.message ?? overall.error?.message); return json(req, 503, { error: "unavailable" }); }
  if (!perIp.data || !overall.data) return json(req, 429, { error: "too_many_requests" });

  const now = new Date().toISOString();
  const { error } = await db.from("campaign_requests").insert({
    organization, contact_name: name, email, phone, campaign_type: b.campaign_type, list_size: b.list_size,
    preferred_date: date || null, message: message || null,
    consent_contacts_at: now, consent_optout_at: now, ip_hash: key,
  });
  if (error) { console.error("request-form: insert failed", error.code, error.message); return json(req, 500, { error: "could_not_save" }); }

  const resendKey = env("RESEND_API_KEY"), to = env("NOTIFY_EMAIL");
  if (resendKey && to) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env("NOTIFY_FROM", "BalVoice <noreply@example.com>"), to: [to],
          subject: `New campaign request: ${organization}`,
          text: `${organization} (${b.campaign_type}, ${b.list_size}) asked for a campaign.\nOpen the dashboard → Requests to follow up.`,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) { console.error("request-form: notification email failed", e instanceof Error ? e.name : "error"); }
  }
  return json(req, 200, { ok: true });
});
