/* BalVoice — cookie consent manager.
 *
 * - Nothing optional is stored or loaded until the visitor chooses.
 * - "Accept all" and "Reject non-essential" are offered with equal prominence.
 * - Choices are kept in a first-party cookie (bv_consent) for 180 days and can be
 *   changed at any time from "Cookie settings" in the footer.
 * - Changing POLICY_VERSION asks everyone again (do this when the cookie policy changes).
 * - The browser's Global Privacy Control signal is honoured: optional categories
 *   start switched off and "Accept all" leaves analytics off.
 *
 * Other scripts can ask for consent:
 *   BalVoiceConsent.has("preferences")              -> true / false
 *   BalVoiceConsent.onChange(fn)                    -> fn(consent) after every save
 *   BalVoiceConsent.open()                          -> opens the preferences dialog
 * Optional third-party scripts are written as
 *   <script type="text/plain" data-consent="analytics" data-src="https://..."></script>
 * and are only loaded after consent for that category. See docs/COOKIE-CONSENT.md.
 */
(function () {
  "use strict";

  const COOKIE = "bv_consent";
  const POLICY_VERSION = "2026-10";
  const MAX_AGE_DAYS = 180;
  const CATEGORIES = [
    { id: "necessary", title: "Strictly necessary", locked: true,
      text: "Needed for the website and client dashboard to work, such as remembering your cookie choices and keeping dashboard data on your device. These cannot be switched off." },
    { id: "preferences", title: "Preferences",
      text: "Remember choices you make on the site, such as the figures you last entered in the campaign cost calculator." },
    { id: "analytics", title: "Analytics",
      text: "Help us understand how visitors use the site so we can improve it. Not currently in use — if we add an analytics service, it will only run with your permission." }
  ];
  const gpc = navigator.globalPrivacyControl === true;
  const listeners = [];

  /* Storage ----------------------------------------------------------------- */
  function read() {
    try {
      const m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE + "=([^;]*)"));
      if (!m) return null;
      const v = JSON.parse(decodeURIComponent(m[1]));
      return v && v.v === POLICY_VERSION ? v : null;
    } catch (e) { return null; }
  }
  function write(choices) {
    const value = {
      v: POLICY_VERSION,
      necessary: true,
      preferences: !!choices.preferences,
      analytics: !!choices.analytics && !(gpc && choices.fromAcceptAll),
      ts: new Date().toISOString(),
      gpc: gpc
    };
    const secure = location.protocol === "https:" ? "; Secure" : "";
    try {
      document.cookie = COOKIE + "=" + encodeURIComponent(JSON.stringify(value)) +
        "; Max-Age=" + MAX_AGE_DAYS * 86400 + "; Path=/; SameSite=Lax" + secure;
    } catch (e) { /* cookies blocked — choice applies to this page view only */ }
    current = value;
    if (!value.preferences) clearPreferenceStorage();
    activateScripts();
    listeners.forEach(fn => { try { fn(value); } catch (e) { /* ignore listener errors */ } });
    return value;
  }
  function clearPreferenceStorage() {
    try {
      Object.keys(localStorage).forEach(k => { if (k.indexOf("bv.pref.") === 0) localStorage.removeItem(k); });
    } catch (e) { /* storage unavailable */ }
  }

  let current = read();

  /* Script gating ----------------------------------------------------------- */
  function activateScripts() {
    if (!current) return;
    document.querySelectorAll('script[type="text/plain"][data-consent]').forEach(el => {
      if (!current[el.dataset.consent] || el.dataset.loaded) return;
      el.dataset.loaded = "1";
      const s = document.createElement("script");
      s.src = el.dataset.src;
      s.async = true;
      document.head.appendChild(s);
    });
  }

  /* Banner ------------------------------------------------------------------ */
  let banner = null, dialog = null, lastFocus = null;

  function buildBanner() {
    banner = document.createElement("section");
    banner.className = "cc-banner";
    banner.setAttribute("aria-labelledby", "cc-title");
    banner.setAttribute("aria-describedby", "cc-desc");
    banner.innerHTML =
      '<div class="cc-inner">' +
        '<div class="cc-text">' +
          '<h2 id="cc-title">Your privacy choices</h2>' +
          '<p id="cc-desc">We use strictly necessary cookies to run this website. With your permission, we would also like to remember your preferences' +
          ' and, in future, measure how the site is used. You can change your choice at any time from <strong>Cookie settings</strong> at the bottom of every page. ' +
          '<a href="cookies.html">Read our cookie policy</a>.</p>' +
          (gpc ? '<p class="cc-gpc">Your browser is sending a Global Privacy Control signal, so analytics will stay off.</p>' : "") +
        '</div>' +
        '<div class="cc-actions">' +
          '<button type="button" class="btn cc-btn" data-cc="reject">Reject non-essential</button>' +
          '<button type="button" class="btn cc-btn" data-cc="accept">Accept all</button>' +
          '<button type="button" class="cc-link" data-cc="manage">Manage preferences</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(banner);
    banner.addEventListener("click", e => {
      const b = e.target.closest("[data-cc]");
      if (!b) return;
      if (b.dataset.cc === "accept") { write({ preferences: true, analytics: true, fromAcceptAll: true }); hideBanner(); announce("All cookies accepted."); }
      if (b.dataset.cc === "reject") { write({ preferences: false, analytics: false }); hideBanner(); announce("Only strictly necessary cookies will be used."); }
      if (b.dataset.cc === "manage") open();
    });
    requestAnimationFrame(() => banner.classList.add("is-visible"));
  }
  function hideBanner() {
    if (!banner) return;
    banner.classList.remove("is-visible");
    const b = banner; banner = null;
    setTimeout(() => b.remove(), 250);
  }

  /* Preferences dialog ------------------------------------------------------ */
  function buildDialog() {
    dialog = document.createElement("dialog");
    dialog.className = "cc-dialog";
    dialog.setAttribute("aria-labelledby", "cc-dialog-title");
    dialog.innerHTML =
      '<form method="dialog" class="cc-form">' +
        '<div class="cc-dialog-head">' +
          '<h2 id="cc-dialog-title">Cookie preferences</h2>' +
          '<button type="button" class="cc-close" data-cc="close" aria-label="Close">' +
            '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="cc-dialog-body">' +
          '<p>Choose which cookies and similar technologies we may use. Strictly necessary cookies are always on because the site cannot work without them. ' +
          'See the <a href="cookies.html">cookie policy</a> for the full list.</p>' +
          CATEGORIES.map(c =>
            '<div class="cc-cat">' +
              '<div class="cc-cat-head">' +
                '<label class="cc-cat-title" for="cc-' + c.id + '">' + c.title + '</label>' +
                (c.locked
                  ? '<span class="cc-always">Always on</span>'
                  : '<span class="cc-switch"><input type="checkbox" role="switch" id="cc-' + c.id + '" data-cat="' + c.id + '"><span aria-hidden="true"></span></span>') +
              '</div>' +
              '<p id="cc-' + c.id + '-desc">' + c.text + '</p>' +
            '</div>').join("") +
          (gpc ? '<p class="cc-gpc">Global Privacy Control detected: analytics is switched off by default.</p>' : "") +
        '</div>' +
        '<div class="cc-dialog-foot">' +
          '<button type="button" class="btn cc-btn" data-cc="reject-all">Reject non-essential</button>' +
          '<button type="button" class="btn cc-btn" data-cc="accept-all">Accept all</button>' +
          '<button type="button" class="btn btn-primary" data-cc="save">Save my choices</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(dialog);
    CATEGORIES.forEach(c => { const i = dialog.querySelector("#cc-" + c.id); if (i) i.setAttribute("aria-describedby", "cc-" + c.id + "-desc"); });
    dialog.addEventListener("click", e => {
      if (e.target === dialog) { close(); return; } // click on backdrop
      const b = e.target.closest("[data-cc]");
      if (!b) return;
      const val = id => { const i = dialog.querySelector('[data-cat="' + id + '"]'); return i ? i.checked : false; };
      if (b.dataset.cc === "close") { close(); return; }
      if (b.dataset.cc === "accept-all") write({ preferences: true, analytics: true, fromAcceptAll: true });
      if (b.dataset.cc === "reject-all") write({ preferences: false, analytics: false });
      if (b.dataset.cc === "save") write({ preferences: val("preferences"), analytics: val("analytics") });
      hideBanner(); close(); announce("Your cookie choices have been saved.");
    });
    dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
  }

  function open() {
    if (!dialog) buildDialog();
    const c = current || { preferences: false, analytics: false };
    dialog.querySelectorAll("[data-cat]").forEach(i => { i.checked = !!c[i.dataset.cat]; });
    lastFocus = document.activeElement;
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    document.body.classList.add("cc-lock");
    const first = dialog.querySelector('[data-cat]');
    if (first) first.focus();
  }
  function close() {
    if (!dialog) return;
    if (typeof dialog.close === "function" && dialog.open) dialog.close(); else dialog.removeAttribute("open");
    document.body.classList.remove("cc-lock");
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    else if (banner) { const b = banner.querySelector("[data-cc]"); if (b) b.focus(); }
  }

  /* Screen reader announcements -------------------------------------------- */
  let live = null;
  function announce(msg) {
    if (!live) { live = document.createElement("div"); live.className = "sr-only"; live.setAttribute("role", "status"); document.body.appendChild(live); }
    live.textContent = "";
    setTimeout(() => { live.textContent = msg; }, 50);
  }

  /* Public API -------------------------------------------------------------- */
  window.BalVoiceConsent = {
    get: () => current ? Object.assign({}, current) : null,
    has: cat => cat === "necessary" || !!(current && current[cat]),
    onChange: fn => { if (typeof fn === "function") listeners.push(fn); },
    open: open,
    reset: () => { document.cookie = COOKIE + "=; Max-Age=0; Path=/; SameSite=Lax"; current = null; clearPreferenceStorage(); if (!banner) buildBanner(); }
  };

  function init() {
    document.querySelectorAll("[data-consent-open]").forEach(el => el.addEventListener("click", e => { e.preventDefault(); open(); }));
    if (current) activateScripts();
    else if (!document.body.hasAttribute("data-no-consent-banner")) buildBanner();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
