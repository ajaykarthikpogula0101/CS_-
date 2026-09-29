# jev-browse

HTTP sidecar behind ChampSet's `browse_page` agent tool. It runs a
[jev-ultrafast](https://github.com/browser-use/jev-ultrafast) browser agent (MIT, pinned in
`pyproject.toml`) in a dedicated headless Chrome. TypeSafe's Jev chooses each click, type
or select. A small OpenRouter model writes text only when a field needs typing.

Use it for data that sits behind a search form, filter or "load more" button. `fetch_page`
only reads a page and can't click or type.

## Run

Needs [uv](https://docs.astral.sh/uv/) and Chrome.

```bash
cd services/jev-browse
uv sync
# TYPESAFE_API_KEY from TypeSafe; OPENROUTER_API_KEY is reused for typed text.
TYPESAFE_API_KEY=... OPENROUTER_API_KEY=... uv run python server.py
```

Then set `JEV_BROWSE_URL=http://127.0.0.1:9380` in ChampSet's `.env`. For Docker, set
`JEV_BROWSE_URL_DOCKER=http://host.docker.internal:9380` instead. On Linux hosts, also set
`JEV_BROWSE_HOST=0.0.0.0` and `JEV_BROWSE_TOKEN` (same value on both sides), because
containers reach the host through the bridge network.

```bash
curl -s localhost:9380/health
curl -s localhost:9380/browse -H 'Content-Type: application/json' -d '{
  "url": "https://find-and-update.company-information.service.gov.uk/",
  "goal": "Search for Monzo Bank and open its company record"}'
```

`/browse` returns the status (`done`, `blocked`, `timeout`, `step_limit` or `error`), the final
page's URL, title and full text, and the steps taken. Each task is limited by `timeout_s`
(default 60, max 120) and `max_actions` (default 25). At most `JEV_BROWSE_CONCURRENCY`
tasks (default 2) run at once.

The rest of the configuration is in the docstring at the top of `server.py`.

## Notes

- **Telemetry is off.** Browser Harness sends telemetry by default. The server sets
  `BH_TELEMETRY=0` so task text never leaves the host.
- **Isolated browser.** The launched Chrome uses a throwaway profile, deleted on exit. Set
  `BU_CDP_URL` to attach to a browser you run yourself instead.
- **Pinned dependency.** The server reads jev-ultrafast's `Agent` state directly. Bump the
  pinned commit deliberately and re-run the tests.

## Test

```bash
uv run pytest
```

The tests are offline. Both model calls are faked. The `browser` tests drive a real headless
Chrome through a local search form, and they are skipped when Chrome isn't installed.
