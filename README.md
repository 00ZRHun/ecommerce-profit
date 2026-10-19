# Profit Growth Coaching — ecommerce profit funnel

A production-ready marketing funnel and lead-capture backend for an ecommerce
profit-coaching business. Static HTML/CSS/JS on the front, a **zero-dependency
Python standard-library server** for the API, lead storage and first-party
analytics on the back.

No Node, no npm, no framework, no third-party trackers, no build step.

---

## Table of contents

- [What is in the box](#what-is-in-the-box)
- [Quickstart](#quickstart)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Pages and sections](#pages-and-sections)
- [API reference](#api-reference)
- [Managing leads](#managing-leads)
- [Analytics](#analytics)
- [Testing](#testing)
- [Deployment](#deployment)
- [Performance, SEO and accessibility](#performance-seo-and-accessibility)
- [Security](#security)
- [Before you go live: replace these placeholders](#before-you-go-live-replace-these-placeholders)
- [License](#license)

---

## What is in the box

**Front end**

- A conversion-focused landing page: announcement bar, hero with proof, problem
  section, six profit levers, interactive **profit-leak scorecard**, results and
  client snapshots, testimonials, five-step process, three programs with
  best-fit labels, comparison table, fit / not-fit qualifiers, founder section,
  two-step application form, nine-question FAQ, final CTA and a rich footer.
- An accessible **profit calculator** dialog with an optional email capture.
- A first-party, **cookie-free analytics** layer: `page_view`, CTA and nav
  clicks, scroll depth, scorecard completion, form start/submit/error,
  newsletter, calculator and booking events.
- **Progressive enhancement**: the page is fully readable and the form fully
  submittable with JavaScript disabled. With JS on you additionally get
  validation, drafts, the calculator, the scorecard and inline success states.
- Self-hosted variable fonts (Inter + Manrope, latin + latin-ext). No Google
  Fonts, no external requests at all.
- Full SEO head: canonical, Open Graph, Twitter card, `sitemap.xml`,
  `robots.txt`, `site.webmanifest`, and a rich `schema.org` graph
  (Organization, WebSite, ProfessionalService with offers, FAQPage).
- Visible, honest trust layer: results shown with an explanatory footnote,
  testimonials labelled as illustrative, and a "who this is not for" section.

**Back end (`server.py`, standard library only)**

- Gzip compression, `ETag` / `If-Modified-Since` 304s, sensible cache headers.
- Security headers including a **Content-Security-Policy with SHA-256 hashes
  computed at boot** from the inline scripts in every page.
- Path-traversal protection and a denylist for source files (`server.py`,
  `README.md`, `.env`, `tests/`, `data/`, `tools/`, …).
- `POST /api/lead`, `POST /api/subscribe`, `POST /api/event` with validation,
  honeypot and fill-time spam checks, per-IP rate limiting and body-size caps.
- `GET /api/health` for uptime checks, plus a token-protected admin API:
  `GET /api/leads` (JSON or CSV) and `GET /api/stats`.
- Leads, subscribers and events stored as append-only JSONL on disk — trivially
  greppable, trivially backed up, no database required.
- Optional HMAC-signed webhook so leads can be pushed to Slack or an automation
  platform.
- Native form POST support: non-JS submissions get a `303` redirect to
  `/thank-you`.

---

## Quickstart

Requirements: **Python 3.9+**. Nothing else.

```bash
cd "Ecommerce Profit"

# 1. (optional) create a local config file
cp .env.example .env
python3 -c "import secrets; print('ADMIN_TOKEN=' + secrets.token_urlsafe(32))" >> .env

# 2. run it
python3 server.py --port 4173

# 3. open it
open http://127.0.0.1:4173
```

You should see the landing page. Without `ADMIN_TOKEN` the server logs a warning
and disables the admin endpoints — everything public still works.

All page references are relative, so double-clicking `index.html` also renders
the full design and behaviour from disk (`file://`). Form submissions and
analytics need the API, so use the server above for end-to-end testing; the
form shows a "start the server" hint when it detects a `file://` preview.

Run the test suite:

```bash
python3 -m unittest discover -s tests -v
```

---

## Project structure

```
.
├── index.html              Landing page (the funnel)
├── legal.html              Privacy, cookies, terms and accessibility
├── thank-you.html          Post-submission page for no-JS submissions
├── 404.html                Not-found page
├── styles.css              Design system + all component styles
├── script.js               All client behaviour (config driven)
├── config.js               Runtime config: endpoints, booking URL, flags
├── server.py               Static server + JSON API (stdlib only)
├── assets/
│   ├── favicon.svg
│   ├── apple-touch-icon.png
│   ├── og-image.png        Social sharing card (1200×630)
│   ├── founder.jpg
│   └── fonts/              Self-hosted Inter + Manrope woff2
├── tests/test_server.py    End-to-end tests for the server and API
├── tools/                  Dev-only sources, never served (see below)
├── robots.txt
├── sitemap.xml
├── site.webmanifest
├── .env.example            Documented environment configuration
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .gitignore
├── README.md
└── DEPLOYMENT.md           Step-by-step production deployment guide
```

`data/` is created at runtime and is gitignored.

---

## Configuration

### Front-end (`config.js`)

`config.js` is the only file you should need to edit for front-end changes.

| Key | Purpose |
| --- | --- |
| `leadEndpoint` | Where applications are POSTed. Default `/api/lead`. |
| `subscribeEndpoint` | Newsletter endpoint. Default `/api/subscribe`. |
| `eventEndpoint` | Analytics endpoint. Default `/api/event`. |
| `bookingUrl` | Optional Calendly / SavvyCal / Cal.com link. Empty means "book a call" opens a pre-filled email instead. |
| `contactEmail` | Address used for mailto fallbacks and the booking fallback. |
| `analytics` | `true` / `false` — master switch for first-party analytics. |
| `scrollDepth` | Percentages that fire `scroll_depth` events. |
| `minFormFillMs` | Must match `MIN_FORM_SECONDS` on the server (spam check only). |
| `draftStorage` | `"local"`, `"session"` or `"none"` — where unfinished applications are kept. |

### Server (`.env`)

See [`.env.example`](.env.example) for the annotated list. The most important:

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `4173` | Use `0.0.0.0` in containers. |
| `DATA_DIR` | `./data` | Where JSONL files are written. |
| `SITE_URL` | `https://profitgrowthcoaching.com` | Canonical origin. |
| `ADMIN_TOKEN` | *(empty)* | Enables `/api/leads` and `/api/stats`. Empty = disabled. |
| `BEHIND_PROXY` | `0` | Trust `X-Forwarded-For` for rate limiting. |
| `ENABLE_HSTS` | `0` | Only enable on HTTPS-only hosts. |
| `ALLOWED_ORIGINS` | *(empty)* | Extra origins allowed to POST cross-origin. |
| `LEAD_WEBHOOK_URL` | *(empty)* | POST new leads to Slack/Zapier/Make/n8n. |
| `LEAD_WEBHOOK_SECRET` | *(empty)* | Signs webhook bodies with `X-PGC-Signature`. |

CLI flags override the environment: `--host`, `--port`, `--data-dir`,
`--log-level`.

---

## Pages and sections

| Route | File | Notes |
| --- | --- | --- |
| `/` | `index.html` | The funnel. |
| `/legal` | `legal.html` | Clean URL; `/legal.html` also works. |
| `/thank-you` | `thank-you.html` | Target of the no-JS form redirect. |
| *(any miss)* | `404.html` | Served with a real `404` status. |

Landing page sections, in order: announcement bar → header → hero → social proof
→ problem → six profit levers → profit-leak scorecard → results & snapshots →
testimonials → process → programs → comparison → fit / not-fit → founder →
application form → FAQ → final CTA → footer, plus a sticky mobile CTA and a
calculator dialog.

---

## API reference

All endpoints are same-origin by default and rate limited per IP.

### `GET /api/health`

```json
{ "ok": true, "version": "2.0.0", "uptimeSeconds": 42, "storage": "ok" }
```

Public by design (no business data). Send the admin bearer token to also get
`"leadsStored": 7`.

### `POST /api/lead`

Accepts `application/json` or `application/x-www-form-urlencoded`.

| Field | Required | Notes |
| --- | --- | --- |
| `fullName` | yes | 2–80 characters and must contain a letter. |
| `email` | yes | Validated and lowercased. |
| `storeUrl` | yes | Normalised to a URL. |
| `revenue` | yes | Allowlisted revenue band. |
| `platform` | yes | Allowlisted platform. |
| `challenge` | yes | Allowlisted primary challenge. |
| `goal` | yes | Allowlisted focus area. |
| `outcomes` | yes | Free text, 10–2000 characters. |
| `program` | no | Allowlisted program name. |
| `consent` | yes | Must be `true` / `on` / `yes`. |
| `scorecard` | no | Array (or comma list) of selected leak keys. |
| `utm`, `page`, `referrer`, `sessionId` | no | Attribution, sent automatically by the client. |
| `companyWebsite` | — | Honeypot. Must stay empty. |
| `elapsedMs` | — | Fill time; too-fast submissions are rejected as spam. |

`201` on success (JSON) or `303 → /thank-you` for native form posts.

### `POST /api/subscribe`

`{ "email": "…", "source": "footer", "companyWebsite": "" }` → `201`.
`companyWebsite` is a honeypot and must stay empty.

### `POST /api/event`

`{ "event": "cta_click", "path": "/", "sessionId": "s_…", "props": { "id": "cta_hero" } }`
→ `204`. Only names on the server allowlist are stored, `props` is capped, and
the request is ignored entirely when the browser sends `DNT: 1` or `Sec-GPC: 1`.

### Admin (requires `Authorization: Bearer $ADMIN_TOKEN`)

```bash
# Recent leads as JSON
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://127.0.0.1:4173/api/leads?limit=100"

# Spreadsheet-friendly CSV
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://127.0.0.1:4173/api/leads?format=csv" -o leads.csv

# Event counts per day for the last 30 days
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://127.0.0.1:4173/api/stats?days=30"
```

---

## Managing leads

Every submission is appended to `data/leads.jsonl` — one JSON object per line.

```bash
# How many leads so far
wc -l data/leads.jsonl

# Just the emails
python3 -c "
import json,pathlib
for line in pathlib.Path('data/leads.jsonl').read_text().splitlines():
    print(json.loads(line)['email'])
"

# Back up
tar czf "leads-$(date +%F).tar.gz" data/
```

Newsletter signups land in `data/subscribers.jsonl`, events in
`data/events/YYYY-MM-DD.jsonl`.

To get leads into Slack, set `LEAD_WEBHOOK_URL` to a Slack incoming-webhook URL
and optionally `LEAD_WEBHOOK_SECRET` so your receiver can verify the
`X-PGC-Signature` header.

---

## Analytics

Analytics are **first-party and cookie-free**. The client posts small events to
`/api/event`; the server stores only allowlisted event names with a random
session id, path, referrer and campaign parameters.

- Analytics are automatically disabled when the browser sends **Do Not Track**
  or **Global Privacy Control**.
- Set `analytics: false` in `config.js` to turn them off completely.
- `GET /api/stats?days=30` returns per-event totals and per-day series.

Because nothing is stored client-side and no third-party script runs, the site
needs no cookie banner — which is stated plainly on `/legal#cookies`.

---

## Testing

```bash
python3 -m unittest discover -s tests -v
```

The suite spins up the real server on an ephemeral port and exercises static
serving, headers, the CSP, clean URLs, protected paths, all API endpoints,
validation, honeypot and timing spam checks, rate limiting and the admin API.
Run it from the repository root.

### Dev-only tools

`tools/` is blocked from HTTP by the server and never shipped in the image.

- `tools/og-card.html` — source for regenerating `assets/og-image.png`.
- `tools/responsive-check.html` + `tools/responsive-check.js` — renders the site
  in a same-origin iframe at an exact CSS width so media queries apply, then
  clips to a fixed window. Copy both files next to the site and open
  `responsive-check.html?w=390&h=844&y=0` to capture pixel-exact slices at any
  breakpoint. It is a development aid only; do not deploy the copies.

---

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full guide: Docker, Docker
Compose, systemd, Caddy/nginx reverse proxy, TLS, backups, monitoring and a
pre-launch checklist.

The 30-second version with Docker:

```bash
cp .env.example .env      # then set ADMIN_TOKEN and SITE_URL
docker compose up -d --build
curl http://127.0.0.1:4173/api/health
```

---

## Performance, SEO and accessibility

**Performance** — no framework, no build, no external font or script requests;
`preload` hints for the two primary fonts and the hero image; gzip;
`ETag`-based revalidation; deferred JavaScript; locally optimised images.

**SEO** — unique titles and meta descriptions, canonicals, Open Graph and
Twitter cards with a generated 1200×630 image, `sitemap.xml`, `robots.txt`
(with `/thank-you` and `/legal` handled deliberately), semantic headings and a
`schema.org` JSON-LD graph including a `FAQPage` that mirrors the visible FAQ.

**Accessibility** — targets WCAG 2.2 AA. See `/legal#accessibility` for the full
commitment, what has been implemented, and how to report a barrier. Highlights:
skip link, keyboard-operable dialogs with focus trap and restore, visible focus
rings, AA contrast, `prefers-reduced-motion` support, labelled fields with
announced inline errors, and a site that works without JavaScript.

---

## Security

- Strict CSP with boot-time SHA-256 hashes for every inline script, plus
  `object-src 'none'`, `base-uri 'none'` and `frame-ancestors 'none'`.
- `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
  `Permissions-Policy`; HSTS available via `ENABLE_HSTS=1`.
- Server-side validation and allowlists on every field; body-size cap; per-IP
  rate limiting; honeypot plus minimum-fill-time checks.
- Source files, dotfiles and `data/` are not reachable over HTTP, and traversal
  attempts are rejected.
- Admin API is opt-in and compared with `hmac.compare_digest`.

---

## Before you go live: replace these placeholders

This repository is a working, self-contained product, but the *business* content
is sample copy. Before publishing:

1. **Domain.** Replace `https://profitgrowthcoaching.com` in `index.html`,
   `legal.html`, `robots.txt`, `sitemap.xml` and `site.webmanifest`, and set
   `SITE_URL`. Add any host-specific rules to `ALLOWED_ORIGINS`.
2. **Contact details.** `config.js` (`contactEmail`, `bookingUrl`) and the
   footer/header mailto links in `index.html`, `legal.html`, `404.html`,
   `thank-you.html`.
3. **Legal copy.** `legal.html` is a template. Fill in your legal entity,
   jurisdiction and actual data processors, then have it reviewed by qualified
   counsel. The template notice at the bottom of the page should be removed once
   that is done.
4. **Claims and social proof.** `assets/founder.jpg`, the client snapshots in
   the results section, testimonials and any statistics are illustrative
   placeholders. Replace them with verifiable numbers, or keep the "illustrative"
   labels that are already in the markup. Never publish invented results.
5. **Program names and pricing.** Update the programs section and the
   `ProfessionalService` offers in the JSON-LD to match your real offer.
6. **Social links.** Replace the generic LinkedIn/Instagram/X/Facebook URLs in
   the footer.
7. **Regenerate the social image** after changing the headline:
   `python3 server.py` then screenshot `tools/og-card.html` at 1200×630 and crop
   it to `assets/og-image.png`.
8. **Rotate secrets.** Set a strong `ADMIN_TOKEN`, keep `.env` out of version
   control, and enable HTTPS before enabling HSTS.

---

## License

Proprietary. All rights reserved. Replace with your own license before
redistributing.
