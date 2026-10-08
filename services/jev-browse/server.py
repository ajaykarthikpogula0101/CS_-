"""HTTP sidecar that runs jev-ultrafast browser tasks for ChampSet's browse_page tool.

jev-ultrafast (https://github.com/browser-use/jev-ultrafast) is a goal-driven
browser agent: TypeSafe's Jev picks each operation and target element, and a
small LLM writes text only when a field needs typing. ChampSet uses it for
pages whose data sits behind a search form, filter or "load more" button,
which fetch_page (read-only) cannot reach.

API:
  GET  /health  -> {"ok": true, "typesafe_configured": bool, ...}
  POST /browse  {"url": "https://...", "goal": "...", "timeout_s": 60, "max_actions": 25}
             -> {"status": "done"|"blocked"|"stuck"|"timeout"|"step_limit"|"error",
                 "url", "title", "text", "steps", "elapsed_ms", "error", "last_choice"}
  "stuck" = several Jev decisions in a row produced no action (the page kept changing);
  the run stops early because each decision is billed.

Configuration (env):
  TYPESAFE_API_KEY          required for /browse
  TEXT_MODEL_API_KEY        text helper key; falls back to OPENROUTER_API_KEY
  JEV_BROWSE_HOST/PORT      bind address (default 127.0.0.1:9380)
  JEV_BROWSE_TOKEN          if set, /browse requires "Authorization: Bearer <token>"
  JEV_BROWSE_CONCURRENCY    tasks run at once (default 2)
  BU_CDP_URL                attach to an existing Chrome; otherwise a dedicated
                            headless Chrome is launched (CHROME_PATH,
                            JEV_BROWSE_CHROME_PORT, JEV_BROWSE_HEADLESS=0,
                            JEV_BROWSE_NO_SANDBOX=1 for root in containers)
"""

import atexit
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# Browser Harness reads these at import time, so set them before importing jev_ultrafast.
# Telemetry is off: task text must not leave this host.
os.environ.setdefault("BH_TELEMETRY", "0")
os.environ.setdefault("BU_NAME", "champset-browse")
# The text helper defaults to the OpenRouter key and model the jev-ultrafast demo uses.
if not os.environ.get("TEXT_MODEL_API_KEY") and os.environ.get("OPENROUTER_API_KEY"):
    os.environ["TEXT_MODEL_API_KEY"] = os.environ["OPENROUTER_API_KEY"]
os.environ.setdefault("TEXT_MODEL_BASE_URL", "https://openrouter.ai/api/v1")
os.environ.setdefault("TEXT_MODEL", "inception/mercury-2.5")
os.environ.setdefault("TEXT_MODEL_REASONING", "none")

from browser_harness import helpers as _harness  # noqa: E402
from browser_harness.admin import restart_daemon  # noqa: E402
from jev_ultrafast import Agent  # noqa: E402

# If Browser Harness was imported before this module, it bound the shared "default"
# daemon name, which may drive someone's personal Chrome. Refuse rather than risk it.
if _harness.NAME != os.environ["BU_NAME"]:
    raise ImportError(
        f"Browser Harness was imported before server.py and bound daemon {_harness.NAME!r}; "
        "import server first (or set BU_NAME in the environment)."
    )

MAX_BODY_BYTES = 64 * 1024
MAX_GOAL_CHARS = 2000
MAX_TEXT_CHARS = 100_000
DEFAULT_TIMEOUT_S, MIN_TIMEOUT_S, MAX_TIMEOUT_S = 60, 5, 120
DEFAULT_MAX_ACTIONS, MAX_ACTIONS = 25, 60
MAX_IDLE_DECISIONS = 6
QUEUE_WAIT_S = 30

slots = threading.BoundedSemaphore(max(1, int(os.environ.get("JEV_BROWSE_CONCURRENCY") or 2)))

# Full page text, not the agent's visible-only snapshot: results below the fold are the data.
READ_PAGE = "({url: location.href, title: document.title, text: document.body ? document.body.innerText : ''})"


def find_chrome():
    if path := os.environ.get("CHROME_PATH"):
        return path
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        if path := shutil.which(name):
            return path
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    return next((path for path in candidates if os.path.exists(path)), None)


def stop_daemon():
    """Stop this service's Browser Harness daemon (named by BU_NAME), if one is running."""
    try:
        restart_daemon(os.environ["BU_NAME"])
    except Exception as exc:  # best effort: nothing to stop, or it is already gone
        print(f"[jev-browse] daemon stop: {exc}", file=sys.stderr, flush=True)


