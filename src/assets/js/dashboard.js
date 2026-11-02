/* BalVoice — campaign dashboard (internal, staff only).
 *
 * Two modes:
 *  - Connected (Supabase configured and a staff member signed in): data for the
 *    selected client is loaded through store.js and every change is written back;
 *    calls are placed by the dialer and results are read from the database.
 *  - Demo (no Supabase settings): data stays in this browser and delivery is
 *    simulated so the screens can be reviewed.
 * The database repeats every rule enforced here. See docs/DASHBOARD-GUIDE.md.
 *
 * Sections: constants · state · helpers · router · campaigns · wizard ·
 * campaign detail · simulation · reports · groups · contacts · templates ·
 * caller IDs · audio · opt-outs · settings · shell
 */
(function () {
  "use strict";

  /* Constants ------------------------------------------------------------- */
  const KEY = "balvoice.demo.v1";
  const LIMITS = {
    csvBytes: 5 * 1024 * 1024,
    audioBytes: 10 * 1024 * 1024,
    contacts: 20000,
    audioSeconds: 180,
    ttsChars: 1000,
    groupName: 60
  };
  const AUDIO_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"];
  const AUDIO_EXT = /\.(mp3|wav)$/i;
  const CSV_EXT = /\.(csv|txt)$/i;
  const XLSX_EXT = /\.xlsx$/i;
  const LIST_ACCEPT = ".csv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const OUTCOMES = {
    answered: { label: "Answered", tag: "tag-answered", color: "#14804A" },
    busy: { label: "Busy", tag: "tag-busy", color: "#D18A1F" },
    noanswer: { label: "No answer", tag: "tag-noanswer", color: "#9AA6B6" },
    unreachable: { label: "Unreachable", tag: "tag-failed", color: "#B42318" }
  };
  const STATUS = { draft: "Draft", scheduled: "Scheduled", running: "Delivering", paused: "Paused", completed: "Completed", cancelled: "Cancelled" };
  const TYPES = { church: "Church / evangelism", political: "Political / civic", organization: "Organization", other: "Other" };
  const LANGS = { en: "English", tw: "Twi", ha: "Hausa", ee: "Ewe" };
  const VOICES = { female: "Female voice", male: "Male voice" };
  const REPEAT = { none: "Does not repeat", daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
  const FIELDS = [
    ["first_name", "First name"], ["last_name", "Last name"], ["full_name", "Full name"], ["company", "Company"]
  ];
  // Starter scripts shipped with the product. Read-only; users can copy them.
  const STARTER_TEMPLATES = [
    { id: "starter-service", name: "Service reminder", category: "Church", starter: true,
      text: "Hello {first_name|friend}. This is a message from {company|our church}. We warmly invite you to join us this Sunday at 9 AM for our special service. We look forward to worshipping with you. To stop receiving these calls, contact our church office." },
    { id: "starter-event", name: "Event invitation", category: "General", starter: true,
      text: "Hello {first_name|there}. You are invited to our upcoming event on Saturday at 10 AM. Please plan to arrive early. Thank you, and we hope to see you there. To stop receiving these calls, reply to the number on your screen." },
    { id: "starter-meeting", name: "Meeting reminder", category: "Organization", starter: true,
      text: "Good day {first_name|member}. This is a reminder that our general meeting takes place tomorrow at 4 PM. Your attendance is important. To stop receiving these calls, contact the secretariat." },
    { id: "starter-civic", name: "Town hall notice", category: "Civic", starter: true,
      text: "Hello {first_name|resident}. You are invited to a community town hall this Thursday at 5 PM to discuss local development projects. All residents are welcome. This message is from {company|the organizing committee}. To stop receiving these calls, contact our office." }
  ];

  /* State ----------------------------------------------------------------- */
  function defaults() {
    return {
      campaigns: [], optouts: [], groups: [], contacts: [], callerIds: [], templates: [],
      settings: { rate: "", currency: "GHS", billing: "second", answeredOnly: true, webhook: "", apiKey: "", lowBalance: "" }
    };
  }
  function load() {
    const base = defaults();
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && typeof s === "object") {
        Object.keys(base).forEach(k => { if (k !== "settings" && Array.isArray(s[k])) base[k] = s[k]; });
        base.settings = Object.assign(base.settings, s.settings || {});
        // A simulation cannot survive a page reload: interrupted runs become paused.
        base.campaigns.forEach(c => { if (c.status === "running") c.status = "paused"; });
      }
    } catch (e) { /* storage unavailable or corrupt — start fresh */ }
    return base;
  }
  let state = load();
  const Store = window.BalVoiceStore;
  let LIVE = false;          // connected to Supabase
  let ROLE = "admin";        // staff role; demo mode shows everything
  let clients = [], currentClient = null;
  const isAdmin = () => ROLE === "admin";
  let draft = null, step = 0, maxStep = 0;
  let filter = { outcome: "", q: "" };
  let contactQuery = { q: "", group: "" };
  let selected = new Set();
  let listLimit = 50;
  const timers = {};
  const view = document.getElementById("view");

  function save() {
    if (LIVE) { Store.sync(state).catch(syncFailed); return true; }
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch (e) { toast("Could not save. Browser storage is unavailable or full."); return false; }
  }

  /* Helpers --------------------------------------------------------------- */
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const nowISO = () => new Date().toISOString();
  const num = n => new Intl.NumberFormat().format(n);
  const pct = (a, b) => b ? Math.round((a / b) * 1000) / 10 : 0;
  const key = p => String(p).replace(/\D/g, "");
  const fmtBytes = b => b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + " KB" : (b / 1024 / 1024).toFixed(1) + " MB";
  const fmtDur = s => { s = Math.round(s || 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  function fmtDate(iso, withTime) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString(undefined, withTime === false
      ? { day: "numeric", month: "short", year: "numeric" }
      : { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function money(v) {
    const cur = state.settings.currency || "GHS";
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(v); }
    catch (e) { return cur + " " + v.toFixed(2); }
  }
  /* Same rules as public.normalize_phone() in the database: Ghana numbers become +233…,
   * including 9-digit numbers whose leading 0 was dropped by Excel. */
  function normPhone(raw) {
    let s = String(raw || "").trim().replace(/[\s\-().]/g, "");
    if (s.startsWith("00")) s = "+" + s.slice(2);
    if (!s.startsWith("+")) {
      if (/^0\d{9}$/.test(s)) s = "+233" + s.slice(1);
      else if (/^233\d{9}$/.test(s)) s = "+" + s;
      else if (/^\d{9}$/.test(s)) s = "+233" + s;
    }
    return /^\+?\d{9,15}$/.test(s) ? s : null;
  }
  // A 9-digit number without a leading 0 usually means Excel removed it.
  const rawTruncated = raw => /^\d{9}$/.test(String(raw || "").trim().replace(/[\s\-().]/g, ""));
  function friendlyError(e) {
    const m = String((e && (e.message || e.code)) || "");
    if (/row-level security|permission denied|42501|not allowed|admins_only/i.test(m)) return "You don't have permission for that.";
    if (/caller ID is not approved/i.test(m)) return "The caller ID is not approved yet.";
    if (/must be in the future/i.test(m)) return "The start time must be in the future.";
    if (/duplicate key|unique|already/i.test(m)) return "That name or number already exists.";
    if (/consent_basis/i.test(m)) return "Describe how recipients agreed to be called.";
    if (/Failed to fetch|NetworkError|network/i.test(m)) return "The connection failed. Check your internet connection.";
    return "The server did not accept the change.";
  }
  function syncFailed(err) {
    console.error("BalVoice save failed", err);
    toast("Not saved: " + friendlyError(err) + " Reloading the latest data.");
    if (currentClient) switchClient(currentClient, true);
  }
  const mask = p => { const d = String(p); return d.length > 4 ? d.slice(0, -4).replace(/\d/g, "•") + d.slice(-4) : d; };
  const fullName = c => (((c.fn || "") + " " + (c.ln || "")).trim() || c.n || "");
  const findCampaign = id => state.campaigns.find(c => c.id === id);
  const findGroup = id => state.groups.find(g => g.id === id);
  const optoutSet = () => new Set(state.optouts.map(o => key(o.p)));
  const tagHTML = (cls, label) => `<span class="tag ${cls}">${esc(label)}</span>`;
  const statusTag = s => tagHTML("tag-" + s, STATUS[s] || s);
  const groupCount = gid => state.contacts.reduce((n, c) => n + (c.groups.indexOf(gid) > -1 ? 1 : 0), 0);
  const allTemplates = () => STARTER_TEMPLATES.concat(state.templates);
  const approvedCallerIds = () => state.callerIds.filter(c => c.status === "approved");

  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("is-visible");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("is-visible"), 3200);
  }
  function logEvent(c, msg) { c.events = c.events || []; c.events.unshift(LIVE ? { t: nowISO(), msg, pending: true } : { t: nowISO(), msg }); }
  function emptyState(title, text, action) {
    return `<div class="empty">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="6" y="9" width="28" height="22" rx="3"/><path d="M6 15h28M12 22h10M12 26h6" stroke-linecap="round"/></svg>
      <h2>${esc(title)}</h2><p>${esc(text)}</p>${action || ""}</div>`;
  }

  /* Personalization: {first_name}, {first_name|fallback}, etc. */
  const FIELD_RE = /\{(first_name|last_name|full_name|company)(?:\|([^}]{0,40}))?\}/g;
  function fieldValue(contact, field) {
    if (!contact) return "";
    if (field === "first_name") return contact.fn || "";
    if (field === "last_name") return contact.ln || "";
    if (field === "full_name") return fullName(contact);
    if (field === "company") return contact.company || "";
    return "";
  }
  function personalize(text, contact) {
    return String(text || "").replace(FIELD_RE, (_, f, fb) => fieldValue(contact, f) || (fb || ""));
  }
  function usedFields(text) {
    const out = new Map();
    String(text || "").replace(FIELD_RE, (_, f, fb) => { if (!out.has(f) || fb === undefined) out.set(f, fb !== undefined); return ""; });
    return out; // field -> hasFallback
  }
  const ttsSeconds = text => Math.max(3, Math.round(String(text || "").trim().split(/\s+/).filter(Boolean).length / 2.4));

  /* Billing estimate using account settings. */
  function billedMinutes(seconds) {
    return state.settings.billing === "minute" ? Math.ceil(seconds / 60) : seconds / 60;
  }

  /* Contact files (CSV and Excel) --------------------------------------- */
  function csvToRows(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const delim = [",", ";", "\t"].reduce((best, d) => lines[0].split(d).length > lines[0].split(best).length ? d : best, ",");
    const split = line => {
      const out = []; let cur = "", q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
          else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === delim) { out.push(cur); cur = ""; }
        else cur += ch;
      }
      out.push(cur);
      return out.map(s => s.trim());
    };
    return lines.map(split);
  }

  /* Map raw rows (from CSV or Excel) to contacts by detecting the columns. */
  function mapRows(rows) {
    rows = rows.filter(r => r.some(c => String(c || "").trim()));
    if (!rows.length) return null;
    rows = rows.map(r => r.map(c => String(c == null ? "" : c).trim()));
    const header = rows[0].map(h => h.toLowerCase().replace(/[\s_-]+/g, ""));
    const find = re => header.findIndex(h => re.test(h));
    let cols = {
      phone: find(/phone|mobile|msisdn|number|^tel|^cell|^contact$/),
      fn: find(/^(first|firstname|fname|givenname)$/),
      ln: find(/^(last|lastname|lname|surname|familyname)$/),
      name: find(/^(name|fullname|contactname)$/),
      email: find(/email/),
      company: find(/company|organi[sz]ation|church|business/)
    };
    let start = 1;
    if (cols.phone === -1 || normPhone(rows[0][cols.phone])) {
      // No header row: guess the phone column and treat the first text column as a name.
      start = 0;
      const ph = rows[0].findIndex(c => normPhone(c));
      cols = { phone: ph === -1 ? 0 : ph, fn: -1, ln: -1, name: -1, email: -1, company: -1 };
      cols.name = rows[0].findIndex((c, i) => i !== cols.phone && c && !/\d{5,}/.test(c) && c.indexOf("@") === -1);
    }
    return {
      rows: rows.slice(start).map(r => {
        let fn = cols.fn > -1 ? r[cols.fn] : "", ln = cols.ln > -1 ? r[cols.ln] : "";
        if (!fn && !ln && cols.name > -1 && r[cols.name]) {
          const parts = r[cols.name].trim().split(/\s+/);
          fn = parts.shift() || ""; ln = parts.join(" ");
        }
        const email = cols.email > -1 ? r[cols.email] : "";
        return {
          raw: r[cols.phone], fn: (fn || "").slice(0, 40), ln: (ln || "").slice(0, 40),
          email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email || "") ? email.slice(0, 120) : "",
          company: (cols.company > -1 ? r[cols.company] || "" : "").slice(0, 80)
        };
      })
    };
  }

  function readContactFile(file, onRows, onError) {
    if (!file) return;
    const isXLSX = XLSX_EXT.test(file.name);
    if (/\.xls$/i.test(file.name)) return onError("Older .xls files are not supported. Open the file in Excel and save it as .xlsx or CSV.");
    if (!isXLSX && !CSV_EXT.test(file.name)) return onError("Upload an Excel (.xlsx) or CSV file with a phone column.");
    if (file.size > LIMITS.csvBytes) return onError("This file is larger than " + LIMITS.csvBytes / 1024 / 1024 + " MB.");
    if (file.size === 0) return onError("This file is empty.");
    const done = rows => {
      const parsed = mapRows(rows);
      if (!parsed || !parsed.rows.length) return onError("No contacts were found. Make sure the first sheet has a phone column.");
      onRows(parsed.rows);
    };
    if (isXLSX) {
      if (!window.BalVoiceXLSX) return onError("Excel support could not be loaded. Please save the file as CSV.");
      window.BalVoiceXLSX.readRows(file).then(done, err => onError(err && err.userMessage ? err.userMessage : "This Excel file could not be read. Save it again as .xlsx or CSV."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => onError("The file could not be read.");
    reader.onload = () => done(csvToRows(String(reader.result)));
    reader.readAsText(file);
  }

  /* Add or update contacts in the phonebook, optionally adding them to a group.
   * Matching is by phone number; empty fields on existing contacts are filled in. */
  function importContacts(rows, groupId) {
    const byKey = new Map(state.contacts.map(c => [key(c.p), c]));
    const seen = new Set(), opt = optoutSet();
    const r = { added: 0, updated: 0, invalid: 0, duplicates: 0, optedOut: 0, overLimit: 0, short: 0 };
    for (const row of rows) {
      const p = normPhone(row.raw || row.p);
      if (!p) { r.invalid++; continue; }
      const k = key(p);
      if (seen.has(k)) { r.duplicates++; continue; }
      seen.add(k);
      if (rawTruncated(row.raw || row.p)) r.short++;
      if (opt.has(k)) r.optedOut++;
      let c = byKey.get(k);
      if (c) {
        ["fn", "ln", "email", "company"].forEach(f => { if (!c[f] && row[f]) c[f] = row[f]; });
        if (groupId && c.groups.indexOf(groupId) === -1) c.groups.push(groupId);
        r.updated++;
      } else {
        if (state.contacts.length >= LIMITS.contacts) { r.overLimit++; continue; }
        c = { id: uid(), p, fn: row.fn || "", ln: row.ln || "", email: row.email || "", company: row.company || "", groups: groupId ? [groupId] : [], createdAt: nowISO() };
        state.contacts.push(c); byKey.set(k, c); r.added++;
      }
    }
    return r;
  }
  // Excel drops the leading 0 from local numbers stored as numbers (0244… → 244…).
  const TRUNC_HINT = "They were read as Ghana numbers (+233…). If that is wrong, format the phone column as Text, re-type the numbers, and import again.";
  function importSummary(r) {
    const parts = [num(r.added) + " added", num(r.updated) + " already in contacts"];
    if (r.invalid) parts.push(num(r.invalid) + " invalid");
    if (r.duplicates) parts.push(num(r.duplicates) + " duplicates skipped");
    if (r.optedOut) parts.push(num(r.optedOut) + " on opt-out register (will not be called)");
    if (r.short) parts.push(num(r.short) + " numbers had only 9 digits — " + TRUNC_HINT);
    if (r.overLimit) parts.push(num(r.overLimit) + " not added — the dashboard limit of " + num(LIMITS.contacts) + " contacts per client was reached");
    return parts.join(" · ");
  }

  function downloadCSV(filename, header, rows) {
    const safe = v => { let s = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(s) && !/^\+\d+$/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const lines = [header.join(",")].concat(rows.map(r => r.map(safe).join(",")));
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename.replace(/[^\w\- .]+/g, "").trim().replace(/\s+/g, "-").toLowerCase();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* Router ---------------------------------------------------------------- */
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, "") || "campaigns";
    const [path, qs] = raw.split("?");
    const [name, id] = path.split("/");
    return { name, id, params: new URLSearchParams(qs || "") };
  }
  function route() {
    const { name, id, params } = parseHash();
    const navKey = { campaign: "campaigns", group: "groups" }[name] || name;
    document.querySelectorAll(".side-link[data-route]").forEach(a => {
      const on = a.dataset.route === navKey;
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    closeSidebar();
    if (timers.poll) { clearInterval(timers.poll); delete timers.poll; }
    const global = ["clients", "requests", "team", "audit"];
    if (LIVE && !currentClient && global.indexOf(name) === -1) { renderClients(); return; }
    if (LIVE && !isAdmin() && (name === "team" || name === "audit" || name === "requests")) { renderCampaigns(); return; }
    switch (name) {
      case "clients": renderClients(); break;
      case "requests": renderRequests(); break;
      case "team": renderTeam(); break;
      case "audit": renderAudit(); break;
      case "new": renderNew(params); break;
      case "campaign": renderDetail(id); break;
      case "reports": renderReports(); break;
      case "groups": renderGroups(); break;
      case "group": renderGroup(id); break;
      case "contacts": renderContacts(); break;
      case "templates": renderTemplates(); break;
      case "callerids": renderCallerIds(); break;
      case "audio": renderAudio(); break;
      case "optouts": renderOptouts(); break;
      case "settings": renderSettings(); break;
      default: renderCampaigns();
    }
    applyWidths(view);
    const h = view.querySelector("h1");
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  function applyWidths(root) {
    root.querySelectorAll("[data-w]").forEach(el => { el.style.width = el.dataset.w + "%"; });
    root.querySelectorAll("[data-color]").forEach(el => { el.style.background = el.dataset.color; });
  }

  /* Campaigns ------------------------------------------------------------- */
  function estimateRecipients(c) {
    const ids = new Set((c.recipients && c.recipients.groupIds) || []), opt = optoutSet();
    return state.contacts.filter(x => x.groups.some(g => ids.has(g)) && !opt.has(key(x.p))).length;
  }
  function counts(c) {
    if (c.live) {
      const s = c.live.current;
      if (!s) return { answered: 0, busy: 0, noanswer: 0, unreachable: 0, done: 0, attempts: 0, skipped: 0, total: estimateRecipients(c), estimate: true };
      return { answered: +s.answered, busy: +s.busy, noanswer: +s.noanswer, unreachable: +s.unreachable, done: +s.done, attempts: +s.attempts, skipped: +s.skipped, total: +s.recipients };
    }
    const r = { answered: 0, busy: 0, noanswer: 0, unreachable: 0, done: 0, attempts: 0 };
    Object.values(c.results || {}).forEach(x => { r[x.o]++; r.done++; r.attempts += x.a; });
    r.total = (c.contacts || []).length;
    return r;
  }
  function msgSeconds(c) {
    if (c.message && c.message.type === "tts") return c.message.seconds || ttsSeconds(c.message.text);
    return (c.audio && c.audio.duration) || 0;
  }
  function billing(c, k) {
    if (c.live) {
      const cur = c.live.current, minutes = cur && cur.billable_minutes != null ? Number(cur.billable_minutes) : 0;
      const r = parseFloat(state.settings.rate);
      return { minutes, cost: isFinite(r) && state.settings.rate !== "" ? minutes * r : null };
    }
    const per = billedMinutes(msgSeconds(c));
    const calls = state.settings.answeredOnly ? k.answered : k.attempts;
    const minutes = per * calls;
    const rate = parseFloat(state.settings.rate);
    return { minutes, cost: isFinite(rate) && state.settings.rate !== "" ? minutes * rate : null };
  }

  function renderCampaigns() {
    document.title = "Campaigns — BalVoice";
    const cs = state.campaigns.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const by = s => cs.filter(c => c.status === s).length;
    view.innerHTML = `
      <div class="view-head">
        <div><h1>Campaigns</h1><p>Create, schedule, and monitor voice broadcast campaigns.</p></div>
        <a class="btn btn-primary" href="#/new">Create campaign</a>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-label">Total campaigns</div><div class="stat-value">${cs.length}</div></div>
        <div class="stat"><div class="stat-label">Scheduled</div><div class="stat-value">${by("scheduled")}</div></div>
        <div class="stat"><div class="stat-label">Contacts in phonebook</div><div class="stat-value">${num(state.contacts.length)}</div><div class="stat-sub">${state.groups.length} group${state.groups.length === 1 ? "" : "s"}</div></div>
        <div class="stat"><div class="stat-label">Completed</div><div class="stat-value">${by("completed")}</div></div>
      </div>
      <div class="box">
        ${cs.length ? `
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th scope="col">Campaign</th><th scope="col">Message</th><th scope="col">Status</th><th scope="col" class="num">Contacts</th><th scope="col">Scheduled start</th><th scope="col" class="num">Answered</th></tr></thead>
          <tbody>${cs.map(c => {
            const k = counts(c);
            return `<tr>
              <td><a href="#/campaign/${esc(c.id)}">${esc(c.name)}</a><div class="small muted">${esc(c.sender)}${c.schedule && c.schedule.repeat && c.schedule.repeat !== "none" ? " · repeats " + esc(REPEAT[c.schedule.repeat].toLowerCase()) : ""}</div></td>
              <td>${c.message && c.message.type === "tts" ? "Text-to-speech" : "Audio file"}</td>
              <td>${statusTag(c.status)}</td>
              <td class="num">${num(k.total)}</td>
              <td>${c.schedule ? esc(fmtDate(c.schedule.start)) : "—"}</td>
              <td class="num">${k.done ? num(k.answered) + " <span class='muted'>(" + pct(k.answered, k.total) + "%)</span>" : "—"}</td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>` : emptyState("No campaigns yet", "Create contact groups for your audience, then create a campaign with a recorded or text-to-speech message.", `<div class="head-actions center-actions"><a class="btn btn-secondary" href="#/groups">Set up contact groups</a><a class="btn btn-primary" href="#/new">Create campaign</a></div>`)}
      </div>`;
  }

  /* Wizard ---------------------------------------------------------------- */
  const STEPS = ["Campaign details", "Message", "Recipients", "Schedule", "Review"];

  function newDraft() {
    return {
      id: uid(), name: "", type: "", sender: "", callerId: "", description: "",
      msgType: "audio", audio: null, audioUrl: null,
      tts: { text: "", lang: "en", voice: "female", templateId: "" },
      audioChecks: { sender: false, optout: false },
      recipMode: state.groups.length ? "groups" : "upload",
      groupIds: [], list: null, uploadRows: [], uploadStats: null, saveTo: "", newGroupName: "",
      consent: false, consentBasis: "",
      schedule: { date: "", time: "", windowStart: "09:00", windowEnd: "19:00", retries: "2", interval: "30", repeat: "none", repeatUntil: "" },
      testCalls: []
    };
  }

  function draftRecipients(d) {
    const opt = optoutSet();
    if (d.recipMode === "groups") {
      const ids = new Set(d.groupIds);
      const inGroups = state.contacts.filter(c => c.groups.some(g => ids.has(g)));
      const memberships = state.contacts.reduce((n, c) => n + c.groups.filter(g => ids.has(g)).length, 0);
      const list = inGroups.filter(c => !opt.has(key(c.p)));
      return { list, optedOut: inGroups.length - list.length, duplicates: memberships - inGroups.length, invalid: 0 };
    }
    const seen = new Set(); const list = []; let optedOut = 0, invalid = 0, duplicates = 0;
    for (const row of d.uploadRows) {
      const p = normPhone(row.raw);
      if (!p) { invalid++; continue; }
      const k = key(p);
      if (seen.has(k)) { duplicates++; continue; }
      seen.add(k);
      if (opt.has(k)) { optedOut++; continue; }
      list.push({ p, fn: row.fn, ln: row.ln, company: row.company, email: row.email, short: rawTruncated(row.raw) });
    }
    return { list, optedOut, duplicates, invalid };
  }
  function draftSeconds(d) { return d.msgType === "tts" ? ttsSeconds(d.tts.text) : (d.audio ? d.audio.duration : 0); }

  function renderNew(params) {
    document.title = "Create campaign — BalVoice";
    if (!draft) {
      draft = newDraft(); step = 0; maxStep = 0;
      const g = params && params.get("group");
      if (g && findGroup(g)) { draft.recipMode = "groups"; draft.groupIds = [g]; }
    }
    view.innerHTML = `
      <div class="view-head">
        <div><div class="view-crumb"><a href="#/campaigns">Campaigns</a> / New</div><h1>Create campaign</h1></div>
        <div class="head-actions"><button class="btn btn-secondary" type="button" id="discard">Discard</button></div>
      </div>
      <div class="wizard">
        <ol class="steps" aria-label="Steps">
          ${STEPS.map((s, i) => `<li class="${i === step ? "is-current" : ""} ${i < maxStep && i !== step ? "is-done" : ""}">
            <button type="button" data-step="${i}" ${i > maxStep ? "disabled" : ""} ${i === step ? 'aria-current="step"' : ""}>${s}</button></li>`).join("")}
        </ol>
        <form class="box" id="wizard-form" novalidate>
          <div class="box-head"><div><h2>${STEPS[step]}</h2><p>Step ${step + 1} of ${STEPS.length}</p></div></div>
          <div class="box-body"><div class="form">${stepBody()}</div></div>
          <div class="box-foot">
            <button class="btn btn-secondary" type="button" id="back" ${step === 0 ? "disabled" : ""}>Back</button>
            <div class="head-actions">
              ${step === 4 ? `<button class="btn btn-secondary" type="button" id="save-draft">Save as draft</button>
                              <button class="btn btn-primary" type="submit">Schedule campaign</button>`
                           : `<button class="btn btn-primary" type="submit">Continue</button>`}
            </div>
          </div>
        </form>
      </div>`;
    const cur = view.querySelector(".steps .is-current");
    if (cur) cur.parentNode.scrollLeft = cur.offsetLeft - 8;
    bindStep();
  }

  function segmented(name, value, options) {
    return `<div class="segmented" role="radiogroup" aria-label="${esc(name)}">${options.map(([v, l]) =>
      `<button type="button" role="radio" aria-checked="${v === value}" data-seg="${esc(name)}" data-value="${esc(v)}">${esc(l)}</button>`).join("")}</div>`;
  }

  function stepBody() {
    const d = draft;
    if (step === 0) {
      const ids = approvedCallerIds();
      return `
      <div class="field"><label for="w-name">Campaign name</label>
        <input class="input" id="w-name" maxlength="80" value="${esc(d.name)}" placeholder="e.g. Easter convention invitation">
        <span class="hint">For your reference only. Recipients do not see this.</span><span class="field-error"></span></div>
      <div class="form-row">
        <div class="field"><label for="w-type">Campaign type</label>
          <select class="select" id="w-type"><option value="">Select…</option>
            ${Object.entries(TYPES).map(([v, l]) => `<option value="${v}" ${d.type === v ? "selected" : ""}>${l}</option>`).join("")}
          </select><span class="field-error"></span></div>
        <div class="field"><label for="w-sender">Sending organization</label>
          <input class="input" id="w-sender" maxlength="80" value="${esc(d.sender)}" placeholder="Name used in the message">
          <span class="field-error"></span></div>
      </div>
      <div class="field"><label for="w-caller">Caller ID</label>
        <select class="select" id="w-caller">
          <option value="">Platform number (default)</option>
          ${ids.map(c => `<option value="${esc(c.id)}" ${d.callerId === c.id ? "selected" : ""}>${esc(c.value)} — ${c.type === "brand" ? "brand name" : "phone number"}</option>`).join("")}
        </select>
        <span class="hint">What recipients see when the phone rings. ${ids.length ? "" : "No approved caller IDs yet — "}<a href="#/callerids">Manage caller IDs</a></span></div>
      <div class="field"><label for="w-desc">Internal notes <span class="optional">(optional)</span></label>
        <textarea class="textarea" id="w-desc" maxlength="500">${esc(d.description)}</textarea></div>`;
    }

    if (step === 1) return `
      ${segmented("Message source", d.msgType, [["audio", "Upload recording"], ["tts", "Text-to-speech"]])}
      ${d.msgType === "audio" ? audioPane() : ttsPane()}
      <p class="inline-error" id="audio-error" role="alert"></p>
      <fieldset class="checkbox-group">
        <legend class="legend-label">Message checklist</legend>
        <label class="checkbox"><input type="checkbox" id="w-chk-sender" ${d.audioChecks.sender ? "checked" : ""}><span>The message identifies the sending organization near the start.</span></label>
        <label class="checkbox"><input type="checkbox" id="w-chk-optout" ${d.audioChecks.optout ? "checked" : ""}><span>The message tells listeners how to opt out of future calls.</span></label>
      </fieldset>`;

    if (step === 2) return recipientsPane();

    if (step === 3) {
      const s = d.schedule;
      return `
      <div class="form-row">
        <div class="field"><label for="w-date">Start date</label><input class="input" type="date" id="w-date" value="${esc(s.date)}"><span class="field-error"></span></div>
        <div class="field"><label for="w-time">Start time</label><input class="input" type="time" id="w-time" value="${esc(s.time)}"><span class="field-error"></span></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="w-repeat">Repeat</label>
          <select class="select" id="w-repeat">${Object.entries(REPEAT).map(([v, l]) => `<option value="${v}" ${s.repeat === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label for="w-until">Repeat until ${s.repeat === "none" ? '<span class="optional">(not repeating)</span>' : ""}</label>
          <input class="input" type="date" id="w-until" value="${esc(s.repeatUntil)}" ${s.repeat === "none" ? "disabled" : ""}><span class="field-error"></span></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="w-ws">Daily calling window — from</label><input class="input" type="time" id="w-ws" value="${esc(s.windowStart)}"><span class="field-error"></span></div>
        <div class="field"><label for="w-we">Until</label><input class="input" type="time" id="w-we" value="${esc(s.windowEnd)}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="w-retries">Retries for unanswered calls</label>
          <select class="select" id="w-retries">${[0, 1, 2, 3].map(n => `<option value="${n}" ${String(s.retries) === String(n) ? "selected" : ""}>${n === 0 ? "No retries" : n + (n === 1 ? " retry" : " retries")}</option>`).join("")}</select></div>
        <div class="field"><label for="w-interval">Time between retries</label>
          <select class="select" id="w-interval">${[15, 30, 60, 120].map(n => `<option value="${n}" ${String(s.interval) === String(n) ? "selected" : ""}>${n < 60 ? n + " minutes" : n / 60 + (n === 60 ? " hour" : " hours")}</option>`).join("")}</select></div>
      </div>
      <p class="notice">Calls are only placed inside the calling window. Set it according to local rules and your audience's routine. Times use this device's time zone (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone || "local")}).${d.recipMode === "groups" && s.repeat !== "none" ? " Repeating campaigns call the selected groups as they are at the time of each run, so new group members are included." : ""}</p>`;
    }
    return reviewPane();
  }

  function audioPane() {
    const d = draft;
    return d.audio ? `
      <div class="file-summary">
        <div class="file-icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 7v4M6 4v10M9 6v6M12 3v12M15 7v4" stroke-linecap="round"/></svg></div>
        <div class="meta"><strong>${esc(d.audio.name)}</strong><span>${fmtDur(d.audio.duration)} · ${fmtBytes(d.audio.size)}</span>
          ${d.audioUrl ? `<audio controls preload="metadata" src="${esc(d.audioUrl)}"></audio>` : ""}</div>
        <button class="btn btn-quiet" type="button" id="audio-remove">Replace</button>
      </div>
      ${d.audio.duration > 60 ? `<p class="notice notice-warn">This message is longer than 60 seconds. Shorter messages are more likely to be heard in full and cost less to deliver.</p>` : ""}
    ` : `
      <div class="dropzone" id="audio-drop">
        <input type="file" id="w-audio" accept=".mp3,.wav,audio/mpeg,audio/wav" aria-describedby="audio-help">
        <strong>Upload recorded message</strong>
        <span id="audio-help">MP3 or WAV, up to ${LIMITS.audioBytes / 1024 / 1024} MB and ${LIMITS.audioSeconds / 60} minutes. Drag a file here or click to browse.</span>
      </div>`;
  }

  function ttsPane() {
    const t = draft.tts;
    const secs = ttsSeconds(t.text);
    const sample = draftRecipients(draft).list[0] || null;
    return `
      <div class="form-row">
        <div class="field"><label for="w-tpl">Start from a template <span class="optional">(optional)</span></label>
          <select class="select" id="w-tpl"><option value="">Write my own</option>
            ${allTemplates().map(tp => `<option value="${esc(tp.id)}" ${t.templateId === tp.id ? "selected" : ""}>${esc(tp.name)}${tp.starter ? " (starter)" : ""}</option>`).join("")}
          </select></div>
        <div class="field"><label for="w-lang">Language</label>
          <select class="select" id="w-lang">${Object.entries(LANGS).map(([v, l]) => `<option value="${v}" ${t.lang === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      </div>
      <div class="field">
        <label for="w-tts">Message text</label>
        <div class="insert-bar" aria-label="Insert a personal field">
          <span class="small muted">Insert:</span>
          ${FIELDS.map(([f, l]) => `<button type="button" class="chip-btn" data-insert="{${f}}">${l}</button>`).join("")}
        </div>
        <textarea class="textarea textarea-lg" id="w-tts" maxlength="${LIMITS.ttsChars}" placeholder="Type the message to be read out. Use fields such as {first_name} to personalise it.">${esc(t.text)}</textarea>
        <span class="hint"><span id="tts-count">${t.text.length}</span> / ${LIMITS.ttsChars} characters · about <span id="tts-secs">${fmtDur(secs)}</span> when spoken. Add a fallback after a bar for missing values: <code>{first_name|friend}</code>.</span>
      </div>
      <div class="form-row">
        <div class="field"><label for="w-voice">Voice</label>
          <select class="select" id="w-voice">${Object.entries(VOICES).map(([v, l]) => `<option value="${v}" ${t.voice === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><span class="field-label">Preview</span>
          <button type="button" class="btn btn-secondary" id="tts-play">Listen in browser</button></div>
      </div>
      <div class="preview-box" id="tts-preview" aria-live="polite">
        <span class="preview-label">${sample ? "How it reads for " + esc(fullName(sample) || mask(sample.p)) : "How it reads (fields shown with fallbacks — pick recipients to preview a real contact)"}</span>
        <p id="tts-preview-text">${esc(personalize(t.text, sample)) || '<span class="muted">Your message will appear here.</span>'}</p>
      </div>
      ${t.lang !== "en" ? `<p class="notice">Browser preview reads English only. ${LANGS[t.lang]} audio is produced by the voice engine when the campaign is sent — send a test call from the Review step to hear it.</p>` : ""}`;
  }

  function recipientsPane() {
    const d = draft;
    const r = draftRecipients(d);
    const fields = d.msgType === "tts" ? usedFields(d.tts.text) : new Map();
    const missing = [];
    fields.forEach((hasFallback, f) => {
      if (hasFallback) return;
      const n = r.list.filter(c => !fieldValue(c, f)).length;
      if (n) missing.push(num(n) + " without " + FIELDS.find(x => x[0] === f)[1].toLowerCase());
    });

    let pane;
    if (d.recipMode === "groups") {
      pane = state.groups.length ? `
        <div class="pick-list" role="group" aria-label="Contact groups">
          ${state.groups.map(g => { const n = groupCount(g.id); return `
            <label class="pick ${d.groupIds.indexOf(g.id) > -1 ? "is-on" : ""}">
              <input type="checkbox" data-group="${esc(g.id)}" ${d.groupIds.indexOf(g.id) > -1 ? "checked" : ""} ${n ? "" : "disabled"}>
              <span class="pick-name">${esc(g.name)}${g.description ? `<span class="small muted">${esc(g.description)}</span>` : ""}</span>
              <span class="pick-count mono">${num(n)}</span>
            </label>`; }).join("")}
        </div>
        <p class="small muted mb-0"><a href="#/groups">Manage contact groups</a></p>`
      : `<div class="notice">You have no contact groups yet. <a href="#/groups">Create a group</a> and import contacts, or upload a file instead.</div>`;
    } else {
      pane = d.list ? `
        <div class="file-summary">
          <div class="file-icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="2.5" width="12" height="13" rx="1.5"/><path d="M6 6.5h6M6 9h6M6 11.5h4" stroke-linecap="round"/></svg></div>
          <div class="meta"><strong>${esc(d.list.name)}</strong><span>${num(d.uploadRows.length)} rows · ${fmtBytes(d.list.size)}</span></div>
          <button class="btn btn-quiet" type="button" id="list-remove">Replace</button>
        </div>
        <div class="form-row">
          <div class="field"><label for="w-saveto">Save these contacts to a group</label>
            <select class="select" id="w-saveto">
              <option value="">Don't save (this campaign only)</option>
              ${state.groups.map(g => `<option value="${esc(g.id)}" ${d.saveTo === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}
              <option value="__new" ${d.saveTo === "__new" ? "selected" : ""}>New group…</option>
            </select></div>
          <div class="field"><label for="w-newgroup">New group name</label>
            <input class="input" id="w-newgroup" maxlength="${LIMITS.groupName}" value="${esc(d.newGroupName)}" ${d.saveTo === "__new" ? "" : "disabled"}><span class="field-error"></span></div>
        </div>` : `
        <div class="dropzone" id="list-drop">
          <input type="file" id="w-list" accept="${LIST_ACCEPT}" aria-describedby="list-help">
          <strong>Upload contact list</strong>
          <span id="list-help">Excel (.xlsx) or CSV with a <strong>phone</strong> column. Optional: <strong>name</strong> (or first_name and last_name), company, email.</span>
        </div>`;
    }

    const hasSel = d.recipMode === "groups" ? d.groupIds.length > 0 : !!d.list;
    return `
      ${segmented("Recipient source", d.recipMode, [["groups", "Contact groups"], ["upload", "Upload a file"]])}
      ${pane}
      ${hasSel ? `
      <div class="check-grid">
        <div><div class="k">Contacts to call</div><div class="v ok">${num(r.list.length)}</div></div>
        <div><div class="k">${d.recipMode === "groups" ? "In more than one group" : "Duplicates removed"}</div><div class="v ${r.duplicates ? "warn" : ""}">${num(r.duplicates)}</div></div>
        <div><div class="k">On opt-out register</div><div class="v ${r.optedOut ? "warn" : ""}">${num(r.optedOut)}</div></div>
        <div><div class="k">Invalid numbers</div><div class="v ${r.invalid ? "bad" : ""}">${num(r.invalid)}</div></div>
      </div>
      ${d.recipMode === "upload" && r.list.some(c => c.short) ? `<p class="notice notice-warn">${num(r.list.filter(c => c.short).length)} numbers had only 9 digits. ${TRUNC_HINT}</p>` : ""}
      ${missing.length ? `<p class="notice notice-warn">Your message uses personal fields, but some contacts are missing them: ${esc(missing.join(", "))}. Those contacts will hear a blank. Add a fallback such as <code>{first_name|friend}</code> in the message step, or fill in the contacts in the group.</p>` : ""}` : ""}
      <p class="inline-error" id="list-error" role="alert"></p>
      <label class="checkbox"><input type="checkbox" id="w-consent" ${d.consent ? "checked" : ""}><span>I confirm that everyone I am sending to has agreed to receive calls from <strong>${esc(d.sender || "our organization")}</strong>.</span></label>
      <div class="field"><label for="w-basis">How did these people agree to be called?</label>
        <input class="input" id="w-basis" maxlength="300" value="${esc(d.consentBasis)}" placeholder="e.g. Members gave their numbers on the church registration form">
        <span class="hint">Kept with the campaign as the consent record, together with your name and the time.</span><span class="field-error"></span></div>`;
  }

  function reviewPane() {
    const d = draft, s = d.schedule;
    const r = draftRecipients(d);
    const secs = draftSeconds(d);
    const caller = d.callerId ? state.callerIds.find(c => c.id === d.callerId) : null;
    const per = billedMinutes(secs);
    const rate = parseFloat(state.settings.rate);
    const hasRate = state.settings.rate !== "" && isFinite(rate);
    const maxCalls = state.settings.answeredOnly ? r.list.length : r.list.length * (Number(s.retries) + 1);
    const source = d.recipMode === "groups"
      ? d.groupIds.map(id => (findGroup(id) || {}).name).filter(Boolean).join(", ")
      : (d.list ? d.list.name : "");
    return `
      <dl class="review">
        <dt>Campaign</dt><dd>${esc(d.name)}</dd>
        <dt>Type</dt><dd>${esc(TYPES[d.type])}</dd>
        <dt>Sending organization</dt><dd>${esc(d.sender)}</dd>
        <dt>Caller ID</dt><dd>${caller ? esc(caller.value) : "Platform number"}</dd>
        <dt>Message</dt><dd>${d.msgType === "tts" ? "Text-to-speech · " + esc(LANGS[d.tts.lang]) + " · " + esc(VOICES[d.tts.voice].toLowerCase()) + " · about " + fmtDur(secs) : esc(d.audio.name) + " · " + fmtDur(secs)}</dd>
        <dt>Recipients</dt><dd>${num(r.list.length)} contacts from ${d.recipMode === "groups" ? "group" + (d.groupIds.length > 1 ? "s" : "") : "file"} ${esc(source)}</dd>
        <dt>Start</dt><dd>${esc(fmtDate(startISO(s)))}</dd>
        <dt>Repeat</dt><dd>${esc(REPEAT[s.repeat])}${s.repeat !== "none" ? " until " + esc(fmtDate(s.repeatUntil + "T23:59", false)) : ""}</dd>
        <dt>Calling window</dt><dd>${esc(s.windowStart)} – ${esc(s.windowEnd)} daily</dd>
        <dt>Retries</dt><dd>${s.retries === "0" ? "None" : esc(s.retries) + " × every " + esc(s.interval) + " min"}</dd>
        <dt>Compliance</dt><dd>Consent confirmed · Sender identified · Opt-out included<br><span class="small muted">${esc(d.consentBasis)}</span></dd>
        <dt>Estimated airtime</dt><dd>${hasRate
          ? `${money(per * rate)} per ${state.settings.answeredOnly ? "answered call" : "attempt"} · up to ${money(maxCalls * per * rate)} for this run`
          : `Set your airtime rate in <a href="#/settings">Settings</a> to see an estimate.`}</dd>
      </dl>
      ${LIVE ? `<p class="notice">Test calls will be available once the voice provider is connected.</p>` : `<div class="test-call">
        <div>
          <h3>Send a test call</h3>
          <p class="small muted mb-0">Hear the message on your own phone before scheduling.${d.msgType === "tts" ? " Personal fields are filled using the first recipient." : ""}</p>
        </div>
        <div class="toolbar">
          <label class="sr-only" for="w-testphone">Your phone number</label>
          <input class="input" id="w-testphone" type="tel" maxlength="20" placeholder="Your phone number" autocomplete="tel">
          <button class="btn btn-secondary" type="button" id="w-testcall">Call me</button>
        </div>
        ${d.testCalls.length ? `<ul class="events">${d.testCalls.slice(0, 3).map(t => `<li><div>Test call to ${esc(mask(t.p))} — simulated<time datetime="${esc(t.t)}">${esc(fmtDate(t.t))}</time></div></li>`).join("")}</ul>` : ""}
      </div>`}`;
  }

  function startISO(s) {
    if (!s.date || !s.time) return null;
    const d = new Date(s.date + "T" + s.time);
    return isNaN(d) ? null : d.toISOString();
  }
  function setErr(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    const f = el.closest(".field");
    if (f) { f.classList.toggle("has-error", !!msg); const e = f.querySelector(".field-error"); if (e) e.textContent = msg || ""; }
    el.setAttribute("aria-invalid", String(!!msg));
  }

  function collect() {
    const v = id => { const el = document.getElementById(id); return el ? el.value : null; };
    const c = id => { const el = document.getElementById(id); return el ? el.checked : null; };
    const d = draft;
    if (step === 0) { d.name = v("w-name").trim(); d.type = v("w-type"); d.sender = v("w-sender").trim(); d.callerId = v("w-caller"); d.description = v("w-desc").trim(); }
    if (step === 1) {
      d.audioChecks = { sender: c("w-chk-sender"), optout: c("w-chk-optout") };
      if (d.msgType === "tts" && v("w-tts") !== null) { d.tts.text = v("w-tts"); d.tts.lang = v("w-lang"); d.tts.voice = v("w-voice"); d.tts.templateId = v("w-tpl"); }
    }
    if (step === 2) {
      d.consent = c("w-consent");
      if (v("w-basis") !== null) d.consentBasis = v("w-basis").trim();
      if (v("w-saveto") !== null) { d.saveTo = v("w-saveto"); d.newGroupName = v("w-newgroup").trim(); }
    }
    if (step === 3) {
      Object.assign(d.schedule, { date: v("w-date"), time: v("w-time"), windowStart: v("w-ws"), windowEnd: v("w-we"), retries: v("w-retries"), interval: v("w-interval"), repeat: v("w-repeat"), repeatUntil: v("w-until") || "" });
    }
  }

  function validateStep() {
    collect();
    const d = draft;
    let ok = true;
    if (step === 0) {
      setErr("w-name", d.name.length >= 3 ? "" : "Enter a name of at least 3 characters."); ok = d.name.length >= 3;
      setErr("w-type", d.type ? "" : "Select a campaign type."); ok = ok && !!d.type;
      setErr("w-sender", d.sender.length >= 2 ? "" : "Enter the organization name."); ok = ok && d.sender.length >= 2;
    }
    if (step === 1) {
      const err = document.getElementById("audio-error");
      if (d.msgType === "audio" && !d.audio) { err.textContent = "Upload the recorded message to continue."; ok = false; }
      else if (d.msgType === "tts" && d.tts.text.trim().length < 10) { err.textContent = "Type the message to be read out (at least 10 characters)."; ok = false; }
      else if (!d.audioChecks.sender || !d.audioChecks.optout) { err.textContent = "Confirm both checklist items. Every message must identify the sender and include an opt-out."; ok = false; }
      else err.textContent = "";
    }
    if (step === 2) {
      const err = document.getElementById("list-error");
      const r = draftRecipients(d);
      if (!r.list.length) { err.textContent = d.recipMode === "groups" ? "Select at least one group with contacts who can be called." : "Upload a contact list with at least one valid number."; ok = false; }
      else if (d.recipMode === "upload" && d.saveTo === "__new" && d.newGroupName.length < 2) { setErr("w-newgroup", "Enter a name for the new group."); err.textContent = ""; ok = false; }
      else if (d.recipMode === "upload" && d.saveTo === "__new" && state.groups.some(g => g.name.toLowerCase() === d.newGroupName.toLowerCase())) { setErr("w-newgroup", "A group with this name already exists."); ok = false; }
      else if (!d.consent) { err.textContent = "Confirm that recipients have agreed to receive calls."; ok = false; }
      else if (d.consentBasis.length < 5) { setErr("w-basis", "Describe how recipients agreed (at least 5 characters)."); err.textContent = ""; ok = false; }
      else { err.textContent = ""; setErr("w-basis", ""); }
    }
    if (step === 3) {
      const s = d.schedule;
      const start = startISO(s);
      const future = !!start && new Date(start) > new Date();
      setErr("w-date", s.date ? "" : "Choose a start date.");
      setErr("w-time", !s.time ? "Choose a start time." : (start && !future ? "The start time must be in the future." : ""));
      const winOk = s.windowStart && s.windowEnd && s.windowStart < s.windowEnd;
      setErr("w-ws", winOk ? "" : "The window must start before it ends.");
      let untilOk = true;
      if (s.repeat !== "none") {
        untilOk = !!s.repeatUntil && s.repeatUntil > s.date;
        setErr("w-until", untilOk ? "" : "Choose an end date after the start date.");
      } else setErr("w-until", "");
      ok = future && winOk && untilOk;
    }
    if (!ok) { const first = view.querySelector('[aria-invalid="true"]'); if (first) first.focus(); }
    return ok;
  }

  function bindStep() {
    const form = document.getElementById("wizard-form");
    form.addEventListener("submit", e => {
      e.preventDefault();
      if (step < 4) { if (!validateStep()) return; step++; maxStep = Math.max(maxStep, step); renderNew(); }
      else finishDraft("scheduled");
    });
    document.getElementById("back").addEventListener("click", () => { collect(); step--; renderNew(); });
    document.getElementById("discard").addEventListener("click", () => {
      if (draft && draft.audioUrl) URL.revokeObjectURL(draft.audioUrl);
      draft = null; go("#/campaigns");
    });
    view.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => {
      const target = Number(b.dataset.step);
      if (target > step && !validateStep()) return;
      collect(); step = target; renderNew();
    }));
    view.querySelectorAll("[data-seg]").forEach(b => b.addEventListener("click", () => {
      collect();
      if (b.dataset.seg === "Message source") draft.msgType = b.dataset.value;
      if (b.dataset.seg === "Recipient source") draft.recipMode = b.dataset.value;
      renderNew();
    }));
    const sd = document.getElementById("save-draft");
    if (sd) sd.addEventListener("click", () => finishDraft("draft"));

    // Message step
    const audio = document.getElementById("w-audio");
    if (audio) { audio.addEventListener("change", () => handleAudio(audio.files[0])); dragStyle("audio-drop"); }
    const ar = document.getElementById("audio-remove");
    if (ar) ar.addEventListener("click", () => { collect(); if (draft.audioUrl) URL.revokeObjectURL(draft.audioUrl); draft.audio = null; draft.audioUrl = null; renderNew(); });
    const tts = document.getElementById("w-tts");
    if (tts) {
      const sample = draftRecipients(draft).list[0] || null;
      const update = () => {
        document.getElementById("tts-count").textContent = tts.value.length;
        document.getElementById("tts-secs").textContent = fmtDur(ttsSeconds(tts.value));
        document.getElementById("tts-preview-text").textContent = personalize(tts.value, sample);
      };
      tts.addEventListener("input", update);
      view.querySelectorAll("[data-insert]").forEach(b => b.addEventListener("click", () => {
        const ins = b.dataset.insert, s = tts.selectionStart, e = tts.selectionEnd;
        if (tts.value.length + ins.length > LIMITS.ttsChars) return;
        tts.value = tts.value.slice(0, s) + ins + tts.value.slice(e);
        tts.focus(); tts.selectionStart = tts.selectionEnd = s + ins.length; update();
      }));
      document.getElementById("w-tpl").addEventListener("change", e => {
        const tp = allTemplates().find(x => x.id === e.target.value);
        if (tp && (!tts.value.trim() || window.confirm("Replace the current text with this template?"))) { tts.value = tp.text; update(); }
      });
      document.getElementById("w-lang").addEventListener("change", () => { collect(); renderNew(); });
      document.getElementById("tts-play").addEventListener("click", () => {
        collect();
        if (!("speechSynthesis" in window)) { toast("This browser cannot play speech previews."); return; }
        if (draft.tts.lang !== "en") { toast("Browser preview is available for English only."); return; }
        const text = personalize(draft.tts.text, sample).trim();
        if (!text) { toast("Type a message first."); return; }
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "en-GB"; u.rate = 0.95;
        const voices = window.speechSynthesis.getVoices().filter(vc => /^en/i.test(vc.lang));
        const pick = voices.find(vc => draft.tts.voice === "male" ? /male|daniel|george|david/i.test(vc.name) && !/female/i.test(vc.name) : /female|samantha|serena|libby|zira/i.test(vc.name));
        if (pick) u.voice = pick;
        window.speechSynthesis.speak(u);
      });
    }

    // Recipients step
    view.querySelectorAll("[data-group]").forEach(cb => cb.addEventListener("change", () => {
      collect();
      const id = cb.dataset.group;
      draft.groupIds = cb.checked ? draft.groupIds.concat(id) : draft.groupIds.filter(g => g !== id);
      renderNew();
    }));
    const list = document.getElementById("w-list");
    if (list) {
      list.addEventListener("change", () => readContactFile(list.files[0], rows => {
        collect();
        draft.list = { name: list.files[0].name.slice(0, 120), size: list.files[0].size, uploadedAt: nowISO() };
        draft.uploadRows = rows.slice(0, LIMITS.contacts * 2);
        renderNew();
      }, msg => { document.getElementById("list-error").textContent = msg; }));
      dragStyle("list-drop");
    }
    const lr = document.getElementById("list-remove");
    if (lr) lr.addEventListener("click", () => { collect(); draft.list = null; draft.uploadRows = []; renderNew(); });
    const saveTo = document.getElementById("w-saveto");
    if (saveTo) saveTo.addEventListener("change", () => { collect(); renderNew(); });

    // Schedule step
    const rep = document.getElementById("w-repeat");
    if (rep) rep.addEventListener("change", () => { collect(); renderNew(); });

    // Review step
    const tc = document.getElementById("w-testcall");
    if (tc) tc.addEventListener("click", () => {
      const p = normPhone(document.getElementById("w-testphone").value);
      if (!p) { toast("Enter a valid phone number for the test call."); return; }
      draft.testCalls.unshift({ p, t: nowISO() });
      toast("Test call to " + mask(p) + " simulated. In production your phone would ring now.");
      renderNew();
    });
  }

  function dragStyle(id) {
    const z = document.getElementById(id);
    if (!z) return;
    ["dragenter", "dragover"].forEach(ev => z.addEventListener(ev, () => z.classList.add("is-drag")));
    ["dragleave", "drop"].forEach(ev => z.addEventListener(ev, () => z.classList.remove("is-drag")));
  }

  function handleAudio(file) {
    const err = document.getElementById("audio-error");
    if (!file) return;
    if (!AUDIO_EXT.test(file.name) || (file.type && AUDIO_TYPES.indexOf(file.type) === -1)) { err.textContent = "Only MP3 or WAV audio files are accepted."; return; }
    if (file.size > LIMITS.audioBytes) { err.textContent = "This file is larger than " + LIMITS.audioBytes / 1024 / 1024 + " MB."; return; }
    if (file.size === 0) { err.textContent = "This file is empty."; return; }
    file.slice(0, 12).arrayBuffer().then(buf => {
      const b = new Uint8Array(buf), txt = String.fromCharCode.apply(null, b);
      const isWav = txt.slice(0, 4) === "RIFF" && txt.slice(8, 12) === "WAVE";
      const isMp3 = txt.slice(0, 3) === "ID3" || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0);
      if (/\.wav$/i.test(file.name) ? !isWav : !isMp3) { err.textContent = "This file's content is not a valid " + (/\.wav$/i.test(file.name) ? "WAV" : "MP3") + " recording."; return; }
      readAudio(file, err);
    }, () => { err.textContent = "The file could not be read."; });
  }
  function readAudio(file, err) {
    const url = URL.createObjectURL(file);
    const el = new Audio();
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      if (!isFinite(el.duration) || el.duration <= 0) { URL.revokeObjectURL(url); err.textContent = "We could not read this audio file. Please export it again as MP3 or WAV."; return; }
      if (el.duration > LIMITS.audioSeconds) { URL.revokeObjectURL(url); err.textContent = "Messages can be up to " + LIMITS.audioSeconds / 60 + " minutes long."; return; }
      if (LIVE) {
        err.textContent = "Uploading…";
        Store.uploadAudio(file, el.duration).then(a => { collect(); (state.audioFiles = state.audioFiles || []).push(a); draft.audio = a; draft.audioUrl = url; renderNew(); },
          e => { URL.revokeObjectURL(url); err.textContent = "Upload failed. " + friendlyError(e); });
        return;
      }
      collect();
      draft.audio = { name: file.name.slice(0, 120), size: file.size, duration: Math.round(el.duration * 10) / 10, type: file.type || "audio" };
      draft.audioUrl = url;
      renderNew();
    };
    el.onerror = () => { URL.revokeObjectURL(url); err.textContent = "We could not read this audio file. Please export it again as MP3 or WAV."; };
    el.src = url;
  }

  function finishDraft(status) {
    const d = draft;
    if (status === "scheduled") {
      const start = startISO(d.schedule);
      if (!start || new Date(start) <= new Date()) { step = 3; renderNew(); validateStep(); toast("The start time is now in the past. Choose a new time."); return; }
    }
    // Connected mode calls groups only, so an uploaded list is always kept as a group.
    if (LIVE && d.recipMode === "upload" && !d.saveTo) {
      let base = ((d.name || "Campaign") + " — uploaded list").slice(0, LIMITS.groupName - 4), name = base, n = 2;
      while (state.groups.some(g => g.name.toLowerCase() === name.toLowerCase())) name = base + " (" + n++ + ")";
      d.saveTo = "__new"; d.newGroupName = name;
    }
    const before = JSON.stringify(state);
    // Save uploaded contacts to a group first, so the campaign can reference it.
    let savedGroup = null;
    if (d.recipMode === "upload" && d.saveTo) {
      if (d.saveTo === "__new") {
        savedGroup = { id: uid(), name: d.newGroupName.slice(0, LIMITS.groupName), description: "Created from " + (d.list ? d.list.name : "upload"), createdAt: nowISO() };
        state.groups.push(savedGroup);
      } else savedGroup = findGroup(d.saveTo);
      if (savedGroup) importContacts(d.uploadRows, savedGroup.id);
    }
    const r = draftRecipients(d);
    const groupIds = d.recipMode === "groups" ? d.groupIds.slice() : (savedGroup ? [savedGroup.id] : []);
    const c = {
      id: d.id, name: d.name, type: d.type, sender: d.sender, callerId: d.callerId, description: d.description,
      createdAt: d.createdAt || nowISO(), status,
      message: d.msgType === "tts"
        ? { type: "tts", text: d.tts.text, lang: d.tts.lang, voice: d.tts.voice, seconds: ttsSeconds(d.tts.text) }
        : { type: "audio" },
      audio: d.msgType === "audio" ? d.audio : null,
      recipients: { mode: d.recipMode, groupIds, file: d.list ? d.list.name : null, invalid: r.invalid, duplicates: r.duplicates, optedOut: r.optedOut },
      list: d.list ? Object.assign({ rows: d.uploadRows.length, invalid: r.invalid, duplicates: r.duplicates, optedOut: r.optedOut }, d.list) : null,
      contacts: LIVE ? [] : r.list.map(x => ({ p: x.p, fn: x.fn || "", ln: x.ln || "", company: x.company || "" })),
      consentBasis: d.consentBasis, runNumber: d.runNumber || 1, timezone: d.timezone,
      live: LIVE ? (d.live || { runs: {}, current: null }) : undefined,
      schedule: Object.assign({}, d.schedule, { start: startISO(d.schedule) }),
      compliance: { consent: d.consent, senderIdentified: d.audioChecks.sender, optoutIncluded: d.audioChecks.optout, confirmedAt: nowISO(), basis: d.consentBasis },
      results: {}, events: (d.events || []).slice(), history: d.history || [], testCalls: d.testCalls.slice(0, 10)
    };
    if (!d.createdAt) logEvent(c, "Campaign created");
    if (savedGroup) logEvent(c, "Contacts saved to group “" + savedGroup.name + "”");
    d.testCalls.forEach(t => logEvent(c, "Test call to " + mask(t.p) + " (simulated)"));
    if (status === "scheduled") logEvent(c, "Scheduled for " + fmtDate(c.schedule.start));
    const idx = state.campaigns.findIndex(x => x.id === c.id);
    if (idx > -1) state.campaigns[idx] = c; else state.campaigns.push(c);
    if (!LIVE && !save()) { state = JSON.parse(before); return; }
    if (LIVE) save();
    if (d.audioUrl) URL.revokeObjectURL(d.audioUrl);
    draft = null;
    toast(status === "draft" ? "Draft saved." : "Campaign scheduled.");
    go("#/campaign/" + c.id);
  }

  /* Campaign detail ------------------------------------------------------- */
  function nextRun(c) {
    const s = c.schedule;
    if (!s || !s.repeat || s.repeat === "none" || !s.start) return null;
    const d = new Date(s.start), until = new Date(s.repeatUntil + "T23:59:59"), now = new Date();
    const runs = (c.history || []).length + (c.status === "completed" ? 1 : 0);
    for (let i = 0; i < runs; i++) {
      if (s.repeat === "daily") d.setDate(d.getDate() + 1);
      if (s.repeat === "weekly") d.setDate(d.getDate() + 7);
      if (s.repeat === "monthly") d.setMonth(d.getMonth() + 1);
    }
    if (runs === 0 && d > now) return d;
    return d <= until ? d : null;
  }

  function renderDetail(id) {
    const c = findCampaign(id);
    if (!c) { view.innerHTML = `<div class="box">${emptyState("Campaign not found", "It may have been deleted.", `<a class="btn btn-secondary" href="#/campaigns">Back to campaigns</a>`)}</div>`; return; }
    document.title = c.name + " — BalVoice";
    const k = counts(c);
    const next = nextRun(c);
    const actions = {
      draft: `<button class="btn btn-secondary" data-act="delete">Delete</button><button class="btn btn-primary" data-act="edit">Continue setup</button>`,
      scheduled: `<button class="btn btn-secondary" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="start">${LIVE ? "Start now" : "Start now (simulate)"}</button>`,
      running: `<button class="btn btn-secondary" data-act="pause">Pause</button>`,
      paused: `<button class="btn btn-secondary" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="resume">Resume</button>`,
      completed: `${next && !LIVE ? `<button class="btn btn-secondary" data-act="rerun">Run next occurrence (simulate)</button>` : ""}<button class="btn btn-primary" data-act="export">Export report (CSV)</button>`,
      cancelled: k.done ? `<button class="btn btn-secondary" data-act="export">Export report (CSV)</button>` : ""
    }[c.status];
    const caller = c.callerId ? state.callerIds.find(x => x.id === c.callerId) : null;
    const groupNames = (c.recipients && c.recipients.groupIds || []).map(g => findGroup(g)).filter(Boolean);
    const isTTS = c.message && c.message.type === "tts";

    view.innerHTML = `
      <div class="view-head">
        <div><div class="view-crumb"><a href="#/campaigns">Campaigns</a> / ${esc(c.name)}</div>
          <h1>${esc(c.name)}</h1><p>${statusTag(c.status)} &nbsp;${esc(TYPES[c.type] || "")} · ${esc(c.sender)}</p></div>
        <div class="head-actions">${actions}</div>
      </div>
      ${c.status === "draft" ? `<p class="notice mb-16">This campaign is a draft and will not be delivered until it is scheduled.</p>` : ""}
      ${c.status === "completed" && next && !LIVE ? `<p class="notice mb-16">This campaign repeats ${esc(REPEAT[c.schedule.repeat].toLowerCase())}. Next occurrence: <strong>${esc(fmtDate(next.toISOString()))}</strong>.</p>` : ""}
      <div class="detail-grid">
        <div>
          <section class="box" aria-labelledby="del-h">
            <div class="box-head"><div><h2 id="del-h">Delivery${LIVE && c.runNumber > 1 ? " — run " + c.runNumber : ""}</h2><p>${k.done ? (LIVE ? "Results from the delivery system" : "Simulated results") : k.estimate && k.total ? "About " + num(k.total) + " contacts in the selected groups. Results appear once delivery starts" : "Results appear here once delivery starts"}</p></div>
              <span class="mono small muted" id="del-count">${num(k.done)} / ${num(k.total)}</span></div>
            <div class="box-body" id="delivery">${deliveryHTML(c, k)}</div>
          </section>
          <section class="box" aria-labelledby="res-h">
            <div class="box-head"><div><h2 id="res-h">Call results</h2><p>Final outcome for each number</p></div></div>
            <div class="box-body">
              <div class="toolbar">
                <label class="sr-only" for="f-q">Search phone or name</label>
                <input class="input" id="f-q" type="search" placeholder="Search phone or name" value="${esc(filter.q)}">
                <label class="sr-only" for="f-o">Filter by outcome</label>
                <select class="select" id="f-o"><option value="">All outcomes</option>${Object.entries(OUTCOMES).map(([v, o]) => `<option value="${v}" ${filter.outcome === v ? "selected" : ""}>${o.label}</option>`).join("")}<option value="pending" ${filter.outcome === "pending" ? "selected" : ""}>Not yet called</option>${LIVE ? `<option value="skipped" ${filter.outcome === "skipped" ? "selected" : ""}>Skipped (opt-out)</option>` : ""}</select>
                ${k.done && k.total > k.answered ? `<button class="btn btn-secondary" type="button" data-act="unreached">Save unreached contacts as group</button>` : ""}
              </div>
            </div>
            <div class="table-wrap" id="results">${resultsHTML(c)}</div>
          </section>
          ${(c.history || []).length ? `
          <section class="box" aria-labelledby="hist-h">
            <div class="box-head"><h2 id="hist-h">Previous runs</h2></div>
            <div class="table-wrap"><table class="tbl"><thead><tr><th scope="col">Run</th><th scope="col">Completed</th><th scope="col" class="num">Contacts</th><th scope="col" class="num">Answered</th></tr></thead>
            <tbody>${c.history.map((h, i) => `<tr><td>#${i + 1}</td><td>${esc(fmtDate(h.at))}</td><td class="num">${num(h.total)}</td><td class="num">${num(h.answered)} (${pct(h.answered, h.total)}%)</td></tr>`).join("")}</tbody></table></div>
          </section>` : ""}
        </div>
        <div>
          <section class="box" aria-labelledby="msg-h">
            <div class="box-head"><h2 id="msg-h">Message</h2></div>
            <div class="box-body">
              ${isTTS ? `<p class="small muted mb-8">Text-to-speech · ${esc(LANGS[c.message.lang])} · ${esc(VOICES[c.message.voice].toLowerCase())} · about ${fmtDur(c.message.seconds)}</p><p class="tts-quote">${esc(c.message.text)}</p>`
                : `<p class="mb-0">${esc(c.audio ? c.audio.name : "—")} <span class="small muted mono">${c.audio ? fmtDur(c.audio.duration) : ""}</span></p>`}
            </div>
          </section>
          <section class="box" aria-labelledby="det-h">
            <div class="box-head"><h2 id="det-h">Details</h2></div>
            <div class="box-body"><dl class="kv">
              <div><dt>Scheduled start</dt><dd>${esc(fmtDate(c.schedule && c.schedule.start))}</dd></div>
              <div><dt>Repeat</dt><dd>${esc(REPEAT[c.schedule.repeat || "none"])}${c.schedule.repeat && c.schedule.repeat !== "none" ? "<br><span class='small muted'>until " + esc(fmtDate(c.schedule.repeatUntil + "T23:59", false)) + "</span>" : ""}</dd></div>
              <div><dt>Calling window</dt><dd>${esc(c.schedule.windowStart)} – ${esc(c.schedule.windowEnd)}</dd></div>
              <div><dt>Retries</dt><dd>${c.schedule.retries === "0" ? "None" : esc(c.schedule.retries) + " × " + esc(c.schedule.interval) + " min"}</dd></div>
              <div><dt>Caller ID</dt><dd>${caller ? esc(caller.value) : "Platform number"}</dd></div>
              <div><dt>Recipients</dt><dd>${num(k.total)} contacts<br><span class="small muted">${groupNames.length ? groupNames.map(g => `<a href="#/group/${esc(g.id)}">${esc(g.name)}</a>`).join(", ") : esc(c.list ? c.list.name : "")}</span></dd></div>
              <div><dt>Created</dt><dd>${esc(fmtDate(c.createdAt))}</dd></div>
            </dl></div>
          </section>
          <section class="box" aria-labelledby="comp-h">
            <div class="box-head"><h2 id="comp-h">Compliance</h2></div>
            <div class="box-body"><dl class="kv">
              <div><dt>Recipient consent</dt><dd>${c.compliance.consent ? tagHTML("tag-answered", "Confirmed") : tagHTML("tag-failed", "Missing")}</dd></div>
              <div><dt>Sender identified</dt><dd>${c.compliance.senderIdentified ? tagHTML("tag-answered", "Yes") : tagHTML("tag-failed", "No")}</dd></div>
              <div><dt>Opt-out included</dt><dd>${c.compliance.optoutIncluded ? tagHTML("tag-answered", "Yes") : tagHTML("tag-failed", "No")}</dd></div>
              <div><dt>How recipients agreed</dt><dd>${esc(c.consentBasis || c.compliance.basis || "—")}</dd></div>
              <div><dt>Confirmed</dt><dd>${esc(fmtDate(c.compliance.confirmedAt))}${LIVE && c.compliance.confirmedBy ? "<br><span class='small muted'>by " + esc(staffName(c.compliance.confirmedBy)) + "</span>" : ""}</dd></div>
            </dl></div>
          </section>
          <section class="box" aria-labelledby="act-h">
            <div class="box-head"><h2 id="act-h">Activity</h2></div>
            <div class="box-body"><ul class="events" id="events">${eventsHTML(c)}</ul></div>
          </section>
        </div>
      </div>`;

    view.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => act(c, b.dataset.act)));
    let qTimer = null;
    document.getElementById("f-q").addEventListener("input", e => {
      filter.q = e.target.value;
      if (LIVE) { clearTimeout(qTimer); qTimer = setTimeout(() => loadLiveResults(c), 300); }
      else document.getElementById("results").innerHTML = resultsHTML(c);
    });
    document.getElementById("f-o").addEventListener("change", e => { filter.outcome = e.target.value; if (LIVE) loadLiveResults(c); else document.getElementById("results").innerHTML = resultsHTML(c); });
    if (LIVE) {
      loadLiveResults(c);
      // Follow delivery while it is running or about to start.
      if (c.status === "running" || (c.status === "scheduled" && c.schedule.start && new Date(c.schedule.start) - Date.now() < 10 * 60 * 1000)) {
        timers.poll = setInterval(() => {
          if (location.hash !== "#/campaign/" + c.id) { clearInterval(timers.poll); return; }
          const was = c.status;
          Store.refresh(c).then(() => { if (c.status !== was) { clearInterval(timers.poll); renderDetail(c.id); applyWidths(view); } else refreshDetail(c); }, () => {});
        }, 5000);
      }
    }
  }

  function deliveryHTML(c, k) {
    const total = k.total || 1;
    const b = billing(c, k);
    return `
      <div class="outcome-bar" role="img" aria-label="Outcome distribution">
        ${Object.entries(OUTCOMES).map(([o, d]) => `<span data-w="${(k[o] / total) * 100}" data-color="${d.color}"></span>`).join("")}
      </div>
      <table class="tbl">
        <caption class="sr-only">Outcome totals</caption>
        <thead><tr><th scope="col">Outcome</th><th scope="col" class="num">Contacts</th><th scope="col" class="num">Share</th></tr></thead>
        <tbody>
          ${Object.entries(OUTCOMES).map(([o, d]) => `<tr><td>${tagHTML(d.tag, d.label)}</td><td class="num">${num(k[o])}</td><td class="num">${pct(k[o], k.total)}%</td></tr>`).join("")}
          <tr><td class="muted">Not yet called</td><td class="num">${num(k.total - k.done)}</td><td class="num">${pct(k.total - k.done, k.total)}%</td></tr>
        </tbody>
      </table>
      <dl class="kv kv-inline mt-16">
        <div><dt>Total call attempts</dt><dd class="mono">${num(k.attempts)}</dd></div>
        <div><dt>Billable minutes ${state.settings.answeredOnly ? "(answered calls)" : "(all attempts)"}</dt><dd class="mono">${num(Math.round(b.minutes * 100) / 100)}</dd></div>
        <div><dt>Estimated airtime cost</dt><dd class="mono">${b.cost === null ? '<a href="#/settings">Set rate</a>' : money(b.cost)}</dd></div>
      </dl>
      ${c.status === "running" ? `<div class="progress-line"><span data-w="${pct(k.done, k.total)}"></span></div>` : ""}`;
  }

  function liveRowsHTML(res) {
    if (!res.rows.length) return `<p class="small muted box-pad">No contacts match.</p>`;
    return `<table class="tbl">
      <caption class="sr-only">Call results</caption>
      <thead><tr><th scope="col">Phone</th><th scope="col">Name</th><th scope="col">Outcome</th><th scope="col" class="num">Attempts</th><th scope="col">Last attempt</th></tr></thead>
      <tbody>${res.rows.map(x => `<tr><td class="mono">${esc(x.p)}</td><td>${esc(fullName(x) || "—")}</td>
        <td>${x.status === "skipped" ? tagHTML("tag-noanswer", "Skipped — opt-out") : x.o ? tagHTML(OUTCOMES[x.o].tag, OUTCOMES[x.o].label) + (x.simulated ? ' <span class="small muted">simulated</span>' : "") : `<span class="muted small">${x.status === "dialing" ? "Calling…" : x.a ? "Retry pending" : "Not yet called"}</span>`}</td>
        <td class="num">${x.a || "—"}</td><td class="small muted">${x.t ? esc(fmtDate(x.t)) : "—"}</td></tr>`).join("")}</tbody></table>
      ${res.count > res.rows.length ? `<p class="small muted box-pad-y">Showing ${res.rows.length} of ${num(res.count)}. Export the report to see all rows.</p>` : ""}`;
  }
  function loadLiveResults(c) {
    const el = document.getElementById("results");
    if (!el) return;
    if (!c.live || !c.live.current) { el.innerHTML = `<p class="small muted box-pad">Per-number results appear once delivery starts.</p>`; return; }
    Store.results(c, { outcome: filter.outcome, q: filter.q, limit: 25 }).then(res => {
      const now = document.getElementById("results");
      if (now && location.hash === "#/campaign/" + c.id) now.innerHTML = liveRowsHTML(res);
    }, e => { el.innerHTML = `<p class="small muted box-pad">Results could not be loaded. ${esc(friendlyError(e))}</p>`; });
  }
  function resultsHTML(c) {
    if (c.live) return `<p class="small muted box-pad">Loading results…</p>`;
    const q = filter.q.trim().toLowerCase();
    const rows = c.contacts.filter(x => {
      const r = c.results[x.p];
      if (filter.outcome === "pending" && r) return false;
      if (filter.outcome && filter.outcome !== "pending" && (!r || r.o !== filter.outcome)) return false;
      if (q && x.p.indexOf(q) === -1 && fullName(x).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    const shown = rows.slice(0, 25);
    if (!rows.length) return `<p class="small muted box-pad">No contacts match.</p>`;
    return `<table class="tbl">
      <caption class="sr-only">Call results</caption>
      <thead><tr><th scope="col">Phone</th><th scope="col">Name</th><th scope="col">Outcome</th><th scope="col" class="num">Attempts</th><th scope="col">Last attempt</th></tr></thead>
      <tbody>${shown.map(x => {
        const r = c.results[x.p];
        return `<tr><td class="mono">${esc(x.p)}</td><td>${esc(fullName(x) || "—")}</td>
          <td>${r ? tagHTML(OUTCOMES[r.o].tag, OUTCOMES[r.o].label) : '<span class="muted small">Not yet called</span>'}</td>
          <td class="num">${r ? r.a : "—"}</td><td class="small muted">${r ? esc(fmtDate(r.t)) : "—"}</td></tr>`;
      }).join("")}</tbody></table>
      ${rows.length > shown.length ? `<p class="small muted box-pad-y">Showing 25 of ${num(rows.length)}. Export the report to see all rows.</p>` : ""}`;
  }

  function eventsHTML(c) {
    return (c.events || []).slice(0, 12).map(e => `<li><div>${esc(e.msg)}<time datetime="${esc(e.t)}">${esc(fmtDate(e.t))}</time></div></li>`).join("");
  }

  function refreshDetail(c) {
    if (location.hash !== "#/campaign/" + c.id) return;
    const del = document.getElementById("delivery");
    if (!del) return;
    const k = counts(c);
    del.innerHTML = deliveryHTML(c, k);
    applyWidths(del);
    document.getElementById("del-count").textContent = num(k.done) + " / " + num(k.total);
    if (LIVE) loadLiveResults(c); else document.getElementById("results").innerHTML = resultsHTML(c);
    document.getElementById("events").innerHTML = eventsHTML(c);
  }

  /* Refresh a campaign's recipients from its groups (used for repeating runs). */
  function refreshFromGroups(c) {
    const ids = new Set((c.recipients && c.recipients.mode === "groups" && c.recipients.groupIds) || []);
    if (!ids.size) return;
    const opt = optoutSet();
    c.contacts = state.contacts.filter(x => x.groups.some(g => ids.has(g)) && !opt.has(key(x.p)))
      .map(x => ({ p: x.p, fn: x.fn, ln: x.ln, company: x.company }));
  }

  function act(c, what) {
    const redraw = () => { renderDetail(c.id); applyWidths(view); };
    if (LIVE && (what === "start" || what === "resume")) {
      if (what === "start" && !window.confirm("Start delivery now? Calls begin within about a minute, inside the calling window.")) return;
      (what === "start" ? Store.startNow(c.id) : Store.resume(c.id)).then(() => Store.refresh(c)).then(() => {
        toast(what === "start" ? "Delivery will begin within a minute." : "Delivery resumed."); redraw();
      }, e => toast("Could not " + what + ": " + friendlyError(e)));
      return;
    }
    if (LIVE && what === "export") {
      toast("Preparing the report…");
      Store.results(c, { all: true }).then(res => {
        downloadCSV(c.name + "-run-" + c.runNumber + "-report.csv", ["phone", "first_name", "last_name", "outcome", "attempts", "duration_sec", "last_attempt", "simulated"],
          res.rows.map(x => [x.p, x.fn, x.ln, x.status === "skipped" ? "Skipped (opt-out)" : x.o ? OUTCOMES[x.o].label : "Not called", x.a, x.d == null ? "" : x.d, x.t || "", x.simulated ? "yes" : ""]));
        toast("Report downloaded.");
      }, e => toast("Could not export: " + friendlyError(e)));
      return;
    }
    if (LIVE && what === "unreached") {
      const name = window.prompt("Name for the new group of contacts who were not reached:", (c.name + " — not reached").slice(0, LIMITS.groupName));
      if (!name || !name.trim()) return;
      if (state.groups.some(g => g.name.toLowerCase() === name.trim().toLowerCase())) { toast("A group with this name already exists."); return; }
      Store.results(c, { all: true }).then(res => {
        const g = { id: uid(), name: name.trim().slice(0, LIMITS.groupName), description: "Not reached in “" + c.name + "”", createdAt: nowISO() };
        state.groups.push(g);
        const r2 = importContacts(res.rows.filter(x => x.status === "done" && x.o !== "answered").map(x => ({ raw: x.p, fn: x.fn, ln: x.ln })), g.id);
        logEvent(c, "Unreached contacts saved to group “" + g.name + "”");
        save(); toast(num(r2.added + r2.updated) + " contacts saved to “" + g.name + "”."); redraw();
      }, e => toast("Could not load results: " + friendlyError(e)));
      return;
    }
    if (what === "start" || what === "resume") {
      if (what === "start") refreshFromGroups(c);
      const opt = optoutSet(), before = c.contacts.length;
      c.contacts = c.contacts.filter(x => !opt.has(key(x.p)) || c.results[x.p]);
      if (c.contacts.length < before) logEvent(c, num(before - c.contacts.length) + " contacts removed (on opt-out register)");
      c.status = "running";
      logEvent(c, what === "start" ? "Delivery started" : "Delivery resumed");
      save(); runSim(c); redraw(); return;
    }
    if (what === "rerun") {
      const k = counts(c);
      c.history = c.history || [];
      c.history.push({ at: nowISO(), total: k.total, answered: k.answered });
      c.results = {};
      refreshFromGroups(c);
      c.status = "running";
      logEvent(c, "Occurrence " + (c.history.length + 1) + " started");
      save(); runSim(c); redraw(); return;
    }
    if (what === "pause") { stopSim(c.id); c.status = "paused"; logEvent(c, "Delivery paused"); save(); redraw(); return; }
    if (what === "cancel") {
      if (!window.confirm("Cancel this campaign? Contacts not yet called will not be called.")) return;
      stopSim(c.id); c.status = "cancelled"; logEvent(c, "Campaign cancelled"); save(); redraw(); return;
    }
    if (what === "delete") {
      if (!window.confirm("Delete this draft? This cannot be undone.")) return;
      state.campaigns = state.campaigns.filter(x => x.id !== c.id); save(); toast("Draft deleted."); go("#/campaigns"); return;
    }
    if (what === "edit") {
      const isTTS = c.message && c.message.type === "tts";
      draft = Object.assign(newDraft(), {
        id: c.id, name: c.name, type: c.type, sender: c.sender, callerId: c.callerId || "", description: c.description || "",
        msgType: isTTS ? "tts" : "audio", audio: c.audio,
        tts: isTTS ? { text: c.message.text, lang: c.message.lang, voice: c.message.voice, templateId: "" } : newDraft().tts,
        audioChecks: { sender: !!c.compliance.senderIdentified, optout: !!c.compliance.optoutIncluded },
        recipMode: c.recipients && c.recipients.mode === "groups" ? "groups" : "upload",
        groupIds: (c.recipients && c.recipients.groupIds) || [],
        list: c.list, uploadRows: c.contacts.map(x => ({ raw: x.p, fn: x.fn, ln: x.ln, company: x.company })),
        consent: !!c.compliance.consent, consentBasis: c.consentBasis || c.compliance.basis || "", schedule: Object.assign({}, c.schedule),
        runNumber: c.runNumber, timezone: c.timezone, live: c.live,
        createdAt: c.createdAt, events: c.events, history: c.history
      });
      step = 3; maxStep = 4; go("#/new"); return;
    }
    if (what === "unreached") {
      const name = window.prompt("Name for the new group of contacts who were not reached:", (c.name + " — not reached").slice(0, LIMITS.groupName));
      if (!name || !name.trim()) return;
      if (state.groups.some(g => g.name.toLowerCase() === name.trim().toLowerCase())) { toast("A group with this name already exists."); return; }
      const g = { id: uid(), name: name.trim().slice(0, LIMITS.groupName), description: "Not reached in “" + c.name + "”", createdAt: nowISO() };
      state.groups.push(g);
      const rows = c.contacts.filter(x => { const r = c.results[x.p]; return r && r.o !== "answered"; }).map(x => ({ raw: x.p, fn: x.fn, ln: x.ln, company: x.company }));
      const res = importContacts(rows, g.id);
      logEvent(c, "Unreached contacts saved to group “" + g.name + "”");
      save(); toast(num(res.added + res.updated) + " contacts saved to “" + g.name + "”."); redraw(); return;
    }
    if (what === "export") {
      downloadCSV(c.name + "-report.csv", ["phone", "first_name", "last_name", "outcome", "attempts", "last_attempt"],
        c.contacts.map(x => { const r = c.results[x.p]; return [x.p, x.fn, x.ln, r ? OUTCOMES[r.o].label : "Not called", r ? r.a : 0, r ? r.t : ""]; }));
      toast("Report downloaded.");
    }
  }

  /* Delivery simulation (prototype only) ---------------------------------- */
  function pickOutcome() {
    const r = Math.random();
    return r < 0.58 ? "answered" : r < 0.70 ? "busy" : r < 0.88 ? "noanswer" : "unreachable";
  }
  function runSim(c) {
    stopSim(c.id);
    const pending = c.contacts.filter(x => !c.results[x.p]);
    const batch = Math.max(1, Math.ceil(c.contacts.length / 50));
    const maxAttempts = Number(c.schedule.retries) + 1;
    timers[c.id] = setInterval(() => {
      for (let i = 0; i < batch && pending.length; i++) {
        const x = pending.shift();
        let o, a = 0;
        do { o = pickOutcome(); a++; } while (o !== "answered" && a < maxAttempts);
        c.results[x.p] = { o, a, t: nowISO() };
      }
      if (!pending.length) {
        stopSim(c.id);
        c.status = "completed";
        const k = counts(c);
        logEvent(c, "Delivery completed — " + num(k.answered) + " answered of " + num(k.total));
        if (state.settings.webhook) logEvent(c, "Status webhook would be sent to " + state.settings.webhook);
        save();
        if (location.hash === "#/campaign/" + c.id) { renderDetail(c.id); applyWidths(view); }
        toast("“" + c.name + "” completed.");
        return;
      }
      refreshDetail(c);
    }, 120);
  }
  function stopSim(id) { if (timers[id]) { clearInterval(timers[id]); delete timers[id]; save(); } }

  /* Reports --------------------------------------------------------------- */
  function renderReports() {
    document.title = "Delivery reports — BalVoice";
    const cs = state.campaigns.filter(c => c.live ? !!c.live.current : Object.keys(c.results || {}).length);
    view.innerHTML = `
      <div class="view-head"><div><h1>Delivery reports</h1><p>Outcome totals for campaigns that have started delivery.</p></div></div>
      <div class="box">${cs.length ? `<div class="table-wrap"><table class="tbl">
        <thead><tr><th scope="col">Campaign</th><th scope="col">Status</th><th scope="col" class="num">Contacts</th>
          ${Object.values(OUTCOMES).map(o => `<th scope="col" class="num">${o.label}</th>`).join("")}<th scope="col" class="num">Billable min</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${cs.map(c => { const k = counts(c); return `<tr>
          <td><a href="#/campaign/${esc(c.id)}">${esc(c.name)}</a></td><td>${statusTag(c.status)}</td><td class="num">${num(k.total)}</td>
          ${Object.keys(OUTCOMES).map(o => `<td class="num">${num(k[o])}</td>`).join("")}
          <td class="num">${num(Math.round(billing(c, k).minutes * 10) / 10)}</td>
          <td class="num"><button class="btn btn-quiet" data-export="${esc(c.id)}">Export</button></td></tr>`; }).join("")}</tbody></table></div>`
      : emptyState("No reports yet", "Reports appear once a campaign starts delivering.", `<a class="btn btn-secondary" href="#/campaigns">View campaigns</a>`)}</div>
      ${LIVE ? `<section class="box" aria-labelledby="cost-h"><div class="box-head"><div><h2 id="cost-h">Airtime by month</h2><p>Answered calls and billable minutes for this client, priced with the rate in Settings. Use it for invoicing.</p></div></div><div id="monthly"><p class="small muted box-pad">Loading…</p></div></section>` : ""}`;
    if (LIVE) Store.monthlyCosts().then(rows => {
      const el = document.getElementById("monthly"); if (!el) return;
      const r = parseFloat(state.settings.rate), hasRate = state.settings.rate !== "" && isFinite(r);
      el.innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th scope="col">Month</th><th scope="col" class="num">Runs</th><th scope="col" class="num">Answered calls</th><th scope="col" class="num">Billable minutes</th><th scope="col" class="num">Airtime</th></tr></thead>
        <tbody>${rows.map(m => `<tr><td>${esc(new Date(m.month + "T12:00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" }))}</td><td class="num">${num(m.runs)}</td><td class="num">${num(m.answered_calls)}</td><td class="num">${num(Number(m.billable_minutes))}</td><td class="num">${hasRate ? money(Number(m.billable_minutes) * r) : '<a href="#/settings">Set rate</a>'}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="small muted box-pad">No calls yet.</p>`;
    }, () => { const el = document.getElementById("monthly"); if (el) el.innerHTML = `<p class="small muted box-pad">Could not load costs.</p>`; });
    view.querySelectorAll("[data-export]").forEach(b => b.addEventListener("click", () => act(findCampaign(b.dataset.export), "export")));
  }

  /* Contact groups -------------------------------------------------------- */
  function renderGroups() {
    document.title = "Contact groups — BalVoice";
    const gs = state.groups.slice().sort((a, b) => a.name.localeCompare(b.name));
    const ungrouped = state.contacts.filter(c => !c.groups.length).length;
    view.innerHTML = `
      <div class="view-head">
        <div><h1>Contact groups</h1><p>Organise your phonebook into groups, then send campaigns to one or more groups at once.</p></div>
        <button class="btn btn-primary" type="button" id="g-new-toggle" aria-expanded="false" aria-controls="g-new">New group</button>
      </div>
      <form class="box inline-form" id="g-new" hidden novalidate>
        <div class="box-body">
          <div class="form-row">
            <div class="field"><label for="g-name">Group name</label><input class="input" id="g-name" maxlength="${LIMITS.groupName}" placeholder="e.g. Youth ministry"><span class="field-error"></span></div>
            <div class="field"><label for="g-desc">Description <span class="optional">(optional)</span></label><input class="input" id="g-desc" maxlength="120"></div>
          </div>
        </div>
        <div class="box-foot"><span class="small muted">You can import contacts after creating the group.</span><div class="head-actions"><button class="btn btn-secondary" type="button" id="g-cancel">Cancel</button><button class="btn btn-primary" type="submit">Create group</button></div></div>
      </form>
      <div class="box">
        ${gs.length ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th scope="col">Group</th><th scope="col" class="num">Contacts</th><th scope="col" class="num">Can be called</th><th scope="col">Created</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${gs.map(g => {
            const opt = optoutSet();
            const members = state.contacts.filter(c => c.groups.indexOf(g.id) > -1);
            const callable = members.filter(c => !opt.has(key(c.p))).length;
            return `<tr>
              <td><a href="#/group/${esc(g.id)}">${esc(g.name)}</a>${g.description ? `<div class="small muted">${esc(g.description)}</div>` : ""}</td>
              <td class="num">${num(members.length)}</td><td class="num">${num(callable)}</td>
              <td class="small muted">${esc(fmtDate(g.createdAt, false))}</td>
              <td class="num"><a class="btn btn-quiet" href="#/new?group=${esc(g.id)}">Send campaign</a></td></tr>`;
          }).join("")}</tbody></table></div>`
        : emptyState("No groups yet", "Groups let you reach the right audience — members, a branch, volunteers, or a ward — without uploading a list each time.", `<button class="btn btn-primary" type="button" id="g-empty-new">Create your first group</button>`)}
      </div>
      <p class="small muted mt-24">${num(state.contacts.length)} contacts in your phonebook${ungrouped ? ", " + num(ungrouped) + " not in any group" : ""}. <a href="#/contacts">View all contacts</a></p>`;

    const form = document.getElementById("g-new"), toggle = document.getElementById("g-new-toggle");
    const open = state => { form.hidden = !state; toggle.setAttribute("aria-expanded", String(state)); if (state) document.getElementById("g-name").focus(); };
    toggle.addEventListener("click", () => open(form.hidden));
    const empty = document.getElementById("g-empty-new"); if (empty) empty.addEventListener("click", () => open(true));
    document.getElementById("g-cancel").addEventListener("click", () => open(false));
    form.addEventListener("submit", e => {
      e.preventDefault();
      const name = document.getElementById("g-name").value.trim();
      if (name.length < 2) { setErr("g-name", "Enter a group name of at least 2 characters."); return; }
      if (state.groups.some(g => g.name.toLowerCase() === name.toLowerCase())) { setErr("g-name", "A group with this name already exists."); return; }
      const g = { id: uid(), name, description: document.getElementById("g-desc").value.trim(), createdAt: nowISO() };
      state.groups.push(g);
      if (save()) { toast("Group created. Now add contacts."); go("#/group/" + g.id); }
    });
  }

  function renderGroup(id) {
    const g = findGroup(id);
    if (!g) { view.innerHTML = `<div class="box">${emptyState("Group not found", "It may have been deleted.", `<a class="btn btn-secondary" href="#/groups">Back to groups</a>`)}</div>`; return; }
    document.title = g.name + " — BalVoice";
    const opt = optoutSet();
    const members = state.contacts.filter(c => c.groups.indexOf(id) > -1);
    const q = contactQuery.q.trim().toLowerCase();
    const rows = members.filter(c => !q || c.p.indexOf(q) > -1 || fullName(c).toLowerCase().indexOf(q) > -1 || (c.company || "").toLowerCase().indexOf(q) > -1);
    selected = new Set([...selected].filter(cid => members.some(m => m.id === cid)));
    const others = state.groups.filter(x => x.id !== id);
    const missingNames = members.filter(c => !c.fn).length;

    view.innerHTML = `
      <div class="view-head">
        <div><div class="view-crumb"><a href="#/groups">Contact groups</a> / ${esc(g.name)}</div>
          <h1>${esc(g.name)}</h1><p>${num(members.length)} contacts${g.description ? " · " + esc(g.description) : ""}</p></div>
        <div class="head-actions">
          <button class="btn btn-secondary" type="button" id="g-export" ${members.length ? "" : "disabled"}>Export CSV</button>
          <button class="btn btn-secondary" type="button" id="g-edit-toggle" aria-expanded="false" aria-controls="g-edit">Edit group</button>
          <a class="btn btn-primary" href="#/new?group=${esc(g.id)}">Send campaign</a>
        </div>
      </div>

      <form class="box inline-form" id="g-edit" hidden novalidate>
        <div class="box-body"><div class="form-row">
          <div class="field"><label for="ge-name">Group name</label><input class="input" id="ge-name" maxlength="${LIMITS.groupName}" value="${esc(g.name)}"><span class="field-error"></span></div>
          <div class="field"><label for="ge-desc">Description</label><input class="input" id="ge-desc" maxlength="120" value="${esc(g.description || "")}"></div>
        </div></div>
        <div class="box-foot"><button class="btn btn-quiet danger" type="button" id="g-delete">Delete group</button><div class="head-actions"><button class="btn btn-primary" type="submit">Save changes</button></div></div>
      </form>

      <div class="detail-grid group-grid">
        <div>
          <section class="box" aria-labelledby="mem-h">
            <div class="box-head"><div><h2 id="mem-h">Contacts</h2><p>${missingNames ? num(missingNames) + " without a first name — personalised messages will use the fallback." : "Everyone in this group can be personalised by first name."}</p></div></div>
            <div class="box-body">
              <div class="toolbar">
                <label class="sr-only" for="gm-q">Search contacts</label>
                <input class="input" id="gm-q" type="search" placeholder="Search name, phone, company" value="${esc(contactQuery.q)}">
              </div>
              <div class="bulk-bar" id="bulk" ${selected.size ? "" : "hidden"}>
                <span><strong id="bulk-n">${selected.size}</strong> selected</span>
                ${others.length ? `<label class="sr-only" for="bulk-target">Target group</label>
                  <select class="select" id="bulk-target">${others.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join("")}</select>
                  <button class="btn btn-secondary" type="button" data-bulk="copy">Copy to group</button>
                  <button class="btn btn-secondary" type="button" data-bulk="move">Move to group</button>` : ""}
                <button class="btn btn-secondary" type="button" data-bulk="remove">Remove from group</button>
              </div>
            </div>
            ${rows.length ? `<div class="table-wrap"><table class="tbl">
              <thead><tr>
                <th scope="col" class="cb"><input type="checkbox" id="sel-all" aria-label="Select all shown contacts" ${rows.length && rows.slice(0, listLimit).every(c => selected.has(c.id)) ? "checked" : ""}></th>
                <th scope="col">Phone</th><th scope="col">Name</th><th scope="col">Company</th><th scope="col">Status</th></tr></thead>
              <tbody>${rows.slice(0, listLimit).map(c => `<tr>
                <td class="cb"><input type="checkbox" data-sel="${esc(c.id)}" aria-label="Select ${esc(fullName(c) || c.p)}" ${selected.has(c.id) ? "checked" : ""}></td>
                <td class="mono">${esc(c.p)}</td><td>${esc(fullName(c) || "—")}</td><td>${esc(c.company || "—")}</td>
                <td>${opt.has(key(c.p)) ? tagHTML("tag-failed", "Opted out") : tagHTML("tag-answered", "Active")}</td></tr>`).join("")}</tbody></table></div>
              ${rows.length > listLimit ? `<div class="box-pad-y"><button class="btn btn-secondary" type="button" id="more">Show more (${num(rows.length - listLimit)} remaining)</button></div>` : ""}`
            : `<p class="small muted box-pad">${members.length ? "No contacts match your search." : "This group is empty. Add contacts one at a time or import an Excel or CSV file."}</p>`}
          </section>
        </div>
        <div>
          <section class="box" aria-labelledby="add-h">
            <div class="box-head"><h2 id="add-h">Add a contact</h2></div>
            <form class="box-body form" id="add-form" novalidate>
              <div class="field"><label for="a-phone">Phone number</label><input class="input" id="a-phone" type="tel" maxlength="20" autocomplete="off"><span class="field-error"></span></div>
              <div class="form-row">
                <div class="field"><label for="a-fn">First name</label><input class="input" id="a-fn" maxlength="40" autocomplete="off"></div>
                <div class="field"><label for="a-ln">Last name</label><input class="input" id="a-ln" maxlength="40" autocomplete="off"></div>
              </div>
              <div class="field"><label for="a-co">Company or church <span class="optional">(optional)</span></label><input class="input" id="a-co" maxlength="80" autocomplete="off"></div>
              <div class="field"><label for="a-em">Email <span class="optional">(optional)</span></label><input class="input" id="a-em" type="email" maxlength="120" autocomplete="off"><span class="field-error"></span></div>
              <button class="btn btn-primary" type="submit">Add to group</button>
            </form>
          </section>
          <section class="box" aria-labelledby="imp-h">
            <div class="box-head"><h2 id="imp-h">Import contacts</h2></div>
            <div class="box-body form">
              <div class="dropzone" id="imp-drop">
                <input type="file" id="imp-file" accept="${LIST_ACCEPT}" aria-describedby="imp-help">
                <strong>Upload Excel or CSV</strong>
                <span id="imp-help">.xlsx or .csv with a <strong>phone</strong> column and optionally <strong>name</strong> (or first_name and last_name), company, email. The first sheet is used. Existing contacts are matched by phone number.</span>
              </div>
              <p class="small muted mb-0" id="imp-result" role="status"></p>
              <div class="head-actions"><a class="btn btn-quiet" href="assets/samples/contacts-sample.xlsx" download>Sample Excel file</a><button class="btn btn-quiet" type="button" id="imp-sample">Sample CSV</button></div>
            </div>
          </section>
        </div>
      </div>`;

    // Edit / delete group
    const ef = document.getElementById("g-edit"), et = document.getElementById("g-edit-toggle");
    et.addEventListener("click", () => { ef.hidden = !ef.hidden; et.setAttribute("aria-expanded", String(!ef.hidden)); });
    ef.addEventListener("submit", e => {
      e.preventDefault();
      const name = document.getElementById("ge-name").value.trim();
      if (name.length < 2) { setErr("ge-name", "Enter a group name of at least 2 characters."); return; }
      if (state.groups.some(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) { setErr("ge-name", "A group with this name already exists."); return; }
      g.name = name; g.description = document.getElementById("ge-desc").value.trim();
      save(); toast("Group updated."); renderGroup(id);
    });
    document.getElementById("g-delete").addEventListener("click", () => {
      if (!window.confirm("Delete the group “" + g.name + "”? Contacts stay in your phonebook and in any other groups.")) return;
      state.contacts.forEach(c => { c.groups = c.groups.filter(x => x !== id); });
      state.groups = state.groups.filter(x => x.id !== id);
      save(); toast("Group deleted."); go("#/groups");
    });
    document.getElementById("g-export").addEventListener("click", () => {
      downloadCSV(g.name + "-contacts.csv", ["phone", "first_name", "last_name", "company", "email"], members.map(c => [c.p, c.fn, c.ln, c.company, c.email]));
    });

    // Search, selection, bulk actions
    const qEl = document.getElementById("gm-q");
    qEl.addEventListener("input", () => {
      contactQuery.q = qEl.value; listLimit = 50; renderGroup(id);
      const again = document.getElementById("gm-q"); again.focus(); again.selectionStart = again.selectionEnd = again.value.length;
    });
    const sync = () => { const b = document.getElementById("bulk"); b.hidden = !selected.size; document.getElementById("bulk-n").textContent = selected.size; };
    view.querySelectorAll("[data-sel]").forEach(cb => cb.addEventListener("change", () => { if (cb.checked) selected.add(cb.dataset.sel); else selected.delete(cb.dataset.sel); sync(); }));
    const all = document.getElementById("sel-all");
    if (all) all.addEventListener("change", () => {
      rows.slice(0, listLimit).forEach(c => { if (all.checked) selected.add(c.id); else selected.delete(c.id); });
      view.querySelectorAll("[data-sel]").forEach(cb => { cb.checked = all.checked; }); sync();
    });
    view.querySelectorAll("[data-bulk]").forEach(b => b.addEventListener("click", () => {
      const what = b.dataset.bulk, target = document.getElementById("bulk-target");
      const tid = target ? target.value : null;
      const chosen = state.contacts.filter(c => selected.has(c.id));
      if (what === "remove" && !window.confirm("Remove " + chosen.length + " contacts from this group? They stay in your phonebook.")) return;
      chosen.forEach(c => {
        if ((what === "copy" || what === "move") && c.groups.indexOf(tid) === -1) c.groups.push(tid);
        if (what === "move" || what === "remove") c.groups = c.groups.filter(x => x !== id);
      });
      const tname = tid ? (findGroup(tid) || {}).name : "";
      selected.clear(); save();
      toast(what === "copy" ? chosen.length + " contacts copied to “" + tname + "”." : what === "move" ? chosen.length + " contacts moved to “" + tname + "”." : chosen.length + " contacts removed from group.");
      renderGroup(id);
    }));
    const more = document.getElementById("more");
    if (more) more.addEventListener("click", () => { listLimit += 50; renderGroup(id); });

    // Add one contact
    document.getElementById("add-form").addEventListener("submit", e => {
      e.preventDefault();
      const p = normPhone(document.getElementById("a-phone").value);
      const em = document.getElementById("a-em").value.trim();
      setErr("a-phone", p ? "" : "Enter a valid phone number (9 to 15 digits).");
      const emOk = !em || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em);
      setErr("a-em", emOk ? "" : "Enter a valid email address or leave it blank.");
      if (!p || !emOk) return;
      const res = importContacts([{ raw: p, fn: document.getElementById("a-fn").value.trim(), ln: document.getElementById("a-ln").value.trim(), company: document.getElementById("a-co").value.trim(), email: em }], id);
      if (res.overLimit) { toast("The limit of " + num(LIMITS.contacts) + " contacts per client was reached."); return; }
      save();
      toast(res.added ? "Contact added." : "This number was already in your contacts. It has been added to the group.");
      renderGroup(id);
      document.getElementById("a-phone").focus();
    });

    // Import CSV
    const file = document.getElementById("imp-file");
    dragStyle("imp-drop");
    file.addEventListener("change", () => readContactFile(file.files[0], rows2 => {
      const res = importContacts(rows2, id);
      save();
      renderGroup(id);
      const summary = importSummary(res);
      document.getElementById("imp-result").textContent = "Import complete: " + summary + (/\.$/.test(summary) ? "" : ".");
    }, msg => { document.getElementById("imp-result").textContent = msg; }));
    document.getElementById("imp-sample").addEventListener("click", () => {
      downloadCSV("contacts-sample.csv", ["name", "phone"], [["First Last", "+233200000000"]]);
    });
  }

  /* All contacts (phonebook) ---------------------------------------------- */
  function renderContacts() {
    document.title = "All contacts — BalVoice";
    const opt = optoutSet();
    const q = contactQuery.q.trim().toLowerCase();
    const gf = contactQuery.group;
    const rows = state.contacts.filter(c =>
      (!gf || (gf === "__none" ? !c.groups.length : c.groups.indexOf(gf) > -1)) &&
      (!q || c.p.indexOf(q) > -1 || fullName(c).toLowerCase().indexOf(q) > -1 || (c.company || "").toLowerCase().indexOf(q) > -1));
    const gname = id => (findGroup(id) || {}).name;
    view.innerHTML = `
      <div class="view-head">
        <div><h1>All contacts</h1><p>Your phonebook. Each contact can belong to any number of groups.</p></div>
        <div class="head-actions"><button class="btn btn-secondary" type="button" id="c-export" ${state.contacts.length ? "" : "disabled"}>Export CSV</button><a class="btn btn-primary" href="#/groups">Manage groups</a></div>
      </div>
      <div class="box">
        <div class="box-body">
          <div class="toolbar">
            <label class="sr-only" for="c-q">Search contacts</label>
            <input class="input" id="c-q" type="search" placeholder="Search name, phone, company" value="${esc(contactQuery.q)}">
            <label class="sr-only" for="c-g">Filter by group</label>
            <select class="select" id="c-g"><option value="">All groups</option><option value="__none" ${gf === "__none" ? "selected" : ""}>Not in any group</option>
              ${state.groups.map(g => `<option value="${esc(g.id)}" ${gf === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>
            <span class="small muted">${num(rows.length)} of ${num(state.contacts.length)}</span>
          </div>
        </div>
        ${rows.length ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th scope="col">Phone</th><th scope="col">Name</th><th scope="col">Company</th><th scope="col">Groups</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${rows.slice(0, listLimit).map(c => `<tr>
            <td class="mono">${esc(c.p)}</td><td>${esc(fullName(c) || "—")}</td><td>${esc(c.company || "—")}</td>
            <td>${c.groups.length ? c.groups.map(g => `<a class="chip" href="#/group/${esc(g)}">${esc(gname(g) || "?")}</a>`).join(" ") : '<span class="muted small">None</span>'}</td>
            <td>${opt.has(key(c.p)) ? tagHTML("tag-failed", "Opted out") : tagHTML("tag-answered", "Active")}</td>
            <td class="num"><button class="btn btn-quiet" data-del="${esc(c.id)}">Delete</button></td></tr>`).join("")}</tbody></table></div>
          ${rows.length > listLimit ? `<div class="box-pad-y"><button class="btn btn-secondary" type="button" id="more">Show more (${num(rows.length - listLimit)} remaining)</button></div>` : ""}`
        : `<p class="small muted box-pad">${state.contacts.length ? "No contacts match." : "No contacts yet. Create a group and import contacts into it."}</p>`}
      </div>`;
    const qEl = document.getElementById("c-q");
    qEl.addEventListener("input", () => { contactQuery.q = qEl.value; listLimit = 50; renderContacts(); const a = document.getElementById("c-q"); a.focus(); a.selectionStart = a.selectionEnd = a.value.length; });
    document.getElementById("c-g").addEventListener("change", e => { contactQuery.group = e.target.value; listLimit = 50; renderContacts(); });
    document.getElementById("c-export").addEventListener("click", () => downloadCSV("all-contacts.csv", ["phone", "first_name", "last_name", "company", "email", "groups"],
      state.contacts.map(c => [c.p, c.fn, c.ln, c.company, c.email, c.groups.map(gname).filter(Boolean).join("; ")])));
    view.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
      if (!window.confirm("Delete this contact from your phonebook and all groups?")) return;
      state.contacts = state.contacts.filter(c => c.id !== b.dataset.del); save(); renderContacts();
    }));
    const more = document.getElementById("more");
    if (more) more.addEventListener("click", () => { listLimit += 50; renderContacts(); });
  }

  /* Message templates ----------------------------------------------------- */
  let editingTemplate = null;
  function renderTemplates() {
    document.title = "Message templates — BalVoice";
    const t = editingTemplate;
    view.innerHTML = `
      <div class="view-head"><div><h1>Message templates</h1><p>Reusable scripts for text-to-speech campaigns. Personal fields are filled in for each contact.</p></div>
        <button class="btn btn-primary" type="button" id="t-new">New template</button></div>
      ${t ? `
      <form class="box inline-form" id="t-form" novalidate>
        <div class="box-head"><h2>${t.id ? "Edit template" : "New template"}</h2></div>
        <div class="box-body form">
          <div class="form-row">
            <div class="field"><label for="t-name">Name</label><input class="input" id="t-name" maxlength="60" value="${esc(t.name || "")}"><span class="field-error"></span></div>
            <div class="field"><label for="t-cat">Category</label><input class="input" id="t-cat" maxlength="30" value="${esc(t.category || "")}" placeholder="e.g. Church, Reminders"></div>
          </div>
          <div class="field"><label for="t-text">Message text</label>
            <div class="insert-bar"><span class="small muted">Insert:</span>${FIELDS.map(([f, l]) => `<button type="button" class="chip-btn" data-insert="{${f}}">${l}</button>`).join("")}</div>
            <textarea class="textarea textarea-lg" id="t-text" maxlength="${LIMITS.ttsChars}">${esc(t.text || "")}</textarea><span class="field-error"></span>
            <span class="hint">Include who the message is from and how to opt out.</span></div>
        </div>
        <div class="box-foot"><span></span><div class="head-actions"><button class="btn btn-secondary" type="button" id="t-cancel">Cancel</button><button class="btn btn-primary" type="submit">Save template</button></div></div>
      </form>` : ""}
      <div class="box">
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th scope="col">Template</th><th scope="col">Category</th><th scope="col">Preview</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${allTemplates().map(tp => `<tr>
            <td><strong>${esc(tp.name)}</strong>${tp.starter ? ' <span class="tag tag-noanswer">Starter</span>' : ""}</td>
            <td>${esc(tp.category || "—")}</td>
            <td class="small muted clip">${esc(tp.text)}</td>
            <td class="num nowrap">${tp.starter ? `<button class="btn btn-quiet" data-copy="${esc(tp.id)}">Copy &amp; edit</button>`
              : `<button class="btn btn-quiet" data-edit="${esc(tp.id)}">Edit</button><button class="btn btn-quiet" data-tdel="${esc(tp.id)}">Delete</button>`}</td></tr>`).join("")}</tbody>
        </table></div>
      </div>`;
    document.getElementById("t-new").addEventListener("click", () => { editingTemplate = { name: "", category: "", text: "" }; renderTemplates(); document.getElementById("t-name").focus(); });
    view.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => { const s = STARTER_TEMPLATES.find(x => x.id === b.dataset.copy); editingTemplate = { name: s.name + " (copy)", category: s.category, text: s.text }; renderTemplates(); }));
    view.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => { editingTemplate = Object.assign({}, state.templates.find(x => x.id === b.dataset.edit)); renderTemplates(); }));
    view.querySelectorAll("[data-tdel]").forEach(b => b.addEventListener("click", () => {
      if (!window.confirm("Delete this template?")) return;
      state.templates = state.templates.filter(x => x.id !== b.dataset.tdel); save(); renderTemplates();
    }));
    const form = document.getElementById("t-form");
    if (form) {
      const ta = document.getElementById("t-text");
      view.querySelectorAll("[data-insert]").forEach(b => b.addEventListener("click", () => {
        const s = ta.selectionStart; ta.value = ta.value.slice(0, s) + b.dataset.insert + ta.value.slice(ta.selectionEnd); ta.focus();
      }));
      document.getElementById("t-cancel").addEventListener("click", () => { editingTemplate = null; renderTemplates(); });
      form.addEventListener("submit", e => {
        e.preventDefault();
        const name = document.getElementById("t-name").value.trim(), text = ta.value.trim();
        setErr("t-name", name.length >= 2 ? "" : "Enter a template name.");
        setErr("t-text", text.length >= 10 ? "" : "Enter the message text (at least 10 characters).");
        if (name.length < 2 || text.length < 10) return;
        const rec = { id: editingTemplate.id || uid(), name, category: document.getElementById("t-cat").value.trim(), text, updatedAt: nowISO() };
        const i = state.templates.findIndex(x => x.id === rec.id);
        if (i > -1) state.templates[i] = rec; else state.templates.push(rec);
        editingTemplate = null; save(); toast("Template saved."); renderTemplates();
      });
    }
  }

  /* Caller IDs ------------------------------------------------------------ */
  function renderCallerIds() {
    document.title = "Caller IDs — BalVoice";
    view.innerHTML = `
      <div class="view-head"><div><h1>Caller IDs</h1><p>The name or number recipients see when this client's campaigns call. New caller IDs are reviewed before use.</p></div></div>
      <div class="box">
        <form class="box-body form" id="cid-form" novalidate>
          <div class="form-row">
            <div class="field"><label for="cid-type">Type</label>
              <select class="select" id="cid-type"><option value="brand">Brand name</option><option value="number">Phone number</option></select></div>
            <div class="field"><label for="cid-value">Caller ID</label><input class="input" id="cid-value" maxlength="20" placeholder="e.g. GRACECHAPEL"><span class="field-error"></span>
              <span class="hint" id="cid-hint">Brand names: 3–11 letters or numbers, no spaces.</span></div>
          </div>
          <div class="field"><label for="cid-reason">Purpose <span class="optional">(helps the review)</span></label><input class="input" id="cid-reason" maxlength="160" placeholder="e.g. Weekly announcements to church members"></div>
          <div><button class="btn btn-primary" type="submit">Request caller ID</button></div>
        </form>
        ${state.callerIds.length ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th scope="col">Caller ID</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Requested</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${state.callerIds.map(c => `<tr>
            <td class="mono">${esc(c.value)}</td><td>${c.type === "brand" ? "Brand name" : "Phone number"}</td>
            <td>${c.status === "approved" ? tagHTML("tag-answered", "Approved") : c.status === "rejected" ? tagHTML("tag-failed", "Rejected") : tagHTML("tag-busy", "Under review")}</td>
            <td class="small muted">${esc(fmtDate(c.createdAt))}</td>
            <td class="num nowrap">${c.status === "pending" && isAdmin() ? `<button class="btn btn-quiet" data-cid-approve="${esc(c.id)}">Approve${LIVE ? "" : " (demo)"}</button><button class="btn btn-quiet" data-cid-reject="${esc(c.id)}">Reject</button>` : ""}<button class="btn btn-quiet" data-cid-del="${esc(c.id)}">Remove</button></td></tr>`).join("")}</tbody></table></div>`
        : `<p class="small muted box-pad">No caller IDs yet. Campaigns use the platform number until one is approved.</p>`}
      </div>
      <p class="small muted mt-24">${isAdmin() ? "Approve a caller ID only after the client has shown they own the name or number." : "An administrator approves caller IDs after checking the client owns the name or number."} Network rules on which caller IDs display can vary.</p>`;
    const type = document.getElementById("cid-type");
    type.addEventListener("change", () => {
      document.getElementById("cid-hint").textContent = type.value === "brand" ? "Brand names: 3–11 letters or numbers, no spaces." : "A phone number you own, with country code.";
      document.getElementById("cid-value").placeholder = type.value === "brand" ? "e.g. GRACECHAPEL" : "e.g. +233...";
    });
    document.getElementById("cid-form").addEventListener("submit", e => {
      e.preventDefault();
      const raw = document.getElementById("cid-value").value.trim();
      let value = null;
      if (type.value === "brand") value = /^[A-Za-z0-9]{3,11}$/.test(raw) ? raw.toUpperCase() : null;
      else value = normPhone(raw);
      setErr("cid-value", value ? "" : (type.value === "brand" ? "Use 3 to 11 letters or numbers, no spaces." : "Enter a valid phone number."));
      if (!value) return;
      if (state.callerIds.some(c => c.value === value)) { setErr("cid-value", "This caller ID has already been requested."); return; }
      state.callerIds.push({ id: uid(), type: type.value, value, purpose: document.getElementById("cid-reason").value.trim(), status: "pending", createdAt: nowISO() });
      save(); toast("Caller ID submitted for review."); renderCallerIds();
    });
    view.querySelectorAll("[data-cid-approve]").forEach(b => b.addEventListener("click", () => {
      const c = state.callerIds.find(x => x.id === b.dataset.cidApprove); c.status = "approved"; c.reviewedAt = nowISO(); save(); renderCallerIds();
    }));
    view.querySelectorAll("[data-cid-reject]").forEach(b => b.addEventListener("click", () => {
      const c = state.callerIds.find(x => x.id === b.dataset.cidReject); c.status = "rejected"; c.reviewedAt = nowISO(); save(); renderCallerIds();
    }));
    view.querySelectorAll("[data-cid-del]").forEach(b => b.addEventListener("click", () => {
      if (!window.confirm("Remove this caller ID? Scheduled campaigns using it will fall back to the platform number.")) return;
      state.callerIds = state.callerIds.filter(x => x.id !== b.dataset.cidDel); save(); renderCallerIds();
    }));
  }

  /* Audio library --------------------------------------------------------- */
  function renderAudio() {
    document.title = "Audio files — BalVoice";
    if (LIVE) { renderAudioLive(); return; }
    const cs = state.campaigns.filter(c => c.audio);
    view.innerHTML = `
      <div class="view-head"><div><h1>Audio files</h1><p>Recorded messages used in your campaigns.</p></div></div>
      <div class="box">${cs.length ? `<div class="table-wrap"><table class="tbl">
        <thead><tr><th scope="col">File</th><th scope="col">Campaign</th><th scope="col" class="num">Duration</th><th scope="col" class="num">Size</th></tr></thead>
        <tbody>${cs.map(c => `<tr><td>${esc(c.audio.name)}</td><td><a href="#/campaign/${esc(c.id)}">${esc(c.name)}</a></td>
          <td class="num">${fmtDur(c.audio.duration)}</td><td class="num">${fmtBytes(c.audio.size)}</td></tr>`).join("")}</tbody></table></div>`
      : emptyState("No audio files", "Audio is uploaded as part of creating a campaign. Text-to-speech campaigns don't need a file.", `<a class="btn btn-primary" href="#/new">Create campaign</a>`)}</div>
      <p class="small muted mt-24">In this prototype only file details are kept; the audio itself is not stored.</p>`;
  }

  function renderAudioLive() {
    const files = (state.audioFiles || []).slice().reverse();
    const usedBy = id => state.campaigns.filter(c => c.audio && c.audio.id === id);
    view.innerHTML = `
      <div class="view-head"><div><h1>Audio files</h1><p>Recordings uploaded for this client, stored privately. Upload new recordings in the campaign wizard.</p></div></div>
      <div class="box">${files.length ? `<div class="table-wrap"><table class="tbl">
        <thead><tr><th scope="col">File</th><th scope="col">Used by</th><th scope="col" class="num">Duration</th><th scope="col" class="num">Size</th><th scope="col">Uploaded</th><th scope="col"><span class="sr-only">Play</span></th></tr></thead>
        <tbody>${files.map(a => `<tr><td>${esc(a.name)}</td><td>${usedBy(a.id).map(c => `<a href="#/campaign/${esc(c.id)}">${esc(c.name)}</a>`).join(", ") || '<span class="muted small">Not used</span>'}</td>
          <td class="num">${fmtDur(a.duration)}</td><td class="num">${fmtBytes(a.size)}</td><td class="small muted">${esc(fmtDate(a.createdAt))}</td>
          <td class="num"><button class="btn btn-quiet" data-play="${esc(a.id)}">Play</button></td></tr>`).join("")}</tbody></table></div>`
      : emptyState("No audio files", "Audio is uploaded as part of creating a campaign. Text-to-speech campaigns don't need a file.", `<a class="btn btn-primary" href="#/new">Create campaign</a>`)}</div>
      <audio id="audio-player" controls hidden></audio>`;
    view.querySelectorAll("[data-play]").forEach(b => b.addEventListener("click", () => {
      Store.audioUrl(b.dataset.play).then(url => { const pl = document.getElementById("audio-player"); pl.hidden = false; pl.src = url; pl.play().catch(() => {}); },
        e => toast("Could not play: " + friendlyError(e)));
    }));
  }

  /* Opt-out register ------------------------------------------------------ */
  function renderOptouts() {
    document.title = "Opt-out register — BalVoice";
    const list = state.optouts.slice().sort((a, b) => b.t.localeCompare(a.t));
    view.innerHTML = `
      <div class="view-head"><div><h1>Opt-out register</h1><p>Numbers here are never called. They stay in groups but are skipped when a list is uploaded and again just before each call.${LIVE ? " Numbers listed for all clients come from the website form or were added by staff." : ""}</p></div></div>
      <div class="box">
        <div class="box-body">
          <form class="toolbar" id="optout-form" novalidate>
            <label class="sr-only" for="o-phone">Phone number</label>
            <input class="input" id="o-phone" type="tel" maxlength="20" placeholder="Phone number" autocomplete="off">
            ${LIVE ? `<label class="sr-only" for="o-scope">Applies to</label><select class="select" id="o-scope"><option value="client">This client only</option><option value="all">All clients</option></select>` : ""}
            <label class="sr-only" for="o-src">Source</label>
            <select class="select" id="o-src"><option>Recipient request</option><option>During call</option><option>Client instruction</option><option>Website request</option></select>
            <button class="btn btn-primary" type="submit">Add to register</button>
          </form>
          <p class="inline-error mt-16" id="o-err" role="alert"></p>
        </div>
        ${list.length ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th scope="col">Phone</th>${LIVE ? '<th scope="col">Applies to</th>' : ""}<th scope="col">Source</th><th scope="col">Added</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${list.map(o => `<tr><td class="mono">${esc(mask(o.p))}</td>${LIVE ? `<td>${o.scope === "all" ? "All clients" : "This client"}</td>` : ""}<td>${esc(o.s)}</td><td class="small muted">${esc(fmtDate(o.t))}</td>
            <td class="num">${isAdmin() ? `<button class="btn btn-quiet" data-remove="${esc((o.scope || "client") + "|" + o.p)}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="small muted box-pad">The register is empty.</p>`}
      </div>`;
    document.getElementById("optout-form").addEventListener("submit", e => {
      e.preventDefault();
      const input = document.getElementById("o-phone");
      const p = normPhone(input.value);
      const err = document.getElementById("o-err");
      if (!p) { err.textContent = "Enter a valid phone number (9 to 15 digits)."; input.focus(); return; }
      const scopeEl = document.getElementById("o-scope"), scope = scopeEl ? scopeEl.value : "client";
      if (state.optouts.some(o => (o.scope || "client") === scope && key(o.p) === key(p))) { err.textContent = "This number is already on the register."; return; }
      state.optouts.push({ p, s: document.getElementById("o-src").value, t: nowISO(), scope });
      save(); toast("Number added to the opt-out register."); renderOptouts();
    });
    view.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", () => {
      if (!window.confirm("Remove this number from the opt-out register? It may be called in future campaigns.")) return;
      state.optouts = state.optouts.filter(o => (o.scope || "client") + "|" + o.p !== b.dataset.remove); save(); renderOptouts();
    }));
  }

  /* Settings & API -------------------------------------------------------- */
  function renderSettings() {
    document.title = "Settings — BalVoice";
    const s = state.settings;
    view.innerHTML = `
      <div class="view-head"><div><h1>Settings</h1><p>Airtime rate and billing rules${LIVE ? " for " + esc(clientName()) : ""}, used for cost estimates and the monthly airtime report.</p></div></div>
      <form class="box" id="bill-form" novalidate>
        <div class="box-head"><div><h2>Billing</h2><p>Used for cost estimates on campaigns and reports. Take these from your agreed rate card.</p></div></div>
        <div class="box-body form">
          <div class="form-row">
            <div class="field"><label for="s-rate">Airtime rate per minute</label><input class="input" id="s-rate" type="number" min="0" step="0.0001" value="${esc(s.rate)}" placeholder="From your quote"><span class="field-error"></span></div>
            <div class="field"><label for="s-cur">Currency</label>
              <select class="select" id="s-cur">${["GHS", "USD", "NGN", "EUR", "GBP"].map(c => `<option ${s.currency === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
          </div>
          <div class="form-row">
            <div class="field"><label for="s-billing">Billing increment</label>
              <select class="select" id="s-billing"><option value="second" ${s.billing === "second" ? "selected" : ""}>Per second</option><option value="minute" ${s.billing === "minute" ? "selected" : ""}>Per minute (rounded up)</option></select></div>
            ${LIVE ? `<input type="hidden" id="s-answered" value="1">` : `<div class="field"><label for="s-answered">Calls that are billed</label>
              <select class="select" id="s-answered"><option value="1" ${s.answeredOnly ? "selected" : ""}>Answered calls only</option><option value="0" ${s.answeredOnly ? "" : "selected"}>Every attempt</option></select></div>`}
          </div>
        </div>
        <div class="box-foot"><span></span><button class="btn btn-primary" type="submit">Save billing settings</button></div>
      </form>`;

    document.getElementById("bill-form").addEventListener("submit", e => {
      e.preventDefault();
      const rate = document.getElementById("s-rate").value.trim();
      if (rate !== "" && !(parseFloat(rate) >= 0)) { setErr("s-rate", "Enter a rate of 0 or more, or leave it blank."); return; }
      setErr("s-rate", "");
      Object.assign(s, { rate, currency: document.getElementById("s-cur").value, billing: document.getElementById("s-billing").value, answeredOnly: document.getElementById("s-answered").value === "1" });
      save(); toast("Billing settings saved.");
    });
  }

  /* Clients (connected mode) --------------------------------------------- */
  const clientName = () => ((clients.find(c => c.id === currentClient) || {}).name || "");
  let staffCache = null;
  function staffName(id) {
    if (!staffCache) { staffCache = []; Store.staff().then(list => { staffCache = list; }, () => {}); }
    const s = staffCache.find(x => x.user_id === id);
    return s ? (s.name || s.email) : "a staff member";
  }

  function renderClients(editId) {
    document.title = "Clients — BalVoice";
    const editing = editId ? clients.find(c => c.id === editId) : null;
    const show = clients.slice().sort((a, b) => (!!a.archived_at - !!b.archived_at) || a.name.localeCompare(b.name));
    const canForm = isAdmin() || !!editing;
    // Load who is assigned to what before drawing, so the form is never redrawn while someone types.
    if (LIVE && isAdmin() && assignCache === null) {
      view.innerHTML = `<div class="box"><p class="small muted box-pad">Loading…</p></div>`;
      if (!assignLoading) assignLoading = Promise.all([loadAssignments(), Store.staff().then(l => { staffCache = l; }, () => {})]).finally(() => { assignLoading = null; });
      assignLoading.then(() => { if (!document.getElementById("client-form") && view.querySelector(".box-pad")) renderClients(editId); });
      return;
    }
    const staffFor = id => (assignCache || []).filter(a => a.workspace_id === id).map(a => staffName(a.user_id));
    view.innerHTML = `
      <div class="view-head"><div><h1>Clients</h1><p>${isAdmin()
        ? "The churches, campaign teams and organizations BalVoice runs campaigns for. Contacts, campaigns and settings are kept separately for each client. Assign clients to staff on the Team page."
        : "The clients assigned to you. An administrator adds clients and decides who works on them."}</p></div></div>
      ${!isAdmin() && !show.length ? `<div class="box">${emptyState("No clients assigned to you yet", "Ask an administrator to assign you to the clients you work on. They will appear here and in the client switcher.", "")}</div>` : ""}
      ${canForm ? `<form class="box" id="client-form" novalidate>
        <div class="box-head"><div><h2>${editing ? "Edit " + esc(editing.name) : "Add a client"}</h2></div></div>
        <div class="box-body form">
          <div class="form-row">
            <div class="field"><label for="cl-name">Client name</label><input class="input" id="cl-name" maxlength="120" value="${esc(editing ? editing.name : "")}"><span class="field-error"></span></div>
            <div class="field"><label for="cl-contact">Contact person <span class="optional">(optional)</span></label><input class="input" id="cl-contact" maxlength="80" value="${esc(editing ? editing.contact_name || "" : "")}"></div>
          </div>
          <div class="form-row">
            <div class="field"><label for="cl-phone">Phone <span class="optional">(optional)</span></label><input class="input" id="cl-phone" type="tel" maxlength="20" value="${esc(editing ? editing.contact_phone || "" : "")}"><span class="field-error"></span></div>
            <div class="field"><label for="cl-email">Email <span class="optional">(optional)</span></label><input class="input" id="cl-email" type="email" maxlength="160" value="${esc(editing ? editing.contact_email || "" : "")}"><span class="field-error"></span></div>
          </div>
          <div class="field"><label for="cl-notes">Notes <span class="optional">(optional)</span></label><textarea class="textarea" id="cl-notes" maxlength="1000">${esc(editing ? editing.notes || "" : "")}</textarea></div>
        </div>
        <div class="box-foot">${editing ? `<a class="btn btn-secondary" href="#/clients">Cancel</a>` : "<span></span>"}<button class="btn btn-primary" type="submit">${editing ? "Save client" : "Add client"}</button></div>
      </form>` : ""}
      ${show.length ? `<div class="box"><div class="table-wrap"><table class="tbl">
        <thead><tr><th scope="col">Client</th><th scope="col">Contact</th>${isAdmin() ? '<th scope="col">Staff assigned</th>' : ""}<th scope="col">Added</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${show.map(c => `<tr>
          <td>${esc(c.name)}${c.id === currentClient ? ' <span class="tag tag-answered">Open</span>' : ""}${c.archived_at ? ' <span class="tag tag-noanswer">Archived</span>' : ""}</td>
          <td class="small">${esc([c.contact_name, c.contact_phone, c.contact_email].filter(Boolean).join(" · ") || "—")}</td>
          ${isAdmin() ? `<td class="small">${esc(staffFor(c.id).join(", ")) || '<span class="muted">Admins only</span>'}</td>` : ""}
          <td class="small muted">${esc(fmtDate(c.created_at, false))}</td>
          <td class="num nowrap">${c.archived_at ? "" : `<button class="btn btn-quiet" data-open="${esc(c.id)}">Open</button>`}<button class="btn btn-quiet" data-edit="${esc(c.id)}">Edit</button>${isAdmin() ? `<button class="btn btn-quiet" data-archive="${esc(c.id)}">${c.archived_at ? "Restore" : "Archive"}</button>` : ""}</td></tr>`).join("")}</tbody></table></div>
      </div>` : isAdmin() ? `<div class="box"><p class="small muted box-pad">No clients yet. Add the first one above, or create one from a campaign request.</p></div>` : ""}`;
    const cf = document.getElementById("client-form");
    if (cf) cf.addEventListener("submit", e => {
      e.preventDefault();
      const name = document.getElementById("cl-name").value.trim(), phoneRaw = document.getElementById("cl-phone").value.trim(), email = document.getElementById("cl-email").value.trim();
      const phone = phoneRaw ? normPhone(phoneRaw) : "";
      setErr("cl-name", name.length >= 2 ? (clients.some(c => c.id !== editId && c.name.toLowerCase() === name.toLowerCase()) ? "A client with this name already exists." : "") : "Enter the client's name.");
      setErr("cl-phone", phone === null ? "Enter a valid phone number." : "");
      setErr("cl-email", !email || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? "" : "Enter a valid email address.");
      if (view.querySelector('#client-form [aria-invalid="true"]')) return;
      Store.saveClient({ id: editId, name, contact_name: document.getElementById("cl-contact").value.trim(), contact_phone: phone,
                         contact_email: email, notes: document.getElementById("cl-notes").value.trim(), archived_at: editing ? editing.archived_at : null })
        .then(row => {
          const i = clients.findIndex(c => c.id === row.id); if (i > -1) clients[i] = row; else clients.push(row);
          renderClientSwitch();
          toast(editing ? "Client saved." : "Client added.");
          if (!editing) switchClient(row.id); else go("#/clients");
        }, err => toast("Could not save the client: " + friendlyError(err)));
    });
    view.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => switchClient(b.dataset.open)));
    view.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => renderClients(b.dataset.edit)));
    view.querySelectorAll("[data-archive]").forEach(b => b.addEventListener("click", () => {
      const c = clients.find(x => x.id === b.dataset.archive);
      if (!c.archived_at && !window.confirm("Archive “" + c.name + "”? It is hidden from the client list; nothing is deleted.")) return;
      Store.saveClient(Object.assign({}, c, { archived_at: c.archived_at ? null : nowISO() })).then(row => {
        Object.assign(c, row); renderClientSwitch();
        if (row.archived_at && row.id === currentClient) { currentClient = null; state = defaults(); }
        renderClients();
      }, err => toast("Could not update the client: " + friendlyError(err)));
    }));
  }

  /* Campaign requests from the website ----------------------------------- */
  const REQ_STATUS = { new: "New", contacted: "Contacted", converted: "Became a client", declined: "Declined" };
  const SIZES = { "under-1000": "Under 1,000", "1000-10000": "1,000 – 10,000", "10000-50000": "10,000 – 50,000", "over-50000": "Over 50,000", unsure: "Not sure" };
  function renderRequests() {
    document.title = "Campaign requests — BalVoice";
    view.innerHTML = `<div class="view-head"><div><h1>Campaign requests</h1><p>Requests sent through the website form. Each one includes the requester's confirmation that recipients agreed to be called and that an opt-out will be included.</p></div></div>
      <div class="box" id="req-box"><p class="small muted box-pad">Loading…</p></div>`;
    Store.requests().then(rows => {
      const box = document.getElementById("req-box"); if (!box) return;
      box.innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl">
        <thead><tr><th scope="col">Received</th><th scope="col">Organization</th><th scope="col">Contact</th><th scope="col">Campaign</th><th scope="col">Status</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td class="small muted nowrap">${esc(fmtDate(r.created_at))}</td>
          <td><strong>${esc(r.organization)}</strong>${r.message ? `<div class="small muted">${esc(r.message.slice(0, 160))}${r.message.length > 160 ? "…" : ""}</div>` : ""}</td>
          <td class="small">${esc(r.contact_name)}<br><a href="mailto:${esc(r.email)}">${esc(r.email)}</a><br><span class="mono">${esc(r.phone)}</span></td>
          <td class="small">${esc(TYPES[r.campaign_type] || r.campaign_type)}<br>${esc(SIZES[r.list_size] || r.list_size)}${r.preferred_date ? "<br>From " + esc(fmtDate(r.preferred_date + "T12:00", false)) : ""}</td>
          <td><label class="sr-only" for="rq-${esc(r.id)}">Status</label><select class="select" id="rq-${esc(r.id)}" data-req="${esc(r.id)}">${Object.entries(REQ_STATUS).map(([v, l]) => `<option value="${v}" ${r.status === v ? "selected" : ""}>${l}</option>`).join("")}</select>
            ${r.handled_at ? `<div class="small muted">${esc(staffName(r.handled_by))}, ${esc(fmtDate(r.handled_at, false))}</div>` : ""}
            ${r.status !== "converted" ? `<button class="btn btn-quiet" data-make-client="${esc(r.id)}">Create client</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="small muted box-pad">No requests yet. They appear here when someone submits the form on the Contact page.</p>`;
      box.querySelectorAll("[data-req]").forEach(sel => sel.addEventListener("change", () => {
        Store.updateRequest(sel.dataset.req, { status: sel.value }).then(() => toast("Request updated."), err => toast("Could not update: " + friendlyError(err)));
      }));
      box.querySelectorAll("[data-make-client]").forEach(b => b.addEventListener("click", () => {
        const r = rows.find(x => x.id === b.dataset.makeClient);
        const existing = clients.find(c => c.name.toLowerCase() === r.organization.toLowerCase());
        const done = row => Store.updateRequest(r.id, { status: "converted", workspace_id: row.id }).then(() => switchClient(row.id));
        if (existing) { done(existing).catch(err => toast(friendlyError(err))); return; }
        Store.saveClient({ name: r.organization, contact_name: r.contact_name, contact_phone: r.phone, contact_email: r.email,
                           notes: [REQ_STATUS.new + " request " + fmtDate(r.created_at, false), r.message || ""].filter(Boolean).join("\n").slice(0, 1000) })
          .then(row => { clients.push(row); renderClientSwitch(); toast("Client created from the request."); return done(row); }, err => toast("Could not create the client: " + friendlyError(err)));
      }));
    }, err => { const box = document.getElementById("req-box"); if (box) box.innerHTML = `<p class="small muted box-pad">Could not load requests. ${esc(friendlyError(err))}</p>`; });
  }

  /* Team (admins) ------------------------------------------------------------ */
  let teamMode = "password", openAssign = null, assignCache = null, assignLoading = null;
  function loadAssignments() { return Store.assignments().then(rows => { assignCache = rows; return rows; }, () => { assignCache = []; return []; }); }
  const STAFF_ERRORS = { weak_password: "The password is too weak.", already_has_account: "This email already has an account.", last_admin: "There must always be at least one active administrator.",
    cannot_deactivate_self: "You can't deactivate your own account.", admins_only: "Only administrators can manage the team.", validation_failed: "Check the name, email and role." };
  function renderTeam() {
    document.title = "Team — BalVoice";
    view.innerHTML = `<div class="view-head"><div><h1>Team</h1><p>Staff who can sign in to the dashboard. Administrators manage the team, clients, caller ID approvals and opt-out removals; operators run campaigns.</p></div></div>
      <form class="box" id="invite-form" novalidate>
        <div class="box-head"><div><h2>Add a staff member</h2><p>Only administrators can add accounts. Nobody can sign up on their own.</p></div></div>
        <div class="box-body form">
          ${segmented("How to add", teamMode, [["password", "Set a temporary password"], ["invite", "Send an email invitation"]])}
          <div class="form-row">
            <div class="field"><label for="iv-name">Full name</label><input class="input" id="iv-name" maxlength="80" autocomplete="off"><span class="field-error"></span></div>
            <div class="field"><label for="iv-email">Email</label><input class="input" id="iv-email" type="email" maxlength="160" autocomplete="off"><span class="field-error"></span></div>
          </div>
          <div class="form-row">
            <div class="field"><label for="iv-role">Role</label><select class="select" id="iv-role"><option value="operator">Operator — works on assigned clients only</option><option value="admin">Administrator — all clients and settings</option></select></div>
            ${teamMode === "password" ? `<div class="field"><label for="iv-pass">Temporary password</label><input class="input mono" id="iv-pass" type="text" maxlength="72" autocomplete="off" spellcheck="false">
              <span class="hint">At least 10 characters with upper and lower case letters and a number. Give it to them privately; they can change it later with "Forgot password".</span><span class="field-error"></span>
              <button class="btn btn-quiet" type="button" id="iv-gen">Generate one</button></div>` : `<div class="field"><span class="field-label">Invitation</span><p class="small muted mb-0">They receive an email to choose their own password. Needs email (SMTP) set up in Supabase.</p></div>`}
          </div>
        </div>
        <div class="box-foot"><span></span><button class="btn btn-primary" type="submit">${teamMode === "password" ? "Create account" : "Send invitation"}</button></div>
      </form>
      <div class="box" id="team-box"><p class="small muted box-pad">Loading…</p></div>`;
    const draw = () => Promise.all([Store.staff(), loadAssignments()]).then(([list]) => {
      staffCache = list;
      const me = Store.user.id, box = document.getElementById("team-box"); if (!box) return;
      const active = clients.filter(c => !c.archived_at).sort((a, b) => a.name.localeCompare(b.name));
      const assigned = uidOf => assignCache.filter(a => a.user_id === uidOf).map(a => a.workspace_id);
      const nameOf = id => (clients.find(c => c.id === id) || {}).name || "";
      box.innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Clients</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${list.map(m => `<tr><td>${esc(m.name || "—")}${m.user_id === me ? ' <span class="small muted">(you)</span>' : ""}<div class="small muted">${esc(m.email)}</div></td>
          <td><label class="sr-only" for="sr-${esc(m.user_id)}">Role</label><select class="select" id="sr-${esc(m.user_id)}" data-role="${esc(m.user_id)}"><option value="operator" ${m.role === "operator" ? "selected" : ""}>Operator</option><option value="admin" ${m.role === "admin" ? "selected" : ""}>Administrator</option></select></td>
          <td class="small">${m.role === "admin" ? '<span class="muted">All clients</span>'
            : `${esc(assigned(m.user_id).map(nameOf).filter(Boolean).join(", ")) || '<span class="muted">None yet</span>'}<br><button class="btn btn-quiet" type="button" data-assign="${esc(m.user_id)}" aria-expanded="${openAssign === m.user_id}">Assign clients</button>`}</td>
          <td>${m.active ? tagHTML("tag-answered", "Active") : tagHTML("tag-noanswer", "Deactivated")}</td>
          <td class="num">${m.user_id === me ? "" : `<button class="btn btn-quiet" data-active="${esc(m.user_id)}" data-to="${m.active ? "0" : "1"}">${m.active ? "Deactivate" : "Reactivate"}</button>`}</td></tr>
          ${openAssign === m.user_id && m.role !== "admin" ? `<tr><td colspan="5"><form class="assign-form" data-assign-form="${esc(m.user_id)}">
            <p class="small mb-8"><strong>Clients ${esc(m.name || m.email)} can work on</strong> — they see nothing from other clients.</p>
            ${active.length ? `<div class="pick-list">${active.map(c => `<label class="pick ${assigned(m.user_id).indexOf(c.id) > -1 ? "is-on" : ""}"><input type="checkbox" value="${esc(c.id)}" ${assigned(m.user_id).indexOf(c.id) > -1 ? "checked" : ""}><span class="pick-name">${esc(c.name)}</span></label>`).join("")}</div>`
              : `<p class="small muted">No clients yet. <a href="#/clients">Add a client</a> first.</p>`}
            <div class="head-actions mt-16"><button class="btn btn-secondary" type="button" data-assign-cancel>Cancel</button><button class="btn btn-primary" type="submit">Save assignments</button></div>
          </form></td></tr>` : ""}`).join("")}</tbody></table></div>`;
      box.querySelectorAll("[data-assign]").forEach(b => b.addEventListener("click", () => { openAssign = openAssign === b.dataset.assign ? null : b.dataset.assign; draw(); }));
      box.querySelectorAll("[data-assign-cancel]").forEach(b => b.addEventListener("click", () => { openAssign = null; draw(); }));
      box.querySelectorAll(".assign-form .pick input").forEach(cb => cb.addEventListener("change", () => cb.closest(".pick").classList.toggle("is-on", cb.checked)));
      box.querySelectorAll("[data-assign-form]").forEach(f => f.addEventListener("submit", e => {
        e.preventDefault();
        const ids = [...f.querySelectorAll("input:checked")].map(x => x.value);
        Store.setAssignments(f.dataset.assignForm, ids).then(() => { assignCache = null; openAssign = null; toast("Assignments saved."); draw(); },
          err => toast("Could not save assignments: " + friendlyError(err)));
      }));
      box.querySelectorAll("[data-role]").forEach(sel => sel.addEventListener("change", () => {
        Store.staffAction({ action: "set_role", user_id: sel.dataset.role, role: sel.value }).then(() => toast("Role updated."), err => { toast(STAFF_ERRORS[err.code] || "Could not change the role."); draw(); });
      }));
      box.querySelectorAll("[data-active]").forEach(b => b.addEventListener("click", () => {
        const on = b.dataset.to === "1";
        if (!on && !window.confirm("Deactivate this account? They are signed out and can no longer sign in.")) return;
        Store.staffAction({ action: "set_active", user_id: b.dataset.active, active: on }).then(() => { toast(on ? "Account reactivated." : "Account deactivated."); draw(); },
          err => toast(STAFF_ERRORS[err.code] || "Could not update the account."));
      }));
    }, err => { const box = document.getElementById("team-box"); if (box) box.innerHTML = `<p class="small muted box-pad">Could not load the team. ${esc(friendlyError(err))}</p>`; });
    draw();
    view.querySelectorAll("[data-seg]").forEach(b => b.addEventListener("click", () => { teamMode = b.dataset.value; renderTeam(); }));
    const gen = document.getElementById("iv-gen");
    if (gen) gen.addEventListener("click", () => {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789", bytes = new Uint32Array(14);
      crypto.getRandomValues(bytes);
      let p = Array.from(bytes, n => chars[n % chars.length]).join("");
      p = "Bv" + p.slice(2, 12) + (bytes[0] % 10) + "k";
      document.getElementById("iv-pass").value = p;
    });
    document.getElementById("invite-form").addEventListener("submit", e => {
      e.preventDefault();
      const name = document.getElementById("iv-name").value.trim(), email = document.getElementById("iv-email").value.trim();
      const passEl = document.getElementById("iv-pass"), pass = passEl ? passEl.value : "";
      const strong = pass.length >= 10 && /[a-z]/.test(pass) && /[A-Z]/.test(pass) && /\d/.test(pass);
      setErr("iv-name", name.length >= 2 ? "" : "Enter the person's name.");
      setErr("iv-email", /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? "" : "Enter a valid email address.");
      if (passEl) setErr("iv-pass", strong ? "" : "Use at least 10 characters with upper and lower case letters and a number.");
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || (passEl && !strong)) return;
      const btn = e.target.querySelector('[type="submit"]'); btn.disabled = true;
      const body = { action: passEl ? "create" : "invite", full_name: name, email, role: document.getElementById("iv-role").value };
      if (passEl) body.password = pass;
      Store.staffAction(body)
        .then(() => { toast(passEl ? "Account created for " + email + ". Share the temporary password privately." : "Invitation sent to " + email + "."); e.target.reset(); draw(); },
              err => toast(STAFF_ERRORS[err.code] || (passEl ? "Could not create the account." : "Could not send the invitation.")))
        .finally(() => { btn.disabled = false; });
    });
  }

  /* Audit log (admins) -------------------------------------------------------- */
  const TABLES = { workspaces: "Client", staff: "Staff", workspace_settings: "Settings", contact_groups: "Group", opt_outs: "Opt-out", global_opt_outs: "Opt-out (all clients)",
    caller_ids: "Caller ID", message_templates: "Template", audio_files: "Audio", campaigns: "Campaign", campaign_requests: "Request", contacts: "Contacts", contact_group_members: "Group members" };
  function auditSummary(e) {
    const ch = e.changes || {};
    if (ch.rows != null) return num(ch.rows) + " row" + (ch.rows === 1 ? "" : "s");
    if (e.action === "UPDATE") return Object.keys(ch).filter(k => k !== "via").map(k => k === "status" && ch.status && ch.status.to ? "status → " + ch.status.to : k.replace(/_/g, " ")).join(", ");
    return ch.name || ch.value || ch.invited || (e.row_id && String(e.row_id).length < 20 ? mask(e.row_id) : "");
  }
  function renderAudit() {
    document.title = "Audit log — BalVoice";
    view.innerHTML = `<div class="view-head"><div><h1>Audit log</h1><p>Who changed what for ${esc(clientName() || "this client")}, plus team and all-client changes. The latest 200 entries. Entries can't be edited or deleted.</p></div></div>
      <div class="box" id="audit-box"><p class="small muted box-pad">Loading…</p></div>`;
    Promise.all([Store.audit(200), Store.staff()]).then(([rows, staff]) => {
      staffCache = staff;
      const box = document.getElementById("audit-box"); if (!box) return;
      box.innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Change</th></tr></thead>
        <tbody>${rows.map(e => `<tr><td class="small muted nowrap">${esc(fmtDate(e.at))}</td><td class="small">${e.actor_kind === "system" ? '<span class="muted">Delivery system</span>' : esc(staffName(e.actor))}</td>
          <td class="small">${esc(TABLES[e.table_name] || e.table_name)} · ${esc({ INSERT: "added", UPDATE: "changed", DELETE: "removed" }[e.action])}</td>
          <td class="small">${esc(auditSummary(e))}</td></tr>`).join("")}</tbody></table></div>` : `<p class="small muted box-pad">No entries yet.</p>`;
    }, err => { const box = document.getElementById("audit-box"); if (box) box.innerHTML = `<p class="small muted box-pad">Could not load the audit log. ${esc(friendlyError(err))}</p>`; });
  }

  /* Startup -------------------------------------------------------------------- */
  function renderClientSwitch() {
    const slot = document.getElementById("client-switch");
    if (!slot || !LIVE) return;
    slot.classList.add("has-select");
    const active = clients.filter(c => !c.archived_at).sort((a, b) => a.name.localeCompare(b.name));
    slot.innerHTML = `<label class="sr-only" for="client-select">Client</label>
      <select class="select select-sm" id="client-select">${currentClient ? "" : '<option value="">Choose a client…</option>'}${active.map(c => `<option value="${esc(c.id)}" ${c.id === currentClient ? "selected" : ""}>${esc(c.name)}</option>`).join("")}<option value="__manage">Manage clients…</option></select>`;
    document.getElementById("client-select").addEventListener("change", e => {
      if (e.target.value === "__manage") { renderClientSwitch(); go("#/clients"); return; }
      if (e.target.value) switchClient(e.target.value);
    });
  }
  function switchClient(id, quiet) {
    if (!quiet) view.innerHTML = `<div class="box"><p class="small muted box-pad">Loading ${esc((clients.find(c => c.id === id) || {}).name || "client")}…</p></div>`;
    return Store.load(id).then(s => {
      state = s; currentClient = id; draft = null; selected.clear();
      try { localStorage.setItem("balvoice.client", id); } catch (e) { /* storage unavailable */ }
      renderClientSwitch();
      const target = /^#\/(clients|requests)/.test(location.hash) ? "#/campaigns" : location.hash;
      if (!quiet && target !== location.hash) go(target); else route();
    }, err => {
      view.innerHTML = `<div class="box">${emptyState("This client could not be loaded", friendlyError(err), `<button class="btn btn-secondary" type="button" id="retry-load">Try again</button>`)}</div>`;
      document.getElementById("retry-load").addEventListener("click", () => switchClient(id));
    });
  }
  function applyShell() {
    document.querySelectorAll("[data-live-only]").forEach(el => { el.hidden = !LIVE; });
    document.querySelectorAll("[data-admin-only]").forEach(el => { el.hidden = !LIVE || !isAdmin(); });
    document.querySelectorAll("[data-demo-only]").forEach(el => { el.hidden = LIVE; });
  }
  function boot() {
    const a = window.BalVoiceAuth;
    if (!a) { document.addEventListener("balvoice:auth", boot, { once: true }); return; }
    if (a.mode === "denied") return;
    if (a.mode !== "supabase" || !Store) { applyShell(); route(); return; }
    LIVE = true; ROLE = a.role === "admin" ? "admin" : "operator";
    Store.init(a.client, a.user, ROLE);
    state = defaults();
    applyShell();
    view.innerHTML = `<div class="box"><p class="small muted box-pad">Loading…</p></div>`;
    Store.listClients().then(list => {
      clients = list;
      let remembered = null;
      try { remembered = localStorage.getItem("balvoice.client"); } catch (e) { /* storage unavailable */ }
      const active = clients.filter(c => !c.archived_at);
      const pick = active.find(c => c.id === remembered) || (active.length === 1 ? active[0] : null);
      renderClientSwitch();
      if (pick) switchClient(pick.id); else route();
    }, err => {
      view.innerHTML = `<div class="box">${emptyState("The dashboard could not load", friendlyError(err), `<button class="btn btn-secondary" type="button" id="reload-app">Reload</button>`)}</div>`;
      document.getElementById("reload-app").addEventListener("click", () => location.reload());
    });
  }

  /* Shell ----------------------------------------------------------------- */
  const sidebar = document.getElementById("sidebar");
  const sbToggle = document.querySelector(".sidebar-toggle");
  function closeSidebar() { sidebar.classList.remove("is-open"); sbToggle.setAttribute("aria-expanded", "false"); }
  sbToggle.addEventListener("click", () => {
    const open = !sidebar.classList.contains("is-open");
    sidebar.classList.toggle("is-open", open);
    sbToggle.setAttribute("aria-expanded", String(open));
  });
  document.getElementById("reset-demo").addEventListener("click", () => {
    if (LIVE) return;
    if (!window.confirm("Clear all demo data — campaigns, groups, contacts, templates, caller IDs, and the opt-out register — from this browser?")) return;
    Object.keys(timers).forEach(stopSim);
    state = defaults(); draft = null; selected.clear();
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    toast("Demo data cleared."); go("#/campaigns");
  });

  window.addEventListener("hashchange", () => { selected.clear(); listLimit = 50; contactQuery = { q: "", group: "" }; route(); window.scrollTo(0, 0); });
  boot();
})();
