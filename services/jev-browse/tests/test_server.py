"""Offline tests for the jev-browse sidecar. No paid APIs: TypeSafe and the text helper are faked.

The browser test drives a real headless Chrome through Browser Harness against a
local company-search site, so it covers the whole path except the two model calls.
"""

import json
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import pytest
from jev_ultrafast import model

import server


def start(httpd):
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return f"http://127.0.0.1:{httpd.server_address[1]}"


@pytest.fixture
def sidecar():
    httpd = server.make_server("127.0.0.1", 0)
    yield start(httpd)
    httpd.shutdown()


def call(base, path, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(base + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())


# ---- request handling (no browser)


def test_health_reports_missing_typesafe_key(sidecar, monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    status, body = call(sidecar, "/health")
    assert status == 200 and body["ok"] is True and body["typesafe_configured"] is False


def test_browse_without_typesafe_key_is_503(sidecar, monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    status, body = call(sidecar, "/browse", {"url": "https://example.com", "goal": "Find the price"})
    assert status == 503 and "TYPESAFE_API_KEY" in body["error"]


@pytest.mark.parametrize(
    "body, message",
    [
        ({"url": "file:///etc/passwd", "goal": "x"}, "http(s)"),
        ({"url": "https://", "goal": "x"}, "http(s)"),
        ({"url": "https://example.com"}, "goal is required"),
        ({"url": "https://example.com", "goal": "   "}, "goal is required"),
        ({"url": "https://example.com", "goal": "x" * 2001}, "at most"),
        ({"url": "https://example.com", "goal": "x", "timeout_s": "fast"}, "must be a number"),
        ([], "JSON object"),
    ],
)
def test_invalid_requests_are_400(sidecar, monkeypatch, body, message):
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    status, out = call(sidecar, "/browse", body)
    assert status == 400 and message in out["error"]


def test_token_is_enforced_when_set(sidecar, monkeypatch):
    monkeypatch.setenv("JEV_BROWSE_TOKEN", "s3cret")
    body = {"url": "https://example.com", "goal": "x"}
    assert call(sidecar, "/browse", body)[0] == 401
    assert call(sidecar, "/browse", body, {"Authorization": "Bearer wrong"})[0] == 401


def test_limits_are_clamped():
    _, _, timeout_s, max_actions = server.parse_request(
        {"url": "https://example.com", "goal": "x", "timeout_s": 9999, "max_actions": 0}
    )
    assert timeout_s == server.MAX_TIMEOUT_S and max_actions == 1


def test_usage_is_summed_ignoring_non_numbers():
    total = server._sum_usage([{"input_tokens": 10, "cost": 0.5, "id": "x"}, None, {"input_tokens": 5, "flag": True}])
    assert total == {"input_tokens": 15, "cost": 0.5}


# ---- end to end in a real browser, with faked model calls

SEARCH_PAGE = b"""<!doctype html><title>Company search</title>
<h1>Find a company</h1>
<form action="/results" method="get">
  <label for="q">Company name</label> <input id="q" name="q" type="text">
  <button type="submit">Search</button>
</form>"""


def results_page(query):
    rows = "".join(f"<p>Filler row {i}</p>" for i in range(80))  # pushes the record below the fold
    return f"""<!doctype html><title>Results</title><h1>Results for {query}</h1>{rows}
<p>ACME LTD | Company number 01234567 | Status: Active</p>""".encode()


class Site(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/results":
            body = results_page(parse_qs(parsed.query).get("q", [""])[0])
        else:
            body = SEARCH_PAGE
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def answer(ids, selected):
    return {"choice": selected, "confidence": 0.99, "probabilities": {i: float(i == selected) for i in ids}}


def fake_models(calls):
    """Scripted Jev: type the company name, click Search, then DONE once results are visible."""

    def post(url, _key, body):
        calls.append(url)
        if "typesafe" not in url:  # text helper
            return {"choices": [{"message": {"content": json.dumps({"text": "Acme"})}}], "usage": {"total_tokens": 7}}
        questions, elements = body["questions"], body["state"]["elements"]
        ops = questions["operation"]["criteria"]
        answers = {}
        empty_field = next((e for e in elements if "TYPE_TEXT" in e["operations"] and not e.get("value")), None)
        if "Results for" in body["state"]["page"]["text"]:
            answers["operation"] = answer(ops, "DONE")
        elif empty_field:
            answers["operation"] = answer(ops, "TYPE_TEXT")
            answers["type_text_target"] = answer(questions["type_text_target"]["criteria"], empty_field["index"])
        else:
            button = next(e for e in elements if e["label"] == "Search" and "CLICK" in e["operations"])
            answers["operation"] = answer(ops, "CLICK")
            answers["click_target"] = answer(questions["click_target"]["criteria"], button["index"])
        return {"model": "fake-jev", "answers": answers, "usage": {"input_tokens": 100, "cost": 0.001}}

    return post


@pytest.fixture(scope="module")
def chrome():
    if not server.find_chrome():
        pytest.skip("Chrome not installed")
    stop = server.launch_chrome()
    yield
    if stop:
        stop()


@pytest.fixture
def site():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    yield start(httpd)
    httpd.shutdown()


@pytest.mark.browser
def test_browse_fills_form_and_returns_full_results_text(chrome, sidecar, site, monkeypatch):
    calls = []
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test")
    monkeypatch.setattr(model, "post_json", fake_models(calls))

    status, out = call(sidecar, "/browse", {"url": site + "/", "goal": "Look up Acme and report its company number"})

    assert status == 200, out
    assert out["status"] == "done", out
    assert [s["kind"] for s in out["steps"]] == ["fill", "click"]
    assert out["steps"][0]["text"] == "Acme"
    assert "/results?q=Acme" in out["url"]
    assert "Company number 01234567" in out["text"]  # below the fold: full page text, not the visible snapshot
    assert out["decisions"] == 3
    assert out["jev_usage"] == {"input_tokens": 300, "cost": pytest.approx(0.003)}
    assert out["text_usage"] == {"total_tokens": 7}


@pytest.mark.browser
def test_step_limit_stops_the_run(chrome, sidecar, site, monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test")
    monkeypatch.setattr(model, "post_json", fake_models([]))

    status, out = call(sidecar, "/browse", {"url": site + "/", "goal": "Look up Acme", "max_actions": 1})

    assert status == 200 and out["status"] == "step_limit"
    assert [s["kind"] for s in out["steps"]] == ["fill"]


@pytest.mark.browser
def test_model_failure_is_reported_not_raised(chrome, sidecar, site, monkeypatch):
    def broken(*_args):
        raise RuntimeError("Model provider returned HTTP 500; no action executed.")

    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(model, "post_json", broken)

    status, out = call(sidecar, "/browse", {"url": site + "/", "goal": "Look up Acme"})

    assert status == 200 and out["status"] == "error"
    assert "HTTP 500" in out["error"]
    assert "Find a company" in out["text"]  # still returns what the page showed
