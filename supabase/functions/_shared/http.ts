// Shared helpers for BalVoice Edge Functions.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.3";

export const env = (k: string, d = "") => Deno.env.get(k) ?? d;

// Website origins allowed to call the public endpoints (comma separated).
const ORIGINS = env("SITE_ORIGINS", env("SITE_URL")).split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : (ORIGINS[0] ?? "null"),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

/** Browsers always send Origin on cross-site POSTs; reject ones that aren't ours. */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  return !origin || ORIGINS.length === 0 || ORIGINS.includes(origin);
}

export function json(req: Request | null, status: number, body: unknown): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (req) Object.assign(headers, corsHeaders(req));
  return new Response(JSON.stringify(body), { status, headers });
}

/** Reads a JSON object body, refusing anything over maxBytes. */
export async function readJson(req: Request, maxBytes = 16_384): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function serviceClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Caller's IP, salted and hashed. Raw IP addresses are never stored. */
export async function ipKey(req: Request): Promise<string> {
  const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  return sha256(env("RATE_LIMIT_SALT", "balvoice") + "|" + ip);
}

/** Same rules as public.normalize_phone() in the database and normPhone() in the dashboard. */
export function normalizePhone(raw: unknown): string | null {
  let s = String(raw ?? "").trim().replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) {
    if (/^0\d{9}$/.test(s)) s = "+233" + s.slice(1);
    else if (/^233\d{9}$/.test(s)) s = "+" + s;
    else if (/^\d{9}$/.test(s)) s = "+233" + s;
  }
  return /^\+\d{9,15}$/.test(s) ? s : null;
}

export const str = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);
