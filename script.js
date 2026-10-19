/**
 * Profit Growth Coaching — interactions
 * No dependencies. Progressive enhancement only.
 */
(() => {
  "use strict";

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

  let scrollQueued = false;
  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    window.requestAnimationFrame(() => {
      updateHeader();
      updateActiveNav();
      scrollQueued = false;
    });
  }

  updateHeader();
  updateActiveNav();
  window.addEventListener("scroll", onScroll, { passive: true });

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
      }
    });

    const desktopQuery = window.matchMedia("(min-width: 1025px)");
    desktopQuery.addEventListener("change", (event) => {
      if (event.matches && menuOpen) setMenu(false);
    });
  }

  /* ------------------------------------------------------------------
     Scroll reveal
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

  /* ------------------------------------------------------------------
     Animated counters
     ------------------------------------------------------------------ */
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
     FAQ accordion
     ------------------------------------------------------------------ */
  const faqButtons = $$(".faq-question");

  faqButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const item = button.closest(".faq-item");
      if (!item) return;
      const answer = item.querySelector(".faq-answer");
      const wasOpen = item.classList.contains("is-open");

      $$(".faq-item.is-open").forEach((openItem) => {
        openItem.classList.remove("is-open");
        const openButton = openItem.querySelector(".faq-question");
        const openAnswer = openItem.querySelector(".faq-answer");
        if (openButton) openButton.setAttribute("aria-expanded", "false");
        if (openAnswer) openAnswer.setAttribute("aria-hidden", "true");
      });

      if (!wasOpen) {
        item.classList.add("is-open");
        button.setAttribute("aria-expanded", "true");
        if (answer) answer.setAttribute("aria-hidden", "false");
      }
    });
  });

  /* ------------------------------------------------------------------
     Profit calculator
     ------------------------------------------------------------------ */
  const calculator = $("#profit-calculator");
  const calcRevenue = $("#calc-revenue");
  const calcMargin = $("#calc-margin");
  const calcImprovement = $("#calc-improvement");

  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

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

    const revenue = Number(calcRevenue.value);
    const margin = Number(calcMargin.value);
    const improvement = Number(calcImprovement.value);

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
    updateCalculator();

    [calcRevenue, calcMargin, calcImprovement].forEach((input) => {
      if (!input) return;
      input.addEventListener("input", updateCalculator);
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

    const calcCta = $("[data-calc-cta]");
    if (calcCta) calcCta.addEventListener("click", closeCalculator);
  }

  /* ------------------------------------------------------------------
     Audit application form
     ------------------------------------------------------------------ */
  const form = $("#audit-form");

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
    const goalField = $("[data-goal-field]", form);
    const goalError = goalField ? goalField.querySelector(".field-error") : null;

    const stepNames = { 1: "About your store", 2: "Your goals" };

    // Connect help text to controls for assistive tech.
    $$(".field", form).forEach((field) => {
      const control = field.querySelector("input:not([type=radio]), select, textarea");
      const error = field.querySelector(".field-error");
      if (control && error && control.name) {
        error.id = `${control.name}-error`;
        control.setAttribute("aria-describedby", error.id);
      }
    });

    function showStep(stepNumber) {
      steps.forEach((step) => {
        step.hidden = Number(step.dataset.step) !== stepNumber;
      });

      if (stepLabel) stepLabel.textContent = `Step ${stepNumber} of 2`;
      if (stepName) stepName.textContent = stepNames[stepNumber];
      if (progressFill) progressFill.style.width = `${stepNumber * 50}%`;
      if (progressTrack) progressTrack.setAttribute("aria-valuenow", String(stepNumber * 50));
      if (stepAnnouncement) {
        stepAnnouncement.textContent = `Step ${stepNumber} of 2. ${stepNames[stepNumber]}.`;
      }

      const activeStep = steps.find((step) => Number(step.dataset.step) === stepNumber);
      const firstControl = activeStep
        ? activeStep.querySelector("input:not([type=radio]), select, textarea")
        : null;

      if (firstControl) {
        window.setTimeout(() => firstControl.focus({ preventScroll: true }), 80);
      }
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
        return url.hostname.includes(".") && !/\s/.test(value);
      } catch {
        return false;
      }
    }

    function validateControl(control) {
      const value = String(control.value || "").trim();
      let message = "";

      if (!value) {
        message = control.dataset.error || "This field is required.";
      } else if (control.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        message = "Enter a valid email address.";
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
      const invalid = form.querySelector(".has-error input, .has-error select, .has-error textarea");
      if (invalid) invalid.focus({ preventScroll: false });
    }

    $$("input, select, textarea", form).forEach((control) => {
      const clear = () => {
        if (control.type === "radio") {
          if (goalField) goalField.classList.remove("has-error");
          if (goalError) goalError.textContent = "";
        } else if (String(control.value || "").trim()) {
          clearFieldError(control);
        }
      };
      control.addEventListener("input", clear);
      control.addEventListener("change", clear);
    });

    if (nextButton) {
      nextButton.addEventListener("click", () => {
        const stepOneControls = $$("input, select, textarea", steps[0]);
        let valid = true;

        stepOneControls.forEach((control) => {
          if (!validateControl(control)) valid = false;
        });

        if (!valid) {
          focusFirstInvalid();
          return;
        }

        showStep(2);
      });
    }

    if (backButton) {
      backButton.addEventListener("click", () => {
        showStep(1);
      });
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      const stepTwo = steps.find((step) => Number(step.dataset.step) === 2);
      const stepTwoControls = stepTwo ? $$("input:not([type=radio]), select, textarea", stepTwo) : [];
      let valid = true;

      stepTwoControls.forEach((control) => {
        if (!validateControl(control)) valid = false;
      });

      if (!validateGoals()) valid = false;

      if (!valid) {
        focusFirstInvalid();
        return;
      }

      const nameControl = form.querySelector('[name="fullName"]');
      const emailControl = form.querySelector('[name="email"]');
      const firstName = nameControl ? String(nameControl.value).trim().split(/\s+/)[0] : "";
      const email = emailControl ? String(emailControl.value).trim() : "";

      steps.forEach((step) => {
        step.hidden = true;
      });
      if (progress) progress.hidden = true;

      const successFirstName = $("[data-success-first]", form);
      const successEmail = $("[data-success-email]", form);
      if (successFirstName && firstName) successFirstName.textContent = `, ${firstName}`;
      if (successEmail) successEmail.textContent = email;

      if (stepAnnouncement) {
        stepAnnouncement.textContent = "Application submitted successfully. We'll reply within 24 to 48 hours.";
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
    });
  }

  /* ------------------------------------------------------------------
     Newsletter
     ------------------------------------------------------------------ */
  $$("[data-newsletter]").forEach((newsletter) => {
    const input = newsletter.querySelector('input[type="email"]');
    const status = newsletter.querySelector("[data-newsletter-status]");
    if (!input || !status) return;

    input.addEventListener("input", () => {
      if (!input.classList.contains("is-invalid")) return;
      input.classList.remove("is-invalid");
      status.textContent = "";
    });

    newsletter.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        input.classList.add("is-invalid");
        status.style.color = "#ff9d9d";
        status.textContent = "Please enter a valid email address.";
        input.focus();
        return;
      }

      input.classList.remove("is-invalid");
      status.style.color = "";
      status.textContent = "You're in. Watch your inbox for the next profit tip.";
      input.value = "";
    });
  });

  /* ------------------------------------------------------------------
     Misc
     ------------------------------------------------------------------ */
  const year = $("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());

  // Signal that the enhancement layer is running.
  window.__pgcReady = true;
})();
