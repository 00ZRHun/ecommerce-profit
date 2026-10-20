# Deployment guide

Everything you need to put the Profit Guild funnel on the public
internet and keep it running. Written for the bundled zero-dependency Python
server; the only requirement is **Python 3.9+** (or Docker).

- [0. Before you start](#0-before-you-start)
- [1. Option A — Docker Compose (recommended)](#1-option-a--docker-compose-recommended)
- [2. Option B — Docker without Compose](#2-option-b--docker-without-compose)
- [3. Option C — systemd on a plain VM](#3-option-c--systemd-on-a-plain-vm)
- [4. Option D — platform-as-a-service](#4-option-d--platform-as-a-service)
- [5. Reverse proxy and TLS](#5-reverse-proxy-and-tls)
- [6. Verifying the deployment](#6-verifying-the-deployment)
- [7. Leads, events and backups](#7-leads-events-and-backups)
- [8. Monitoring and logs](#8-monitoring-and-logs)
- [9. Updating and rolling back](#9-updating-and-rolling-back)
- [10. Pre-launch checklist](#10-pre-launch-checklist)
- [11. Troubleshooting](#11-troubleshooting)

---

## 0. Before you start

**Configure the site.** Edit `config.js` for the front end (`contactEmail`,
`bookingUrl`, endpoints) and complete the placeholder list at the bottom of
[README.md](README.md).

**Create a config file.**

```bash
cp .env.example .env
python3 -c "import secrets; print('ADMIN_TOKEN=' + secrets.token_urlsafe(32))" >> .env
```

Then set at minimum:

```dotenv
HOST=0.0.0.0
PORT=4173
DATA_DIR=/app/data          # or ./data on a VM
SITE_URL=https://your-domain.com
ADMIN_TOKEN=<the generated token>
BEHIND_PROXY=1              # when a reverse proxy sits in front
ENABLE_HSTS=1               # only once the site is HTTPS-only
LOG_LEVEL=INFO
```

`.env` is gitignored and never served over HTTP.

**Run the tests** before shipping:

```bash
python3 -m unittest discover -s tests
```

---

## 1. Option A — Docker Compose (recommended)

The bundled `docker-compose.yml` builds the image, publishes it on
`127.0.0.1:4173` only (so it is not exposed directly to the internet), mounts a
named volume for data, and drops privileges.

```bash
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:4173/api/health
```

Expected:

```json
{"ok": true, "version": "2.0.0", "uptimeSeconds": 3, "storage": "ok"}
```

Put a TLS-terminating proxy in front ([section 5](#5-reverse-proxy-and-tls)).

Useful commands:

```bash
docker compose logs -f funnel          # follow logs
docker compose restart funnel          # restart
docker compose down                    # stop (keeps the data volume)
docker compose down -v                 # stop and delete data — destructive
```

---

## 2. Option B — Docker without Compose

```bash
docker build -t pgc-funnel:latest .

docker run -d --name pgc-funnel \
  --restart unless-stopped \
  -p 127.0.0.1:4173:4173 \
  --env-file .env \
  -e HOST=0.0.0.0 -e DATA_DIR=/app/data -e BEHIND_PROXY=1 \
  -v pgc-data:/app/data \
  --read-only --tmpfs /tmp \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --log-opt max-size=10m --log-opt max-file=5 \
  pgc-funnel:latest
```

---

## 3. Option C — systemd on a plain VM

No Python packages are needed, so a system Python is fine. Create a dedicated
user and a writable data directory:

```bash
sudo useradd --system --home /opt/pgc --shell /usr/sbin/nologin pgc
sudo mkdir -p /opt/pgc/data
sudo chown -R pgc:pgc /opt/pgc
```

Copy the site into `/opt/pgc` (excluding `data/`, `tests/`, `tools/`, `.env` —
or including `.env` if you keep your config there; just `chmod 600` it).

`/etc/systemd/system/pgc-funnel.service`:

```ini
[Unit]
Description=Profit Guild funnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pgc
Group=pgc
WorkingDirectory=/opt/pgc
EnvironmentFile=/opt/pgc/.env
ExecStart=/usr/bin/python3 /opt/pgc/server.py
Restart=on-failure
RestartSec=3

# Hardening
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
ReadWritePaths=/opt/pgc/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo chmod 600 /opt/pgc/.env
sudo systemctl daemon-reload
sudo systemctl enable --now pgc-funnel
sudo systemctl status pgc-funnel
```

Logs:

```bash
journalctl -u pgc-funnel -f
```

---

## 4. Option D — platform-as-a-service

The repository includes a `Dockerfile`, so most container platforms work with
no extra configuration. Build/start conventions:

| Setting | Value |
| --- | --- |
| Build | Dockerfile present in the repo root |
| Port | `4173`, or set `PORT` and bind `HOST=0.0.0.0` |
| Health check path | `/api/health` |
| Persistent volume | mount at `/app/data` |
| Required env | `SITE_URL`, `ADMIN_TOKEN`, `BEHIND_PROXY=1`, `DATA_DIR=/app/data` |

**Important:** most PaaS filesystems are ephemeral. Without a persistent volume
mounted at `DATA_DIR`, leads are lost on every redeploy. Either attach a volume,
or point `LEAD_WEBHOOK_URL` at Slack/Zapier/Make/n8n so every lead is forwarded
somewhere durable the moment it arrives.

---

## 5. Reverse proxy and TLS

Terminate TLS at the proxy and forward to `127.0.0.1:4173`. Set
`BEHIND_PROXY=1` so rate limiting and logs use the real client IP.

### Caddy (simplest — automatic HTTPS)

`/etc/caddy/Caddyfile`:

```caddyfile
your-domain.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4173
}
```

```bash
sudo systemctl reload caddy
```

Caddy provisions and renews certificates automatically.

### nginx

`/etc/nginx/sites-available/pgc`:

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Compress HTML/CSS/JS once, at the edge.
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml application/xml;
    gzip_min_length 1024;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
        client_max_body_size 1m;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/pgc /etc/nginx/sites-enabled/pgc
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.com
```

When TLS is handled by the proxy, leave `ENABLE_HSTS=0` on the app if the proxy
already sets the header (as above), or set `ENABLE_HSTS=1` and remove the
`add_header` line. Do not send it twice.

---

## 6. Verifying the deployment

```bash
BASE=https://your-domain.com

# Health
curl -s $BASE/api/health

# Security headers + CSP
curl -sI $BASE/ | grep -iE 'content-security-policy|strict-transport|x-content-type|x-frame|referrer-policy|permissions-policy'

# Clean URLs
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $BASE/legal

# A real 404 status
curl -s -o /dev/null -w '%{http_code}\n' $BASE/does-not-exist

# Compression works
curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download} bytes\n' $BASE/styles.css

# A 304 on revalidation
ETAG=$(curl -sI $BASE/styles.css | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: $ETAG" $BASE/styles.css

# The admin API refuses unauthenticated requests
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/leads
```

Then in a browser:

1. Submit the application form — you should see the inline success panel.
2. Disable JavaScript, reload, submit again — you should land on `/thank-you`.
3. Open the profit calculator and the scorecard; check the console is clean.
4. Check the site at 1440 / 1024 / 768 / 390 / 320 px widths.
5. Confirm `data/leads.jsonl` gained a line:

   ```bash
   docker compose exec funnel sh -c 'wc -l /app/data/leads.jsonl'
   ```

---

## 7. Leads, events and backups

| Path | Contents |
| --- | --- |
| `data/leads.jsonl` | One JSON object per application. |
| `data/subscribers.jsonl` | Newsletter signups. |
| `data/events/YYYY-MM-DD.jsonl` | One file per day of analytics events. |

Export at any time:

```bash
TOKEN=$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2-)
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:4173/api/leads?format=csv" -o "leads-$(date +%F).csv"
```

**Backups.** The data directory is small plain text; a nightly tarball is
enough. Example cron entry on a VM:

```cron
15 3 * * * tar czf /var/backups/pgc-$(date +\%F).tar.gz -C /opt/pgc data && find /var/backups -name 'pgc-*.tar.gz' -mtime +30 -delete
```

For Docker:

```bash
docker run --rm -v pgc-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/pgc-data-$(date +%F).tar.gz -C /data .
```

**Retention.** The privacy policy states applications are kept for up to 24
months and event data for up to 14 months. Schedule a cleanup that matches
whatever you publish:

```bash
# Delete event files older than 14 months
find data/events -name '*.jsonl' -mtime +425 -delete
```

---

## 8. Monitoring and logs

- **Uptime**: poll `GET /api/health` every minute from an external monitor
  (UptimeRobot, Better Stack, Healthchecks.io). It returns `200` with a
  `storage` field, which also tells you whether the data directory is writable.
  Add the admin bearer token to the request if you also want `leadsStored`
  (kept off the public response so lead volume stays private).
- **Health check**: the Docker image has a built-in `HEALTHCHECK`, so
  `docker ps` shows `healthy` / `unhealthy`.
- **Logs**: structured stdout lines (`INFO` / `WARNING` / `ERROR`) — one per
  request plus one per stored lead. Collect with `docker logs`, `journalctl`, or
  your platform's log drain. `LOG_LEVEL=DEBUG` is noisy; use it temporarily.
- **Watch for**: `ADMIN_TOKEN is not set` (admin API disabled), repeated `429`
  rate-limit responses, and `Could not persist lead` (disk or permissions).

---

## 9. Updating and rolling back

1. Back up `data/` first (see above).
2. Pull the new revision.
3. Run `python3 -m unittest discover -s tests`.
4. Rebuild and restart:
   - Compose: `docker compose up -d --build`
   - systemd: replace the files, then `sudo systemctl restart pgc-funnel`
5. Re-run the checks in [section 6](#6-verifying-the-deployment).

Content changes (HTML/CSS/JS/fonts) need no migration — just replace the files.
`ETag`s are derived from file mtime and size, so cache busting is automatic.
If you change `index.html` inline scripts, the CSP is recomputed at boot;
restart the server so browsers do not see a stale policy.

**Rolling back** means checking out the previous revision and restarting. The
data format is append-only JSONL and has not changed between versions, so no
data migration is required.

---

## 10. Pre-launch checklist

**Content**

- [ ] Real domain in `index.html`, `legal.html`, `robots.txt`, `sitemap.xml`,
      `site.webmanifest`; `SITE_URL` set in `.env`.
- [ ] `contactEmail` and `bookingUrl` set in `config.js`; mailto links updated.
- [ ] Placeholder testimonials, client snapshots and statistics replaced with
      real, verifiable numbers — or left clearly labelled as illustrative.
- [ ] Real founder photo and bio.
- [ ] Program names, pricing and the JSON-LD `Offer` block match your offer.
- [ ] Social links point at your profiles.
- [ ] `assets/og-image.png` regenerated from `tools/og-card.html` if the
      headline changed.
- [ ] Legal copy reviewed by counsel; template notice removed.

**Technical**

- [ ] `python3 -m unittest discover -s tests` passes.
- [ ] HTTPS live, certificate auto-renewing.
- [ ] `ENABLE_HSTS=1` once HTTPS is confirmed working.
- [ ] `ADMIN_TOKEN` set to a strong random value and stored safely.
- [ ] `.env` not committed; `.gitignore` working (`git status` shows no data).
- [ ] `data/` on a persistent volume or covered by a webhook/backup.
- [ ] Test form submission arrives in `data/leads.jsonl` **and** in your inbox
      or Slack.
- [ ] `curl` checks from [section 6](#6-verifying-the-deployment) all pass.
- [ ] Uptime monitor pointed at `/api/health`.
- [ ] Manual pass at 1440 / 1024 / 768 / 390 / 320 px, plus a keyboard-only and
      a JavaScript-disabled pass.
- [ ] Lighthouse run for performance, accessibility, best practices and SEO.

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `WARNING ADMIN_TOKEN is not set` | Admin API disabled by design. | Add `ADMIN_TOKEN` to `.env` and restart. |
| `403 Origin not allowed` on form submit | The `Origin` header does not match `SITE_URL`. | Set `SITE_URL` correctly, or add the origin to `ALLOWED_ORIGINS`. |
| Form returns `429` | Rate limit hit (`LEAD_RATE_LIMIT` per `LEAD_RATE_WINDOW`). | Raise the limits, or set `BEHIND_PROXY=1` so the real client IP is used instead of the proxy's. |
| Form rejected as spam | Submitted faster than `MIN_FORM_SECONDS`, or the honeypot was filled. | Keep `MIN_FORM_SECONDS` and `config.js → minFormFillMs` in sync. |
| Refused to execute inline script | Browser cached an older CSP, or `index.html` was edited while the server was running. | Restart the server so hashes are recomputed; hard-refresh. |
| Fonts do not load behind a proxy | Font files blocked or MIME type wrong. | Ensure `.woff2` is served as `font/woff2` and that `font-src 'self'` is intact. |
| Leads disappear after redeploy | Ephemeral filesystem, or `docker compose down -v`. | Mount a persistent volume at `DATA_DIR`, or set `LEAD_WEBHOOK_URL`. |
| `500` on form submit | Data directory not writable. | Check ownership/permissions on `DATA_DIR` (or `ReadWritePaths` in systemd). |
| Stale pages after deploy | Aggressive CDN caching. | The server sends `ETag` + `must-revalidate`; purge the CDN cache if you added one in front. |
