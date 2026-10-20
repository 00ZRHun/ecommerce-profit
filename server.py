#!/usr/bin/env python3
"""Production server for the Profit Guild funnel.

Zero third-party dependencies. Serves the static site, accepts audit
applications, forwards them to an optional webhook, stores them as JSON Lines,
and records privacy-friendly first-party funnel events.

Run locally:
    python3 server.py --port 4173

Environment variables (see .env.example):
    HOST, PORT, DATA_DIR, ADMIN_TOKEN, LEAD_WEBHOOK_URL, LEAD_WEBHOOK_SECRET,
    SITE_URL, ALLOWED_ORIGINS, TRUST_PROXY, RATE_LIMIT_*, MAX_BODY_BYTES,
    ENABLE_HSTS, BEHIND_PROXY
"""

from __future__ import annotations

import argparse
import base64
import csv
import gzip
import hashlib
import hmac
import io
import ipaddress
import json
import logging
import mimetypes
import os
import re
import secrets
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import formatdate
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, quote, unquote, urlparse

VERSION = "2.0.0"
ROOT = Path(__file__).resolve().parent
LOGGER = logging.getLogger("pgc")

# Files that should never be served, even if they sit inside the web root.
PROTECTED_NAMES = {
    "server.py",
    "Dockerfile",
    "docker-compose.yml",
    ".env",
    ".env.example",
    ".gitignore",
    ".dockerignore",
    "README.md",
    "DEPLOYMENT.md",
}
PROTECTED_DIRS = {"data", "tests", "tools", ".git", ".github", "__pycache__", "node_modules"}
# Pages link to their files (so the site also works when opened from disk);
# the server redirects those file URLs to the canonical clean URLs.
CANONICAL_REDIRECTS = {
    "/index.html": "/",
    "/legal.html": "/legal",
    "/thank-you.html": "/thank-you",
}
STATIC_ALLOWED_EXTENSIONS = {
    ".html",
    ".css",
    ".js",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".avif",
    ".ico",
    ".woff2",
    ".woff",
    ".txt",
    ".xml",
    ".json",
    ".webmanifest",
    ".pdf",
}


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def load_dotenv(path: Path) -> None:
    """Load a .env file without overriding real environment variables."""
    if not path.is_file():
        return
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        LOGGER.warning("Could not read %s", path)


@dataclass
class Config:
    root: Path = ROOT
    host: str = "127.0.0.1"
    port: int = 4173
    data_dir: Path = ROOT / "data"
    admin_token: str = ""
    site_url: str = "https://profitgrowthcoaching.com"
    allowed_origins: tuple[str, ...] = ()
    trust_proxy: bool = False
    enable_hsts: bool = False
    max_body_bytes: int = 32 * 1024
    lead_rate_limit: int = 5
    lead_rate_window: int = 600
    subscribe_rate_limit: int = 5
    subscribe_rate_window: int = 600
    event_rate_limit: int = 90
    event_rate_window: int = 60
    webhook_url: str = ""
    webhook_secret: str = ""
    webhook_timeout: int = 6
    min_form_seconds: float = 2.5
    stdout_logs: bool = True
    version: str = VERSION
    started_at: float = field(default_factory=time.time)

    @property
    def leads_path(self) -> Path:
        return self.data_dir / "leads.jsonl"

    @property
    def subscribers_path(self) -> Path:
        return self.data_dir / "subscribers.jsonl"

    @property
    def events_dir(self) -> Path:
        return self.data_dir / "events"

    @classmethod
    def from_env(cls, root: Path = ROOT) -> "Config":
        origins = tuple(
            origin.strip().rstrip("/")
            for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",")
            if origin.strip()
        )
        return cls(
            root=root,
            host=os.environ.get("HOST", "127.0.0.1"),
            port=_env_int("PORT", 4173),
            data_dir=Path(os.environ.get("DATA_DIR", str(root / "data"))).expanduser(),
            admin_token=os.environ.get("ADMIN_TOKEN", ""),
            site_url=os.environ.get("SITE_URL", "https://profitgrowthcoaching.com").rstrip("/"),
            allowed_origins=origins,
            # BEHIND_PROXY is the friendlier alias documented in DEPLOYMENT.md;
            # either variable enables X-Forwarded-For trust.
            trust_proxy=_env_bool("TRUST_PROXY") or _env_bool("BEHIND_PROXY"),
            enable_hsts=_env_bool("ENABLE_HSTS"),
            max_body_bytes=_env_int("MAX_BODY_BYTES", 32 * 1024),
            lead_rate_limit=_env_int("LEAD_RATE_LIMIT", 5),
            lead_rate_window=_env_int("LEAD_RATE_WINDOW", 600),
            subscribe_rate_limit=_env_int("SUBSCRIBE_RATE_LIMIT", 5),
            subscribe_rate_window=_env_int("SUBSCRIBE_RATE_WINDOW", 600),
            event_rate_limit=_env_int("EVENT_RATE_LIMIT", 90),
            event_rate_window=_env_int("EVENT_RATE_WINDOW", 60),
            webhook_url=os.environ.get("LEAD_WEBHOOK_URL", ""),
            webhook_secret=os.environ.get("LEAD_WEBHOOK_SECRET", ""),
            webhook_timeout=_env_int("WEBHOOK_TIMEOUT", 6),
            min_form_seconds=float(os.environ.get("MIN_FORM_SECONDS", "2.5")),
            stdout_logs=not _env_bool("QUIET_LOGS"),
        )


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

