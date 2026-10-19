"""Tests for the funnel server. Run with: python3 -m unittest discover -s tests -v"""

from __future__ import annotations

import gzip
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

import server


ROOT = Path(__file__).resolve().parent.parent


def valid_lead(**overrides):
    payload = {
        "fullName": "Jordan Lee",
        "email": "jordan@yourstore.com",
        "storeUrl": "yourstore.com",
        "revenue": "$100k – $250k",
        "platform": "Shopify",
        "challenge": "Rising ad costs",
        "goal": "Increase net profit",
        "outcomes": "Add $30k per month in profit without increasing revenue.",
        "consent": True,
        "elapsedMs": 12000,
        "utm": {"source": "google", "medium": "cpc", "campaign": "profit-audit"},
        "page": "/",
    }
    payload.update(overrides)
    return payload


class ServerTestCase(unittest.TestCase):
    config_overrides: dict = {}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp.name)
        self.config = server.Config(
            root=ROOT,
            host="127.0.0.1",
            port=0,
            data_dir=self.data_dir,
            admin_token="test-token",
            min_form_seconds=0,
            lead_rate_limit=100,
            subscribe_rate_limit=100,
            event_rate_limit=1000,
            stdout_logs=False,
        )
        for key, value in self.config_overrides.items():
            setattr(self.config, key, value)
        self.server = server.ThreadingHTTPServer(("127.0.0.1", 0), server.FunnelHandler)
        self.server.daemon_threads = True
        self.server.config = self.config  # type: ignore[attr-defined]
        self.server.limiter = server.RateLimiter()  # type: ignore[attr-defined]
        self.server.csp = server.build_csp(ROOT)  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    # -- request helpers --------------------------------------------------
    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        data = response.read()
        result = (response.status, dict(response.getheaders()), data)
        connection.close()
        return result

    def post_json(self, path, payload, headers=None):
        base = {"Content-Type": "application/json", "Accept": "application/json"}
        base.update(headers or {})
        return self.request("POST", path, json.dumps(payload).encode(), base)

    def post_form(self, path, payload):
        from urllib.parse import urlencode

        return self.request(
            "POST",
            path,
            urlencode(payload).encode(),
            {"Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html"},
        )


class ValidationTests(unittest.TestCase):
    def test_valid_lead_is_normalized(self):
        clean, errors = server.validate_lead(valid_lead())
        self.assertEqual(errors, {})
        self.assertEqual(clean["storeUrl"], "https://yourstore.com")
        self.assertEqual(clean["email"], "jordan@yourstore.com")
        self.assertEqual(clean["consent"], True)
        self.assertEqual(clean["utm"]["source"], "google")

    def test_store_url_normalization(self):
        cases = {
            "shop.example.com": "https://shop.example.com",
            "http://shop.example.com/collections/all": "https://shop.example.com/collections/all",
            "https://Shop.Example.com/": "https://shop.example.com",
        }
        for raw, expected in cases.items():
            clean, errors = server.validate_lead(valid_lead(storeUrl=raw))
            self.assertEqual(errors, {}, raw)
            self.assertEqual(clean["storeUrl"], expected)

    def test_bad_store_urls_rejected(self):
        for raw in ("javascript:alert(1)", "not a url", "http://localhost:3000", "127.0.0.1", "https://x"):
            _, errors = server.validate_lead(valid_lead(storeUrl=raw))
            self.assertIn("storeUrl", errors, raw)

    def test_bad_emails_rejected(self):
        for raw in ("", "jordan", "jordan@", "jordan@localhost", "a..b@example.com", "a b@example.com"):
            _, errors = server.validate_lead(valid_lead(email=raw))
            self.assertIn("email", errors, raw)

    def test_choices_are_allowlisted(self):
        _, errors = server.validate_lead(valid_lead(revenue="<script>"))
        self.assertIn("revenue", errors)
        _, errors = server.validate_lead(valid_lead(goal="Make me rich"))
        self.assertIn("goal", errors)

    def test_consent_required(self):
        _, errors = server.validate_lead(valid_lead(consent=False))
        self.assertIn("consent", errors)

    def test_honeypot_and_timing_block_spam(self):
        _, errors = server.validate_lead(valid_lead(companyWebsite="spam.example"))
        self.assertIn("_spam", errors)
        _, errors = server.validate_lead(valid_lead(elapsedMs=200), min_form_seconds=2.5)
        self.assertIn("_spam", errors)

    def test_unknown_fields_are_dropped(self):
        clean, errors = server.validate_lead(valid_lead(admin=True, secret="x"))
        self.assertEqual(errors, {})
        self.assertNotIn("admin", clean)
        self.assertNotIn("secret", clean)

    def test_control_characters_are_stripped(self):
        clean, errors = server.validate_lead(valid_lead(fullName="Jordan\x00 Lee"))
        self.assertEqual(errors, {})
        self.assertEqual(clean["fullName"], "Jordan Lee")

    def test_scorecard_allowlist(self):
        clean, _ = server.validate_lead(valid_lead(scorecard=["ad-spend", "retention", "hacker"]))
        self.assertEqual(clean["scorecard"], ["ad-spend", "retention"])

    def test_subscriber_validation(self):
        clean, errors = server.validate_subscriber({"email": "A@Example.com"})
        self.assertEqual(errors, {})
        self.assertEqual(clean["email"], "a@example.com")
        self.assertEqual(clean["source"], "newsletter")


