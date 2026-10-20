/**
 * Profit Guild — funnel interactions
 * No dependencies. Progressive enhancement only.
 */
(() => {
  "use strict";

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const CONFIG = Object.assign(
    {
      leadEndpoint: "/api/lead",
      subscribeEndpoint: "/api/subscribe",
      eventEndpoint: "/api/event",
      bookingUrl: "",
      contactEmail: "hello@profitgrowthcoaching.com",
      analytics: true,
      scrollDepth: [25, 50, 75, 90],
      minFormFillMs: 2500,
      draftStorage: "local",
    },
    window.PGC_CONFIG || {}
  );

  const storage = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* Storage can be full or blocked; the funnel still works. */
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* no-op */
      }
    },
    sessionGet(key) {
      try {
        return window.sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    sessionSet(key, value) {
      try {
        window.sessionStorage.setItem(key, value);
      } catch {
        /* no-op */
      }
    },
  };

  const reduceData = () =>
    navigator.doNotTrack === "1" ||
    window.doNotTrack === "1" ||
    navigator.globalPrivacyControl === true;

  function getSessionId() {
    let id = storage.sessionGet("pgc_sid");
    if (!id) {
      const random =
        window.crypto && typeof window.crypto.randomUUID === "function"
          ? window.crypto.randomUUID().replace(/-/g, "").slice(0, 20)
          : Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      id = `s_${random}`;
      storage.sessionSet("pgc_sid", id);
    }
    return id;
  }

  const sessionId = getSessionId();
  let saveDraftHook = () => {};

  /* ------------------------------------------------------------------
     Attribution
     ------------------------------------------------------------------ */
  const utmKeys = ["source", "medium", "campaign", "term", "content"];
  let utm = {};

  function captureUtm() {
    const params = new URLSearchParams(window.location.search);
    const found = {};
    utmKeys.forEach((key) => {
      const value = params.get(`utm_${key}`);
      if (value) found[key] = value.slice(0, 120);
    });
    if (Object.keys(found).length) {
      storage.sessionSet("pgc_utm", JSON.stringify(found));
      utm = found;
    } else {
      try {
        utm = JSON.parse(storage.sessionGet("pgc_utm") || "{}") || {};
      } catch {
        utm = {};
      }
    }
    // Persist the landing page on first touch.
    if (!storage.sessionGet("pgc_landing")) {
      storage.sessionSet("pgc_landing", `${window.location.pathname}${window.location.search}`.slice(0, 300));
    }
  }

  function landingPage() {
    return storage.sessionGet("pgc_landing") || `${window.location.pathname}${window.location.search}`;
  }

  captureUtm();

  /* ------------------------------------------------------------------
     Analytics (cookie-free, first party, respects DNT/GPC)
     ------------------------------------------------------------------ */
  function track(event, props = {}) {
    if (!CONFIG.analytics || reduceData()) return;
    const payload = {
      event,
      path: `${window.location.pathname}${window.location.hash}`.slice(0, 200),
      sessionId,
      props,
    };
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: `pgc_${event}`, ...props });
    } catch {
      /* no-op */
    }
    if (typeof window.plausible === "function") {
      window.plausible(event, { props });
    }
    const url = CONFIG.eventEndpoint;
    if (!url || window.location.protocol === "file:") return;
    try {
      const body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon(url, blob);
        return;
      }
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* Analytics must never break the page. */
    }
  }

  function sectionOf(element) {
    const section = element.closest("section, header, footer, dialog");
    return section ? section.id || section.className.split(" ")[0] : "page";
  }

  // Delegate CTA / navigation / outbound tracking so new links are covered.
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const outbound = target.closest('a[target="_blank"]');
      if (outbound) {
        track("outbound_click", { href: outbound.href.slice(0, 160), location: sectionOf(outbound) });
      }

      const nav = target.closest(".nav-link, .mobile-link, .footer-col a, .footer-legal a");
      if (nav && !nav.hasAttribute("data-track")) {
        track("nav_click", {
          label: (nav.textContent || "").trim().slice(0, 60),
          href: (nav.getAttribute("href") || "").slice(0, 120),
          location: sectionOf(nav),
        });
      }

      const trigger = target.closest("[data-track], [data-open-calculator], [data-book-call], [data-score-cta], [data-calc-cta]");
      if (!trigger) return;

      const label = (trigger.getAttribute("data-track") || trigger.textContent || "").trim().slice(0, 80);
      const location = sectionOf(trigger);

      if (trigger.hasAttribute("data-open-calculator")) {
        track("calculator_open", { location, label });
      } else if (trigger.hasAttribute("data-book-call")) {
        track("book_call", { location, label });
      } else if (trigger.hasAttribute("data-score-cta")) {
        track("scorecard_cta", { location, label });
      } else if (trigger.hasAttribute("data-calc-cta")) {
        track("calculator_apply", { location, label });
      } else {
        track("cta_click", { id: label, location });
      }
    },
    { capture: true }
  );

  /* ------------------------------------------------------------------
     Header + active section navigation
     ------------------------------------------------------------------ */
  const header = $("[data-header]");
  const main = $("#main");
  const footer = $(".site-footer");
  const navLinks = $$('.primary-nav .nav-link[href^="#"]');
  const navTargets = navLinks
    .map((link) => ({ link, section: $(link.getAttribute("href")) }))
    .filter((item) => item.section);

  function updateHeader() {
    if (header) header.classList.toggle("is-scrolled", window.scrollY > 10);
  }

  function updateActiveNav() {
    if (!navTargets.length) return;
    const marker = window.scrollY + Math.min(window.innerHeight * 0.42, 420);
    let active = navTargets[0].link;

    navTargets.forEach(({ link, section }) => {
      const top = section.getBoundingClientRect().top + window.scrollY;
      if (top <= marker) active = link;
    });

    navLinks.forEach((link) => {
      const isActive = link === active;
      link.classList.toggle("is-active", isActive);
      if (isActive) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }

  /* ------------------------------------------------------------------
     Mobile navigation
     ------------------------------------------------------------------ */
  const menuToggle = $("[data-menu-toggle]");
  const mobilePanel = $("[data-mobile-panel]");
  const navBackdrop = $("[data-nav-backdrop]");
  let menuOpen = false;

  function setMenu(open) {
    if (!menuToggle || !mobilePanel) return;
    menuOpen = open;
    menuToggle.setAttribute("aria-expanded", String(open));
    menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    const iconUse = menuToggle.querySelector("use");
    if (iconUse) iconUse.setAttribute("href", open ? "#i-close" : "#i-menu");

    mobilePanel.classList.toggle("is-open", open);
    mobilePanel.setAttribute("aria-hidden", String(!open));
    if (navBackdrop) navBackdrop.classList.toggle("is-open", open);
    document.body.classList.toggle("menu-open", open);

    if (main) main.inert = open;
    if (footer) footer.inert = open;

    if (open) {
      const firstLink = mobilePanel.querySelector("a, button");
      if (firstLink) firstLink.focus({ preventScroll: true });
    }
  }

  if (menuToggle && mobilePanel) {
    mobilePanel.setAttribute("aria-hidden", "true");
    menuToggle.addEventListener("click", () => setMenu(!menuOpen));
    if (navBackdrop) navBackdrop.addEventListener("click", () => setMenu(false));
    $$("a, button", mobilePanel).forEach((item) => {
      item.addEventListener("click", () => setMenu(false));
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && menuOpen) {
        setMenu(false);
        menuToggle.focus();
        return;
      }
      if (event.key !== "Tab" || !menuOpen) return;
      const focusable = $$('a[href], button:not([disabled])', mobilePanel).filter(
        (item) => item.offsetParent !== null
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    const desktopQuery = window.matchMedia("(min-width: 1025px)");
    desktopQuery.addEventListener("change", (event) => {
      if (event.matches && menuOpen) setMenu(false);
    });
  }

  /* ------------------------------------------------------------------
     Scroll reveal + counters
     ------------------------------------------------------------------ */
  const revealItems = $$("[data-reveal]");

  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealItems.forEach((item) => item.classList.add("is-visible"));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -7% 0px" }
    );
    revealItems.forEach((item) => revealObserver.observe(item));
  }

  const counters = $$("[data-counter]");

  function formatCounter(value, decimals) {
    return value.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function runCounter(element) {
    if (element.dataset.counted === "true") return;
    element.dataset.counted = "true";

    const target = Number.parseFloat(element.dataset.counter || "0");
    const decimals = Number.parseInt(element.dataset.decimals || "0", 10);
    const prefix = element.dataset.prefix || "";
    const suffix = element.dataset.suffix || "";

    if (reduceMotion) {
      element.textContent = `${prefix}${formatCounter(target, decimals)}${suffix}`;
      return;
    }

    const duration = 1500;
    const start = performance.now();

    function frame(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = `${prefix}${formatCounter(target * eased, decimals)}${suffix}`;
      if (progress < 1) window.requestAnimationFrame(frame);
      else element.textContent = `${prefix}${formatCounter(target, decimals)}${suffix}`;
    }

    window.requestAnimationFrame(frame);
  }

  if ("IntersectionObserver" in window) {
    const counterObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          runCounter(entry.target);
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.5 }
    );
    counters.forEach((counter) => counterObserver.observe(counter));
  } else {
    counters.forEach(runCounter);
  }

  /* ------------------------------------------------------------------
     Sticky mobile CTA
     ------------------------------------------------------------------ */
  const stickyCta = $("[data-sticky-cta]");
  const applySection = $("#apply");
  let applyInView = false;

  function syncStickyCta() {
    if (!stickyCta) return;
    const visible = window.scrollY > 700 && !applyInView && !menuOpen;
    stickyCta.classList.toggle("is-visible", visible);
    stickyCta.setAttribute("aria-hidden", String(!visible));
    document.body.classList.toggle("has-sticky-cta", visible);
  }

  if (stickyCta && applySection && "IntersectionObserver" in window) {
    const applyObserver = new IntersectionObserver(
      (entries) => {
        applyInView = entries.some((entry) => entry.isIntersecting);
        syncStickyCta();
      },
      { threshold: 0.12 }
    );
    applyObserver.observe(applySection);
  }

  /* ------------------------------------------------------------------
     Scroll depth + scroll handler
     ------------------------------------------------------------------ */
  const depthMarks = [...new Set((CONFIG.scrollDepth || []).map(Number).filter(Boolean))].sort(
    (a, b) => a - b
  );
  const depthSent = new Set();
  let scrollQueued = false;

  function trackScrollDepth() {
    if (!depthMarks.length) return;
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    if (scrollable <= 0) return;
    const percent = Math.round((window.scrollY / scrollable) * 100);
    depthMarks.forEach((mark) => {
      if (percent >= mark && !depthSent.has(mark)) {
        depthSent.add(mark);
        track("scroll_depth", { percent: mark });
      }
    });
  }

  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    window.requestAnimationFrame(() => {
      updateHeader();
      updateActiveNav();
      syncStickyCta();
      trackScrollDepth();
      scrollQueued = false;
    });
  }

  updateHeader();
  updateActiveNav();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", syncStickyCta, { passive: true });

  /* ------------------------------------------------------------------
     FAQ accordion (independent toggles)
     ------------------------------------------------------------------ */
  // The collapsed state is pure CSS, so the answers stay readable without
  // JavaScript. Only once the enhancement layer runs do we take collapsed
  // answers out of the tab order and the accessibility tree.
  $$(".faq-item").forEach((item) => {
    const answer = item.querySelector(".faq-answer");
    if (!answer || item.classList.contains("is-open")) return;
    answer.setAttribute("aria-hidden", "true");
    answer.setAttribute("inert", "");
  });

  $$(".faq-question").forEach((button) => {
    button.addEventListener("click", () => {
      const item = button.closest(".faq-item");
      if (!item) return;
      const answer = item.querySelector(".faq-answer");
      const isOpen = item.classList.toggle("is-open");
      button.setAttribute("aria-expanded", String(isOpen));
      if (answer) {
        answer.setAttribute("aria-hidden", String(!isOpen));
        // `inert` keeps the collapsed answer's links out of the tab order.
        if (isOpen) answer.removeAttribute("inert");
        else answer.setAttribute("inert", "");
      }
      if (isOpen) track("faq_open", { question: (button.textContent || "").trim().slice(0, 90) });
    });
  });

  /* ------------------------------------------------------------------
     Shared helpers
     ------------------------------------------------------------------ */
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

  function moneyShort(value) {
    if (!Number.isFinite(value) || value <= 0) return "$0";
    return money.format(Math.round(value));
  }

  function showToast(message) {
    const toast = $("[data-toast]");
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    toast.classList.add("is-visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
      window.setTimeout(() => {
        toast.hidden = true;
      }, 220);
    }, 3200);
  }

  function revenueOptionFor(value) {
    const amount = Number(value) || 0;
    if (amount < 25000) return "Under $25k";
    if (amount < 50000) return "$25k – $50k";
    if (amount < 100000) return "$50k – $100k";
    if (amount < 250000) return "$100k – $250k";
    if (amount < 500000) return "$250k – $500k";
    return "$500k+";
  }

  function selectValue(select, value) {
    if (!select || !value) return false;
    const options = Array.from(select.options);
    const match = options.find((option) => option.value === value || option.text === value);
    if (!match) return false;
    select.value = match.value || match.text;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function openBooking() {
    const subject = encodeURIComponent("15-minute fit call — Profit Guild");
    const body = encodeURIComponent(
      "Hi, I'd like to book a 15-minute call to see if profit coaching is a fit.\n\nStore URL:\nMonthly revenue:\nBiggest challenge:\n"
    );
    if (CONFIG.bookingUrl) {
      window.open(CONFIG.bookingUrl, "_blank", "noopener,noreferrer");
      return;
    }
    window.location.href = `mailto:${CONFIG.contactEmail}?subject=${subject}&body=${body}`;
  }

  $$("[data-book-call]").forEach((button) => {
    button.addEventListener("click", openBooking);
  });

  /* ------------------------------------------------------------------
     Profit calculator
     ------------------------------------------------------------------ */
  const calculator = $("#profit-calculator");
  const calcRevenue = $("#calc-revenue");
  const calcMargin = $("#calc-margin");
  const calcImprovement = $("#calc-improvement");

  function calcValues() {
    return {
      revenue: Number(calcRevenue ? calcRevenue.value : 0),
      margin: Number(calcMargin ? calcMargin.value : 0),
      improvement: Number(calcImprovement ? calcImprovement.value : 0),
    };
  }

  function updateRangeFill(input) {
    if (!input) return;
    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);
    const percent = ((value - min) / (max - min)) * 100;
    input.style.setProperty("--fill", `${percent}%`);
  }

  function updateCalculator() {
    if (!calculator || !calcRevenue || !calcMargin || !calcImprovement) return;

    const { revenue, margin, improvement } = calcValues();
    const newMonthlyProfit = revenue * ((margin + improvement) / 100);
    const additionalAnnual = revenue * (improvement / 100) * 12;
    const valuationUplift = additionalAnnual * 3;

    const revenueOutput = $("#calc-revenue-out");
    const marginOutput = $("#calc-margin-out");
    const improvementOutput = $("#calc-improvement-out");
    const newProfitOutput = $("[data-calc-new-profit]");
    const annualOutput = $("[data-calc-annual]");
    const valuationOutput = $("[data-calc-valuation]");

    if (revenueOutput) revenueOutput.textContent = money.format(revenue);
    if (marginOutput) marginOutput.textContent = `${margin.toFixed(1)}%`;
    if (improvementOutput) improvementOutput.textContent = `+${improvement.toFixed(1)} pts`;
    if (newProfitOutput) newProfitOutput.textContent = money.format(newMonthlyProfit);
    if (annualOutput) annualOutput.textContent = money.format(additionalAnnual);
    if (valuationOutput) valuationOutput.textContent = money.format(valuationUplift);

    [calcRevenue, calcMargin, calcImprovement].forEach(updateRangeFill);
  }

  function saveCalculator() {
    const { revenue, margin, improvement } = calcValues();
    storage.set("pgc_calc", JSON.stringify({ revenue, margin, improvement }));
  }

  function restoreCalculator() {
    if (!calcRevenue || !calcMargin || !calcImprovement) return;
    try {
      const saved = JSON.parse(storage.get("pgc_calc") || "null");
      if (saved && Number(saved.revenue) > 0) {
        calcRevenue.value = String(saved.revenue);
        calcMargin.value = String(saved.margin);
        calcImprovement.value = String(saved.improvement);
      }
    } catch {
      /* Ignore malformed storage. */
    }
  }

  function openCalculator() {
    if (!calculator) return;
    if (menuOpen) setMenu(false);

    if (typeof calculator.showModal === "function") {
      if (!calculator.open) calculator.showModal();
    } else {
      calculator.setAttribute("open", "");
    }

    document.body.classList.add("modal-open");
    updateCalculator();
  }

  function closeCalculator() {
    if (!calculator) return;
    if (typeof calculator.close === "function" && calculator.open) {
      calculator.close();
    } else {
      calculator.removeAttribute("open");
      document.body.classList.remove("modal-open");
    }
  }

  if (calculator) {
    restoreCalculator();
    updateCalculator();

    [calcRevenue, calcMargin, calcImprovement].forEach((input) => {
      if (!input) return;
      input.addEventListener("input", () => {
        updateCalculator();
        saveCalculator();
      });
    });

    $$("[data-open-calculator]").forEach((trigger) => {
      trigger.addEventListener("click", openCalculator);
    });

    $$("[data-close-calculator]").forEach((button) => {
      button.addEventListener("click", closeCalculator);
    });

    calculator.addEventListener("close", () => {
      document.body.classList.remove("modal-open");
    });

    calculator.addEventListener("click", (event) => {
      if (event.target !== calculator) return;
      const box = calculator.getBoundingClientRect();
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (!inside) closeCalculator();
    });

    const calcEmailForm = $("[data-calc-email]");
    if (calcEmailForm) {
      const calcEmail = $("#calc-email");
      const calcStatus = $("[data-calc-email-status]");
      const calcEmailButton = calcEmailForm.querySelector('button[type="submit"]');

      calcEmailForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!calcEmail) return;
        const email = calcEmail.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
          if (calcStatus) {
            calcStatus.textContent = "Enter a valid email address.";
            calcStatus.classList.add("is-error");
          }
          calcEmail.focus();
          return;
        }

        if (calcEmailButton) calcEmailButton.disabled = true;
        if (calcStatus) {
          calcStatus.textContent = "Sending…";
          calcStatus.classList.remove("is-error");
        }

        try {
          const { revenue, margin, improvement } = calcValues();
          const response = await fetch(CONFIG.subscribeEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              email,
              source: `calculator:${revenue}:${margin}:${improvement}`,
              page: landingPage(),
              sessionId,
            }),
          });
          if (!response.ok) throw new Error("Request failed");
          if (calcStatus) calcStatus.textContent = "Sent. Check your inbox for the breakdown.";
          calcEmail.value = "";
          track("calculator_email", { revenue, improvement });
        } catch {
          if (calcStatus) {
            calcStatus.textContent = `Couldn't send that. Email ${CONFIG.contactEmail} and we'll send it over.`;
            calcStatus.classList.add("is-error");
          }
        } finally {
          if (calcEmailButton) calcEmailButton.disabled = false;
        }
      });
    }

    const calcCta = $("[data-calc-cta]");
    if (calcCta) {
      calcCta.addEventListener("click", (event) => {
        event.preventDefault();
        const { revenue, margin, improvement } = calcValues();
        prefillApplication({
          revenue: revenueOptionFor(revenue),
          outcome: `Calculator estimate: $${Math.round(revenue).toLocaleString("en-US")}/month revenue at ${margin.toFixed(
            1
          )}% net margin, targeting +${improvement.toFixed(1)} margin points. I'd like a plan to get there.`,
        });
        closeCalculator();
        window.setTimeout(() => scrollToApplication(), 60);
      });
    }
  }

  /* ------------------------------------------------------------------
     Profit leak scorecard
     ------------------------------------------------------------------ */
  const scorecard = $("[data-scorecard]");
  const scoreRevenue = $("[data-score-revenue]");
  const leakInputs = $$("[data-leak]");
  const scoreAmount = $("[data-score-amount]");
  const scoreFull = $("[data-score-full]");
  const scoreHalf = $("[data-score-half]");
  const scorePoints = $("[data-score-points]");
  const scoreSelected = $("[data-score-selected]");
  const scoreSub = $("[data-score-sub]");
  const scoreMeter = $("[data-score-meter]");
  let scoreStarted = false;
  let scoreCompleted = false;

  function scoreState() {
    const revenue = Math.max(0, Number(scoreRevenue ? scoreRevenue.value : 0) || 0);
    const selected = leakInputs.filter((input) => input.checked);
    const points = selected.reduce((total, input) => total + Number(input.dataset.points || 0), 0);
    return {
      revenue,
      selected,
      points,
      full: revenue * 12 * (points / 100),
      half: revenue * 12 * (points / 100) * 0.5,
    };
  }

  function scoreMessage(points) {
    if (points <= 0) return "Select the leaks you recognise to see your number.";
    if (points < 2) return "A small leak — but it compounds on every order.";
    if (points < 3.5) return "This is usually $10k–$40k a year hiding in plain sight.";
    if (points < 5) return "That is a meaningful margin problem worth fixing this quarter.";
    return "This is the pattern we see in stores that are growing revenue but losing profit.";
  }

  function updateScorecard({ persist = true } = {}) {
    if (!scorecard) return;
    const state = scoreState();
    const count = state.selected.length;

    if (scoreAmount) scoreAmount.textContent = state.points > 0 ? moneyShort(state.half) : "$0";
    if (scoreFull) scoreFull.textContent = moneyShort(state.full);
    if (scoreHalf) scoreHalf.textContent = moneyShort(state.half);
    if (scorePoints) scorePoints.textContent = `${state.points.toFixed(1)} pts`;
    if (scoreSelected) scoreSelected.textContent = `${count} of ${leakInputs.length} leaks selected`;
    if (scoreSub) scoreSub.textContent = scoreMessage(state.points);
    if (scoreMeter) scoreMeter.style.width = `${Math.min(100, (state.points / 6.3) * 100)}%`;

    if (persist) {
      storage.sessionSet(
        "pgc_score",
        JSON.stringify({
          revenue: state.revenue,
          leaks: state.selected.map((input) => input.value),
        })
      );
    }

    if (count > 0 && !scoreStarted) {
      scoreStarted = true;
      track("scorecard_start", { leaks: count });
    }
    if (count >= 2 && !scoreCompleted) {
      scoreCompleted = true;
      track("scorecard_complete", {
        leaks: count,
        points: state.points,
        revenue: state.revenue,
        estimate: Math.round(state.half),
      });
    }
  }

  function restoreScorecard() {
    if (!scorecard) return;
    try {
      const saved = JSON.parse(storage.sessionGet("pgc_score") || "null");
      if (!saved) return;
      if (saved.revenue && scoreRevenue) scoreRevenue.value = String(saved.revenue);
      leakInputs.forEach((input) => {
        input.checked = Array.isArray(saved.leaks) && saved.leaks.includes(input.value);
      });
    } catch {
      /* Ignore malformed storage. */
    }
  }

  if (scorecard) {
    restoreScorecard();
    updateScorecard({ persist: false });

    if (scoreRevenue) {
      scoreRevenue.addEventListener("input", () => updateScorecard());
      scoreRevenue.addEventListener("blur", () => {
        const value = Math.min(10000000, Math.max(10000, Number(scoreRevenue.value) || 150000));
        if (String(value) !== scoreRevenue.value) scoreRevenue.value = String(value);
        updateScorecard();
      });
    }

    leakInputs.forEach((input) => {
      input.addEventListener("change", () => updateScorecard());
    });

    const scoreCta = $("[data-score-cta]");
    if (scoreCta) {
      scoreCta.addEventListener("click", () => {
        const state = scoreState();
        const labels = state.selected.map((input) => {
          const copy = input.closest(".leak-option");
          const title = copy ? copy.querySelector("strong") : null;
          return (title ? title.textContent : input.value).trim();
        });
        const value = state.selected.map((input) => input.value).join(",");
        const scoreField = $("[data-scorecard-field]");
        if (scoreField) scoreField.value = value;

        const outcome =
          state.points > 0
            ? `My profit check flagged ${labels.join(", ")}. Estimated annual opportunity: ${moneyShort(
                state.half
              )} (${state.points.toFixed(1)} margin points). I'd like to fix the biggest leaks first.`
            : "I'd like to find out where my profit is leaking and what to fix first.";

        prefillApplication({
          revenue: state.revenue ? revenueOptionFor(state.revenue) : "",
          challenge: "Declining profit margins",
          goal: "Increase net profit",
          outcome,
        });
        scrollToApplication();
      });
    }
  }

  /* ------------------------------------------------------------------
     Audit application form
     ------------------------------------------------------------------ */
  const form = $("[data-audit-form]");
  let formLoadedAt = Date.now();

  function scrollToApplication() {
    const section = $("#apply");
    if (!section) return;
    section.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  function prefillApplication({ revenue, challenge, goal, outcome, program } = {}) {
    if (!form) return;
    if (revenue) selectValue($("#revenue"), revenue);
    if (challenge) selectValue($("#challenge"), challenge);
    if (goal) {
      const radio = Array.from(form.querySelectorAll('input[name="goal"]')).find(
        (input) => input.value === goal
      );
      if (radio) radio.checked = true;
    }
    if (program) {
      const programField = $("[data-program-field]", form);
      if (programField) programField.value = program;
    }
    const outcomes = $("#outcomes");
    if (outcomes && outcome && !outcomes.value.trim()) {
      outcomes.value = outcome;
    }
    if (outcomes && outcome && program && outcomes.value.trim()) {
      // Keep the applicant's own words, but preserve the program context.
      const programField = $("[data-program-field]", form);
      if (programField && !programField.value) programField.value = program;
    }
    saveDraftHook();
    window.setTimeout(() => {
      const first = $("#full-name");
      if (first) first.focus({ preventScroll: true });
    }, reduceMotion ? 0 : 420);
  }

  if (form) {
    const steps = $$("[data-step]", form);
    const progress = $(".form-progress", form);
    const progressTrack = $(".progress-track", form);
    const progressFill = $("[data-progress-fill]", form);
    const stepLabel = $("[data-step-label]", form);
    const stepName = $("[data-step-name]", form);
    const stepAnnouncement = $("[data-step-announcement]", form);
    const successPanel = $("[data-success]", form);
    const nextButton = $("[data-next]", form);
    const backButton = $("[data-back]", form);
    const submitButton = $("[data-submit]", form);
    const submitLabel = $("[data-submit-label]", form);
    const goalField = $("[data-goal-field]", form);
    const goalError = goalField ? goalField.querySelector(".field-error") : null;
    const alertBox = $("[data-form-alert]", form);
    const alertTitle = $("[data-form-alert-title]", form);
    const alertMessage = $("[data-form-alert-message]", form);
    const alertMail = $("[data-form-alert-mail]", form);
    const elapsedField = $("[data-elapsed]", form);
    const honeypot = $("[data-honeypot]", form);

    let step = 1;
    let submitting = false;
    let formStarted = false;
    const savedDraft = readDraft();

    const stepNames = { 1: "About your store", 2: "Your goals" };

    // Populate hidden attribution fields.
    const pageField = $("[data-page]", form);
    const referrerField = $("[data-referrer]", form);
    const sessionField = $("[data-session]", form);
    if (pageField) pageField.value = landingPage();
    if (referrerField) referrerField.value = (document.referrer || "").slice(0, 500);
    if (sessionField) sessionField.value = sessionId;
    utmKeys.forEach((key) => {
      const field = $(`[data-utm-${key}]`, form);
      if (field) field.value = utm[key] || "";
    });

    // Connect error text to controls for assistive tech.
    $$(".field", form).forEach((field) => {
      const control = field.querySelector("input:not([type=radio]):not([type=checkbox]), select, textarea");
      const error = field.querySelector(".field-error");
      if (control && error && control.name) {
        error.id = `${control.name}-error`;
        control.setAttribute("aria-describedby", error.id);
      }
    });

    function readDraft() {
      if (CONFIG.draftStorage === "none") return null;
      const raw =
        CONFIG.draftStorage === "session"
          ? storage.sessionGet("pgc_draft")
          : storage.get("pgc_draft");
      if (!raw) return null;
      try {
        const draft = JSON.parse(raw);
        if (!draft || !draft.savedAt) return null;
        if (Date.now() - draft.savedAt > 1000 * 60 * 60 * 24 * 14) {
          storage.remove("pgc_draft");
          return null;
        }
        return draft;
      } catch {
        return null;
      }
    }

    function draftData() {
      const data = {};
      $$("input, select, textarea", form).forEach((control) => {
        if (!control.name || control.type === "radio" || control.type === "checkbox") return;
        if (control === honeypot) return;
        if (control.value) data[control.name] = control.value;
      });
      const goal = form.querySelector('input[name="goal"]:checked');
      if (goal) data.goal = goal.value;
      return data;
    }

    saveDraftHook = () => saveDraft();

    function saveDraft() {
      if (CONFIG.draftStorage === "none" || submitting) return;
      if (successPanel && !successPanel.hidden) return;
      const payload = JSON.stringify({ savedAt: Date.now(), data: draftData() });
      if (CONFIG.draftStorage === "session") storage.sessionSet("pgc_draft", payload);
      else storage.set("pgc_draft", payload);
    }

    let draftTimer = 0;
    function saveDraftSoon() {
      window.clearTimeout(draftTimer);
      draftTimer = window.setTimeout(saveDraft, 350);
    }

    function clearDraft() {
      storage.remove("pgc_draft");
      storage.sessionSet("pgc_draft", "");
    }

    if (savedDraft && savedDraft.data) {
      Object.entries(savedDraft.data).forEach(([name, value]) => {
        if (name === "goal") {
          const radio = Array.from(form.querySelectorAll('input[name="goal"]')).find(
            (input) => input.value === value
          );
          if (radio) radio.checked = true;
          return;
        }
        const control = form.elements.namedItem(name);
        if (control && typeof control.value !== "undefined" && !control.value) {
          control.value = value;
        }
      });
      // A restored draft should never trip the bot timing check.
      formLoadedAt = Date.now() - 10000;
    }

    $$("input, select, textarea", form).forEach((control) => {
      if (control.type === "hidden") return;
      control.addEventListener("input", saveDraftSoon);
      control.addEventListener("change", saveDraftSoon);
    });

    function markStarted() {
      if (formStarted) return;
      formStarted = true;
      track("form_start");
    }

    form.addEventListener("focusin", markStarted);
    form.addEventListener("pointerdown", markStarted);

    function showStep(stepNumber) {
      step = stepNumber;
      steps.forEach((item) => {
        item.hidden = Number(item.dataset.step) !== stepNumber;
      });

      if (stepLabel) stepLabel.textContent = `Step ${stepNumber} of 2`;
      if (stepName) stepName.textContent = stepNames[stepNumber];
      if (progressFill) progressFill.style.width = `${stepNumber * 50}%`;
      if (progressTrack) progressTrack.setAttribute("aria-valuenow", String(stepNumber * 50));
      if (stepAnnouncement) {
        stepAnnouncement.textContent = `Step ${stepNumber} of 2. ${stepNames[stepNumber]}.`;
      }

      const activeStep = steps.find((item) => Number(item.dataset.step) === stepNumber);
      const firstControl = activeStep
        ? activeStep.querySelector("input:not([type=radio]):not([type=checkbox]), select, textarea")
        : null;

      if (firstControl) {
        window.setTimeout(() => firstControl.focus({ preventScroll: true }), 80);
      }
      saveDraftSoon();
    }

    function getFieldWrap(control) {
      return control.closest(".field");
    }

    function showFieldError(control, message) {
      const wrap = getFieldWrap(control);
      if (!wrap) return;
      wrap.classList.add("has-error");
      control.setAttribute("aria-invalid", "true");
      const error = wrap.querySelector(".field-error");
      if (error) error.textContent = message || control.dataset.error || "Please check this field.";
    }

    function clearFieldError(control) {
      const wrap = getFieldWrap(control);
      if (!wrap) return;
      wrap.classList.remove("has-error");
      control.removeAttribute("aria-invalid");
      const error = wrap.querySelector(".field-error");
      if (error) error.textContent = "";
    }

    function isValidUrl(value) {
      try {
        const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
        return (
          url.hostname.includes(".") &&
          !/\s/.test(value) &&
          !/^(javascript|data|file):/i.test(value) &&
          url.hostname !== "localhost"
        );
      } catch {
        return false;
      }
    }

    function validateControl(control) {
      // Hidden fields (program, scorecard, attribution, honeypot) are metadata,
      // never user-facing answers, so they must not block submission.
      if (control.type === "hidden") return true;

      const value = String(control.value || "").trim();
      let message = "";

      if (control.type === "checkbox") {
        if (!control.checked) message = control.dataset.error || "Please check this box.";
      } else if (!value) {
        message = control.dataset.error || "This field is required.";
      } else if (control.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        message = "Enter a valid email address.";
      } else if (control.name === "fullName" && value.length < 2) {
        message = "Enter your full name.";
      } else if (control.name === "storeUrl" && !isValidUrl(value)) {
        message = "Enter your store URL (e.g. yourstore.com).";
      } else if (control.tagName === "TEXTAREA" && value.length < 10) {
        message = "Tell us a little more (at least 10 characters).";
      }

      if (message) {
        showFieldError(control, message);
        return false;
      }

      clearFieldError(control);
      return true;
    }

    function validateGoals() {
      const checked = form.querySelector('input[name="goal"]:checked');
      if (checked) {
        if (goalField) goalField.classList.remove("has-error");
        if (goalError) goalError.textContent = "";
        return true;
      }

      if (goalField) goalField.classList.add("has-error");
      if (goalError) goalError.textContent = "Choose one focus for your business.";
      return false;
    }

    function focusFirstInvalid() {
      const invalid = form.querySelector(
        ".has-error input, .has-error select, .has-error textarea"
      );
      if (invalid) invalid.focus({ preventScroll: false });
    }

    function hideAlert() {
      if (alertBox) alertBox.hidden = true;
    }

    function showAlert(title, message, emailBody) {
      if (!alertBox) return;
      alertTitle.textContent = title;
      alertMessage.textContent = message;
      if (alertMail) {
        const subject = encodeURIComponent("Profit audit application");
        const body = encodeURIComponent(emailBody || "Hi, I'd like to apply for a profit audit.");
        alertMail.href = `mailto:${CONFIG.contactEmail}?subject=${subject}&body=${body}`;
      }
      alertBox.hidden = false;
      alertBox.focus({ preventScroll: true });
    }

    $$("input, select, textarea", form).forEach((control) => {
      const clear = () => {
        if (control.type === "radio") {
          if (goalField) goalField.classList.remove("has-error");
          if (goalError) goalError.textContent = "";
        } else if (control.type === "checkbox" || String(control.value || "").trim()) {
          clearFieldError(control);
        }
      };
      control.addEventListener("input", clear);
      control.addEventListener("change", clear);
      if (control.type !== "hidden" && control.type !== "radio") {
        control.addEventListener("blur", () => {
          if (!String(control.value || "").trim() && !control.required) return;
          if (control.type === "checkbox" && !control.checked) return;
          validateControl(control);
        });
      }
    });

    if (nextButton) {
      nextButton.addEventListener("click", () => {
        markStarted();
        const stepOneControls = $$(
          "input:not([type=radio]):not([type=checkbox]):not([type=hidden]), select, textarea",
          steps[0]
        );
        let valid = true;

        stepOneControls.forEach((control) => {
          if (!validateControl(control)) valid = false;
        });

        if (!valid) {
          searchForErrors();
          return;
        }

        hideAlert();
        showStep(2);
        track("form_step", { step: 2 });
      });
    }

    if (backButton) {
      backButton.addEventListener("click", () => {
        hideAlert();
        showStep(1);
        track("form_step", { step: 1 });
      });
    }

    function searchForErrors() {
      const invalid = form.querySelector(".has-error input, .has-error select, .has-error textarea");
      if (invalid) {
        invalid.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
        invalid.focus({ preventScroll: true });
      }
    }

    function buildPayload() {
      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());
      payload.utm = {};
      utmKeys.forEach((key) => {
        const value = formData.get(`utm_${key}`);
        if (value) payload.utm[key] = value;
        delete payload[`utm_${key}`];
      });
      payload.consent = formData.get("consent") === "yes";
      payload.scorecard = String(formData.get("scorecard") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      payload.elapsedMs = Date.now() - formLoadedAt;
      payload.page = landingPage();
      payload.sessionId = sessionId;
      return payload;
    }

    function emailFallbackBody(payload) {
      return [
        "Hi, I'd like to apply for a profit audit.",
        "",
        `Name: ${payload.fullName || ""}`,
        `Email: ${payload.email || ""}`,
        `Store: ${payload.storeUrl || ""}`,
        `Revenue: ${payload.revenue || ""}`,
        `Platform: ${payload.platform || ""}`,
        `Challenge: ${payload.challenge || ""}`,
        `Goal: ${payload.goal || ""}`,
        "",
        "Outcomes:",
        payload.outcomes || "",
      ].join("\n");
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submitting) return;
      markStarted();

      const stepTwo = steps.find((item) => Number(item.dataset.step) === 2);
      const stepTwoControls = stepTwo
        ? $$(
            "input:not([type=radio]):not([type=checkbox]):not([type=hidden]), select, textarea",
            stepTwo
          )
        : [];
      let valid = true;

      stepTwoControls.forEach((control) => {
        if (!validateControl(control)) valid = false;
      });

      const consent = $("#consent", form);
      if (consent && !validateControl(consent)) valid = false;
      if (!validateGoals()) valid = false;

      if (honeypot && honeypot.value) {
        valid = false;
      }

      if (!valid) {
        showAlert("Please check the highlighted fields.", "A few answers are missing or invalid. You won't lose anything you've typed.");
        searchForErrors();
        track("form_error", { reason: "validation" });
        return;
      }

      submitting = true;
      hideAlert();
      const payload = buildPayload();
      if (elapsedField) elapsedField.value = String(payload.elapsedMs);

      if (submitButton) {
        submitButton.disabled = true;
        submitButton.setAttribute("aria-busy", "true");
        submitButton.classList.add("is-loading");
      }
      if (submitLabel) submitLabel.textContent = "Sending application…";

      try {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 16000);
        let response;
        try {
          response = await fetch(CONFIG.leadEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } finally {
          window.clearTimeout(timeout);
        }

        let data = {};
        try {
          data = await response.json();
        } catch {
          data = {};
        }

        if (!response.ok) {
          const errors = data.errors || {};
          Object.entries(errors).forEach(([name, message]) => {
            if (name === "_spam") return;
            if (name === "goal") {
              if (goalField) goalField.classList.add("has-error");
              if (goalError) goalError.textContent = String(message);
              return;
            }
            const control = form.elements.namedItem(name);
            if (control && typeof control.closest === "function") {
              showFieldError(control, String(message));
            }
          });
          if (errors._spam) {
            throw new Error("Submission rejected. Please email us directly.");
          }
          const message =
            data.message || "Something went wrong on our side. Your answers are saved — please try again.";
          showAlert("We couldn't submit that.", message, emailFallbackBody(payload));
          searchForErrors();
          track("form_error", { reason: `http_${response.status}` });
          return;
        }

        showSuccess(payload);
      } catch (error) {
        const message =
          window.location.protocol === "file:"
            ? "This page is open as a local file, so there is no server to receive your application. Run python3 server.py and open http://127.0.0.1:4173 — or email us directly and we'll reply within 24–48 hours."
            : error && error.name === "AbortError"
              ? "The request timed out. Your answers are saved — please try again or email us."
              : "We couldn't reach the server. Your answers are saved — check your connection and try again, or email us directly.";
        showAlert("We couldn't submit that.", message, emailFallbackBody(payload));
        track("form_error", { reason: error && error.name ? error.name : "network" });
      } finally {
        submitting = false;
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.removeAttribute("aria-busy");
          submitButton.classList.remove("is-loading");
        }
        if (submitLabel) submitLabel.textContent = "Submit application";
      }
    });

    function showSuccess(payload) {
      const firstName = String(payload.fullName || "").trim().split(/\s+/)[0];
      const email = String(payload.email || "").trim();

      steps.forEach((item) => {
        item.hidden = true;
      });
      if (progress) progress.hidden = true;
      hideAlert();

      const successFirstName = $("[data-success-first]", form);
      const successEmail = $("[data-success-email]", form);
      if (successFirstName && firstName) successFirstName.textContent = `, ${firstName}`;
      if (successEmail) successEmail.textContent = email;

      if (stepAnnouncement) {
        stepAnnouncement.textContent =
          "Application submitted successfully. We'll reply within 24 to 48 hours.";
      }

      if (successPanel) {
        successPanel.hidden = false;
        successPanel.setAttribute("tabindex", "-1");
        successPanel.focus({ preventScroll: true });
        successPanel.scrollIntoView({
          behavior: reduceMotion ? "auto" : "smooth",
          block: "center",
        });
      }

      clearDraft();
      form.reset();
      track("form_submit", {
        revenue: payload.revenue,
        platform: payload.platform,
        challenge: payload.challenge,
        goal: payload.goal,
        scorecard: payload.scorecard.length,
      });
    }
  }

  /* ------------------------------------------------------------------
     Program prefill
     ------------------------------------------------------------------ */
  $$("[data-program]").forEach((link) => {
    link.addEventListener("click", () => {
      const program = link.getAttribute("data-program") || "";
      if (!form || !program) return;
      const programField = $("[data-program-field]", form);
      if (programField) programField.value = program;
      const outcomes = $("#outcomes");
      if (outcomes && !outcomes.value.trim()) {
        outcomes.value = `I'm interested in the ${program} program. My main goal is to increase net profit.`;
      }
      saveDraftHook();
    });
  });

  /* ------------------------------------------------------------------
     Newsletter
     ------------------------------------------------------------------ */
  $$("[data-newsletter]").forEach((newsletter) => {
    const input = newsletter.querySelector('input[type="email"]');
    const status = newsletter.querySelector("[data-newsletter-status]");
    const button = newsletter.querySelector('button[type="submit"]');
    if (!input || !status) return;

    input.addEventListener("input", () => {
      if (!input.classList.contains("is-invalid")) return;
      input.classList.remove("is-invalid");
      input.removeAttribute("aria-invalid");
      status.textContent = "";
      status.classList.remove("is-error");
    });

    newsletter.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = input.value.trim();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        input.classList.add("is-invalid");
        input.setAttribute("aria-invalid", "true");
        status.textContent = "Please enter a valid email address.";
        status.classList.add("is-error");
        input.focus();
        return;
      }

      if (button) button.disabled = true;
      status.classList.remove("is-error");
      status.textContent = "Subscribing…";

      try {
        const response = await fetch(CONFIG.subscribeEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            email: value,
            source: "footer",
            page: landingPage(),
            sessionId,
          }),
        });
        if (!response.ok) throw new Error("Request failed");
        input.classList.remove("is-invalid");
        input.value = "";
        status.textContent = "You're in. Watch your inbox for the next profit tip.";
        track("newsletter_submit", { source: "footer" });
      } catch {
        status.classList.add("is-error");
        status.textContent = "Couldn't subscribe right now. Please try again in a moment.";
        track("form_error", { reason: "newsletter" });
      } finally {
        if (button) button.disabled = false;
      }
    });
  });

  /* ------------------------------------------------------------------
     Misc
     ------------------------------------------------------------------ */
  const year = $("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());

  // Page context for first-party analytics.
  let referrerHost = "direct";
  try {
    if (document.referrer) referrerHost = new URL(document.referrer).hostname.slice(0, 80);
  } catch {
    referrerHost = "unknown";
  }
  track("page_view", {
    referrer: referrerHost,
    landing: landingPage().slice(0, 120),
  });

  // If this file arrived after the no-JS fallback timer fired, restore the
  // enhanced presentation before signalling readiness.
  document.documentElement.classList.remove("no-js");
  document.documentElement.classList.add("js");

  // Signal that the enhancement layer is running.
  window.__pgcReady = true;
})();