EMAIL_RE = re.compile(r"^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$")
HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$", re.I)
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
URL_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)

REVENUE_OPTIONS = (
    "Under $25k",
    "$25k – $50k",
    "$50k – $100k",
    "$100k – $250k",
    "$250k – $500k",
    "$500k+",
)
PLATFORM_OPTIONS = (
    "Shopify",
    "WooCommerce",
    "BigCommerce",
    "Magento",
    "Custom / Headless",
    "Other",
)
CHALLENGE_OPTIONS = (
    "Declining profit margins",
    "Rising ad costs",
    "Low conversion rate",
    "Weak retention / LTV",
    "Cash-flow pressure",
    "Not sure — that's why I'm here",
)
GOAL_OPTIONS = (
    "Increase net profit",
    "Scale ad spend profitably",
    "Improve cash flow",
    "Build an exit-ready business",
)
PROGRAM_OPTIONS = (
    "Growth Accelerator",
    "Profit Partner",
    "Executive Partner",
    "Not sure yet",
)
SCORECARD_LEAKS = (
    "ad-spend",
    "discounts",
    "shipping",
    "aov",
    "retention",
    "supplier",
)

UTM_KEYS = ("source", "medium", "campaign", "term", "content")
EVENT_ALLOWLIST = {
    "page_view",
    "cta_click",
    "nav_click",
    "calculator_open",
    "calculator_apply",
    "calculator_email",
    "scorecard_start",
    "scorecard_complete",
    "scorecard_cta",
    "form_start",
    "form_step",
    "form_submit",
    "form_error",
    "newsletter_submit",
    "scroll_depth",
    "faq_open",
    "book_call",
    "outbound_click",
}


def _clean_text(value: Any, max_length: int) -> str:
    if value is None:
        return ""
    text = CONTROL_RE.sub("", str(value))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max_length]


def _clean_multiline(value: Any, max_length: int) -> str:
    if value is None:
        return ""
    text = CONTROL_RE.sub("", str(value)).replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:max_length]


def normalize_email(value: Any) -> str:
    return _clean_text(value, 254).lower()


def is_valid_email(value: str) -> bool:
    if not value or len(value) > 254 or ".." in value:
        return False
    if not EMAIL_RE.match(value):
        return False
    local, _, domain = value.rpartition("@")
    if not local or local.startswith(".") or local.endswith("."):
        return False
    return bool(HOSTNAME_RE.match(domain)) and not domain.endswith(".local")


def normalize_store_url(value: Any) -> tuple[str, str]:
    """Return (normalized URL, error message)."""
    raw = _clean_text(value, 300)
    if not raw:
        return "", "Enter your store URL (e.g. yourstore.com)."
    if CONTROL_RE.search(raw) or any(ch.isspace() for ch in raw):
        return "", "Enter your store URL (e.g. yourstore.com)."
    if raw.lower().startswith(("javascript:", "data:", "file:", "ftp:")):
        return "", "Enter a valid http(s) store URL."
    if "://" not in raw:
        raw = f"https://{raw}"
    try:
        parsed = urlparse(raw)
    except ValueError:
        return "", "Enter a valid store URL."
    if parsed.scheme not in {"http", "https"}:
        return "", "Enter a valid http(s) store URL."
    host = (parsed.hostname or "").lower()
    if not host or not HOSTNAME_RE.match(host):
        return "", "Enter your store URL (e.g. yourstore.com)."
    try:
        ipaddress.ip_address(host)
        return "", "Enter your public store URL, not an IP address."
    except ValueError:
        pass
    if any(host.endswith(suffix) for suffix in (".local", ".internal", ".localhost")):
        return "", "Enter your public store URL."
    path = parsed.path.rstrip("/")
    normalized = f"https://{host}{path}"
    if parsed.query:
        normalized += f"?{parsed.query[:120]}"
    return normalized[:300], ""


def _validate_choice(value: Any, options: Iterable[str], label: str) -> tuple[str, str]:
    cleaned = _clean_text(value, 120)
    if not cleaned:
        return "", f"Select {label}."
    for option in options:
        if cleaned.casefold() == option.casefold():
            return option, ""
    return "", f"Select a valid {label}."