class StaticTests(ServerTestCase):
    def test_index_served_with_security_headers(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Profit Growth Coaching", body)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        self.assertIn("script-src 'self' 'sha256-", headers["Content-Security-Policy"])
        self.assertIn("no-cache", headers["Cache-Control"])
        self.assertIn("text/html", headers["Content-Type"])

    def test_clean_url_and_404(self):
        status, _, body = self.request("GET", "/legal")
        self.assertEqual(status, 200)
        self.assertIn(b"Privacy", body)
        status, _, body = self.request("GET", "/does-not-exist")
        self.assertEqual(status, 404)
        self.assertIn(b"not found", body.lower())

    def test_protected_paths_and_traversal_blocked(self):
        for path in ("/server.py", "/.env", "/data/leads.jsonl", "/README.md", "/tests/test_server.py"):
            status, _, _ = self.request("GET", path)
            self.assertEqual(status, 404, path)
        for path in ("/../server.py", "/%2e%2e/server.py", "/assets/../../server.py", "/..%5cserver.py"):
            status, _, _ = self.request("GET", path)
            self.assertEqual(status, 404, path)

    def test_etag_returns_304(self):
        _, headers, _ = self.request("GET", "/styles.css")
        etag = headers["ETag"]
        status, _, body = self.request("GET", "/styles.css", headers={"If-None-Match": etag})
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")

    def test_gzip_negotiation(self):
        status, headers, body = self.request("GET", "/styles.css", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Encoding"), "gzip")
        self.assertGreater(len(gzip.decompress(body)), len(body))

    def test_robots_and_sitemap(self):
        for path in ("/robots.txt", "/sitemap.xml", "/site.webmanifest"):
            status, _, _ = self.request("GET", path)
            self.assertEqual(status, 200, path)

    def test_health(self):
        status, _, body = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["version"], server.VERSION)


class LeadApiTests(ServerTestCase):
    def test_lead_created_and_persisted(self):
        status, _, body = self.post_json("/api/lead", valid_lead())
        self.assertEqual(status, 201, body)
        payload = json.loads(body)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["id"].startswith("lead_"))
        stored = (self.data_dir / "leads.jsonl").read_text().strip().splitlines()
        self.assertEqual(len(stored), 1)
        record = json.loads(stored[0])
        self.assertEqual(record["email"], "jordan@yourstore.com")
        self.assertEqual(record["storeUrl"], "https://yourstore.com")
        self.assertNotIn("ip", record)
        self.assertEqual(len(record["ipHash"]), 24)

    def test_invalid_lead_returns_field_errors(self):
        status, _, body = self.post_json(
            "/api/lead", valid_lead(email="nope", consent=False, outcomes="short")
        )
        self.assertEqual(status, 422)
        errors = json.loads(body)["errors"]
        self.assertIn("email", errors)
        self.assertIn("consent", errors)
        self.assertIn("outcomes", errors)

    def test_honeypot_returns_400(self):
        status, _, body = self.post_json("/api/lead", valid_lead(companyWebsite="bot"))
        self.assertEqual(status, 400)
        self.assertIn("_spam", json.loads(body)["errors"])

    def test_no_js_form_submission_redirects(self):
        status, headers, _ = self.post_form(
            "/api/lead",
            {
                "fullName": "Jordan Lee",
                "email": "jordan@yourstore.com",
                "storeUrl": "yourstore.com",
                "revenue": "$100k – $250k",
                "platform": "Shopify",
                "challenge": "Rising ad costs",
                "goal": "Increase net profit",
                "outcomes": "I want to add thirty thousand dollars of monthly profit.",
                "consent": "yes",
            },
        )
        self.assertEqual(status, 303)
        self.assertEqual(headers["Location"], "/thank-you.html")

    def test_rate_limit(self):
        self.config.lead_rate_limit = 2
        self.config.lead_rate_window = 60
        self.assertEqual(self.post_json("/api/lead", valid_lead())[0], 201)
        self.assertEqual(self.post_json("/api/lead", valid_lead())[0], 201)
        status, headers, _ = self.post_json("/api/lead", valid_lead())
        self.assertEqual(status, 429)
        self.assertIn("Retry-After", headers)

    def test_cross_origin_rejected(self):
        status, _, _ = self.post_json("/api/lead", valid_lead(), {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)

    def test_same_origin_allowed(self):
        status, _, _ = self.post_json(
            "/api/lead", valid_lead(), {"Origin": f"http://127.0.0.1:{self.port}"}
        )
        self.assertEqual(status, 201)

    def test_oversized_body_rejected(self):
        self.config.max_body_bytes = 100
        status, _, _ = self.post_json("/api/lead", valid_lead())
        self.assertEqual(status, 400)


class AdminApiTests(ServerTestCase):
    def test_requires_token(self):
        status, _, _ = self.request("GET", "/api/leads")
        self.assertEqual(status, 401)
        status, _, _ = self.request("GET", "/api/leads", headers={"Authorization": "Bearer wrong"})
        self.assertEqual(status, 401)

    def test_list_and_csv(self):
        self.post_json("/api/lead", valid_lead())
        headers = {"Authorization": "Bearer test-token"}
        status, _, body = self.request("GET", "/api/leads", headers=headers)
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["count"], 1)
        status, csv_headers, body = self.request(
            "GET", "/api/leads?format=csv", headers=headers
        )
        self.assertEqual(status, 200)
        self.assertIn("text/csv", csv_headers["Content-Type"])
        self.assertIn(b"jordan@yourstore.com", body)

    def test_admin_disabled_without_token(self):
        self.config.admin_token = ""
        status, _, _ = self.request("GET", "/api/leads")
        self.assertEqual(status, 503)

    def test_stats_aggregate_events(self):
        headers = {"Authorization": "Bearer test-token", "Content-Type": "application/json"}
        for event in ("page_view", "page_view", "form_start", "form_submit"):
            status, _, _ = self.request(
                "POST",
                "/api/event",
                json.dumps({"event": event, "path": "/"}).encode(),
                headers,
            )
            self.assertEqual(status, 204)
        status, _, body = self.request("GET", "/api/stats?days=7", headers=headers)
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["totals"]["pageViews"], 2)
        self.assertEqual(payload["totals"]["formSubmits"], 1)
        self.assertEqual(len(payload["byDay"]), 7)


class SubscribeAndEventTests(ServerTestCase):
    def test_subscribe(self):
        status, _, body = self.post_json(
            "/api/subscribe", {"email": "reader@example.com", "source": "footer"}
        )
        self.assertEqual(status, 201, body)
        stored = (self.data_dir / "subscribers.jsonl").read_text().strip().splitlines()
        self.assertEqual(json.loads(stored[0])["source"], "footer")

    def test_subscribe_rejects_invalid_email(self):
        status, _, _ = self.post_json("/api/subscribe", {"email": "nope"})
        self.assertEqual(status, 422)

    def test_event_allowlist(self):
        status, _, _ = self.post_json("/api/event", {"event": "page_view", "path": "/"})
        self.assertEqual(status, 204)
        status, _, _ = self.post_json("/api/event", {"event": "purchase", "path": "/"})
        self.assertEqual(status, 400)

    def test_dnt_respected(self):
        status, _, _ = self.post_json(
            "/api/event", {"event": "page_view"}, {"DNT": "1"}
        )
        self.assertEqual(status, 204)
        self.assertFalse(self.config.events_dir.exists())


if __name__ == "__main__":
    unittest.main()
