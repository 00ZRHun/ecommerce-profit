/**
 * Runtime configuration.
 *
 * Edit this file, not script.js, to point the funnel at your booking calendar
 * or a different form backend. Everything is optional.
 */
window.PGC_CONFIG = {
  // Where audit applications and newsletter signups are sent.
  // Leave these as-is to use the bundled server (server.py).
  leadEndpoint: "/api/lead",
  subscribeEndpoint: "/api/subscribe",
  eventEndpoint: "/api/event",

  // Optional scheduling link (Calendly, SavvyCal, Cal.com, etc.).
  // When empty, "book a call" buttons open an email draft instead.
  bookingUrl: "",

  contactEmail: "hello@profitgrowthcoaching.com",

  // First-party, cookie-free funnel analytics. Set to false to disable.
  analytics: true,

  // Scroll depth events at these percentages.
  scrollDepth: [25, 50, 75, 90],

  // Matches MIN_FORM_SECONDS on the server. Used for spam protection only.
  minFormFillMs: 2500,

  // Where to keep an unfinished application. Set to "session" for tab-only
  // storage, "local" to survive a browser restart, or "none" to disable.
  draftStorage: "local",
};