def validate_lead(payload: dict[str, Any], *, min_form_seconds: float = 2.5) -> tuple[dict[str, Any], dict[str, str]]:
    """Validate and normalize an audit application.

    Returns (clean, errors). `clean` is safe to persist. Unknown fields are
    dropped so the API cannot be used to store arbitrary data.
    """
    errors: dict[str, str] = {}

    full_name = _clean_text(payload.get("fullName"), 80)
    if len(full_name) < 2:
        errors["fullName"] = "Enter your full name."
    elif not re.search(r"[A-Za-zÀ-ÖØ-öø-ÿ]", full_name):
        errors["fullName"] = "Enter a valid name."

    email = normalize_email(payload.get("email"))
    if not email:
        errors["email"] = "Enter your email address."
    elif not is_valid_email(email):
        errors["email"] = "Enter a valid email address."

    store_url, store_error = normalize_store_url(payload.get("storeUrl"))
    if store_error:
        errors["storeUrl"] = store_error

    revenue, revenue_error = _validate_choice(payload.get("revenue"), REVENUE_OPTIONS, "a revenue range")
    if revenue_error:
        errors["revenue"] = revenue_error

    platform, platform_error = _validate_choice(payload.get("platform"), PLATFORM_OPTIONS, "your platform")
    if platform_error:
        errors["platform"] = platform_error

    challenge, challenge_error = _validate_choice(payload.get("challenge"), CHALLENGE_OPTIONS, "your biggest challenge")
    if challenge_error:
        errors["challenge"] = challenge_error

    goal, goal_error = _validate_choice(payload.get("goal"), GOAL_OPTIONS, "one focus for your business")
    if goal_error:
        errors["goal"] = goal_error

    outcomes = _clean_multiline(payload.get("outcomes"), 2000)
    if len(outcomes) < 10:
        errors["outcomes"] = "Tell us a little more (at least 10 characters)."

    consent_raw = payload.get("consent")
    consent = consent_raw is True or str(consent_raw).strip().lower() in {"yes", "true", "on", "1"}
    if not consent:
        errors["consent"] = "Please agree to the privacy policy so we can contact you."

    honeypot = _clean_text(payload.get("companyWebsite"), 200)
    if honeypot:
        errors["_spam"] = "Submission rejected."

    elapsed_raw = payload.get("elapsedMs")
    try:
        elapsed_ms = float(elapsed_raw) if elapsed_raw is not None else None
    except (TypeError, ValueError):
        elapsed_ms = None
    if min_form_seconds > 0 and elapsed_ms is not None and elapsed_ms < min_form_seconds * 1000:
        errors["_spam"] = "Submission rejected."

    program_in = _clean_text(payload.get("program"), 80)
    program = ""
    if program_in:
        for option in PROGRAM_OPTIONS:
            if program_in.casefold() == option.casefold():
                program = option
                break
        if not program:
            errors["program"] = "Select a valid program."

    utm_in = payload.get("utm") if isinstance(payload.get("utm"), dict) else {}
    utm = {}
    for key in UTM_KEYS:
        value = _clean_text(utm_in.get(key), 120)
        if value:
            utm[key] = value

    raw_scorecard = payload.get("scorecard")
    if isinstance(raw_scorecard, str):
        raw_scorecard = [part for part in raw_scorecard.split(",") if part]
    scorecard = []
    if isinstance(raw_scorecard, list):
        for item in raw_scorecard[:12]:
            cleaned = _clean_text(item, 40).lower()
            if cleaned in SCORECARD_LEAKS and cleaned not in scorecard:
                scorecard.append(cleaned)

    clean = {
        "fullName": full_name,
        "email": email,
        "storeUrl": store_url,
        "revenue": revenue,
        "platform": platform,
        "challenge": challenge,
        "goal": goal,
        "outcomes": outcomes,
        "program": program,
        "consent": consent,
        "scorecard": scorecard,
        "utm": utm,
        "page": _clean_text(payload.get("page"), 300),
        "referrer": _clean_text(payload.get("referrer"), 500),
        "sessionId": _clean_text(payload.get("sessionId"), 64),
        "elapsedMs": int(elapsed_ms) if elapsed_ms is not None else None,
    }
    return clean, errors