def launch_chrome():
    """Start a dedicated Chrome for the agent unless BU_CDP_URL/BU_CDP_WS points at one."""
    if os.environ.get("BU_CDP_URL") or os.environ.get("BU_CDP_WS"):
        return None
    exe = find_chrome()
    if not exe:
        raise RuntimeError("Chrome not found. Install Chrome, or set CHROME_PATH or BU_CDP_URL.")
    port = int(os.environ.get("JEV_BROWSE_CHROME_PORT") or 9223)
    # A daemon left by a killed run would still hold a connection to its dead Chrome.
    stop_daemon()
    profile = tempfile.mkdtemp(prefix="jev-browse-chrome-")
    args = [
        exe,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1120,780",
    ]
    if os.environ.get("JEV_BROWSE_HEADLESS", "1") != "0":
        args.append("--headless=new")
    if os.environ.get("JEV_BROWSE_NO_SANDBOX") == "1":
        args.append("--no-sandbox")
    cdp_url = f"http://127.0.0.1:{port}"
    procs = []

    def stop():
        stop_daemon()
        for proc in procs:
            _stop_chrome(proc)
        shutil.rmtree(profile, ignore_errors=True)

    atexit.register(stop)
    version = _start_chrome(args, cdp_url, procs)
    # Headless Chrome announces itself as "HeadlessChrome", which sites block on sight.
    # Restart once with the same browser's normal user agent.
    agent_string = version.get("User-Agent", "")
    if "HeadlessChrome" in agent_string:
        _stop_chrome(procs.pop())
        version = _start_chrome([*args, f"--user-agent={agent_string.replace('HeadlessChrome', 'Chrome')}"],
                                cdp_url, procs)
    if version is None:
        stop()
        raise RuntimeError(f"Chrome did not open remote debugging on port {port}")
    os.environ["BU_CDP_URL"] = cdp_url
    return stop


def _start_chrome(args, cdp_url, procs):
    """Start Chrome and wait for its debugging endpoint. Returns /json/version, or None."""
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    procs.append(proc)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(cdp_url + "/json/version", timeout=1) as res:
                return json.loads(res.read())
        except OSError:
            if proc.poll() is not None:
                return None
            time.sleep(0.2)
    return None


def _stop_chrome(proc):
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def _sum_usage(entries):
    total = {}
    for usage in entries:
        for key, value in (usage or {}).items():
            if isinstance(value, int | float) and not isinstance(value, bool):
                total[key] = total.get(key, 0) + value
    return total


def _read_page(agent):
    try:
        page = agent.browser.evaluate(READ_PAGE)
        if isinstance(page, dict):
            return page
    except (ValueError, RuntimeError):
        pass  # navigating or closed: fall back to the last observation
    last = agent.state["page"]
    return {"url": last.get("url"), "title": last.get("title"), "text": last.get("text", "")}


def _last_choice(state):
    """What Jev chose last, for error reports: operation and the element's label."""
    if not state["decisions"]:
        return None
    decision = state["decisions"][-1]
    label = None
    if decision.get("target"):
        elements = decision.get("request", {}).get("state", {}).get("elements", [])
        label = next((e.get("label") for e in elements if e.get("index") == decision["target"].split(":")[0]), None)
    return {"operation": decision.get("operation"), "element": label}


def run_task(url, goal, timeout_s=DEFAULT_TIMEOUT_S, max_actions=DEFAULT_MAX_ACTIONS):
    """Run one goal to completion or a limit. Never raises for task-level failures."""
    started = time.monotonic()
    status, error = "error", None
    try:
        agent = Agent(url, goal)
    except Exception as exc:  # browser unreachable, navigation failure
        return {"status": "error", "error": f"Browser could not open the page: {exc}", "url": url,
                "title": None, "text": "", "steps": [], "elapsed_ms": round((time.monotonic() - started) * 1000)}
    with agent:
        # Chrome's own error page (TLS failure, DNS, refused): no point asking Jev about it.
        if (agent.state["page"].get("url") or "").startswith("chrome-error://"):
            page = _read_page(agent)
            reason = next((line for line in (page.get("text") or "").splitlines() if "ERR_" in line), "")
            return {"status": "error", "error": f"Browser could not load the page {reason}".strip(), "url": url,
                    "title": page.get("title"), "text": "", "steps": [], "decisions": 0,
                    "elapsed_ms": round((time.monotonic() - started) * 1000)}
        # Decisions are billed even when the page changes before the chosen action can run.
        # Stop once several in a row have produced no action, instead of looping to the timeout.
        actions_seen, acted_at = 0, 0
        try:
            for state in agent.run():
                if time.monotonic() - started > timeout_s:
                    status = "timeout"
                    break
                if len(state["history"]) >= max_actions:
                    status = "step_limit"
                    break
                if len(state["history"]) > actions_seen:
                    actions_seen, acted_at = len(state["history"]), len(state["decisions"])
                if len(state["decisions"]) - acted_at >= MAX_IDLE_DECISIONS:
                    status, error = "stuck", "The page kept changing before any chosen action could run."
                    break
            else:
                status = agent.state["status"]
        except (ValueError, RuntimeError) as exc:  # invalid model output, provider errors, budgets
            status, error = "error", str(exc)
        page = _read_page(agent)
        state = agent.state
        return {
            "status": status,
            "error": error,
            "last_choice": _last_choice(state) if status in {"error", "stuck"} else None,
            "url": page.get("url"),
            "title": page.get("title"),
            "text": (page.get("text") or "")[:MAX_TEXT_CHARS],
            "steps": [
                {k: h.get(k) for k in ("action", "kind", "text", "page_changed", "url")} for h in state["history"]
            ],
            "decisions": len(state["decisions"]),
            "jev_usage": _sum_usage(d.get("usage") for d in state["decisions"]),
            "text_usage": _sum_usage(t.get("usage") for t in state["text_calls"]),
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }


