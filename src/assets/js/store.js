/* BalVoice — Supabase data layer for the dashboard.
 *
 * Loads one client's data into the same shape the dashboard uses in demo mode,
 * and writes changes back by comparing against what was last loaded or saved.
 * All writes go through Row Level Security as the signed-in staff member; the
 * database repeats every rule (see supabase/migrations). Writes run one at a
 * time, in order, so an action never overtakes the save it depends on.
 */
(function () {
  "use strict";
  const PAGE = 1000;
  const OUTCOME_FILTERS = ["answered", "busy", "noanswer", "unreachable"];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let sb = null, ws = null, snap = null, queue = Promise.resolve();

  function check(res) { if (res.error) throw res.error; return res.data; }
  async function all(build) {
    let out = [], from = 0;
    for (;;) {
      const rows = check(await build().range(from, from + PAGE - 1));
      out = out.concat(rows);
      if (rows.length < PAGE) return out;
      from += PAGE;
    }
  }
  const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const pad = n => String(n).padStart(2, "0");
  const localDate = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const localTime = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Accra"; } catch (e) { return "Africa/Accra"; } };

  /* Run work after every earlier write has finished. */
  function run(fn) {
    const p = queue.then(fn);
    queue = p.then(() => {}, () => {});
    return p;
  }

  /* Mapping: database rows <-> dashboard objects -------------------------- */
  const groupRow = g => ({ id: g.id, workspace_id: ws, name: g.name, description: g.description || null });
  const contactRow = c => ({ client_id: c.id, phone: c.p, first_name: c.fn || "", last_name: c.ln || "", email: c.email || "", company: c.company || "" });
  const callerRow = c => ({ id: c.id, workspace_id: ws, type: c.type, value: c.value, purpose: c.purpose || null, status: c.status });
  const templateRow = t => ({ id: t.id, workspace_id: ws, name: t.name, category: t.category || null, body: t.text });
  const settingsRow = s => ({ workspace_id: ws, airtime_rate: s.rate === "" || s.rate == null ? null : Number(s.rate), currency: s.currency || "GHS",
                              billing_increment: s.billing === "minute" ? "minute" : "second", bill_answered_only: s.answeredOnly !== false });
  function campaignRow(c) {
    const tts = c.message && c.message.type === "tts", s = c.schedule || {};
    return {
      id: c.id, workspace_id: ws, name: c.name, type: c.type, sender_name: c.sender, description: c.description || null,
      caller_id: c.callerId || null, message_type: tts ? "tts" : "audio",
      audio_file_id: !tts && c.audio && c.audio.id ? c.audio.id : null,
      tts_text: tts ? c.message.text : null, tts_language: tts ? c.message.lang : null, tts_voice: tts ? c.message.voice : null,
      status: c.status, schedule_start: s.start || null,
      window_start: s.windowStart || "09:00", window_end: s.windowEnd || "19:00", timezone: c.timezone || tz(),
      retries: Number(s.retries || 0), retry_interval_min: Number(s.interval || 30),
      repeat_rule: s.repeat || "none", repeat_until: s.repeat && s.repeat !== "none" ? (s.repeatUntil || null) : null,
      consent_confirmed: !!(c.compliance && c.compliance.consent), sender_identified: !!(c.compliance && c.compliance.senderIdentified),
      optout_included: !!(c.compliance && c.compliance.optoutIncluded), consent_basis: c.consentBasis || null
    };
  }
  function toCampaign(r, groupIds, audio, events, runs, costs) {
    const start = r.schedule_start ? new Date(r.schedule_start) : null;
    const runMap = {};
    runs.forEach(x => { runMap[x.run_number] = Object.assign({}, x, costs[x.run_number] || {}); });
    return {
      id: r.id, name: r.name, type: r.type, sender: r.sender_name, callerId: r.caller_id || "", description: r.description || "",
      createdAt: r.created_at, status: r.status, consentBasis: r.consent_basis || "", timezone: r.timezone, runNumber: r.run_number,
      message: r.message_type === "tts" ? { type: "tts", text: r.tts_text || "", lang: r.tts_language || "en", voice: r.tts_voice || "female" } : { type: "audio" },
      audio: audio || null,
      recipients: { mode: "groups", groupIds },
      list: null, contacts: [], results: {},
      schedule: {
        date: start ? localDate(start) : "", time: start ? localTime(start) : "", start: r.schedule_start,
        windowStart: String(r.window_start).slice(0, 5), windowEnd: String(r.window_end).slice(0, 5),
        retries: String(r.retries), interval: String(r.retry_interval_min), repeat: r.repeat_rule, repeatUntil: r.repeat_until || ""
      },
      compliance: { consent: r.consent_confirmed, senderIdentified: r.sender_identified, optoutIncluded: r.optout_included,
                    confirmedAt: r.compliance_confirmed_at, confirmedBy: r.compliance_confirmed_by },
      events: events.map(e => ({ t: e.created_at, msg: e.message })),
      history: Object.values(runMap).filter(x => x.run_number !== r.run_number).sort((a, b) => a.run_number - b.run_number)
        .map(x => ({ at: x.last_call_at, total: Number(x.recipients), answered: Number(x.answered), run: x.run_number })),
      testCalls: [],
      live: { runs: runMap, current: runMap[r.run_number] || null }
    };
  }

  /* Snapshot of what the server holds, for working out changes. */
  function snapshot(state) {
    const m = (list, key, val) => new Map(list.map(x => [key(x), JSON.stringify(val(x))]));
    const members = new Set(), cgroups = new Set();
    state.contacts.forEach(c => c.groups.forEach(g => members.add(c.id + "|" + g)));
    state.campaigns.forEach(c => ((c.recipients && c.recipients.groupIds) || []).forEach(g => cgroups.add(c.id + "|" + g)));
    return {
      groups: m(state.groups, x => x.id, groupRow),
      contacts: m(state.contacts, x => x.id, contactRow),
      callerIds: m(state.callerIds, x => x.id, callerRow),
      templates: m(state.templates, x => x.id, templateRow),
      optouts: m(state.optouts, x => (x.scope || "client") + "|" + x.p, x => x.s),
      campaigns: m(state.campaigns, x => x.id, campaignRow),
      campaignStatus: new Map(state.campaigns.map(c => [c.id, c.status])),
      members, cgroups,
      settings: JSON.stringify(settingsRow(state.settings))
    };
  }
  function diff(before, list, key, val) {
    const now = new Map(list.map(x => [key(x), x]));
    const changed = [], removed = [];
    now.forEach((x, k) => { if (before.get(k) !== JSON.stringify(val(x))) changed.push(x); });
    before.forEach((_, k) => { if (!now.has(k)) removed.push(k); });
    return { changed, removed, isNew: x => !before.has(key(x)) };
  }

  const Store = {
    init(client, user, role) { sb = client; this.user = user; this.role = role; },
    get clientId() { return ws; },
    run,

    /* Clients -------------------------------------------------------------- */
    async listClients() {
      return check(await sb.from("workspaces").select("id, name, contact_name, contact_phone, contact_email, notes, archived_at, created_at").order("name"));
    },
    async saveClient(c) {
      const row = { name: c.name, contact_name: c.contact_name || null, contact_phone: c.contact_phone || null,
                    contact_email: c.contact_email || null, notes: c.notes || null, archived_at: c.archived_at || null };
      if (c.id) return check(await sb.from("workspaces").update(row).eq("id", c.id).select().single());
      return check(await sb.from("workspaces").insert(row).select().single());
    },

    /* Load everything the dashboard shows for one client. */
    async load(clientId) {
      ws = clientId;
      const eq = q => q.eq("workspace_id", ws);
      const [groups, contacts, members, callers, templates, opt, gopt, settings, campaigns, cgroups, audio, events, runs, costs] = await Promise.all([
        all(() => eq(sb.from("contact_groups").select("id, name, description, created_at")).order("name")),
        all(() => eq(sb.from("contacts").select("id, phone, first_name, last_name, email, company, created_at")).order("created_at")),
        all(() => eq(sb.from("contact_group_members").select("group_id, contact_id")).order("group_id")),
        all(() => eq(sb.from("caller_ids").select("id, type, value, purpose, status, created_at, reviewed_at")).order("created_at")),
        all(() => eq(sb.from("message_templates").select("id, name, category, body, updated_at")).order("name")),
        all(() => eq(sb.from("opt_outs").select("phone, source, created_at")).order("created_at")),
        all(() => sb.from("global_opt_outs").select("phone, source, created_at").order("created_at")),
        eq(sb.from("workspace_settings").select("*")).maybeSingle().then(check),
        all(() => eq(sb.from("campaigns").select("*")).order("created_at")),
        all(() => eq(sb.from("campaign_groups").select("campaign_id, group_id")).order("campaign_id")),
        all(() => eq(sb.from("audio_files").select("id, file_name, mime_type, size_bytes, duration_sec, created_at")).order("created_at")),
        eq(sb.from("campaign_events").select("campaign_id, message, created_at")).order("created_at", { ascending: false }).limit(2000).then(check),
        all(() => eq(sb.from("campaign_run_stats").select("*")).order("campaign_id")),
        all(() => eq(sb.from("campaign_costs").select("campaign_id, run_number, billable_minutes, answered_calls")).order("campaign_id"))
      ]);
      const byContact = new Map(contacts.map(c => [c.id, { id: c.id, p: c.phone, fn: c.first_name || "", ln: c.last_name || "", email: c.email || "", company: c.company || "", groups: [], createdAt: c.created_at }]));
      members.forEach(m => { const c = byContact.get(m.contact_id); if (c) c.groups.push(m.group_id); });
      const audioById = new Map(audio.map(a => [a.id, { id: a.id, name: a.file_name, size: a.size_bytes, duration: Number(a.duration_sec || 0), type: a.mime_type, createdAt: a.created_at }]));
      const cg = id => cgroups.filter(x => x.campaign_id === id).map(x => x.group_id);
      const ev = id => events.filter(x => x.campaign_id === id);
      const rs = id => runs.filter(x => x.campaign_id === id);
      const cs = id => { const o = {}; costs.filter(x => x.campaign_id === id).forEach(x => { o[x.run_number] = { billable_minutes: Number(x.billable_minutes) }; }); return o; };
      const state = {
        groups: groups.map(g => ({ id: g.id, name: g.name, description: g.description || "", createdAt: g.created_at })),
        contacts: Array.from(byContact.values()),
        callerIds: callers.map(c => ({ id: c.id, type: c.type, value: c.value, purpose: c.purpose || "", status: c.status, createdAt: c.created_at, reviewedAt: c.reviewed_at })),
        templates: templates.map(t => ({ id: t.id, name: t.name, category: t.category || "", text: t.body, updatedAt: t.updated_at })),
        optouts: opt.map(o => ({ p: o.phone, s: o.source, t: o.created_at, scope: "client" }))
          .concat(gopt.map(o => ({ p: o.phone, s: o.source, t: o.created_at, scope: "all" }))),
        settings: settings ? { rate: settings.airtime_rate == null ? "" : String(Number(settings.airtime_rate)), currency: settings.currency,
                               billing: settings.billing_increment, answeredOnly: settings.bill_answered_only }
                           : { rate: "", currency: "GHS", billing: "second", answeredOnly: true },
        campaigns: campaigns.map(r => toCampaign(r, cg(r.id), r.audio_file_id ? audioById.get(r.audio_file_id) : null, ev(r.id), rs(r.id), cs(r.id))),
        audioFiles: Array.from(audioById.values())
      };
      snap = snapshot(state);
      return state;
    },

    /* Write every change since the last load or save. */
    sync(state) {
      return run(async () => {
        if (!snap) return;
        const s0 = snap;
        // Groups first: contacts and campaigns refer to them.
        const g = diff(s0.groups, state.groups, x => x.id, groupRow);
        if (g.changed.length) check(await sb.from("contact_groups").upsert(g.changed.map(groupRow)));

        // Contacts are upserted by phone on the server, which returns the stored id.
        const c = diff(s0.contacts, state.contacts, x => x.id, contactRow);
        for (const part of chunks(c.changed, 1000)) {
          const rows = check(await sb.rpc("upsert_contacts", { p_workspace: ws, p_rows: part.map(contactRow) }));
          const idMap = new Map(rows.map(r => [r.client_id, r.id]));
          part.forEach(x => { const id = idMap.get(x.id); if (id && id !== x.id) x.id = id; });
        }
        // Merge any contacts that now share a server id (same number added twice).
        const seen = new Map();
        state.contacts = state.contacts.filter(x => {
          const prev = seen.get(x.id);
          if (prev) { x.groups.forEach(gid => { if (prev.groups.indexOf(gid) === -1) prev.groups.push(gid); }); return false; }
          seen.set(x.id, x); return true;
        });
        const removedContacts = c.removed.filter(id => !seen.has(id));
        for (const part of chunks(removedContacts, 200)) check(await sb.from("contacts").delete().eq("workspace_id", ws).in("id", part));

        // Group membership.
        const members = new Set();
        state.contacts.forEach(x => x.groups.forEach(gid => members.add(x.id + "|" + gid)));
        const addM = [], delM = new Map();
        members.forEach(k => { if (!s0.members.has(k)) { const [cid, gid] = k.split("|"); addM.push({ workspace_id: ws, group_id: gid, contact_id: cid }); } });
        s0.members.forEach(k => {
          const [cid, gid] = k.split("|");
          if (!members.has(k) && seen.has(cid) && !g.removed.includes(gid)) { if (!delM.has(gid)) delM.set(gid, []); delM.get(gid).push(cid); }
        });
        for (const part of chunks(addM, 1000)) check(await sb.from("contact_group_members").upsert(part, { onConflict: "group_id,contact_id", ignoreDuplicates: true }));
        for (const [gid, cids] of delM) for (const part of chunks(cids, 200)) check(await sb.from("contact_group_members").delete().eq("group_id", gid).in("contact_id", part));

        // Caller IDs, templates, opt-outs, settings.
        const ci = diff(s0.callerIds, state.callerIds, x => x.id, callerRow);
        for (const x of ci.changed) {
          if (ci.isNew(x)) check(await sb.from("caller_ids").insert(callerRow(x)));
          else check(await sb.from("caller_ids").update({ status: x.status, purpose: x.purpose || null }).eq("id", x.id));
        }
        if (ci.removed.length) check(await sb.from("caller_ids").delete().in("id", ci.removed));
        const t = diff(s0.templates, state.templates, x => x.id, templateRow);
        if (t.changed.length) check(await sb.from("message_templates").upsert(t.changed.map(templateRow)));
        if (t.removed.length) check(await sb.from("message_templates").delete().in("id", t.removed));
        const o = diff(s0.optouts, state.optouts, x => (x.scope || "client") + "|" + x.p, x => x.s);
        for (const x of o.changed) {
          if (x.scope === "all") check(await sb.from("global_opt_outs").upsert({ phone: x.p, source: x.s }, { onConflict: "phone", ignoreDuplicates: true }));
          else check(await sb.from("opt_outs").upsert({ workspace_id: ws, phone: x.p, source: x.s }, { onConflict: "workspace_id,phone", ignoreDuplicates: true }));
        }
        for (const k of o.removed) {
          const [scope, phone] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
          if (scope === "all") check(await sb.from("global_opt_outs").delete().eq("phone", phone));
          else check(await sb.from("opt_outs").delete().eq("workspace_id", ws).eq("phone", phone));
        }
        if (JSON.stringify(settingsRow(state.settings)) !== s0.settings) check(await sb.from("workspace_settings").upsert(settingsRow(state.settings)));

        // Campaigns. Delivery-owned statuses are never sent back unchanged.
        const cp = diff(s0.campaigns, state.campaigns, x => x.id, campaignRow);
        for (const x of cp.changed) {
          const row = campaignRow(x);
          if (cp.isNew(x)) check(await sb.from("campaigns").insert(row));
          else {
            const was = s0.campaignStatus.get(x.id);
            if (was === row.status) delete row.status;
            delete row.id; delete row.workspace_id;
            check(await sb.from("campaigns").update(row).eq("id", x.id));
          }
        }
        if (cp.removed.length) check(await sb.from("campaigns").delete().in("id", cp.removed));
        const cg = new Set();
        state.campaigns.forEach(x => ((x.recipients && x.recipients.groupIds) || []).forEach(gid => cg.add(x.id + "|" + gid)));
        const addCG = [];
        cg.forEach(k => { if (!s0.cgroups.has(k)) { const [cid, gid] = k.split("|"); addCG.push({ workspace_id: ws, campaign_id: cid, group_id: gid }); } });
        if (addCG.length) check(await sb.from("campaign_groups").upsert(addCG, { onConflict: "campaign_id,group_id", ignoreDuplicates: true }));
        for (const k of s0.cgroups) {
          const [cid, gid] = k.split("|");
          if (!cg.has(k) && !cp.removed.includes(cid) && !g.removed.includes(gid)) check(await sb.from("campaign_groups").delete().eq("campaign_id", cid).eq("group_id", gid));
        }
        // Activity entries written in the dashboard.
        const newEvents = [];
        state.campaigns.forEach(x => (x.events || []).forEach(e => { if (e.pending) { newEvents.push({ workspace_id: ws, campaign_id: x.id, message: String(e.msg).slice(0, 300), created_by: this.user.id }); delete e.pending; } }));
        if (newEvents.length) check(await sb.from("campaign_events").insert(newEvents));

        // Groups are deleted last, after anything that referred to them.
        if (g.removed.length) check(await sb.from("contact_groups").delete().in("id", g.removed));
        snap = snapshot(state);
      });
    },

    /* Campaign delivery --------------------------------------------------- */
    startNow(id) { return run(async () => check(await sb.rpc("campaign_start_now", { p_campaign: id }))); },
    resume(id) { return run(async () => check(await sb.rpc("campaign_resume", { p_campaign: id }))); },

    /* Reload one campaign's status, activity and results from the server. */
    async refresh(c) {
      return run(async () => {
        const [row, events, runs, costs] = await Promise.all([
          sb.from("campaigns").select("*").eq("id", c.id).maybeSingle().then(check),
          sb.from("campaign_events").select("message, created_at").eq("campaign_id", c.id).order("created_at", { ascending: false }).limit(50).then(check),
          sb.from("campaign_run_stats").select("*").eq("campaign_id", c.id).then(check),
          sb.from("campaign_costs").select("run_number, billable_minutes, answered_calls").eq("campaign_id", c.id).then(check)
        ]);
        if (!row) return null;
        const cs = {}; costs.forEach(x => { cs[x.run_number] = { billable_minutes: Number(x.billable_minutes) }; });
        const fresh = toCampaign(row, c.recipients.groupIds, c.audio, events, runs, cs);
        Object.assign(c, fresh);
        if (snap) { snap.campaigns.set(c.id, JSON.stringify(campaignRow(c))); snap.campaignStatus.set(c.id, c.status); }
        return c;
      });
    },

    /* One page of per-number results, filtered on the server. */
    async results(c, opts) {
      const runNo = opts.run || c.runNumber;
      let q = sb.from("campaign_recipients")
        .select("id, phone, first_name, last_name, status, skip_reason, provider_call_id, call_results" + (opts.outcome && OUTCOME_FILTERS.indexOf(opts.outcome) > -1 ? "!inner" : "") +
                "(outcome, attempts, duration_sec, last_attempt_at)", { count: "exact" })
        .eq("campaign_id", c.id).eq("run_number", runNo);
      if (opts.outcome === "pending") q = q.in("status", ["queued", "dialing"]);
      else if (opts.outcome === "skipped") q = q.eq("status", "skipped");
      else if (opts.outcome) q = q.eq("status", "done").eq("call_results.outcome", opts.outcome);
      const term = String(opts.q || "").replace(/[^\p{L}\p{N} +@.'-]/gu, "").trim();
      if (term) q = q.or(["phone", "first_name", "last_name"].map(f => f + ".ilike.*" + term + "*").join(","));
      q = q.order("id");
      const res = opts.all ? { data: await all(() => q), count: null } : await q.range(opts.offset || 0, (opts.offset || 0) + (opts.limit || 25) - 1);
      if (res.error) throw res.error;
      return {
        count: res.count,
        rows: res.data.map(r => {
          const cr = Array.isArray(r.call_results) ? r.call_results[0] : r.call_results;
          return { p: r.phone, fn: r.first_name || "", ln: r.last_name || "", status: r.status, skip: r.skip_reason,
                   simulated: /^sim-/.test(r.provider_call_id || ""), o: cr && r.status === "done" ? cr.outcome : null,
                   a: cr ? cr.attempts : 0, d: cr ? cr.duration_sec : null, t: cr ? cr.last_attempt_at : null };
        })
      };
    },

    /* Audio: private bucket, one folder per client. */
    async uploadAudio(file, duration) {
      const ext = /\.wav$/i.test(file.name) ? "wav" : "mp3";
      const id = crypto.randomUUID(), path = ws + "/" + id + "." + ext;
      const type = ext === "wav" ? "audio/wav" : "audio/mpeg";
      check(await sb.storage.from("campaign-audio").upload(path, file, { contentType: type, upsert: false }));
      const row = check(await sb.from("audio_files").insert({ id, workspace_id: ws, storage_path: path, file_name: file.name.slice(0, 120),
        mime_type: type, size_bytes: file.size, duration_sec: Math.round(duration * 10) / 10 }).select().single());
      return { id: row.id, name: row.file_name, size: row.size_bytes, duration: Number(row.duration_sec), type: row.mime_type, createdAt: row.created_at };
    },
    async audioUrl(audioId) {
      const row = check(await sb.from("audio_files").select("storage_path").eq("id", audioId).single());
      return check(await sb.storage.from("campaign-audio").createSignedUrl(row.storage_path, 600)).signedUrl;
    },

    /* Staff, requests, costs, audit ------------------------------------------ */
    async staff() {
      const [staff, profiles] = await Promise.all([
        sb.from("staff").select("user_id, role, active, created_at").order("created_at").then(check),
        sb.from("profiles").select("id, full_name, email").then(check)
      ]);
      const p = new Map(profiles.map(x => [x.id, x]));
      return staff.map(s => Object.assign({}, s, { name: (p.get(s.user_id) || {}).full_name || "", email: (p.get(s.user_id) || {}).email || "" }));
    },
    async staffAction(body) {
      const { data, error } = await sb.functions.invoke("staff-admin", { body });
      if (error) {
        let code = "failed";
        try { code = (await error.context.json()).error || code; } catch (e) { /* no body */ }
        throw Object.assign(new Error(code), { code });
      }
      return data;
    },
    async assignments() { return check(await sb.from("client_assignments").select("workspace_id, user_id")); },
    async setAssignments(userId, clientIds) {
      const now = check(await sb.from("client_assignments").select("workspace_id").eq("user_id", userId)).map(r => r.workspace_id);
      const add = clientIds.filter(id => now.indexOf(id) === -1), drop = now.filter(id => clientIds.indexOf(id) === -1);
      if (add.length) check(await sb.from("client_assignments").insert(add.map(id => ({ workspace_id: id, user_id: userId }))));
      if (drop.length) check(await sb.from("client_assignments").delete().eq("user_id", userId).in("workspace_id", drop));
    },
    async requests() { return check(await sb.from("campaign_requests").select("*").order("created_at", { ascending: false }).limit(500)); },
    async updateRequest(id, patch) { return check(await sb.from("campaign_requests").update(patch).eq("id", id)); },
    async monthlyCosts() { return all(() => sb.from("client_monthly_costs").select("*").eq("workspace_id", ws).order("month", { ascending: false })); },
    async audit(limit) {
      return check(await sb.from("audit_log").select("*").or("workspace_id.eq." + ws + ",workspace_id.is.null").order("at", { ascending: false }).limit(limit || 200));
    },
    isUuid: v => UUID.test(String(v || ""))
  };
  window.BalVoiceStore = Store;
})();
