// BalVoice — staff accounts (admins only).
// Actions: invite (email, full_name, role), create (email, full_name, role, password), set_role (user_id, role), set_active (user_id, active).
// Deactivating a staff member also blocks their sign-in and ends their sessions.
//
// Secrets: SITE_URL (used for the invitation link)
// Deploy:  supabase functions deploy staff-admin        (JWT verification ON)

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { corsHeaders, env, json, readJson, serviceClient, str } from "../_shared/http.ts";

const ROLES = ["admin", "operator"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  // Who is asking? Use their own token so RLS and is_admin() apply to them.
  const auth = req.headers.get("authorization") ?? "";
  const asCaller = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await asCaller.auth.getUser();
  const caller = userData?.user;
  if (!caller) return json(req, 401, { error: "not_signed_in" });
  const { data: isAdmin } = await asCaller.rpc("is_admin");
  if (!isAdmin) return json(req, 403, { error: "admins_only" });

  const b = await readJson(req, 4_000);
  if (!b) return json(req, 400, { error: "invalid_body" });
  const db = serviceClient();
  const audit = (row_id: string, changes: Record<string, unknown>) =>
    db.from("audit_log").insert({ actor: caller.id, actor_kind: "staff", table_name: "staff", row_id, action: "UPDATE", changes: { via: "staff-admin", ...changes } });

  if (b.action === "invite") {
    const email = str(b.email, 161).toLowerCase(), fullName = str(b.full_name, 80), role = String(b.role ?? "operator");
    if (!EMAIL.test(email) || !ROLES.includes(role) || fullName.length < 2) return json(req, 422, { error: "validation_failed" });
    const { data, error } = await db.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      redirectTo: env("SITE_URL").replace(/\/$/, "") + "/auth-callback.html?next=reset-password.html",
    });
    if (error || !data.user) {
      const exists = /already|registered|exists/i.test(error?.message ?? "");
      return json(req, exists ? 409 : 500, { error: exists ? "already_has_account" : "invite_failed" });
    }
    const { error: staffError } = await db.from("staff").insert({ user_id: data.user.id, role, created_by: caller.id });
    if (staffError) return json(req, 500, { error: "could_not_add_staff" });
    await audit(data.user.id, { invited: email, role });
    return json(req, 200, { ok: true, user_id: data.user.id });
  }

  // Create the account directly with a temporary password (no email needed).
  if (b.action === "create") {
    const email = str(b.email, 161).toLowerCase(), fullName = str(b.full_name, 80), role = String(b.role ?? "operator");
    const password = String(b.password ?? "");
    const strong = password.length >= 10 && password.length <= 72 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
    if (!EMAIL.test(email) || !ROLES.includes(role) || fullName.length < 2) return json(req, 422, { error: "validation_failed" });
    if (!strong) return json(req, 422, { error: "weak_password" });
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
    if (error || !data.user) {
      const exists = /already|registered|exists/i.test(error?.message ?? "");
      return json(req, exists ? 409 : 500, { error: exists ? "already_has_account" : "create_failed" });
    }
    const { error: staffError } = await db.from("staff").insert({ user_id: data.user.id, role, created_by: caller.id });
    if (staffError) return json(req, 500, { error: "could_not_add_staff" });
    await audit(data.user.id, { created: email, role });
    return json(req, 200, { ok: true, user_id: data.user.id });
  }

  const userId = String(b.user_id ?? "");
  if (!UUID.test(userId)) return json(req, 422, { error: "validation_failed" });

  if (b.action === "set_role") {
    const role = String(b.role ?? "");
    if (!ROLES.includes(role)) return json(req, 422, { error: "validation_failed" });
    const { error } = await db.from("staff").update({ role }).eq("user_id", userId);
    if (error) return json(req, 409, { error: /admin/.test(error.message) ? "last_admin" : "update_failed" });
    await audit(userId, { role });
    return json(req, 200, { ok: true });
  }

  if (b.action === "set_active") {
    const active = b.active === true;
    if (!active && userId === caller.id) return json(req, 422, { error: "cannot_deactivate_self" });
    const { error } = await db.from("staff").update({ active }).eq("user_id", userId);
    if (error) return json(req, 409, { error: /admin/.test(error.message) ? "last_admin" : "update_failed" });
    // A ban blocks sign-in and refresh; "none" lifts it.
    const { error: banError } = await db.auth.admin.updateUserById(userId, { ban_duration: active ? "none" : "876000h" });
    if (banError) console.error("staff-admin: could not update sign-in ban", banError.message);
    await audit(userId, { active });
    return json(req, 200, { ok: true });
  }

  return json(req, 400, { error: "unknown_action" });
});
