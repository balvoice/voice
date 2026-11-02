// A small stand-in for the Supabase APIs the dashboard uses (REST, RPC, storage, staff-admin),
// backed by PGlite running the real migrations. Every request runs as the user in its
// bearer token, so Row Level Security applies exactly as in production.
import http from "node:http";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

export async function startFakeSupabase(root, port) {
  const db = new PGlite({ extensions: { pgcrypto } });
  const migrations = fs.readdirSync(root + "/supabase/migrations").filter(n => n.endsWith(".sql")).sort().map(n => "supabase/migrations/" + n);
  for (const f of ["supabase/tests/supabase-stub.sql", ...migrations])
    await db.exec(fs.readFileSync(root + "/" + f, "utf8"));
  const files = new Map();
  let chain = Promise.resolve();
  const serial = fn => { const p = chain.then(fn); chain = p.then(() => {}, () => {}); return p; };
  const ident = s => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Object.assign(new Error("bad identifier " + s), { status: 400 }); return s; };
  const pk = {};
  async function pkey(t) {
    if (!pk[t]) pk[t] = (await db.query(`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = 'public.${t}'::regclass and i.indisprimary`)).rows.map(r => r.attname);
    return pk[t];
  }
  const claimsOf = req => {
    const tok = (req.headers.authorization || "").replace(/^Bearer /, "");
    try { const c = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()); return c.sub ? c : null; } catch { return null; }
  };
  // Run a statement as the caller (authenticated or anon), or as the service role.
  function asUser(claims, fn) {
    return serial(async () => {
      const role = claims ? (claims.role === "service_role" ? "service_role" : "authenticated") : "anon";
      await db.exec("begin");
      try {
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims || { role: "anon" })]);
        await db.exec(`set local role ${role}`);
        const r = await fn();
        await db.exec("commit");
        return r;
      } catch (e) { await db.exec("rollback"); throw e; }
    });
  }

  function where(params, alias, values) {
    const out = [];
    const lit = (col, op, val) => {
      const c = col.includes(".") ? col.split(".").map(ident).join(".") : alias + "." + ident(col);
      if (op === "eq") { values.push(val); return `${c} = $${values.length}`; }
      if (op === "neq") { values.push(val); return `${c} <> $${values.length}`; }
      if (op === "gte") { values.push(val); return `${c} >= $${values.length}`; }
      if (op === "lte") { values.push(val); return `${c} <= $${values.length}`; }
      if (op === "is") return `${c} is ${val === "null" ? "null" : val === "true" ? "true" : "false"}`;
      if (op === "in") { values.push(val.replace(/^\(|\)$/g, "").split(",").map(v => v.replace(/^"|"$/g, ""))); return `${c}::text = any($${values.length})`; }
      if (op === "ilike") { values.push(val.replace(/\*/g, "%")); return `${c}::text ilike $${values.length}`; }
      throw Object.assign(new Error("unsupported operator " + op), { status: 400 });
    };
    for (const [k, v] of params) {
      if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
      if (k === "or") {
        const parts = v.replace(/^\(|\)$/g, "").split(",").map(p => { const m = p.match(/^([\w.]+)\.(\w+)\.(.*)$/); return lit(m[1], m[2], m[3]); });
        out.push("(" + parts.join(" or ") + ")"); continue;
      }
      const m = v.match(/^(\w+)\.(.*)$/);
      if (k.startsWith("call_results.")) { out.push(lit("cr." + k.split(".")[1], m[1], m[2])); continue; }
      out.push(lit(k, m[1], m[2]));
    }
    return out.length ? " where " + out.join(" and ") : "";
  }

  async function rest(req, url, body, claims) {
    const t = ident(url.pathname.split("/").pop());
    const p = url.searchParams, prefer = req.headers.prefer || "";
    if (url.pathname.includes("/rpc/")) {
      const keys = Object.keys(body || {}).map(ident);
      const vals = keys.map(k => (typeof body[k] === "object" && body[k] !== null) ? JSON.stringify(body[k]) : body[k]);
      const meta = (await db.query(`select p.proretset, t.typname from pg_proc p join pg_type t on t.oid = p.prorettype where p.proname = $1 and p.pronamespace = 'public'::regnamespace limit 1`, [t])).rows[0];
      const r = await asUser(claims, () => db.query(`select * from public.${t}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`, vals));
      if (meta && !meta.proretset && meta.typname !== "record") return { body: r.rows[0] ? r.rows[0][t] ?? null : null };
      return { body: r.rows };
    }
    if (req.method === "GET") {
      const sel = p.get("select") || "*", values = [];
      let cols = [], embed = null;
      const m = sel.match(/,?call_results(!inner)?\(([^)]*)\)/);
      const plain = m ? sel.replace(m[0], "") : sel;
      cols = plain.split(",").filter(Boolean).map(c => c === "*" ? "t.*" : "t." + ident(c.trim()));
      if (m) embed = { inner: !!m[1], cols: m[2].split(",").map(c => "cr." + ident(c.trim())) };
      let sql = `select ${cols.join(", ")}${embed ? `, (select to_jsonb(x) from (select ${embed.cols.join(", ")}) x) as call_results` : ""} from public.${t} t`;
      if (embed) sql += ` ${embed.inner ? "join" : "left join"} public.call_results cr on cr.recipient_id = t.id`;
      sql += where(p, "t", values);
      const countSql = `select count(*)::int n from (${sql}) q`;
      if (p.get("order")) sql += " order by " + p.get("order").split(",").map(o => { const [c, d] = o.split("."); return "t." + ident(c) + (d === "desc" ? " desc" : ""); }).join(", ");
      if (p.get("limit")) sql += " limit " + Number(p.get("limit"));
      if (p.get("offset")) sql += " offset " + Number(p.get("offset"));
      const r = await asUser(claims, async () => ({ rows: (await db.query(sql, values)).rows, n: /count=exact/.test(prefer) ? (await db.query(countSql, values)).rows[0].n : null }));
      const headers = r.n != null ? { "content-range": `0-${Math.max(0, r.rows.length - 1)}/${r.n}` } : {};
      if (/vnd\.pgrst\.object/.test(req.headers.accept || "")) {
        if (r.rows.length !== 1) return { status: 406, body: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } };
        return { body: r.rows[0], headers };
      }
      return { body: r.rows, headers };
    }
    if (req.method === "POST") {
      const rows = Array.isArray(body) ? body : [body];
      if (!rows.length) return { status: 201, body: [] };
      const cols = Object.keys(rows[0]).map(ident), values = [];
      const tuples = rows.map(r => "(" + cols.map(c => { const v = r[c]; values.push(v !== null && typeof v === "object" ? JSON.stringify(v) : v); return "$" + values.length; }).join(", ") + ")");
      let sql = `insert into public.${t} (${cols.join(", ")}) values ${tuples.join(", ")}`;
      const conflict = p.get("on_conflict") ? p.get("on_conflict").split(",").map(ident) : (/resolution=/.test(prefer) ? await pkey(t) : null);
      if (conflict && /ignore-duplicates/.test(prefer)) sql += ` on conflict (${conflict.join(", ")}) do nothing`;
      else if (conflict && /merge-duplicates/.test(prefer)) {
        const upd = cols.filter(c => !conflict.includes(c));
        sql += ` on conflict (${conflict.join(", ")}) do ` + (upd.length ? "update set " + upd.map(c => `${c} = excluded.${c}`).join(", ") : "nothing");
      }
      sql += " returning *";
      const r = await asUser(claims, () => db.query(sql, values));
      if (/return=representation/.test(prefer)) {
        if (/vnd\.pgrst\.object/.test(req.headers.accept || "")) return { status: 201, body: r.rows[0] };
        return { status: 201, body: r.rows };
      }
      return { status: 201, body: null };
    }
    if (req.method === "PATCH") {
      const cols = Object.keys(body).map(ident), values = cols.map(c => body[c]);
      let sql = `update public.${t} t set ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")}` + where(p, "t", values) + " returning t.*";
      const r = await asUser(claims, () => db.query(sql, values));
      if (/return=representation/.test(prefer)) return { body: /vnd\.pgrst\.object/.test(req.headers.accept || "") ? r.rows[0] : r.rows };
      return { status: 204, body: null };
    }
    if (req.method === "DELETE") {
      const values = [];
      await asUser(claims, () => db.query(`delete from public.${t} t` + where(p, "t", values), values));
      return { status: 204, body: null };
    }
  }

  async function staffAdmin(body, claims) {
    const isAdmin = (await asUser(claims, () => db.query("select public.is_admin() a"))).rows[0].a;
    if (!isAdmin) return { status: 403, body: { error: "admins_only" } };
    return serial(async () => {
      if (body.action === "invite" || body.action === "create") {
        const u = (await db.query("insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id", [body.email, JSON.stringify({ full_name: body.full_name })])).rows[0];
        await db.query("insert into public.staff (user_id, role, created_by) values ($1, $2, $3)", [u.id, body.role, claims.sub]);
        return { body: { ok: true, user_id: u.id } };
      }
      try {
        if (body.action === "set_role") await db.query("update public.staff set role = $1 where user_id = $2", [body.role, body.user_id]);
        if (body.action === "set_active") await db.query("update public.staff set active = $1 where user_id = $2", [body.active, body.user_id]);
      } catch (e) { return { status: 409, body: { error: /admin/.test(e.message) ? "last_admin" : "update_failed" } }; }
      return { body: { ok: true } };
    });
  }

  const server = http.createServer(async (req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "content-range" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    const url = new URL(req.url, "http://x");
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const claims = claimsOf(req);
    const send = (status, body, headers = {}) => { res.writeHead(status, Object.assign({ "content-type": "application/json" }, cors, headers)); res.end(body == null ? "" : JSON.stringify(body)); };
    try {
      if (url.pathname.startsWith("/rest/v1/")) {
        const body = raw.length ? JSON.parse(raw.toString()) : null;
        const r = await rest(req, url, body, claims);
        return send(r.status || 200, r.body, r.headers);
      }
      if (url.pathname.startsWith("/storage/v1/object/sign/")) {
        const key = url.pathname.replace("/storage/v1/object/sign/", "");
        return send(200, { signedURL: "/storage/v1/object/public-test/" + key + "?token=t" });
      }
      if (url.pathname.startsWith("/storage/v1/object/public-test/")) {
        const f = files.get(url.pathname.replace("/storage/v1/object/public-test/", ""));
        res.writeHead(f ? 200 : 404, Object.assign({ "content-type": "audio/wav" }, cors)); return res.end(f || "");
      }
      if (url.pathname.startsWith("/storage/v1/object/") && req.method === "POST") {
        const key = url.pathname.replace("/storage/v1/object/", ""), [bucket, ...rest2] = key.split("/");
        await asUser(claims, () => db.query("insert into storage.objects (bucket_id, name) values ($1, $2)", [bucket, rest2.join("/")]));
        files.set(key, raw);
        return send(200, { Key: key, Id: key });
      }
      if (url.pathname === "/functions/v1/staff-admin") {
        const r = await staffAdmin(JSON.parse(raw.toString() || "{}"), claims);
        return send(r.status || 200, r.body);
      }
      if (url.pathname.startsWith("/auth/v1/")) return send(200, {});
      send(404, { message: "not supported by the fake" });
    } catch (e) {
      send(e.status || (/row-level security|permission denied/.test(e.message) ? 403 : 400), { message: e.message, code: e.code || "P0001" });
    }
  });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  return { db, server, files, asService: fn => asUser({ role: "service_role", sub: "" }, fn) };
}