def validate_subscriber(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    errors: dict[str, str] = {}
    email = normalize_email(payload.get("email"))
    if not email:
        errors["email"] = "Enter your email address."
    elif not is_valid_email(email):
        errors["email"] = "Enter a valid email address."

    if _clean_text(payload.get("companyWebsite"), 200):
        errors["_spam"] = "Submission rejected."

    clean = {
        "email": email,
        "source": _clean_text(payload.get("source"), 80) or "newsletter",
        "page": _clean_text(payload.get("page"), 300),
        "sessionId": _clean_text(payload.get("sessionId"), 64),
    }
    return clean, errors


# ---------------------------------------------------------------------------
# Storage + rate limiting
# ---------------------------------------------------------------------------


class JsonlStore:
    """Append-only JSON Lines store with a process lock."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def append(self, record: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()
                os.fsync(handle.fileno())

    def read_all(self, limit: int | None = None) -> list[dict[str, Any]]:
        if not self.path.is_file():
            return []
        records: list[dict[str, Any]] = []
        with self._lock:
            with self.path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        LOGGER.warning("Skipping corrupt JSONL line in %s", self.path)
        if limit is not None:
            return records[-limit:]
        return records


class RateLimiter:
    """Thread-safe sliding-window limiter kept in memory."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str, limit: int, window: int) -> tuple[bool, int]:
        now = time.monotonic()
        cutoff = now - window
        with self._lock:
            bucket = self._hits[key]
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= limit:
                retry_after = max(1, int(bucket[0] + window - now) + 1)
                return False, retry_after
            bucket.append(now)
            # Opportunistic cleanup keeps the dictionary from growing forever.
            if len(self._hits) > 5000:
                for stale_key in list(self._hits):
                    stale = self._hits[stale_key]
                    if not stale or stale[-1] < cutoff:
                        del self._hits[stale_key]
            return True, 0


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_day() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def hash_ip(ip: str, site_url: str) -> str:
    """One-way, rotating-ish IP fingerprint for abuse review. Never the raw IP."""
    salt = hashlib.sha256(f"{site_url}|{utc_day()}".encode()).hexdigest()[:16]
    digest = hmac.new(salt.encode(), ip.encode(), hashlib.sha256).hexdigest()
    return digest[:24]


def client_ip(handler: BaseHTTPRequestHandler, config: Config) -> str:
    if config.trust_proxy:
        forwarded = handler.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",")[0].strip()[:64]
        real_ip = handler.headers.get("X-Real-IP", "")
        if real_ip:
            return real_ip.strip()[:64]
    return handler.client_address[0]


def write_event(config: Config, event: dict[str, Any]) -> None:
    path = config.events_dir / f"{utc_day()}.jsonl"
    store = JsonlStore(path)
    store.append(event)


# ---------------------------------------------------------------------------
# Webhook delivery
# ---------------------------------------------------------------------------


