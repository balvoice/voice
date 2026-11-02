/* BalVoice — site scripts. No dependencies. */
(function () {
  "use strict";

  document.documentElement.classList.add("js");

  /* Navigation ------------------------------------------------------------ */
  function initNav() {
    var toggle = document.querySelector(".nav-toggle");
    var nav = document.getElementById("site-nav");
    if (!toggle || !nav) return;

    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      toggle.querySelector(".sr-only").textContent = open ? "Open menu" : "Close menu";
      nav.classList.toggle("is-open", !open);
      document.body.classList.toggle("nav-open", !open);
    });

    var subToggles = document.querySelectorAll(".sub-toggle");
    subToggles.forEach(function (btn) {
      var menu = document.getElementById(btn.getAttribute("aria-controls"));
      var item = btn.closest(".nav-item");
      function setOpen(state) {
        btn.setAttribute("aria-expanded", String(state));
        menu.classList.toggle("is-open", state);
      }
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        setOpen(btn.getAttribute("aria-expanded") !== "true");
      });
      // Desktop hover
      var hoverable = window.matchMedia("(hover: hover) and (min-width: 961px)");
      item.addEventListener("mouseenter", function () { if (hoverable.matches) setOpen(true); });
      item.addEventListener("mouseleave", function () { if (hoverable.matches) setOpen(false); });
      document.addEventListener("click", function (e) { if (!item.contains(e.target)) setOpen(false); });
      item.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { setOpen(false); btn.focus(); }
      });
      item.addEventListener("focusout", function (e) {
        if (!item.contains(e.relatedTarget) && hoverable.matches) setOpen(false);
      });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("is-open")) toggle.click();
    });
  }

  /* Scroll reveal --------------------------------------------------------- */
  function initReveal() {
    var items = document.querySelectorAll(".reveal");
    if (!items.length) return;
    if (!("IntersectionObserver" in window)) {
      items.forEach(function (el) { el.classList.add("is-visible"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    items.forEach(function (el) { io.observe(el); });
  }

  /* Hero console: one-time fill animation --------------------------------- */
  function initConsole() {
    var segs = document.querySelectorAll(".console [data-width]");
    if (!segs.length) return;
    requestAnimationFrame(function () {
      setTimeout(function () {
        segs.forEach(function (s) { s.style.width = s.getAttribute("data-width") + "%"; });
      }, 250);
    });
  }

  /* Cost calculator ------------------------------------------------------- */
  function initCalculator() {
    var form = document.getElementById("cost-calc");
    if (!form) return;

    var $ = function (id) { return document.getElementById(id); };
    var fields = ["contacts", "duration", "billing", "rate", "retries", "answer", "platform", "production", "currency"];
    var els = {};
    fields.forEach(function (f) { els[f] = $("calc-" + f); });

    // Keep range + number pairs in sync
    document.querySelectorAll("[data-sync]").forEach(function (el) {
      var target = $(el.getAttribute("data-sync"));
      el.addEventListener("input", function () { target.value = el.value; update(); });
    });

    function num(el, min, max) {
      var v = parseFloat(el.value);
      if (!isFinite(v)) return 0;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      return v;
    }

    function fmt(v, cur) {
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
      } catch (e) {
        return cur + " " + v.toFixed(2);
      }
    }
    function fmtN(v, d) {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: d || 0 }).format(v);
    }

    function update() {
      var contacts = Math.round(num(els.contacts, 0, 10000000));
      var seconds = num(els.duration, 1, 600);
      var perMinuteRounding = els.billing.value === "minute";
      var minutes = perMinuteRounding ? Math.ceil(seconds / 60) : seconds / 60;
      var rateEntered = els.rate.value.trim() !== "";
      var rate = num(els.rate, 0);
      var retries = Math.round(num(els.retries, 0, 5));
      var answer = num(els.answer, 1, 100) / 100;
      var platform = num(els.platform, 0);
      var production = num(els.production, 0);
      var cur = els.currency.value;

      // Each retry only goes to numbers not yet answered.
      var attempts = 0;
      for (var k = 0; k <= retries; k++) attempts += Math.pow(1 - answer, k);
      var reached = contacts * (1 - Math.pow(1 - answer, retries + 1));
      var airtime = contacts * minutes * rate * attempts;
      var total = airtime + platform + production;

      $("out-minutes").textContent = fmtN(minutes, 2) + " min";
      $("out-attempts").textContent = fmtN(attempts, 2);
      $("out-calls").textContent = fmtN(contacts * attempts);
      $("out-reached").textContent = fmtN(reached);
      $("out-airtime").textContent = rateEntered ? fmt(airtime, cur) : "—";
      $("out-platform").textContent = fmt(platform, cur);
      $("out-production").textContent = fmt(production, cur);
      $("out-total").textContent = rateEntered ? fmt(total, cur) : "Enter an airtime rate to see the total";
      $("out-total").classList.toggle("is-empty", !rateEntered);
      $("out-per").textContent = rateEntered && reached > 0
        ? fmt(total / reached, cur) + " per contact reached (estimated)"
        : "Airtime rates depend on your network and destination. Use the rate from your quote.";
    }

    // Remember inputs only if the visitor allowed preference storage.
    var PREF_KEY = "bv.pref.calculator";
    var consent = window.BalVoiceConsent;
    function canRemember() { return consent && consent.has("preferences"); }
    function remember() {
      if (!canRemember()) return;
      var data = {};
      fields.forEach(function (f) { data[f] = els[f].value; });
      try { localStorage.setItem(PREF_KEY, JSON.stringify(data)); } catch (e) { /* storage unavailable */ }
    }
    if (canRemember()) {
      try {
        var saved = JSON.parse(localStorage.getItem(PREF_KEY) || "null");
        if (saved) fields.forEach(function (f) { if (saved[f] !== undefined && els[f]) els[f].value = saved[f]; });
        ["retries", "answer"].forEach(function (f) { var r = $("calc-" + f + "-range"); if (r) r.value = els[f].value; });
      } catch (e) { /* ignore corrupt data */ }
    }
    if (consent) consent.onChange(function () { if (canRemember()) remember(); });

    form.addEventListener("input", function () { update(); remember(); });
    form.addEventListener("change", function () { update(); remember(); });
    form.addEventListener("submit", function (e) { e.preventDefault(); });
    update();
  }

  /* Contact / request form ------------------------------------------------ */
  function initRequestForm() {
    var form = document.getElementById("request-form");
    if (!form) return;

    var status = document.getElementById("form-status");
    var submit = form.querySelector('[type="submit"]');

    // Preselect campaign type from ?type=
    var params = new URLSearchParams(window.location.search);
    var type = params.get("type");
    var typeSelect = form.elements["campaign_type"];
    if (type && typeSelect) {
      Array.prototype.forEach.call(typeSelect.options, function (o) { if (o.value === type) typeSelect.value = type; });
    }

    var rules = {
      organization: function (v) { return v.trim().length >= 2 && v.length <= 120 || "Enter your organization name."; },
      name: function (v) { return v.trim().length >= 2 && v.length <= 80 || "Enter your full name."; },
      email: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) && v.length <= 160 || "Enter a valid email address."; },
      phone: function (v) { var d = v.replace(/[^\d]/g, ""); return d.length >= 9 && d.length <= 15 || "Enter a valid phone number, including area code."; },
      campaign_type: function (v) { return v !== "" || "Select a campaign type."; },
      list_size: function (v) { return v !== "" || "Select an approximate list size."; },
      message: function (v) { return v.length <= 2000 || "Please keep this under 2,000 characters."; },
      consent_contacts: function (_, el) { return el.checked || "Please confirm that recipients have agreed to receive calls."; },
      consent_optout: function (_, el) { return el.checked || "Please confirm that you agree to include an opt-out option."; }
    };

    function validateField(name) {
      var el = form.elements[name];
      if (!el || !rules[name]) return true;
      var result = rules[name](el.value || "", el);
      var field = el.closest(".field, .checkbox-field");
      var err = field && field.querySelector(".field-error");
      var ok = result === true;
      if (field) field.classList.toggle("has-error", !ok);
      el.setAttribute("aria-invalid", String(!ok));
      if (err) err.textContent = ok ? "" : result;
      return ok;
    }

    Object.keys(rules).forEach(function (name) {
      var el = form.elements[name];
      if (!el) return;
      el.addEventListener("blur", function () { if (el.value || el.type === "checkbox") validateField(name); });
      el.addEventListener("change", function () { validateField(name); });
    });

    function show(kind, msg) {
      status.className = "form-status is-visible is-" + kind;
      status.textContent = msg;
      status.focus();
    }

    var lastSubmit = 0;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      // Honeypot: real users never fill this field.
      if (form.elements["website"] && form.elements["website"].value) return;

      var firstInvalid = null;
      Object.keys(rules).forEach(function (name) {
        if (!validateField(name) && !firstInvalid) firstInvalid = form.elements[name];
      });
      if (firstInvalid) {
        show("error", "Please correct the highlighted fields.");
        firstInvalid.focus();
        return;
      }

      var now = Date.now();
      if (now - lastSubmit < 30000) {
        show("info", "Your request is already on its way. Please wait a moment before sending another.");
        return;
      }
      lastSubmit = now;

      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = typeof v === "string" ? v.trim() : v; });

      var endpoint = form.getAttribute("data-endpoint") || functionUrl("request-form");
      if (!endpoint) {
        // No backend configured yet — see README "Connecting the request form".
        show("info", "Thank you. Your details were checked and are ready to send, but this form is not yet connected to a server. Please contact us directly using the details on this page.");
        return;
      }

      submit.disabled = true;
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(data),
        credentials: "omit"
      }).then(function (res) {
        if (res.status === 429) { lastSubmit = 0; throw new Error("rate"); }
        if (!res.ok) throw new Error("Request failed");
        form.reset();
        show("success", "Thank you. We have received your request and will be in touch to discuss your campaign.");
      }).catch(function (err) {
        show("error", err && err.message === "rate"
          ? "Too many requests have come from your connection. Please try again in an hour or contact us directly."
          : "We could not send your request. Please try again or contact us directly.");
        lastSubmit = 0;
      }).finally(function () {
        submit.disabled = false;
      });
    });
  }

  /* Supabase Edge Function address, when the site is connected (assets/js/config.js). */
  function functionUrl(name) {
    var cfg = window.BALVOICE_CONFIG || {};
    return cfg.supabaseUrl ? cfg.supabaseUrl.replace(/\/$/, "") + "/functions/v1/" + name : "";
  }

  /* "Stop receiving calls" form ------------------------------------------ */
  function initOptOutForm() {
    var form = document.getElementById("optout-form");
    if (!form) return;
    var status = document.getElementById("optout-status"), input = form.elements["phone"];
    var field = input.closest(".field"), err = field.querySelector(".field-error");
    function show(kind, msg) { status.className = "form-status is-visible is-" + kind; status.textContent = msg; status.focus(); }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (form.elements["website"].value) return;
      var digits = input.value.replace(/[^\d]/g, "");
      var ok = digits.length >= 9 && digits.length <= 15;
      field.classList.toggle("has-error", !ok);
      input.setAttribute("aria-invalid", String(!ok));
      err.textContent = ok ? "" : "Enter the phone number, including the area code.";
      if (!ok) { input.focus(); return; }
      var endpoint = functionUrl("opt-out");
      if (!endpoint) { show("info", "This form is not connected yet. Please use the contact details above to stop calls."); return; }
      var btn = form.querySelector('[type="submit"]'); btn.disabled = true;
      fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit",
                        body: JSON.stringify({ phone: input.value.trim(), website: "" }) })
        .then(function (res) {
          if (res.status === 429) throw new Error("rate");
          if (res.status === 422) throw new Error("invalid");
          if (!res.ok) throw new Error("failed");
          form.reset();
          show("success", "Done. This number will not receive further calls from campaigns we deliver. Calls already in progress may still complete.");
        })
        .catch(function (e2) {
          show("error", e2.message === "invalid" ? "That doesn't look like a valid phone number." :
                        e2.message === "rate" ? "Too many requests from your connection. Please try again later or contact us." :
                        "We could not record your request. Please try again or contact us directly.");
        })
        .finally(function () { btn.disabled = false; });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initOptOutForm();
    initNav();
    initReveal();
    initConsole();
    initCalculator();
    initRequestForm();
  });
})();