def _clamp(value, default, low, high):
    if value is None:
        return default
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise ValueError("must be a number")
    return max(low, min(high, value))


def parse_request(body):
    if not isinstance(body, dict):
        raise ValueError("Body must be a JSON object")
    url, goal = body.get("url"), body.get("goal")
    if not isinstance(url, str) or urlparse(url).scheme not in {"http", "https"} or not urlparse(url).netloc:
        raise ValueError("url must be an absolute http(s) URL")
    if not isinstance(goal, str) or not goal.strip():
        raise ValueError("goal is required")
    if len(goal) > MAX_GOAL_CHARS:
        raise ValueError(f"goal must be at most {MAX_GOAL_CHARS} characters")
    try:
        timeout_s = _clamp(body.get("timeout_s"), DEFAULT_TIMEOUT_S, MIN_TIMEOUT_S, MAX_TIMEOUT_S)
        max_actions = int(_clamp(body.get("max_actions"), DEFAULT_MAX_ACTIONS, 1, MAX_ACTIONS))
    except ValueError as exc:
        raise ValueError(f"timeout_s/max_actions {exc}") from None
    return url, goal.strip(), timeout_s, max_actions


class Handler(BaseHTTPRequestHandler):
    server_version = "jev-browse/0.1"

    def _send(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[jev-browse] {self.address_string()} {fmt % args}\n")

    def do_GET(self):
        if self.path != "/health":
            return self._send(404, {"error": "Not found"})
        self._send(200, {
            "ok": True,
            "typesafe_configured": bool(os.environ.get("TYPESAFE_API_KEY")),
            "text_model_configured": bool(os.environ.get("TEXT_MODEL_API_KEY")),
            "cdp_url": os.environ.get("BU_CDP_URL") or os.environ.get("BU_CDP_WS"),
        })

    def do_POST(self):
        if self.path != "/browse":
            return self._send(404, {"error": "Not found"})
        token = os.environ.get("JEV_BROWSE_TOKEN")
        if token and self.headers.get("Authorization") != f"Bearer {token}":
            return self._send(401, {"error": "Unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            return self._send(413, {"error": "Request body too large"})
        try:
            url, goal, timeout_s, max_actions = parse_request(json.loads(self.rfile.read(length) or b"null"))
        except (ValueError, json.JSONDecodeError) as exc:
            return self._send(400, {"error": str(exc)})
        if not os.environ.get("TYPESAFE_API_KEY"):
            return self._send(503, {"error": "TYPESAFE_API_KEY is not set on the jev-browse service."})
        if not slots.acquire(timeout=QUEUE_WAIT_S):
            return self._send(503, {"error": "jev-browse is busy. Try again shortly."})
        try:
            self._send(200, run_task(url, goal, timeout_s, max_actions))
        finally:
            slots.release()


def make_server(host="127.0.0.1", port=9380):
    return ThreadingHTTPServer((host, port), Handler)


def main():
    # Exit normally on SIGTERM (docker stop) so atexit stops the launched Chrome.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    launch_chrome()
    host = os.environ.get("JEV_BROWSE_HOST", "127.0.0.1")
    port = int(os.environ.get("JEV_BROWSE_PORT") or 9380)
    server = make_server(host, port)
    print(f"[jev-browse] listening on http://{host}:{port} (browser {os.environ.get('BU_CDP_URL')})", flush=True)
    if not os.environ.get("TYPESAFE_API_KEY"):
        print("[jev-browse] TYPESAFE_API_KEY is not set: /browse will return 503", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