def post_webhook(config: Config, payload: dict[str, Any]) -> None:
    """Best-effort signed webhook with two retries. Runs in a daemon thread."""
    if not config.webhook_url:
        return
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    headers = {
        "Content-Type": "application/json",
        "User-Agent": f"PGC-Funnel/{config.version}",
        "X-PGC-Event": "lead.created",
    }
    if config.webhook_secret:
        signature = hmac.new(config.webhook_secret.encode(), body, hashlib.sha256).hexdigest()
        headers["X-PGC-Signature"] = f"sha256={signature}"

    for attempt in range(3):
        request = urllib.request.Request(config.webhook_url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=config.webhook_timeout) as response:
                if 200 <= response.status < 300:
                    LOGGER.info("Lead webhook delivered (attempt %s)", attempt + 1)
                    return
                LOGGER.warning("Lead webhook returned %s", response.status)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            LOGGER.warning("Lead webhook failed (attempt %s): %s", attempt + 1, exc)
        time.sleep(1.5 * (attempt + 1))
    LOGGER.error("Lead webhook permanently failed for %s", payload.get("leadId"))


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class FunnelHandler(BaseHTTPRequestHandler):
    server_version = f"PGC-Funnel/{VERSION}"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # -- helpers ----------------------------------------------------------
    @property
    def config(self) -> Config:
        return self.server.config  # type: ignore[attr-defined]

    @property
    def limiter(self) -> RateLimiter:
        return self.server.limiter  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        if self.config.stdout_logs:
            LOGGER.info("%s - %s", self.client_address[0], fmt % args)

    def _common_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
        )
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Content-Security-Policy", self.server.csp)  # type: ignore[attr-defined]
        if self.config.enable_hsts:
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

    def _send_json(self, status: int, payload: dict[str, Any], extra: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if status != HTTPStatus.NO_CONTENT else b""
        self.send_response(status)
        self._common_headers()
        if body:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _send_html(self, status: int, markup: str) -> None:
        body = markup.encode("utf-8")
        self.send_response(status)
        self._common_headers()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _redirect(self, location: str, status: int = HTTPStatus.MOVED_PERMANENTLY) -> None:
        self.send_response(status)
        self._common_headers()
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid Content-Length")
        if length < 0 or length > self.config.max_body_bytes:
            raise ValueError("Request body too large")
        body = self.rfile.read(length)
        if len(body) != length:
            raise ValueError("Incomplete request body")
        return body

    def _parse_body(self) -> dict[str, Any]:
        body = self._read_body()
        content_type = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if content_type == "application/json":
            if not body:
                return {}
            data = json.loads(body.decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("JSON body must be an object")
            return data
        if content_type == "application/x-www-form-urlencoded":
            parsed = parse_qs(body.decode("utf-8"), keep_blank_values=True)
            result: dict[str, Any] = {}
            for key, values in parsed.items():
                result[key] = values[0] if len(values) == 1 else values
            if "utm_source" in result:
                result["utm"] = {
                    "source": result.get("utm_source"),
                    "medium": result.get("utm_medium"),
                    "campaign": result.get("utm_campaign"),
                    "term": result.get("utm_term"),
                    "content": result.get("utm_content"),
                }
            return result
        if content_type in {"text/plain", ""}:
            return json.loads(body.decode("utf-8") or "{}")
        raise ValueError("Unsupported Content-Type")

    def _same_origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True  # Non-browser client; no ambient credentials exist.
        normalized = origin.rstrip("/")
        if normalized in self.config.allowed_origins:
            return True
        allowed_hosts = {self.headers.get("Host", "")}
        parsed = urlparse(normalized)
        if parsed.netloc and parsed.netloc in allowed_hosts:
            return True
        site = urlparse(self.config.site_url)
        return bool(site.netloc and parsed.netloc == site.netloc)

    def _rate_limit(self, bucket: str, limit: int, window: int) -> bool:
        ip = client_ip(self, self.config)
        allowed, retry_after = self.limiter.check(f"{bucket}:{ip}", limit, window)
        if not allowed:
            self._send_json(
                HTTPStatus.TOO_MANY_REQUESTS,
                {"ok": False, "message": "Too many requests. Please try again shortly."},
                {"Retry-After": str(retry_after)},
            )
        return allowed

    def _wants_html(self) -> bool:
        accept = self.headers.get("Accept", "")
        return "text/html" in accept and "application/json" not in accept

    # -- HTTP verbs -------------------------------------------------------
    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            self._handle_api_get(path, parse_qs(parsed.query))
            return
        canonical = CANONICAL_REDIRECTS.get(path)
        if canonical is not None:
            suffix = f"?{parsed.query}" if parsed.query else ""
            self._redirect(f"{canonical}{suffix}")
            return
        self._serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if not self._same_origin_ok():
            self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "message": "Origin not allowed."})
            return
        try:
            if path == "/api/lead":
                self._handle_lead()
            elif path == "/api/subscribe":
                self._handle_subscribe()
            elif path == "/api/event":
                self._handle_event()
            else:
                self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "message": "Not found."})
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": str(exc)})
        except json.JSONDecodeError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Invalid JSON."})
        except Exception:  # pragma: no cover - last-resort guard
            LOGGER.exception("Unhandled error for %s", path)
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "message": "Something went wrong."})

    # -- API --------------------------------------------------------------
    def _handle_api_get(self, path: str, query: dict[str, list[str]]) -> None:
        if path == "/api/health":
            payload = {
                "ok": True,
                "version": self.config.version,
                "uptimeSeconds": int(time.time() - self.config.started_at),
                "storage": "ok" if self.config.data_dir.exists() else "missing",
            }
            # The stored-lead count is business intelligence, so it is only
            # reported to an authorised caller. Uptime checks stay public.
            if self._authorized():
                payload["leadsStored"] = len(JsonlStore(self.config.leads_path).read_all())
            self._send_json(HTTPStatus.OK, payload)
            return
        if path in {"/api/leads", "/api/stats"}:
            if not self.config.admin_token:
                self._send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"ok": False, "message": "Admin access is disabled. Set ADMIN_TOKEN to enable it."},
                )
                return
            if not self._authorized():
                self._send_json(
                    HTTPStatus.UNAUTHORIZED,
                    {"ok": False, "message": "Unauthorized."},
                    {"WWW-Authenticate": 'Bearer realm="pgc-admin"'},
                )
                return
            if path == "/api/leads":
                self._export_leads(query)
            else:
                self._stats(query)
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "message": "Not found."})

    def _authorized(self) -> bool:
        token = self.config.admin_token
        if not token:
            return False
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        provided = header[7:].strip()
        return hmac.compare_digest(provided, token)

    def _export_leads(self, query: dict[str, list[str]]) -> None:
        if not self.config.admin_token:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"ok": False, "message": "Admin access is disabled. Set ADMIN_TOKEN to enable it."},
            )
            return
        try:
            limit = min(max(int(query.get("limit", ["500"])[0]), 1), 5000)
        except ValueError:
            limit = 500
        leads = JsonlStore(self.config.leads_path).read_all(limit=limit)
        if query.get("format", ["json"])[0].lower() == "csv":
            output = io.StringIO()
            columns = [
                "id",
                "receivedAt",
                "fullName",
                "email",
                "storeUrl",
                "revenue",
                "platform",
                "challenge",
                "goal",
                "outcomes",
                "scorecard",
                "utm",
                "page",
                "referrer",
            ]
            writer = csv.DictWriter(output, fieldnames=columns)
            writer.writeheader()
            for lead in leads:
                row = {key: lead.get(key, "") for key in columns}
                row["scorecard"] = ",".join(row.get("scorecard") or [])
                utm = row.get("utm") or {}
                row["utm"] = " ".join(f"{k}={v}" for k, v in utm.items())
                writer.writerow(row)
            body = output.getvalue().encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self._common_headers()
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="leads.csv"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        self._send_json(HTTPStatus.OK, {"ok": True, "count": len(leads), "leads": leads})

    def _stats(self, query: dict[str, list[str]]) -> None:
        try:
            days = min(max(int(query.get("days", ["30"])[0]), 1), 365)
        except ValueError:
            days = 30
        since = datetime.now(timezone.utc).date() - timedelta(days=days - 1)
        by_event: dict[str, int] = defaultdict(int)
        by_day: dict[str, dict[str, int]] = {}
        for offset in range(days):
            day = (since + timedelta(days=offset)).isoformat()
            by_day[day] = {}
        if self.config.events_dir.is_dir():
            for path in sorted(self.config.events_dir.glob("*.jsonl")):
                try:
                    day = datetime.strptime(path.stem, "%Y-%m-%d").date()
                except ValueError:
                    continue
                if day < since:
                    continue
                for record in JsonlStore(path).read_all():
                    event = str(record.get("event", ""))
                    if event not in EVENT_ALLOWLIST:
                        continue
                    by_event[event] += 1
                    by_day.setdefault(day.isoformat(), {})[event] = (
                        by_day.setdefault(day.isoformat(), {}).get(event, 0) + 1
                    )
        leads = JsonlStore(self.config.leads_path).read_all()
        subscribers = JsonlStore(self.config.subscribers_path).read_all()
        page_views = by_event.get("page_view", 0)
        submissions = by_event.get("form_submit", 0)
        self._send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "days": days,
                "totals": {
                    "pageViews": page_views,
                    "leads": len(leads),
                    "subscribers": len(subscribers),
                    "applyStarts": by_event.get("form_start", 0),
                    "formSteps": by_event.get("form_step", 0),
                    "formSubmits": submissions,
                    "calculatorOpens": by_event.get("calculator_open", 0),
                    "scorecardCompletes": by_event.get("scorecard_complete", 0),
                },
                "conversion": {
                    "pageToApply": round(submissions / page_views, 4) if page_views else 0,
                    "applyToSubmit": round(submissions / by_event.get("form_start", 1), 4)
                    if by_event.get("form_start")
                    else 0,
                },
                "byEvent": dict(sorted(by_event.items())),
                "byDay": by_day,
            },
        )

    def _handle_lead(self) -> None:
        if not self._rate_limit(
            "lead", self.config.lead_rate_limit, self.config.lead_rate_window
        ):
            return
        payload = self._parse_body()
        clean, errors = validate_lead(payload, min_form_seconds=self.config.min_form_seconds)
        if errors:
            status = HTTPStatus.BAD_REQUEST if "_spam" in errors else HTTPStatus.UNPROCESSABLE_ENTITY
            if self._wants_html():
                self._send_html(status, error_page(errors.get("_spam") or "Please check the highlighted fields.", "/#apply"))
            else:
                self._send_json(
                    status,
                    {"ok": False, "message": "Please check the highlighted fields.", "errors": errors},
                )
            return

        lead_id = f"lead_{secrets.token_hex(8)}"
        ip = client_ip(self, self.config)
        record = {
            "id": lead_id,
            "receivedAt": utc_now(),
            "fullName": clean["fullName"],
            "email": clean["email"],
            "storeUrl": clean["storeUrl"],
            "revenue": clean["revenue"],
            "platform": clean["platform"],
            "challenge": clean["challenge"],
            "goal": clean["goal"],
            "outcomes": clean["outcomes"],
            "program": clean["program"],
            "consent": True,
            "consentAt": utc_now(),
            "scorecard": clean["scorecard"],
            "utm": clean["utm"],
            "page": clean["page"],
            "referrer": clean["referrer"],
            "sessionId": clean["sessionId"],
            "elapsedMs": clean["elapsedMs"],
            "ipHash": hash_ip(ip, self.config.site_url),
            "userAgent": self.headers.get("User-Agent", "")[:300],
        }
        try:
            JsonlStore(self.config.leads_path).append(record)
        except OSError:
            LOGGER.exception("Could not persist lead")
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "ok": False,
                    "message": "We could not save your application. Please try again or use the email link below.",
                },
            )
            return

        LOGGER.info("New audit application %s (%s)", lead_id, clean["revenue"])
        if self.config.webhook_url:
            threading.Thread(
                target=post_webhook,
                args=(self.config, sanitize_for_webhook(record)),
                daemon=True,
                name=f"webhook-{lead_id}",
            ).start()

        if self._wants_html():
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", "/thank-you")
            self.send_header("Content-Length", "0")
            self._common_headers()
            self.end_headers()
            return

        self._send_json(
            HTTPStatus.CREATED,
            {
                "ok": True,
                "id": lead_id,
                "message": "Application received. We'll reply within 24–48 hours.",
            },
        )

    def _handle_subscribe(self) -> None:
        if not self._rate_limit(
            "subscribe", self.config.subscribe_rate_limit, self.config.subscribe_rate_window
        ):
            return
        payload = self._parse_body()
        clean, errors = validate_subscriber(payload)
        if errors:
            status = HTTPStatus.BAD_REQUEST if "_spam" in errors else HTTPStatus.UNPROCESSABLE_ENTITY
            self._send_json(status, {"ok": False, "message": "Please check your email.", "errors": errors})
            return
        record = {
            "id": f"sub_{secrets.token_hex(8)}",
            "receivedAt": utc_now(),
            "email": clean["email"],
            "source": clean["source"],
            "page": clean["page"],
            "sessionId": clean["sessionId"],
            "ipHash": hash_ip(client_ip(self, self.config), self.config.site_url),
        }
        try:
            JsonlStore(self.config.subscribers_path).append(record)
        except OSError:
            LOGGER.exception("Could not persist subscriber")
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "message": "Could not subscribe right now. Please try again."},
            )
            return
        self._send_json(
            HTTPStatus.CREATED,
            {"ok": True, "message": "You're in. Watch your inbox for the next profit tip."},
        )

    def _handle_event(self) -> None:
        if self.headers.get("DNT") == "1" or self.headers.get("Sec-GPC") == "1":
            self._send_json(HTTPStatus.NO_CONTENT, {})
            return
        if not self._rate_limit(
            "event", self.config.event_rate_limit, self.config.event_rate_window
        ):
            return
        payload = self._parse_body()
        event = _clean_text(payload.get("event"), 40)
        if event not in EVENT_ALLOWLIST:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Unknown event."})
            return
        props = payload.get("props") if isinstance(payload.get("props"), dict) else {}
        clean_props: dict[str, str] = {}
        for key, value in list(props.items())[:12]:
            clean_key = _clean_text(key, 40)
            if clean_key:
                clean_props[clean_key] = _clean_text(value, 160)
        record = {
            "event": event,
            "receivedAt": utc_now(),
            "path": _clean_text(payload.get("path"), 200) or "/",
            "sessionId": _clean_text(payload.get("sessionId"), 64),
            "props": clean_props,
        }
        try:
            write_event(self.config, record)
        except OSError:
            LOGGER.exception("Could not persist event")
        self._send_json(HTTPStatus.NO_CONTENT, {})

    # -- static -----------------------------------------------------------
    def _resolve_static(self, request_path: str) -> Path | None:
        try:
            decoded = unquote(request_path)
        except Exception:
            return None
        if "\x00" in decoded or "\\" in decoded:
            return None
        if decoded == "/":
            decoded = "/index.html"
        if decoded.endswith("/"):
            decoded += "index.html"
        relative = decoded.lstrip("/")
        if not relative or any(part in {"..", "."} for part in Path(relative).parts):
            return None
        candidate = (self.config.root / relative).resolve()
        try:
            candidate.relative_to(self.config.root.resolve())
        except ValueError:
            return None
        if any(part in PROTECTED_DIRS for part in candidate.relative_to(self.config.root).parts):
            return None
        if candidate.name in PROTECTED_NAMES or candidate.name.startswith(".env"):
            return None
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if not candidate.is_file():
            # Allow clean URLs such as /legal -> legal.html.
            html_candidate = candidate.with_suffix(".html")
            if html_candidate.is_file():
                candidate = html_candidate
            else:
                return None
        if candidate.suffix.lower() not in STATIC_ALLOWED_EXTENSIONS:
            return None
        return candidate

    def _serve_static(self, request_path: str) -> None:
        candidate = self._resolve_static(request_path)
        if candidate is None:
            self._serve_not_found()
            return

        try:
            stat = candidate.stat()
        except OSError:
            self._serve_not_found()
            return

        etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self._common_headers()
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if_modified = self.headers.get("If-Modified-Since")
        if if_modified:
            try:
                parsed = datetime.strptime(if_modified, "%a, %d %b %Y %H:%M:%S GMT").replace(
                    tzinfo=timezone.utc
                )
                if stat.st_mtime <= parsed.timestamp() + 1:
                    self.send_response(HTTPStatus.NOT_MODIFIED)
                    self._common_headers()
                    self.send_header("ETag", etag)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            except ValueError:
                pass

        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix.lower() == ".webmanifest":
            content_type = "application/manifest+json"
        if content_type.startswith("text/") or content_type in {
            "application/javascript",
            "application/json",
            "image/svg+xml",
            "application/manifest+json",
            "application/xml",
        }:
            content_type += "; charset=utf-8"

        try:
            body = candidate.read_bytes()
        except OSError:
            self._serve_not_found()
            return

        can_gzip = (
            len(body) > 1024
            and "gzip" in self.headers.get("Accept-Encoding", "")
            and (
                content_type.startswith("text/")
                or content_type.startswith("application/javascript")
                or content_type.startswith("application/json")
                or content_type.startswith("application/manifest")
                or content_type.startswith("image/svg")
                or content_type.startswith("application/xml")
            )
        )
        if can_gzip:
            body = gzip.compress(body, compresslevel=6)

        self.send_response(HTTPStatus.OK)
        self._common_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", formatdate(stat.st_mtime, usegmt=True))
        self.send_header("Vary", "Accept-Encoding")
        if candidate.suffix.lower() == ".woff2":
            # Fonts are effectively immutable and the heaviest asset; cache hard.
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            # HTML, JS, CSS and images are not content-hashed, so revalidate with
            # the ETag on every load. This keeps deploys consistent (a returning
            # visitor can never pair new HTML with stale CSS/JS) at the cost of a
            # cheap 304 round-trip.
            self.send_header("Cache-Control", "no-cache")
        if can_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_not_found(self) -> None:
        page = self.config.root / "404.html"
        if page.is_file():
            body = page.read_bytes()
            self.send_response(HTTPStatus.NOT_FOUND)
            self._common_headers()
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            return
        self._send_html(HTTPStatus.NOT_FOUND, error_page("Page not found.", "/"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def sanitize_for_webhook(record: dict[str, Any]) -> dict[str, Any]:
    """Add a stable event name and remove internal-only fields."""
    payload = dict(record)
    payload["event"] = "lead.created"
    payload["leadId"] = payload.pop("id")
    return payload


def error_page(message: str, back_href: str) -> str:
    safe_message = (
        message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Submission error — Profit Guild</title>
<meta name="robots" content="noindex">
<style>
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#15110e;color:#f6f2ef;
font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}}
main{{max-width:520px;text-align:center;background:#19120e;border:1px solid rgba(223, 168, 133, .14);
border-radius:22px;padding:44px 32px}}
h1{{font-size:1.6rem;margin:0 0 12px}}p{{color:#c0b1a8;margin:0 0 24px}}
a{{display:inline-block;background:#d18352;color:#0f0b08;font-weight:700;text-decoration:none;
padding:12px 22px;border-radius:999px}}
</style></head><body><main><h1>We couldn't submit that</h1><p>{safe_message}</p>
<a href="{back_href}">Go back to the form</a></main></body></html>"""


def build_csp(root: Path) -> str:
    sources = [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "manifest-src 'self'",
    ]
    hashes: list[str] = []
    seen: set[str] = set()
    # Hash inline scripts on every top-level page, not just the landing page, so
    # pages such as 404.html and legal.html can use small inline snippets.
    for page in sorted(root.glob("*.html")):
        if not page.is_file():
            continue
        html = page.read_text(encoding="utf-8", errors="replace")
        for match in re.finditer(r"<script(?![^>]*\bsrc=)([^>]*)>(.*?)</script>", html, re.S | re.I):
            attrs, body = match.group(1), match.group(2)
            if not body.strip():
                continue
            # Only scripts that actually execute need a hash. Skip data blocks
            # such as <script type="application/ld+json">.
            type_match = re.search(r"""\btype\s*=\s*["']?([^"'\s>]+)""", attrs, re.I)
            if type_match:
                script_type = type_match.group(1).strip().lower()
                javascript_types = {
                    "text/javascript",
                    "application/javascript",
                    "text/ecmascript",
                    "application/ecmascript",
                    "module",
                }
                if script_type not in javascript_types:
                    continue
            digest = base64.b64encode(hashlib.sha256(body.encode("utf-8")).digest()).decode()
            entry = f"'sha256-{digest}'"
            if entry not in seen:
                seen.add(entry)
                hashes.append(entry)
    sources.append("script-src 'self'" + ((" " + " ".join(hashes)) if hashes else ""))
    return "; ".join(sources)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Profit Guild funnel server")
    parser.add_argument("--host", help="Bind address (default: HOST or 127.0.0.1)")
    parser.add_argument("--port", type=int, help="Port (default: PORT or 4173)")
    parser.add_argument("--data-dir", help="Directory for leads and events")
    parser.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    return parser


def main(argv: list[str] | None = None) -> int:
    load_dotenv(ROOT / ".env")
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    config = Config.from_env(ROOT)
    if args.host:
        config.host = args.host
    if args.port:
        config.port = args.port
    if args.data_dir:
        config.data_dir = Path(args.data_dir).expanduser().resolve()
    config.data_dir.mkdir(parents=True, exist_ok=True)
    if not config.admin_token:
        LOGGER.warning("ADMIN_TOKEN is not set; /api/leads and /api/stats are disabled.")

    server = ThreadingHTTPServer((config.host, config.port), FunnelHandler)
    server.daemon_threads = True
    server.config = config  # type: ignore[attr-defined]
    server.limiter = RateLimiter()  # type: ignore[attr-defined]
    server.csp = build_csp(config.root)  # type: ignore[attr-defined]

    def shutdown(signum: int, _frame: Any) -> None:
        LOGGER.info("Received signal %s, shutting down", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    LOGGER.info("Serving %s on http://%s:%s", config.root, config.host, config.port)
    try:
        server.serve_forever(poll_interval=0.4)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
